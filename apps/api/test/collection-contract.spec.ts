import { expect, test } from "vitest";
import apiWorker from "../src/index";
import { apiHeaders, installApiSuite, seedApiRevision, testEnv } from "./api-fixtures";

installApiSuite();

test.each(["cards", "printings", "products"])(
  "%s requires an available current query projection before returning a page or 304",
  async (collection) => {
    const revisionId = `catrev_collection_unavailable_${collection}`;
    await seedApiRevision({ revisionId, runId: `run_collection_unavailable_${collection}`, cards: [] });
    const url = `https://card-keepr.invalid/v1/${collection}`;
    const first = await apiWorker.fetch(new Request(url, { headers: apiHeaders(`${collection}-available`) }), testEnv);
    expect(first.status).toBe(200);
    await testEnv.CATALOGUE_DB.prepare(
      "UPDATE catalogue_query_revisions SET state = 'pending' WHERE catalogue_revision_id = ?",
    )
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
    for (const validator of [`*, ${first.headers.get("etag")}`, `${first.headers.get("etag")},`]) {
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
