import { AdapterParseFailure, decodeAdapterUtf8, withAdapterParseFailure } from "./adapter-parse-failure";
import type { SourceAdapterParseContext, SourceAdapterRegistration } from "./source-adapter-registration-types";
import {
  assertRiftboundDbRecordIdentity,
  eclipseHeraldSourceId,
  riftboundDbEclipseObservation,
  riftboundDbList as list,
  riftboundDbOrigin as origin,
  riftboundDbPromoImages,
  riftboundDbRecord as record,
  riftboundDbReviewRecord,
  riftboundDbText as text,
} from "./riftbound-db-evidence";
import {
  isRiftboundDbCensusRoot,
  riftboundDbCensusObservations,
  riftboundDbCensusPage,
  riftboundDbCensusPageReference,
  riftboundDbCensusRequests,
  riftboundDbCensusRootRequests,
  riftboundDbFacetsUrl,
} from "./riftbound-db-census";

const surfaces: Readonly<Record<string, string>> = {
  facets: riftboundDbFacetsUrl,
  "promo-page": `${origin}/api/cards?set=PR&page=1&pageSize=3`,
  "bird-page": `${origin}/api/cards?q=Bird&page=1&pageSize=3`,
};
const censusSurfaces: Readonly<Record<string, string>> = { "set-census": riftboundDbFacetsUrl };

function surfaceUrl(declared: Readonly<Record<string, string>>) {
  return (surface: string) => {
    const url = declared[surface];
    if (!url) throw new AdapterParseFailure("Unknown Riftbound DB surface.", { category: "configuration" });
    return url;
  };
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
  const ids = cards.map(assertRiftboundDbRecordIdentity);
  if (new Set(ids).size !== ids.length) throw new AdapterParseFailure("Riftbound DB repeats an ID within one page.");
  return cards;
}

function reviewRecord(card: Record<string, unknown>) {
  text(card.text, 16 * 1024);
  return riftboundDbReviewRecord(card, riftboundDbPromoImages(card));
}

function sourceRecordObservation(card: Record<string, unknown>) {
  return card.id === eclipseHeraldSourceId ? riftboundDbEclipseObservation(card) : reviewRecord(card);
}

function censusPage(bytes: Uint8Array, context: SourceAdapterParseContext) {
  return riftboundDbCensusPageReference(context.url) === null ? null : riftboundDbCensusPage(bytes, context);
}

// Riftbound DB is an independent fan database (Riot data and OpenRift promo
// records). Registration permits bounded reading of its public card API; it
// designates no authority. The pilot reads three fixed roots; the separate
// census scope follows every set bucket the facets list (#333).
export const riftboundDbSourceAdapterRegistration: SourceAdapterRegistration = {
  adapterVersion: "riftbound-db-en@1",
  sourceLineage: "riftbound-db-en",
  supportedGame: "riftbound",
  gameProfileVersion: "riftbound@1",
  parserContract: "riftbound-db-bounded-queries@1",
  maximumSnapshotBytes: 1024 * 1024,
  // Set-census envelope, not a measured inventory: the facets root, pages of
  // 80 for about 1,200 Riot-mirrored and several hundred promo or preview
  // records across 11 buckets, and one original front per record hosted off
  // Riot's CDN, with headroom for every record needing a front. A larger
  // inventory pauses for a Capacity Extension rather than failing. Edited in
  // place before Go-Live (ADR 0008) together with its capacity migration.
  requestCapacity: 2_500,
  // Census pages check their bucket against the facets and the retained page 1:
  // a later page descends from its page 1, which descends from the facets root.
  retainedParentContext: { maximumDepth: 2, maximumTotalBytes: 1024 * 1024 },
  // #389 adaptive pacing bounds.
  hostPacing: [
    {
      hostname: "www.riftbound-db.com",
      kind: "page",
      floorMs: 2_000,
      ceilingMs: 16_000,
      maximumConcurrency: 1,
      evidence:
        "Retained robots.txt (2026-09-14, SHA-256 b039c3df..., see acceptance/fixtures/real-sources/2026-09-14-riftbound-db/README.md) disallows /api/ for crawlers; the May 2026 terms prohibit scraping or bulk export that harms the service. No owner clearance of the census is recorded yet (#333). API responses are CDN-cached (s-maxage 3600) and the pilot's three API requests returned HTTP 200. Bounds are deliberately more polite than the other Riftbound sources: sequential, 2 s floor, 16 s ceiling.",
    },
    {
      hostname: "openrift.app",
      kind: "asset",
      floorMs: 250,
      ceilingMs: 4_000,
      maximumConcurrency: 2,
      evidence:
        "OpenRift's original promo fronts behind Cloudflare (retained 2026-09-15 headers: immutable UUID paths, one-year Expires). No robots or terms retained for this host; the pilot's three front requests returned HTTP 200. A small community host, so at most 2 in flight with 250 ms start spacing, backing off on any refusal.",
    },
  ],
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
  requestUrlForSurface: surfaceUrl(surfaces),
  coverageContracts: {
    "promo-overlap-pilot": {
      description:
        "The facet snapshot and only page 1, size 3 of the PR and Bird queries. Includes a real overlapping Bird observation; does not claim either query or the source inventory is complete.",
      requiredSurfaces: Object.keys(surfaces),
      requestUrlForSurface: surfaceUrl(surfaces),
    },
    "set-census": {
      description:
        "Every set bucket the facets list, each read page by page in the site's own set-traversal query (80 per page, default order) and checked against its page 1 and its own row count, with the original front of every record hosted on OpenRift. Every record is retained as an unresolved review record; Eclipse Herald keeps its pilot overlap while it fits. The census is Riftbound DB's API inventory, not proof of English print, physical issuance or promo coverage.",
      requiredSurfaces: Object.keys(censusSurfaces),
      requestUrlForSurface: surfaceUrl(censusSurfaces),
    },
  },
  parseBytes(bytes, context) {
    if (context.mediaType?.startsWith("image/")) return [];
    if (isRiftboundDbCensusRoot(context)) {
      riftboundDbCensusRootRequests(bytes);
      return [];
    }
    const census = censusPage(bytes, context);
    if (census !== null) return riftboundDbCensusObservations(census);
    return sourceRecords(bytes, context.url).map(sourceRecordObservation);
  },
  discoverRequests(bytes, context) {
    if (context.mediaType?.startsWith("image/")) return [];
    if (isRiftboundDbCensusRoot(context)) return riftboundDbCensusRootRequests(bytes);
    const census = censusPage(bytes, context);
    if (census !== null) return riftboundDbCensusRequests(census);
    return sourceRecords(bytes, context.url).flatMap((card) => {
      const observation = sourceRecordObservation(card);
      return observation.appearance_evidence.images.map((image) => ({
        role: "image" as const,
        url: image.source_url,
        headers: { accept: "image/webp,image/png" },
      }));
    });
  },
};
