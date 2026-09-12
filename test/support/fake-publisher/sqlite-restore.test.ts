import assert from "node:assert/strict";
import { test } from "node:test";
import { SqliteRestore } from "./sqlite-restore.ts";

test("restore verification reads imported SQL facts and executes reconstruction against an independent database", async () => {
  const restored = new SqliteRestore();
  const other = new SqliteRestore();
  try {
    await restored.upload(`
      CREATE TABLE facts(id TEXT PRIMARY KEY, value TEXT);
      INSERT INTO facts VALUES ('retained', 'official ''quoted'' value');
      CREATE INDEX facts_value ON facts(value);
    `);
    await restored.import();
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

test("missing or invalid uploaded SQL cannot produce a successful restore", async () => {
  const restored = new SqliteRestore();
  try {
    await assert.rejects(() => restored.import(), /No SQL bytes were uploaded/);
    restored.query("CREATE TABLE control(value TEXT)", []);
    restored.query("INSERT INTO control VALUES ('existing target fact')", []);
    await restored.upload("CREATE TABLE partial(id TEXT); INSERT INTO missing VALUES ('invalid');");
    await assert.rejects(() => restored.import(), /no such table: missing/);
    assert.deepEqual(restored.query("SELECT name FROM sqlite_schema WHERE name = 'partial'", []), []);
    assert.equal(restored.query("SELECT value FROM control", [])[0]?.value, "existing target fact");
  } finally {
    restored.close();
  }
});

test("restore consumes streamed SQL across UTF-8, quoted text and trigger boundaries", async () => {
  const restored = new SqliteRestore();
  const sql = new TextEncoder().encode(`
    CREATE TABLE facts(id INTEGER PRIMARY KEY, value TEXT);
    CREATE TABLE audit(value TEXT);
    CREATE TRIGGER inserted AFTER INSERT ON facts BEGIN
      INSERT INTO audit VALUES ('semi;colon');
      INSERT INTO audit VALUES (NEW.value);
    END;
    INSERT INTO facts VALUES (1, '雪\nquoted ''value'';');
  `);
  let offset = 0;
  try {
    await restored.upload(
      new ReadableStream({
        pull(controller) {
          if (offset === sql.length) controller.close();
          else {
            controller.enqueue(sql.slice(offset, offset + 1));
            offset++;
          }
        },
      }),
    );
    await restored.import();
    assert.equal(restored.query("SELECT value FROM facts", [])[0]?.value, "雪\nquoted 'value';");
    assert.deepEqual(
      restored.query("SELECT value FROM audit ORDER BY rowid", []).map(({ value }) => value),
      ["semi;colon", "雪\nquoted 'value';"],
    );
  } finally {
    restored.close();
  }
});

test("an interrupted upload cannot import an earlier or partial SQL file", async () => {
  const restored = new SqliteRestore();
  try {
    await restored.upload("CREATE TABLE previous_upload(id TEXT);");
    const failed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("CREATE TABLE partial_upload(id TEXT);"));
        controller.error(new Error("upload interrupted"));
      },
    });
    await assert.rejects(() => restored.upload(failed), /upload interrupted/);
    await assert.rejects(() => restored.import(), /No SQL bytes were uploaded/);
  } finally {
    restored.close();
  }
});
