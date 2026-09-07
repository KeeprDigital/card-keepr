import type { WorkflowStep } from "cloudflare:workers";
import { expect, test } from "vitest";
import { runGamePublicationWorkflow } from "../src/game-publication-workflow";
import { catalogueStore } from "../../../src/catalogue/shared";
import { reservePublicExportAttempt, advancePublicationExports } from "../../../src/catalogue/ingestion";
import { pauseGamePublication } from "../../../src/catalogue/reconciliation";
import { resumeGamePublication } from "../../../src/catalogue/reconciliation/game-publication";
import { setCardSearchFtsStateStateOwnerToken } from "./query-helpers/card-search";
import { publicationStateSnapshot } from "./query-helpers/atomic-publication";
import { collect, get, post, installReconciliationSuite, testEnv } from "./reconciliation-helpers";

installReconciliationSuite();

// Controlled Workflow control-plane fault injection. The shipped Workflow and
// owner repositories run against real D1; this is not checkpoint/restore proof.
function stepDriver() {
  const receipts = new Map<string, unknown>();
  return {
    async do(name: string, ...args: unknown[]) {
      if (receipts.has(name)) return receipts.get(name);
      const callback = args.at(-1) as () => Promise<unknown>;
      const options = args.length > 1 ? (args[0] as { retries?: { limit?: number } }) : {};
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await callback();
          receipts.set(name, result);
          return result;
        } catch (error) {
          if (attempt >= (options.retries?.limit ?? 0)) throw error;
        }
      }
    },
    async sleep() {},
  } as unknown as WorkflowStep;
}
async function approvedCandidate(key: string) {
  const source = await collect("/reconciliation/base", key);
  let candidate = (
    await post("/v1/game-candidates", {
      ingestion_run_id: source.id,
      supported_game: "one-piece",
      expected_game_revision_id: "catrev_spine_000",
      idempotency_key: `${key}-candidate`,
    })
  ).document;
  const deadline = Date.now() + 15000;
  while (candidate.state === "preparing" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    candidate = (await get(`/v1/game-candidates/${candidate.id}`)).document;
  }
  expect(candidate.state).toBe("sealed");
  const approved = await post("/v1/publications", {
    candidate_id: candidate.id,
    manifest_digest: candidate.manifest_digest,
    expected_game_revision_id: "catrev_spine_000",
    generation: 0,
    idempotency_key: `${key}-approval`,
  });
  expect(approved.response.status).toBe(202);
  return approved.document;
}

test.each([false, true])(
  "successor dispatch exhaustion retains a fenced pause and exact resume (existing progress: %s)",
  async (progress) => {
    const approved = await approvedCandidate("successor-failure");
    const id = String(approved.id),
      db = catalogueStore(testEnv.CATALOGUE_DB);
    const sequence = progress ? 1 : 0;
    if (progress) {
      const path = `/v1/game-candidates/${approved.candidate_id}/publication-preparation`;
      let prepared = (
        await post(path, {
          manifest_digest: approved.manifest_digest,
          generation: 0,
          sequence: 0,
          idempotency_key: "wait-private",
        })
      ).document;
      for (let unit = 0; prepared.state === "preparing" && unit < 250; unit++)
        prepared = (
          await post(path, {
            manifest_digest: approved.manifest_digest,
            generation: 0,
            sequence: prepared.sequence,
            idempotency_key: `wait-private-${unit}`,
          })
        ).document;
      expect(prepared.state).toBe("verified");
      expect(
        (
          await post(`/v1/publications/${id}/export-preparation/advance`, {
            generation: 0,
            idempotency_key: "wait-public-first",
          })
        ).document.sequence,
      ).toBe(sequence);
      await setCardSearchFtsStateStateOwnerToken(testEnv.CATALOGUE_DB)
        .bind("injected-search-wait", "2099-01-01T00:00:00.000Z")
        .run();
    }
    let creates = 0;
    const failing = {
      ...testEnv,
      RECONCILIATION_WORKFLOW: {
        async create() {
          creates++;
          throw new Error("injected successor create failure");
        },
        async get() {
          throw new Error("workflow not found");
        },
      },
    } as unknown as Env;
    const steps = stepDriver();
    await expect(runGamePublicationWorkflow(failing, steps, { id, generation: 0 })).rejects.toThrow(
      "injected successor",
    );
    expect(creates).toBe(4);
    const paused = (await get(`/v1/publications/${id}`)).document;
    expect(paused).toMatchObject({
      state: "retry_paused",
      failure_code: "publication_successor_dispatch_exhausted",
      deadline: approved.deadline,
      candidate_id: approved.candidate_id,
    });
    expect((await post(`/v1/publications/${id}/advance`, { generation: 0 })).document).toEqual(paused);
    await runGamePublicationWorkflow(failing, steps, { id, generation: 0 });
    expect((await get(`/v1/publications/${id}`)).document).toEqual(paused);
    expect(creates).toBe(4);
    const dispatched: unknown[] = [];
    const successful = {
      ...testEnv,
      CATALOGUE_DB: db,
      RECONCILIATION_WORKFLOW: {
        async create(input: unknown) {
          dispatched.push(input);
          return {
            async status() {
              return { status: "queued" };
            },
          };
        },
      },
    } as unknown as Parameters<typeof resumeGamePublication>[0];
    const resumed = await resumeGamePublication(
      successful,
      id,
      { generation: 0, idempotency_key: "successor-resume" },
      new Date().toISOString(),
    );
    expect(resumed).toMatchObject({
      generation: 1,
      state: "approved",
      deadline: approved.deadline,
      candidate_id: approved.candidate_id,
    });
    await pauseGamePublication(db, id, 0, "publication_successor_dispatch_exhausted", { shard: 0, sequence });
    expect((await get(`/v1/publications/${id}`)).document.state).toBe("approved");
    expect(await reservePublicExportAttempt(db, id, 1, 1)).toBe(true);
    await pauseGamePublication(db, id, 1, "publication_successor_dispatch_exhausted", { shard: 0, sequence });
    expect((await get(`/v1/publications/${id}`)).document.state).toBe("approved");
    await runGamePublicationWorkflow(failing, stepDriver(), { id, generation: 0 });
    expect(creates).toBe(4);
    expect(dispatched).toHaveLength(1);
  },
);

test("forty durable attempts pause without an implicit advance or another successor budget", async () => {
  const approved = await approvedCandidate("attempt-budget");
  const id = String(approved.id),
    db = catalogueStore(testEnv.CATALOGUE_DB);
  for (let attempt = 0; attempt < 40; attempt++) expect(await reservePublicExportAttempt(db, id, 0, 0)).toBe(true);
  expect(await reservePublicExportAttempt(db, id, 0, 0)).toBe(false);
  await runGamePublicationWorkflow(testEnv, stepDriver(), { id, generation: 0 });
  expect((await get(`/v1/publications/${id}`)).document).toMatchObject({
    state: "retry_paused",
    failure_code: "public_export_workflow_budget_exhausted",
    deadline: approved.deadline,
  });
  expect((await post(`/v1/publications/${id}/advance`, { generation: 0 })).document.state).toBe("retry_paused");
  expect(await reservePublicExportAttempt(db, id, 0, 1)).toBe(false);
});

test("corrupt retained public bytes fail preparation before any head or backup reservation changes", async () => {
  const approved = await approvedCandidate("corrupt-public-artifact");
  const path = `/v1/game-candidates/${approved.candidate_id}/publication-preparation`;
  let prepared = (
    await post(path, {
      manifest_digest: approved.manifest_digest,
      generation: 0,
      sequence: 0,
      idempotency_key: "corrupt-private",
    })
  ).document;
  for (let unit = 0; prepared.state === "preparing" && unit < 250; unit++)
    prepared = (
      await post(path, {
        manifest_digest: approved.manifest_digest,
        generation: 0,
        sequence: prepared.sequence,
        idempotency_key: `corrupt-private-${unit}`,
      })
    ).document;
  expect(prepared.state).toBe("verified");
  const before = await publicationStateSnapshot(testEnv.CATALOGUE_DB);
  const bucket = new Proxy(testEnv.CATALOGUE_EXPORTS, {
    get(target, property) {
      if (property === "get")
        return async (...args: Parameters<R2Bucket["get"]>) => {
          const object = await target.get(...args);
          if (!object || !args[0].startsWith("catalogue-public-components/")) return object;
          return new Proxy(object, {
            get(value, field) {
              if (field === "arrayBuffer") return async () => new Uint8Array(value.size).buffer;
              const member = Reflect.get(value, field);
              return typeof member === "function" ? member.bind(value) : member;
            },
          });
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const result = await advancePublicationExports(
    { CATALOGUE_DB: catalogueStore(testEnv.CATALOGUE_DB), CATALOGUE_EXPORTS: bucket },
    String(approved.id),
    0,
    "corrupt-public-unit",
  );
  expect(result).toMatchObject({ state: "failed", failure_code: "public_export_artifact_corrupt" });
  expect((await post(`/v1/publications/${approved.id}/advance`, { generation: 0 })).document).toMatchObject({
    state: "failed",
    failure_code: "public_export_artifact_corrupt",
    deadline: approved.deadline,
  });
  expect(await publicationStateSnapshot(testEnv.CATALOGUE_DB)).toEqual(before);
});
