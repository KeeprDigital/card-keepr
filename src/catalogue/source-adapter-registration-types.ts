// Registration shapes of a Source Adapter Version that both the adapter
// registry and the raw Official Source contracts describe. This module is a
// leaf: it declares types only and imports nothing, so the raw contracts can
// name these shapes without importing the registry that registers them.
// `source-adapters` re-exports them.

// Registration facts reconciliation reads about a lineage's listing
// evidence (ADR 0004: these lived in code-side version lists before).
export type ListingReconciliationTraits = Readonly<{
  // The releases surface also carries release-timing Legality Rules.
  releasesSurfaceCarriesLegality: boolean;
  // Listing observations are publisher pages closed by full locator.
  groupsPublisherPages: boolean;
  // Listing identity is read from listing_identity_evidence rather than
  // the generic identity_evidence.
  strictListingIdentity: boolean;
  // How the same locator observed by two listing requests is judged
  // compatible: by observation semantic, by canonical identity, or never.
  duplicateLocatorCompatibility: "semantic" | "canonical" | "never";
}>;
