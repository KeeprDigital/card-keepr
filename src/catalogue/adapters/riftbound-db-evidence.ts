import { createHash } from "node:crypto";
import type { RiftboundSupplementarySourceAdmissionEvidenceObservation } from "./adapter-observations";
import { AdapterParseFailure } from "./adapter-parse-failure";
import { officialArtworkFingerprint } from "./official-artwork-identity";

export const riftboundDbLineage = "riftbound-db-en" as const;
export const riftboundDbOrigin = "https://www.riftbound-db.com";

type SourceImage = RiftboundSupplementarySourceAdmissionEvidenceObservation["appearance_evidence"]["images"][number];

// #331 retained front depictions. These pins qualify an image association only;
// OpenRift IDs and foil/distribution assertions never allocate canonical entities.
const promoImages: Readonly<Record<string, { url: string; sha256: string }>> = {
  "openrift-019da2ae-1077-772f-96d1-c880a9447bf7": {
    url: "https://openrift.app/media/cards/41/019da2bf-1d23-79df-991d-36cdf252d941-full.webp",
    sha256: "d11c91b510726e00859c8c11d110b652998c1f65cbad533806bfc227b27fdeb7",
  },
  "openrift-019e1fea-0113-7f38-b59d-23cab5997383": {
    url: "https://openrift.app/media/cards/8a/019e20c4-0813-72be-8016-7c91518c268a-full.webp",
    sha256: "7017a24aedbfefa54ada92f08b0a257b6b41fd7af1f2403ef0688bb055bc510b",
  },
  "openrift-019fc332-4e48-780f-950d-64756d280c23": {
    url: "https://openrift.app/media/cards/b4/019fc332-9ec0-75e9-90b3-76a19111f2b4-full.webp",
    sha256: "bce21dd660bd25858c9d06a678083b6f322ef87f733ccd94e543e5953293518a",
  },
};
export const eclipseHeraldSourceId = "69bc5bc9d308c64675ca86f6";
const eclipseOriginal =
  "https://cmsassets.rgpub.io/sanity/images/dsfx7636/game_data_live/bbe4fec278b8960681f97da658dc2f06ee46c4bd-744x1039.png";

export function riftboundDbPromoImages(card: Record<string, unknown>) {
  const selected = promoImages[String(card.id)];
  if (!selected || card.imageSourceUrl !== selected.url) return [];
  return [
    {
      association: "source_record" as const,
      role: "front" as const,
      source_url: selected.url,
      artwork_fingerprint: `riftbound-db-en:source-record-image:${selected.sha256}`,
      content_sha256: selected.sha256,
    },
  ];
}

export function riftboundDbEclipseObservation(card: Record<string, unknown>) {
  // This one inspected overlap is established by the retained Riot record and
  // front image, not a general transformation from Riftbound DB's display code.
  if (
    card.id !== eclipseHeraldSourceId ||
    card.name !== "Eclipse Herald" ||
    card.riftboundId !== "ogn-059-298" ||
    card.setCode !== "OGN" ||
    card.number !== "59" ||
    card.imageSourceUrl !== eclipseOriginal ||
    card.cardType !== "Unit" ||
    card.previewed !== false ||
    card.alternateArt !== false ||
    card.signature !== false ||
    card.orientation !== "portrait" ||
    card.artist !== "Kudos Productions" ||
    JSON.stringify(card.domain) !== '["Calm"]' ||
    !Array.isArray(card.tags) ||
    card.tags.some((tag) => typeof tag !== "string") ||
    typeof card.text !== "string" ||
    !card.text.length ||
    card.text.length > 16384 ||
    ![card.cost, card.power, card.might].every((value) => Number.isSafeInteger(value) && Number(value) >= 0)
  )
    throw new AdapterParseFailure("Riftbound DB Eclipse Herald no longer fits its retained overlap qualification.");
  const printingAttributes = {
    public_code: "OGN-059/298",
    collector_number: 59,
    set_code: "OGN",
    orientation: "portrait",
    reverse_face: null,
    finish: null,
    artists: [card.artist],
  };
  const fingerprint = officialArtworkFingerprint("OGN-059/298", ["front"], null);
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
      official_identity: { kind: "publisher_name", value: "Eclipse Herald" },
      name: card.name,
      effective_rules_text: card.text,
      game_data: {
        profile: "riftbound@1",
        attributes: {
          card_types: ["unit"],
          supertypes: [],
          domains: ["calm"],
          energy: card.cost,
          power: card.power,
          might: card.might,
          might_bonus: null,
          tags: card.tags,
          ability_text: card.text,
          effect_text: null,
        },
      },
    },
    printing: {
      rarity: {
        raw: typeof card.rarity === "string" ? card.rarity : null,
        normalized: card.rarity === "Uncommon" ? "uncommon" : null,
      },
      printed_rules_text: null,
      game_data: { profile: "riftbound@1", attributes: printingAttributes },
    },
    identity_evidence: {
      locator: eclipseHeraldSourceId,
      variant_key: eclipseHeraldSourceId,
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
          source_url: `${eclipseOriginal}?accountingTag=RB`,
          artwork_fingerprint: fingerprint,
          content_sha256: "258b9664ca0503286d4eaca25385ef2e1c6992616b806a3c4bd4744bd61bd190",
        },
      ],
    },
    memberships: { products: [], distribution_contexts: [], source_buckets: ["OGN"] },
    product_release_catalogue: { products: [], distribution_contexts: [], relationships: [] },
    source_sidecar: {
      source_record_json: JSON.stringify(card),
      image_qualification:
        "The retained Riot URL includes accountingTag=RB; the DB original locator without that query remains in the raw record. Same publisher asset, not independent corroboration.",
      unmapped_optional_fields: Object.entries(card)
        .filter(([key]) => !knownFields.has(key))
        .map(([key, value]) => ({ path: `riftbound_db_record.${key}`, value: JSON.stringify(value) })),
    },
  };
}

const knownFields = new Set([
  "id",
  "raw",
  "cost",
  "name",
  "tags",
  "text",
  "might",
  "power",
  "artist",
  "domain",
  "flavor",
  "number",
  "rarity",
  "regions",
  "setCode",
  "setName",
  "cardType",
  "imageUrl",
  "keywords",
  "textRich",
  "previewed",
  "signature",
  "orientation",
  "riftboundId",
  "alternateArt",
  "thumbnailUrl",
  "imageSourceUrl",
]);

/** Raw and presented source identities and attributed upstream IDs must agree. */
export function assertRiftboundDbRecordIdentity(card: Record<string, unknown>): string {
  const id = riftboundDbText(card.id);
  const raw = riftboundDbRecord(card.raw);
  if (
    raw.id !== id ||
    raw.riftbound_id !== card.riftboundId ||
    (raw.media !== undefined && riftboundDbRecord(raw.media).image_url !== card.imageSourceUrl)
  )
    throw new AdapterParseFailure(
      "Riftbound DB raw and presented source identities or original image locators disagree.",
    );
  if (raw.openrift !== undefined) {
    const upstream = riftboundDbRecord(raw.openrift);
    riftboundDbText(upstream.cardId);
    if (id !== `openrift-${riftboundDbText(upstream.printingId)}`)
      throw new AdapterParseFailure("Riftbound DB upstream Printing identifier attribution disagrees.");
  }
  return id;
}

/**
 * An unresolved source record: its evidence and complete record are retained
 * for owner review, and no Card, Printing or Game Profile is inferred from it.
 */
export function riftboundDbReviewRecord(
  card: Record<string, unknown>,
  images: readonly SourceImage[],
  sourceRecord: Record<string, unknown> = card,
): RiftboundSupplementarySourceAdmissionEvidenceObservation {
  const id = assertRiftboundDbRecordIdentity(card);
  riftboundDbText(card.name);
  const number = Number.isSafeInteger(card.number) ? String(card.number) : riftboundDbText(card.number);
  return {
    observation_type: "source_admission_evidence",
    game: "riftbound",
    source_lineage: riftboundDbLineage,
    locator: id,
    source_membership: { set_id: riftboundDbText(card.setCode), local_id: number },
    target: { kind: "unresolved_record" },
    issues: [
      { code: "card_identity_unresolved", source_paths: ["raw.openrift.cardId", "name"] },
      { code: "printing_treatment_unresolved", source_paths: ["raw.openrift", "imageSourceUrl"] },
      { code: "physical_issuance_unresolved", source_paths: ["previewed", "raw.openrift.channelPath"] },
    ],
    appearance_evidence: { images: [...images] },
    source_sidecar: { source_record_json: JSON.stringify(sourceRecord) },
    completeness: {
      structurally_complete: true,
      required_surfaces_complete: true,
      partitions_complete: true,
      declared_record_count: 1,
      parsed_record_count: 1,
    },
  };
}

export function riftboundDbRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AdapterParseFailure("Riftbound DB requires an object.");
  return value as Record<string, unknown>;
}
export function riftboundDbText(value: unknown, maximum = 256): string {
  if (typeof value !== "string" || !value.length || value.length > maximum)
    throw new AdapterParseFailure("Riftbound DB source text is missing or exceeds its bound.");
  return value;
}
export function riftboundDbList(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new AdapterParseFailure("Riftbound DB source list exceeds its bound.");
  return value;
}
