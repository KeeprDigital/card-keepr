import { AdapterParseFailure, decodeAdapterUtf8 } from "./adapter-parse-failure";
import type { SourceAdapterRegistration } from "./source-adapter-registration-types";
import {
  parsePiltoverGalleryPage,
  piltoverArchiveOrigin,
  piltoverCensusPageUrl,
  piltoverGalleryPageNumber,
  type PiltoverGalleryPage,
} from "./piltover-archive-gallery";
import { piltoverPinnedImageRequest, piltoverPinnedObservation } from "./piltover-archive-evidence";
import {
  isPiltoverCensusUrl,
  piltoverCensusObservations,
  piltoverCensusPage,
  piltoverCensusRequests,
} from "./piltover-archive-census";

// Piltover Archive is an independent Source using Riot assets. Registration
// permits bounded reading of its public gallery; it designates no authority.
// The pilot root `/cards` keeps its two pinned rows only; the census root
// `/cards?page=1` follows the gallery's own pagination (#330).
const pilotSurfaces: Readonly<Record<string, string>> = { gallery: `${piltoverArchiveOrigin}/cards` };
const censusSurfaces: Readonly<Record<string, string>> = { "gallery-census": piltoverCensusPageUrl(1) };

function surfaceUrl(surfaces: Readonly<Record<string, string>>) {
  return (surface: string) => {
    const url = surfaces[surface];
    if (!url) throw new AdapterParseFailure("Unknown Piltover Archive surface.", { category: "configuration" });
    return url;
  };
}

function pilotPage(bytes: Uint8Array, url: string): PiltoverGalleryPage {
  piltoverGalleryPageNumber(url);
  if (!Object.values(pilotSurfaces).includes(url))
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
  // Census envelope of the retained 2026-09-21 gallery page 1: 26 pages and
  // 1,240 displayed rows, each with at most one front, plus about 10% growth
  // headroom. Edited in place before Go-Live (ADR 0008) together with its
  // capacity migration. It is a finite admission bound, not measured throughput.
  requestCapacity: 1_400,
  // Census pages 2..N compare their pagination with the retained page 1.
  retainedParentContext: { maximumDepth: 1, maximumTotalBytes: 1024 * 1024 },
  // #389 adaptive pacing bounds.
  hostPacing: [
    {
      hostname: "piltoverarchive.com",
      kind: "page",
      floorMs: 1_000,
      ceilingMs: 8_000,
      maximumConcurrency: 1,
      evidence:
        "Retained robots.txt (2026-09-14, SHA-256 c3263709…, see acceptance/fixtures/real-sources/2026-09-21-piltover-archive/README.md) allows / and disallows only /admin/, /api/, /_next/ and /static/, with no Crawl-delay. The April 2026 terms prohibit overloading automation; the owner cleared automated consumption on 2026-09-21 (#330). The pages are uncached Next.js renders (cf-cache-status DYNAMIC, ~0.3 s origin time), so the floor stays conservative at 1 s; the pilot's 2 s-paced requests all returned HTTP 200.",
    },
    ...["cdn.piltoverarchive.com", "piltoverarchive.b-cdn.net"].map((hostname) => ({
      hostname,
      kind: "asset" as const,
      floorMs: 100,
      ceilingMs: 2_000,
      maximumConcurrency: 4,
      evidence:
        "Static WebP front art on Piltover's CDN hosts; no CDN-specific robots or terms are retained. The pilot's two front requests returned HTTP 200. Conservative bounds: at most 4 in flight, 100 ms start spacing, backing off on any refusal.",
    })),
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
  requiredSurfaces: Object.keys(pilotSurfaces),
  requestUrlForSurface: surfaceUrl(pilotSurfaces),
  coverageContracts: {
    "promo-lead-pilot": {
      description:
        "The first public gallery page and the two pinned rows it carries: Blazing Scorcher OGN-001 (retained Riot overlap) and Vi, Destructive ARC-001 (supplementary promo lead), each with its front art. Other rows stay retained bytes only; neither the page nor the gallery inventory is claimed complete.",
      requiredSurfaces: Object.keys(pilotSurfaces),
      requestUrlForSurface: surfaceUrl(pilotSurfaces),
    },
    "gallery-census": {
      description:
        "Every page of the public English gallery that page 1 reports, each checked against page 1's page count, displayed total and page size, and the front art of every row on Piltover's two art hosts. Every row is retained as an unresolved review record; the two pinned rows keep their qualified outputs while they still fit. The census is the gallery's own display inventory, not proof of physical issuance, English printing or promo coverage.",
      requiredSurfaces: Object.keys(censusSurfaces),
      requestUrlForSurface: surfaceUrl(censusSurfaces),
    },
  },
  parseBytes(bytes, context) {
    if (context.mediaType?.startsWith("image/")) return [];
    if (isPiltoverCensusUrl(context.url)) return piltoverCensusObservations(piltoverCensusPage(bytes, context));
    const page = pilotPage(bytes, context.url);
    return page.rows.flatMap((row) => {
      const observation = piltoverPinnedObservation(row, page);
      return observation === null ? [] : [observation];
    });
  },
  discoverRequests(bytes, context) {
    if (context.mediaType?.startsWith("image/")) return [];
    if (isPiltoverCensusUrl(context.url)) return piltoverCensusRequests(piltoverCensusPage(bytes, context));
    return pilotPage(bytes, context.url).rows.flatMap((row) => {
      const request = piltoverPinnedImageRequest(row);
      return request === null ? [] : [request];
    });
  },
};
