import { AdapterParseFailure, decodeAdapterUtf8 } from "./adapter-parse-failure";
import type { SourceAdapterRegistration } from "./source-adapter-registration-types";
import { hexdeckOrigin, parseHexdeckSearchPage, type HexdeckSearchPage } from "./hexdeck-gallery";
import { hexdeckPinnedImageRequest, hexdeckPinnedObservation } from "./hexdeck-evidence";
import {
  hexdeckCensusObservations,
  hexdeckCensusPage,
  hexdeckCensusPageUrl,
  hexdeckCensusRequests,
} from "./hexdeck-census";

// HexDeck is an independent fan-project Source using Riot assets. Registration
// permits bounded reading of its documented public pages; it designates no
// authority.
// The pilot's search sorted by Set lists OGS, OGN, then SFD; page 7 carries the
// end of OGN with its T01 Buff token before SFD begins. The pilot follows no
// page; the separate census scope follows the search's own page count (#332).
const searchPage = (page: number) =>
  `${hexdeckOrigin}/cards?displayFormat=Images&page=${page}&sortDirection=Ascending&sortField=Set`;
const pilotSurfaces: Readonly<Record<string, string>> = {
  "set-slice": searchPage(1),
  "token-page": searchPage(7),
};
const censusSurfaces: Readonly<Record<string, string>> = { "search-census": hexdeckCensusPageUrl(1) };

function surfaceUrl(surfaces: Readonly<Record<string, string>>) {
  return (surface: string) => {
    const url = surfaces[surface];
    if (!url) throw new AdapterParseFailure("Unknown HexDeck surface.", { category: "configuration" });
    return url;
  };
}

const isPilotUrl = (url: string) => Object.values(pilotSurfaces).includes(url);

function pilotPage(bytes: Uint8Array, url: string): HexdeckSearchPage {
  return parseHexdeckSearchPage(decodeAdapterUtf8(bytes), url);
}

export const hexdeckSourceAdapterRegistration: SourceAdapterRegistration = {
  adapterVersion: "hexdeck-en@1",
  sourceLineage: "hexdeck-en",
  supportedGame: "riftbound",
  gameProfileVersion: "riftbound@1",
  parserContract: "hexdeck-search-flight@1",
  maximumSnapshotBytes: 1024 * 1024,
  // Census envelope of the retained 2026-09-21 search: 940 listings in 19
  // pages of 50, each with at most one page-referenced front, plus about 15%
  // growth headroom. Edited in place before Go-Live (ADR 0008) together with
  // its capacity migration. It is a finite admission bound, not throughput.
  requestCapacity: 1_100,
  // Census pages 2..N compare their total and page size with the retained page 1.
  retainedParentContext: { maximumDepth: 1, maximumTotalBytes: 1024 * 1024 },
  // #389 adaptive pacing bounds.
  hostPacing: [
    {
      hostname: "www.hexdeck.io",
      kind: "page",
      floorMs: 1_000,
      ceilingMs: 8_000,
      maximumConcurrency: 1,
      evidence:
        "No robots policy: the retained /robots.txt response (2026-09-14) is a Vercel HTTP 404 HTML page. The June 2026 terms require written permission for automated scripts; the owner cleared automated consumption on 2026-09-21 (#332). The search pages are Next.js renders on Vercel; the pilot's 12 requests at 2 s all returned HTTP 200 (except the rejected bare image locator). The floor stays conservative at 1 s. See acceptance/fixtures/real-sources/2026-09-21-hexdeck/README.md.",
    },
    {
      hostname: "imagedelivery.net",
      kind: "asset",
      floorMs: 100,
      ceilingMs: 2_000,
      maximumConcurrency: 4,
      evidence:
        "Cloudflare Images delivery host shared by many accounts; no host-specific robots or terms are retained. The pilot's `standard` front requests returned HTTP 200. Conservative bounds: at most 4 in flight, 100 ms start spacing, backing off on any refusal.",
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
  requiredSurfaces: Object.keys(pilotSurfaces),
  requestUrlForSurface: surfaceUrl(pilotSurfaces),
  coverageContracts: {
    "set-slice-pilot": {
      description:
        "Pages 1 and 7 of the Images-format search sorted by Set: a 50-row OGS/OGN slice with the pinned Blazing Scorcher row, and the OGN tail with the pinned T01 Buff token before SFD, each with its page-referenced front art. Other rows stay retained bytes only; no page is followed and nothing is claimed complete.",
      requiredSurfaces: Object.keys(pilotSurfaces),
      requestUrlForSurface: surfaceUrl(pilotSurfaces),
    },
    "search-census": {
      description:
        "Every page of the Images-format search sorted by Set that page 1's total and page size imply, each checked against page 1 and its own row count, and the page-referenced `standard` front of every listing. Every listing is retained as an unresolved review record with incomplete Card facts; the two pinned listings keep their pilot outputs while they fit. The census is HexDeck's search inventory, not proof of physical issuance or promo coverage.",
      requiredSurfaces: Object.keys(censusSurfaces),
      requestUrlForSurface: surfaceUrl(censusSurfaces),
    },
  },
  parseBytes(bytes, context) {
    if (context.mediaType?.startsWith("image/")) return [];
    if (!isPilotUrl(context.url)) return hexdeckCensusObservations(hexdeckCensusPage(bytes, context));
    const page = pilotPage(bytes, context.url);
    return page.rows.flatMap((row) => {
      const observation = hexdeckPinnedObservation(row, page);
      return observation === null ? [] : [observation];
    });
  },
  discoverRequests(bytes, context) {
    if (context.mediaType?.startsWith("image/")) return [];
    if (!isPilotUrl(context.url)) return hexdeckCensusRequests(hexdeckCensusPage(bytes, context));
    const page = pilotPage(bytes, context.url);
    return page.rows.flatMap((row) => {
      const request = hexdeckPinnedImageRequest(row);
      return request === null ? [] : [request];
    });
  },
};
