import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { expect, test } from "vitest";
import type { CatalogueBackupWorkflowParams } from "../../../src/catalogue/backup-recovery";
import type { ReconciliationWorkflowParams } from "../../../src/catalogue/reconciliation";
import { compositionEntityResponse } from "../../../src/catalogue/read/composition-read";
import { canonicalJson, catalogueStore, sha256Text } from "../../../src/catalogue/shared";
import { runCatalogueBackupWorkflow } from "../src/backup-workflow";
import worker from "../src/index";
import { runReconciliationWorkflow as runNativeWorkflow } from "../src/reconciliation-workflow";
import { nativeCandidateRecords } from "./native-candidate-helpers";
import { retainNativePreparation } from "./native-preparation-fixture";
import {
  approveNativeCandidate,
  prepareNativeCandidate,
  waitForVerifiedPublicationBackup,
} from "./native-publication-helpers";
import {
  curatedPins,
  curatedRevisionRowid,
  identityAllocations,
  preparationCheckpoints,
  preparationNormalizedObservations,
  preparationSeal,
  preparationSourceMappings,
  preparationTextChunks,
  publicationSwitchEffects,
} from "./query-helpers/committed-response-loss";
import {
  collect,
  get,
  installReconciliationSuite,
  post,
  postWithControlledPublication,
  requiredFirst,
  requiredString,
  testEnv,
} from "./reconciliation-helpers";
import { runReconciliationWorkflow } from "./reconciliation-workflow-driver";

installReconciliationSuite();

type Row = Record<string, unknown>;

/** Capture dispatches so the test drives each Workflow exactly once through its production entrypoint. */
function captureWorkflows<Params>() {
  const created: { id: string; params: Params }[] = [];
  const instance = (id: string) => ({ id, status: async () => ({ status: "queued" }) }) as unknown as WorkflowInstance;
  const binding = {
    create: async (options: { id: string; params: Params }) => {
      created.push(options);
      return instance(options.id);
    },
    get: async (id: string) => {
      if (created.some((work) => work.id === id)) return instance(id);
      throw new Error("instance.not_found");
    },
  } as unknown as Workflow<Params>;
  return { created, binding };
}

async function ownerRequest(env: Env, path: string, body: Record<string, unknown>) {
  const response = await worker.fetch(
    new Request(`https://card-keepr.invalid${path}`, {
      method: "POST",
      headers: { authorization: "Bearer vitest-administration-key", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
  return { status: response.status, document: await response.json<Record<string, unknown>>() };
}

async function durableState(id: string) {
  const db = testEnv.CATALOGUE_DB;
  return {
    text: (await preparationTextChunks(db).bind(id).all<Row>()).results,
    normalized: (await preparationNormalizedObservations(db).bind(id).all<Row>()).results,
    mappings: (await preparationSourceMappings(db).bind(id).all<Row>()).results,
    allocations: (await identityAllocations(db).all<Row>()).results,
    checkpoints: (await preparationCheckpoints(db).bind(id).all<Row>()).results,
    seal: await preparationSeal(db).bind(id).first<Row>(),
  };
}

/**
 * Commit the first matching D1 batch for real, then lose its successful response once.
 * `unavailableReads` fails that many immediately following statement preparations.
 */
function loseFirstCommittedResponse<State>(
  snapshot: () => Promise<State>,
  matches: (sql: string, values: unknown[]) => boolean,
  unavailableReads = 0,
) {
  let failReads = 0;
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
  const probe: { loss?: { before: State; after: State }; failedReads: number } = { failedReads: 0 };
  const database = new Proxy(testEnv.CATALOGUE_DB, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => {
          if (failReads > 0) {
            failReads--;
            probe.failedReads++;
            throw new Error("Injected unavailable readback after a lost committed response.");
          }
          return wrap(target.prepare(sql), sql);
        };
      if (property === "batch")
        return async (batch: D1PreparedStatement[]) => {
          const hit = batch.some((statement) => {
            const entry = statements.get(statement);
            return entry !== undefined && matches(entry.sql, entry.values);
          });
          if (probe.loss || !hit) return target.batch(batch);
          const before = await snapshot();
          await target.batch(batch);
          probe.loss = { before, after: await snapshot() };
          failReads = unavailableReads;
          throw new Error("Injected loss of a committed D1 response.");
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { database, probe };
}

type StepContext = { step: { name: string; count: number }; attempt: number };
type Retry = { step: string; attempt: number; limit: number };

/** Mirror the platform's bounded step retries, including its one-based attempt context. */
function retryingStep(retries: Retry[]) {
  return {
    do: async (
      name: string,
      configOrCallback: { retries?: { limit: number } } | ((context: StepContext) => Promise<unknown>),
      possibleCallback?: (context: StepContext) => Promise<unknown>,
    ) => {
      const callback = typeof configOrCallback === "function" ? configOrCallback : possibleCallback!;
      const limit = typeof configOrCallback === "function" ? 5 : (configOrCallback.retries?.limit ?? 5);
      for (let attempt = 0; ; attempt++) {
        try {
          return await callback({ step: { name, count: 1 }, attempt: attempt + 1 });
        } catch (error) {
          retries.push({ step: name, attempt, limit });
          if (attempt >= limit) throw error;
        }
      }
    },
  } as unknown as WorkflowStep;
}

const largeText = "Synthetic printed text. ".repeat(60_000);

test.each([
  {
    boundary: "text chunk",
    scenario: "large-card-content",
    effect: "text",
    matches: (sql: string, values: unknown[], id: string) =>
      sql.includes("INSERT INTO reconciliation_text_chunks") && values[0] === id,
  },
  {
    boundary: "normalized observation",
    scenario: "errata-card-rules-text",
    effect: "normalized",
    matches: (sql: string, values: unknown[], id: string) =>
      sql.includes("INSERT INTO reconciliation_normalized_observations") && values[0] === id,
  },
  {
    boundary: "canonical identity allocation",
    scenario: "base",
    effect: "allocations",
    matches: (sql: string) => sql.includes("INSERT INTO canonical_identity_allocations"),
  },
  {
    boundary: "source mapping",
    scenario: "base",
    effect: "mappings",
    matches: (sql: string, values: unknown[], id: string) =>
      sql.includes("INSERT INTO reconciliation_source_mappings") && values[0] === id,
  },
  {
    boundary: "final seal transaction",
    scenario: "base",
    effect: "seal",
    matches: (sql: string, values: unknown[], id: string) =>
      sql.includes("UPDATE reconciliation_operations SET state = 'sealed'") && values[2] === id,
  },
] as const)(
  "a lost committed $boundary response converges through one bounded retry",
  async ({ boundary, scenario, effect, matches }) => {
    const key = boundary.replaceAll(" ", "-");
    const run = await collect(`/reconciliation/${scenario}`, `response-loss-${key}`);
    const preparation = await retainNativePreparation(run.id, "catrev_spine_000", `response-loss-${key}-candidate`);
    const id = preparation.candidateId;
    const initial = (await get(`/v1/game-candidates/${id}`)).document;
    const { database, probe } = loseFirstCommittedResponse(
      () => durableState(id),
      (sql, values) => matches(sql, values, id),
    );
    const retries: Retry[] = [];
    const event = { payload: preparation.params } as WorkflowEvent<ReconciliationWorkflowParams>;
    await runReconciliationWorkflow({ ...testEnv, CATALOGUE_DB: database }, event, retryingStep(retries));

    // The response was lost only after the durable write committed, while every checkpoint lagged.
    expect(probe.loss, boundary).toBeDefined();
    const { before, after } = probe.loss!;
    expect(after[effect]).not.toEqual(before[effect]);
    expect(after.checkpoints).toEqual(before.checkpoints);
    if (effect === "seal") {
      expect(before.seal).toMatchObject({ operation_state: "preparing", candidate_state: "preparing" });
      expect(after.seal).toMatchObject({ operation_state: "sealed", candidate_state: "sealed" });
      expect(after.seal!.semantic_digest).toMatch(/^[a-f0-9]{64}$/u);
    } else expect(after.seal).toEqual(before.seal);
    expect(retries).toEqual([
      { step: expect.stringMatching(/^reconcile retained Card, Printing/u), attempt: 0, limit: 3 },
    ]);

    // One actual retry seals the same candidate without rewriting or duplicating committed effects.
    const sealed = (await get(`/v1/game-candidates/${id}`)).document;
    expect(sealed).toMatchObject({
      id,
      state: "sealed",
      generation: initial.generation,
      deadline: initial.deadline,
      expected_game_revision_id: "catrev_spine_000",
    });
    const final = await durableState(id);
    for (const kind of ["text", "normalized", "mappings", "allocations"] as const)
      expect(final[kind]).toEqual(expect.arrayContaining(after[kind]));
    if (effect === "seal") expect(final.seal).toEqual(after.seal);
    const inspection = await get(
      `/v1/game-candidates/${id}/inspection?manifest=${requiredString(sealed, "manifest_digest")}`,
    );
    expect(inspection.response.status, JSON.stringify(inspection.document)).toBe(200);
    expect(inspection.document).toMatchObject({ ready: true, manifest_digest: sealed.manifest_digest });

    const records = await nativeCandidateRecords(id, ["cards", "printings"]);
    const entities = [...records.cards!, ...records.printings!].map(({ id }) => String(id)).sort();
    expect(entities).toHaveLength(2);
    expect(final.allocations.map(({ entity_id }) => String(entity_id)).sort()).toEqual(entities);
    expect(new Set(final.mappings.map(({ entity_id }) => String(entity_id)))).toEqual(new Set(entities));
    expect(final.mappings).toHaveLength(entities.length * final.normalized.length);
    expect(new Set(final.normalized.map(({ observation_id }) => observation_id)).size).toBe(final.normalized.length);
    if (effect === "text") {
      const chunks = final.text.map(({ content }) => String(content));
      expect(new Set(final.text.map(({ sha256 }) => sha256)).size).toBe(1);
      expect(final.text.map(({ ordinal }) => ordinal)).toEqual(chunks.map((_, ordinal) => ordinal));
      expect(chunks.join("")).toBe(largeText);
    }

    // Replaying the sealed preparation is a no-op.
    await runReconciliationWorkflow({ ...testEnv, CATALOGUE_DB: database }, event, retryingStep(retries));
    expect(retries).toHaveLength(1);
    expect((await get(`/v1/game-candidates/${id}`)).document).toEqual(sealed);
    expect(await durableState(id)).toEqual(final);
  },
);

test.each([
  { readback: "available", unavailableReads: 0 },
  { readback: "unavailable", unavailableReads: 1 },
])(
  "a lost committed composition switch response with $readback readback publishes exactly once",
  async ({ readback, unavailableReads }) => {
    const run = await collect("/reconciliation/base", `switch-${readback}`);
    const candidate = await prepareNativeCandidate(
      run.id,
      "one-piece",
      "catrev_spine_000",
      `switch-${readback}-candidate`,
    );
    const id = requiredString(candidate, "id");
    const manifest = requiredString(candidate, "manifest_digest");
    const artifacts = await postWithControlledPublication(`/v1/game-candidates/${id}/publication-preparation/start`, {
      manifest_digest: manifest,
      generation: candidate.generation,
      sequence: 0,
      idempotency_key: `switch-${readback}-artifacts`,
    });
    expect(artifacts.response.status, JSON.stringify(artifacts.document)).toBe(202);
    expect((await get(`/v1/game-candidates/${id}/publication-preparation`)).document.state).toBe("verified");
    const workflows = captureWorkflows<ReconciliationWorkflowParams>();
    const backups = captureWorkflows<CatalogueBackupWorkflowParams>();
    const env = { ...testEnv, RECONCILIATION_WORKFLOW: workflows.binding, CATALOGUE_BACKUP_WORKFLOW: backups.binding };
    const approved = await ownerRequest(env, "/v1/publications/start", {
      candidate_id: id,
      manifest_digest: manifest,
      expected_game_revision_id: "catrev_spine_000",
      generation: candidate.generation,
      idempotency_key: `switch-${readback}`,
    });
    expect(approved.status, JSON.stringify(approved.document)).toBe(202);
    const operation = requiredString(approved.document, "id");
    expect(workflows.created).toHaveLength(1);
    const effects = () => publicationSwitchEffects(testEnv.CATALOGUE_DB).bind(operation, "one-piece").first<Row>();
    const { database, probe } = loseFirstCommittedResponse(
      effects,
      (sql, values) =>
        sql.includes("UPDATE game_publication_operations SET state='published'") && values[3] === operation,
      unavailableReads,
    );
    const retries: Retry[] = [];
    const event = {
      instanceId: workflows.created[0]!.id,
      payload: workflows.created[0]!.params,
      timestamp: new Date(),
    } as WorkflowEvent<ReconciliationWorkflowParams>;
    const result = JSON.parse(
      (await runNativeWorkflow({ ...env, CATALOGUE_DB: database }, event, retryingStep(retries))).result_json,
    );

    // The single switch transaction committed membership, heads, receipt and backup reservation before the loss.
    expect(probe.loss).toBeDefined();
    const { before, after } = probe.loss!;
    expect(before).toMatchObject({
      revisions: 0,
      backups: 0,
      candidate_publications: 0,
      game_head: "catrev_spine_000",
    });
    expect(before!.state).not.toBe("published");
    const revision = requiredString(after!, "resulting_revision_id");
    expect(after).toMatchObject({
      state: "published",
      composition_head: revision,
      game_head: revision,
      revisions: 1,
      members: 1,
      backups: 1,
      backup_state: "pending",
      candidate_publications: 1,
    });
    expect(probe.failedReads).toBe(unavailableReads);
    expect(retries).toEqual(
      unavailableReads ? [{ step: expect.stringMatching(/^publication switch \d+$/u), attempt: 0, limit: 3 }] : [],
    );
    expect(result).toMatchObject({
      id: operation,
      state: "published",
      resulting_revision_id: revision,
      backup_attempt_id: after!.backup_attempt_id,
    });
    expect(await effects()).toEqual(after);
    expect(backups.created).toHaveLength(1);
    expect(backups.created[0]!.params).toMatchObject({
      expected_current_revision_id: revision,
      idempotency_key: after!.backup_attempt_id,
    });

    // The reserved backup verifies the switched revision through the actual SQL export/import provider.
    await runCatalogueBackupWorkflow(
      env,
      {
        instanceId: backups.created[0]!.id,
        payload: backups.created[0]!.params,
        timestamp: new Date(),
      } as WorkflowEvent<CatalogueBackupWorkflowParams>,
      retryingStep([]),
    );
    await waitForVerifiedPublicationBackup(requiredString(after!, "backup_attempt_id"), revision);
    const consumerBase = { origin: "https://catalogue.example", basePath: "" };
    const cards = (await (await compositionEntityResponse(
      catalogueStore(testEnv.CATALOGUE_DB),
      new Request(`${consumerBase.origin}/v1/cards?game=one-piece`),
      consumerBase,
      "cards",
    ))!.json()) as { data: { id: string }[] };
    const records = await nativeCandidateRecords(id, ["cards"]);
    expect(cards.data.map(({ id }) => id)).toEqual(records.cards!.map(({ id }) => id));

    // Replaying the publication Workflow observes the terminal receipt without another switch or reservation.
    const replayed = JSON.parse(
      (await runNativeWorkflow({ ...env, CATALOGUE_DB: database }, event, retryingStep(retries))).result_json,
    );
    expect(replayed).toMatchObject({ id: operation, state: "published", resulting_revision_id: revision });
    expect(await effects()).toEqual({ ...after, backup_state: "verified" });
    expect(backups.created).toHaveLength(1);
    expect(retries).toHaveLength(unavailableReads);
  },
);

test("a lost committed native creation response replays its original curated selection pin", async () => {
  const seedRun = await collect("/reconciliation/base", "curated-pin-seed");
  const seed = await prepareNativeCandidate(seedRun.id, "one-piece", "catrev_spine_000", "curated-pin-seed-candidate");
  const original = requiredFirst(await nativeCandidateRecords(requiredString(seed, "id"), ["cards"]), "cards");
  const published = await approveNativeCandidate(seed, "curated-pin-seed-publish");
  const revision = requiredString(published.document, "resulting_revision_id");
  const run = await collect("/reconciliation/base", "curated-pin-refresh");
  const pins = async () => (await curatedPins(testEnv.CATALOGUE_DB).all<Row>()).results;
  const { database, probe } = loseFirstCommittedResponse(
    pins,
    (sql) => sql.includes("INSERT INTO reconciliation_curated_pins"),
    2,
  );
  const workflows = captureWorkflows<ReconciliationWorkflowParams>();
  const intent = {
    ingestion_run_id: run.id,
    supported_game: "one-piece",
    expected_game_revision_id: revision,
    idempotency_key: "curated-pin-refresh-candidate",
  };
  const env = { ...testEnv, RECONCILIATION_WORKFLOW: workflows.binding };
  const lost = await ownerRequest({ ...env, CATALOGUE_DB: database }, "/v1/game-candidates", intent);

  // Creation committed its immutable pin; the response and both readbacks were lost, so nothing was dispatched.
  expect(lost.status, JSON.stringify(lost.document)).toBeGreaterThanOrEqual(500);
  expect(probe.failedReads).toBe(2);
  const { before, after } = probe.loss!;
  expect(after).toEqual(expect.arrayContaining(before));
  expect(after).toHaveLength(before.length + 1);
  const pin = after.find((row) => !before.some(({ preparation_id }) => preparation_id === row.preparation_id))!;
  expect(workflows.created).toEqual([]);

  // A curated revision authored after the committed pin must not enter the replayed preparation.
  const proposal = {
    game: "one-piece",
    target: { kind: "field", entity_type: "card", entity_id: original.id, path: "/name" },
    assertion: { kind: "field", value: "Synthetic late curated name" },
    rationale: "Synthetic revision authored after the preparation pin",
    evidence: [{ kind: "owner_reference", uri: "https://owner.example/review/late", content_digest: "e".repeat(64) }],
    effective_interval: { from: null, to: null },
    reviewed_source_digest: await sha256Text(canonicalJson(original.name)),
    supersedes_revision_id: null,
  };
  const curated = await post("/v1/curated-revisions", {
    environment: "production",
    expected_current_revision_id: revision,
    proposal,
    proposal_digest: await sha256Text(canonicalJson(proposal)),
    idempotency_key: "curated-pin-late-revision",
  });
  expect(curated.response.status, JSON.stringify(curated.document)).toBe(201);
  const late = await curatedRevisionRowid(testEnv.CATALOGUE_DB)
    .bind(requiredString(curated.document, "curated_revision_id"))
    .first<{ rowid: number }>();
  expect(late!.rowid).toBeGreaterThan(Number(pin.revision_cutoff));

  const replay = await ownerRequest(env, "/v1/game-candidates", intent);
  expect(replay.status, JSON.stringify(replay.document)).toBe(202);
  expect(replay.document.id).toBe(pin.preparation_id);
  expect(await pins()).toEqual(after);
  expect(workflows.created).toHaveLength(1);
  const retries: Retry[] = [];
  await runReconciliationWorkflow(
    testEnv,
    { payload: workflows.created[0]!.params } as WorkflowEvent<ReconciliationWorkflowParams>,
    retryingStep(retries),
  );
  expect(retries).toEqual([]);
  const sealed = (await get(`/v1/game-candidates/${pin.preparation_id}`)).document;
  expect(sealed).toMatchObject({ state: "sealed", generation: 0, expected_game_revision_id: revision });
  const card = requiredFirst(await nativeCandidateRecords(String(pin.preparation_id), ["cards"]), "cards");
  expect(card).toMatchObject({ id: original.id, name: original.name });
  expect(card.curated_provenance ?? []).toEqual([]);
  expect(await pins()).toEqual(after);
});
