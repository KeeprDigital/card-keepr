import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const observedAt = "2026-09-09T00:00:00.000Z";
const digest = "a".repeat(64);

// Explicit migration seam: these durable rows represent retained schema-30
// state, not an assertion that a synthetic backup performed an actual restore.
function publishedCandidate(db, key, predecessor, reservation = key) {
  db.prepare(
    "INSERT INTO ingestion_runs(id,started_at,expected_current_revision_id,idempotency_key) VALUES (?,?,?,?)",
  ).run(key, observedAt, predecessor, key);
  db.prepare(`INSERT INTO reconciliation_operations(id,ingestion_run_id,supported_game,expected_game_revision_id,
    state,created_at,deadline,definition_pins_json,observation_cutoff,identity_decision_cutoff,authority_decision_cutoff)
    VALUES (?,?,'one-piece',?,'sealed',?,?,'{}',0,0,0)`).run(key, key, predecessor, observedAt, observedAt);
  db.prepare(`INSERT INTO game_candidates(id,preparation_id,ingestion_run_id,supported_game,expected_game_revision_id,
    created_at,deadline,state,generation,manifest_digest) VALUES (?,?,?,'one-piece',?,?,?,'published',0,?)`).run(
    key,
    key,
    key,
    predecessor,
    observedAt,
    observedAt,
    digest,
  );
  db.prepare(`INSERT INTO game_publication_operations(id,candidate_id,manifest_digest,expected_game_revision_id,
    candidate_generation,deadline,approved_at,inspection_receipt,idempotency_key,request_json,approval_json,state,
    resulting_revision_id,backup_attempt_id,published_at) VALUES (?,?,?,?,0,?,?,?,?,'{}','{}','published',?,?,?)`).run(
    key,
    key,
    digest,
    predecessor,
    observedAt,
    observedAt,
    digest,
    key,
    key,
    reservation,
    observedAt,
  );
  db.prepare(`INSERT INTO catalogue_revisions(id,ingestion_run_id,published_at,content_digest,
    expected_previous_revision_id,approved_candidate_digest,publication_operation_id) VALUES (?,?,?,?,?,?,?)`).run(
    key,
    key,
    observedAt,
    digest,
    predecessor,
    digest,
    key,
  );
  db.prepare("INSERT INTO catalogue_composition_games VALUES (?,'one-piece',?,?,?)").run(key, key, key, digest);
  db.prepare("INSERT INTO catalogue_candidate_publications VALUES (?,?)").run(key, key);
}

function backup(db, key, state, operation, linked = null) {
  const verified = state === "verified";
  const failed = state === "failed";
  db.prepare(`INSERT INTO catalogue_backup_attempts(idempotency_key,request_json,owner_token,catalogue_revision_id,
    state,object_key,started_at,d1_bookmark,failure_code,failure_detail,completed_at,manifest_key,content_sha256,
    manifest_sha256,export_bytes,schema_migration_level,disposable_database_id,restore_generation,restore_phase,
    publication_operation_id,linked_attempt_id,publication_ingestion_run_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    key,
    JSON.stringify({ publication_operation_id: operation }),
    key,
    operation ?? "verified",
    state,
    `backups/${key}.sql`,
    observedAt,
    verified ? "retained-bookmark" : null,
    failed ? "retained-failure" : null,
    failed ? "retained diagnostic" : null,
    verified || failed ? observedAt : null,
    verified ? `backups/${key}.json` : null,
    verified ? digest : null,
    verified ? digest : null,
    verified ? 1234 : null,
    verified ? 30 : null,
    verified ? `restore-${key}` : null,
    verified ? 1 : 0,
    verified ? "verified" : null,
    operation,
    linked,
    operation,
  );
}

test("schema 31 preserves populated native backup evidence and classifies only exact publication reservations", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON");
    const names = (await readdir(new URL("../migrations/", import.meta.url)))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const name of names.filter((name) => Number.parseInt(name, 10) < 31)) {
      db.exec("BEGIN");
      db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      db.exec("COMMIT");
    }
    let predecessor = "catrev_spine_000";
    for (const state of ["verified", "failed", "pending"]) {
      publishedCandidate(db, state, predecessor);
      backup(db, state, state, state);
      predecessor = state;
    }
    publishedCandidate(db, "manual", predecessor, "missing-reservation");
    backup(db, "manual", "verified", "manual");
    // Matching only the reservation key or only the operation is insufficient.
    publishedCandidate(db, "other", "manual", "wrong-operation");
    publishedCandidate(db, "mismatched", "other", "another-reservation");
    backup(db, "wrong-operation", "failed", "mismatched");
    backup(db, "retry", "verified", "failed", "failed");
    backup(db, "legacy", "verified", null);
    db.exec(
      "UPDATE catalogue_state SET current_revision_id='pending'; UPDATE game_catalogue_heads SET revision_id='pending' WHERE supported_game='one-piece'",
    );
    const rows = () => db.prepare("SELECT * FROM catalogue_backup_attempts ORDER BY idempotency_key").all();
    const triggers = () =>
      db
        .prepare(
          "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='catalogue_backup_attempts' ORDER BY name",
        )
        .all();
    const before = rows();
    const beforeTriggers = triggers();
    const bindings = db.prepare("SELECT * FROM catalogue_candidate_publications ORDER BY candidate_id").all();
    assert.equal(db.prepare("SELECT migration_level FROM catalogue_schema_state").get().migration_level, 30);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);

    db.exec("BEGIN");
    db.exec(await readFile(new URL("../migrations/0031_native_no_change_acceptance.sql", import.meta.url), "utf8"));
    db.exec("COMMIT");

    assert.equal(db.prepare("SELECT migration_level FROM catalogue_schema_state").get().migration_level, 31);
    assert.deepEqual(
      rows().map(({ publication_reserved, ...row }) => row),
      before.map((row) => ({ ...row })),
    );
    assert.deepEqual(Object.fromEntries(rows().map((row) => [row.idempotency_key, row.publication_reserved])), {
      failed: 1,
      legacy: 0,
      manual: 0,
      pending: 1,
      retry: 0,
      verified: 1,
      "wrong-operation": 0,
    });
    assert.deepEqual(triggers(), beforeTriggers, "the complete backup trigger definitions remain unchanged");
    assert.deepEqual(
      db.prepare("SELECT * FROM catalogue_candidate_publications ORDER BY candidate_id").all(),
      bindings,
    );
    assert.equal(
      db.prepare("SELECT candidate_id FROM game_accepted_candidates WHERE supported_game='one-piece'").get()
        .candidate_id,
      "pending",
    );
    assert.equal(
      db.prepare("SELECT publication_operation_id FROM catalogue_acceptance_head").get().publication_operation_id,
      "pending",
    );
    assert.equal(
      db.prepare("SELECT predecessor_candidate_id FROM game_candidate_predecessors WHERE candidate_id='pending'").get()
        .predecessor_candidate_id,
      "failed",
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM game_candidate_semantic_receipts").all(),
      [],
      "old evidence has no invented semantic receipt",
    );
    for (const row of before.filter((row) => ["verified", "failed"].includes(row.state))) {
      assert.throws(
        () =>
          db
            .prepare("UPDATE catalogue_backup_attempts SET object_key='tampered' WHERE idempotency_key=?")
            .run(row.idempotency_key),
        /terminal backup attempt is immutable/u,
      );
      assert.throws(
        () =>
          db
            .prepare("UPDATE catalogue_backup_attempts SET publication_reserved=0 WHERE idempotency_key=?")
            .run(row.idempotency_key),
        /terminal backup attempt is immutable/u,
      );
    }
    assert.throws(() =>
      db.exec("UPDATE catalogue_backup_attempts SET state='verified' WHERE idempotency_key='pending'"),
    );
    assert.deepEqual(
      rows().map(({ publication_reserved, ...row }) => row),
      before.map((row) => ({ ...row })),
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});
