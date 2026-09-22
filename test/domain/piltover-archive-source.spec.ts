import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { requiredSourceAdapter } from "../../src/catalogue/adapters/source-adapters";
import { parseSourceAdmissionEvidence } from "../../src/catalogue/reconciliation/source-admission-evidence";
import { parseReconciliationObservation } from "../../src/catalogue/reconciliation/reconciliation-observation";
import { AdapterParseFailure } from "../../src/catalogue/adapters/adapter-parse-failure";
import { parsePiltoverGalleryPage } from "../../src/catalogue/adapters/piltover-archive-gallery";
import { piltoverPinnedObservation } from "../../src/catalogue/adapters/piltover-archive-evidence";
import { syntheticPiltoverGalleryPage } from "../support/synthetic-flight-pages.mjs";

const fixture = "acceptance/fixtures/real-sources/2026-09-21-piltover-archive/raw/";
const gallery = "https://piltoverarchive.com/cards";
const context = { url: gallery, mediaType: "text/html; charset=utf-8" };
const arcImage = "https://piltoverarchive.b-cdn.net/temporary/1760416626325-f3zxpz5s8g7.webp";
const ognImage = "https://cdn.piltoverarchive.com/cards/OGN-001.webp";

test("Piltover Archive reads the retained gallery render without claiming the inventory", () => {
  const page = parsePiltoverGalleryPage(readFileSync(`${fixture}gallery-page-1.html`, "utf8"), gallery);
  expect([page.page, page.pages, page.total, page.rows.length]).toEqual([1, 26, "1,240", 48]);
  expect(new Set(page.rows.map((row) => row.source_key)).size).toBe(48);
  const vi = page.rows.filter((row) => row.card.name === "Vi, Destructive");
  expect(vi.map((row) => [row.variant_number, row.variant_type, row.foil_mode, row.card.id])).toEqual([
    ["ARC-001", "Promo", "foil_only", "4a10b30f-22fa-4e09-803b-a375e361a905"],
    ["OGN-036", "Standard", "foil_only", "4a10b30f-22fa-4e09-803b-a375e361a905"],
  ]);
  expect(page.rows.find((row) => row.variant_number === "OGN-001")?.record).toMatchObject({
    artist: "Envar Studios",
    card: { power: 0, mightBonus: 0, tags: ["Noxus", "Dragon"] },
  });
  for (const outside of [`${gallery}?page=2`, `${gallery}?sort=name`, "https://piltoverarchive.com/news"])
    expect(() => parsePiltoverGalleryPage(readFileSync(`${fixture}gallery-page-1.html`, "utf8"), outside)).toThrow(
      AdapterParseFailure,
    );
});

test("Piltover Archive selects only the two pinned records and their own front art", async () => {
  const adapter = requiredSourceAdapter("piltover-archive-en@1");
  const bytes = readFileSync(`${fixture}gallery-page-1.html`);
  const values = (await adapter.parseBytes!(bytes, context)) as Record<string, unknown>[];
  expect(values).toHaveLength(2);
  expect(adapter.discoverRequests!(bytes, context)).toEqual([
    { role: "image", url: arcImage, headers: { accept: "image/webp,image/png" } },
    { role: "image", url: ognImage, headers: { accept: "image/webp,image/png" } },
  ]);
  expect(adapter.printingAdmission).toBe("owner_review");
  expect(adapter.requestCapacity).toBe(1_400);
  expect(
    await adapter.parseBytes!(readFileSync(`${fixture}ogn-001-blazing-scorcher.webp`), {
      url: ognImage,
      mediaType: "image/webp",
    }),
  ).toEqual([]);
});

test("Blazing Scorcher maps its evidenced Riot overlap with the Piltover front as separate evidence", async () => {
  const adapter = requiredSourceAdapter("piltover-archive-en@1");
  const values = await adapter.parseBytes!(readFileSync(`${fixture}gallery-page-1.html`), context);
  const overlap = values.find((value) => typeof value === "object" && value !== null && "card" in value);
  const parsed = parseReconciliationObservation("retained-blazing-scorcher", overlap);
  expect(parsed).toMatchObject({
    kind: "card_printing",
    locator: "15eb5d43-3264-410f-9ba7-2dba0b3a185d",
    artworkFingerprint: 'official-artwork:{"official_card_identity":"OGN-001/298","roles":["front"],"artwork_id":null}',
    observedCardAndPrinting: {
      card: {
        name: "Blazing Scorcher",
        category: "gameplay",
        official_identity: { kind: "publisher_name", value: "Blazing Scorcher" },
        effective_rules_text:
          "[Accelerate] (You may pay :rb_energy_1::rb_rune_fury: as an additional cost to have me enter ready.)",
        game_data: {
          profile: "riftbound@1",
          attributes: { card_types: ["unit"], domains: ["fury"], energy: 5, power: null, might: 5, might_bonus: null },
        },
      },
      printing: {
        rarity: { raw: "Common", normalized: "common" },
        printed_rules_text: null,
        game_data: {
          attributes: { public_code: "OGN-001/298", set_code: "OGN", finish: null, artists: ["Envar Studio"] },
        },
      },
    },
  });
  expect(parsed.kind === "card_printing" && parsed.observedCardAndPrinting.card?.game_data.attributes.tags).toEqual([
    "Dragon",
    "Noxus",
  ]);
  const image = (overlap as unknown as { appearance_evidence: { images: Record<string, unknown>[] } })
    .appearance_evidence.images[0];
  expect(image).toMatchObject({
    role: "front",
    source_url: ognImage,
    content_sha256: "8c1510496db79e46e165c262316884ae155d8d1a38d09b80a5f2cfb85b185405",
  });
});

test("Vi ARC-001 stays an unresolved supplementary record with a private source-record front", async () => {
  const adapter = requiredSourceAdapter("piltover-archive-en@1");
  const values = await adapter.parseBytes!(readFileSync(`${fixture}gallery-page-1.html`), context);
  const lead = values.find((value) => typeof value === "object" && value !== null && !("card" in value));
  const review = parseSourceAdmissionEvidence(lead, adapter);
  expect(review).toEqual(lead);
  expect(review).toMatchObject({
    game: "riftbound",
    source_lineage: "piltover-archive-en",
    locator: "a60d2063-be1a-4ee5-a745-784eef4ed8b1",
    source_membership: { set_id: "ARC", local_id: "ARC-001" },
    target: { kind: "unresolved_record" },
  });
  expect(review.issues.map((issue) => issue.code)).toEqual([
    "printing_locale_unresolved",
    "printing_treatment_unresolved",
    "physical_issuance_unresolved",
  ]);
  expect(review.appearance_evidence.images).toEqual([
    {
      association: "source_record",
      role: "front",
      source_url: arcImage,
      artwork_fingerprint:
        "piltover-archive-en:source-record-image:b96e5881f9ca253550bf2aa124189a32097c3a5caf28adcbb18433f505c2a4df",
      content_sha256: "b96e5881f9ca253550bf2aa124189a32097c3a5caf28adcbb18433f505c2a4df",
    },
  ]);
  const record = JSON.parse(review.source_sidecar.source_record_json);
  expect(record).toMatchObject({
    variantNumber: "ARC-001",
    foilMode: "foil_only",
    variantLabel: "Arcane Box Promo",
    card: { id: "4a10b30f-22fa-4e09-803b-a375e361a905", super: "Champion" },
    gallery_page: { page: 1, pages: 26, rows: 48, total: "1,240" },
  });
  expect(review).not.toHaveProperty("card");
  expect(review).not.toHaveProperty("printing");
});

test("Piltover Archive fails closed when a pinned record no longer fits its retained qualification", () => {
  const page = parsePiltoverGalleryPage(readFileSync(`${fixture}gallery-page-1.html`, "utf8"), gallery);
  const overlap = page.rows.find((row) => row.variant_number === "OGN-001")!;
  expect(
    piltoverPinnedObservation(
      page.rows.find((row) => row.variant_number === "OGN-002")!,
      page,
    ),
  ).toBeNull();
  expect(() =>
    piltoverPinnedObservation({ ...overlap, card: { ...overlap.card, description: "changed wording" } }, page),
  ).toThrow(AdapterParseFailure);
  expect(() => piltoverPinnedObservation({ ...overlap, artist: "Someone Else" }, page)).toThrow(AdapterParseFailure);
  expect(piltoverPinnedObservation({ ...overlap, release_date: "2030-01-01" }, page)).not.toBeNull();
});

describe("Piltover Archive gallery census", () => {
  const census = (page: number) => `${gallery}?page=${page}`;
  const page1Bytes = readFileSync(`${fixture}gallery-page-1.html`);
  const page1 = parsePiltoverGalleryPage(page1Bytes.toString("utf8"), census(1));
  const records = page1.rows.map((row) => row.record);
  const parent = {
    requestId: "piltover-archive-en:gallery-census",
    snapshotId: "snapshot-page-1",
    role: "listing",
    url: census(1),
    mediaType: "text/html; charset=utf-8",
    retrievedAt: "2026-09-21T06:52:00.000Z",
    contentSha256: "retained",
    bytes: page1Bytes,
  };
  const synthetic = (page: number, variants = records, pages = 26, total = 1_240) =>
    new TextEncoder().encode(syntheticPiltoverGalleryPage({ page, pages, total, variants }));

  test("page 1 retains every row and discovers every reported page and front", async () => {
    const adapter = requiredSourceAdapter("piltover-archive-en@1");
    const context = { url: census(1), mediaType: "text/html; charset=utf-8" };
    const values = (await adapter.parseBytes!(page1Bytes, context)) as Record<string, unknown>[];
    expect(values).toHaveLength(48);
    // 47 review records and the one qualified Blazing Scorcher overlap.
    expect(values.filter((value) => value.observation_type === "source_admission_evidence")).toHaveLength(47);
    for (const value of values.filter((entry) => entry.observation_type === "source_admission_evidence"))
      expect(parseSourceAdmissionEvidence(value, adapter)).toEqual(value);
    const requests = adapter.discoverRequests!(page1Bytes, context);
    expect(requests.filter((request) => request.role === "listing").map((request) => request.url)).toEqual(
      Array.from({ length: 25 }, (_, index) => census(index + 2)),
    );
    const images = requests.filter((request) => request.role === "image").map((request) => request.url);
    expect(images).toHaveLength(48);
    expect(new Set(images).size).toBe(48);
    expect(images).toEqual(expect.arrayContaining([ognImage, arcImage]));
    expect(adapter.requestCapacity).toBe(1_400);
    expect(adapter.hostPacing?.map((policy) => [policy.hostname, policy.kind, policy.maximumConcurrency])).toEqual([
      ["piltoverarchive.com", "page", 1],
      ["cdn.piltoverarchive.com", "asset", 4],
      ["piltoverarchive.b-cdn.net", "asset", 4],
    ]);
  });

  test("census rows state their unresolved identity, treatment, issuance and locale", async () => {
    const adapter = requiredSourceAdapter("piltover-archive-en@1");
    const values = (await adapter.parseBytes!(page1Bytes, { url: census(1), mediaType: "text/html" })) as {
      locator: string;
      source_membership?: { local_id: string };
      issues?: { code: string }[];
      appearance_evidence: { images: Record<string, unknown>[] };
      source_sidecar: { source_record_json: string };
    }[];
    const byNumber = new Map(
      values.filter((value) => value.source_membership).map((value) => [value.source_membership!.local_id, value]),
    );
    const codes = (number: string) => byNumber.get(number)!.issues!.map((issue) => issue.code);
    expect(codes("OGN-002")).toEqual(["card_identity_unresolved", "printing_locale_unresolved"]);
    expect(codes("OGN-007a")).toEqual([
      "card_identity_unresolved",
      "printing_treatment_unresolved",
      "printing_locale_unresolved",
    ]);
    for (const number of ["ARC-001", "ARC-002", "OGN-007b"])
      expect(codes(number)).toEqual([
        "printing_locale_unresolved",
        "printing_treatment_unresolved",
        "physical_issuance_unresolved",
      ]);
    expect(values.filter((value) => "card" in value)).toEqual([
      expect.objectContaining({
        identity_evidence: expect.objectContaining({ locator: "15eb5d43-3264-410f-9ba7-2dba0b3a185d" }),
      }),
    ]);
    const review = byNumber.get("OGN-002")!;
    expect(review.appearance_evidence.images).toEqual([
      expect.objectContaining({
        association: "source_record",
        role: "front",
        source_url: "https://cdn.piltoverarchive.com/cards/OGN-002.webp",
      }),
    ]);
    expect(review.appearance_evidence.images[0]).not.toHaveProperty("content_sha256");
    expect(JSON.parse(review.source_sidecar.source_record_json)).toMatchObject({
      variantNumber: "OGN-002",
      gallery_page: { page: 1, pages: 26, total: "1,240", rows: 48 },
    });
  });

  test("later pages must match page 1's pagination, total and page size", async () => {
    const adapter = requiredSourceAdapter("piltover-archive-en@1");
    const parse = async (bytes: Uint8Array, page: number, parents: (typeof parent)[] | undefined = [parent]) =>
      adapter.parseBytes!(bytes, { url: census(page), mediaType: "text/html", parents });
    expect(await parse(synthetic(2), 2)).toHaveLength(48);
    expect(
      adapter.discoverRequests!(synthetic(2), { url: census(2), mediaType: "text/html", parents: [parent] }).every(
        (request) => request.role === "image",
      ),
    ).toBe(true);
    expect(await parse(synthetic(26, records.slice(0, 40)), 26)).toHaveLength(40);
    const drifted: [Uint8Array, number, (typeof parent)[] | undefined][] = [
      [synthetic(2), 2, []],
      [synthetic(2, records, 27), 2, [parent]],
      [synthetic(2, records, 26, 1_241), 2, [parent]],
      [synthetic(2, records.slice(1)), 2, [parent]],
      [synthetic(26, records.slice(0, 41)), 26, [parent]],
    ];
    for (const [index, [bytes, page, parents]] of drifted.entries())
      await expect(parse(bytes, page, parents), `drift case ${index}`).rejects.toThrow(AdapterParseFailure);
    await expect(parse(synthetic(1, records, 61, 2_928), 1, undefined)).rejects.toThrow(AdapterParseFailure);
  });

  test("a pinned row that no longer fits is retained as a census review, while the pilot fails closed", async () => {
    const adapter = requiredSourceAdapter("piltover-archive-en@1");
    const changed = records.map((record) =>
      record.variantNumber === "OGN-001" ? { ...record, artist: "Someone Else" } : record,
    );
    const values = (await adapter.parseBytes!(synthetic(1, changed), {
      url: census(1),
      mediaType: "text/html",
    })) as { locator: string; source_sidecar: { source_record_json: string } }[];
    const overlap = values.find((value) => value.locator === "15eb5d43-3264-410f-9ba7-2dba0b3a185d")!;
    expect(overlap).not.toHaveProperty("card");
    expect(JSON.parse(overlap.source_sidecar.source_record_json).pinned_qualification).toBe("changed");
    await expect(
      Promise.resolve().then(() =>
        adapter.parseBytes!(synthetic(1, changed), { url: gallery, mediaType: "text/html" }),
      ),
    ).rejects.toThrow(AdapterParseFailure);
  });
});
