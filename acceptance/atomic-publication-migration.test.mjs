import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

// Schema migration is an explicitly requested integrity boundary. Synthetic
// legacy rows prove preservation; they do not claim real-source publication.
test("atomic publication migration preserves populated legacy ancestry and all inbound references", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const names = (await readdir(new URL("../migrations/", import.meta.url))).filter((n) => n.endsWith(".sql")).sort();
    for (const name of names.filter((n) => Number.parseInt(n, 10) < 22))
      db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    for (let i = 0; i < 3; i++) {
      db.prepare(
        "INSERT INTO ingestion_runs(id,started_at,expected_current_revision_id,idempotency_key) VALUES (?,?,?,?)",
      ).run(`run_${i}`, "2026-09-07T00:00:00.000Z", i ? `revision_${i - 1}` : "catrev_spine_000", `run_${i}`);
      db.prepare("INSERT INTO catalogue_revisions VALUES (?,?,?,?,?,?)").run(
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
      db.prepare(
        "INSERT INTO catalogue_exports(catalogue_revision_id,manifest_key,manifest_digest,verified) VALUES (?,?,?,1)",
      ).run(`revision_${i}`, `export_${i}`, "c".repeat(64));
      db.prepare("INSERT INTO revision_cards VALUES (?,?,'{}')").run(`revision_${i}`, `card_${i}`);
      db.prepare(
        "INSERT INTO catalogue_backup_attempts(idempotency_key,request_json,owner_token,catalogue_revision_id,state,object_key,started_at) VALUES (?,'{}',?,?,'pending',?,?)",
      ).run(`backup_${i}`, `owner_${i}`, `revision_${i}`, `object_${i}`, "2026-09-07T00:00:00.000Z");
    }
    db.exec("UPDATE catalogue_state SET current_revision_id='revision_2'");
    const inbound = () =>
      db
        .prepare(
          `SELECT m.name,f.id,f."table",f."from",f."to",f.on_delete FROM sqlite_schema m,pragma_foreign_key_list(m.name) f WHERE m.type='table' AND f."table"='catalogue_revisions' ORDER BY m.name,f.id`,
        )
        .all();
    const before = inbound();
    assert.ok(before.length > 15);
    assert.ok(
      before.every((f) => f.on_delete === "NO ACTION"),
      "DROP must not cascade into revision evidence",
    );
    const tables = ["catalogue_state", "catalogue_exports", "catalogue_query_revisions", "revision_cards"];
    const rows = tables.map((name) => db.prepare(`SELECT * FROM ${name}`).all());
    const revisions = db.prepare("SELECT * FROM catalogue_revisions ORDER BY id").all();
    const backups = db.prepare("SELECT * FROM catalogue_backup_attempts ORDER BY idempotency_key").all();
    db.exec("BEGIN");
    db.exec(
      await readFile(new URL(`../migrations/${names.find((n) => n.startsWith("0022_"))}`, import.meta.url), "utf8"),
    );
    db.exec("COMMIT");
    assert.deepEqual(
      tables.map((name) => db.prepare(`SELECT * FROM ${name}`).all()),
      rows,
    );
    assert.deepEqual(
      db
        .prepare("SELECT * FROM catalogue_revisions ORDER BY id")
        .all()
        .map(({ publication_operation_id, ...r }) => {
          assert.equal(publication_operation_id, null);
          return r;
        }),
      revisions.map((r) => ({ ...r })),
    );
    assert.deepEqual(
      db
        .prepare("SELECT * FROM catalogue_backup_attempts ORDER BY idempotency_key")
        .all()
        .map(({ publication_operation_id, ...r }) => {
          assert.equal(publication_operation_id, null);
          return r;
        }),
      backups.map((r) => ({ ...r })),
    );
    for (const fk of before) assert.ok(inbound().some((n) => JSON.stringify(n) === JSON.stringify(fk)));
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});
