// Registration shapes of a Source Adapter Version that both the adapter
// registry and the raw Official Source contracts describe. This module is a
// leaf: it declares types only and imports nothing, so the raw contracts can
// name these shapes without importing the registry that registers them.
// `source-adapters` re-exports them.

// Registration facts reconciliation reads about a lineage's listing
// evidence (ADR 0004: these lived in code-side version lists before).
export type ListingReconciliationTraits = Readonly<{
  // Listing observations are publisher pages closed by full locator.
  groupsPublisherPages: boolean;
  // Listing identity is read from listing_identity_evidence rather than
  // the generic identity_evidence.
  strictListingIdentity: boolean;
  // How the same locator observed by two listing requests is judged
  // compatible: by observation semantic, by canonical identity, or never.
  duplicateLocatorCompatibility: "semantic" | "canonical" | "never";
}>;

export type OfficialSourceContract = Readonly<{
  supportedGame: "one-piece" | "fusion-world" | "digimon" | "gundam" | "riftbound";
  partition: "EN-OCEANIA" | "EN-ASIA" | "EN-US";
  origin: string;
  documentPathnamePrefixes: readonly string[];
  imagePathnamePrefixes: readonly string[];
  documentAuthorities?: readonly { origin: string; pathnamePrefixes: readonly string[] }[];
  requiredSurfaces: readonly string[];
}>;

export type SourceAdapterRegistration = Readonly<{
  adapterVersion: string;
  sourceLineage: string;
  supportedGame: string;
  gameProfileVersion: string;
  parserContract: string;
  maximumSnapshotBytes: number;
  requestCapacity: number;
  coverageLossThreshold?: Readonly<{ absolute: number; fraction: number }>;
  origin: "production";
  requestSurface: Readonly<{ kind: "credential-free-https" }> | Readonly<{ kind: "exact-url"; url: string }>;
  reconciliationCapability: "catalogue" | "errata" | "unavailable";
  /** Whether source-qualified Printing evidence is sufficient or an owner decision is mandatory. */
  printingAdmission?: "owner_review" | "source_qualification";
  reconciliationAreas?: readonly ("catalogue" | "errata")[];
  inheritDiscoveryRequestHeaders?: boolean;
  listingReconciliation?: ListingReconciliationTraits;
  parse?: (document: unknown) => readonly unknown[] | Promise<readonly unknown[]>;
  parseBytes?: (
    bytes: Uint8Array,
    context: { mediaType: string | null; url: string; requestId?: string },
  ) => readonly unknown[] | Promise<readonly unknown[]>;
  discoverRequests?: (
    bytes: Uint8Array,
    context: { mediaType: string | null; url: string; requestId?: string },
  ) => readonly {
    role: "listing" | "detail" | "product_detail" | "image";
    discoveryKey?: string;
    url: string;
    headers: Record<string, string>;
  }[];
  coverageContracts?: Readonly<
    Record<
      string,
      Readonly<{
        description: string;
        printingAdmission?: "owner_review" | "source_qualification";
        /** Exact Card identities whose complete variant inventory belongs to this scope. */
        cardIdentities?: readonly { kind: string; value: string }[];
        requiredSurfaces: readonly string[];
        requestUrlForSurface: (surface: string) => string;
      }>
    >
  >;
  requiredSurfaces?: readonly string[];
  requestUrlForDiscovery?: () => string;
  requestUrlForSurface?: (surface: string) => string;
  officialSourceContract?: OfficialSourceContract;
}>;
