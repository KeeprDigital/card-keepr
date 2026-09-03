import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import {
  prepareCardSearchForD1ExportStatements,
  reconstructCardSearchAfterD1RestoreStatements,
} from "../../src/catalogue/card-search-recovery-statements.ts";

const root = resolve(import.meta.dirname, "../..");

test("D1 backup export restores the reconstructible Card FTS index", async () => {
  const directory = await mkdtemp(join(tmpdir(), "card-keepr-fts-restore-"));
  const source = new DatabaseSync(join(directory, "source.sqlite"));
  let restored;
  try {
    await applyMigrations(source);
    source.exec("PRAGMA foreign_keys = OFF");
    source.prepare(
      `INSERT INTO revision_card_search_chunks (
         catalogue_revision_id, card_id, field_ordinal,
         chunk_ordinal, search_text
       ) VALUES (?, ?, 1, 0, ?)`,
    ).run("catrev_backup_restore", "card_backup_restore", "backup quartz");
    assert.equal(matchedRevision(source), "catrev_backup_restore");

    const migratedDefinition = cardSearchSchema(source);

    source.prepare(
      `UPDATE card_search_fts_state
       SET state = 'reconstructing', owner_token = ?, lease_expires_at = ?
       WHERE singleton = 1 AND state = 'ready'`,
    ).run(
      "backup:acceptance-owner",
      "2099-01-01T00:00:00.000Z",
    );
    executeAtomically(source, prepareCardSearchForD1ExportStatements);
    assert.equal(
      source.prepare(
        `SELECT count(*) AS count
         FROM sqlite_schema
         WHERE type = 'table'
           AND name LIKE 'revision_card%'
           AND lower(sql) LIKE '%create virtual table%'`,
      ).get().count,
      0,
    );
    assert.equal(
      source.prepare(
        `SELECT count(*) AS count FROM revision_card_search_chunks
         WHERE catalogue_revision_id = 'catrev_backup_restore'`,
      ).get().count,
      1,
    );

    source.prepare("VACUUM INTO ?").run(join(directory, "restored.sqlite"));
    restored = new DatabaseSync(join(directory, "restored.sqlite"));
    executeAtomically(
      restored,
      reconstructCardSearchAfterD1RestoreStatements,
    );
    restored.prepare(
      `UPDATE card_search_fts_state
       SET state = 'ready', owner_token = NULL, lease_expires_at = NULL
       WHERE singleton = 1 AND owner_token = ?`,
    ).run("backup:acceptance-owner");

    assert.equal(
      restored.prepare(
        "SELECT state FROM card_search_fts_state WHERE singleton = 1",
      ).get().state,
      "ready",
    );
    assert.equal(matchedRevision(restored), "catrev_backup_restore");
    assert.deepEqual(cardSearchSchema(restored), migratedDefinition);
    restored.prepare(
      `UPDATE revision_card_search_chunks
       SET search_text = 'restored trigger quartz'
       WHERE catalogue_revision_id = 'catrev_backup_restore'`,
    ).run();
    assert.equal(
      matchedRevision(restored, "restored trigger quartz"),
      "catrev_backup_restore",
    );
  } finally {
    restored?.close();
    source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function applyMigrations(database) {
  const directory = resolve(root, "migrations");
  const migrations = (await readdir(directory)).sort();
  for (const migration of migrations) {
    database.exec(await readFile(resolve(directory, migration), "utf8"));
  }
}

function executeAtomically(database, statements) {
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const statement of statements) database.exec(statement);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function matchedRevision(database, text = "quartz") {
  return database.prepare(
    `SELECT catalogue_revision_id
     FROM revision_card_search_fts
     WHERE revision_card_search_fts MATCH ?`,
  ).get(
    `revision_token : "|catrev_backup_restore|" AND ` +
      `search_text : "${text}"`,
  )?.catalogue_revision_id;
}

function cardSearchSchema(database) {
  return database.prepare(
    `SELECT type, name, sql
     FROM sqlite_schema
     WHERE name IN (
       'revision_card_search_fts_rows',
       'revision_card_search_fts',
       'revision_card_search_chunks_insert_fts',
       'revision_card_search_chunks_delete_fts',
       'revision_card_search_chunks_before_update_fts',
       'revision_card_search_chunks_after_update_fts'
     )
     ORDER BY type, name`,
  ).all().map(({ type, name, sql }) => ({
    type,
    name,
    sql: sql.replaceAll(/\s+/gu, " ").trim(),
  }));
}
