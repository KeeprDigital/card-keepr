import { DatabaseSync } from "node:sqlite";
export function compositionSnapshotPageFixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE reconciliation_checkpoints (
    preparation_id TEXT, phase TEXT, ordinal INTEGER, content TEXT CHECK(length(CAST(content AS BLOB))<=524288), sha256 TEXT);
    CREATE TABLE reconciliation_reducer_state (
    preparation_id TEXT, namespace TEXT, key_digest TEXT, observation_ordinal INTEGER, group_digest TEXT, content TEXT CHECK(length(CAST(content AS BLOB))<=524288), sha256 TEXT);`);
  const insert = db.prepare(
    "INSERT INTO reconciliation_checkpoints(rowid,preparation_id,phase,ordinal,content,sha256) VALUES (?,'preparation','curated_revisions',?,?,?)",
  );
  for (const rowid of [1, 3, 5, 8, 11])
    insert.run(rowid, rowid, JSON.stringify({ text: "x".repeat(300000) }), "a".repeat(64));
  return { db, query: ({ sql, params }) => db.prepare(sql).all(...params) };
}
