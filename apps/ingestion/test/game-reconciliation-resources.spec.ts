import { expect, test } from "vitest";
import worker from "../src/index";
import type { ReconciliationWorkflowParams } from "../../../src/catalogue/reconciliation";
import { runReconciliationWorkflow } from "./reconciliation-workflow-driver";
import {
  approve,
  reconcile,
  post,
  collect,
  get,
  installReconciliationSuite,
  requiredString,
  testEnv,
} from "./reconciliation-helpers";

import { canonicalJson, sha256Text } from "../../../src/catalogue/shared";

installReconciliationSuite();

test.each([
  "capacity-card-identity-fanout",
  "capacity-card-inline-errata",
  "capacity-product-input-fanout",
  "capacity-product-identity-fanout",
  "capacity-card-facts-fanout",
  "known-card-facts-fanout",
  "capacity-nested-card-matches",
  "curated-text-target",
  "curated-text-target-retry",
  "curated-text-target-normalization-retry",
  "curated-text-target-reducer-retry",
  "large-card-content",
  "card-only-work-units",
])("%s respects the D1/R2 callback budget", async (scenario) => {
  const fixture = scenario.startsWith("curated-text-target") ? "curated-text-target" : scenario;
  let injectedFailures = 0;
  let predecessor = "catrev_spine_000";
  if (fixture === "capacity-product-identity-fanout") {
    const seed = await reconcile((await collect(`/reconciliation/${fixture}-base`, "product-identity-seed")).id);
    const published = await approve(seed.document);
    expect(published.response.status, JSON.stringify(published.document)).toBe(200);
    predecessor = requiredString(published.document, "resulting_revision_id");
  }
  if (fixture === "curated-text-target") {
    const seed = await reconcile(
      (await collect("/reconciliation/curated-text-target-base", "curated-resource-seed")).id,
    );
    const card = (seed.document.cards as { id: string; name: string }[])[0]!;
    const published = await approve(seed.document);
    expect(published.response.status).toBe(200);
    predecessor = requiredString(published.document, "resulting_revision_id");
    const proposal = {
      game: "one-piece",
      target: { kind: "field", entity_type: "card", entity_id: card.id, path: "/name" },
      assertion: { kind: "field", value: "Reviewed curated text target" },
      rationale: "Reviewed name for retained source",
      evidence: [{ kind: "owner_reference", uri: "https://owner.example/text-target", content_digest: "a".repeat(64) }],
      effective_interval: { from: null, to: null },
      reviewed_source_digest: await sha256Text(canonicalJson(card.name)),
      supersedes_revision_id: null,
    };
    const revision = await post("/admin/v1/curated-revisions", {
      environment: "production",
      expected_current_revision_id: predecessor,
      proposal,
      proposal_digest: await sha256Text(canonicalJson(proposal)),
      idempotency_key: "curated-resource-correction",
    });
    expect(revision.response.status, JSON.stringify(revision.document)).toBe(201);
  }
  const source = await collect(`/reconciliation/${fixture}`, "native-resource-evidence");
  let params: ReconciliationWorkflowParams | undefined;
  const queued = { status: async () => ({ status: "queued" }) } as unknown as WorkflowInstance;
  const binding = {
    create: async (options: { params: ReconciliationWorkflowParams }) => {
      params = options.params;
      return queued;
    },
    get: async () => queued,
  } as unknown as Env["RECONCILIATION_WORKFLOW"];
  const created = await worker.fetch(
    new Request("https://card-keepr.invalid/v1/game-candidates", {
      method: "POST",
      headers: { authorization: "Bearer vitest-administration-key", "content-type": "application/json" },
      body: JSON.stringify({
        ingestion_run_id: source.id,
        supported_game: "one-piece",
        expected_game_revision_id: predecessor,
        idempotency_key: "native-resource-candidate",
      }),
    }),
    { ...testEnv, RECONCILIATION_WORKFLOW: binding },
  );
  expect(created.status).toBe(201);
  const id = requiredString(await created.json<Record<string, unknown>>(), "id");
  expect(params).toBeDefined();
  let calls = 0;
  const measured: { name: string; calls: number }[] = [];
  const statement = (original: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(original, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => statement(target.bind(...values));
        const value = Reflect.get(target, property);
        if (["run", "first", "all", "raw"].includes(String(property)))
          return (...args: unknown[]) => {
            calls++;
            return Reflect.apply(value, target, args);
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const database = new Proxy(testEnv.CATALOGUE_DB, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => {
          if (
            injectedFailures === 0 &&
            ((scenario === "curated-text-target-retry" && sql.includes("json_quote(content)")) ||
              (scenario === "curated-text-target-normalization-retry" &&
                sql.includes("INSERT INTO reconciliation_observation_origins")) ||
              (scenario === "curated-text-target-reducer-retry" &&
                sql.includes("INSERT INTO reconciliation_reducer_state")))
          ) {
            injectedFailures++;
            throw new Error("Injected synchronous text-page preparation outage.");
          }
          return statement(target.prepare(sql));
        };
      if (property === "batch")
        return (...args: Parameters<D1Database["batch"]>) => {
          calls++;
          return target.batch(...args);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const bucket = (original: R2Bucket) =>
    new Proxy(original, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          calls++;
          return Reflect.apply(value, target, args);
        };
      },
    });
  await runReconciliationWorkflow(
    {
      ...testEnv,
      CATALOGUE_DB: database,
      EVIDENCE_OBJECTS: bucket(testEnv.EVIDENCE_OBJECTS),
      PRINTING_IMAGES: bucket(testEnv.PRINTING_IMAGES),
    },
    {
      instanceId: "native-resource-root",
      payload: params!,
    } as import("cloudflare:workers").WorkflowEvent<ReconciliationWorkflowParams>,
    {
      do: async (name: string, config: { retries: { limit: number } }, callback: () => Promise<string>) => {
        for (let attempt = 0; ; attempt++) {
          calls = 0;
          try {
            return await callback();
          } catch (error) {
            if (attempt >= config.retries.limit) throw error;
          } finally {
            measured.push({ name, calls });
          }
        }
      },
    } as unknown as import("cloudflare:workers").WorkflowStep,
  );
  expect(measured.filter(({ calls }) => calls > 100)).toEqual([]);
  const candidate = (await get(`/v1/game-candidates/${id}`)).document;
  expect(candidate, JSON.stringify(candidate)).toMatchObject({
    ...(scenario === "card-only-work-units" ||
    scenario === "known-card-facts-fanout" ||
    scenario === "large-card-content" ||
    fixture === "curated-text-target"
      ? { state: "sealed" }
      : { state: "failed", failure_code: "reconciliation_capacity_exceeded" }),
  });
  if (fixture === "curated-text-target") {
    const evidence = await get(`/v1/game-candidates/${id}/inspection/evidence/curated`);
    expect(evidence.response.status).toBe(200);
    expect(evidence.document.records).toEqual([
      expect.objectContaining({
        proposal: expect.objectContaining({ assertion: { kind: "field", value: "Reviewed curated text target" } }),
      }),
    ]);
    const page = (await get(`/v1/game-candidates/${id}/partitions`)).document;
    const cards = (page.partitions as { kind: string; ordinal: number }[]).filter((part) => part.kind === "cards");
    expect(cards).toHaveLength(1);
    const detail = (await get(`/v1/game-candidates/${id}/partitions/${cards[0]!.ordinal}`)).document;
    expect(detail.records).toMatchObject([{ name: "Reviewed curated text target" }]);
    const parts = (detail.text_parts as { path: (string | number)[]; sha256: string; byte_length: number }[][])[0]!;
    expect(parts).toHaveLength(32);
    const expectedTraits = Array.from(
      { length: 32 },
      (_, index) => `Synthetic trait ${index} ${"text ".repeat(8000)}`,
    ).sort();
    for (let index = 0; index < 32; index++) {
      const expected = expectedTraits[index]!;
      expect(parts).toContainEqual(
        expect.objectContaining({
          path: ["game_data", "attributes", "traits", index],
          sha256: await sha256Text(expected),
          byte_length: new TextEncoder().encode(expected).byteLength,
        }),
      );
    }
  }
  if (scenario.endsWith("-retry")) expect(injectedFailures).toBe(1);
  expect(measured.length).toBeGreaterThan(10);
});
