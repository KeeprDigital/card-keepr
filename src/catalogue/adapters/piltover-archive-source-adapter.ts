import { AdapterParseFailure, decodeAdapterUtf8 } from "./adapter-parse-failure";
import type { SourceAdapterRegistration } from "./source-adapter-registration-types";
import {
  parsePiltoverGalleryPage,
  piltoverArchiveOrigin,
  piltoverGalleryPageNumber,
  type PiltoverGalleryPage,
} from "./piltover-archive-gallery";
import { piltoverPinnedImageRequest, piltoverPinnedObservation } from "./piltover-archive-evidence";

// Piltover Archive is an independent Source using Riot assets. Registration
// permits bounded reading of its public gallery; it designates no authority.
const surfaces: Readonly<Record<string, string>> = { gallery: `${piltoverArchiveOrigin}/cards` };

function surfaceUrl(surface: string) {
  const url = surfaces[surface];
  if (!url) throw new AdapterParseFailure("Unknown Piltover Archive pilot surface.", { category: "configuration" });
  return url;
}

function galleryPage(bytes: Uint8Array, url: string): PiltoverGalleryPage {
  piltoverGalleryPageNumber(url);
  if (!Object.values(surfaces).includes(url))
    throw new AdapterParseFailure("Piltover Archive request is outside the bounded promo-lead pilot.");
  return parsePiltoverGalleryPage(decodeAdapterUtf8(bytes), url);
}

export const piltoverArchiveSourceAdapterRegistration: SourceAdapterRegistration = {
  adapterVersion: "piltover-archive-en@1",
  sourceLineage: "piltover-archive-en",
  supportedGame: "riftbound",
  gameProfileVersion: "riftbound@1",
  parserContract: "piltover-archive-gallery-flight@1",
  maximumSnapshotBytes: 1024 * 1024,
  requestCapacity: 3,
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
    "promo-lead-pilot": {
      description:
        "The first public gallery page and the two pinned rows it carries: Blazing Scorcher OGN-001 (retained Riot overlap) and Vi, Destructive ARC-001 (supplementary promo lead), each with its front art. Other rows stay retained bytes only; neither the page nor the gallery inventory is claimed complete.",
      requiredSurfaces: Object.keys(surfaces),
      requestUrlForSurface: surfaceUrl,
    },
  },
  parseBytes(bytes, context) {
    if (context.mediaType?.startsWith("image/")) return [];
    const page = galleryPage(bytes, context.url);
    return page.rows.flatMap((row) => {
      const observation = piltoverPinnedObservation(row, page);
      return observation === null ? [] : [observation];
    });
  },
  discoverRequests(bytes, context) {
    if (context.mediaType?.startsWith("image/")) return [];
    return galleryPage(bytes, context.url).rows.flatMap((row) => {
      const request = piltoverPinnedImageRequest(row);
      return request === null ? [] : [request];
    });
  },
};
