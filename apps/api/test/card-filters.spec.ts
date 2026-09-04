import { exports } from "cloudflare:workers";
import { expect, test } from "vitest";
import { cardAttributeProjectionStatement } from "../../../src/catalogue/ingestion/card-attribute-repository";
import { printingQueryProjectionStatements } from "../../../src/catalogue/ingestion/printing-query-materialization";
import { apiCard, apiHeaders, installApiSuite, seedApiRevision, testEnv } from "./api-fixtures";

installApiSuite();

test("Card Product and rarity filters compose across a Card's Printings and existing search filters", async () => {
  await seedCards();
  for (const query of [
    "product_id=product_deck&rarity=rare",
    "product_id=product_deck&rarity=rare&game=one-piece&q=Captain",
    "product_id=product_deck&rarity=rare&game=one-piece&q=Ca",
    "product_id=product_deck&rarity=rare&card_number=OP01-001",
  ]) {
    const response = await api(query);
    expect(response.status).toBe(200);
    const body = await response.json<{ data: { id: string }[] }>();
    expect(body.data.map(({ id }) => id)).toEqual(["card_captain"]);
  }
});

test("unknown Card Product and rarity values fail explicitly before conditional responses", async () => {
  await seedCards();
  for (const [query, parameter] of [
    ["product_id=product_missing", "product_id"],
    ["rarity=imaginary", "rarity"],
  ]) {
    const response = await api(query!, { "if-none-match": "*" });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_parameter",
      invalid_params: [{ name: parameter }],
    });
  }
});

test("Card Game Profile attributes compose typed scalar and array membership filters", async () => {
  await seedCards();
  for (const query of [
    "game=one-piece&attribute.colours=red&attribute.cost=3",
    "game=one-piece&attribute.colours=red&attribute.cost=3&product_id=product_deck&rarity=rare&q=Captain",
  ]) {
    const response = await api(query);
    expect(response.status).toBe(200);
    const body = await response.json<{ data: { id: string }[] }>();
    expect(body.data.map(({ id }) => id)).toEqual(["card_captain"]);
  }
  const empty = await api("game=one-piece&attribute.colours=blue&rarity=rare&product_id=product_deck");
  expect(empty.status).toBe(200);
  await expect(empty.json()).resolves.toMatchObject({ data: [], page: { next_cursor: null } });
});

test("Card attribute names and values fail closed against the selected Game Profile", async () => {
  await seedCards();
  for (const [query, parameter] of [
    ["attribute.colours=red", "attribute.colours"],
    ["game=one-piece&attribute.level=3", "attribute.level"],
    ["game=one-piece&attribute.colours=magenta", "attribute.colours"],
    ["game=one-piece&attribute.cost=-1", "attribute.cost"],
    ["game=one-piece&attribute.cost=3.0", "attribute.cost"],
    ["game=one-piece&attribute.cost=03", "attribute.cost"],
    ["game=one-piece&attribute.cost=999", "attribute.cost"],
    ["game=one-piece&attribute.traits=Imaginary", "attribute.traits"],
    ["game=one-piece&attribute.colours=red&attribute.colours=blue", "attribute.colours"],
    ["game=one-piece&cost=3", "cost"],
  ]) {
    const response = await api(query!, { "if-none-match": "*" });
    expect(response.status, query).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_parameter",
      invalid_params: [{ name: parameter }],
    });
  }
});

test("Card filter cursors bind every active filter and keep values pinned after publication", async () => {
  await seedCards();
  const query = "game=one-piece&rarity=rare&attribute.colours=red&limit=1";
  const first = await (await api(query)).json<{
    data: { id: string }[];
    page: { next_cursor: string };
    meta: { catalogue_revision_id: string };
  }>();
  expect(first.data.map(({ id }) => id)).toEqual(["card_captain"]);
  expect(first.page.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/u);
  for (const changed of [
    "game=one-piece&rarity=common&attribute.colours=red&limit=1",
    "game=one-piece&rarity=rare&attribute.colours=blue&limit=1",
    `${query}&product_id=product_deck`,
  ]) {
    const response = await api(`${changed}&after=${first.page.next_cursor}`);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_cursor" });
  }
  await seedApiRevision({
    revisionId: "catrev_filters_new",
    runId: "run_filters_new",
    cards: [apiCard({ id: "card_new", cardNumber: "OP99-001", name: "New" })],
  });
  const next = await (await api(`${query}&after=${first.page.next_cursor}`)).json<{
    data: { id: string }[];
    page: { next_cursor: string | null };
    meta: { catalogue_revision_id: string };
  }>();
  expect(next.data.map(({ id }) => id)).toEqual(["card_guest"]);
  expect(next.page.next_cursor).toBeNull();
  expect(next.meta.catalogue_revision_id).toBe(first.meta.catalogue_revision_id);
  expect((await api(query)).status).toBe(400);
});

test("attribute parameter order has one canonical Card representation and ETag", async () => {
  await seedCards();
  const first = await api("game=one-piece&attribute.cost=3&attribute.colours=red&rarity=RARE");
  const second = await api("attribute.colours=red&rarity=rare&attribute.cost=3&game=one-piece");
  expect(first.status).toBe(200);
  expect(second.headers.get("etag")).toBe(first.headers.get("etag"));
  expect(await second.text()).toBe(await first.text());
});

let fixtureSequence = 0;
async function seedCards() {
  const suffix = ++fixtureSequence;
  const revisionId = `catrev_filters_${suffix}`;
  const cards = [
    apiCard({ id: "card_captain", cardNumber: "OP01-001", name: "Captain" }),
    apiCard({ id: "card_crew", cardNumber: "OP01-002", name: "Crew" }),
    apiCard({ id: "card_guest", cardNumber: "OP01-003", name: "Guest" }),
  ];
  for (const [index, card] of cards.entries()) {
    const gameData = card.game_data as { attributes: Record<string, unknown> };
    gameData.attributes.card_type = "character";
    gameData.attributes.cost = index === 0 ? 3 : 4;
    gameData.attributes.colours = index === 1 ? ["blue"] : ["red"];
  }
  await seedApiRevision({ revisionId, runId: `run_filters_${suffix}`, cards });
  await cardAttributeProjectionStatement(testEnv.CATALOGUE_DB, revisionId).run();
  const printings = [
    { printing_id: "printing_captain_common", card_id: "card_captain", normalized_rarity: "common" },
    { printing_id: "printing_captain_rare", card_id: "card_captain", normalized_rarity: "rare" },
    { printing_id: "printing_crew", card_id: "card_crew", normalized_rarity: "common" },
    { printing_id: "printing_guest", card_id: "card_guest", normalized_rarity: "rare" },
  ];
  await testEnv.CATALOGUE_DB.batch([
    ...printings.map((printing) =>
      testEnv.CATALOGUE_DB.prepare("INSERT INTO revision_printings VALUES (?, ?, ?, ?)").bind(
        revisionId,
        printing.printing_id,
        printing.card_id,
        JSON.stringify(printing),
      ),
    ),
    testEnv.CATALOGUE_DB.prepare(
      "INSERT INTO revision_products VALUES (?, 'product_deck', 'one-piece', 'ST-01', 'Deck', 'deck', '[]', '{}')",
    ).bind(revisionId),
    ...["printing_captain_common", "printing_crew"].map((id) =>
      testEnv.CATALOGUE_DB.prepare("INSERT INTO revision_product_relationships VALUES (?, ?, ?)").bind(
        revisionId,
        `relationship_${id}`,
        JSON.stringify({
          kind: "printing-product",
          from: { id },
          to: { id: "product_deck" },
          lifecycle: { current: true },
        }),
      ),
    ),
    ...printingQueryProjectionStatements(
      testEnv.CATALOGUE_DB,
      revisionId,
      printings.map((printing) => ({ ...printing, supported_game: "one-piece" as const })),
    ),
  ]);
}

function api(query: string, headers: Record<string, string> = {}) {
  return exports.default.fetch(
    new Request(`https://card-keepr.invalid/v1/cards?${query}`, {
      headers: { ...apiHeaders("203.0.113.79"), ...headers },
    }),
  );
}
