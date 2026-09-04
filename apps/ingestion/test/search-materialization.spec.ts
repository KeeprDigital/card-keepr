import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import { insertRepairedCardSearchChunkStatement } from "../../../src/catalogue/ingestion/card-search-repair-repository";
import {
  deleteArchivedCardQueryDocumentsStatement,
  publishCardSearchChunksStatement,
} from "../../../src/catalogue/ingestion/publication-commit-repository";
import { catalogueStore } from "../../../src/catalogue/shared";
import {
  archiveMaterializedRevision,
  matchingMaterializedCards,
  materializationCounts,
  removeSearchMaterializationTriggers,
  seedSearchMaterializationCard,
  seedSearchMaterializationRevision,
} from "./query-helpers/search-materialization";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
beforeAll(async () => {
  await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
  await removeSearchMaterializationTriggers(testEnv.CATALOGUE_DB);
  await seedSearchMaterializationRevision(testEnv.CATALOGUE_DB);
});
test("published Card chunks are searchable without schema materialization triggers", async () => {
  await seedSearchMaterializationCard(testEnv.CATALOGUE_DB, "card_materialized");
  const database = catalogueStore(testEnv.CATALOGUE_DB);
  await publishCardSearchChunksStatement(database, {
    revisionId: "catrev_materialization",
    chunksJson: JSON.stringify([
      { card_id: "card_materialized", field_ordinal: 0, chunk_ordinal: 0, search_text: "monkey captain" },
      { card_id: "card_materialized", field_ordinal: 1, chunk_ordinal: 0, search_text: "pirate crew" },
    ]),
  }).run();
  expect((await matchingMaterializedCards(database, '"captain"').all()).results).toEqual([
    { card_id: "card_materialized" },
  ]);
  expect((await matchingMaterializedCards(database, '"pirate"').all()).results).toEqual([
    { card_id: "card_materialized" },
  ]);
});

test("replayed repair chunks keep their persisted search text and exactly one FTS row", async () => {
  await seedSearchMaterializationCard(testEnv.CATALOGUE_DB, "card_repair_replay");
  const database = catalogueStore(testEnv.CATALOGUE_DB);
  await insertRepairedCardSearchChunkStatement(database, {
    revisionId: "catrev_materialization",
    cardId: "card_repair_replay",
    fieldOrdinal: 0,
    chunkOrdinal: 0,
    searchText: "retained navigator",
  }).run();
  const replay = await insertRepairedCardSearchChunkStatement(database, {
    revisionId: "catrev_materialization",
    cardId: "card_repair_replay",
    fieldOrdinal: 0,
    chunkOrdinal: 0,
    searchText: "uncommitted musician",
  }).run();
  expect(replay.meta.changes).toBe(0);
  expect(await materializationCounts(database, "card_repair_replay").first()).toEqual({ chunks: 1, rows: 1, fts: 1 });
  expect((await matchingMaterializedCards(database, '"navigator"').all()).results).toEqual([
    { card_id: "card_repair_replay" },
  ]);
  expect((await matchingMaterializedCards(database, '"musician"').all()).results).toEqual([]);
});

test("a later batch failure rolls back published chunks and both FTS representations together", async () => {
  await seedSearchMaterializationCard(testEnv.CATALOGUE_DB, "card_atomic_search");
  const database = catalogueStore(testEnv.CATALOGUE_DB);
  await expect(
    database.batch([
      publishCardSearchChunksStatement(database, {
        revisionId: "catrev_materialization",
        chunksJson: JSON.stringify([
          { card_id: "card_atomic_search", field_ordinal: 0, chunk_ordinal: 0, search_text: "rollback lookout" },
        ]),
      }),
      publishCardSearchChunksStatement(database, {
        revisionId: "catrev_materialization",
        chunksJson: JSON.stringify([
          { card_id: "missing_card", field_ordinal: 0, chunk_ordinal: 0, search_text: "invalid" },
        ]),
      }),
    ]),
  ).rejects.toThrow("FOREIGN KEY");
  expect(await materializationCounts(database, "card_atomic_search").first()).toEqual({ chunks: 0, rows: 0, fts: 0 });
  expect((await matchingMaterializedCards(database, '"lookout"').all()).results).toEqual([]);
});

test("archiving query documents removes their chunks, FTS rows, and logical mappings atomically", async () => {
  await seedSearchMaterializationCard(testEnv.CATALOGUE_DB, "card_archived_search");
  const database = catalogueStore(testEnv.CATALOGUE_DB);
  await insertRepairedCardSearchChunkStatement(database, {
    revisionId: "catrev_materialization",
    cardId: "card_archived_search",
    fieldOrdinal: 0,
    chunkOrdinal: 0,
    searchText: "archived helmsman",
  }).run();
  await database.batch([archiveMaterializedRevision(database), deleteArchivedCardQueryDocumentsStatement(database)]);
  expect(await materializationCounts(database, "card_archived_search").first()).toEqual({ chunks: 0, rows: 0, fts: 0 });
  expect((await matchingMaterializedCards(database, '"helmsman"').all()).results).toEqual([]);
});
