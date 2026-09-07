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
      db.prepare(
        "INSERT INTO ingestion_runs(id,started_at,expected_current_revision_id,idempotency_key) VALUES (?,?,?,?)",
      ).run(run, at, predecessor, run);
      db.prepare("INSERT INTO ingestion_run_selected_games VALUES (?,0,'one-piece')").run(run);
      db.prepare(
        "INSERT INTO catalogue_revisions(id,ingestion_run_id,published_at,content_digest,expected_previous_revision_id,approved_candidate_digest) VALUES (?,?,?,?,?,?)",
      ).run(revision, run, at, "a".repeat(64), predecessor, "b".repeat(64));
      db.prepare("INSERT INTO revision_printings VALUES (?,?,?,'{}')").run(revision, `printing_${i}`, `card_${i}`);
      db.prepare("INSERT INTO revision_products VALUES (?,?,'one-piece','TEST','Test','test','[]','{}')").run(
        revision,
        `product_${i}`,
      );
      db.prepare("INSERT INTO revision_printing_query VALUES (?,?,?,'one-piece','common')").run(
        revision,
        `printing_${i}`,
        `card_${i}`,
      );
      db.prepare("INSERT INTO revision_printing_product_query VALUES (?,?,?,?,'')").run(
        revision,
        `printing_${i}`,
        `card_${i}`,
        `product_${i}`,
      );
      db.prepare("INSERT INTO catalogue_query_revisions(catalogue_revision_id,state) VALUES (?,'available')").run(
        revision,
      );
      db.prepare(
        "INSERT INTO catalogue_exports(catalogue_revision_id,manifest_key,manifest_digest,verified) VALUES (?,?,?,1)",
      ).run(revision, `export_${i}`, "c".repeat(64));
      db.prepare(
        "INSERT INTO catalogue_backup_attempts(idempotency_key,request_json,owner_token,catalogue_revision_id,state,object_key,started_at) VALUES (?,'{}',?,?,'pending',?,?)",
      ).run(`backup_${i}`, `owner_${i}`, revision, `object_${i}`, at);
      db.prepare(
        "INSERT INTO reconciled_errata VALUES (?,'one-piece','card',?,NULL,'Correction','\"Corrected\"',?,?)",
      ).run(`erratum_${i}`, `card_${i}`, revision, revision);
      db.prepare("INSERT INTO revision_errata VALUES (?,?)").run(revision, `erratum_${i}`);
      db.prepare("INSERT INTO erratum_provenance VALUES (?,'one-piece-en',?,?,?)").run(
        `erratum_${i}`,
        `observation_${i}`,
        revision,
        revision,
      );
      db.prepare(
        "INSERT INTO curated_revisions VALUES (?,'one-piece',?,'field',NULL,NULL,'{}',?,?,'{}','owner',?,'active',1)",
      ).run(`curated_${i}`, `target_${i}`, "d".repeat(64), "e".repeat(64), at);
      db.prepare("INSERT INTO curated_revision_events VALUES (?,1,'authored','{}',?,'owner')").run(`curated_${i}`, at);
      db.prepare(
        "INSERT INTO reconciliation_operations(id,ingestion_run_id,state,created_at,deadline,definition_pins_json,observation_cutoff,identity_decision_cutoff,authority_decision_cutoff) VALUES (?,?,'preparing',?,?,'{}',0,0,0)",
      ).run(`preparation_${i}`, run, at, "2026-09-15T00:00:00.000Z");
      db.prepare("INSERT INTO reconciliation_checkpoints VALUES (?,'product_reduction:one-piece',0,'{}',?)").run(
        `preparation_${i}`,
        "f".repeat(64),
      );
    }
    db.prepare("INSERT INTO source_freshness VALUES ('one-piece','errata','','',?,'riftbound_migration_run_2')").run(
      at,
    );
    db.exec("UPDATE catalogue_state SET current_revision_id='riftbound_migration_revision_2'");
    const affected = [
      "reconciled_errata",
      "source_freshness",
      "curated_revisions",
      "reconciliation_checkpoints",
      "ingestion_run_selected_games",
    ];
    const inbound = () =>
      db
        .prepare(
          `SELECT m.name,f.id,f."table",f."from",f."to",f.on_delete FROM sqlite_schema m,pragma_foreign_key_list(m.name) f WHERE m.type='table' AND f."table" IN ('reconciled_errata','source_freshness','curated_revisions','reconciliation_checkpoints') ORDER BY m.name,f.id`,
        )
        .all();
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
    const before = tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    const guards = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all();
    db.exec("BEGIN");
    db.exec(await readFile(new URL("0026_riftbound_catalogue.sql", root), "utf8"));
    db.exec("COMMIT");
    assert.deepEqual(
      tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()),
      before,
    );
    assert.deepEqual(inbound(), beforeFks);
    assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all(), guards);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("SELECT migration_level FROM catalogue_schema_state").get().migration_level, 26);
    db.prepare(
      "INSERT INTO reconciliation_checkpoints VALUES ('preparation_0','product_reduction:riftbound',0,'{}',?)",
    ).run("f".repeat(64));
    db.prepare("UPDATE revision_printing_query SET supported_game='riftbound' WHERE printing_id='printing_0'").run();
  } finally {
    db.close();
  }
});
