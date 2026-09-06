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

test.each([
  {
    title: "completed documents",
    successfulImages: 1,
    requests: [
      { id: "first", scenario: "base" },
      { id: "second", scenario: "new-locator" },
    ],
  },
  {
    title: "completed observation groups",
    successfulImages: 8,
    requests: [{ id: "cards", scenario: "curated-conflict-fanout-base" }],
  },
])(
  "normalization resumes after $title without rereading their completed payloads",
  async ({ requests, successfulImages }) => {
    const run = await collectRequests(requests, `normalization-cursor-${successfulImages}`);
    const firstSnapshot = (run.document.snapshots as { id: string; request: { url: string } }[]).find(({ request }) =>
      request.url.endsWith(`/reconciliation/${requests[0]!.scenario}`),
    )!;
    const firstSet = (run.document.observation_sets as { id: string; source_snapshot_id: string }[]).find(
      ({ source_snapshot_id }) => source_snapshot_id === firstSnapshot.id,
    )!;
    let firstObservation: unknown;
    let resumed = false;
    let writes = 0;
    let failures = 0;
    const images = new Proxy(testEnv.PRINTING_IMAGES, {
      get(target, property) {
        if (property === "put")
          return async (...args: Parameters<R2Bucket["put"]>) => {
            if (!resumed && writes++ >= successfulImages) {
              failures++;
              throw new Error("Injected image outage after completed normalization work");
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
          const observationLookup =
            sql.includes("SELECT 1 AS present FROM reconciliation_normalized_observations") && values.length === 2;
          if (!resumed && observationLookup) firstObservation ??= values[1];
          if (
            (property === "first" || property === "all") &&
            resumed &&
            (successfulImages === 1
              ? sql.includes("FROM reconciliation_document_partitions") && values.includes(firstSet.id)
              : observationLookup && values[1] === firstObservation)
          )
            return async () => {
              throw new Error("Completed normalization work must not be revisited during continuation.");
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
    expect(paused).toMatchObject({ state: "paused", generation: 1, completed_observations: successfulImages });
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
          cursor: expect.objectContaining({
            observationSetId: firstSet.id,
            ...(successfulImages === 8 ? { nextObservationOrdinal: 8, complete: false } : {}),
          }),
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
  },
);

test.each([false, true])(
  "normalization returns control between observation groups (frozen metadata: %s)",
  async (requireFrozenMetadata) => {
    const run = await collectRequests(
      [{ id: "cards", scenario: "curated-conflict-fanout-base" }],
      "normalization-work-units",
    );
    let imagesInUnit = 0;
    const completedGroups: number[] = [];
    const images = new Proxy(testEnv.PRINTING_IMAGES, {
      get(target, property) {
        if (property === "put")
          return async (...args: Parameters<R2Bucket["put"]>) => {
            imagesInUnit++;
            return target.put(...args);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const database = new Proxy(testEnv.CATALOGUE_DB, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            if (requireFrozenMetadata && completedGroups.length > 0 && sql.includes("FROM source_requests"))
              throw new Error("A returning normalization unit must reopen the frozen request selection.");
            return target.prepare(sql);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const step = {
      do: async (_name: string, _config: unknown, callback: () => Promise<unknown>) => {
        imagesInUnit = 0;
        const result = await callback();
        if (imagesInUnit) completedGroups.push(imagesInUnit);
        expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(65536);
        return result;
      },
    } as unknown as import("cloudflare:workers").WorkflowStep;
    await runReconciliationWorkflow(
      { ...testEnv, CATALOGUE_DB: database, PRINTING_IMAGES: images },
      {
        payload: {
          ingestion_run_id: run.id,
          expected_current_revision_id: requiredString(run.document, "expected_current_revision_id"),
          idempotency_key: "normalization-work-units",
          observed_at: new Date().toISOString(),
          generation: 0,
        },
      } as import("cloudflare:workers").WorkflowEvent<
        import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams
      >,
      step,
    );
    expect(completedGroups).toEqual([8, 8, 8, 8]);
    expect((await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document).toMatchObject({ state: "sealed" });
  },
);
