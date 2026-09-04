import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import * as runQueries from "./helpers/query-helpers/run-event-schema.mjs";
import * as schemaQueries from "./helpers/query-helpers/schema.mjs";

async function migrationFixture(t) {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec(await readFile(new URL("../migrations/0001_baseline.sql", import.meta.url), "utf8"));
  return { database };
}

function seedIdentity(database) {
  database.exec(`INSERT INTO ingestion_runs
    (id, started_at, expected_current_revision_id, idempotency_key)
    VALUES ('run_schema', '2026-09-04T00:00:00.000Z', 'catrev_spine_000', 'run_schema_start');`);
}
function seedEventAndProjection(database) {
  database.exec(`INSERT INTO ingestion_run_events
    (ingestion_run_id, sequence_number, event_id, event_kind, occurred_at, from_state, to_state, payload_json)
    VALUES ('run_schema', 1, 'event_schema', 'created', '2026-09-04T00:00:00.000Z', NULL, 'planning', '{}');
    INSERT INTO ingestion_run_current
    (ingestion_run_id, last_event_sequence, last_event_id, state, completed_stage_count)
    VALUES ('run_schema', 1, 'event_schema', 'planning', 0);
    INSERT INTO ingestion_run_selected_games VALUES ('run_schema', 0, 'one-piece');
    INSERT INTO ingestion_run_curated_revision_sets VALUES
    ('run_schema', '[]', '${"a".repeat(64)}', '2026-09-04T00:00:00.000Z');`);
}

test("the baseline separates the immutable run anchor from typed current state", async (t) => {
  const { database } = await migrationFixture(t);
  assert.equal(schemaQueries.schemaMigrationLevel(database).get().migration_level, 1);
  assert.deepEqual(
    runQueries
      .runAnchorColumns(database)
      .all()
      .map(({ name }) => name),
    [
      "id",
      "started_at",
      "expected_current_revision_id",
      "linked_run_id",
      "idempotency_key",
      "approval_idempotency_key",
      "operational_request_id",
    ],
  );
  assert.ok(
    runQueries
      .runCurrentColumns(database)
      .all()
      .every(({ name }) => !name.endsWith("_json")),
  );
  assert.deepEqual(schemaQueries.foreignKeyViolations(database).all(), []);
  assert.equal(schemaQueries.integrityCheck(database).get().integrity_check, "ok");
});

test("run identities, events and payloads remain immutable while current state can be rebuilt without deleting pins", async (t) => {
  const { database } = await migrationFixture(t);
  seedIdentity(database);
  seedEventAndProjection(database);
  runQueries.insertPayloadChunk(database).run(0, "{}");
  const events = runQueries.runEventRows(database).all();
  const projection = runQueries.runProjectionRows(database).all();
  const pins = runQueries.retainedRunPins(database).all();
  const payloads = runQueries.eventPayloadRows(database).all();
  for (const mutation of [
    "UPDATE ingestion_run_events SET payload_json = '{\"changed\":true}'",
    "DELETE FROM ingestion_run_events",
  ])
    assert.throws(() => database.exec(mutation), /ingestion_run_event_immutable/u);
  for (const mutation of [
    "UPDATE ingestion_run_event_payload_chunks SET content = 'changed'",
    "DELETE FROM ingestion_run_event_payload_chunks",
  ])
    assert.throws(() => database.exec(mutation), /ingestion_run_event_payload_immutable/u);
  for (const mutation of [
    "UPDATE ingestion_runs SET idempotency_key = 'changed'",
    "UPDATE ingestion_runs SET started_at = 'changed'",
    "DELETE FROM ingestion_runs",
  ])
    assert.throws(() => database.exec(mutation), /ingestion_run_identity_immutable/u);
  database.exec("UPDATE ingestion_runs SET approval_idempotency_key = 'approval_schema' WHERE id = 'run_schema'");
  for (const value of ["NULL", "'replacement'"])
    assert.throws(
      () => database.exec(`UPDATE ingestion_runs SET approval_idempotency_key = ${value} WHERE id = 'run_schema'`),
      /ingestion_run_identity_immutable/u,
    );
  assert.equal(runQueries.approvalIdentity(database).get().approval_idempotency_key, "approval_schema");
  database.exec(`DELETE FROM ingestion_run_current;
    DELETE FROM ingestion_run_selected_games;
    INSERT INTO ingestion_run_current (ingestion_run_id, last_event_sequence, last_event_id, state, completed_stage_count)
    VALUES ('run_schema', 1, 'event_schema', 'planning', 0);
    INSERT INTO ingestion_run_selected_games VALUES ('run_schema', 0, 'one-piece');`);
  assert.deepEqual(runQueries.runProjectionRows(database).all(), projection);
  assert.deepEqual(runQueries.runEventRows(database).all(), events);
  assert.deepEqual(runQueries.retainedRunPins(database).all(), pins);
  assert.deepEqual(runQueries.eventPayloadRows(database).all(), payloads);
  assert.deepEqual(schemaQueries.foreignKeyViolations(database).all(), []);
});

test("event identities, references, closed kinds and UTF-8 chunk sizes are structurally bounded", async (t) => {
  const { database } = await migrationFixture(t);
  seedIdentity(database);
  seedEventAndProjection(database);
  assert.throws(
    () => database.exec(`INSERT INTO ingestion_run_events SELECT * FROM ingestion_run_events`),
    /UNIQUE constraint/u,
  );
  for (const [run, sequence, kind, state, payload] of [
    ["missing_run", 2, "failed", "failed", "{}"],
    ["run_schema", 0, "failed", "failed", "{}"],
    ["run_schema", 2, "arbitrary_patch", "failed", "{}"],
    ["run_schema", 2, "failed", "arbitrary_state", "{}"],
    ["run_schema", 2, "failed", "failed", "[]"],
  ])
    assert.throws(
      () =>
        database.exec(`INSERT INTO ingestion_run_events VALUES
    ('${run}', ${sequence}, 'invalid_event', '${kind}', '2026-09-04T00:00:00.000Z', 'planning', '${state}', '${payload}')`),
      /constraint failed/u,
    );
  runQueries.insertPayloadChunk(database).run(0, "é".repeat(262144));
  assert.throws(() => runQueries.insertPayloadChunk(database).run(1, "é".repeat(262145)), /CHECK constraint/u);
});

test("the read projection renders ordered games, payload chunks, progress and decisions without writable JSON columns", async (t) => {
  const { database } = await migrationFixture(t);
  seedIdentity(database);
  seedEventAndProjection(database);
  const empty = runQueries.renderedRun(database).get();
  assert.equal(empty.candidate_json, "{}");
  assert.equal(empty.warnings_json, "[]");
  assert.equal(empty.approval_json, null);
  assert.equal(empty.approval_history_json, "[]");
  database.exec(`INSERT INTO ingestion_run_selected_games VALUES ('run_schema', 1, 'gundam');
    INSERT INTO ingestion_run_events VALUES ('run_schema', 2, 'event_approval', 'approval_reserved',
      '2026-09-04T01:00:00.000Z', 'awaiting_approval', 'publishing',
      '{"decision":{"action":"approved","at":"first"}}');
    INSERT INTO ingestion_run_events VALUES ('run_schema', 3, 'event_publish', 'published',
      '2026-09-04T02:00:00.000Z', 'publishing', 'published', '{"decision":null}');
    INSERT INTO ingestion_run_event_payload_chunks VALUES ('run_schema', 1, 'candidate', 1, 'true}');
    INSERT INTO ingestion_run_event_payload_chunks VALUES ('run_schema', 1, 'candidate', 0, '{"candidate":');
    INSERT INTO ingestion_run_event_payload_chunks VALUES ('run_schema', 1, 'diagnostics', 0, '["warning"]');
    UPDATE ingestion_run_current SET state = 'published', completed_stage_count = 6,
      candidate_payload_event_sequence = 1, diagnostics_event_sequence = 1,
      approved_at = '2026-09-04T01:00:00.000Z', approved_candidate_digest = 'digest',
      approved_expected_revision_id = 'catrev_spine_000' WHERE ingestion_run_id = 'run_schema';`);
  const rendered = runQueries.renderedRun(database).get();
  assert.deepEqual(JSON.parse(rendered.selected_games_json), ["one-piece", "gundam"]);
  assert.deepEqual(JSON.parse(rendered.candidate_json), { candidate: true });
  assert.deepEqual(JSON.parse(rendered.warnings_json), ["warning"]);
  assert.deepEqual(JSON.parse(rendered.approval_json), {
    action: "approved",
    approved_at: "2026-09-04T01:00:00.000Z",
    candidate_digest: "digest",
    expected_current_revision_id: "catrev_spine_000",
  });
  assert.deepEqual(JSON.parse(rendered.approval_history_json), [{ action: "approved", at: "first" }]);
  assert.deepEqual(JSON.parse(rendered.progress_json), {
    completed_stages: ["planning", "collecting", "parsing", "reconciling", "awaiting_approval", "publishing"],
    current_stage: "published",
  });
  assert.throws(() => database.exec("UPDATE ingestion_run_read SET candidate_json = '{}'"), /cannot modify.*view/u);
});
