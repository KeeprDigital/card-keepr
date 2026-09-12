import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  exportSqliteFile,
  localCatalogueDatabase,
  sqliteExportResponse,
} from "../test/support/fake-publisher/sqlite-transfer.ts";
import { SqliteRestore } from "../test/support/fake-publisher/sqlite-restore.ts";
import "../test/support/fake-publisher/sqlite-restore.test.ts";

test("a file-backed snapshot restores the original catalogue, schema and bytes after live data changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "keepr-backup-'quoted-"));
  const path = join(directory, "source.sqlite");
  const source = new DatabaseSync(path);
  const restored = new SqliteRestore();
  try {
    source.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE catalogue_state(id INTEGER PRIMARY KEY);
      CREATE TABLE _cf_METADATA(key INTEGER PRIMARY KEY, value BLOB);
      CREATE TABLE facts(id INTEGER PRIMARY KEY, value TEXT, bytes BLOB);
      CREATE TABLE child(id INTEGER PRIMARY KEY, fact_id INTEGER REFERENCES facts(id));
      CREATE INDEX facts_value ON facts(value);
      CREATE TABLE audit(value TEXT);
      CREATE TRIGGER record_insert AFTER INSERT ON facts BEGIN
        INSERT INTO audit VALUES ('semi;colon'); INSERT INTO audit VALUES (NEW.value);
      END;
      INSERT INTO facts VALUES(1, '雪\nquoted ''value'';', X'00017FFF');
      INSERT INTO child VALUES(1,1);
      CREATE VIRTUAL TABLE search USING fts5(value);
      INSERT INTO search VALUES('retained searchable text');
    `);
    assert.equal(await localCatalogueDatabase(directory), path);
    const file = await exportSqliteFile(path, directory);
    source.exec("UPDATE facts SET value='later live change';");
    await restored.upload(sqliteExportResponse(file).body);
    await restored.import();
    assert.equal(restored.query("SELECT value FROM facts WHERE id=1", [])[0].value, "雪\nquoted 'value';");
    assert.equal(restored.query("SELECT hex(bytes) AS hex FROM facts", [])[0].hex, "00017FFF");
    assert.deepEqual(restored.query("PRAGMA foreign_key_check", []), []);
    assert.equal(restored.query("SELECT count(*) AS n FROM search WHERE search MATCH 'searchable'", [])[0].n, 1);
    restored.query("INSERT INTO facts VALUES(2, 'after restore', NULL)", []);
    assert.equal(restored.query("SELECT count(*) AS n FROM audit", [])[0].n, 4);
    assert.equal(restored.query("SELECT count(*) AS n FROM sqlite_schema WHERE name='facts_value'", [])[0].n, 1);
    assert.equal(restored.query("SELECT count(*) AS n FROM sqlite_schema WHERE name='_cf_METADATA'", [])[0].n, 0);
    // The owning runtime must be unambiguous even if another catalogue is present.
    const other = new DatabaseSync(join(directory, "other.sqlite"));
    other.exec("CREATE TABLE catalogue_state(id INTEGER PRIMARY KEY)");
    other.close();
    await assert.rejects(() => localCatalogueDatabase(directory), /found 2/);
  } finally {
    source.close();
    restored.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
