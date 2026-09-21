import { AdapterParseFailure, decodeAdapterUtf8 } from "./adapter-parse-failure";
import type { SourceAdapterRegistration } from "./source-adapter-registration-types";
import { hexdeckOrigin, parseHexdeckSearchPage, type HexdeckSearchPage } from "./hexdeck-gallery";
import { hexdeckPinnedImageRequest, hexdeckPinnedObservation } from "./hexdeck-evidence";

// HexDeck is an independent fan-project Source using Riot assets. Registration
// permits bounded reading of its documented public pages; it designates no
// authority and follows no pagination.
// The search sorted by Set lists OGS, OGN, then SFD; page 7 carries the end of
// OGN with its T01 Buff token before SFD begins. No page is followed.
const searchPage = (page: number) =>
  `${hexdeckOrigin}/cards?displayFormat=Images&page=${page}&sortDirection=Ascending&sortField=Set`;
const surfaces: Readonly<Record<string, string>> = {
  "set-slice": searchPage(1),
  "token-page": searchPage(7),
};

function surfaceUrl(surface: string) {
  const url = surfaces[surface];
  if (!url) throw new AdapterParseFailure("Unknown HexDeck pilot surface.", { category: "configuration" });
  return url;
}

function documentPage(bytes: Uint8Array, url: string): HexdeckSearchPage {
  if (!Object.values(surfaces).includes(url))
    throw new AdapterParseFailure("HexDeck request is outside the bounded pilot.");
  return parseHexdeckSearchPage(decodeAdapterUtf8(bytes), url);
}

export const hexdeckSourceAdapterRegistration: SourceAdapterRegistration = {
  adapterVersion: "hexdeck-en@1",
  sourceLineage: "hexdeck-en",
  supportedGame: "riftbound",
  gameProfileVersion: "riftbound@1",
  parserContract: "hexdeck-search-flight@1",
  maximumSnapshotBytes: 1024 * 1024,
  requestCapacity: 4,
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
    "set-slice-pilot": {
      description:
        "Pages 1 and 7 of the Images-format search sorted by Set: a 50-row OGS/OGN slice with the pinned Blazing Scorcher row, and the OGN tail with the pinned T01 Buff token before SFD, each with its page-referenced front art. Other rows stay retained bytes only; no page is followed and nothing is claimed complete.",
      requiredSurfaces: Object.keys(surfaces),
      requestUrlForSurface: surfaceUrl,
    },
  },
  parseBytes(bytes, context) {
    if (context.mediaType?.startsWith("image/")) return [];
    const page = documentPage(bytes, context.url);
    return page.rows.flatMap((row) => {
      const observation = hexdeckPinnedObservation(row, page);
      return observation === null ? [] : [observation];
    });
  },
  discoverRequests(bytes, context) {
    if (context.mediaType?.startsWith("image/")) return [];
    const page = documentPage(bytes, context.url);
    return page.rows.flatMap((row) => {
      const request = hexdeckPinnedImageRequest(row);
      return request === null ? [] : [request];
    });
  },
};
