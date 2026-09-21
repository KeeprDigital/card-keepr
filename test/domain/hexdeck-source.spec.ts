import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { requiredSourceAdapter } from "../../src/catalogue/adapters/source-adapters";
import { parseSourceAdmissionEvidence } from "../../src/catalogue/reconciliation/source-admission-evidence";
import { AdapterParseFailure } from "../../src/catalogue/adapters/adapter-parse-failure";
import { parseHexdeckSearchPage } from "../../src/catalogue/adapters/hexdeck-gallery";
import { hexdeckPinnedObservation } from "../../src/catalogue/adapters/hexdeck-evidence";

const fixture = "acceptance/fixtures/real-sources/2026-09-21-hexdeck/raw/";
const search = (page: number) =>
  `https://www.hexdeck.io/cards?displayFormat=Images&page=${page}&sortDirection=Ascending&sortField=Set`;
const html = { mediaType: "text/html; charset=utf-8" };
const blazingArt = "https://imagedelivery.net/hLYQStpAJ2Sj9NgyRRqPTQ/3c5370d6-4818-4270-041a-7590b83f8d00/standard";
const buffArt = "https://imagedelivery.net/hLYQStpAJ2Sj9NgyRRqPTQ/8d1fe662-832a-4378-f580-1b643d064800/standard";

test("HexDeck reads the retained search renders without following or claiming the inventory", () => {
  const first = parseHexdeckSearchPage(readFileSync(`${fixture}search-set-page-1.html`, "utf8"), search(1));
  const seventh = parseHexdeckSearchPage(readFileSync(`${fixture}search-set-page-7.html`, "utf8"), search(7));
  expect([first.current_page, first.page_size, first.total_count, first.rows.length]).toEqual([1, 50, 940, 50]);
  expect([seventh.current_page, seventh.total_count, seventh.rows.length]).toEqual([7, 940, 50]);
  expect(new Set(first.rows.map((row) => row.set_tag))).toEqual(new Set(["OGS", "OGN"]));
  expect(seventh.rows.map((row) => row.set_tag).filter((tag, index, tags) => tags.indexOf(tag) === index)).toEqual([
    "OGN",
    "SFD",
  ]);
  const blazing = first.rows.find((row) => row.source_key === "cmpmw79dv00wuqg6x47fpe8yb")!;
  expect(blazing).toMatchObject({
    set_tag: "OGN",
    set_number: "001",
    power: 0,
    might_bonus: null,
    art_url: blazingArt,
  });
  expect(seventh.rows.find((row) => row.name === "Buff")).toMatchObject({
    set_tag: "OGN",
    set_number: "T01",
    supertypes: ["Token"],
    types: [],
    energy: null,
    art_url: buffArt,
  });
  // The page must carry a page mismatch, a foreign origin and a followed page closed.
  for (const outside of [search(2), "https://hexdeck.io/cards?page=1", "https://www.hexdeck.io/events?page=1"])
    expect(() => parseHexdeckSearchPage(readFileSync(`${fixture}search-set-page-1.html`, "utf8"), outside)).toThrow(
      AdapterParseFailure,
    );
});

test("HexDeck selects only the two pinned listings and their page-referenced fronts", async () => {
  const adapter = requiredSourceAdapter("hexdeck-en@1");
  const first = readFileSync(`${fixture}search-set-page-1.html`);
  const seventh = readFileSync(`${fixture}search-set-page-7.html`);
  expect(await adapter.parseBytes!(first, { ...html, url: search(1) })).toHaveLength(1);
  expect(await adapter.parseBytes!(seventh, { ...html, url: search(7) })).toHaveLength(1);
  expect(adapter.discoverRequests!(first, { ...html, url: search(1) })).toEqual([
    { role: "image", url: blazingArt, headers: { accept: "image/webp,image/png,image/jpeg" } },
  ]);
  expect(adapter.discoverRequests!(seventh, { ...html, url: search(7) })).toEqual([
    { role: "image", url: buffArt, headers: { accept: "image/webp,image/png,image/jpeg" } },
  ]);
  expect(adapter.printingAdmission).toBe("owner_review");
  expect(adapter.requestCapacity).toBe(4);
  expect(() => adapter.parseBytes!(first, { ...html, url: search(8) })).toThrow(AdapterParseFailure);
  expect(
    await adapter.parseBytes!(readFileSync(`${fixture}ogn-001-blazing-scorcher-standard.webp`), {
      url: blazingArt,
      mediaType: "image/webp",
    }),
  ).toEqual([]);
});

test("HexDeck listings stay unresolved review records because the surface carries no rules text or artist", async () => {
  const adapter = requiredSourceAdapter("hexdeck-en@1");
  const [blazing] = await adapter.parseBytes!(readFileSync(`${fixture}search-set-page-1.html`), {
    ...html,
    url: search(1),
  });
  const [buff] = await adapter.parseBytes!(readFileSync(`${fixture}search-set-page-7.html`), {
    ...html,
    url: search(7),
  });
  for (const value of [blazing, buff]) {
    const review = parseSourceAdmissionEvidence(value, adapter);
    expect(review).toEqual(value);
    expect(review).toMatchObject({
      game: "riftbound",
      source_lineage: "hexdeck-en",
      target: { kind: "unresolved_record" },
    });
    expect(review.issues.map((issue) => issue.code)).toEqual([
      "card_facts_incomplete",
      "printing_treatment_unresolved",
      "physical_issuance_unresolved",
    ]);
    expect(review).not.toHaveProperty("card");
    expect(review).not.toHaveProperty("printing");
  }
  const blazingReview = parseSourceAdmissionEvidence(blazing, adapter);
  expect(blazingReview).toMatchObject({ source_membership: { set_id: "OGN", local_id: "001" } });
  expect(blazingReview.appearance_evidence.images).toEqual([
    {
      association: "source_record",
      role: "front",
      source_url: blazingArt,
      artwork_fingerprint:
        "hexdeck-en:source-record-image:f0655cf3301d0778b42245b27b648f9c4a49b5db9f3e71a9ae5919a6a0a72119",
      content_sha256: "f0655cf3301d0778b42245b27b648f9c4a49b5db9f3e71a9ae5919a6a0a72119",
    },
  ]);
  const buffReview = parseSourceAdmissionEvidence(buff, adapter);
  expect(buffReview).toMatchObject({ source_membership: { set_id: "OGN", local_id: "T01" } });
  expect(buffReview.appearance_evidence.images[0]).toMatchObject({
    source_url: buffArt,
    content_sha256: "58da926e840907f0907f5858beecd27019c8274551b8282116f36d1c1a19f0c7",
  });
  expect(JSON.parse(buffReview.source_sidecar.source_record_json)).toMatchObject({
    uuid: "cmpmw7kdx016hqg6xq59srhe8",
    superTypes: [{ name: "Token" }],
    search_page: { current_page: 7, page_size: 50, total_count: 940, rows: 50 },
  });
});

test("HexDeck fails closed when a pinned listing no longer fits its retained qualification", () => {
  const page = parseHexdeckSearchPage(readFileSync(`${fixture}search-set-page-1.html`, "utf8"), search(1));
  const blazing = page.rows.find((row) => row.source_key === "cmpmw79dv00wuqg6x47fpe8yb")!;
  expect(
    hexdeckPinnedObservation(
      page.rows.find((row) => row.name === "Firestorm")!,
      page,
    ),
  ).toBeNull();
  expect(() => hexdeckPinnedObservation({ ...blazing, power: 1 }, page)).toThrow(AdapterParseFailure);
  expect(() => hexdeckPinnedObservation({ ...blazing, art_url: null }, page)).toThrow(AdapterParseFailure);
  expect(hexdeckPinnedObservation({ ...blazing, record: { ...blazing.record, extra: true } }, page)).not.toBeNull();
});
