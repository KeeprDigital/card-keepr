import { expect, test } from "vitest";
import {
  approveNativeCandidateThroughBinding as approveNativeCandidate,
  prepareNativeCandidateThroughBinding as prepareNativeCandidate,
} from "./native-publication-helpers";
import { collect, get, installReconciliationSuite, post, requiredString, testEnv } from "./reconciliation-helpers";
import { runReconciliationWorkflow } from "./reconciliation-workflow-driver";

installReconciliationSuite();

test("Product work resumes after partial writes and carries forward releases absent from the next source check", async () => {
  const source = await collect("/reconciliation/card-only-work-units", "product-cursor-seed");
  const seed = await prepareNativeCandidate(source.id, "one-piece", "catrev_spine_000", "product-cursor-candidate");
  expect((await approveNativeCandidate(seed, "product-cursor-publish")).document.state).toBe("published");
  const run = await collect("/reconciliation/card-only-work-units-changed", "product-cursor-next");
  let calls = 0;
  let armed = false;
  let resumed = false;
  let writes = 0;
  let failures = 0;
  const progress: number[] = [];
  const stages = new Set<string>();
  const unitCalls: number[] = [];
  const statements = new WeakMap<object, { sql: string; values: unknown[] }>();
  const wrap = (statement: D1PreparedStatement, sql: string, values: unknown[] = []): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...bound: unknown[]) => wrap(target.bind(...bound), sql, bound);
        const value = Reflect.get(target, property);
        if (["run", "first", "all", "raw"].includes(String(property)))
          return (...args: unknown[]) => {
            calls++;
            return Reflect.apply(value, target, args);
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    statements.set(proxy, { sql, values });
    return proxy;
  };
  const database = new Proxy(testEnv.CATALOGUE_DB, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === "batch")
        return (...args: Parameters<D1Database["batch"]>) => {
          calls++;
          if (
            armed &&
            !resumed &&
            args[0].some((statement) => {
              const entry = statements.get(statement);
              return (
                entry?.sql.includes("INSERT INTO reconciliation_reducer_state") &&
                entry.values.includes("product_observations_one-piece")
              );
            }) &&
            ++writes === 2
          ) {
            failures++;
            throw new Error("Injected Product storage outage after one uncheckpointed observation.");
          }
          return target.batch(...args);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const step = {
    do: async (_name: string, config: { retries: { limit: number } }, callback: () => Promise<string>) => {
      let result: string;
      for (let attempt = 0; ; attempt++) {
        calls = 0;
        writes = 0;
        try {
          result = await callback();
          break;
        } catch (error) {
          if (attempt >= config.retries.limit) throw error;
        }
      }
      if (JSON.parse(result).continuation?.phase === "product_reduction:one-piece") {
        unitCalls.push(calls);
        const status = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
        const checkpoint = (
          status.checkpoints as { phase: string; cursor: { stage: string; processedInputs: number } }[]
        ).find((row) => row.phase === "product_reduction:one-piece")!;
        progress.push(checkpoint.cursor.processedInputs);
        stages.add(checkpoint.cursor.stage);
        if (checkpoint.cursor.processedInputs > 0) armed = true;
      }
      expect(new TextEncoder().encode(result).byteLength).toBeLessThan(65536);
      return result;
    },
  } as unknown as import("cloudflare:workers").WorkflowStep;
  const event = {
    payload: {
      ingestion_run_id: run.id,
      expected_current_revision_id: requiredString(run.document, "expected_current_revision_id"),
      idempotency_key: "product-cursor-next",
      observed_at: new Date().toISOString(),
      generation: 0,
    },
  } as import("cloudflare:workers").WorkflowEvent<
    import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams
  >;
  const environment = { ...testEnv, CATALOGUE_DB: database };
  await runReconciliationWorkflow(environment, event, step);
  expect(failures).toBe(4);
  const paused = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
  expect(paused).toMatchObject({ state: "paused", generation: 1 });
  expect(
    (
      await post(`/v1/ingestion-runs/${run.id}/reconciliation/resume`, {
        generation: 1,
        idempotency_key: "resume-product-cursor",
      })
    ).response.status,
  ).toBe(200);
  resumed = true;
  await runReconciliationWorkflow(environment, { payload: { ...event.payload, generation: 1 } } as typeof event, step);
  const complete = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
  expect(complete).toMatchObject({ state: "sealed", generation: 1, deadline: paused.deadline });
  expect(progress.some((count) => count > 0 && count < 32)).toBe(true);
  expect(progress).toContain(32);
  expect(stages.has("inputs")).toBe(true);
  expect(stages.has("complete")).toBe(true);
  expect(Math.max(...unitCalls)).toBeLessThanOrEqual(100);
  const page = (await get(`/v1/ingestion-runs/${run.id}/reconciliation/partitions`)).document;
  for (const kind of ["products", "distribution_contexts"]) {
    const records: unknown[] = [];
    for (const partition of (page.partitions as { kind: string; ordinal: number }[]).filter(
      (part) => part.kind === kind,
    )) {
      const detail = (await get(`/v1/ingestion-runs/${run.id}/reconciliation/partitions/${partition.ordinal}`))
        .document;
      records.push(...(detail.records as unknown[]));
    }
    expect(records).toHaveLength(40);
    if (kind === "products")
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ official_code: "WU-0", observed: false }),
          expect.objectContaining({ official_code: "WU-39" }),
        ]),
      );
  }
});
