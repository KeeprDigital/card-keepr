import { createHash } from "node:crypto";
import { AdapterParseFailure, decodeAdapterUtf8, withAdapterParseFailure } from "./adapter-parse-failure";
import type { SourceAdapterParseContext } from "./source-adapter-registration-types";
import {
  assertRiftboundDbRecordIdentity,
  eclipseHeraldSourceId,
  riftboundDbEclipseObservation,
  riftboundDbLineage,
  riftboundDbList,
  riftboundDbOrigin,
  riftboundDbPromoImages,
  riftboundDbRecord,
  riftboundDbReviewRecord,
  riftboundDbText,
} from "./riftbound-db-evidence";

// #333 set census. The census root reads the facets and discovers page 1 of
// every set bucket they list, in the exact query form the site's own set
// traversal uses (`set`, `page`, `pageSize=80`, default Collection № order).
// Page 1 of a bucket discovers every page its total implies; each page is
// checked against its bucket's retained page 1 and its own row count, and
// fails closed on drift. Every record is retained as an unresolved review
// record: there is no qualified rule from Riftbound DB identifiers, display
// codes or wording to Riot identities, so nothing is allocated or linked
// without owner review. Eclipse Herald keeps its pilot overlap output while it
// still fits.

export const riftboundDbFacetsUrl = `${riftboundDbOrigin}/api/facets`;
/** The census root shares the pilot's facets URL; its plan identity selects the census reading. */
export const riftboundDbCensusRootId = `${riftboundDbLineage}:set-census`;
export const riftboundDbCensusPageSize = 80;
/** The site's own set traversal stops at page 200; more is a changed bucket, not a longer crawl. */
export const riftboundDbCensusMaximumPages = 200;
const maximumSets = 32;
const setCode = /^[A-Z][A-Z0-9]{1,5}$/u;
// Original fronts are fetched only from the upstream promo image host. Fronts
// on Riot's publisher CDN are the Riot lineage's own assets (retained by its
// refresh), not independent evidence; their locators stay in the record.
const censusImageHost = "openrift.app";

export type RiftboundDbCensusPage = Readonly<{
  set: string;
  page: number;
  pages: number;
  total: number;
  cards: readonly Record<string, unknown>[];
}>;

export function riftboundDbCensusPageUrl(set: string, page: number): string {
  if (!setCode.test(set) || !Number.isSafeInteger(page) || page < 1 || page > riftboundDbCensusMaximumPages)
    throw new AdapterParseFailure("Riftbound DB census page is outside its registered bounds.");
  const query = new URLSearchParams({ set, page: String(page), pageSize: String(riftboundDbCensusPageSize) });
  return `${riftboundDbOrigin}/api/cards?${query.toString()}`;
}

/** A census page URL's bucket and page, or null for any other request. */
export function riftboundDbCensusPageReference(url: string): { set: string; page: number } | null {
  const parsed = new URL(url);
  if (
    parsed.origin !== riftboundDbOrigin ||
    parsed.pathname !== "/api/cards" ||
    parsed.searchParams.get("pageSize") !== String(riftboundDbCensusPageSize)
  )
    return null;
  const set = parsed.searchParams.get("set") ?? "";
  const page = /^[1-9]\d{0,2}$/u.exec(parsed.searchParams.get("page") ?? "")?.[0];
  if (page === undefined || url !== riftboundDbCensusPageUrl(set, Number(page)))
    throw new AdapterParseFailure("Riftbound DB census request is not a registered set page.");
  return { set, page: Number(page) };
}

export function isRiftboundDbCensusRoot(context: SourceAdapterParseContext): boolean {
  return context.requestId === riftboundDbCensusRootId && context.url === riftboundDbFacetsUrl;
}

/** The set buckets the retained facets list: the census's declared partitions. */
export function riftboundDbCensusSets(bytes: Uint8Array): string[] {
  const facets = riftboundDbRecord(withAdapterParseFailure(() => JSON.parse(decodeAdapterUtf8(bytes))));
  const sets = riftboundDbList(facets.sets, maximumSets).map((value) => riftboundDbText(value, 16));
  if (!sets.length || new Set(sets).size !== sets.length || sets.some((set) => !setCode.test(set)))
    throw new AdapterParseFailure("Riftbound DB facets no longer list a bounded set of distinct set codes.");
  return sets;
}

function pagination(bytes: Uint8Array) {
  const document = riftboundDbRecord(withAdapterParseFailure(() => JSON.parse(decodeAdapterUtf8(bytes))));
  const cards = riftboundDbList(document.cards, riftboundDbCensusPageSize).map(riftboundDbRecord);
  const reported = riftboundDbRecord(document.pagination);
  const total = Number(reported.total);
  if (!Number.isSafeInteger(reported.total) || total < 0 || reported.pageSize !== riftboundDbCensusPageSize)
    throw new AdapterParseFailure("Riftbound DB census pagination is malformed.");
  return { cards, page: reported.page, total, hasMore: reported.hasMore };
}

/** Parse a census page and prove it belongs to the same dated bucket as its page 1. */
export function riftboundDbCensusPage(bytes: Uint8Array, context: SourceAdapterParseContext): RiftboundDbCensusPage {
  const reference = riftboundDbCensusPageReference(context.url);
  if (reference === null) throw new AdapterParseFailure("Riftbound DB request is not a census page.");
  const { set, page } = reference;
  const { cards, total, ...reported } = pagination(bytes);
  const pages = Math.max(1, Math.ceil(total / riftboundDbCensusPageSize));
  if (pages > riftboundDbCensusMaximumPages)
    throw new AdapterParseFailure("Riftbound DB set bucket exceeds its registered census envelope.");
  if (reported.page !== page || page > pages)
    throw new AdapterParseFailure("Riftbound DB census page does not echo a page of its bucket.");
  const expectedRows = page < pages ? riftboundDbCensusPageSize : total - (pages - 1) * riftboundDbCensusPageSize;
  if (cards.length !== expectedRows || reported.hasMore !== page < pages)
    throw new AdapterParseFailure("Riftbound DB census page does not carry its reported rows.");
  const ids = cards.map(assertRiftboundDbRecordIdentity);
  if (new Set(ids).size !== ids.length) throw new AdapterParseFailure("Riftbound DB repeats an ID within one page.");
  if (page === 1) {
    const facets = context.parents?.find((parent) => parent.url === riftboundDbFacetsUrl);
    if (facets === undefined || !riftboundDbCensusSets(facets.bytes).includes(set))
      throw new AdapterParseFailure("Riftbound DB census bucket is not listed by its retained facets.");
  } else {
    const first = context.parents?.find((parent) => parent.url === riftboundDbCensusPageUrl(set, 1));
    if (first === undefined) throw new AdapterParseFailure("Riftbound DB census page lacks its retained page 1.");
    if (pagination(first.bytes).total !== total)
      throw new AdapterParseFailure("Riftbound DB set bucket changed during its census.");
  }
  return { set, page, pages, total, cards };
}

function censusImages(card: Record<string, unknown>) {
  const pinned = riftboundDbPromoImages(card);
  if (pinned.length) return pinned;
  if (typeof card.imageSourceUrl !== "string" || !URL.canParse(card.imageSourceUrl)) return [];
  const url = new URL(card.imageSourceUrl);
  if (
    url.protocol !== "https:" ||
    url.hostname !== censusImageHost ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    url.href !== card.imageSourceUrl
  )
    return [];
  return [
    {
      association: "source_record" as const,
      role: "front" as const,
      source_url: url.href,
      // Attributes raw image evidence only; it names no design or Printing.
      artwork_fingerprint: `${riftboundDbLineage}:source-record-image:${createHash("sha256")
        .update(JSON.stringify([card.id, "front", url.href]))
        .digest("hex")}`,
    },
  ];
}

function censusReview(card: Record<string, unknown>, page: RiftboundDbCensusPage, changedPin: boolean) {
  return riftboundDbReviewRecord(card, censusImages(card), {
    ...card,
    census_page: { set: page.set, page: page.page, page_size: riftboundDbCensusPageSize, total: page.total },
    ...(changedPin ? { pinned_qualification: "changed" } : {}),
  });
}

export function riftboundDbCensusObservations(page: RiftboundDbCensusPage): unknown[] {
  return page.cards.map((card) => {
    if (card.id !== eclipseHeraldSourceId) return censusReview(card, page, false);
    try {
      return riftboundDbEclipseObservation(card);
    } catch (error) {
      if (!(error instanceof AdapterParseFailure)) throw error;
      return censusReview(card, page, true);
    }
  });
}

export function riftboundDbCensusRootRequests(bytes: Uint8Array) {
  return riftboundDbCensusSets(bytes).map((set) => ({
    role: "listing" as const,
    url: riftboundDbCensusPageUrl(set, 1),
    headers: { accept: "application/json" },
  }));
}

export function riftboundDbCensusRequests(page: RiftboundDbCensusPage) {
  const pages =
    page.page === 1
      ? Array.from({ length: page.pages - 1 }, (_, index) => ({
          role: "listing" as const,
          url: riftboundDbCensusPageUrl(page.set, index + 2),
          headers: { accept: "application/json" },
        }))
      : [];
  const images = new Set(
    riftboundDbCensusObservations(page)
      .flatMap(
        (observation) =>
          (observation as { appearance_evidence: { images: readonly { source_url: string }[] } }).appearance_evidence
            .images,
      )
      .map((image) => image.source_url),
  );
  return [
    ...pages,
    ...[...images].map((url) => ({ role: "image" as const, url, headers: { accept: "image/webp,image/png" } })),
  ];
}
