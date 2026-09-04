import type { Memberships } from "./reconciliation-model";
import { canonicalJson } from "../shared";

export type RelationshipKind = "product" | "distribution_context" | "source_bucket";

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
  first_revision_order?: string;
  last_observed_revision_order?: string;
  current: number;
  last_missing_revision_id: string | null;
};

export function membershipEntries(memberships: Memberships): {
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

export function aggregateRelationshipEvidence(rows: readonly RelationshipEvidenceRow[]): RelationshipEvidence[] {
  const grouped = new Map<string, RelationshipEvidenceRow[]>();
  for (const row of rows) {
    const key = canonicalJson([row.source_lineage, row.relationship_kind, row.relationship_value]);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return [...grouped.values()]
    .map((evidence) => {
      const earliest = [...evidence].sort(compareFirstEvidenceOrder)[0]!;
      const active = evidence.filter((row) => row.current === 1);
      const latest = [...(active.length > 0 ? active : evidence)].sort(compareLastEvidenceOrder).at(-1)!;
      return {
        source_lineage: latest.source_lineage,
        relationship_kind: latest.relationship_kind,
        relationship_value: latest.relationship_value,
        source_observation_ids: [...new Set(evidence.map((row) => row.source_observation_id))].sort(),
        first_revision_id: earliest.first_revision_id,
        last_observed_revision_id: latest.last_observed_revision_id,
        current: active.length > 0,
        last_missing_revision_id: active.length > 0 ? null : latest.last_missing_revision_id,
      };
    })
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function compareFirstEvidenceOrder(left: RelationshipEvidenceRow, right: RelationshipEvidenceRow): number {
  const leftKey = canonicalJson([
    left.first_revision_order ?? left.first_revision_id,
    left.first_revision_id,
    left.source_observation_id,
  ]);
  const rightKey = canonicalJson([
    right.first_revision_order ?? right.first_revision_id,
    right.first_revision_id,
    right.source_observation_id,
  ]);
  return leftKey.localeCompare(rightKey);
}

function compareLastEvidenceOrder(left: RelationshipEvidenceRow, right: RelationshipEvidenceRow): number {
  const leftKey = canonicalJson([
    left.last_observed_revision_order ?? left.last_observed_revision_id,
    left.last_observed_revision_id,
    left.source_observation_id,
  ]);
  const rightKey = canonicalJson([
    right.last_observed_revision_order ?? right.last_observed_revision_id,
    right.last_observed_revision_id,
    right.source_observation_id,
  ]);
  return leftKey.localeCompare(rightKey);
}
