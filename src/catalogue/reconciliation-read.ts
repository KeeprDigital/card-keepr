import type { Memberships } from "./reconciliation-model";
import type { ReconciledPrintingRow } from "./reconciliation-repository";
import type { RelationshipEvidence } from "./reconciliation-publication";

type MembershipRow = {
  source_lineage: string;
  source_observation_id: string;
  relationship_kind:
    | "product"
    | "distribution_context"
    | "source_bucket";
  relationship_value: string;
  first_revision_id: string;
  last_observed_revision_id: string;
  current: number;
  last_missing_revision_id: string | null;
};

export async function relationshipDisappearanceWarnings(
  database: D1Database,
  printingId: string,
  sourceLineage: string,
  memberships: Memberships,
): Promise<Record<string, unknown>[]> {
  const existing = await database
    .prepare(
      `SELECT source_lineage, source_observation_id,
              relationship_kind, relationship_value,
              first_revision_id, last_observed_revision_id,
              current, last_missing_revision_id
       FROM reconciled_printing_memberships
       WHERE printing_id = ? AND source_lineage = ? AND current = 1
       ORDER BY relationship_kind, relationship_value`,
    )
    .bind(printingId, sourceLineage)
    .all<MembershipRow>();
  const current = new Set(membershipEntries(memberships).map(membershipKey));
  const disappeared = new Map(
    existing.results
      .filter((row) => !current.has(membershipKey(row)))
      .map((row) => [membershipKey(row), row]),
  );
  return [...disappeared.values()]
    .map((row) => ({
      code: "relationship_not_observed",
      printing_id: printingId,
      relationship_kind: row.relationship_kind,
      relationship_value: row.relationship_value,
      detail:
        "The relationship was not observed in this complete run; it remains historical and is not withdrawn.",
    }));
}

export async function printingDisappearanceWarnings(
  database: D1Database,
  sourceLineage: string,
  observedPrintingIds: readonly string[],
): Promise<Record<string, unknown>[]> {
  const exclusion =
    observedPrintingIds.length === 0
      ? ""
      : `AND printing.id NOT IN (${observedPrintingIds.map(() => "?").join(", ")})`;
  const result = await database
    .prepare(
      `SELECT DISTINCT printing.id
       FROM reconciled_printings AS printing
       JOIN reconciled_printing_locators AS locator
         ON locator.printing_id = printing.id
       WHERE locator.source_lineage = ?
         ${exclusion}
         AND printing.withdrawn = 0
       ORDER BY printing.id`,
    )
    .bind(sourceLineage, ...observedPrintingIds)
    .all<{ id: string }>();
  return result.results.map((row) => ({
    code: "record_not_observed",
    printing_id: row.id,
    detail:
      "The Printing was not observed in this complete run; it remains historical and is not withdrawn.",
  }));
}

export async function cardDisappearanceWarnings(
  database: D1Database,
  sourceLineage: string,
  observedCardIds: readonly string[],
): Promise<Record<string, unknown>[]> {
  const exclusion =
    observedCardIds.length === 0
      ? ""
      : `AND card.id NOT IN (${observedCardIds.map(() => "?").join(", ")})`;
  const result = await database
    .prepare(
      `SELECT DISTINCT card.id
       FROM reconciled_cards AS card
       JOIN reconciled_card_observations AS observation
         ON observation.card_id = card.id
       WHERE observation.source_lineage = ?
         AND observation.current = 1
         ${exclusion}
         AND card.withdrawn = 0
       ORDER BY card.id`,
    )
    .bind(sourceLineage, ...observedCardIds)
    .all<{ id: string }>();
  return result.results.map((row) => ({
    code: "record_not_observed",
    card_id: row.id,
    detail:
      "The Card was not observed in this complete run; it remains historical and is not withdrawn.",
  }));
}

export async function publicReconciledPrinting(
  database: D1Database,
  printingId: string,
): Promise<Record<string, unknown> | null> {
  const printing = await database
    .prepare("SELECT * FROM reconciled_printings WHERE id = ?")
    .bind(printingId)
    .first<ReconciledPrintingRow>();
  if (printing === null) return null;
  const [locators, memberships] = await Promise.all([
    database
      .prepare(
        `SELECT locator FROM reconciled_printing_locators
         WHERE printing_id = ? ORDER BY locator`,
      )
      .bind(printingId)
      .all<{ locator: string }>(),
    database
      .prepare(
        `SELECT source_lineage, source_observation_id,
                relationship_kind, relationship_value,
                first_revision_id, last_observed_revision_id,
                current, last_missing_revision_id
         FROM reconciled_printing_memberships
         WHERE printing_id = ?
         ORDER BY relationship_kind, relationship_value`,
      )
      .bind(printingId)
      .all<MembershipRow>(),
  ]);
  const current = membershipProjection<string[]>(() => []);
  const historical = membershipProjection<
    {
      id: string;
      first_revision_id: string;
      last_observed_revision_id: string;
      current: false;
      last_missing_revision_id: string | null;
    }[]
  >(() => []);
  const relationshipEvidence = aggregateRelationshipEvidence(
    memberships.results,
  );
  for (const membership of relationshipEvidence) {
    const key = projectionKey(membership.relationship_kind);
    if (membership.current) {
      if (!current[key].includes(membership.relationship_value)) {
        current[key].push(membership.relationship_value);
      }
    } else {
      historical[key].push({
        id: membership.relationship_value,
        first_revision_id: membership.first_revision_id,
        last_observed_revision_id: membership.last_observed_revision_id,
        current: false,
        last_missing_revision_id: membership.last_missing_revision_id,
      });
    }
  }
  return {
    id: printing.id,
    card_id: printing.card_id,
    locators: locators.results.map((row) => row.locator),
    memberships: { current, historical },
    relationship_evidence: relationshipEvidence,
    lifecycle: lifecycle(
      printing.first_revision_id,
      printing.last_observed_revision_id,
      printing.withdrawn === 1,
      printing.withdrawal_revision_id,
      printing.withdrawal_evidence_json,
    ),
  };
}

export function membershipEntries(memberships: Memberships): MembershipRow[] {
  return [
    ...memberships.products.map((relationship_value) => ({
      relationship_kind: "product" as const,
      relationship_value,
      source_lineage: "",
      source_observation_id: "",
      first_revision_id: "",
      last_observed_revision_id: "",
      current: 1,
      last_missing_revision_id: null,
    })),
    ...memberships.distribution_contexts.map((relationship_value) => ({
      relationship_kind: "distribution_context" as const,
      relationship_value,
      source_lineage: "",
      source_observation_id: "",
      first_revision_id: "",
      last_observed_revision_id: "",
      current: 1,
      last_missing_revision_id: null,
    })),
    ...memberships.source_buckets.map((relationship_value) => ({
      relationship_kind: "source_bucket" as const,
      relationship_value,
      source_lineage: "",
      source_observation_id: "",
      first_revision_id: "",
      last_observed_revision_id: "",
      current: 1,
      last_missing_revision_id: null,
    })),
  ];
}

function aggregateRelationshipEvidence(
  rows: readonly MembershipRow[],
): RelationshipEvidence[] {
  const grouped = new Map<string, MembershipRow[]>();
  for (const row of rows) {
    const key = `${row.source_lineage}\u0000${row.relationship_kind}\u0000${row.relationship_value}`;
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
        source_observation_ids: evidence
          .map((row) => row.source_observation_id)
          .sort(),
        first_revision_id: evidence[0]!.first_revision_id,
        last_observed_revision_id: latest.last_observed_revision_id,
        current: active.length > 0,
        last_missing_revision_id:
          active.length > 0 ? null : latest.last_missing_revision_id,
      };
    })
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
}

function membershipKey(
  row: Pick<MembershipRow, "relationship_kind" | "relationship_value">,
): string {
  return `${row.relationship_kind}\u0000${row.relationship_value}`;
}

function membershipProjection<T>(create: () => T): {
  products: T;
  distribution_contexts: T;
  source_buckets: T;
} {
  return {
    products: create(),
    distribution_contexts: create(),
    source_buckets: create(),
  };
}

function projectionKey(kind: MembershipRow["relationship_kind"]) {
  return kind === "product"
    ? "products"
    : kind === "distribution_context"
      ? "distribution_contexts"
      : "source_buckets";
}

function lifecycle(
  first: string,
  last: string,
  withdrawn = false,
  withdrawalRevision: string | null = null,
  withdrawalEvidence: string | null = null,
): Record<string, unknown> {
  return {
    first_revision_id: first,
    last_observed_revision_id: last,
    withdrawn,
    withdrawal:
      withdrawalEvidence === null
        ? null
        : {
            revision_id: withdrawalRevision,
            evidence: JSON.parse(withdrawalEvidence),
          },
  };
}
