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

test.each([
  { scenario: "curated-conflict-fanout-base", requireFrozenMetadata: false, groups: [8, 8, 8, 8] },
  { scenario: "curated-conflict-fanout-base", requireFrozenMetadata: true, groups: [8, 8, 8, 8] },
  { scenario: "large-card-content", requireFrozenMetadata: true, groups: [1] },
  { scenario: "single-card-warning-work-units", requireFrozenMetadata: true, groups: [1] },
  { scenario: "card-only-work-units", requireFrozenMetadata: true, groups: [], expectedObservations: 32 },
  { scenario: "metadata-request-pages", requireFrozenMetadata: true, groups: Array(32).fill(1), requestCount: 32 },
])(
  "normalization returns bounded work units for $scenario (frozen metadata: $requireFrozenMetadata)",
  async ({
    scenario,
    requireFrozenMetadata,
    groups,
    requestCount = 1,
    expectedObservations = scenario === "curated-conflict-fanout-base" ? 32 : requestCount,
  }) => {
    const run = await collectRequests(
      Array.from({ length: requestCount }, (_, index) => ({
        id: `cards-${index}`,
        scenario: requestCount > 1 ? `${scenario}?request=${index}` : scenario,
      })),
      "normalization-work-units",
    );
    let imagesInUnit = 0;
    let serviceCalls = 0;
    const completedGroups: number[] = [];
    const callsPerGroup: number[] = [];
    const preparationCalls: number[] = [];
    const preparationCursors: number[] = [];
    const metadataScans: number[] = [];
    const verificationCalls: number[] = [];
    const verificationCursors: number[] = [];
    const reductionCalls: number[] = [];
    const reductionCursors: number[] = [];
    let officialCardsComplete = false;
    let officialErrataComplete = false;
    const images = new Proxy(testEnv.PRINTING_IMAGES, {
      get(target, property) {
        if (property === "put")
          return async (...args: Parameters<R2Bucket["put"]>) => {
            imagesInUnit++;
            serviceCalls++;
            return target.put(...args);
          };
        if (property === "get")
          return (...args: Parameters<R2Bucket["get"]>) => {
            serviceCalls++;
            return target.get(...args);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const wrap = (statement: D1PreparedStatement, sql: string, values: unknown[] = []): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, property) {
          if (property === "bind") return (...bound: unknown[]) => wrap(target.bind(...bound), sql, bound);
          const value = Reflect.get(target, property);
          if (["run", "first", "all", "raw"].includes(String(property)))
            return (...args: unknown[]) => {
              serviceCalls++;
              if (
                officialCardsComplete &&
                !officialErrataComplete &&
                sql.includes("FROM reconciliation_input_partitions") &&
                values.includes("observations")
              )
                throw new Error("The completed Card scan found no dedicated Errata; do not reread its observations.");
              return Reflect.apply(value, target, args);
            };
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    const database = new Proxy(testEnv.CATALOGUE_DB, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            if (requireFrozenMetadata && completedGroups.length > 0 && sql.includes("AS completed_reducer_records"))
              throw new Error("Continuing a work unit must not recount the complete retained candidate.");
            if (requireFrozenMetadata && completedGroups.length > 0 && /\b(?:FROM|JOIN)\s+source_requests\b/u.test(sql))
              throw new Error("A returning normalization unit must reopen the frozen request selection.");
            return wrap(target.prepare(sql), sql);
          };
        if (property === "batch")
          return (...args: Parameters<D1Database["batch"]>) => {
            serviceCalls++;
            return target.batch(...args);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const step = {
      do: async (_name: string, _config: unknown, callback: () => Promise<unknown>) => {
        imagesInUnit = 0;
        serviceCalls = 0;
        const result = await callback();
        if (imagesInUnit) {
          completedGroups.push(imagesInUnit);
          callsPerGroup.push(serviceCalls);
        }
        if (JSON.parse(result as string).continuation?.phase === "input_preparation") {
          preparationCalls.push(serviceCalls);
          const status = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
          const checkpoint = (
            status.checkpoints as {
              phase: string;
              cursor: { preparedObservations: number; completedMetadataScans: number };
            }[]
          ).find((row) => row.phase === "input_preparation");
          preparationCursors.push(checkpoint?.cursor.preparedObservations ?? -1);
          metadataScans.push(checkpoint?.cursor.completedMetadataScans ?? -1);
        }
        if (JSON.parse(result as string).continuation?.phase === "input_verification") {
          verificationCalls.push(serviceCalls);
          const status = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
          const checkpoint = (status.checkpoints as { phase: string; cursor: { verifiedObservations: number } }[]).find(
            (row) => row.phase === "input_verification",
          );
          verificationCursors.push(checkpoint!.cursor.verifiedObservations);
        }
        if (JSON.parse(result as string).continuation?.phase === "official_reduction") {
          reductionCalls.push(serviceCalls);
          const status = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
          const checkpoint = (
            status.checkpoints as { phase: string; cursor: { processedObservations: number; complete: boolean } }[]
          ).find((row) => row.phase === "official_reduction");
          reductionCursors.push(checkpoint!.cursor.processedObservations);
          officialCardsComplete = checkpoint!.cursor.complete;
        }
        if (JSON.parse(result as string).continuation?.phase === "official_errata") officialErrataComplete = true;
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
    const completed = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
    expect(completed, JSON.stringify({ state: completed.state, failure_code: completed.failure_code })).toMatchObject({
      state: "sealed",
    });
    if (scenario === "single-card-warning-work-units") {
      const page = (await get(`/v1/ingestion-runs/${run.id}/reconciliation/partitions`)).document;
      const warnings = (page.partitions as { kind: string; record_count: number; byte_length: number }[]).filter(
        ({ kind }) => kind === "warnings",
      );
      expect(warnings.reduce((sum, part) => sum + part.record_count, 0)).toBeGreaterThanOrEqual(64);
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings.every(({ byte_length }) => byte_length <= 524288)).toBe(true);
    }
    expect(completedGroups).toEqual(groups);
    if (requireFrozenMetadata) {
      expect(Math.max(...callsPerGroup)).toBeLessThanOrEqual(100);
      expect(preparationCalls.length).toBeGreaterThan(0);
      expect(Math.max(...preparationCalls)).toBeLessThanOrEqual(100);
      expect(preparationCursors).toContain(expectedObservations);
      if (requestCount === 32) expect(metadataScans).toContain(8);
      expect(reductionCalls.length).toBeGreaterThan(0);
      expect(Math.max(...reductionCalls)).toBeLessThanOrEqual(100);
      expect(reductionCursors).toContain(expectedObservations);
      if (scenario === "card-only-work-units") expect(reductionCalls.length).toBeLessThanOrEqual(10);
      if (scenario === "curated-conflict-fanout-base")
        expect(reductionCursors.some((count) => count > 0 && count < 32)).toBe(true);
      expect(verificationCalls.length).toBeGreaterThan(0);
      expect(Math.max(...verificationCalls)).toBeLessThanOrEqual(100);
      if (scenario === "curated-conflict-fanout-base") expect(verificationCursors).toContain(8);
    }
    expect((await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document).toMatchObject({ state: "sealed" });
  },
);
