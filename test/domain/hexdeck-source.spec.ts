import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { requiredSourceAdapter } from "../../src/catalogue/adapters/source-adapters";
import { parseSourceAdmissionEvidence } from "../../src/catalogue/reconciliation/source-admission-evidence";
import { AdapterParseFailure } from "../../src/catalogue/adapters/adapter-parse-failure";
import { parseHexdeckSearchPage } from "../../src/catalogue/adapters/hexdeck-gallery";
import { hexdeckPinnedObservation } from "../../src/catalogue/adapters/hexdeck-evidence";
import { syntheticHexdeckSearchPage } from "../support/synthetic-flight-pages.mjs";

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
  expect(adapter.requestCapacity).toBe(1_100);
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

describe("HexDeck search census", () => {
  const census = (page: number) =>
    `https://www.hexdeck.io/cards?displayFormat=Images&page=${page}&sortField=Set&sortDirection=Ascending`;
  const retained = (page: number) => readFileSync(`${fixture}search-set-page-${page}.html`);
  const first = parseHexdeckSearchPage(retained(1).toString("utf8"), census(1));
  const parent = {
    requestId: "hexdeck-en:search-census",
    snapshotId: "snapshot-page-1",
    role: "listing",
    url: census(1),
    mediaType: "text/html; charset=utf-8",
    retrievedAt: "2026-09-21T07:08:00.000Z",
    contentSha256: "retained",
    bytes: retained(1),
  };
  const synthetic = (page: number, results = first.rows.map((row) => row.record), totalCount = 940, pageSize = 50) =>
    new TextEncoder().encode(
      syntheticHexdeckSearchPage({ page, pageSize, totalCount, results: results as { imageUrl: string }[] }),
    );
  const parse = async (bytes: Uint8Array, page: number, parents: (typeof parent)[] = [parent]) =>
    requiredSourceAdapter("hexdeck-en@1").parseBytes!(bytes, { ...html, url: census(page), parents });

  test("the retained page 1 discovers every implied page and every page-referenced front", async () => {
    const adapter = requiredSourceAdapter("hexdeck-en@1");
    const context = { ...html, url: census(1) };
    const values = (await adapter.parseBytes!(retained(1), context)) as Record<string, unknown>[];
    expect(values).toHaveLength(50);
    for (const value of values) expect(parseSourceAdmissionEvidence(value, adapter)).toEqual(value);
    const requests = adapter.discoverRequests!(retained(1), context);
    expect(requests.filter((request) => request.role === "listing").map((request) => request.url)).toEqual(
      Array.from({ length: 18 }, (_, index) => census(index + 2)),
    );
    const images = requests.filter((request) => request.role === "image").map((request) => request.url);
    expect(new Set(images).size).toBe(images.length);
    expect(images).toContain(blazingArt);
    expect(images.every((url) => url.startsWith("https://imagedelivery.net/") && url.endsWith("/standard"))).toBe(true);
    expect(adapter.hostPacing?.map((policy) => [policy.hostname, policy.kind, policy.maximumConcurrency])).toEqual([
      ["www.hexdeck.io", "page", 1],
      ["imagedelivery.net", "asset", 4],
    ]);
  });

  test("retained pages 7 and 8 are census pages of the same dated search", async () => {
    const seventh = (await parse(retained(7), 7)) as {
      source_membership: { set_id: string; local_id: string };
      issues: { code: string }[];
      source_sidecar: { source_record_json: string };
    }[];
    expect(seventh).toHaveLength(50);
    expect(seventh.map((value) => value.source_membership.local_id)).toContain("T01");
    expect(await parse(retained(8), 8)).toHaveLength(50);
    const firestorm = ((await parse(retained(1), 1, [])) as typeof seventh).find(
      (value) => JSON.parse(value.source_sidecar.source_record_json).name === "Firestorm",
    )!;
    expect(firestorm.issues.map((issue) => issue.code)).toEqual([
      "card_facts_incomplete",
      "printing_treatment_unresolved",
      "physical_issuance_unresolved",
    ]);
    expect(JSON.parse(firestorm.source_sidecar.source_record_json).search_page).toMatchObject({
      url: census(1),
      current_page: 1,
      total_count: 940,
    });
  });

  test("later pages must match page 1 and carry their implied row count", async () => {
    const rows = first.rows.map((row) => row.record);
    expect(await parse(synthetic(19, rows.slice(0, 40)), 19)).toHaveLength(40);
    const drifted: [Uint8Array, number, (typeof parent)[]][] = [
      [retained(7), 7, []],
      [synthetic(2, rows, 941), 2, [parent]],
      [synthetic(2, rows.slice(0, 49)), 2, [parent]],
      [synthetic(19, rows.slice(0, 41)), 19, [parent]],
      [synthetic(20, rows.slice(0, 1)), 20, [parent]],
    ];
    for (const [index, [bytes, page, parents]] of drifted.entries())
      await expect(parse(bytes, page, parents), `drift case ${index}`).rejects.toThrow(AdapterParseFailure);
    await expect(parse(synthetic(1, rows, 3_050), 1, [])).rejects.toThrow(AdapterParseFailure);
    // The pilot request form is never a census page.
    await expect(
      Promise.resolve().then(() =>
        requiredSourceAdapter("hexdeck-en@1").parseBytes!(retained(8), { ...html, url: search(8) }),
      ),
    ).rejects.toThrow(AdapterParseFailure);
  });

  test("a pinned listing that no longer fits is retained as a census review, while the pilot fails closed", async () => {
    const changed = first.rows.map((row) =>
      row.source_key === "cmpmw79dv00wuqg6x47fpe8yb" ? { ...row.record, power: 1 } : row.record,
    );
    const values = (await parse(synthetic(1, changed), 1, [])) as {
      locator: string;
      appearance_evidence: { images: Record<string, unknown>[] };
      source_sidecar: { source_record_json: string };
    }[];
    const blazing = values.find((value) => value.locator === "cmpmw79dv00wuqg6x47fpe8yb")!;
    expect(JSON.parse(blazing.source_sidecar.source_record_json).pinned_qualification).toBe("changed");
    expect(blazing.appearance_evidence.images[0]).not.toHaveProperty("content_sha256");
    await expect(
      Promise.resolve().then(() =>
        requiredSourceAdapter("hexdeck-en@1").parseBytes!(synthetic(1, changed), { ...html, url: search(1) }),
      ),
    ).rejects.toThrow(AdapterParseFailure);
  });
});
