import { expect, test } from "vitest";
import apiWorker from "../src/index";
import { apiCard, apiHeaders, installApiSuite, seedApiRevision, testEnv } from "./api-fixtures";
import { assertHttpResponse } from "../../../test/support/http-contract";
import contract from "../../../contracts/read-openapi.json";

installApiSuite();

test("game discovery exposes only published consumer facts and validates before conditional responses", async () => {
  const request = (query = "", key = "vitest-api-key") =>
    apiWorker.fetch(
      new Request(`https://card-keepr.invalid/v1/games${query}`, {
        headers: { authorization: `Bearer ${key}`, "if-none-match": "*" },
      }),
      testEnv,
    );
  const response = await apiWorker.fetch(
    new Request("https://card-keepr.invalid/v1/games", { headers: apiHeaders("discovery") }),
    testEnv,
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ data: [] });
  expect((await request("?source_lineage=one-piece-en")).status).toBe(400);
  expect((await request("", "vitest-administration-key")).status).toBe(401);
  expect((await request()).status).toBe(304);
  await assertHttpResponse(contract, "/v1/games", "get", response, body);
});

test("Card detail and catalogue status use generated contracts for actual success and validation branches", async () => {
  await seedApiRevision({
    revisionId: "catrev_detail_wire",
    runId: "run_detail_wire",
    cards: [apiCard({ id: "card_detail_wire", cardNumber: "OP01-001", name: "Captain" })],
  });
  for (const [path, definition] of [
    ["/v1/cards/card_detail_wire", "/v1/cards/{card}"],
    ["/v1/catalogue", "/v1/catalogue"],
  ]) {
    const response = await apiWorker.fetch(
      new Request(`https://card-keepr.invalid${path}`, { headers: apiHeaders("detail-wire") }),
      testEnv,
    );
    expect(response.status).toBe(200);
    await assertHttpResponse(contract, definition!, "get", response);
    const invalid = await apiWorker.fetch(
      new Request(`https://card-keepr.invalid${path}?private=true`, {
        headers: { ...apiHeaders("detail-invalid"), "if-none-match": "*" },
      }),
      testEnv,
    );
    expect(invalid.status).toBe(400);
    await assertHttpResponse(contract, definition!, "get", invalid);
  }
});

test("Card search and validation responses conform to the generated wire contract", async () => {
  await seedApiRevision({
    revisionId: "catrev_hono",
    runId: "run_hono",
    cards: [apiCard({ id: "card_hono", cardNumber: "OP01-001", name: "Captain" })],
  });
  for (const [query, expected] of [
    ["game=one-piece&q=Captain", 200],
    ["limit=01", 400],
    ["unknown=true", 400],
  ] as const) {
    const response = await apiWorker.fetch(
      new Request(`https://card-keepr.invalid/v1/cards?${query}`, { headers: apiHeaders(`hono-${query}`) }),
      testEnv,
    );
    expect(response.status).toBe(expected);
    await assertHttpResponse(contract, "/v1/cards", "get", response);
  }
});

test("pilot methods preserve credential isolation and reject unsupported HEAD without reading catalogue data", async () => {
  for (const [method, key, status] of [
    ["GET", "vitest-administration-key", 401],
    ["HEAD", "vitest-api-key", 404],
    ["POST", "vitest-api-key", 404],
  ] as const) {
    const response = await apiWorker.fetch(
      new Request("https://card-keepr.invalid/v1/cards", { method, headers: { authorization: `Bearer ${key}` } }),
      testEnv,
    );
    expect(response.status).toBe(status);
    if (method === "GET") await assertHttpResponse(contract, "/v1/cards", "get", response);
  }
});

test("Card search preserves an owner-admitted unknown official identity", async () => {
  await seedApiRevision({
    revisionId: "catrev_unknown_identity",
    runId: "run_unknown_identity",
    cards: [
      {
        ...apiCard({ id: "card_unknown_identity", cardNumber: "", name: "Owner-admitted Card" }),
        official_identity: { kind: "unknown", value: null },
      },
    ],
  });
  const response = await apiWorker.fetch(
    new Request("https://card-keepr.invalid/v1/cards", { headers: apiHeaders("unknown-identity") }),
    testEnv,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const document = await response.json<{ data: { official_identity: unknown }[] }>();
  expect(document.data[0]!.official_identity).toEqual({ kind: "unknown", value: null });
  await assertHttpResponse(contract, "/v1/cards", "get", response, document);
});

test.each([false, true])("Card search preserves the retained withdrawal marker %s", async (withdrawn) => {
  const revisionId = `catrev_withdrawal_${withdrawn}`;
  const withdrawal = { withdrawn, withdrawal: withdrawn ? { revision_id: revisionId } : null };
  await seedApiRevision({
    revisionId,
    runId: `run_withdrawal_${withdrawn}`,
    cards: [
      {
        ...apiCard({ id: `card_withdrawal_${withdrawn}`, cardNumber: "OP01-001", name: "Retained Card" }),
        lifecycle: {
          first_revision_id: revisionId,
          last_observed_revision_id: revisionId,
          ...withdrawal,
        },
      },
    ],
  });
  const response = await apiWorker.fetch(
    new Request("https://card-keepr.invalid/v1/cards", { headers: apiHeaders(`withdrawal-marker-${withdrawn}`) }),
    testEnv,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const document = await response.json<{ data: { lifecycle: unknown }[] }>();
  expect(document.data[0]!.lifecycle).toMatchObject(withdrawal);
  await assertHttpResponse(contract, "/v1/cards", "get", response, document);
});

test("Card search exposes gameplay, token and art Cards with their applicable profile data", async () => {
  await seedCardCategories("all");
  const response = await apiWorker.fetch(
    new Request("https://card-keepr.invalid/v1/cards", { headers: apiHeaders("hono-categories") }),
    testEnv,
  );
  expect(response.status).toBe(200);
  const document = await response.json<{ data: Record<string, unknown>[] }>();
  expect(document.data.map(({ category }) => category).sort()).toEqual(["art", "gameplay", "token"]);
  expect(document.data.find(({ category }) => category === "art")).toMatchObject({
    gameplay_applicability: "inapplicable",
    game_data: { profile: "one-piece@1", attributes: {} },
    related_cards: [{ kind: "shared_artwork", card_id: "card_hono_gameplay" }],
  });
  expect(document.data.find(({ category }) => category === "gameplay")).toMatchObject({
    gameplay_applicability: "applicable",
    game_data: { attributes: { cost: null, power: 5000 } },
    related_cards: [],
  });
  expect(document.data.find(({ category }) => category === "token")).toMatchObject({
    gameplay_applicability: "applicable",
    game_data: { profile: "gundam@1", attributes: { card_type: "unit_token", cost: null, ap: 1 } },
    related_cards: [],
  });
  await assertHttpResponse(contract, "/v1/cards", "get", response, document);
});

test("Card category filters select each category and reject invalid values before a conditional response", async () => {
  await seedCardCategories("filter");
  for (const category of ["gameplay", "token", "art"]) {
    const response = await apiWorker.fetch(
      new Request(`https://card-keepr.invalid/v1/cards?category=${category}`, {
        headers: apiHeaders(`hono-category-${category}`),
      }),
      testEnv,
    );
    expect(response.status).toBe(200);
    const document = await response.json<{ data: { category: string }[] }>();
    expect(document.data.map((card) => card.category)).toEqual([category]);
    await assertHttpResponse(contract, "/v1/cards", "get", response, document);
  }
  const invalid = await apiWorker.fetch(
    new Request("https://card-keepr.invalid/v1/cards?category=collectible", {
      headers: { ...apiHeaders("hono-category-invalid"), "if-none-match": "*" },
    }),
    testEnv,
  );
  expect(invalid.status).toBe(400);
  await assertHttpResponse(contract, "/v1/cards", "get", invalid);
  await expect(invalid.json()).resolves.toMatchObject({
    code: "invalid_parameter",
    invalid_params: [{ name: "category" }],
  });
});

async function seedCardCategories(suffix: string) {
  await seedApiRevision({
    revisionId: `catrev_hono_categories_${suffix}`,
    runId: `run_hono_categories_${suffix}`,
    cards: [
      apiCard({ id: "card_hono_gameplay", cardNumber: "OP01-001", name: "Captain" }),
      {
        ...apiCard({ id: "card_hono_art", cardNumber: "ART-001", name: "Captain illustration" }),
        category: "art",
        gameplay_applicability: "inapplicable",
        effective_rules_text: null,
        game_data: { profile: "one-piece@1", attributes: {} },
        related_cards: [{ kind: "shared_artwork", card_id: "card_hono_gameplay" }],
      },
      {
        ...apiCard({ id: "card_hono_token", cardNumber: "TOKEN-001", name: "Unit token" }),
        game: "gundam",
        category: "token",
        game_data: {
          profile: "gundam@1",
          attributes: {
            card_type: "unit_token",
            colours: [],
            level: null,
            cost: null,
            block_icon: null,
            effect_text: null,
            zone: null,
            traits: [],
            link_condition: null,
            ap: 1,
            hp: 1,
            series_titles: [],
          },
        },
      },
    ],
  });
}
