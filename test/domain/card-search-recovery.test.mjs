import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { d1Adapter } from "../../acceptance/helpers/query-helpers/sqlite-d1-adapter.mjs";
import {
  prepareCardSearchForD1ExportStatements,
  reconstructCardSearchAfterD1RestoreStatements,
} from "../../src/catalogue/backup-recovery/card-search-recovery-statements.ts";
import { publishCardSearchChunksStatement } from "../../src/catalogue/ingestion/publication-commit-repository.ts";
import { catalogueStore } from "../../src/catalogue/shared/catalogue-store-repository.ts";
import * as cardSearchQueries from "./query-helpers/card-search.ts";
import * as publishedCatalogueQueries from "./query-helpers/published-catalogue.ts";

const root = resolve(import.meta.dirname, "../..");

test("D1 backup export restores the reconstructible Card FTS index", async () => {
  const directory = await mkdtemp(join(tmpdir(), "card-keepr-fts-restore-"));
  const source = new DatabaseSync(join(directory, "source.sqlite"));
  let restored;
  try {
    await applyMigrations(source);
    source.exec("PRAGMA foreign_keys = OFF");
    await publishSearchChunk(source, "card_backup_restore", "backup quartz");
    assert.equal(matchedRevision(source), "catrev_backup_restore");

    const migratedDefinition = cardSearchSchema(source);

    cardSearchQueries
      .setCardSearchFtsStateStateOwnerToken(source)
      .run("backup:acceptance-owner", "2099-01-01T00:00:00.000Z");
    executeAtomically(source, prepareCardSearchForD1ExportStatements);
    assert.equal(publishedCatalogueQueries.countSqliteSchemaCount(source).get().count, 0);
    assert.equal(cardSearchQueries.countRevisionCardSearchChunksCount(source).get().count, 1);

    publishedCatalogueQueries.copySqliteDatabase(source).run(join(directory, "restored.sqlite"));
    restored = new DatabaseSync(join(directory, "restored.sqlite"));
    executeAtomically(restored, reconstructCardSearchAfterD1RestoreStatements);
    cardSearchQueries
      .setCardSearchFtsStateStateOwnerTokenForD1BackupExportRestoresReconstructibleCardFTSIndex(restored)
      .run("backup:acceptance-owner");

    assert.equal(cardSearchQueries.readCardSearchFtsStateState(restored).get().state, "ready");
    assert.equal(matchedRevision(restored), "catrev_backup_restore");
    assert.deepEqual(cardSearchSchema(restored), migratedDefinition);
    // This index-only fixture omits parent query documents on both databases.
    // A new chunk exercises the production write path after reconstruction.
    restored.exec("PRAGMA foreign_keys = OFF");
    await publishSearchChunk(restored, "card_after_restore", "restored repository quartz");
    assert.equal(matchedRevision(restored, "restored repository quartz"), "catrev_backup_restore");
    assert.equal(cardSearchQueries.countRevisionCardSearchChunksCount(restored).get().count, 2);
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
  return cardSearchQueries
    .readRevisionCardSearchFtsCatalogueRevisionId(database)
    .get(`revision_token : "|catrev_backup_restore|" AND ` + `search_text : "${text}"`)?.catalogue_revision_id;
}

function cardSearchSchema(database) {
  return cardSearchQueries
    .readSqliteSchemaTypeName(database)
    .all()
    .map(({ type, name, sql }) => ({
      type,
      name,
      sql: sql.replaceAll(/\s+/gu, " ").trim(),
    }));
}

async function publishSearchChunk(database, cardId, searchText) {
  // Vitest imports the factory and store through one Vite module graph.
  await publishCardSearchChunksStatement(catalogueStore(d1Adapter(database)), {
    revisionId: "catrev_backup_restore",
    chunksJson: JSON.stringify([{ card_id: cardId, field_ordinal: 1, chunk_ordinal: 0, search_text: searchText }]),
  }).run();
}
