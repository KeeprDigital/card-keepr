import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  prepareCardSearchForD1ExportStatements,
  reconstructCardSearchAfterD1RestoreStatements,
} from "../src/catalogue/card-search-recovery-statements.mjs";

const root = resolve(import.meta.dirname, "..");

test("D1 backup export restores the reconstructible Card FTS index", async () => {
  const source = new DatabaseSync(":memory:");
  const restored = new DatabaseSync(":memory:");
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

    const exported = source.serialize();
    restored.deserialize(exported);
    executeAtomically(
      restored,
      reconstructCardSearchAfterD1RestoreStatements,
    );

    assert.equal(
      restored.prepare(
        "SELECT state FROM card_search_fts_state WHERE singleton = 1",
      ).get().state,
      "ready",
    );
    assert.equal(matchedRevision(restored), "catrev_backup_restore");
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
    restored.close();
    source.close();
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
