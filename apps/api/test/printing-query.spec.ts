import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { expect, test } from "vitest";
import { printingCollectionQuery } from "../../../src/catalogue/read";
import { seedPrintingQueryFixture, seedPrintingQueryProjection } from "./printing-query-fixtures";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
test("Printing filters seek publication indexes without scanning thousands of unrelated Printings", async () => {
  await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
  await seedPrintingQueryFixture(testEnv.CATALOGUE_DB);
  await testEnv.CATALOGUE_DB.batch([
    testEnv.CATALOGUE_DB.prepare(`INSERT INTO revision_cards(catalogue_revision_id, card_id, document_json)
      SELECT catalogue_revision_id, 'card_zz_bulk', json_set(document_json, '$.id', 'card_zz_bulk', '$.game', 'digimon')
      FROM revision_cards WHERE catalogue_revision_id = 'catrev_products' AND card_id = 'card_st15_event'`),
    testEnv.CATALOGUE_DB.prepare(`INSERT INTO revision_printings(catalogue_revision_id, printing_id, card_id, document_json)
      WITH RECURSIVE entries(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM entries WHERE n < 6000)
      SELECT 'catrev_products', printf('printing_bulk_%05d', n), 'card_zz_bulk',
             json_set(printing.document_json, '$.id', printf('printing_bulk_%05d', n), '$.card_id', 'card_zz_bulk', '$.rarity.normalized', 'common')
      FROM entries CROSS JOIN revision_printings AS printing
      WHERE printing.catalogue_revision_id = 'catrev_products' AND printing.printing_id = 'printing_st15_event'`),
    testEnv.CATALOGUE_DB.prepare(`INSERT INTO revision_products(catalogue_revision_id, product_id, supported_game, official_code, name, search_text, release_regions_json, document_json)
      SELECT catalogue_revision_id, 'product_bulk', 'digimon', 'BULK', 'Bulk', 'bulk', '["EN-US"]', document_json
      FROM revision_products WHERE catalogue_revision_id = 'catrev_products' AND product_id = 'product_st15'`),
    testEnv.CATALOGUE_DB.prepare(`INSERT INTO revision_product_relationships(catalogue_revision_id, relationship_id, document_json)
      SELECT catalogue_revision_id, 'relationship_' || printing_id,
        json_object('kind', 'printing-product', 'from', json_object('id', printing_id),
          'to', json_object('id', CASE WHEN printing_id = 'printing_st15_event' THEN 'product_st15' ELSE 'product_bulk' END),
          'lifecycle', json_object('current', json('true')))
      FROM revision_printings WHERE catalogue_revision_id = 'catrev_products'`),
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
    const query = printingCollectionQuery("catrev_products", { ...none, ...filters }, null, 2);
    const plan = await testEnv.CATALOGUE_DB.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
      .bind(...query.bindings)
      .all<{ detail: string }>();
    expect(
      plan.results.some(({ detail }) => detail.includes("SEARCH") && detail.includes(index)),
      JSON.stringify(plan.results),
    ).toBe(true);
    expect(query.sql).not.toMatch(/json_extract|json_each/u);
    const result = await testEnv.CATALOGUE_DB.prepare(query.sql)
      .bind(...query.bindings)
      .all<{ printing_id: string }>();
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
