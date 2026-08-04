export type CuratedProvenance = Readonly<{
  curated_revision_id: string;
  content_digest: string;
  target: Readonly<Record<string, unknown>>;
  rationale: string;
  evidence: readonly Readonly<Record<string, unknown>>[];
  author: string;
  reviewed_source_value: unknown;
}>;

export type CuratedProvenanceBearing = {
  curated_provenance?: readonly CuratedProvenance[];
};
