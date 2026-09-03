import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
// ADR 0006: the baseline seeds catalogue_schema_state at level 1 and every
// later migration opens with the level guard, so the walk starts at the
// first file and the guard proof covers every file after it.
const firstSchemaStateLevel = 1;
const firstGuardedLevel = 2;

test("every migration leaves catalogue_schema_state at its own level", async () => {
  const migrations = await readMigrations();
  const database = new DatabaseSync(":memory:");
  for (const { level, sql } of migrations) {
    database.exec(sql);
    if (level < firstSchemaStateLevel) continue;
    assert.equal(
      schemaLevel(database),
      level,
      `migration ${String(level).padStart(4, "0")} must leave the schema level at ${level}`,
    );
  }
  database.close();
});

test("a guarded migration aborts before changing anything when the recorded level mismatches", async (t) => {
  const migrations = await readMigrations();
  const guarded = migrations.filter(({ level }) => level >= firstGuardedLevel);
  if (guarded.length === 0) {
    t.skip("no migration after the baseline yet; every later file is guarded");
    return;
  }
  for (const migration of guarded) {
    const database = new DatabaseSync(":memory:");
    for (const earlier of migrations) {
      if (earlier.level >= migration.level) break;
      database.exec(earlier.sql);
    }
    const expectedObjects = schemaObjects(database);
    database.prepare(
      "UPDATE catalogue_schema_state SET migration_level = 99 WHERE singleton = 1",
    ).run();
    assert.throws(
      () => database.exec(migration.sql),
      /malformed JSON/u,
      `migration ${migration.name} must abort on a schema level mismatch`,
    );
    assert.deepEqual(schemaObjects(database), expectedObjects);
    assert.equal(schemaLevel(database), 99);
    database.close();
  }
});

// Migration 0002 rebuilds the two tables whose CHECK enumerates the Workflow
// Pause reasons. Production already holds retained pause and termination
// rows, so the rebuild is proven on a populated database: every row
// survives, the immutability and paused-run guards are back, and the new
// owner_requested reason is accepted where the old vocabulary was.
test("migration 0002 retains pause and termination rows and re-guards both tables", async () => {
  const migrations = await readMigrations();
  const baseline = migrations.find(({ level }) => level === 1);
  const rebuild = migrations.find(({ level }) => level === 2);
  assert.ok(baseline && rebuild);
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(baseline.sql);
  const terminateRun = (id, reason) => {
    database.exec(
      `INSERT INTO ingestion_runs (
         id, state, selected_games_json, started_at,
         expected_current_revision_id, idempotency_key, candidate_json
       ) VALUES ('${id}', 'planning', '["one-piece"]', '2026-09-03T00:00:00.000Z',
                 'catrev_spine_000', 'key_${id}', '{}')`,
    );
    database.exec(
      `UPDATE operation_state SET active_ingestion_run_id = '${id}' WHERE singleton = 1`,
    );
    database.exec(`UPDATE ingestion_runs SET state = 'collecting' WHERE id = '${id}'`);
    database.exec(`UPDATE ingestion_runs SET state = 'paused' WHERE id = '${id}'`);
    database.exec(
      `INSERT INTO ingestion_run_workflow_pauses VALUES
         ('${id}', 'evidence-${id}', '${reason}', 'terminated',
          '2026-09-03T01:00:00.000Z', NULL)`,
    );
    database.exec(
      `INSERT INTO ingestion_run_terminations VALUES
         ('${id}', '${reason}', '2026-09-03T01:00:00.000Z',
          '2026-09-03T02:00:00.000Z', 'terminate_${id}', '${"a".repeat(64)}', '{}')`,
    );
    database.exec(
      `UPDATE ingestion_runs SET state = 'failed', failure_code = 'ingestion_run_terminated'
       WHERE id = '${id}'`,
    );
    database.exec(
      "UPDATE operation_state SET active_ingestion_run_id = NULL WHERE singleton = 1",
    );
  };
  terminateRun("run_retained", "source_workflow_terminated");
  const rows = (table) =>
    database.prepare(`SELECT * FROM ${table} ORDER BY ingestion_run_id`).all();
  const before = {
    pauses: rows("ingestion_run_workflow_pauses"),
    terminations: rows("ingestion_run_terminations"),
  };

  database.exec(rebuild.sql);

  assert.equal(schemaLevel(database), 2);
  assert.deepEqual(
    { pauses: rows("ingestion_run_workflow_pauses"), terminations: rows("ingestion_run_terminations") },
    before,
  );
  assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.throws(
    () => database.exec(
      `INSERT INTO ingestion_run_workflow_pauses VALUES
         ('run_retained', 'late', 'owner_requested', 'running', '2026-09-03T03:00:00.000Z', NULL)`,
    ),
    /workflow_pause_requires_paused_run/u,
  );
  assert.throws(
    () => database.exec("UPDATE ingestion_run_workflow_pauses SET workflow_status = 'errored'"),
    /workflow_pause_immutable/u,
  );
  assert.throws(
    () => database.exec("DELETE FROM ingestion_run_terminations"),
    /termination_immutable/u,
  );
  assert.throws(
    () => database.exec("UPDATE ingestion_run_terminations SET terminated_at = '2026-09-04T00:00:00.000Z'"),
    /termination_immutable/u,
  );
  // The widened vocabulary is accepted end to end: an owner-requested pause
  // can be recorded and terminated on the migrated schema.
  terminateRun("run_owner", "owner_requested");
  assert.equal(
    database.prepare("SELECT state FROM ingestion_runs WHERE id = 'run_owner'").get().state,
    "failed",
  );
  database.close();
});

test("the schema carries the hot-path indexes and not the dead ones", async () => {
  const database = await migratedDatabase();
  const indexes = database.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'index' ORDER BY name",
  ).all().map((row) => row.name);
  assert.ok(!indexes.includes("revision_products_region"));
  assert.ok(!indexes.includes("revision_errata_by_revision"));

  assert.deepEqual(
    plan(
      database,
      `SELECT document_json FROM revision_printings
       WHERE catalogue_revision_id = ? AND card_id = ?
       ORDER BY printing_id`,
    ),
    ["SEARCH revision_printings USING INDEX revision_printings_by_card (catalogue_revision_id=? AND card_id=?)"],
  );
  assert.deepEqual(
    plan(
      database,
      `SELECT * FROM source_snapshots WHERE ingestion_run_id = ?
       ORDER BY retrieved_at DESC, id DESC LIMIT ?`,
    ),
    ["SEARCH source_snapshots USING INDEX source_snapshots_by_run (ingestion_run_id=?)"],
  );
  assert.deepEqual(
    plan(
      database,
      "SELECT COUNT(*) FROM source_snapshots WHERE ingestion_run_id = ?",
    ),
    ["SEARCH source_snapshots USING COVERING INDEX source_snapshots_by_run (ingestion_run_id=?)"],
  );
  assert.deepEqual(
    plan(
      database,
      `SELECT * FROM source_fetch_attempts WHERE ingestion_run_id = ?
       ORDER BY completed_at DESC, request_id DESC, attempt_number DESC LIMIT ?`,
    ),
    ["SEARCH source_fetch_attempts USING INDEX source_fetch_attempts_by_run (ingestion_run_id=?)"],
  );
  assert.equal(
    plan(
      database,
      `SELECT printing_id, source_lineage, locator FROM reconciled_printing_locators
       WHERE printing_id = ? ORDER BY locator`,
    )[0],
    "SEARCH reconciled_printing_locators USING COVERING INDEX reconciled_printing_locators_by_printing (printing_id=?)",
  );
  assert.deepEqual(
    plan(
      database,
      `SELECT printing_id, source_lineage, locator, variant_key
       FROM reconciled_printing_locators
       WHERE printing_id IN (SELECT value FROM json_each(?))
       ORDER BY printing_id, source_lineage, locator, COALESCE(variant_key, '')`,
    ).filter((step) => step.includes("reconciled_printing_locators")),
    ["SEARCH reconciled_printing_locators USING INDEX reconciled_printing_locators_by_printing (printing_id=?)"],
  );
  assert.deepEqual(
    plan(
      database,
      `SELECT idempotency_key FROM catalogue_backup_attempts
       WHERE catalogue_revision_id = ?
       ORDER BY started_at DESC, idempotency_key DESC`,
    ),
    ["SEARCH catalogue_backup_attempts USING COVERING INDEX catalogue_backup_attempts_by_revision (catalogue_revision_id=?)"],
  );
  assert.deepEqual(
    plan(
      database,
      `SELECT idempotency_key FROM catalogue_backup_attempts
       WHERE state = 'verified' AND catalogue_revision_id = ?
         AND d1_bookmark IS NOT NULL AND manifest_sha256 IS NOT NULL
       ORDER BY completed_at DESC LIMIT 1`,
    )[0],
    "SEARCH catalogue_backup_attempts USING INDEX catalogue_backup_attempts_by_revision (catalogue_revision_id=?)",
  );
  assert.deepEqual(
    plan(
      database,
      "SELECT idempotency_key FROM catalogue_backup_attempts WHERE linked_attempt_id = ? LIMIT 1",
    ),
    ["SEARCH catalogue_backup_attempts USING INDEX one_catalogue_backup_retry_per_failed_attempt (linked_attempt_id=?)"],
  );
  assert.deepEqual(
    plan(
      database,
      "SELECT * FROM ingestion_runs ORDER BY started_at DESC, id DESC LIMIT 20",
    ),
    ["SCAN ingestion_runs USING INDEX ingestion_runs_recent"],
  );
  assert.deepEqual(
    plan(
      database,
      `SELECT * FROM ingestion_runs
       WHERE state = 'publishing'
         AND publication_reconcile_after IS NOT NULL
         AND publication_reconcile_after <= ?
       ORDER BY publication_reconcile_after, id LIMIT 1`,
    ),
    ["SEARCH ingestion_runs USING INDEX ingestion_runs_by_state (state=? AND publication_reconcile_after>? AND publication_reconcile_after<?)"],
  );
  assert.deepEqual(
    plan(database, "SELECT id FROM ingestion_runs WHERE state = 'expired'"),
    ["SEARCH ingestion_runs USING COVERING INDEX ingestion_runs_by_state (state=?)"],
  );
  database.close();
});

test("dropping the dead indexes leaves their queries on an equivalent seek", async () => {
  const database = await migratedDatabase();
  assert.match(
    plan(
      database,
      "SELECT product_id FROM revision_products WHERE catalogue_revision_id = ? ORDER BY product_id",
    )[0],
    /^SEARCH revision_products USING (?:COVERING )?INDEX \S+ \(catalogue_revision_id=\?\)$/u,
  );
  assert.deepEqual(
    plan(
      database,
      "SELECT erratum_id FROM revision_errata WHERE catalogue_revision_id = ?",
    ),
    ["SEARCH revision_errata USING COVERING INDEX sqlite_autoindex_revision_errata_1 (catalogue_revision_id=?)"],
  );
  database.close();
});

function plan(database, sql) {
  return database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((row) => row.detail);
}

function schemaLevel(database) {
  return database.prepare(
    "SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1",
  ).get().migration_level;
}

function schemaObjects(database) {
  return database.prepare(
    "SELECT type, name, sql FROM sqlite_schema ORDER BY type, name",
  ).all();
}

async function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const { sql } of await readMigrations()) database.exec(sql);
  return database;
}

async function readMigrations() {
  const directory = resolve(root, "migrations");
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  return Promise.all(names.map(async (name) => ({
    name,
    level: Number.parseInt(name, 10),
    sql: await readFile(resolve(directory, name), "utf8"),
  })));
}
