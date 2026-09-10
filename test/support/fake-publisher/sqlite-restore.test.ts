import assert from "node:assert/strict";
import { test } from "node:test";
import { SqliteRestore } from "./sqlite-restore.ts";

test("restore verification reads imported SQL facts and executes reconstruction against an independent database", () => {
  const restored = new SqliteRestore();
  const other = new SqliteRestore();
  try {
    restored.upload(`
      CREATE TABLE facts(id TEXT PRIMARY KEY, value TEXT);
      INSERT INTO facts VALUES ('retained', 'official ''quoted'' value');
      CREATE INDEX facts_value ON facts(value);
    `);
    restored.import();
    assert.deepEqual(restored.query("SELECT value FROM facts WHERE id = ?", ["invented"]), []);
    assert.equal(
      restored.query("SELECT value FROM facts WHERE id = ?", ["retained"])[0]?.value,
      "official 'quoted' value",
    );
    restored.query("CREATE VIRTUAL TABLE search USING fts5(value)", []);
    restored.query("INSERT INTO search SELECT value FROM facts", []);
    assert.equal(
      restored.query("SELECT count(*) AS count FROM search WHERE search MATCH ?", ["official"])[0]?.count,
      1,
    );
    assert.throws(() => other.query("SELECT * FROM facts", []), /Disposable restore query failed/);
    restored.reset();
    assert.throws(() => restored.query("SELECT * FROM facts", []), /Disposable restore query failed/);
  } finally {
    restored.close();
    other.close();
  }
});

test("missing or invalid uploaded SQL cannot produce a successful restore", () => {
  const restored = new SqliteRestore();
  try {
    assert.throws(() => restored.import(), /No SQL bytes were uploaded/);
    restored.upload("CREATE TABLE partial(id TEXT); INSERT INTO missing VALUES ('invalid');");
    assert.throws(() => restored.import(), /no such table: missing/);
    assert.deepEqual(restored.query("SELECT name FROM sqlite_schema WHERE name = 'partial'", []), []);
  } finally {
    restored.close();
  }
});
