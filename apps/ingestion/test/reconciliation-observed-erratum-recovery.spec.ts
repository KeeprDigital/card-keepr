import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { expect, test } from "vitest";
import type { ReconciliationWorkflowParams } from "../../../src/catalogue/reconciliation";
import { latestReconciliationCheckpointStatement } from "../../../src/catalogue/reconciliation/reconciliation-checkpoint-repository";
import { catalogueStore, consumerContent, sha256Text } from "../../../src/catalogue/shared";
import { nativeCandidateRecords } from "./native-candidate-helpers";
import { retainNativePreparation } from "./native-preparation-fixture";
import { prepareNativeCandidate, seedNativePredecessor } from "./native-publication-helpers";
import { observedErratumEffects } from "./query-helpers/observed-erratum-recovery";
import {
  collect,
  get,
  installReconciliationSuite,
  requiredFirst,
  requiredString,
  testEnv,
} from "./reconciliation-helpers";
import { runReconciliationWorkflow } from "./reconciliation-workflow-driver";

installReconciliationSuite();

type Effect = {
  namespace: string;
  key_digest: string;
  observation_ordinal: number;
  content: string;
  sha256: string;
};
type Checkpoint = { ordinal: number; content: string; sha256: string };

test("a lost committed observed Erratum response replays its source without duplicating evidence", async () => {
  const source = await collect("/reconciliation/errata-card-rules-text", "observed-erratum-seed");
  const seed = await prepareNativeCandidate(
    source.id,
    "one-piece",
    "catrev_spine_000",
    "observed-erratum-seed-candidate",
  );
  const seedId = requiredString(seed, "id");
  const original = await nativeCandidateRecords(seedId, ["cards", "printings", "errata"]);
  const card = requiredFirst(original, "cards");
  const printing = requiredFirst(original, "printings");
  const erratum = requiredFirst(original, "errata");
  expect(original.cards).toHaveLength(1);
  expect(original.printings).toHaveLength(1);
  expect(original.errata).toHaveLength(1);
  const predecessor = await seedNativePredecessor(seed, "observed-erratum-predecessor");
  expect(predecessor.checkpoint).toBe("pending");
  const refresh = await collect("/reconciliation/errata-card-rules-text", "observed-erratum-refresh");
  const preparation = await retainNativePreparation(refresh.id, predecessor.revisionId, "observed-erratum-candidate");
  const id = preparation.candidateId;
  const initial = (await get(`/v1/game-candidates/${id}`)).document;
  const effects = async () => (await observedErratumEffects(testEnv.CATALOGUE_DB).bind(id).all<Effect>()).results;
  const checkpoint = (phase: string) =>
    latestReconciliationCheckpointStatement(catalogueStore(testEnv.CATALOGUE_DB), id, phase).first<Checkpoint>();
  const boundary = async () => ({
    effects: await effects(),
    prior: await checkpoint("prior_state"),
    source: await checkpoint("official_reduction"),
  });
  let loss: { before: Awaited<ReturnType<typeof boundary>>; after: Awaited<ReturnType<typeof boundary>> } | undefined;
  const statements = new WeakMap<object, { sql: string; values: unknown[] }>();
  const wrap = (statement: D1PreparedStatement, sql: string, values: unknown[] = []): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...bound: unknown[]) => wrap(target.bind(...bound), sql, bound);
        const value = Reflect.get(target, property);
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
        return async (batch: D1PreparedStatement[]) => {
          const observedWrite = batch.some((statement) => {
            const entry = statements.get(statement);
            return (
              entry?.sql.includes("INSERT INTO reconciliation_reducer_state") &&
              entry.values[0] === id &&
              entry.values[1] === "observed_errata"
            );
          });
          if (!loss && observedWrite) {
            const before = await boundary();
            await target.batch(batch);
            loss = { before, after: await boundary() };
            throw new Error("Injected loss of the committed observed Erratum response.");
          }
          return target.batch(batch);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const event = { payload: preparation.params } as WorkflowEvent<ReconciliationWorkflowParams>;
  const retries: { attempt: number; limit: number }[] = [];
  const step = {
    do: async (_name: string, config: { retries: { limit: number } }, callback: () => Promise<string>) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await callback();
        } catch (error) {
          retries.push({ attempt, limit: config.retries.limit });
          if (attempt >= config.retries.limit) throw error;
        }
      }
    },
  } as unknown as WorkflowStep;
  await runReconciliationWorkflow({ ...testEnv, CATALOGUE_DB: database }, event, step);
  expect(loss).toBeDefined();
  expect(retries).toHaveLength(1);
  expect(retries[0]!.attempt).toBe(0);
  expect(retries[0]!.limit).toBeGreaterThan(retries[0]!.attempt);
  expect(loss!.before.effects.map(({ namespace }) => namespace)).toEqual(["current_errata", "prior_errata"]);
  expect(loss!.after.effects.map(({ namespace }) => namespace)).toEqual([
    "current_errata",
    "observed_errata",
    "prior_errata",
  ]);
  expect(loss!.after.effects.filter(({ namespace }) => namespace !== "observed_errata")).toEqual(loss!.before.effects);
  expect(loss!.before.prior).not.toBeNull();
  expect(loss!.after.prior).toEqual(loss!.before.prior);
  expect(loss!.before.source).not.toBeNull();
  expect(loss!.after.source).toEqual(loss!.before.source);
  for (const retained of [loss!.before.prior!, loss!.before.source!, ...loss!.after.effects])
    expect(await sha256Text(retained.content)).toBe(retained.sha256);
  expect(JSON.parse(loss!.before.prior!.content)).toMatchObject({
    candidate: seedId,
    complete: true,
    positions: { priorErrata: 1, currentErrata: 1 },
  });
  expect(JSON.parse(loss!.before.source!.content)).toMatchObject({
    complete: false,
    after: null,
    processedObservations: 0,
    prior: { priorErrata: 1, currentErrata: 1 },
    indexes: { observedErrata: 0 },
  });
  for (const effect of loss!.before.effects) expect(JSON.parse(effect.content).value).toEqual(erratum);
  const observed = loss!.after.effects.find(({ namespace }) => namespace === "observed_errata")!;
  expect(observed.observation_ordinal).toBe(1);
  const observedValue = JSON.parse(observed.content).value;
  expect(observedValue).toEqual({
    ...erratum,
    provenance: [{ source_lineage: "one-piece-en", source_observation_id: expect.any(String) }],
  });
  const sealed = (await get(`/v1/game-candidates/${id}`)).document;
  expect(sealed).toMatchObject({
    id,
    state: "sealed",
    generation: initial.generation,
    deadline: initial.deadline,
    expected_game_revision_id: predecessor.revisionId,
  });
  const retainedEffects = await effects();
  expect(retainedEffects.filter(({ namespace }) => namespace === "observed_errata")).toEqual([observed]);
  const records = await nativeCandidateRecords(id, ["cards", "printings", "errata"]);
  expect(records.cards).toEqual(original.cards);
  expect(consumerContent(records.printings)).toEqual(consumerContent(original.printings));
  expect(records.cards![0]).toMatchObject({
    id: card.id,
    effective_rules_text: "[On Play] Draw 2 cards, then discard 1 card.",
  });
  expect(records.printings![0]).toMatchObject({
    id: printing.id,
    card_id: card.id,
    printed_rules_text: "[On Play] Draw 1 card.",
  });
  expect(records.errata).toHaveLength(1);
  expect(records.errata![0]).toMatchObject({
    id: erratum.id,
    target_id: card.id,
    corrected_value: "[On Play] Draw 2 cards, then discard 1 card.",
  });
  const provenance = records.errata![0]!.provenance as { source_lineage: string; source_observation_id: string }[];
  expect(provenance).toHaveLength(2);
  expect(new Set(provenance.map(({ source_observation_id }) => source_observation_id)).size).toBe(2);
  expect(provenance).toEqual(
    expect.arrayContaining([...(erratum.provenance as unknown[]), ...observedValue.provenance]),
  );
  await runReconciliationWorkflow({ ...testEnv, CATALOGUE_DB: database }, event, step);
  expect((await get(`/v1/game-candidates/${id}`)).document).toEqual(sealed);
  expect(await nativeCandidateRecords(id, ["cards", "printings", "errata"])).toEqual(records);
  expect(await effects()).toEqual(retainedEffects);
  expect(await nativeCandidateRecords(seedId, ["cards", "printings", "errata"])).toEqual(original);
  expect((await get(`/v1/backups/${predecessor.backupAttemptId}`)).document.state).toBe("pending");
});
