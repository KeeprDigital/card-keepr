import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

// Explicit schema/invariant seam: populated legacy evidence remains intact.
test("composed recovery migration preserves populated ancestors and fences a previously prepared writer", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const names = (await readdir(new URL("../migrations/", import.meta.url)))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const name of names.filter((name) => Number.parseInt(name, 10) < 23))
      db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    for (let i = 0; i < 3; i++) {
      db.prepare(
        "INSERT INTO ingestion_runs(id,started_at,expected_current_revision_id,idempotency_key) VALUES (?,?,?,?)",
      ).run(`run_${i}`, "2026-09-07T00:00:00.000Z", i ? `revision_${i - 1}` : "catrev_spine_000", `run_${i}`);
      db.prepare(
        "INSERT INTO catalogue_revisions(id,ingestion_run_id,published_at,content_digest,expected_previous_revision_id,approved_candidate_digest) VALUES (?,?,?,?,?,?)",
      ).run(
        `revision_${i}`,
        `run_${i}`,
        "2026-09-07T00:00:00.000Z",
        "a".repeat(64),
        i ? `revision_${i - 1}` : "catrev_spine_000",
        "b".repeat(64),
      );
      db.prepare("INSERT INTO catalogue_query_revisions(catalogue_revision_id,state) VALUES (?,'available')").run(
        `revision_${i}`,
      );
      db.prepare("INSERT INTO revision_cards VALUES (?,?,'{}')").run(`revision_${i}`, `card_${i}`);
    }
    db.exec("UPDATE catalogue_state SET current_revision_id='revision_2'");
    const before = db.prepare("SELECT * FROM catalogue_revisions ORDER BY id").all();
    const cards = db.prepare("SELECT * FROM revision_cards ORDER BY catalogue_revision_id,card_id").all();
    const writer = db.prepare(
      "INSERT INTO ingestion_runs(id,started_at,expected_current_revision_id,idempotency_key) VALUES ('late-writer','2026-09-07T00:00:00.000Z','revision_2','late-writer')",
    );
    db.exec("BEGIN");
    db.exec(
      await readFile(
        new URL(`../migrations/${names.find((name) => name.startsWith("0023_"))}`, import.meta.url),
        "utf8",
      ),
    );
    db.exec("COMMIT");
    assert.deepEqual(db.prepare("SELECT * FROM catalogue_revisions ORDER BY id").all(), before);
    assert.deepEqual(db.prepare("SELECT * FROM revision_cards ORDER BY catalogue_revision_id,card_id").all(), cards);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    db.exec("UPDATE operation_state SET recovery_restore_guard='blocked'");
    assert.throws(() => writer.run(), /catalogue_recovery_writer_fenced/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM ingestion_runs").get().n, 3);
    db.exec("UPDATE operation_state SET recovery_restore_guard='clear'");
    writer.run();
    assert.equal(db.prepare("SELECT count(*) AS n FROM ingestion_runs").get().n, 4);
  } finally {
    db.close();
  }
});
