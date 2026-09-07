import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("cleanup migration preserves existing preparation facts and starts unknown terminal age conservatively", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const names = (await readdir(new URL("../migrations/", import.meta.url)))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const name of names.filter((name) => Number.parseInt(name, 10) < 24))
      db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    for (const state of ["abandoned", "failed", "paused"]) {
      db.prepare(
        `INSERT INTO ingestion_runs(id,started_at,expected_current_revision_id,idempotency_key) VALUES (?,'2026-01-01T00:00:00.000Z','catrev_spine_000',?)`,
      ).run(state, state);
      db.prepare(
        `INSERT INTO reconciliation_operations(id,ingestion_run_id,state,created_at,deadline,definition_pins_json,observation_cutoff,identity_decision_cutoff,authority_decision_cutoff) VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z','2026-01-08T00:00:00.000Z','{}',0,0,0)`,
      ).run(state, state, state);
    }
    const before = db
      .prepare("SELECT id,ingestion_run_id,state,created_at,deadline FROM reconciliation_operations ORDER BY id")
      .all();
    const started = Date.now();
    db.exec("BEGIN");
    db.exec(await readFile(new URL("../migrations/0024_evidence_cleanup.sql", import.meta.url), "utf8"));
    db.exec("COMMIT");
    const ended = Date.now();
    assert.deepEqual(
      db
        .prepare("SELECT id,ingestion_run_id,state,created_at,deadline FROM reconciliation_operations ORDER BY id")
        .all(),
      before,
    );
    for (const row of db
      .prepare("SELECT terminal_at FROM reconciliation_operations WHERE state IN ('failed','abandoned')")
      .all()) {
      const terminal = Date.parse(row.terminal_at);
      assert.ok(terminal >= started && terminal <= ended, "Old deadlines must not invent terminal age");
      assert.ok(terminal + 30 * 86400000 > ended, "Legacy work cannot become immediately eligible");
    }
    assert.equal(
      db.prepare("SELECT terminal_at FROM reconciliation_operations WHERE id='paused'").get().terminal_at,
      null,
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});
