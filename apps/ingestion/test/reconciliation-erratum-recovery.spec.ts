import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { expect, test } from "vitest";
import type { ReconciliationWorkflowParams } from "../../../src/catalogue/reconciliation";
import { latestReconciliationCheckpointStatement } from "../../../src/catalogue/reconciliation/reconciliation-checkpoint-repository";
import { compositionEntityResponse } from "../../../src/catalogue/read/composition-read";
import { catalogueStore, consumerContent, sha256Text } from "../../../src/catalogue/shared";
import { nativeCandidateRecords } from "./native-candidate-helpers";
import { retainNativePreparation } from "./native-preparation-fixture";
import { approveNativeCandidate, prepareNativeCandidate } from "./native-publication-helpers";
import {
  erratumPublication,
  priorErratumEffects,
  restoredErratumPublicationSql,
} from "./query-helpers/erratum-recovery";
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

test("a lost committed Erratum seed response preserves its predecessor through resume, publication and SQL restore", async () => {
  const source = await collect("/reconciliation/errata-card-rules-text", "erratum-loss-seed");
  const seed = await prepareNativeCandidate(source.id, "one-piece", "catrev_spine_000", "erratum-loss-seed-candidate");
  const seedId = requiredString(seed, "id");
  const original = await nativeCandidateRecords(seedId, ["cards", "printings", "errata"]);
  const card = requiredFirst(original, "cards");
  const printing = requiredFirst(original, "printings");
  const erratum = requiredFirst(original, "errata");
  expect(original.cards).toHaveLength(1);
  expect(original.printings).toHaveLength(1);
  expect(original.errata).toHaveLength(1);
  expect(card.effective_rules_text).toBe("[On Play] Draw 2 cards, then discard 1 card.");
  expect(printing.printed_rules_text).toBe("[On Play] Draw 1 card.");
  const firstPublication = await approveNativeCandidate(seed, "erratum-loss-seed-approval");
  const predecessor = requiredString(firstPublication.document, "resulting_revision_id");
  const refresh = await collect("/reconciliation/errata-card-rules-text", "erratum-loss-refresh");
  const preparation = await retainNativePreparation(refresh.id, predecessor, "erratum-loss-candidate");
  const id = preparation.candidateId;
  const checkpoint = () =>
    latestReconciliationCheckpointStatement(
      catalogueStore(testEnv.CATALOGUE_DB),
      id,
      "prior_state",
    ).first<Checkpoint>();
  const effects = async () => (await priorErratumEffects(testEnv.CATALOGUE_DB).bind(id).all<Effect>()).results;
  const losses: {
    before: Effect[];
    after: Effect[];
    checkpointBefore: Checkpoint | null;
    checkpointAfter: Checkpoint | null;
    expected: { content: string; sha256: string };
  }[] = [];
  const statements = new WeakMap<object, { sql: string; values: unknown[] }>();
  let unavailable = true;
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
          const write = batch
            .map((statement) => statements.get(statement))
            .find(
              (entry) =>
                entry?.sql.includes("INSERT INTO reconciliation_reducer_state") &&
                entry.values[0] === id &&
                entry.values[1] === "current_errata" &&
                entry.values[3] === 1,
            );
          if (unavailable && write) {
            const before = await effects();
            const checkpointBefore = await checkpoint();
            await target.batch(batch);
            losses.push({
              before,
              after: await effects(),
              checkpointBefore,
              checkpointAfter: await checkpoint(),
              expected: { content: String(write.values[4]), sha256: String(write.values[5]) },
            });
            throw new Error("Injected response loss after the current Erratum seed committed.");
          }
          return target.batch(batch);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const event = { payload: preparation.params } as WorkflowEvent<ReconciliationWorkflowParams>;
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
  } as unknown as WorkflowStep;
  await runReconciliationWorkflow({ ...testEnv, CATALOGUE_DB: database }, event, step);
  expect(losses).toHaveLength(4);
  expect(losses[0]!.before.map(({ namespace }) => namespace)).toEqual(["prior_errata"]);
  for (const loss of losses) {
    expect(loss.after.map(({ namespace }) => namespace)).toEqual(["current_errata", "prior_errata"]);
    expect(loss.after).toEqual(losses[0]!.after);
    expect(loss.after[0]).toMatchObject({ ...loss.expected, observation_ordinal: 1 });
    expect(loss.after[1]).toEqual(loss.before.find(({ namespace }) => namespace === "prior_errata"));
    for (const effect of loss.after) {
      expect(await sha256Text(effect.content)).toBe(effect.sha256);
      expect(JSON.parse(effect.content).value).toEqual(erratum);
    }
    expect(loss.checkpointBefore).not.toBeNull();
    expect(loss.checkpointAfter).toEqual(loss.checkpointBefore);
    expect(await sha256Text(loss.checkpointBefore!.content)).toBe(loss.checkpointBefore!.sha256);
    expect(JSON.parse(loss.checkpointBefore!.content)).toMatchObject({
      candidate: seedId,
      complete: false,
      positions: { priorErrata: 0, currentErrata: 0 },
    });
  }
  const paused = (await get(`/v1/game-candidates/${id}`)).document;
  expect(paused).toMatchObject({ id, state: "paused", generation: 1, expected_game_revision_id: predecessor });
  expect(paused.manifest_digest).toBeNull();
  const resume = () => preparation.resume(1, "erratum-loss-resume");
  const resumed = await resume();
  expect(resumed.status).toBe(202);
  expect(await (await resume()).json()).toEqual(await resumed.json());
  unavailable = false;
  const resumedEvent = { payload: { ...event.payload, generation: 1 } } as typeof event;
  await runReconciliationWorkflow({ ...testEnv, CATALOGUE_DB: database }, resumedEvent, step);
  const sealed = (await get(`/v1/game-candidates/${id}`)).document;
  expect(sealed).toMatchObject({
    id,
    state: "sealed",
    generation: 1,
    deadline: paused.deadline,
    expected_game_revision_id: predecessor,
  });
  const records = await nativeCandidateRecords(id);
  expect(records.cards).toEqual(original.cards);
  expect(consumerContent(records.printings)).toEqual(consumerContent(original.printings));
  expect(records.errata).toHaveLength(1);
  expect(records.errata![0]).toMatchObject({
    id: erratum.id,
    target_id: card.id,
    corrected_value: "[On Play] Draw 2 cards, then discard 1 card.",
  });
  const provenance = records.errata![0]!.provenance as { source_observation_id: string }[];
  expect(provenance).toHaveLength(2);
  expect(new Set(provenance.map(({ source_observation_id }) => source_observation_id)).size).toBe(2);
  await runReconciliationWorkflow({ ...testEnv, CATALOGUE_DB: database }, resumedEvent, step);
  expect((await get(`/v1/game-candidates/${id}`)).document).toEqual(sealed);
  expect(await nativeCandidateRecords(id)).toEqual(records);
  expect(await nativeCandidateRecords(seedId, ["cards", "printings", "errata"])).toEqual(original);

  const published = await approveNativeCandidate(sealed, "erratum-loss-approval");
  expect(published.document).toMatchObject({ candidate_id: id, state: "published", approval_scope: "whole_candidate" });
  const base = { origin: "https://catalogue.example", basePath: "" };
  for (const [kind, entity] of [
    ["cards", card],
    ["printings", printing],
  ] as const) {
    const response = await compositionEntityResponse(
      catalogueStore(testEnv.CATALOGUE_DB),
      new Request(`${base.origin}/v1/${kind}/${entity.id}`),
      base,
      kind,
      String(entity.id),
    );
    expect(response!.status).toBe(200);
    const document = await response!.json<{ data: Record<string, unknown> }>();
    expect(document.data).toMatchObject({
      id: entity.id,
      ...(kind === "cards"
        ? { effective_rules_text: "[On Play] Draw 2 cards, then discard 1 card." }
        : { card_id: card.id, printed_rules_text: "[On Play] Draw 1 card." }),
    });
  }
  const backup = (await get(`/v1/backups/${published.document.backup_attempt_id}`)).document;
  expect(backup).toMatchObject({ state: "verified", catalogue_revision_id: published.document.resulting_revision_id });
  const params = [String(published.document.id), String(card.id), String(printing.id)];
  const live = await erratumPublication(testEnv.CATALOGUE_DB)
    .bind(...params)
    .first<Record<string, unknown>>();
  expect(live).toMatchObject({
    candidate_id: id,
    state: "published",
    predecessor_candidate_id: seedId,
    accepted_candidate_id: id,
  });
  expect(JSON.parse(String(live!.request_json))).toMatchObject({
    candidate_id: id,
    manifest_digest: sealed.manifest_digest,
  });
  const mappings = JSON.parse(String(live!.source_mappings));
  expect(mappings).toHaveLength(4);
  expect(mappings).toEqual(
    expect.arrayContaining(
      [card, printing].flatMap((entity) => [
        expect.objectContaining({ entity_id: entity.id, preparation_id: seedId, ingestion_run_id: source.id }),
        expect.objectContaining({ entity_id: entity.id, preparation_id: id, ingestion_run_id: refresh.id }),
      ]),
    ),
  );
  const documents = JSON.parse(String(live!.documents)) as {
    kind: string;
    id: string;
    content: string;
    sha256: string;
  }[];
  expect(documents.map(({ id: entityId }) => entityId).sort()).toEqual([card.id, printing.id, erratum.id].sort());
  for (const document of documents) {
    expect(await sha256Text(document.content)).toBe(document.sha256);
    const envelope = JSON.parse(document.content).records[0];
    expect(envelope.text_parts).toEqual([]);
    expect(envelope.value).toMatchObject(
      document.kind === "cards"
        ? { id: card.id, effective_rules_text: "[On Play] Draw 2 cards, then discard 1 card." }
        : document.kind === "printings"
          ? { id: printing.id, card_id: card.id, printed_rules_text: "[On Play] Draw 1 card." }
          : { id: erratum.id, target_id: card.id, corrected_value: "[On Play] Draw 2 cards, then discard 1 card." },
    );
  }
  const restored = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${testEnv.CLOUDFLARE_ACCOUNT_ID}/d1/database/${backup.disposable_database_id}/query`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.D1_VERIFICATION_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ sql: restoredErratumPublicationSql, params }),
    },
  );
  expect(restored.status).toBe(200);
  const imported = await restored.json<{ success: boolean; result: { success: boolean; results: unknown[] }[] }>();
  expect(imported).toMatchObject({ success: true, result: [{ success: true, results: [live] }] });
});
