import type { RiftboundSupplementarySourceAdmissionEvidenceObservation } from "./adapter-observations";
import { AdapterParseFailure } from "./adapter-parse-failure";
import type { HexdeckListing, HexdeckSearchPage } from "./hexdeck-gallery";

// #332 pinned qualifications. Each selected listing is compared, field by
// field, with the exact retained rendering; a changed listing no longer fits
// and fails closed. HexDeck's listing surface carries no rules text, artist,
// finish or locale, so no listing maps into the shared profile: every pinned
// row stays a retained review record with its own front, and the complete
// source record stays in the sidecar. Nothing here allocates an entity.

export const hexdeckLineage = "hexdeck-en" as const;
export const hexdeckPinnedRowKeys = {
  blazingScorcher: "cmpmw79dv00wuqg6x47fpe8yb",
  buffToken: "cmpmw7kdx016hqg6xq59srhe8",
} as const;

type PinnedFields = Omit<HexdeckListing, "record">;
type PinnedImage = Readonly<{ url: string; sha256: string }>;

const blazingScorcherImage: PinnedImage = {
  url: "https://imagedelivery.net/hLYQStpAJ2Sj9NgyRRqPTQ/3c5370d6-4818-4270-041a-7590b83f8d00/standard",
  sha256: "f0655cf3301d0778b42245b27b648f9c4a49b5db9f3e71a9ae5919a6a0a72119",
};
const buffTokenImage: PinnedImage = {
  url: "https://imagedelivery.net/hLYQStpAJ2Sj9NgyRRqPTQ/8d1fe662-832a-4378-f580-1b643d064800/standard",
  sha256: "58da926e840907f0907f5858beecd27019c8274551b8282116f36d1c1a19f0c7",
};

const pinned: Readonly<Record<string, { fields: PinnedFields; image: PinnedImage }>> = {
  [hexdeckPinnedRowKeys.blazingScorcher]: {
    fields: {
      source_key: hexdeckPinnedRowKeys.blazingScorcher,
      name: "Blazing Scorcher",
      set_tag: "OGN",
      set_number: "001",
      rarity: "Common",
      energy: 5,
      might: 5,
      power: 0,
      might_bonus: null,
      image_url: "https://imagedelivery.net/hLYQStpAJ2Sj9NgyRRqPTQ/3c5370d6-4818-4270-041a-7590b83f8d00/",
      art_url: blazingScorcherImage.url,
      domains: ["Fury"],
      types: ["Unit"],
      supertypes: [],
      search_tags: [],
    },
    image: blazingScorcherImage,
  },
  // Riot lists Buff as UNL-T04 and Riftbound DB retains a PR promo Buff; HexDeck
  // files it under OGN T01. The token has no domain, type, energy or power.
  [hexdeckPinnedRowKeys.buffToken]: {
    fields: {
      source_key: hexdeckPinnedRowKeys.buffToken,
      name: "Buff",
      set_tag: "OGN",
      set_number: "T01",
      rarity: "Common",
      energy: null,
      might: 1,
      power: null,
      might_bonus: null,
      image_url: "https://imagedelivery.net/hLYQStpAJ2Sj9NgyRRqPTQ/8d1fe662-832a-4378-f580-1b643d064800/",
      art_url: buffTokenImage.url,
      domains: [],
      types: [],
      supertypes: ["Token"],
      search_tags: [],
    },
    image: buffTokenImage,
  },
};

function pinnedFields(row: HexdeckListing): PinnedFields {
  const { record: _record, ...rest } = row;
  return rest;
}

/** The retained review record for a pinned listing, or null for an unselected row. */
export function hexdeckPinnedObservation(
  row: HexdeckListing,
  page: HexdeckSearchPage,
): RiftboundSupplementarySourceAdmissionEvidenceObservation | null {
  const selected = pinned[row.source_key];
  if (selected === undefined) return null;
  if (JSON.stringify(pinnedFields(row)) !== JSON.stringify(selected.fields))
    throw new AdapterParseFailure(`HexDeck listing ${row.source_key} no longer fits its retained qualification.`);
  const fingerprint = `${hexdeckLineage}:source-record-image:${selected.image.sha256}`;
  return {
    observation_type: "source_admission_evidence",
    game: "riftbound",
    source_lineage: hexdeckLineage,
    locator: row.source_key,
    source_membership: { set_id: row.set_tag, local_id: row.set_number },
    target: { kind: "unresolved_record" },
    issues: [
      { code: "card_facts_incomplete", source_paths: ["searchTags", "name"] },
      { code: "printing_treatment_unresolved", source_paths: ["rarity", "imageUrl"] },
      { code: "physical_issuance_unresolved", source_paths: ["setTag", "setNumber"] },
    ],
    appearance_evidence: {
      images: [
        {
          association: "source_record",
          role: "front",
          source_url: selected.image.url,
          artwork_fingerprint: fingerprint,
          content_sha256: selected.image.sha256,
        },
      ],
    },
    source_sidecar: {
      source_record_json: JSON.stringify({
        ...row.record,
        search_page: {
          url: page.url,
          display_format: page.display_format,
          sort_field: page.sort_field,
          sort_direction: page.sort_direction,
          current_page: page.current_page,
          page_size: page.page_size,
          total_count: page.total_count,
          rows: page.rows.length,
        },
      }),
    },
    completeness: {
      structurally_complete: true,
      required_surfaces_complete: true,
      partitions_complete: true,
      declared_record_count: 1,
      parsed_record_count: 1,
    },
  };
}

/** Only a pinned listing's own front art, from HexDeck's observed delivery host, is fetched. */
export function hexdeckPinnedImageRequest(row: HexdeckListing) {
  if (pinned[row.source_key] === undefined || row.art_url === null) return null;
  const url = new URL(row.art_url);
  if (url.hostname !== "imagedelivery.net" || url.search || url.hash)
    throw new AdapterParseFailure("HexDeck art locator is outside its observed delivery host.");
  return { role: "image" as const, url: url.href, headers: { accept: "image/webp,image/png,image/jpeg" } };
}
