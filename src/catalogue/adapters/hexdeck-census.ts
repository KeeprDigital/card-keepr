import { createHash } from "node:crypto";
import type { RiftboundSupplementarySourceAdmissionEvidenceObservation } from "./adapter-observations";
import { AdapterParseFailure, decodeAdapterUtf8 } from "./adapter-parse-failure";
import type { SourceAdapterParseContext } from "./source-adapter-registration-types";
import { hexdeckOrigin, parseHexdeckSearchPage, type HexdeckListing, type HexdeckSearchPage } from "./hexdeck-gallery";
import {
  hexdeckLineage,
  hexdeckListingIssues,
  hexdeckPinnedImageRequest,
  hexdeckPinnedObservation,
  hexdeckPinnedStatus,
  hexdeckSearchPageSidecar,
} from "./hexdeck-evidence";

// #332 search census. The census walks the Images-format search sorted by Set
// in the parameter order HexDeck's own navigation links use, which keeps its
// request identities apart from the pilot's two pages. Page 1 discovers every
// page its total and page size imply; each page discovers the page-referenced
// `standard` front of its rows. Every listing stays a review record: the
// listing surface has no rules text, artist, finish or locale, so no row can
// form the profile's Card or be linked.

/** Finite census envelope: more pages than this is a changed search, not a longer crawl. */
export const hexdeckCensusMaximumPages = 60;
const deliveryHost = "imagedelivery.net";

export function hexdeckCensusPageUrl(page: number): string {
  if (!Number.isSafeInteger(page) || page < 1 || page > 999)
    throw new AdapterParseFailure("HexDeck search page number is outside its bound.");
  return `${hexdeckOrigin}/cards?displayFormat=Images&page=${page}&sortField=Set&sortDirection=Ascending`;
}

function pageCount(page: HexdeckSearchPage) {
  return Math.max(1, Math.ceil(page.total_count / page.page_size));
}

function censusPageNumber(url: string): number {
  const page = /^[1-9]\d{0,2}$/u.exec(new URL(url).searchParams.get("page") ?? "")?.[0];
  if (page === undefined || url !== hexdeckCensusPageUrl(Number(page)))
    throw new AdapterParseFailure("HexDeck census request is not a registered search page.");
  return Number(page);
}

/** Parse a census page and prove it belongs to the same dated search as its page 1. */
export function hexdeckCensusPage(bytes: Uint8Array, context: SourceAdapterParseContext): HexdeckSearchPage {
  const number = censusPageNumber(context.url);
  const page = parseHexdeckSearchPage(decodeAdapterUtf8(bytes), context.url);
  if (page.display_format !== "Images" || page.sort_field !== "Set" || page.sort_direction !== "Ascending")
    throw new AdapterParseFailure("HexDeck census page does not echo its registered search.");
  const pages = pageCount(page);
  if (pages > hexdeckCensusMaximumPages)
    throw new AdapterParseFailure("HexDeck search exceeds its registered census envelope.");
  if (number > pages) throw new AdapterParseFailure("HexDeck census page is beyond the reported search.");
  const expectedRows = number < pages ? page.page_size : page.total_count - (pages - 1) * page.page_size;
  if (page.rows.length !== expectedRows)
    throw new AdapterParseFailure("HexDeck census page does not carry its reported row count.");
  if (number === 1) return page;
  const parent = context.parents?.find((candidate) => candidate.url === hexdeckCensusPageUrl(1));
  if (parent === undefined) throw new AdapterParseFailure("HexDeck census page lacks its retained page 1.");
  const first = parseHexdeckSearchPage(decodeAdapterUtf8(parent.bytes), parent.url);
  if (first.total_count !== page.total_count || first.page_size !== page.page_size)
    throw new AdapterParseFailure("HexDeck search changed during its census.");
  return page;
}

function censusImageUrl(row: HexdeckListing): string | null {
  if (row.art_url === null) return null;
  const url = new URL(row.art_url);
  return url.hostname === deliveryHost && !url.search && !url.hash ? url.href : null;
}

/** An unqualified census listing: retained with its own front, never an entity. */
export function hexdeckCensusReview(
  row: HexdeckListing,
  page: HexdeckSearchPage,
  pinnedQualification: "changed" | null = null,
): RiftboundSupplementarySourceAdmissionEvidenceObservation {
  const imageUrl = censusImageUrl(row);
  return {
    observation_type: "source_admission_evidence",
    game: "riftbound",
    source_lineage: hexdeckLineage,
    locator: row.source_key,
    source_membership: { set_id: row.set_tag, local_id: row.set_number },
    target: { kind: "unresolved_record" },
    issues: hexdeckListingIssues.map((issue) => ({ ...issue, source_paths: [...issue.source_paths] })),
    appearance_evidence: {
      images:
        imageUrl === null
          ? []
          : [
              {
                association: "source_record",
                role: "front",
                source_url: imageUrl,
                // Attributes raw image evidence only; it names no design or Printing.
                artwork_fingerprint: `${hexdeckLineage}:source-record-image:${createHash("sha256")
                  .update(JSON.stringify([row.source_key, "front", imageUrl]))
                  .digest("hex")}`,
              },
            ],
    },
    source_sidecar: {
      source_record_json: JSON.stringify({
        ...row.record,
        search_page: hexdeckSearchPageSidecar(page),
        ...(pinnedQualification === null ? {} : { pinned_qualification: pinnedQualification }),
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

export function hexdeckCensusObservations(page: HexdeckSearchPage): unknown[] {
  return page.rows.map((row) => {
    const status = hexdeckPinnedStatus(row);
    if (status === "fits") return hexdeckPinnedObservation(row, page);
    return hexdeckCensusReview(row, page, status === "changed" ? "changed" : null);
  });
}

export function hexdeckCensusRequests(page: HexdeckSearchPage) {
  const pages =
    page.current_page === 1
      ? Array.from({ length: pageCount(page) - 1 }, (_, index) => ({
          role: "listing" as const,
          url: hexdeckCensusPageUrl(index + 2),
          headers: { accept: "text/html" },
        }))
      : [];
  const images = page.rows.flatMap((row) => {
    if (hexdeckPinnedStatus(row) === "fits") {
      const pinned = hexdeckPinnedImageRequest(row);
      return pinned === null ? [] : [pinned];
    }
    const url = censusImageUrl(row);
    return url === null
      ? []
      : [{ role: "image" as const, url, headers: { accept: "image/webp,image/png,image/jpeg" } }];
  });
  return [...pages, ...images];
}
