import { expect, test } from "vitest";
import {
  collectRequests,
  get,
  installReconciliationSuite,
  post,
  requiredString,
  testEnv,
} from "./reconciliation-helpers";
import { runReconciliationWorkflow } from "../src/reconciliation-workflow";

installReconciliationSuite();

test("normalization resumes after completed documents without rereading their verified payloads", async () => {
  const run = await collectRequests(
    [
      { id: "first", scenario: "base" },
      { id: "second", scenario: "new-locator" },
    ],
    "normalization-document-cursor",
  );
  const firstSnapshot = (run.document.snapshots as { id: string; request: { url: string } }[]).find(({ request }) =>
    request.url.endsWith("/base"),
  )!;
  const firstSet = (run.document.observation_sets as { id: string; source_snapshot_id: string }[]).find(
    ({ source_snapshot_id }) => source_snapshot_id === firstSnapshot.id,
  )!;
  let resumed = false;
  let writes = 0;
  let failures = 0;
  const images = new Proxy(testEnv.PRINTING_IMAGES, {
    get(target, property) {
      if (property === "put")
        return async (...args: Parameters<R2Bucket["put"]>) => {
          if (!resumed && writes++ > 0) {
            failures++;
            throw new Error("Injected second document image outage");
          }
          return target.put(...args);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const wrap = (statement: D1PreparedStatement, sql: string, values: unknown[] = []): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...bound: unknown[]) => wrap(target.bind(...bound), sql, bound);
        if (
          (property === "first" || property === "all") &&
          resumed &&
          sql.includes("FROM reconciliation_document_partitions") &&
          values.includes(firstSet.id)
        )
          return async () => {
            throw new Error("Completed document payload must not be revisited during normalization continuation.");
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const database = new Proxy(testEnv.CATALOGUE_DB, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const event = {
    payload: {
      ingestion_run_id: run.id,
      expected_current_revision_id: requiredString(run.document, "expected_current_revision_id"),
      idempotency_key: "normalization-document-cursor",
      observed_at: new Date().toISOString(),
      generation: 0,
    },
  } as import("cloudflare:workers").WorkflowEvent<
    import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams
  >;
  const step = {
    do: async (_name: string, config: { retries: { limit: number } }, callback: () => Promise<string>) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await callback();
        } catch (error) {
          if (attempt >= config.retries.limit) throw error;
        }
      }
    },
  } as unknown as import("cloudflare:workers").WorkflowStep;
  await runReconciliationWorkflow({ ...testEnv, CATALOGUE_DB: database, PRINTING_IMAGES: images }, event, step);
  expect(failures).toBe(4);
  const paused = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
  expect(paused).toMatchObject({ state: "paused", generation: 1, completed_observations: 1 });
  expect(paused.checkpoints).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        phase: "source_graph",
        ordinal: 0,
        cursor: { inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      }),
      expect.objectContaining({
        phase: "normalization",
        ordinal: 0,
        cursor: expect.objectContaining({ observationSetId: firstSet.id }),
      }),
    ]),
  );
  expect(
    (
      await post(`/v1/ingestion-runs/${run.id}/reconciliation/resume`, {
        generation: 1,
        idempotency_key: "resume-normalization-document-cursor",
      })
    ).response.status,
  ).toBe(200);
  resumed = true;
  await runReconciliationWorkflow(
    { ...testEnv, CATALOGUE_DB: database, PRINTING_IMAGES: images },
    { payload: { ...event.payload, generation: 1 } } as typeof event,
    step,
  );
  const completed = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
  expect(completed, JSON.stringify({ state: completed.state, failure_code: completed.failure_code })).toMatchObject({
    state: "sealed",
    generation: 1,
    deadline: paused.deadline,
  });
});
