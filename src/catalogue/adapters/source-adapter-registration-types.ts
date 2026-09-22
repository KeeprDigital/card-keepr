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

export type ExtractedSourceRequest = {
  role: "listing" | "detail" | "product_detail" | "image";
  discoveryKey?: string;
  url: string;
  headers: Record<string, string>;
};

export type SourceAdapterParent = Readonly<{
  requestId: string;
  snapshotId: string;
  role: string;
  url: string;
  mediaType: string | null;
  retrievedAt: string;
  contentSha256: string;
  bytes: Uint8Array;
}>;

export type SourceAdapterParseContext = Readonly<{
  url: string;
  mediaType: string | null;
  requestId?: string;
  /** Exact retained discovery ancestors, nearest first; absent for legacy parsers. */
  parents?: readonly SourceAdapterParent[];
}>;

export type SourcePrintingIdentityEvidence = Readonly<{
  cardDesignKey?: string;
  observedCardAndPrinting: {
    card: { game: string; name: string; official_identity: { kind: string; value: string | null } } | null;
    printing: { game_data: { profile: string; attributes: Record<string, unknown> } | null } | null;
  };
  locator: string | null;
  variantKey: string | null;
  artworkFingerprint: string | null;
}>;

export type SourceAdapterRegistration = Readonly<{
  adapterVersion: string;
  sourceLineage: string;
  supportedGame: string;
  gameProfileVersion: string;
  parserContract: string;
  maximumSnapshotBytes: number;
  /** A larger exact archive transport never widens ordinary document/image bodies. */
  archiveExtraction?: {
    matches: (context: { url: string; requestId?: string }) => boolean;
    pin: (context: { url: string; requestId: string; compressedBytes: number }) => {
      cutoff: string;
      limits: { compressedBytes: number; decompressedBytes: number; recordBytes: number; records: number };
    };
    record: (
      bytes: Uint8Array,
      cutoff: string,
    ) => {
      sourceKey: string;
      exclusion: string | null;
      observations: readonly { sourceKey: string; value: unknown }[];
      requests: readonly ExtractedSourceRequest[];
    };
    maximumSnapshotBytes: number;
  };
  requestCapacity: number;
  /**
   * Discovered request roles this scope admits into a run's collection. Absent
   * means every role. Dropped requests stay in the sealed observations as the
   * adapter's discovery claims; they are never acquired by this scope.
   */
  acquiredDiscoveryRoles?: readonly ExtractedSourceRequest["role"][];
  /** Retained access-policy floor after HTTP 429; longer Retry-After remains binding. */
  minimumRateLimitBackoffMilliseconds?: number;
  coverageLossThreshold?: Readonly<{ absolute: number; fraction: number }>;
  origin: "production";
  requestSurface: Readonly<{ kind: "credential-free-https" }> | Readonly<{ kind: "exact-url"; url: string }>;
  reconciliationCapability: "catalogue" | "errata" | "unavailable";
  /** Whether source-qualified Printing evidence is sufficient or an owner decision is mandatory. */
  printingAdmission?: "owner_review" | "source_qualification";
  /** Proven source-specific identity rule; retained physical evidence is checked separately. */
  qualifiesPrintingIdentity?: (evidence: SourcePrintingIdentityEvidence) => boolean;
  /**
   * What establishes a new source-qualified Printing's appearance. The default
   * requires retained Printing Image proof of a demonstrably novel appearance.
   * `qualified_source_record` admits a Printing that `qualifiesPrintingIdentity`
   * accepts from its structurally complete source record alone; it publishes
   * with an explicit image gap until image bytes are acquired.
   */
  printingNoveltyProof?: "printing_image" | "qualified_source_record";
  /** Source-scoped design evidence may associate Cards only under this exact parser qualification. */
  qualifiesCardDesignIdentity?: (evidence: SourcePrintingIdentityEvidence) => boolean;
  reconciliationAreas?: readonly ("catalogue" | "errata")[];
  inheritDiscoveryRequestHeaders?: boolean;
  retainedParentContext?: Readonly<{ maximumDepth: number; maximumTotalBytes: number }>;
  /** These discovered roles bind one parent; another parent is conflicting source evidence. */
  singleDiscoveryParentRoles?: readonly ExtractedSourceRequest["role"][];
  listingReconciliation?: ListingReconciliationTraits;
  recordExtraction?: {
    matches: (context: { mediaType: string | null; url: string }) => boolean;
    extract: (
      source: () => AsyncIterable<string>,
      context: SourceAdapterParseContext,
    ) => Promise<{
      count: number;
      pagination: Record<string, unknown> | null;
      requests: Iterable<ExtractedSourceRequest> | AsyncIterable<ExtractedSourceRequest>;
      records: AsyncIterable<{
        sourceKey: string;
        value: unknown;
        request: ExtractedSourceRequest | null;
      }>;
    }>;
  };
  /** Ordered top-level record containers understood by this JSON parser. */
  jsonRecordContainers?: readonly string[];
  parse?: (document: unknown) => readonly unknown[] | Promise<readonly unknown[]>;
  parseBytes?: (
    bytes: Uint8Array,
    context: SourceAdapterParseContext,
  ) => readonly unknown[] | Promise<readonly unknown[]>;
  discoverRequests?: (
    bytes: Uint8Array,
    context: SourceAdapterParseContext,
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
        reconciliationAreas?: readonly ("catalogue" | "errata")[];
        reconciliationCapability?: "catalogue" | "errata";
        printingAdmission?: "owner_review" | "source_qualification";
        /** Overrides the registration's acquired discovery roles for this named scope. */
        acquiredDiscoveryRoles?: readonly ExtractedSourceRequest["role"][];
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
