import { createHash } from "node:crypto";
import type { RiftboundSupplementarySourceAdmissionEvidenceObservation } from "./adapter-observations";
import { AdapterParseFailure, adapterUrl, decodeAdapterUtf8 } from "./adapter-parse-failure";
import type { SourceAdapterParseContext } from "./source-adapter-registration-types";
import {
  parsePiltoverGalleryPage,
  piltoverCensusPageUrl,
  piltoverGalleryPageNumber,
  type PiltoverGalleryPage,
  type PiltoverVariant,
} from "./piltover-archive-gallery";
import {
  galleryPageSidecar,
  piltoverArchiveLineage,
  piltoverArtHosts,
  piltoverPinnedImageRequest,
  piltoverPinnedObservation,
  piltoverPinnedStatus,
} from "./piltover-archive-evidence";

// #330 gallery census. Page 1 (`/cards?page=1`) discovers every other page its
// pagination reports and each page discovers the front art of its own rows.
// Every row is retained as an attributable review record; the two pinned rows
// keep their qualified pilot outputs while they still fit. There is no general
// rule from Piltover numbers or wording to Riot identities, so no census row
// allocates or links an entity: that remains owner review (#333).

/** Finite census envelope: more pages than this is a changed gallery, not a longer crawl. */
export const piltoverCensusMaximumPages = 60;

export function isPiltoverCensusUrl(url: string): boolean {
  return adapterUrl(url).searchParams.has("page");
}

function displayedTotal(page: PiltoverGalleryPage): number {
  return Number(page.total.replaceAll(",", ""));
}

/** Parse a census page and prove it belongs to the same dated gallery as its page 1. */
export function piltoverCensusPage(bytes: Uint8Array, context: SourceAdapterParseContext): PiltoverGalleryPage {
  const number = piltoverGalleryPageNumber(context.url);
  if (context.url !== piltoverCensusPageUrl(number))
    throw new AdapterParseFailure("Piltover Archive census request is not a registered gallery page.");
  const page = parsePiltoverGalleryPage(decodeAdapterUtf8(bytes), context.url);
  if (page.pages > piltoverCensusMaximumPages)
    throw new AdapterParseFailure("Piltover Archive gallery exceeds its registered census envelope.");
  if (number === 1) return page;
  const parent = context.parents?.find((candidate) => candidate.url === piltoverCensusPageUrl(1));
  if (parent === undefined) throw new AdapterParseFailure("Piltover Archive census page lacks its retained page 1.");
  const first = parsePiltoverGalleryPage(decodeAdapterUtf8(parent.bytes), parent.url);
  const perPage = first.rows.length;
  const expectedRows = number < first.pages ? perPage : displayedTotal(first) - (first.pages - 1) * perPage;
  if (page.pages !== first.pages || page.total !== first.total || page.rows.length !== expectedRows)
    throw new AdapterParseFailure("Piltover Archive gallery changed during its census.");
  return page;
}

function isStandard(row: PiltoverVariant) {
  return row.variant_type === "Standard" && row.variant_types.every((type) => type === "Standard");
}

function isPromo(row: PiltoverVariant) {
  return row.variant_type === "Promo" || row.variant_types.includes("Promo");
}

function censusImageUrl(row: PiltoverVariant): string | null {
  const url = new URL(row.image_url);
  return piltoverArtHosts.has(url.hostname) && !url.search && !url.hash ? url.href : null;
}

/** An unqualified census row: retained with its own front, never an entity. */
export function piltoverCensusReview(
  row: PiltoverVariant,
  page: PiltoverGalleryPage,
  pinnedQualification: "changed" | null = null,
): RiftboundSupplementarySourceAdmissionEvidenceObservation {
  const imageUrl = censusImageUrl(row);
  const locale = { code: "printing_locale_unresolved" as const, source_paths: ["imageUrl"] };
  const treatment = {
    code: "printing_treatment_unresolved" as const,
    source_paths: ["variantType", "variantTypes", "variantLabel", "rarity", "foilMode"],
  };
  // The review contract holds at most three issues. A promo keeps the pinned
  // ARC-001 triple (locale, treatment, issuance); other rows state that no
  // qualified rule maps them to an existing Card or Printing.
  const issues = isPromo(row)
    ? [
        locale,
        treatment,
        {
          code: "physical_issuance_unresolved" as const,
          source_paths: ["variantLabel", "releaseDate", "set.releaseDate"],
        },
      ]
    : [
        { code: "card_identity_unresolved" as const, source_paths: ["variantNumber", "set.prefix", "card.id"] },
        ...(isStandard(row) ? [] : [treatment]),
        locale,
      ];
  return {
    observation_type: "source_admission_evidence",
    game: "riftbound",
    source_lineage: piltoverArchiveLineage,
    locator: row.source_key,
    source_membership: { set_id: row.set.prefix, local_id: row.variant_number },
    target: { kind: "unresolved_record" },
    issues,
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
                artwork_fingerprint: `${piltoverArchiveLineage}:source-record-image:${createHash("sha256")
                  .update(JSON.stringify([row.source_key, "front", imageUrl]))
                  .digest("hex")}`,
              },
            ],
    },
    source_sidecar: {
      source_record_json: JSON.stringify({
        ...row.record,
        gallery_page: galleryPageSidecar(page),
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

export function piltoverCensusObservations(page: PiltoverGalleryPage): unknown[] {
  return page.rows.map((row) => {
    const status = piltoverPinnedStatus(row);
    if (status === "fits") return piltoverPinnedObservation(row, page);
    return piltoverCensusReview(row, page, status === "changed" ? "changed" : null);
  });
}

export function piltoverCensusRequests(page: PiltoverGalleryPage) {
  const pages =
    page.page === 1
      ? Array.from({ length: page.pages - 1 }, (_, index) => ({
          role: "listing" as const,
          url: piltoverCensusPageUrl(index + 2),
          headers: { accept: "text/html" },
        }))
      : [];
  const images = page.rows.flatMap((row) => {
    if (piltoverPinnedStatus(row) === "fits") {
      const pinned = piltoverPinnedImageRequest(row);
      return pinned === null ? [] : [pinned];
    }
    const url = censusImageUrl(row);
    return url === null ? [] : [{ role: "image" as const, url, headers: { accept: "image/webp,image/png" } }];
  });
  return [...pages, ...images];
}
