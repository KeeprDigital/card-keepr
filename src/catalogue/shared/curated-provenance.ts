export type CuratedFieldTarget = Readonly<{
  kind: "field";
  entity_type: "card" | "printing" | "product" | "release" | "distribution_context" | "erratum" | "legality_rule";
  entity_id: string;
  path: string;
}>;

export type CuratedRelationshipTarget = Readonly<{
  kind: "relationship";
  relationship_kind:
    | "printing-product"
    | "printing-distribution-context"
    | "distribution-context-product"
    | "product-card";
  from: Readonly<{ type: "printing" | "distribution_context" | "product"; id: string }>;
  to: Readonly<{ type: "product" | "distribution_context" | "card"; id: string }>;
}>;

export type CuratedEvidence = Readonly<
  { kind: "source_observation"; id: string } | { kind: "owner_reference"; uri: string; content_digest: string }
>;

export type CuratedProvenance = Readonly<{
  curated_revision_id: string;
  content_digest: string;
  target: CuratedFieldTarget | CuratedRelationshipTarget;
  rationale: string;
  evidence: readonly CuratedEvidence[];
  author: string;
  reviewed_source_value: unknown;
}>;

export type CuratedProvenanceBearing = {
  curated_provenance?: readonly CuratedProvenance[];
};
