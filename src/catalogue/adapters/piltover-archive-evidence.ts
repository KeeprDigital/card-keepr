import { createHash } from "node:crypto";
import type { RiftboundSupplementarySourceAdmissionEvidenceObservation } from "./adapter-observations";
import { AdapterParseFailure } from "./adapter-parse-failure";
import { officialArtworkFingerprint } from "./official-artwork-identity";
import type { PiltoverGalleryPage, PiltoverVariant } from "./piltover-archive-gallery";

// #330 pinned qualifications. Each selected variant record is compared, field
// by field, with the exact retained rendering that was inspected against the
// retained Riot record and the retained front image; a changed record no
// longer fits and fails closed. Only the Blazing Scorcher overlap maps into
// the shared profile: Piltover's keyword tokens ("[ACCELERATE]", "[1] [Fury]"),
// its zero Power and zero mightBonus for a unit without those printed values
// are renderings of the publisher wording that Riot serves as "[Accelerate]",
// ":rb_energy_1::rb_rune_fury:" and absent fields, so the mapped Card facts
// repeat the retained Riot wording for that one record. There is no general
// transformation rule; the complete source record stays in the sidecar, and
// nothing here allocates an entity.

export const piltoverArchiveLineage = "piltover-archive-en" as const;
export const piltoverPinnedRowKeys = {
  blazingScorcher: "15eb5d43-3264-410f-9ba7-2dba0b3a185d",
  viArcanePromo: "a60d2063-be1a-4ee5-a745-784eef4ed8b1",
} as const;

// Fields compared for the pin. Marketplace identifiers/prices, dates and
// Piltover's internal set/card identifiers are retained, not qualified.
type PinnedFields = Omit<PiltoverVariant, "record" | "release_date" | "set" | "card"> & {
  set: Pick<PiltoverVariant["set"], "name" | "prefix">;
  card: Omit<PiltoverVariant["card"], "id">;
};
type PinnedImage = Readonly<{ url: string; sha256: string }>;

const blazingScorcherImage: PinnedImage = {
  url: "https://cdn.piltoverarchive.com/cards/OGN-001.webp",
  sha256: "8c1510496db79e46e165c262316884ae155d8d1a38d09b80a5f2cfb85b185405",
};
const viArcanePromoImage: PinnedImage = {
  url: "https://piltoverarchive.b-cdn.net/temporary/1760416626325-f3zxpz5s8g7.webp",
  sha256: "b96e5881f9ca253550bf2aa124189a32097c3a5caf28adcbb18433f505c2a4df",
};

const pinnedFieldsByKey: Readonly<Record<string, PinnedFields>> = {
  [piltoverPinnedRowKeys.blazingScorcher]: {
    source_key: piltoverPinnedRowKeys.blazingScorcher,
    variant_number: "OGN-001",
    rarity: "Common",
    variant_type: "Standard",
    variant_types: ["Standard"],
    variant_label: "Standard",
    foil_mode: "both",
    image_url: blazingScorcherImage.url,
    flavor_text: null,
    artist: "Envar Studios",
    parent_variant_id: null,
    set: { name: "Origins", prefix: "OGN" },
    card: {
      name: "Blazing Scorcher",
      types: ["Unit"],
      type: "Unit",
      super: null,
      description: "[ACCELERATE] (You may pay [1] [Fury] as an additional cost to have me enter ready.)",
      energy: 5,
      might: 5,
      power: 0,
      tags: ["Noxus", "Dragon"],
      attach_text: null,
      effect: null,
      might_bonus: 0,
      colors: ["Fury"],
    },
  },
  [piltoverPinnedRowKeys.viArcanePromo]: {
    source_key: piltoverPinnedRowKeys.viArcanePromo,
    variant_number: "ARC-001",
    rarity: "Showcase",
    variant_type: "Promo",
    variant_types: ["Promo"],
    variant_label: "Arcane Box Promo",
    foil_mode: "foil_only",
    image_url: viArcanePromoImage.url,
    flavor_text: null,
    artist: "Fortiche Production",
    parent_variant_id: null,
    set: { name: "Arcane Box Set", prefix: "ARC" },
    card: {
      name: "Vi, Destructive",
      types: ["Unit"],
      type: "Unit",
      super: "Champion",
      description:
        "[GANKING] (I can move from battlefield to battlefield.)\nRecycle 1 from your trash: Give me +1 [Might] this turn.",
      energy: 2,
      might: 3,
      power: 1,
      tags: ["Vi", "Piltover"],
      attach_text: null,
      effect: null,
      might_bonus: 0,
      colors: ["Fury"],
    },
  },
};

function pinnedFields(row: PiltoverVariant): PinnedFields {
  const { record: _record, release_date: _date, set, card, ...rest } = row;
  const { id: _card, ...cardFields } = card;
  return { ...rest, set: { name: set.name, prefix: set.prefix }, card: cardFields };
}

function requirePinned(row: PiltoverVariant): PinnedFields | null {
  const expected = pinnedFieldsByKey[row.source_key];
  if (expected === undefined) return null;
  if (JSON.stringify(pinnedFields(row)) !== JSON.stringify(expected))
    throw new AdapterParseFailure(
      `Piltover Archive record ${row.source_key} no longer fits its retained qualification.`,
    );
  return expected;
}

/** Whether a record is pinned and, if so, still fits its retained qualification. */
export function piltoverPinnedStatus(row: PiltoverVariant): "unpinned" | "fits" | "changed" {
  const expected = pinnedFieldsByKey[row.source_key];
  if (expected === undefined) return "unpinned";
  return JSON.stringify(pinnedFields(row)) === JSON.stringify(expected) ? "fits" : "changed";
}

export function galleryPageSidecar(page: PiltoverGalleryPage) {
  return { url: page.url, page: page.page, pages: page.pages, rows: page.rows.length, total: page.total };
}

/** The retained Riot record ogn-001-298 (2026-09-08 pack, cards-0.json) establishes this overlap. */
function blazingScorcherObservation(row: PiltoverVariant, page: PiltoverGalleryPage) {
  const printingAttributes = {
    public_code: "OGN-001/298",
    collector_number: 1,
    set_code: "OGN",
    orientation: "portrait",
    reverse_face: null,
    finish: null,
    artists: ["Envar Studio"],
  };
  const fingerprint = officialArtworkFingerprint("OGN-001/298", ["front"], null);
  const ability =
    "[Accelerate] (You may pay :rb_energy_1::rb_rune_fury: as an additional cost to have me enter ready.)";
  return {
    completeness: {
      structurally_complete: true,
      required_surfaces_complete: true,
      partitions_complete: true,
      declared_record_count: 1,
      parsed_record_count: 1,
    },
    card: {
      game: "riftbound",
      category: "gameplay",
      official_identity: { kind: "publisher_name", value: "Blazing Scorcher" },
      name: "Blazing Scorcher",
      effective_rules_text: ability,
      game_data: {
        profile: "riftbound@1",
        attributes: {
          card_types: ["unit"],
          supertypes: [],
          domains: ["fury"],
          energy: 5,
          power: null,
          might: 5,
          might_bonus: null,
          tags: ["Dragon", "Noxus"],
          ability_text: ability,
          effect_text: null,
        },
      },
    },
    printing: {
      rarity: { raw: "Common", normalized: "common" },
      printed_rules_text: null,
      game_data: { profile: "riftbound@1", attributes: printingAttributes },
    },
    identity_evidence: {
      locator: row.source_key,
      variant_key: row.source_key,
      artwork_fingerprint: fingerprint,
      printed_fields_digest: createHash("sha256")
        .update(JSON.stringify({ printed_rules_text: null, ...printingAttributes }))
        .digest("hex"),
      treatment: null,
    },
    appearance_evidence: {
      images: [
        {
          role: "front",
          source_url: blazingScorcherImage.url,
          artwork_fingerprint: fingerprint,
          content_sha256: blazingScorcherImage.sha256,
        },
      ],
    },
    memberships: { products: [], distribution_contexts: [], source_buckets: ["OGN"] },
    product_release_catalogue: { products: [], distribution_contexts: [], relationships: [] },
    source_sidecar: {
      source_record_json: JSON.stringify(row.record),
      gallery_page: galleryPageSidecar(page),
      qualification:
        "Justified match to retained Riot ogn-001-298 / OGN-001/298 by displayed number, set, named Card, type, rarity, domain, tags, energy, Might, Accelerate wording, artist (Piltover spells the studio 'Envar Studios') and the retained English front showing 'OGN 001/298'. Piltover's Power 0 and mightBonus 0 correspond to Riot's absent fields; foilMode 'both' is a source claim, not a catalogued finish. The Piltover WebP is a separate asset from Riot's PNG; equal bytes were never assumed.",
      unmapped_optional_fields: [],
    },
  };
}

/** ARC-001 stays a supplementary lead: its retained front is a Chinese-language print. */
function viArcanePromoReview(
  row: PiltoverVariant,
  page: PiltoverGalleryPage,
): RiftboundSupplementarySourceAdmissionEvidenceObservation {
  return {
    observation_type: "source_admission_evidence",
    game: "riftbound",
    source_lineage: piltoverArchiveLineage,
    locator: row.source_key,
    source_membership: { set_id: "ARC", local_id: "ARC-001" },
    target: { kind: "unresolved_record" },
    issues: [
      { code: "printing_locale_unresolved", source_paths: ["imageUrl"] },
      { code: "printing_treatment_unresolved", source_paths: ["rarity", "variantType", "foilMode"] },
      { code: "physical_issuance_unresolved", source_paths: ["variantLabel", "releaseDate", "set.releaseDate"] },
    ],
    appearance_evidence: {
      images: [
        {
          association: "source_record",
          role: "front",
          source_url: viArcanePromoImage.url,
          artwork_fingerprint: `${piltoverArchiveLineage}:source-record-image:${viArcanePromoImage.sha256}`,
          content_sha256: viArcanePromoImage.sha256,
        },
      ],
    },
    // The review contract retains the exact source record only. Piltover keys
    // ARC-001 and OGN-036 to one card identifier and its English gallery text
    // matches Riot's ogn-036-298 wording, but the retained front depicts a
    // Chinese-language print marked "ARC-001/006": no English Printing is
    // evidenced, and "Showcase", "Promo" and foilMode "foil_only" stay labels.
    source_sidecar: { source_record_json: JSON.stringify({ ...row.record, gallery_page: galleryPageSidecar(page) }) },
    completeness: {
      structurally_complete: true,
      required_surfaces_complete: true,
      partitions_complete: true,
      declared_record_count: 1,
      parsed_record_count: 1,
    },
  };
}

/** The qualified observation for a pinned record, or null for an unselected row. */
export function piltoverPinnedObservation(row: PiltoverVariant, page: PiltoverGalleryPage) {
  if (requirePinned(row) === null) return null;
  return row.source_key === piltoverPinnedRowKeys.blazingScorcher
    ? blazingScorcherObservation(row, page)
    : viArcanePromoReview(row, page);
}

export const piltoverArtHosts: ReadonlySet<string> = new Set(["cdn.piltoverarchive.com", "piltoverarchive.b-cdn.net"]);
const artHosts = piltoverArtHosts;

/** Only a pinned record's own front art, from Piltover's two observed art hosts, is fetched. */
export function piltoverPinnedImageRequest(row: PiltoverVariant) {
  if (pinnedFieldsByKey[row.source_key] === undefined) return null;
  const url = new URL(row.image_url);
  if (!artHosts.has(url.hostname) || url.search || url.hash)
    throw new AdapterParseFailure("Piltover Archive art locator is outside its observed art hosts.");
  return { role: "image" as const, url: url.href, headers: { accept: "image/webp,image/png" } };
}
