import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("migration 0015 distrusts legacy verified backups without degrading a fresh catalogue", async () => {
  const migrations = await readMigrations();
  const upgrade = new DatabaseSync(":memory:");
  for (const migration of migrations.slice(0, 14)) upgrade.exec(migration);
  upgrade.prepare(
    `INSERT INTO catalogue_backup_attempts (
       idempotency_key, request_json, owner_token, catalogue_revision_id,
       state, object_key, d1_bookmark, started_at, completed_at
     ) VALUES (?, ?, ?, ?, 'verified', ?, ?, ?, ?)`,
  ).run(
    "legacy-verified-backup",
    '{"expected_current_revision_id":"catrev_spine_000"}',
    `backup:${"a".repeat(64)}`,
    "catrev_spine_000",
    "d1-backups/legacy/catalogue.sql",
    "legacy-bookmark",
    "2026-08-01T00:00:00.000Z",
    "2026-08-01T00:01:00.000Z",
  );
  const candidateDigest = "b".repeat(64);
  upgrade.prepare(
    `INSERT INTO ingestion_runs (
       id, state, selected_games_json, started_at,
       expected_current_revision_id, idempotency_key, candidate_digest,
       candidate_created_at, approval_deadline, candidate_json,
       candidate_catalogue_digest
     ) VALUES (?, 'awaiting_approval', '[]', ?, ?, ?, ?, ?, ?, '{}', ?)`,
  ).run(
    "run-legacy-backup-approval",
    "2026-08-01T01:00:00.000Z",
    "catrev_spine_000",
    "run-legacy-backup-approval",
    candidateDigest,
    "2026-08-01T01:01:00.000Z",
    "2099-01-01T00:00:00.000Z",
    candidateDigest,
  );
  upgrade.prepare(
    `UPDATE operation_state SET active_ingestion_run_id = ?
     WHERE singleton = 1`,
  ).run("run-legacy-backup-approval");
  upgrade.exec(migrations[14]);
  assert.equal(recoveryHealth(upgrade), "degraded");
  const approvalJson = JSON.stringify({
    approved_at: "2026-08-01T01:02:00.000Z",
    candidate_digest: candidateDigest,
    expected_current_revision_id: "catrev_spine_000",
  });
  assert.throws(() => upgrade.prepare(
    `UPDATE ingestion_runs SET state = 'publishing', approval_json = ?
     WHERE id = 'run-legacy-backup-approval'`,
  ).run(approvalJson), /approval_guard_failed/u);

  upgrade.prepare(
    `INSERT INTO catalogue_backup_attempts (
       idempotency_key, request_json, owner_token, catalogue_revision_id,
       state, object_key, d1_bookmark, started_at, manifest_key,
       content_sha256, manifest_sha256, export_bytes,
       schema_migration_level, disposable_database_id,
       restore_generation, restore_phase
     ) VALUES (?, ?, ?, ?, 'verifying', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1,
       'imported')`,
  ).run(
    "post-upgrade-verified-backup",
    '{"expected_current_revision_id":"catrev_spine_000"}',
    `backup:${"c".repeat(64)}`,
    "catrev_spine_000",
    "d1-backups/post-upgrade/catalogue.sql",
    "post-upgrade-bookmark",
    "2026-08-01T02:00:00.000Z",
    "d1-backups/post-upgrade/manifest.json",
    "d".repeat(64),
    "e".repeat(64),
    1024,
    15,
    "disposable-post-upgrade",
  );
  upgrade.prepare(
    `UPDATE catalogue_backup_attempts
     SET state = 'verified', restore_phase = 'verified', completed_at = ?
     WHERE idempotency_key = 'post-upgrade-verified-backup'`,
  ).run("2026-08-01T02:01:00.000Z");
  upgrade.prepare(
    `INSERT INTO catalogue_backup_retention (
       attempt_id, newest_success, retain_until, policy
     ) VALUES (?, 1, NULL, 'newest-indefinite-and-dated-90-days')`,
  ).run("post-upgrade-verified-backup");
  upgrade.prepare(
    "UPDATE operation_state SET recovery_health = 'healthy' WHERE singleton = 1",
  ).run();
  upgrade.prepare(
    `UPDATE ingestion_runs SET state = 'publishing', approval_json = ?
     WHERE id = 'run-legacy-backup-approval'`,
  ).run(approvalJson);
  assert.equal(
    upgrade.prepare(
      "SELECT state FROM ingestion_runs WHERE id = 'run-legacy-backup-approval'",
    ).get().state,
    "publishing",
  );
  upgrade.close();

  const fresh = new DatabaseSync(":memory:");
  for (const migration of migrations) fresh.exec(migration);
  assert.equal(recoveryHealth(fresh), "healthy");
  insertFailedAttempt(fresh, "failed-retry-source");
  insertPendingAttempt(fresh, "first-retry-child", "failed-retry-source");
  assert.throws(
    () => insertPendingAttempt(fresh, "second-retry-child", "failed-retry-source"),
    /UNIQUE constraint failed/u,
  );
  insertWorkflowRequest(fresh, "first-workflow-child", "failed-retry-source");
  assert.throws(
    () => insertWorkflowRequest(fresh, "second-workflow-child", "failed-retry-source"),
    /UNIQUE constraint failed/u,
  );
  fresh.close();
});

// Every other migration test starts from an empty database. 0028 rebuilds
// ingestion_runs by dropping it, and the curated-revision pin tables cascade
// on delete, so it lost their rows on any populated database: production
// aborted on the pin sets' immutability trigger at level 27. D1 applies a
// migration as one transaction, which is what lets 0028 defer the foreign
// keys of the other children, so each migration is applied inside one here.
test("migration 0028 rebuilds ingestion_runs on a populated database without losing curated pins", async () => {
  const migrations = await readMigrations();
  const names = await migrationNames();
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const [index, migration] of migrations.entries()) {
    if (names[index] >= "0028_") break;
    database.exec(migration);
  }
  database.prepare(
    `INSERT INTO ingestion_runs (
       id, state, selected_games_json, started_at, expected_current_revision_id,
       idempotency_key, candidate_json
     ) VALUES (?, 'planning', '["one-piece"]', ?, 'catrev_spine_000', ?, '{}')`,
  ).run("run-populated-upgrade", "2026-08-20T00:00:00.000Z", "run-populated-upgrade");
  database.prepare(
    `INSERT INTO ingestion_run_curated_revision_sets (
       ingestion_run_id, revision_ids_json, set_digest, pinned_at
     ) VALUES (?, '[]', ?, ?)`,
  ).run("run-populated-upgrade", "a".repeat(64), "2026-08-20T00:00:00.000Z");
  const pinsBefore = database.prepare(
    "SELECT * FROM ingestion_run_curated_revision_sets ORDER BY ingestion_run_id",
  ).all();
  const transitionsBefore = database.prepare(
    "SELECT count(*) AS count FROM ingestion_run_transitions",
  ).get().count;

  for (const [index, migration] of migrations.entries()) {
    if (names[index] < "0028_") continue;
    database.exec("BEGIN");
    try {
      database.exec(migration);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw new Error(`${names[index]} failed on a populated database: ${error.message}`);
    }
  }

  assert.equal(
    database.prepare("SELECT migration_level FROM catalogue_schema_state").get().migration_level,
    Number.parseInt(names.at(-1), 10),
  );
  assert.deepEqual(
    database.prepare("SELECT * FROM ingestion_run_curated_revision_sets ORDER BY ingestion_run_id").all(),
    pinsBefore,
  );
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM ingestion_runs").get().count,
    1,
  );
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM ingestion_run_transitions").get().count,
    transitionsBefore,
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.throws(
    () => database.prepare("DELETE FROM ingestion_run_curated_revision_sets").run(),
    /curated_revision_pin_set_immutable/u,
  );

  const fresh = new DatabaseSync(":memory:");
  for (const migration of migrations) fresh.exec(migration);
  const schema = (source) => source.prepare(
    `SELECT type, name, tbl_name, sql FROM sqlite_schema
     WHERE name LIKE '%curated%' OR name LIKE 'ingestion_run%'
     ORDER BY type, name`,
  ).all();
  assert.deepEqual(schema(database), schema(fresh));
  database.close();
  fresh.close();
});

function insertFailedAttempt(database, id) {
  database.prepare(
    `INSERT INTO catalogue_backup_attempts (
       idempotency_key, request_json, owner_token, catalogue_revision_id,
       state, object_key, started_at, failure_code, failure_detail, completed_at
     ) VALUES (?, '{}', ?, 'catrev_spine_000', 'failed', ?, ?,
       'backup_failed', 'synthetic failure', ?)`,
  ).run(
    id,
    `backup:${id}`,
    `d1-backups/catrev_spine_000/${id}/catalogue.sql`,
    "2026-08-05T06:00:00.000Z",
    "2026-08-05T06:01:00.000Z",
  );
}

function insertPendingAttempt(database, id, linkedAttemptId) {
  database.prepare(
    `INSERT INTO catalogue_backup_attempts (
       idempotency_key, request_json, owner_token, catalogue_revision_id,
       state, object_key, started_at, linked_attempt_id
     ) VALUES (?, '{}', ?, 'catrev_spine_000', 'pending', ?, ?, ?)`,
  ).run(
    id,
    `backup:${id}`,
    `d1-backups/catrev_spine_000/${id}/catalogue.sql`,
    "2026-08-05T06:02:00.000Z",
    linkedAttemptId,
  );
}

function insertWorkflowRequest(database, id, linkedAttemptId) {
  database.prepare(
    `INSERT INTO catalogue_backup_workflow_requests (
       idempotency_key, expected_current_revision_id, request_json,
       workflow_params_json, workflow_instance_id, observed_at,
       linked_attempt_id
     ) VALUES (?, 'catrev_spine_000', '{}', '{}', ?, ?, ?)`,
  ).run(id, `workflow:${id}`, "2026-08-05T06:02:00.000Z", linkedAttemptId);
}

async function migrationNames() {
  return (await readdir(resolve(root, "migrations")))
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

async function readMigrations() {
  const directory = resolve(root, "migrations");
  const names = await migrationNames();
  return Promise.all(names.map((name) =>
    readFile(resolve(directory, name), "utf8")
  ));
}

function recoveryHealth(database) {
  return database.prepare(
    "SELECT recovery_health FROM operation_state WHERE singleton = 1",
  ).get().recovery_health;
}
