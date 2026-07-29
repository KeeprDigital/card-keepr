import type { Memberships } from "./reconciliation-model";
import { canonicalJson } from "./serialization";

export type RelationshipKind =
  | "product"
  | "distribution_context"
  | "source_bucket";

export type RelationshipEvidence = {
  source_lineage: string;
  relationship_kind: RelationshipKind;
  relationship_value: string;
  source_observation_ids: string[];
  first_revision_id: string;
  last_observed_revision_id: string;
  current: boolean;
  last_missing_revision_id: string | null;
};

export type RelationshipEvidenceRow = {
  source_lineage: string;
  source_observation_id: string;
  relationship_kind: RelationshipKind;
  relationship_value: string;
  first_revision_id: string;
  last_observed_revision_id: string;
  current: number;
  last_missing_revision_id: string | null;
};

export function membershipEntries(
  memberships: Memberships,
): {
  relationship_kind: RelationshipKind;
  relationship_value: string;
}[] {
  return [
    ...memberships.products.map((relationship_value) => ({
      relationship_kind: "product" as const,
      relationship_value,
    })),
    ...memberships.distribution_contexts.map((relationship_value) => ({
      relationship_kind: "distribution_context" as const,
      relationship_value,
    })),
    ...memberships.source_buckets.map((relationship_value) => ({
      relationship_kind: "source_bucket" as const,
      relationship_value,
    })),
  ];
}

export function aggregateRelationshipEvidence(
  rows: readonly RelationshipEvidenceRow[],
): RelationshipEvidence[] {
  const grouped = new Map<string, RelationshipEvidenceRow[]>();
  for (const row of rows) {
    const key = canonicalJson([
      row.source_lineage,
      row.relationship_kind,
      row.relationship_value,
    ]);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return [...grouped.values()]
    .map((evidence) => {
      const active = evidence.filter((row) => row.current === 1);
      const latest =
        active[active.length - 1] ?? evidence[evidence.length - 1]!;
      return {
        source_lineage: latest.source_lineage,
        relationship_kind: latest.relationship_kind,
        relationship_value: latest.relationship_value,
        source_observation_ids: [
          ...new Set(evidence.map((row) => row.source_observation_id)),
        ].sort(),
        first_revision_id: evidence[0]!.first_revision_id,
        last_observed_revision_id: latest.last_observed_revision_id,
        current: active.length > 0,
        last_missing_revision_id:
          active.length > 0 ? null : latest.last_missing_revision_id,
      };
    })
    .sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)),
    );
}
