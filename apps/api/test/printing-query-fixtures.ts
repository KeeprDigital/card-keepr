import { catalogueStore } from "../../../src/catalogue/shared";
import * as ingestionQueries from "../../ingestion/test/query-helpers/ingestion";
import * as publishedCatalogueQueries from "../../ingestion/test/query-helpers/published-catalogue";
import {
  type PrintingQueryFact,
  printingQueryProjectionStatements,
} from "../../../src/catalogue/ingestion/printing-query-materialization";

export async function seedPrintingQueryFixture(database: D1Database): Promise<void> {
  await database.batch([
    ingestionQueries.insertIngestionRuns(database).bind(
      "a".repeat(64),
      JSON.stringify({
        candidate_digest: "a".repeat(64),
        expected_current_revision_id: "catrev_spine_000",
        approved_at: "2026-01-01T00:00:00.000Z",
      }),
    ),
    ingestionQueries.setOperationStateActiveIngestionRunId(database),
    publishedCatalogueQueries.insertCatalogueRevisions(database).bind("a".repeat(64), "a".repeat(64)),
    publishedCatalogueQueries.insertCatalogueQueryRevisions(database),
    publishedCatalogueQueries
      .insertRevisionCardsForSeedPrintingQueryFixture(database)
      .bind(JSON.stringify({ id: "card_st15_event", game: "one-piece" })),
    publishedCatalogueQueries.insertRevisionPrintingsForSeedPrintingQueryFixture(database).bind(
      JSON.stringify({
        id: "printing_st15_event",
        card_id: "card_st15_event",
        rarity: { normalized: "leader", raw: "L" },
      }),
    ),
    publishedCatalogueQueries.insertRevisionProductsForSeedPrintingQueryFixture(database),
    publishedCatalogueQueries.setCatalogueStateCurrentRevisionId(database),
  ]);
}

export async function seedPrintingQueryProjection(database: D1Database): Promise<void> {
  const rows = await publishedCatalogueQueries
    .readRevisionPrintingsSupportedGameNormalizedRarity(database)
    .all<PrintingQueryFact>();
  await database.batch([
    publishedCatalogueQueries.deleteRevisionPrintingQuery(database),
    ...printingQueryProjectionStatements(catalogueStore(database), "catrev_products", rows.results),
  ]);
}
