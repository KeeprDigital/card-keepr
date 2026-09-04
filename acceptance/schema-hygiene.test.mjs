import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import * as schemaQueries from "./helpers/query-helpers/schema.mjs";

const root = resolve(import.meta.dirname, "..");
// ADR 0006: the baseline seeds catalogue_schema_state at level 1 and every
// later migration opens with the level guard, so the walk starts at the
// first file and the guard proof covers every file after it.
const firstSchemaStateLevel = 1;
const firstGuardedLevel = 2;

test("Reconciliation Context stores only immutable per-run digests", async () => {
  const database = await migratedDatabase();
  database.exec(`INSERT INTO ingestion_runs
    (id, started_at, expected_current_revision_id, idempotency_key)
    VALUES ('run_context', '2026-09-04T00:00:00.000Z', 'catrev_spine_000', 'context_schema');`);
  assert.deepEqual(
    schemaQueries
      .reconciliationContextColumns(database)
      .all()
      .map(({ name }) => name),
    ["ingestion_run_id", "digest_payload_json"],
  );
  assert.equal(schemaQueries.reconciliationContextCount(database).get().count, 0);
  database.exec("INSERT INTO reconciliation_contexts VALUES ('run_context', '{\"partitions\":[]}')");
  assert.throws(
    () => database.exec("UPDATE reconciliation_contexts SET digest_payload_json = '{}'"),
    /reconciliation_context_immutable/u,
  );
  assert.throws(() => database.exec("DELETE FROM reconciliation_contexts"), /reconciliation_context_immutable/u);
  assert.throws(
    () => database.exec("INSERT INTO reconciliation_contexts VALUES ('missing_run', '{}')"),
    /FOREIGN KEY constraint failed/u,
  );
  assert.deepEqual(schemaQueries.foreignKeyViolations(database).all(), []);
  database.close();
});

test("the baseline retains immutability and excludes obsolete schema objects", async () => {
  const database = await migratedDatabase();
  schemaQueries.seedPreGuardMigrationLease(database).run();
  const lease = schemaQueries.canonicalReleaseLease(database).get();
  const objects = schemaQueries.schemaDefinitionRows(database).all();
  const triggers = objects.filter(({ type }) => type === "trigger");
  assert.equal(triggers.length, 105);
  assert.ok(triggers.every(({ sql }) => /BEFORE (UPDATE|DELETE)/u.test(sql)));
  for (const name of ["ingestion_run_transitions", "production_release_transitions", "revision_card_search_terms"])
    assert.ok(!objects.some((object) => object.name === name), name);
  const leaseColumns = schemaQueries
    .operationStateColumns(database)
    .all()
    .map(({ name }) => name);
  assert.ok(!leaseColumns.includes("active_release_id"));
  assert.ok(!leaseColumns.includes("active_release_expires_at"));
  assert.deepEqual(schemaQueries.canonicalReleaseLease(database).get(), lease);
  const repairColumns = schemaQueries
    .queryRevisionColumns(database)
    .all()
    .map(({ name }) => name);
  assert.ok(repairColumns.includes("repair_chunk_offset"));
  assert.ok(!repairColumns.includes("repair_term_offset"));
  assert.equal(schemaQueries.integrityCheck(database).get().integrity_check, "ok");
  assert.deepEqual(schemaQueries.foreignKeyViolations(database).all(), []);
  database.close();
});

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
    schemaQueries.setUnexpectedSchemaLevel(database).run();
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
test("the schema carries the hot-path indexes and not the dead ones", async () => {
  const database = await migratedDatabase();
  const indexes = schemaQueries
    .schemaIndexNames(database)
    .all()
    .map((row) => row.name);
  assert.ok(!indexes.includes("revision_products_region"));
  assert.ok(!indexes.includes("revision_errata_by_revision"));

  assert.deepEqual(plan(schemaQueries.explainCardPrintings(database)), [
    "SEARCH revision_printings USING INDEX revision_printings_by_card (catalogue_revision_id=? AND card_id=?)",
  ]);
  assert.deepEqual(plan(schemaQueries.explainRecentSnapshots(database)), [
    "SEARCH source_snapshots USING INDEX source_snapshots_by_run (ingestion_run_id=?)",
  ]);
  assert.deepEqual(plan(schemaQueries.explainSnapshotCount(database)), [
    "SEARCH source_snapshots USING COVERING INDEX source_snapshots_by_run (ingestion_run_id=?)",
  ]);
  assert.deepEqual(plan(schemaQueries.explainRecentFetchAttempts(database)), [
    "SEARCH source_fetch_attempts USING INDEX source_fetch_attempts_by_run (ingestion_run_id=?)",
  ]);
  assert.equal(
    plan(schemaQueries.explainPrintingLocators(database))[0],
    "SEARCH reconciled_printing_locators USING COVERING INDEX reconciled_printing_locators_by_printing (printing_id=?)",
  );
  assert.deepEqual(
    plan(schemaQueries.explainPrintingLocatorSets(database)).filter((step) =>
      step.includes("reconciled_printing_locators"),
    ),
    ["SEARCH reconciled_printing_locators USING INDEX reconciled_printing_locators_by_printing (printing_id=?)"],
  );
  assert.deepEqual(plan(schemaQueries.explainRevisionBackups(database)), [
    "SEARCH catalogue_backup_attempts USING COVERING INDEX catalogue_backup_attempts_by_revision (catalogue_revision_id=?)",
  ]);
  assert.deepEqual(
    plan(schemaQueries.explainVerifiedRevisionBackup(database))[0],
    "SEARCH catalogue_backup_attempts USING INDEX catalogue_backup_attempts_by_revision (catalogue_revision_id=?)",
  );
  assert.deepEqual(plan(schemaQueries.explainBackupRetryChild(database)), [
    "SEARCH catalogue_backup_attempts USING INDEX one_catalogue_backup_retry_per_failed_attempt (linked_attempt_id=?)",
  ]);
  assert.deepEqual(plan(schemaQueries.explainRecentIngestionRuns(database)), [
    "SCAN ingestion_runs USING INDEX ingestion_runs_recent",
  ]);
  assert.deepEqual(plan(schemaQueries.explainRecoverablePublications(database)), [
    "SEARCH ingestion_run_current USING INDEX ingestion_runs_by_state (state=? AND publication_reconcile_after>? AND publication_reconcile_after<?)",
  ]);
  assert.deepEqual(plan(schemaQueries.explainExpiredRuns(database)), [
    "SEARCH ingestion_run_current USING COVERING INDEX ingestion_runs_by_state (state=?)",
  ]);
  database.close();
});

test("dropping the dead indexes leaves their queries on an equivalent seek", async () => {
  const database = await migratedDatabase();
  assert.match(
    plan(schemaQueries.explainRevisionProducts(database))[0],
    /^SEARCH revision_products USING (?:COVERING )?INDEX \S+ \(catalogue_revision_id=\?\)$/u,
  );
  assert.deepEqual(plan(schemaQueries.explainRevisionErrata(database)), [
    "SEARCH revision_errata USING COVERING INDEX sqlite_autoindex_revision_errata_1 (catalogue_revision_id=?)",
  ]);
  database.close();
});

function plan(statement) {
  return statement.all().map((row) => row.detail);
}

function schemaLevel(database) {
  return schemaQueries.schemaMigrationLevel(database).get().migration_level;
}

function schemaObjects(database) {
  return schemaQueries.schemaObjectRows(database).all();
}

async function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const { sql } of await readMigrations()) database.exec(sql);
  return database;
}

async function readMigrations() {
  const directory = resolve(root, "migrations");
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      level: Number.parseInt(name, 10),
      sql: await readFile(resolve(directory, name), "utf8"),
    })),
  );
}
