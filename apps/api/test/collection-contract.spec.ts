import * as publishedCatalogueQueries from "../../ingestion/test/query-helpers/published-catalogue";
import { expect, test } from "vitest";
import apiWorker from "../src/index";
import { apiCard, apiHeaders, installApiSuite, seedApiRevision, testEnv } from "./api-fixtures";

installApiSuite();

test.each(["q", "card_number"])(
  "Card %s caps normalization expansion before publishing a canonical link",
  async (name) => {
    await seedApiRevision({ revisionId: `catrev_expansion_${name}`, runId: `run_expansion_${name}`, cards: [] });
    const response = await apiWorker.fetch(
      new Request(`https://card-keepr.invalid/v1/cards?${name}=${encodeURIComponent("ﬃ".repeat(167))}`, {
        headers: apiHeaders(`collection-expansion-${name}`),
      }),
      testEnv,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_parameter", invalid_params: [{ name }] });
  },
);

test("equivalent Card cursor encodings have byte-identical representations and validators", async () => {
  await seedApiRevision({
    revisionId: "catrev_collection_cursor_encoding",
    runId: "run_collection_cursor_encoding",
    cards: [
      apiCard({ id: "card_encoding_a", cardNumber: "OP01-001", name: "First" }),
      apiCard({ id: "card_encoding_b", cardNumber: "OP01-002", name: "Second" }),
    ],
  });
  const fetchPage = (after: string | null) =>
    apiWorker.fetch(
      new Request(
        `https://card-keepr.invalid/v1/cards?limit=1${after === null ? "" : `&after=${encodeURIComponent(after)}`}`,
        { headers: apiHeaders("collection-cursor-encoding") },
      ),
      testEnv,
    );
  const first = await fetchPage(null);
  const { page } = await first.json<{ page: { next_cursor: string } }>();
  const decoded = JSON.parse(atob(page.next_cursor.replaceAll("-", "+").replaceAll("_", "/"))) as Record<
    string,
    unknown
  >;
  const alternate = btoa(JSON.stringify(Object.fromEntries(Object.entries(decoded).reverse())));
  const original = await fetchPage(page.next_cursor);
  const equivalent = await fetchPage(alternate);
  expect(original.status).toBe(200);
  expect(equivalent.status).toBe(200);
  expect(equivalent.headers.get("etag")).toBe(original.headers.get("etag"));
  expect(await equivalent.text()).toBe(await original.text());
});

test.each(["cards", "printings", "products"])(
  "%s requires an available current query projection before returning a page or 304",
  async (collection) => {
    const revisionId = `catrev_collection_unavailable_${collection}`;
    await seedApiRevision({ revisionId, runId: `run_collection_unavailable_${collection}`, cards: [] });
    const url = `https://card-keepr.invalid/v1/${collection}`;
    const first = await apiWorker.fetch(new Request(url, { headers: apiHeaders(`${collection}-available`) }), testEnv);
    expect(first.status).toBe(200);
    await publishedCatalogueQueries
      .setCatalogueQueryRevisionsStateForCollectionContract(testEnv.CATALOGUE_DB)
      .bind(revisionId)
      .run();
    const unavailable = await apiWorker.fetch(
      new Request(url, {
        headers: { ...apiHeaders(`${collection}-unavailable`), "if-none-match": first.headers.get("etag")! },
      }),
      testEnv,
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ code: "catalogue_query_unavailable" });
  },
);

test.each(["cards", "printings", "products"])(
  "%s validators identify canonical filters regardless of parameter order",
  async (collection) => {
    await seedApiRevision({
      revisionId: `catrev_collection_etag_${collection}`,
      runId: `run_collection_etag_${collection}`,
      cards: [],
    });
    const first = await apiWorker.fetch(
      new Request(`https://card-keepr.invalid/v1/${collection}?game=one-piece&limit=1`, {
        headers: apiHeaders(`collection-etag-${collection}-1`),
      }),
      testEnv,
    );
    expect(first.status).toBe(200);
    const second = await apiWorker.fetch(
      new Request(`https://card-keepr.invalid/v1/${collection}?limit=1&game=one-piece`, {
        headers: { ...apiHeaders(`collection-etag-${collection}-2`), "if-none-match": first.headers.get("etag")! },
      }),
      testEnv,
    );
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    for (const validator of [`*, ${first.headers.get("etag")}`, `"different", *`, `${first.headers.get("etag")},`]) {
      const malformed = await apiWorker.fetch(
        new Request(`https://card-keepr.invalid/v1/${collection}?limit=1&game=one-piece`, {
          headers: { ...apiHeaders(`collection-etag-${collection}-malformed`), "if-none-match": validator },
        }),
        testEnv,
      );
      expect(malformed.status).toBe(200);
    }
    const reordered = await apiWorker.fetch(
      new Request(`https://card-keepr.invalid/v1/${collection}?limit=1&game=one-piece`, {
        headers: apiHeaders(`collection-etag-${collection}-body`),
      }),
      testEnv,
    );
    expect(await reordered.text()).toBe(await first.text());
  },
);

test("Card filters reject overlong identities through the HTTP contract", async () => {
  const response = await apiWorker.fetch(
    new Request(`https://card-keepr.invalid/v1/cards?card_number=${"a".repeat(501)}`, {
      headers: apiHeaders("collection-long-card-number"),
    }),
    testEnv,
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: "invalid_parameter" });
});

test.each(["cards", "printings", "products", "catalogue-exports"])(
  "%s rejects repeated pagination parameters through the HTTP contract",
  async (collection) => {
    for (const query of ["limit=1&limit=1", "after=x&after=x"]) {
      const response = await apiWorker.fetch(
        new Request(`https://card-keepr.invalid/v1/${collection}?${query}`, {
          headers: apiHeaders(`collection-repeat-${collection}-${query}`),
        }),
        testEnv,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "invalid_parameter",
      });
    }
  },
);

test.each(["cards", "printings", "products", "catalogue-exports"])(
  "%s rejects noncanonical page limits through the HTTP contract",
  async (collection) => {
    for (const limit of ["050", "1e2", "50.0", "0", "101"]) {
      const response = await apiWorker.fetch(
        new Request(`https://card-keepr.invalid/v1/${collection}?limit=${limit}`, {
          headers: apiHeaders(`collection-limit-${collection}-${limit}`),
        }),
        testEnv,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_parameter" });
    }
  },
);
