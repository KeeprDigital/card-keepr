import { expect, test } from "vitest";
import {
  approve,
  collect,
  get,
  post,
  installReconciliationSuite,
  reconcile,
  requiredString,
  testEnv,
} from "./reconciliation-helpers";
import { runReconciliationWorkflow } from "./reconciliation-workflow-driver";

installReconciliationSuite();

test.each([
  {
    base: "curated-conflict-fanout-base",
    changed: "withdrawal-work-units",
    expectedCards: 32,
    count: 32,
    name: "Synthetic reviewed Card 0",
    interrupt: "semantic_preparation",
  },
  {
    base: "curated-conflict-fanout-base",
    changed: "prior-state-carry-forward",
    expectedCards: 40,
    count: 32,
    name: "Synthetic reviewed Card 0",
    interrupt: "prior_state",
  },
  {
    base: "curated-conflict-fanout-base",
    changed: "prior-state-carry-forward",
    expectedCards: 40,
    count: 32,
    name: "Synthetic reviewed Card 0",
    interrupt: "official_reduction",
  },
  {
    base: "curated-conflict-fanout-base",
    changed: "dedicated-errata-work-units",
    expectedCards: 32,
    count: 32,
    name: "Synthetic reviewed Card 0",
    interrupt: "official_errata",
  },
  {
    base: "curated-conflict-fanout-base",
    changed: "withdrawal-work-units",
    expectedCards: 32,
    count: 32,
    name: "Synthetic reviewed Card 0",
    interrupt: "withdrawal_diagnostics",
  },
  {
    base: "curated-conflict-fanout-base",
    changed: "prior-state-carry-forward",
    expectedCards: 40,
    count: 32,
    name: "Synthetic reviewed Card 0",
    interrupt: "official_assembly",
  },
  {
    base: "single-card-warning-work-units",
    changed: "single-card-warning-work-units",
    expectedCards: 1,
    count: 1,
    name: "Synthetic Card with many source warnings",
    interrupt: "source_warnings",
  },
  {
    base: "curated-conflict-fanout-base",
    changed: "prior-state-carry-forward",
    expectedCards: 40,
    count: 32,
    name: "Synthetic reviewed Card 0",
    interrupt: "disappearance_warnings",
  },
  {
    base: "prior-state-text-pages",
    changed: "prior-state-text-pages",
    expectedCards: 32,
    count: 32,
    name: "Synthetic reviewed Card 0",
  },
])(
  "prior Cards from $base resume through durable returning groups ($interrupt)",
  async ({ base, changed, count, expectedCards, name, interrupt = "" }) => {
    const prior = await collect(`/reconciliation/${base}`, "prior-state-base");
    const accepted = await reconcile(prior.id);
    expect(accepted.response.status).toBe(200);
    expect((await approve(accepted.document)).response.status).toBe(200);
    const run = await collect(
      `/reconciliation/${changed}`,
      "prior-state-changed",
      interrupt === "official_errata"
        ? {
            game: "one-piece",
            lineage: "one-piece-en",
            adapter: "fixture-one-piece-official-errata-json@1",
          }
        : undefined,
    );
    const errataCursors: number[] = [];
    const errataCalls: number[] = [];
    const withdrawalCursors: number[] = [];
    const withdrawalCalls: number[] = [];
    const semanticCalls: number[] = [];
    const semanticCursors: number[] = [];
    const disappearanceCursors: number[] = [];
    const disappearanceCalls: number[] = [];
    const sourceWarningCursors: number[] = [];
    const sourceWarningCalls: number[] = [];
    const assembledCards: number[] = [];
    const assemblyCalls: number[] = [];
    const assembledObserved: { cards: number; printings: number }[] = [];
    const restoredCards: number[] = [];
    let calls = 0;
    let armed = false;
    let resumed = false;
    let priorWrites = 0;
    let failures = 0;
    const statements = new WeakMap<object, { sql: string; values: unknown[] }>();
    const callsPerUnit: number[] = [];
    const chunkPositions: number[] = [];
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
              interrupt &&
              armed &&
              !resumed &&
              args[0].some((statement) => {
                const entry = statements.get(statement);
                return (
                  entry?.sql.includes("INSERT INTO reconciliation_reducer_state") &&
                  entry.values.includes(
                    interrupt === "semantic_preparation"
                      ? "semantic_withdrawal_values"
                      : interrupt === "prior_state"
                        ? "prior_cards"
                        : interrupt === "official_errata"
                          ? "current_errata"
                          : interrupt === "withdrawal_diagnostics"
                            ? "withdrawal_assertion_groups"
                            : interrupt === "official_assembly"
                              ? "candidate_before_curated_cards"
                              : interrupt === "source_warnings" || interrupt === "disappearance_warnings"
                                ? "warning_records"
                                : "card_facts",
                  )
                );
              }) &&
              ++priorWrites === 2
            ) {
              failures++;
              throw new Error("Injected reducer storage outage after an uncheckpointed Card write.");
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
          priorWrites = 0;
          try {
            result = await callback();
            break;
          } catch (error) {
            if (attempt >= config.retries.limit) throw error;
          }
        }
        if (JSON.parse(result).continuation?.phase === "prior_state") {
          callsPerUnit.push(calls);
          const status = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
          const checkpoint = (
            status.checkpoints as {
              phase: string;
              cursor: { seededCards: number; member: { chunkIndex: number } | null };
            }[]
          ).find((row) => row.phase === "prior_state");
          restoredCards.push(checkpoint!.cursor.seededCards);
          if (interrupt === "prior_state" && checkpoint!.cursor.seededCards > 0) armed = true;
          if (checkpoint!.cursor.member) chunkPositions.push(checkpoint!.cursor.member.chunkIndex);
        }
        if (interrupt === "official_reduction" && JSON.parse(result).continuation?.phase === "official_reduction") {
          const status = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
          const checkpoint = (
            status.checkpoints as { phase: string; cursor: { processedObservations: number } }[]
          ).find((row) => row.phase === "official_reduction");
          if (checkpoint!.cursor.processedObservations > 0) armed = true;
        }
        if (interrupt === "source_warnings" && JSON.parse(result).continuation?.phase === "official_reduction") {
          sourceWarningCalls.push(calls);
          const status = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
          const checkpoint = (
            status.checkpoints as { phase: string; cursor: { pendingSourceWarning: number | null } }[]
          ).find((row) => row.phase === "official_reduction")!;
          if (checkpoint.cursor.pendingSourceWarning !== null) {
            sourceWarningCursors.push(checkpoint.cursor.pendingSourceWarning);
            if (checkpoint.cursor.pendingSourceWarning >= 8) armed = true;
          }
        }
        if (JSON.parse(result).continuation?.phase === "disappearance_warnings") {
          disappearanceCalls.push(calls);
          const status = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
          const checkpoint = (status.checkpoints as { phase: string; cursor: { processedRecords: number } }[]).find(
            (row) => row.phase === "disappearance_warnings",
          )!;
          disappearanceCursors.push(checkpoint.cursor.processedRecords);
          if (interrupt === "disappearance_warnings") armed = true;
        }
        if (JSON.parse(result).continuation?.phase === "official_errata") {
          errataCalls.push(calls);
          const status = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
          const checkpoint = (status.checkpoints as { phase: string; cursor: { processedErrata: number } }[]).find(
            (row) => row.phase === "official_errata",
          )!;
          errataCursors.push(checkpoint.cursor.processedErrata);
          if (interrupt === "official_errata" && checkpoint.cursor.processedErrata > 0) armed = true;
        }
        if (JSON.parse(result).continuation?.phase === "semantic_preparation") {
          semanticCalls.push(calls);
          const status = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
          const checkpoint = (status.checkpoints as { phase: string; cursor: { processedPlans: number } }[]).find(
            ({ phase }) => phase === "semantic_preparation",
          )!;
          semanticCursors.push(checkpoint.cursor.processedPlans);
          if (interrupt === "semantic_preparation" && checkpoint.cursor.processedPlans > 0) armed = true;
        }
        if (JSON.parse(result).continuation?.phase === "withdrawal_diagnostics") {
          withdrawalCalls.push(calls);
          const status = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
          const checkpoint = (status.checkpoints as { phase: string; cursor: { processedPlans: number } }[]).find(
            (row) => row.phase === "withdrawal_diagnostics",
          )!;
          withdrawalCursors.push(checkpoint.cursor.processedPlans);
          if (interrupt === "withdrawal_diagnostics" && checkpoint.cursor.processedPlans > 0) armed = true;
        }
        if (JSON.parse(result).continuation?.phase === "official_assembly") {
          assemblyCalls.push(calls);
          const status = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
          const checkpoint = (
            status.checkpoints as {
              phase: string;
              cursor: { cards: number; observedCards: number; observedPrintings: number };
            }[]
          ).find((row) => row.phase === "official_assembly")!;
          assembledCards.push(checkpoint.cursor.cards);
          assembledObserved.push({
            cards: checkpoint.cursor.observedCards,
            printings: checkpoint.cursor.observedPrintings,
          });
          if (interrupt === "official_assembly" && checkpoint.cursor.cards > 0) armed = true;
        }
        expect(new TextEncoder().encode(result).byteLength).toBeLessThan(65536);
        return result;
      },
    } as unknown as import("cloudflare:workers").WorkflowStep;
    const event = {
      payload: {
        ingestion_run_id: run.id,
        expected_current_revision_id: requiredString(run.document, "expected_current_revision_id"),
        idempotency_key: "prior-state-changed",
        observed_at: new Date().toISOString(),
        generation: 0,
      },
    } as import("cloudflare:workers").WorkflowEvent<
      import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams
    >;
    const environment = { ...testEnv, CATALOGUE_DB: database };
    await runReconciliationWorkflow(environment, event, step);
    if (interrupt) {
      expect(failures).toBe(4);
      const paused = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
      expect(paused).toMatchObject({ state: "paused", generation: 1 });
      expect(
        (
          await post(`/v1/ingestion-runs/${run.id}/reconciliation/resume`, {
            generation: 1,
            idempotency_key: "resume-prior-state-cursor",
          })
        ).response.status,
      ).toBe(200);
      resumed = true;
      await runReconciliationWorkflow(
        environment,
        { payload: { ...event.payload, generation: 1 } } as typeof event,
        step,
      );
      expect((await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document.deadline).toBe(paused.deadline);
    }
    expect((await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document).toMatchObject({ state: "sealed" });
    if (count === 32) expect(restoredCards.some((restored) => restored > 0 && restored < 32)).toBe(true);
    if (base === "prior-state-text-pages") expect(Math.max(...chunkPositions)).toBeGreaterThan(0);
    expect(Math.max(...callsPerUnit)).toBeLessThanOrEqual(100);
    expect(Math.max(...assemblyCalls)).toBeLessThanOrEqual(100);
    for (let index = 0; index < restoredCards.length; index++)
      expect(restoredCards[index]! - (restoredCards[index - 1] ?? 0)).toBeLessThanOrEqual(8);
    expect(restoredCards).toContain(count);
    const page = await get(`/v1/ingestion-runs/${run.id}/reconciliation/partitions`);
    const cards = (page.document.partitions as { kind: string; ordinal: number }[]).find(
      (part) => part.kind === "cards",
    )!;
    const detail = await get(`/v1/ingestion-runs/${run.id}/reconciliation/partitions/${cards.ordinal}`);
    expect(detail.document.records).toHaveLength(expectedCards);
    expect(detail.document.records).toEqual(expect.arrayContaining([expect.objectContaining({ name })]));
    if (interrupt === "disappearance_warnings") {
      expect(disappearanceCursors.some((count) => count > 0 && count < 64)).toBe(true);
      expect(disappearanceCursors).toContain(64);
      expect(Math.max(...disappearanceCalls)).toBeLessThanOrEqual(100);
      let absent = 0;
      for (const partition of page.document.partitions as { kind: string; ordinal: number }[]) {
        if (partition.kind !== "warnings") continue;
        const detail = (await get(`/v1/ingestion-runs/${run.id}/reconciliation/partitions/${partition.ordinal}`))
          .document;
        absent += (detail.records as { code: string }[]).filter(({ code }) => code === "record_not_observed").length;
      }
      expect(absent).toBe(16);
    }
    if (interrupt === "source_warnings") {
      expect(sourceWarningCursors).toContain(8);
      expect(sourceWarningCursors).toContain(56);
      expect(Math.max(...sourceWarningCalls)).toBeLessThanOrEqual(100);
      const warnings = (page.document.partitions as { kind: string; record_count: number }[]).filter(
        ({ kind }) => kind === "warnings",
      );
      expect(warnings.reduce((sum, part) => sum + part.record_count, 0)).toBeGreaterThanOrEqual(64);
    }
    if (interrupt === "official_assembly") {
      expect(assembledCards.some((count) => count > 0 && count < 40)).toBe(true);
      expect(assembledCards).toContain(40);
      expect(assembledObserved).toContainEqual({ cards: 32, printings: 32 });
      expect(assembledObserved.some(({ cards }) => cards > 0 && cards < 32)).toBe(true);
      expect(Math.max(...assemblyCalls)).toBeLessThanOrEqual(100);
    }
    if (interrupt === "semantic_preparation") {
      expect(semanticCursors.some((count) => count > 0 && count < 32)).toBe(true);
      expect(semanticCursors).toContain(32);
      expect(Math.max(...semanticCalls)).toBeLessThanOrEqual(100);
    }
    if (interrupt === "withdrawal_diagnostics" || interrupt === "semantic_preparation") {
      expect(withdrawalCursors.some((count) => count > 0 && count < 32)).toBe(true);
      expect(withdrawalCursors).toContain(32);
      expect(Math.max(...withdrawalCalls)).toBeLessThanOrEqual(100);
      const candidate = await get(`/v1/ingestion-runs/${run.id}/candidate`);
      expect((await approve(candidate.document)).response.status).toBe(200);
      const printing = (accepted.document.printings as { id: string }[])[0]!;
      expect((await get(`/v1/reconciliation/printings/${printing.id}`)).document).toMatchObject({
        lifecycle: { withdrawn: true },
      });
    }
    if (interrupt === "official_errata") {
      expect(errataCursors.some((count) => count > 0 && count < 32)).toBe(true);
      expect(errataCursors).toContain(32);
      expect(Math.max(...errataCalls)).toBeLessThanOrEqual(100);
      const errataPart = (page.document.partitions as { kind: string; ordinal: number }[]).find(
        (part) => part.kind === "errata",
      )!;
      const errata = (await get(`/v1/ingestion-runs/${run.id}/reconciliation/partitions/${errataPart.ordinal}`))
        .document.records;
      expect(errata).toHaveLength(32);
      expect(errata).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ corrected_value: "Corrected rules for Card 0" }),
          expect.objectContaining({ corrected_value: "Corrected rules for Card 31" }),
        ]),
      );
    }
  },
);
