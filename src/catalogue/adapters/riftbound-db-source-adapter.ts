import { AdapterParseFailure, decodeAdapterUtf8, withAdapterParseFailure } from "./adapter-parse-failure";
import type { RiftboundDbSourceAdmissionEvidenceObservation } from "./adapter-observations";
import type { SourceAdapterRegistration } from "./source-adapter-registration-types";
import { eclipseHeraldSourceId, riftboundDbEclipseObservation, riftboundDbPromoImages } from "./riftbound-db-evidence";

const origin = "https://www.riftbound-db.com";
const surfaces: Readonly<Record<string, string>> = {
  facets: `${origin}/api/facets`,
  "promo-page": `${origin}/api/cards?set=PR&page=1&pageSize=3`,
  "bird-page": `${origin}/api/cards?q=Bird&page=1&pageSize=3`,
};

function surfaceUrl(surface: string) {
  const url = surfaces[surface];
  if (!url) throw new AdapterParseFailure("Unknown Riftbound DB pilot surface.", { category: "configuration" });
  return url;
}

function sourceRecords(bytes: Uint8Array, url: string) {
  if (!Object.values(surfaces).includes(url))
    throw new AdapterParseFailure("Riftbound DB request is outside the bounded two-query pilot.");
  const page = record(withAdapterParseFailure(() => JSON.parse(decodeAdapterUtf8(bytes))));
  if (url === surfaces.facets) {
    const sets = list(page.sets, 32).map((value) => text(value, 16));
    if (!sets.length || new Set(sets).size !== sets.length || !sets.includes("PR"))
      throw new AdapterParseFailure("Riftbound DB facets no longer establish the selected PR bucket.");
    for (const field of [
      "cardTypes",
      "supertypes",
      "regions",
      "rarities",
      "keywords",
      "domains",
      "artists",
      "subtypes",
    ])
      list(page[field], 256).forEach((value) => text(value));
    record(page.setNames);
    text(page.source);
    return [];
  }
  const cards = list(page.cards, 3).map(record);
  const pagination = record(page.pagination);
  if (
    pagination.page !== 1 ||
    pagination.pageSize !== 3 ||
    !Number.isSafeInteger(pagination.total) ||
    Number(pagination.total) < cards.length ||
    cards.length !== Math.min(3, Number(pagination.total)) ||
    pagination.hasMore !== Number(pagination.total) > cards.length ||
    !cards.length
  )
    throw new AdapterParseFailure("Riftbound DB pagination is malformed; this pilot never follows further pages.");
  const ids = cards.map((card) => text(card.id));
  if (new Set(ids).size !== ids.length) throw new AdapterParseFailure("Riftbound DB repeats an ID within one page.");
  for (const card of cards) {
    const raw = record(card.raw);
    if (
      raw.id !== card.id ||
      raw.riftbound_id !== card.riftboundId ||
      record(raw.media).image_url !== card.imageSourceUrl
    )
      throw new AdapterParseFailure(
        "Riftbound DB raw and presented source identities or original image locators disagree.",
      );
    if (raw.openrift !== undefined) {
      const upstream = record(raw.openrift);
      text(upstream.cardId);
      if (card.id !== `openrift-${text(upstream.printingId)}`)
        throw new AdapterParseFailure("Riftbound DB upstream Printing identifier attribution disagrees.");
    }
  }
  return cards;
}

function reviewRecord(card: Record<string, unknown>): RiftboundDbSourceAdmissionEvidenceObservation {
  const raw = record(card.raw);
  const id = text(card.id);
  if (raw.id !== id) throw new AdapterParseFailure("Riftbound DB source identifiers disagree.");
  text(card.name);
  text(card.text, 16 * 1024);
  return {
    observation_type: "source_admission_evidence" as const,
    game: "riftbound" as const,
    source_lineage: "riftbound-db-en" as const,
    locator: id,
    source_membership: { set_id: text(card.setCode), local_id: text(card.number) },
    target: { kind: "unresolved_record" as const },
    issues: [
      { code: "card_identity_unresolved", source_paths: ["raw.openrift.cardId", "name"] },
      { code: "printing_treatment_unresolved", source_paths: ["raw.openrift", "imageSourceUrl"] },
      { code: "physical_issuance_unresolved", source_paths: ["previewed", "raw.openrift.channelPath"] },
    ],
    appearance_evidence: { images: riftboundDbPromoImages(card) },
    source_sidecar: { source_record_json: JSON.stringify(card) },
    completeness: {
      structurally_complete: true as const,
      required_surfaces_complete: true as const,
      partitions_complete: true as const,
      declared_record_count: 1 as const,
      parsed_record_count: 1 as const,
    },
  };
}

export const riftboundDbSourceAdapterRegistration: SourceAdapterRegistration = {
  adapterVersion: "riftbound-db-en@1",
  sourceLineage: "riftbound-db-en",
  supportedGame: "riftbound",
  gameProfileVersion: "riftbound@1",
  parserContract: "riftbound-db-bounded-queries@1",
  maximumSnapshotBytes: 1024 * 1024,
  requestCapacity: 7,
  origin: "production",
  requestSurface: { kind: "credential-free-https" },
  reconciliationCapability: "catalogue",
  printingAdmission: "owner_review",
  reconciliationAreas: ["catalogue"],
  listingReconciliation: {
    groupsPublisherPages: false,
    strictListingIdentity: false,
    duplicateLocatorCompatibility: "semantic",
  },
  requiredSurfaces: Object.keys(surfaces),
  requestUrlForSurface: surfaceUrl,
  coverageContracts: {
    "promo-overlap-pilot": {
      description:
        "The facet snapshot and only page 1, size 3 of the PR and Bird queries. Includes a real overlapping Bird observation; does not claim either query or the source inventory is complete.",
      requiredSurfaces: Object.keys(surfaces),
      requestUrlForSurface: surfaceUrl,
    },
  },
  parseBytes(bytes, context) {
    if (context.mediaType?.startsWith("image/")) return [];
    return sourceRecords(bytes, context.url).map((card) =>
      card.id === eclipseHeraldSourceId ? riftboundDbEclipseObservation(card) : reviewRecord(card),
    );
  },
  discoverRequests(bytes, context) {
    if (context.mediaType?.startsWith("image/")) return [];
    return sourceRecords(bytes, context.url).flatMap((card) => {
      const observation = card.id === eclipseHeraldSourceId ? riftboundDbEclipseObservation(card) : reviewRecord(card);
      return observation.appearance_evidence.images.map((image) => ({
        role: "image" as const,
        url: image.source_url,
        headers: { accept: "image/webp,image/png" },
      }));
    });
  },
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AdapterParseFailure("Riftbound DB requires an object.");
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 256): string {
  if (typeof value !== "string" || !value.length || value.length > maximum)
    throw new AdapterParseFailure("Riftbound DB source text is missing or exceeds its bound.");
  return value;
}
function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new AdapterParseFailure("Riftbound DB source list exceeds its bound.");
  return value;
}
