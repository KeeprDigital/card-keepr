import { exports } from "cloudflare:workers";
import { expect, test } from "vitest";
import { apiCard, apiHeaders, installApiSuite, seedApiRevision, testEnv } from "./api-fixtures";
import { dropObsoleteCardSearchTerms } from "../../ingestion/test/query-helpers/card-search";

installApiSuite();

test("short literal Card searches survive removal of gram rows and keep cursor revision and ordering", async () => {
  await seedApiRevision({
    revisionId: "catrev_short_search",
    runId: "run_short_search",
    cards: [
      apiCard({ id: "card_short_first", cardNumber: "OP01-001", name: "Quartz First" }),
      apiCard({ id: "card_short_second", cardNumber: "OP01-002", name: "Quartz Second" }),
      apiCard({ id: "card_short_other", cardNumber: "OP01-003", name: "Ordinary" }),
      apiCard({ id: "card_short_unicode", cardNumber: "OP01-004", name: "Éclair" }),
    ],
  });
  await dropObsoleteCardSearchTerms(testEnv.CATALOGUE_DB).run();
  for (const query of ["q=Q", "q=qu", "q=ＱＵ&game=one-piece"]) {
    const response = await api(query);
    expect(response.status).toBe(200);
    const body = await response.json<{ data: { id: string }[] }>();
    expect(body.data.map(({ id }) => id)).toEqual(["card_short_first", "card_short_second"]);
  }
  const exact = await api("q=qu&game=one-piece&card_number=OP01-002");
  await expect(exact.json()).resolves.toMatchObject({ data: [{ id: "card_short_second" }] });
  const unicode = await api("q=E%CC%81");
  await expect(unicode.json()).resolves.toMatchObject({ data: [{ id: "card_short_unicode" }] });
  const absent = await api("q=zx");
  await expect(absent.json()).resolves.toMatchObject({ data: [] });
  const first = await (await api("q=qu&limit=1")).json<{ data: { id: string }[]; page: { next_cursor: string } }>();
  expect(first.data.map(({ id }) => id)).toEqual(["card_short_first"]);
  await seedApiRevision({
    revisionId: "catrev_short_new",
    runId: "run_short_new",
    cards: [apiCard({ id: "card_short_new", cardNumber: "OP02-001", name: "Quartz New" })],
  });
  const next = await api(`q=qu&limit=1&after=${first.page.next_cursor}`);
  expect(next.headers.get("x-catalogue-revision")).toBe("catrev_short_search");
  await expect(next.json()).resolves.toMatchObject({
    data: [{ id: "card_short_second" }],
    page: { next_cursor: null },
  });
});

function api(query: string): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://card-keepr.invalid/v1/cards?${query}`, { headers: apiHeaders("203.0.113.199") }),
  );
}
