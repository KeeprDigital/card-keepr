import { inspectPrintingCollectionQuery } from "../../ingestion/test/query-helpers/collection-query-plans";
import * as publishedCatalogueQueries from "../../ingestion/test/query-helpers/published-catalogue";
import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { expect, test } from "vitest";
import { seedPrintingQueryFixture, seedPrintingQueryProjection } from "./printing-query-fixtures";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
test("Printing filters seek publication indexes without scanning thousands of unrelated Printings", async () => {
  await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
  await seedPrintingQueryFixture(testEnv.CATALOGUE_DB);
  await testEnv.CATALOGUE_DB.batch([
    publishedCatalogueQueries.insertRevisionCards(testEnv.CATALOGUE_DB),
    publishedCatalogueQueries.insertRevisionPrintingsForPrintingFiltersSeekPublicationIndexesWithoutScanningThousandsUnrelated(
      testEnv.CATALOGUE_DB,
    ),
    publishedCatalogueQueries.insertRevisionProductsForPrintingFiltersSeekPublicationIndexesWithoutScanningThousandsUnrelated(
      testEnv.CATALOGUE_DB,
    ),
    publishedCatalogueQueries.insertRevisionProductRelationshipsForPrintingFiltersSeekPublicationIndexesWithoutScanningThousandsUnrelated(
      testEnv.CATALOGUE_DB,
    ),
  ]);
  await seedPrintingQueryProjection(testEnv.CATALOGUE_DB);
  const none = { card_id: null, game: null, rarity: null, product_id: null, release_region: null };
  const cases = [
    [{ card_id: "card_st15_event" }, "revision_printing_query_by_card"],
    [{ game: "one-piece" }, "revision_printing_query_by_game"],
    [{ rarity: "leader" }, "revision_printing_query_by_rarity"],
    [{ game: "one-piece", rarity: "leader" }, "revision_printing_query_by_game_rarity"],
    [{ product_id: "product_st15" }, "revision_printing_products_by_product"],
    [{ release_region: "EN-OCEANIA" }, "revision_printing_products_by_region"],
    [{ product_id: "product_st15", release_region: "EN-OCEANIA" }, "revision_printing_products_by_product_region"],
    [
      { card_id: "card_st15_event", product_id: "product_st15", release_region: "EN-OCEANIA" },
      "revision_printing_query_by_card",
    ],
  ] as const;
  for (const [filters, index] of cases) {
    const query = inspectPrintingCollectionQuery(
      testEnv.CATALOGUE_DB,
      "catrev_products",
      { ...none, ...filters },
      null,
      2,
    );
    const plan = await query.plan().all<{ detail: string }>();
    expect(
      plan.results.some(({ detail }) => detail.includes("SEARCH") && detail.includes(index)),
      JSON.stringify(plan.results),
    ).toBe(true);
    expect(query.sql).not.toMatch(/json_extract|json_each/u);
    const result = await query.rows().all<{ printing_id: string }>();
    expect(result.results.map(({ printing_id }) => printing_id)).toEqual(["printing_st15_event"]);
    expect(result.meta.rows_read, JSON.stringify({ filters, meta: result.meta })).toBeLessThan(40);
    const response = await api(`/v1/printings?${new URLSearchParams(filters)}`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: [{ id: "printing_st15_event" }] });
  }
});

function api(path: string): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://card-keepr.invalid${path}`, {
      headers: { authorization: "Bearer vitest-api-key", "cf-connecting-ip": "203.0.113.28" },
    }),
  );
}
