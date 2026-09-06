import type { ListingReconciliationTraits } from "./source-adapter-registration-types";
export type ProductSourceGame = "one-piece" | "fusion-world" | "digimon" | "gundam";

export type DiscoveryFormat = "one-piece" | "fusion-world" | "digimon" | "gundam";

import type { OfficialSourceObservation } from "./adapter-observations";
export type OfficialSourceSurface = { mediaType: string | null; url: string; requestId?: string };

export type OfficialRawAdapterContract = {
  adapterVersion: string;
  parserContract: string;
  sourceLineage: string;
  supportedGame: ProductSourceGame;
  format: DiscoveryFormat;
  requiredSurfaces: readonly string[];
  sourceOrigin: string;
  documentPathnamePrefixes: readonly string[];
  imagePathnamePrefixes: readonly string[];
  partition: "EN-OCEANIA" | "EN-ASIA" | "EN-US";
  // Registration facts that reconciliation reads for this version: which
  // areas a successful run refreshes and whether dynamically discovered
  // requests inherit the discovery request's headers.
  reconciliationAreas: readonly ("catalogue" | "errata")[];
  inheritDiscoveryRequestHeaders: boolean;
  listingReconciliation: ListingReconciliationTraits;
  requestUrlForDiscovery?: () => string;
  requestUrlForSurface: (surface: string) => string;
  parse: (surface: OfficialSourceSurface, bytes: Uint8Array) => readonly OfficialSourceObservation[];
  discoverRequests: (
    bytes: Uint8Array,
    context: OfficialSourceSurface,
  ) => readonly {
    role: "listing" | "detail" | "product_detail" | "image";
    discoveryKey?: string;
    url: string;
    headers: Record<string, string>;
  }[];
};

// Parser behaviour flags that discriminate the live Source Adapter Versions.
// Every live version reads the 2026-08 restructured Bandai
// sites, and parses the live product detail pages; those former flags are
// no longer modelled because no live version takes the other branch.
export type LiveContractFlags = {
  // one-piece-en: the Card List leaf publishes inline Card modals, so the
  // decoder derives the complete One Piece catalogue from them.
  expandedOnePieceCatalogue: boolean;
  // fusion-world-en and the Gundam locales: listings close their publisher
  // totals to unique full locators and schedule Card details only at a leaf.
  catalogueComplete: boolean;
  // digimon-en: the complete Card List leaf is the popup inventory.
  completeDigimonCatalogue: boolean;
  // Fusion World Energy Markers publish no rarity block and Digimon Q&A
  // answers nest Related Cards.
  optionalCardFields: boolean;
  // The live Fusion World page shapes retained by the third full-scale
  // production run (anchored product status sections, Errata Applied
  // annotations and season-precision releases).
  liveShapes: boolean;
};

export type LiveContractVersion = LiveContractFlags & {
  adapterVersion: string;
  parserContract: string;
  // Exact surface URL overrides this version pins differently from its
  // lineage definition.
  urls?: Readonly<Record<string, string>>;
};

export type RawAdapterDefinition = {
  sourceLineage: string;
  supportedGame: ProductSourceGame;
  format: DiscoveryFormat;
  sourceOrigin: string;
  documentPathnamePrefixes: readonly string[];
  imagePathnamePrefixes: readonly string[];
  partition: "EN-OCEANIA" | "EN-ASIA" | "EN-US";
  reconciliationAreas: readonly ("catalogue" | "errata")[];
  inheritDiscoveryRequestHeaders: boolean;
  listingReconciliation: ListingReconciliationTraits;
  requiredSurfaces: readonly string[];
  urls: Readonly<Record<string, string>>;
  version: LiveContractVersion;
};
