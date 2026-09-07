import { expect, test } from "vitest";
import {
  collectRequests,
  get,
  installReconciliationSuite,
  post,
  requiredString,
  testEnv,
} from "./reconciliation-helpers";
import { runReconciliationWorkflow } from "./reconciliation-workflow-driver";

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
              ? sql.includes("FROM reconciliation_source_byte_chunks") && values.includes(firstSet.id)
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
  { scenario: "capacity-single-observation", requireFrozenMetadata: true, groups: [1] },
  { scenario: "large-card-content", requireFrozenMetadata: true, groups: [1] },
  {
    scenario: "three-role-image-work-units",
    requireFrozenMetadata: true,
    groups: [6, 6, 6, 6],
    expectedObservations: 8,
  },
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
    const selectionCalls: number[] = [];
    const curatedCalls: number[] = [];
    const semanticCalls: number[] = [];
    const sortingCalls: number[] = [];
    const digestCalls: number[] = [];
    const candidateDigestCalls: number[] = [];
    const partitionCalls: number[] = [];
    const mappingCalls: number[] = [];
    const summaryCalls: number[] = [];
    const stagingCalls: number[] = [];
    const payloadCalls: number[] = [];
    const gameCalls: number[] = [];
    const graphCalls: number[] = [];
    const graphCursors: number[] = [];
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
        if (JSON.parse(result as string).continuation?.phase === "game_preparation") gameCalls.push(serviceCalls);
        if (JSON.parse(result as string).continuation?.phase === "candidate_staging") stagingCalls.push(serviceCalls);
        if (JSON.parse(result as string).continuation?.phase?.startsWith("payload_preparation:"))
          payloadCalls.push(serviceCalls);
        if (JSON.parse(result as string).continuation?.phase === "warning_summary") summaryCalls.push(serviceCalls);
        if (JSON.parse(result as string).continuation?.phase === "source_mappings") mappingCalls.push(serviceCalls);
        if (JSON.parse(result as string).continuation?.phase === "candidate_partitions")
          partitionCalls.push(serviceCalls);
        if (JSON.parse(result as string).continuation?.phase === "canonical_digest:candidate")
          candidateDigestCalls.push(serviceCalls);
        if (JSON.parse(result as string).continuation?.phase === "canonical_digest:catalogue")
          digestCalls.push(serviceCalls);
        if (JSON.parse(result as string).continuation?.phase?.startsWith("record_sorting:"))
          sortingCalls.push(serviceCalls);
        if (JSON.parse(result as string).continuation?.phase === "semantic_preparation")
          semanticCalls.push(serviceCalls);
        if (JSON.parse(result as string).continuation?.phase === "curated_revisions") curatedCalls.push(serviceCalls);
        if (JSON.parse(result as string).continuation?.phase === "source_selection") selectionCalls.push(serviceCalls);
        if (JSON.parse(result as string).continuation?.phase === "graph_validation") {
          graphCalls.push(serviceCalls);
          const status = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
          const checkpoint = (status.checkpoints as { phase: string; cursor: { processedRequests: number } }[]).find(
            ({ phase }) => phase === "graph_validation",
          )!;
          graphCursors.push(checkpoint.cursor.processedRequests);
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
    if (scenario === "three-role-image-work-units") expect(Math.max(...callsPerGroup)).toBeLessThanOrEqual(100);
    expect(completedGroups).toEqual(groups);
    if (requireFrozenMetadata) {
      expect(gameCalls.length).toBeGreaterThan(0);
      expect(Math.max(...gameCalls)).toBeLessThanOrEqual(100);
      expect(stagingCalls.length).toBeGreaterThan(0);
      expect(Math.max(...stagingCalls)).toBeLessThanOrEqual(100);
      expect(payloadCalls.length).toBeGreaterThan(0);
      expect(Math.max(...payloadCalls)).toBeLessThanOrEqual(100);
      expect(summaryCalls.length).toBeGreaterThan(0);
      expect(Math.max(...summaryCalls)).toBeLessThanOrEqual(100);
      expect(mappingCalls.length).toBeGreaterThan(0);
      expect(Math.max(...mappingCalls)).toBeLessThanOrEqual(100);
      expect(partitionCalls.length).toBeGreaterThan(0);
      expect(Math.max(...partitionCalls)).toBeLessThanOrEqual(100);
      expect(candidateDigestCalls.length).toBeGreaterThan(0);
      expect(Math.max(...candidateDigestCalls)).toBeLessThanOrEqual(100);
      expect(digestCalls.length).toBeGreaterThan(0);
      expect(Math.max(...digestCalls)).toBeLessThanOrEqual(100);
      expect(sortingCalls.length).toBeGreaterThan(0);
      expect(Math.max(...sortingCalls)).toBeLessThanOrEqual(100);
      expect(semanticCalls.length).toBeGreaterThan(0);
      expect(Math.max(...semanticCalls)).toBeLessThanOrEqual(100);
      expect(curatedCalls.length).toBeGreaterThan(0);
      expect(Math.max(...curatedCalls)).toBeLessThanOrEqual(100);
      expect(selectionCalls.length).toBeGreaterThan(0);
      expect(Math.max(...selectionCalls)).toBeLessThanOrEqual(100);
      expect(graphCalls.length).toBeGreaterThan(0);
      expect(Math.max(...graphCalls)).toBeLessThanOrEqual(100);
      if (requestCount === 32) expect(graphCursors.some((count) => count > 0 && count < 32)).toBe(true);
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

test.each(["r2", "receipt"])(
  "source observation bytes resume from retained ranges after %s storage failure",
  async (failure) => {
    const run = await collectRequests([{ id: "cards", scenario: "prior-state-text-pages" }], "source-byte-cursor");
    let serviceCalls = 0;
    const documentCalls: number[] = [];
    let failures = 0;
    let resumed = false;
    let completedBytes = 0;
    const completed: number[] = [];
    const ranges: number[] = [];
    const evidence = new Proxy(testEnv.EVIDENCE_OBJECTS, {
      get(target, property) {
        if (property === "get")
          return (...args: Parameters<R2Bucket["get"]>) => {
            serviceCalls++;
            if (args[0].startsWith("source-observations/")) {
              const range = args[1]?.range as { offset?: number; length?: number } | undefined;
              expect(range?.length).toBeLessThanOrEqual(65536);
              expect(range?.offset).toBeGreaterThanOrEqual(completedBytes);
              if (failure === "r2" && completedBytes > 0 && !resumed) {
                failures++;
                throw new Error("Injected source byte storage outage after retained progress.");
              }
              ranges.push(range!.offset!);
            }
            return target.get(...args);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, property) {
          if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
          const value = Reflect.get(target, property);
          if (["run", "first", "all", "raw"].includes(String(property)))
            return (...args: unknown[]) => {
              serviceCalls++;
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
              failure === "receipt" &&
              completedBytes > 0 &&
              !resumed &&
              sql.includes("FROM reconciliation_source_byte_chunks")
            ) {
              failures++;
              throw new Error("Injected synchronous source receipt preparation outage after retained progress.");
            }
            return wrap(target.prepare(sql));
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
      do: async (_name: string, config: { retries: { limit: number } }, callback: () => Promise<string>) => {
        let result: string;
        for (let attempt = 0; ; attempt++) {
          try {
            serviceCalls = 0;
            result = await callback();
            break;
          } catch (error) {
            if (attempt >= config.retries.limit) throw error;
          }
        }
        if (JSON.parse(result).continuation?.phase === "source_documents") {
          documentCalls.push(serviceCalls);
          const progress = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
          const checkpoint = (progress.checkpoints as { phase: string; cursor: { offset: number } }[]).find(
            ({ phase }) => phase === "source_documents",
          )!;
          completedBytes = checkpoint.cursor.offset;
          completed.push(completedBytes);
        }
        return result;
      },
    } as unknown as import("cloudflare:workers").WorkflowStep;
    const event = {
      payload: {
        ingestion_run_id: run.id,
        expected_current_revision_id: requiredString(run.document, "expected_current_revision_id"),
        idempotency_key: "source-byte-cursor",
        observed_at: new Date().toISOString(),
        generation: 0,
      },
    } as import("cloudflare:workers").WorkflowEvent<
      import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams
    >;
    const environment = { ...testEnv, EVIDENCE_OBJECTS: evidence, CATALOGUE_DB: database };
    await runReconciliationWorkflow(environment, event, step);
    expect(failures).toBe(4);
    const paused = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
    expect(paused).toMatchObject({ state: "paused", generation: 1 });
    expect(
      (
        await post(`/v1/ingestion-runs/${run.id}/reconciliation/resume`, {
          generation: 1,
          idempotency_key: "resume-source-bytes",
        })
      ).response.status,
    ).toBe(200);
    resumed = true;
    await runReconciliationWorkflow(
      environment,
      { payload: { ...event.payload, generation: 1 } } as typeof event,
      step,
    );
    const sealed = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
    expect(sealed).toMatchObject({ state: "sealed", deadline: paused.deadline });
    expect(Math.max(...documentCalls)).toBeLessThanOrEqual(100);
    expect(completed.length).toBeGreaterThan(2);
    if (failure === "r2") expect(new Set(ranges).size).toBe(ranges.length);
    else expect(ranges.length - new Set(ranges).size).toBe(4);
    const page = (await get(`/v1/ingestion-runs/${run.id}/reconciliation/partitions`)).document;
    const cards = (page.partitions as { kind: string; record_count: number }[]).filter(({ kind }) => kind === "cards");
    expect(cards.reduce((sum, part) => sum + part.record_count, 0)).toBe(32);
  },
);

test("source selection resumes after an uncheckpointed evidence receipt without rescanning its completed prefix", async () => {
  const run = await collectRequests(
    Array.from({ length: 12 }, (_, index) => ({
      id: `cards-${index}`,
      scenario: `metadata-request-pages?request=${index}`,
    })),
    "selection-receipt-cursor",
  );
  let selectionSequence = -1;
  let resumed = false;
  let failures = 0;
  const wrap = (statement: D1PreparedStatement, sql: string, values: unknown[] = []): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...bound: unknown[]) => wrap(target.bind(...bound), sql, bound);
        if (
          property === "first" &&
          selectionSequence >= 0 &&
          !resumed &&
          sql.includes("SELECT content, sha256 FROM reconciliation_evidence_selection")
        )
          return async () => {
            failures++;
            throw new Error("Injected selection receipt outage after an uncheckpointed write.");
          };
        if (
          property === "first" &&
          selectionSequence >= 0 &&
          sql.includes("FROM source_requests") &&
          sql.includes("ORDER BY sequence_number, request_id LIMIT 1")
        )
          expect(Number(values[1])).toBeGreaterThanOrEqual(selectionSequence);
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
  const step = {
    do: async (_name: string, config: { retries: { limit: number } }, callback: () => Promise<string>) => {
      let result: string;
      for (let attempt = 0; ; attempt++) {
        try {
          result = await callback();
          break;
        } catch (error) {
          if (attempt >= config.retries.limit) throw error;
        }
      }
      if (JSON.parse(result).continuation?.phase === "source_selection") {
        const progress = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
        const checkpoint = (
          progress.checkpoints as { phase: string; cursor: { stage: string; sequence: number } }[]
        ).find(({ phase }) => phase === "source_selection")!;
        if (checkpoint.cursor.stage === "selection" && checkpoint.cursor.sequence >= 0)
          selectionSequence = checkpoint.cursor.sequence;
      }
      return result;
    },
  } as unknown as import("cloudflare:workers").WorkflowStep;
  const event = {
    payload: {
      ingestion_run_id: run.id,
      expected_current_revision_id: requiredString(run.document, "expected_current_revision_id"),
      idempotency_key: "selection-receipt-cursor",
      observed_at: new Date().toISOString(),
      generation: 0,
    },
  } as import("cloudflare:workers").WorkflowEvent<
    import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams
  >;
  await runReconciliationWorkflow({ ...testEnv, CATALOGUE_DB: database }, event, step);
  expect(failures).toBe(4);
  const paused = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
  expect(paused).toMatchObject({ state: "paused", generation: 1 });
  expect(
    (
      await post(`/v1/ingestion-runs/${run.id}/reconciliation/resume`, {
        generation: 1,
        idempotency_key: "resume-selection-receipt",
      })
    ).response.status,
  ).toBe(200);
  resumed = true;
  await runReconciliationWorkflow(
    { ...testEnv, CATALOGUE_DB: database },
    { payload: { ...event.payload, generation: 1 } } as typeof event,
    step,
  );
  const sealed = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
  expect(sealed).toMatchObject({ state: "sealed", deadline: paused.deadline });
  const page = (await get(`/v1/ingestion-runs/${run.id}/reconciliation/partitions`)).document;
  expect(
    (page.partitions as { kind: string; record_count: number }[])
      .filter(({ kind }) => kind === "cards")
      .reduce((sum, part) => sum + part.record_count, 0),
  ).toBe(12);
});

test("canonical sorting replays an uncheckpointed merge batch and preserves every warning", async () => {
  const run = await collectRequests([{ id: "cards", scenario: "single-card-warning-work-units" }], "sort-replay");
  const phase = "record_sorting:warning_records_sorted";
  let armed = false;
  let resumed = false;
  let failures = 0;
  let serviceCalls = 0;
  const calls: number[] = [];
  const passes = new Set<number>();
  const mergeWrites: string[] = [];
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...bound: unknown[]) => {
            if (armed && !resumed && sql.includes("INSERT INTO reconciliation_checkpoints") && bound.includes(phase)) {
              failures++;
              throw new Error("Injected checkpoint construction failure after a retained merge batch.");
            }
            if (
              sql.includes("INSERT INTO reconciliation_sort_batches") &&
              bound[1] === "warning_records_sorted" &&
              Number(bound[2]) > 0
            )
              mergeWrites.push(JSON.stringify(bound));
            return wrap(target.bind(...bound), sql);
          };
        const value = Reflect.get(target, property);
        if (["run", "first", "all", "raw"].includes(String(property)))
          return (...args: unknown[]) => {
            serviceCalls++;
            return Reflect.apply(value, target, args);
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const database = new Proxy(testEnv.CATALOGUE_DB, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
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
    do: async (_name: string, config: { retries: { limit: number } }, callback: () => Promise<string>) => {
      let result: string;
      for (let attempt = 0; ; attempt++) {
        serviceCalls = 0;
        try {
          result = await callback();
          break;
        } catch (error) {
          if (attempt >= config.retries.limit) throw error;
        }
      }
      if (JSON.parse(result).continuation?.phase === phase) {
        calls.push(serviceCalls);
        const progress = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
        const checkpoint = (
          progress.checkpoints as { phase: string; cursor: { stage: string; pass: number; outputBatch: number } }[]
        ).find((item) => item.phase === phase)!;
        passes.add(checkpoint.cursor.pass);
        if (checkpoint.cursor.stage === "merge" && checkpoint.cursor.outputBatch > 0) armed = true;
      }
      return result;
    },
  } as unknown as import("cloudflare:workers").WorkflowStep;
  const event = {
    payload: {
      ingestion_run_id: run.id,
      expected_current_revision_id: requiredString(run.document, "expected_current_revision_id"),
      idempotency_key: "sort-replay",
      observed_at: new Date().toISOString(),
      generation: 0,
    },
  } as import("cloudflare:workers").WorkflowEvent<
    import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams
  >;
  await runReconciliationWorkflow({ ...testEnv, CATALOGUE_DB: database }, event, step);
  expect(failures).toBe(4);
  expect(mergeWrites.length - new Set(mergeWrites).size).toBe(3);
  const paused = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
  expect(paused).toMatchObject({ state: "paused", generation: 1 });
  expect(
    (
      await post(`/v1/ingestion-runs/${run.id}/reconciliation/resume`, {
        generation: 1,
        idempotency_key: "resume-sort-replay",
      })
    ).response.status,
  ).toBe(200);
  resumed = true;
  await runReconciliationWorkflow(
    { ...testEnv, CATALOGUE_DB: database },
    { payload: { ...event.payload, generation: 1 } } as typeof event,
    step,
  );
  const sealed = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
  expect(sealed).toMatchObject({ state: "sealed", deadline: paused.deadline });
  expect(passes.has(2)).toBe(true);
  expect(Math.max(...calls)).toBeLessThanOrEqual(100);
  const page = (await get(`/v1/ingestion-runs/${run.id}/reconciliation/partitions`)).document;
  const warnings: unknown[] = [];
  for (const part of page.partitions as { kind: string; ordinal: number }[]) {
    if (part.kind === "warnings")
      warnings.push(
        ...((await get(`/v1/ingestion-runs/${run.id}/reconciliation/partitions/${part.ordinal}`)).document
          .records as unknown[]),
      );
  }
  const { canonicalJson } = await import("../../../src/catalogue/shared");
  const keys = warnings.map(canonicalJson);
  expect(keys.length).toBeGreaterThanOrEqual(64);
  expect(new Set(keys).size).toBe(keys.length);
  expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
});

test.each(["canonical_digest:candidate", "payload_preparation:digest"])(
  "%s resumes inside large Card text after a checkpoint write outage",
  async (phase) => {
    const run = await collectRequests([{ id: "cards", scenario: "large-card-content" }], "hash-replay");
    const payloadChunks = new Map<number, string>();
    const progressValue = (cursor: { sha?: { bytes: string }; chunks?: number }) =>
      cursor.sha ? Number(cursor.sha.bytes) : cursor.chunks!;
    let armed = false;
    let resumed = false;
    let failures = 0;
    let savedBytes = 0;
    let resumedBytes = 0;
    const database = new Proxy(testEnv.CATALOGUE_DB, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            const statement = target.prepare(sql);
            return new Proxy(statement, {
              get(prepared, method) {
                if (method === "bind")
                  return (...values: unknown[]) => {
                    if (sql.includes("INSERT INTO reconciliation_checkpoints") && values[1] === phase) {
                      const cursor = JSON.parse(values[3] as string) as { sha?: { bytes: string }; chunks?: number };
                      if (armed && !resumed) {
                        failures++;
                        throw new Error("Injected hash checkpoint write outage.");
                      }
                      if (resumed) resumedBytes ||= progressValue(cursor);
                    }
                    if (sql.includes("INSERT INTO reconciliation_payload_chunks") && values[1] === "digest") {
                      const index = Number(values[2]),
                        content = String(values[3]);
                      if (payloadChunks.has(index)) expect(payloadChunks.get(index)).toBe(content);
                      payloadChunks.set(index, content);
                    }
                    return prepared.bind(...values);
                  };
                const value = Reflect.get(prepared, method);
                return typeof value === "function" ? value.bind(prepared) : value;
              },
            });
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const step = {
      do: async (_name: string, config: { retries: { limit: number } }, callback: () => Promise<string>) => {
        let result: string;
        for (let attempt = 0; ; attempt++) {
          try {
            result = await callback();
            break;
          } catch (error) {
            if (attempt >= config.retries.limit) throw error;
          }
        }
        if (!armed && JSON.parse(result).continuation?.phase === phase) {
          const progress = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
          const checkpoint = (
            progress.checkpoints as {
              phase: string;
              cursor: { chunk: number; sha?: { bytes: string }; chunks?: number };
            }[]
          ).find((item) => item.phase === phase)!;
          if (checkpoint.cursor.chunk > 0) {
            armed = true;
            savedBytes = progressValue(checkpoint.cursor);
          }
        }
        return result;
      },
    } as unknown as import("cloudflare:workers").WorkflowStep;
    const event = {
      payload: {
        ingestion_run_id: run.id,
        expected_current_revision_id: requiredString(run.document, "expected_current_revision_id"),
        idempotency_key: "hash-replay",
        observed_at: new Date().toISOString(),
        generation: 0,
      },
    } as import("cloudflare:workers").WorkflowEvent<
      import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams
    >;
    await runReconciliationWorkflow({ ...testEnv, CATALOGUE_DB: database }, event, step);
    expect(failures).toBe(4);
    expect(savedBytes).toBeGreaterThan(phase === "canonical_digest:candidate" ? 500000 : 0);
    const paused = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
    expect(paused).toMatchObject({ state: "paused", generation: 1 });
    expect(
      (
        await post(`/v1/ingestion-runs/${run.id}/reconciliation/resume`, {
          generation: 1,
          idempotency_key: "resume-hash-replay",
        })
      ).response.status,
    ).toBe(200);
    resumed = true;
    await runReconciliationWorkflow(
      { ...testEnv, CATALOGUE_DB: database },
      { payload: { ...event.payload, generation: 1 } } as typeof event,
      step,
    );
    const sealed = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
    expect(sealed).toMatchObject({ state: "sealed", deadline: paused.deadline });
    expect(resumedBytes).toBeGreaterThan(savedBytes);
    const digest = (sealed.checkpoints as { phase: string; cursor: { digest?: string } }[]).find(
      (item) => item.phase === "canonical_digest:candidate",
    )!.cursor.digest;
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    const retainedPayload = [...payloadChunks]
      .sort(([left], [right]) => left - right)
      .map(([, content]) => content)
      .join("");
    expect(new TextEncoder().encode(retainedPayload).byteLength).toBeGreaterThan(1000000);
    const retainedDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(retainedPayload));
    expect(Array.from(new Uint8Array(retainedDigest), (byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(
      digest,
    );
    // Replaying the same completed operation must retain the exact digest.
    await runReconciliationWorkflow(
      { ...testEnv, CATALOGUE_DB: database },
      { payload: { ...event.payload, generation: 1 } } as typeof event,
      step,
    );
    const replayed = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
    expect(
      (replayed.checkpoints as { phase: string; cursor: { digest?: string } }[]).find(
        (item) => item.phase === "canonical_digest:candidate",
      )!.cursor.digest,
    ).toBe(digest);
  },
);

test.each([
  {
    phase: "candidate_partitions",
    scenario: "curated-conflict-fanout-base",
    progressField: "ordinal",
    expectedCards: 32,
  },
  {
    phase: "game_preparation",
    scenario: "curated-conflict-fanout-base",
    progressField: "partition",
    expectedCards: 32,
  },
  { phase: "candidate_staging", scenario: "curated-conflict-fanout-base", progressField: "ordinal", expectedCards: 32 },
  { phase: "warning_summary", scenario: "single-card-warning-work-units", progressField: "total", expectedCards: 1 },
])(
  "$phase resumes after a checkpoint outage without replaying its completed prefix",
  async ({ phase, scenario, progressField, expectedCards }) => {
    const run = await collectRequests([{ id: "cards", scenario }], "partition-replay");
    let completed = 0;
    let completedGameOutput = 0;
    let checkedPartitionWrites = 0;
    let resumed = false;
    let failures = 0;
    const database = new Proxy(testEnv.CATALOGUE_DB, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            const statement = target.prepare(sql);
            return new Proxy(statement, {
              get(prepared, method) {
                if (method === "bind")
                  return (...values: unknown[]) => {
                    if (
                      sql.includes("INSERT INTO reconciliation_checkpoints") &&
                      values[1] === phase &&
                      completed > 0 &&
                      !resumed
                    ) {
                      failures++;
                      throw new Error("Injected partition checkpoint outage after its output write.");
                    }
                    if (completedGameOutput > 0 && sql.includes("INSERT INTO game_candidate_partitions"))
                      expect(Number(values[1])).toBeGreaterThanOrEqual(completedGameOutput);
                    if (
                      phase === "candidate_partitions" &&
                      completed > 0 &&
                      sql.includes("INSERT INTO reconciliation_record_partitions")
                    ) {
                      checkedPartitionWrites++;
                      expect(Number(values[1])).toBeGreaterThanOrEqual(completed);
                    }
                    return prepared.bind(...values);
                  };
                const value = Reflect.get(prepared, method);
                return typeof value === "function" ? value.bind(prepared) : value;
              },
            });
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const step = {
      do: async (_name: string, config: { retries: { limit: number } }, callback: () => Promise<string>) => {
        let result: string;
        for (let attempt = 0; ; attempt++) {
          try {
            result = await callback();
            break;
          } catch (error) {
            if (attempt >= config.retries.limit) throw error;
          }
        }
        if (!completed && JSON.parse(result).continuation?.phase === phase) {
          const progress = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
          const cursor = (progress.checkpoints as { phase: string; cursor: Record<string, number> }[]).find(
            (item) => item.phase === phase,
          )!.cursor;
          if (cursor[progressField]! >= 2) {
            completed = cursor[progressField]!;
            if (phase === "game_preparation") completedGameOutput = cursor.ordinal!;
          }
        }
        return result;
      },
    } as unknown as import("cloudflare:workers").WorkflowStep;
    const event = {
      payload: {
        ingestion_run_id: run.id,
        expected_current_revision_id: requiredString(run.document, "expected_current_revision_id"),
        idempotency_key: "partition-replay",
        observed_at: new Date().toISOString(),
        generation: 0,
      },
    } as import("cloudflare:workers").WorkflowEvent<
      import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams
    >;
    await runReconciliationWorkflow({ ...testEnv, CATALOGUE_DB: database }, event, step);
    expect(failures).toBe(4);
    const paused = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
    expect(paused).toMatchObject({ state: "paused", generation: 1 });
    expect(
      (
        await post(`/v1/ingestion-runs/${run.id}/reconciliation/resume`, {
          generation: 1,
          idempotency_key: "resume-partition-replay",
        })
      ).response.status,
    ).toBe(200);
    resumed = true;
    await runReconciliationWorkflow(
      { ...testEnv, CATALOGUE_DB: database },
      { payload: { ...event.payload, generation: 1 } } as typeof event,
      step,
    );
    const sealed = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
    expect(sealed).toMatchObject({ state: "sealed", deadline: paused.deadline });
    const page = (await get(`/v1/ingestion-runs/${run.id}/reconciliation/partitions`)).document;
    const ids: string[] = [];
    for (const partition of page.partitions as { ordinal: number; kind: string }[]) {
      if (partition.kind !== "cards") continue;
      const detail = (await get(`/v1/ingestion-runs/${run.id}/reconciliation/partitions/${partition.ordinal}`))
        .document;
      ids.push(...(detail.records as { id: string }[]).map((record) => record.id));
    }
    expect(ids.length).toBe(expectedCards);
    expect(new Set(ids).size).toBe(expectedCards);
    if (phase === "candidate_partitions") expect(checkedPartitionWrites).toBeGreaterThan(0);
    if (phase === "game_preparation") {
      expect(completedGameOutput).toBeGreaterThan(0);
      const candidate = (sealed.candidates as { id: string; state: string }[])[0]!;
      const header = (await get(`/v1/game-candidates/${candidate.id}`)).document;
      expect(header).toMatchObject({ state: "sealed", deadline: paused.deadline });
      const gamePage = (await get(`/v1/game-candidates/${candidate.id}/partitions`)).document;
      const gameIds: string[] = [];
      for (const partition of gamePage.partitions as { ordinal: number; kind: string }[]) {
        if (partition.kind !== "cards") continue;
        const detail = (await get(`/v1/game-candidates/${candidate.id}/partitions/${partition.ordinal}`)).document;
        gameIds.push(...(detail.records as { id: string }[]).map((record) => record.id));
      }
      expect(gameIds.sort()).toEqual([...ids].sort());
    }
    if (phase === "warning_summary") {
      const warnings = (page.partitions as { kind: string; record_count: number }[])
        .filter((part) => part.kind === "warnings")
        .reduce((total, part) => total + part.record_count, 0);
      expect(warnings).toBeGreaterThanOrEqual(64);
      expect(
        (sealed.checkpoints as { phase: string; cursor: { total: number } }[]).find((item) => item.phase === phase)!
          .cursor.total,
      ).toBe(warnings);
    }
  },
);
