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
  fresh.close();
});

async function readMigrations() {
  const directory = resolve(root, "migrations");
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  return Promise.all(names.map((name) =>
    readFile(resolve(directory, name), "utf8")
  ));
}

function recoveryHealth(database) {
  return database.prepare(
    "SELECT recovery_health FROM operation_state WHERE singleton = 1",
  ).get().recovery_health;
}
