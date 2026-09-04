import { publishCardSearchChunksStatement } from "../../../src/catalogue/ingestion/publication-commit-repository";
import { catalogueStore } from "../../../src/catalogue/shared";
import * as publishedCatalogueQueries from "./query-helpers/published-catalogue";
import * as ingestionQueries from "./query-helpers/ingestion";
import * as cardSearchQueries from "./query-helpers/card-search";
import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { cardSearchChunks, cardSearchFtsQuery, cardSearchText } from "../../../src/catalogue/read";
import { releaseSmokeSearchQuery } from "../../../src/catalogue/ingestion";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };

beforeEach(async () => {
  await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
});

test("Production Release search fixtures come from realistic revision-pinned Card index material", async () => {
  const revision = "catrev_release_fixture";
  const cardId = "opaque-card-row-2";
  const data = {
    type: "card",
    id: cardId,
    game: "one-piece",
    official_identity: { kind: "card_number", value: "OP99-002" },
    name: "Indexed Release Sentinel",
    effective_rules_text: "When attacking, draw one indexed card.",
    game_data: { profile: "one-piece@1", attributes: {} },
    lifecycle: { current: true },
    links: {},
  };
  const document = JSON.stringify({ data });
  const summary = JSON.stringify(data);
  const searchDocument = cardSearchText(data);
  await testEnv.CATALOGUE_DB.batch([
    ingestionQueries
      .insertIngestionRunsForProductionReleaseSearchFixturesComeFromRealisticRevisionPinned(testEnv.CATALOGUE_DB)
      .bind("a".repeat(64)),
    ingestionQueries.setOperationStateActiveIngestionRunIdForProductionReleaseSearchFixturesComeFromRealisticRevisionPinned(
      testEnv.CATALOGUE_DB,
    ),
  ]);
  await ingestionQueries
    .insertCatalogueRevisionsForProductionReleaseSearchFixturesComeFromRealisticRevisionPinned(testEnv.CATALOGUE_DB)
    .bind(revision, "b".repeat(64), "a".repeat(64))
    .run();
  await testEnv.CATALOGUE_DB.batch([
    publishedCatalogueQueries
      .insertRevisionCardsForProductionReleaseSearchFixturesComeFromRealisticRevisionPinned(testEnv.CATALOGUE_DB)
      .bind(revision, cardId, document),
    publishedCatalogueQueries
      .insertRevisionCardQueryDocumentsForProductionReleaseSearchFixturesComeFromRealisticRevisionPinned(
        testEnv.CATALOGUE_DB,
      )
      .bind(revision, cardId, summary, searchDocument),
  ]);
  await publishCardSearchChunksStatement(catalogueStore(testEnv.CATALOGUE_DB), {
    revisionId: revision,
    chunksJson: JSON.stringify(
      cardSearchChunks(searchDocument).map((chunk) => ({
        card_id: cardId,
        field_ordinal: chunk.field,
        chunk_ordinal: chunk.ordinal,
        search_text: chunk.text,
      })),
    ),
  }).run();

  const query = releaseSmokeSearchQuery(document);
  expect(query).toBe("op99-002");
  expect(query).not.toBe(cardId);
  if (query === null) throw new Error("release search fixture missing");
  const fts = cardSearchFtsQuery(query, revision);
  const indexed = await cardSearchQueries
    .readRevisionCardSearchFtsCardId(testEnv.CATALOGUE_DB)
    .bind(fts, revision, query)
    .first<{ card_id: string }>();
  expect(indexed?.card_id).toBe(cardId);
});
