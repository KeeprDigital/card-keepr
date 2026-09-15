import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createServer } from "vite";
import { d1Adapter } from "./helpers/query-helpers/sqlite-d1-adapter.mjs";
import * as capacity from "./helpers/query-helpers/source-capacity-migration.mjs";
import * as recovery from "./helpers/query-helpers/parent-context-fences.mjs";
import * as schema from "./helpers/query-helpers/schema.mjs";
import * as queries from "./helpers/query-helpers/scryfall-registration-migration.mjs";

const root = new URL("../migrations/", import.meta.url);

test("the forward Scryfall migration retains its identity and selects the dated capacity", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  for (const name of (await readdir(root))
    .filter((name) => name.endsWith(".sql") && Number.parseInt(name, 10) <= 40)
    .sort()) {
    database.exec("BEGIN");
    database.exec(await readFile(new URL(name, root), "utf8"));
    database.exec("COMMIT");
  }
  assert.equal(schema.schemaMigrationLevel(database).get().migration_level, 40);
  assert.deepEqual(
    { ...queries.scryfallRegistration(database).get() },
    {
      adapter_version: "scryfall-magic-en@1",
      source_lineage: "scryfall-magic-en",
      supported_game: "magic",
      game_profile_version: "magic@1",
      parser_contract: "scryfall-magic-card-pilot@1",
      adapter_origin: "production",
      request_capacity: 108691,
    },
  );
});

test("the Scryfall capacity change protects resumable collections and retained history atomically", async (t) => {
  const predecessors = await Promise.all(
    (await readdir(root))
      .filter((name) => name.endsWith(".sql") && Number.parseInt(name, 10) < 40)
      .sort()
      .map((name) => readFile(new URL(name, root), "utf8")),
  );
  const migration = await readFile(new URL("0040_scryfall_bulk_registration.sql", root), "utf8");
  const vite = await createServer({ logLevel: "silent", server: { middlewareMode: true } });
  t.after(() => vite.close());
  const { seedRunFixtureStatement } = await vite.ssrLoadModule("/apps/ingestion/test/query-helpers/run-events.ts");
  const { validateEvidencePlan } = await vite.ssrLoadModule("/src/catalogue/source-evidence/source-evidence-model.ts");
  const { requiredSourceAdapter } = await vite.ssrLoadModule("/src/catalogue/adapters/index.ts");
  const at = "2026-09-15T00:00:00.000Z";
  const pilot = JSON.parse(
    await readFile(new URL("../docs/examples/scryfall-magic-pilot-plan.json", import.meta.url), "utf8"),
  );
  const { plan: magic } = await validateEvidencePlan({ ...pilot.plans[0], idempotency_key: "migration-magic-plan" });
  const { plan: other } = await validateEvidencePlan({
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "one-piece-en@6",
    idempotency_key: "migration-other-plan",
    requests: [{ id: "one-piece-en:discovery", url: requiredSourceAdapter("one-piece-en@6").requestUrlForDiscovery() }],
  });
  function fresh(context) {
    const database = new DatabaseSync(":memory:");
    context.after(() => database.close());
    database.exec("PRAGMA foreign_keys=ON");
    for (const sql of predecessors) {
      database.exec("BEGIN");
      database.exec(sql);
      database.exec("COMMIT");
    }
    return database;
  }
  async function seed(
    database,
    { state = "collecting", shape = "single", reservation = true, completed = false, missing = null } = {},
  ) {
    const id = "retained-scryfall";
    if (missing === "event") {
      capacity
        .insertIngestionRun(database)
        .run({ id, started_at: at, expected_current_revision_id: "catrev_spine_000", idempotency_key: id });
      queries.unrecordedCurrent(database).run({
        ingestion_run_id: id,
        last_event_sequence: 1,
        last_event_id: "missing-event",
        state: "failed",
        completed_stage_count: 0,
      });
    } else {
      await seedRunFixtureStatement(d1Adapter(database), {
        id,
        state,
        selected_games_json: shape === "composed" ? '["one-piece","magic"]' : '["magic"]',
        started_at: at,
        failure_code: state === "failed" ? "retained_failure" : null,
        terminal_at: ["published", "rejected", "expired", "failed"].includes(state) ? at : null,
      }).run();
    }
    const first = shape === "single" ? magic : other;
    const document =
      shape === "composed"
        ? { plans: [other, magic] }
        : shape === "json-root"
          ? magic
          : shape === "other"
            ? { ...other, note: magic.adapter_version }
            : magic;
    capacity.insertEvidencePlan(database).run({
      ingestion_run_id: id,
      source_lineage: first.source_lineage,
      supported_game: first.supported_game,
      game_profile_version: first.game_profile_version,
      adapter_version: first.adapter_version,
      request_plan_json: JSON.stringify(document),
    });
    if (completed) queries.completeCollection(database).run(at, id);
    if (!reservation) queries.removeReservation(database).run(id);
    if (missing === "current") queries.removeCurrent(database).run(id);
    if (missing === "agreement") queries.disagreeingCurrent(database).run("parsing", id);
    return id;
  }
  function refused(database, pattern = /malformed JSON/u) {
    const rows = schema.seedRows(database),
      definitions = schema.schemaObjectRows(database).all();
    const level = schema.schemaMigrationLevel(database).get().migration_level;
    database.exec("BEGIN");
    try {
      assert.throws(() => database.exec(migration), pattern);
    } finally {
      database.exec("ROLLBACK");
    }
    assert.equal(schema.schemaMigrationLevel(database).get().migration_level, level);
    assert.deepEqual(schema.seedRows(database), rows);
    assert.deepEqual(schema.schemaObjectRows(database).all(), definitions);
  }
  function migrated(database) {
    const before = schema.seedRows(database),
      definitions = schema.schemaObjectRows(database).all();
    database.exec("BEGIN");
    try {
      database.exec(migration);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    const after = schema.seedRows(database);
    assert.equal(schema.schemaMigrationLevel(database).get().migration_level, 40);
    assert.equal(queries.scryfallRegistration(database).get().request_capacity, 108691);
    const withoutMagic = (rows) => rows.filter((row) => JSON.parse(row).adapter_version !== magic.adapter_version);
    assert.deepEqual(withoutMagic(after.source_adapter_versions), withoutMagic(before.source_adapter_versions));
    delete before.source_adapter_versions;
    delete after.source_adapter_versions;
    assert.deepEqual(after, before);
    assert.deepEqual(schema.schemaObjectRows(database).all(), definitions);
    assert.deepEqual(schema.foreignKeyViolations(database).all(), []);
    assert.equal(schema.integrityCheck(database).get().integrity_check, "ok");
    assert.throws(
      () => capacity.mutateRetainedAdapter(database).run(108692, magic.adapter_version),
      /source_adapter_version_immutable/u,
    );
  }
  for (const shape of ["single", "composed"]) {
    for (const state of ["planning", "collecting", "paused"]) {
      for (const reservation of [true, false]) {
        await t.test(`${shape} ${state} is refused with reservation=${reservation}`, async (context) => {
          const database = fresh(context);
          await seed(database, { shape, state, reservation });
          refused(database);
        });
      }
    }
  }
  for (const missing of ["current", "event", "agreement"]) {
    await t.test(`missing or disagreeing ${missing} fails closed`, async (context) => {
      const database = fresh(context);
      await seed(database, { missing, reservation: false, completed: true });
      refused(database);
    });
  }
  await t.test("the exact JSON root is guarded even when stored first-plan columns differ", async (context) => {
    const database = fresh(context);
    await seed(database, { shape: "json-root", reservation: false });
    refused(database);
  });
  await t.test("an owner extension does not exempt a paused composed Scryfall run", async (context) => {
    const database = fresh(context);
    const id = await seed(database, { shape: "composed", state: "paused", reservation: false });
    capacity.insertCapacityExtension(database).run({
      ingestion_run_id: id,
      capacity_generation: 2,
      previous_request_capacity: 10,
      request_capacity: 20,
      source_lineage: magic.source_lineage,
      extended_at: at,
      idempotency_key: "active-extension",
      request_digest: "a".repeat(64),
      response_json: '{"request_capacity":20}',
    });
    refused(database);
  });
  await t.test("another active adapter is not mistaken for Scryfall by game or incidental text", async (context) => {
    const database = fresh(context);
    await seed(database, { shape: "other" });
    migrated(database);
  });
  for (const state of ["parsing", "reconciling", "awaiting_approval", "publishing"]) {
    await t.test(`${state} requires recorded collection completion`, async (context) => {
      const database = fresh(context);
      await seed(database, { state, reservation: false });
      refused(database);
      queries.completeCollection(database).run(at, "retained-scryfall");
      migrated(database);
    });
  }
  for (const state of ["published", "rejected", "expired", "failed"]) {
    await t.test(`${state} history remains safe with a retained reservation`, async (context) => {
      const database = fresh(context);
      const id = await seed(database, { state });
      capacity.insertCapacityExtension(database).run({
        ingestion_run_id: id,
        capacity_generation: 2,
        previous_request_capacity: 10,
        request_capacity: 20,
        source_lineage: magic.source_lineage,
        extended_at: at,
        idempotency_key: "retained-extension",
        request_digest: "a".repeat(64),
        response_json: '{"request_capacity":20,"retained":"owner intent"}',
      });
      queries.retainAuthorityDecision(database).run({
        idempotency_key: "retained-authority",
        game: "magic",
        locale: "en",
        release_region: "unknown",
        area: "card_facts",
        source_lineage: "scryfall-magic-en",
        generation: 2,
        rationale: "Retained owner designation",
        request_json: '{"retained":"owner rationale"}',
        decided_at: at,
      });
      migrated(database);
    });
  }
  for (const classification of ["retained_source", "abandoned_after_restore"]) {
    await t.test(`permanent recovery classification ${classification}`, async (context) => {
      const database = fresh(context);
      const id = await seed(database, { state: "paused", reservation: false });
      recovery.insertParentRecoveryBackup(database).run("old-backup", "old-owner", "old-backup-object");
      recovery
        .insertParentRecoveryOperation(database)
        .run("old-recovery", "old-recovery", "a".repeat(64), "old-backup");
      queries.retainClassification(database).run("old-recovery", id, "paused", classification);
      if (classification === "retained_source") refused(database);
      else {
        migrated(database);
        assert.throws(() => queries.disagreeingCurrent(database).run("parsing", id), /restored_collection_abandoned/u);
      }
    });
  }
  await t.test("retained Scryfall requests, snapshots and interpretations remain byte-identical", async (context) => {
    const database = fresh(context),
      id = await seed(database, { state: "failed", reservation: false });
    const source = {
      source_lineage: magic.source_lineage,
      supported_game: magic.supported_game,
      game_profile_version: magic.game_profile_version,
      adapter_version: magic.adapter_version,
    };
    const request = magic.requests[0];
    capacity.insertSourceRequest(database).run({
      ingestion_run_id: id,
      request_id: request.id,
      sequence_number: 0,
      method: "GET",
      url: request.url,
      request_headers_json: JSON.stringify(request.headers),
      representation_fingerprint: request.representation_fingerprint,
      state: "observed",
    });
    capacity.insertFetchAttempt(database).run({
      id: "retained-fetch",
      ingestion_run_id: id,
      request_id: request.id,
      attempt_number: 1,
      requested_at: at,
      completed_at: at,
      outcome: "success",
      http_status: 200,
      response_headers_json: "{}",
    });
    capacity.insertSourceSnapshot(database).run({
      id: "retained-snapshot",
      ingestion_run_id: id,
      request_id: request.id,
      fetch_attempt_id: "retained-fetch",
      request_method: "GET",
      request_url: request.url,
      request_headers_json: JSON.stringify(request.headers),
      representation_fingerprint: request.representation_fingerprint,
      response_vary_json: "[]",
      retrieved_at: at,
      http_status: 200,
      response_headers_json: "{}",
      media_type: "application/json",
      content_digest: "c".repeat(64),
      content_byte_length: 2,
      content_object_key: "source-snapshots/retained-snapshot",
      ...source,
    });
    capacity.insertParseOperation(database).run({
      id: "retained-parse",
      source_snapshot_id: "retained-snapshot",
      adapter_version: magic.adapter_version,
      intent: "collection",
      idempotency_key: "retained-interpretation",
      observation_set_id: "retained-set",
      content_object_key: "source-observations/retained-set",
      parsed_at: at,
      state: "finalized",
      content_digest: "d".repeat(64),
      content_byte_length: 2,
      observation_count: 1,
    });
    capacity.insertObservationSet(database).run({
      id: "retained-set",
      parse_operation_id: "retained-parse",
      source_snapshot_id: "retained-snapshot",
      ...source,
      parsed_at: at,
      content_digest: "d".repeat(64),
      content_byte_length: 2,
      content_object_key: "source-observations/retained-set",
      observation_count: 1,
    });
    migrated(database);
  });
  await t.test("recovery rejection after the trigger drop restores every row and definition", (context) => {
    const database = fresh(context);
    capacity.recoveryFence(database).run("blocked");
    refused(database, /catalogue_recovery_writer_fenced/u);
    capacity.recoveryFence(database).run("clear");
    assert.throws(
      () => capacity.mutateRetainedAdapter(database).run(11, magic.adapter_version),
      /source_adapter_version_immutable/u,
    );
  });
  await t.test("handoff rejection after the trigger drop restores every row and definition", (context) => {
    const database = fresh(context),
      release = "migration-handoff",
      digest = "b".repeat(64);
    const preparation = JSON.stringify({ release_id: release, dispatch_digest: digest });
    queries.prepareHandoff(database).run({
      idempotency_key: release,
      operation: "prepare_production_release",
      request_json: "{}",
      response_json: preparation,
      http_status: 200,
      outcome: "success",
      created_at: at,
    });
    queries.reserveHandoff(database).run(release, "2099-01-01T00:00:00.000Z");
    queries.claimHandoff(database).run({
      release_id: release,
      role: "source",
      dispatch_digest: digest,
      execution_id: "migration-execution",
      request_json: "{}",
      preparation_json: preparation,
      phase: 1,
      evidence_json: "[]",
      created_at: at,
    });
    refused(database, /fresh_baseline_mutation_fenced/u);
  });
  await t.test("stale schema and changed registration predecessors are refused atomically", (context) => {
    const database = fresh(context);
    schema.setUnexpectedSchemaLevel(database).run();
    refused(database);
    queries.stalePredecessor(database).run(39);
    migrated(database);
    refused(database);
    queries.stalePredecessor(database).run(39);
    refused(database);
  });
});
