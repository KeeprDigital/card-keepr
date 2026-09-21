import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { requiredSourceAdapter } from "../../src/catalogue/adapters/source-adapters";
import { parseSourceAdmissionEvidence } from "../../src/catalogue/reconciliation/source-admission-evidence";
import { parseReconciliationObservation } from "../../src/catalogue/reconciliation/reconciliation-observation";
import { AdapterParseFailure } from "../../src/catalogue/adapters/adapter-parse-failure";
import { parsePiltoverGalleryPage } from "../../src/catalogue/adapters/piltover-archive-gallery";
import { piltoverPinnedObservation } from "../../src/catalogue/adapters/piltover-archive-evidence";

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
  expect(adapter.requestCapacity).toBe(3);
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
