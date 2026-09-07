import * as queries from "./helpers/query-helpers/riftbound-migration.mjs";
import * as schema from "./helpers/query-helpers/schema.mjs";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

// Synthetic populated migration integrity evidence, distinct from publisher
// captures and the native collection/publication/restore journey.
test("Riftbound CHECK widening preserves populated ancestors, decisions and inbound foreign keys", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON");
    const root = new URL("../migrations/", import.meta.url);
    for (const name of (await readdir(root)).filter((n) => n.endsWith(".sql") && Number.parseInt(n, 10) <= 23).sort())
      db.exec(await readFile(new URL(name, root), "utf8"));
    const at = "2026-09-08T00:00:00.000Z";
    for (let i = 0; i < 3; i++) {
      const run = `riftbound_migration_run_${i}`,
        revision = `riftbound_migration_revision_${i}`;
      const predecessor = i ? `riftbound_migration_revision_${i - 1}` : "catrev_spine_000";
      queries.seedRun(db).run(run, at, predecessor, run);
      queries.seedSelectedGame(db).run(run);
      queries.seedRevision(db).run(revision, run, at, "a".repeat(64), predecessor, "b".repeat(64));
      queries.seedPrinting(db).run(revision, `printing_${i}`, `card_${i}`);
      queries.seedProduct(db).run(revision, `product_${i}`);
      queries.seedPrintingQuery(db).run(revision, `printing_${i}`, `card_${i}`);
      queries.seedPrintingProductQuery(db).run(revision, `printing_${i}`, `card_${i}`, `product_${i}`);
      queries.seedQueryRevision(db).run(revision);
      queries.seedExport(db).run(revision, `export_${i}`, "c".repeat(64));
      queries.seedBackup(db).run(`backup_${i}`, `owner_${i}`, revision, `object_${i}`, at);
      queries.seedErratum(db).run(`erratum_${i}`, `card_${i}`, revision, revision);
      queries.seedRevisionErratum(db).run(revision, `erratum_${i}`);
      queries.seedErratumProvenance(db).run(`erratum_${i}`, `observation_${i}`, revision, revision);
      queries.seedCuratedRevision(db).run(`curated_${i}`, `target_${i}`, "d".repeat(64), "e".repeat(64), at);
      queries.seedCuratedEvent(db).run(`curated_${i}`, at);
      queries.seedReconciliation(db).run(`preparation_${i}`, run, at, "2026-09-15T00:00:00.000Z");
      queries.seedCheckpoint(db).run(`preparation_${i}`, "f".repeat(64));
    }
    queries.seedFreshness(db).run(at);
    db.exec("UPDATE catalogue_state SET current_revision_id='riftbound_migration_revision_2'");
    const affected = [
      "reconciled_errata",
      "source_freshness",
      "curated_revisions",
      "reconciliation_checkpoints",
      "ingestion_run_selected_games",
    ];
    const inbound = () => queries.inboundForeignKeys(db).all();
    const beforeFks = inbound();
    assert.ok(beforeFks.length >= 5);
    assert.ok(
      beforeFks.every((r) => r.on_delete === "NO ACTION"),
      "No dependent row may cascade during table rebuild",
    );
    const tables = [
      ...affected,
      "revision_errata",
      "erratum_provenance",
      "curated_revision_events",
      "catalogue_state",
      "catalogue_revisions",
      "catalogue_exports",
      "catalogue_query_revisions",
      "catalogue_backup_attempts",
      "revision_printing_query",
      "revision_printing_product_query",
      "revision_printings",
      "revision_products",
    ];
    const before = tables.map((table) => queries.tableRows(db, table).all());
    const guards = queries.triggers(db).all();
    db.exec("BEGIN");
    db.exec(await readFile(new URL("0026_riftbound_catalogue.sql", root), "utf8"));
    db.exec("COMMIT");
    assert.deepEqual(
      tables.map((table) => queries.tableRows(db, table).all()),
      before,
    );
    assert.deepEqual(inbound(), beforeFks);
    assert.deepEqual(queries.triggers(db).all(), guards);
    assert.deepEqual(schema.foreignKeyViolations(db).all(), []);
    assert.equal(schema.schemaMigrationLevel(db).get().migration_level, 26);
    queries.seedRiftboundCheckpoint(db).run("f".repeat(64));
    queries.setRiftboundPrintingGame(db).run();
  } finally {
    db.close();
  }
});
