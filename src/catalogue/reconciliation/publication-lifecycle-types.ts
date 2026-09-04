// The lifecycle a published entity carries across Catalogue Revisions: the
// revision that first published it, the revision that last observed it, and
// whether an Official Source has withdrawn it. This module is a leaf: it
// declares types only and imports nothing, so the reconciliation and product
// release publication modules can both read it without importing each other.
// `reconciliation-publication` re-exports it.

export type NormalizedLifecycle = {
  first_revision_id: string;
  last_observed_revision_id: string;
  withdrawn: boolean;
  withdrawal?: {
    revision_id: string;
    evidence: Record<string, unknown>;
  } | null;
};
