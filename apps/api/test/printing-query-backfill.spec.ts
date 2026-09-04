import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { expect, test } from "vitest";
import { seedPrintingQueryFixture } from "./printing-query-fixtures";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };

test("Printing projection backfills retained bare and enveloped documents and current Product memberships", async () => {
  await applyD1Migrations(
    testEnv.CATALOGUE_DB,
    testEnv.TEST_MIGRATIONS.filter(({ name }) => Number.parseInt(name, 10) < 6),
  );
  await seedPrintingQueryFixture(testEnv.CATALOGUE_DB);
  await testEnv.CATALOGUE_DB.batch([
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE revision_cards SET document_json = json_object('data', json(document_json)) WHERE catalogue_revision_id = 'catrev_products'`,
    ),
    testEnv.CATALOGUE_DB.prepare(`INSERT INTO revision_printings
      SELECT catalogue_revision_id, 'printing_enveloped', card_id, json_object('data', json_set(document_json, '$.id', 'printing_enveloped'))
      FROM revision_printings WHERE printing_id = 'printing_st15_event'`),
    testEnv.CATALOGUE_DB.prepare(`INSERT INTO revision_products
      SELECT catalogue_revision_id, 'product_empty', supported_game, NULL, 'No regions', '', '[]', '{}'
      FROM revision_products WHERE product_id = 'product_st15'`),
    testEnv.CATALOGUE_DB.prepare(`INSERT INTO revision_products
      SELECT catalogue_revision_id, 'product_shared', supported_game, NULL, 'Shared', '', '["EN-US","EN-EU"]', '{}'
      FROM revision_products WHERE product_id = 'product_st15'`),
    ...[
      ["shared-first", "printing_enveloped", "product_shared", true],
      ["shared-second", "printing_st15_event", "product_shared", true],
      ["current", "printing_st15_event", "product_st15", true],
      ["duplicate", "printing_st15_event", "product_st15", true],
      ["historical", "printing_enveloped", "product_st15", false],
      ["no-region", "printing_enveloped", "product_empty", true],
    ].map(([id, printing, product, current]) =>
      testEnv.CATALOGUE_DB.prepare(`INSERT INTO revision_product_relationships VALUES ('catrev_products', ?, ?)`).bind(
        id,
        JSON.stringify({
          kind: "printing-product",
          from: { id: printing },
          to: { id: product },
          lifecycle: { current },
        }),
      ),
    ),
  ]);
  await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
  for (const [filters, ids] of [
    ["game=one-piece&rarity=leader", ["printing_enveloped", "printing_st15_event"]],
    ["product_id=product_st15&release_region=EN-OCEANIA", ["printing_st15_event"]],
    ["release_region=EN-OCEANIA", ["printing_st15_event"]],
    ["product_id=product_empty", ["printing_enveloped"]],
    ["product_id=product_empty&release_region=EN-OCEANIA", []],
  ] as const) {
    const response = await exports.default.fetch(
      new Request(`https://card-keepr.invalid/v1/printings?${filters}`, {
        headers: { authorization: "Bearer vitest-api-key", "cf-connecting-ip": "203.0.113.29" },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json<{ data: { id: string }[] }>();
    expect(body.data.map(({ id }) => id)).toEqual(ids);
  }
  const first = await printingPage("product_id=product_shared&limit=1");
  expect(first.data.map(({ id }) => id)).toEqual(["printing_enveloped"]);
  expect(first.page.next_cursor).toEqual(expect.any(String));
  const second = await printingPage(
    `product_id=product_shared&limit=1&after=${encodeURIComponent(first.page.next_cursor!)}`,
  );
  expect(second.data.map(({ id }) => id)).toEqual(["printing_st15_event"]);
  expect(second.page.next_cursor).toBeNull();
});

async function printingPage(query: string) {
  const response = await exports.default.fetch(
    new Request(`https://card-keepr.invalid/v1/printings?${query}`, {
      headers: { authorization: "Bearer vitest-api-key", "cf-connecting-ip": "203.0.113.29" },
    }),
  );
  expect(response.status).toBe(200);
  return response.json<{ data: { id: string }[]; page: { next_cursor: string | null } }>();
}
