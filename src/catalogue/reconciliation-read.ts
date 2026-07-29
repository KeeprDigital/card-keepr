import type { Memberships } from "./reconciliation-model";
import type { ReconciledPrintingRow } from "./reconciliation-repository";

type MembershipRow = {
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
  memberships: Memberships,
): Promise<Record<string, unknown>[]> {
  const existing = await database
    .prepare(
      `SELECT relationship_kind, relationship_value,
              first_revision_id, last_observed_revision_id,
              current, last_missing_revision_id
       FROM reconciled_printing_memberships
       WHERE printing_id = ? AND current = 1
       ORDER BY relationship_kind, relationship_value`,
    )
    .bind(printingId)
    .all<MembershipRow>();
  const current = new Set(membershipEntries(memberships).map(membershipKey));
  return existing.results
    .filter((row) => !current.has(membershipKey(row)))
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
      : `AND id NOT IN (${observedPrintingIds.map(() => "?").join(", ")})`;
  const result = await database
    .prepare(
      `SELECT id FROM reconciled_printings
       WHERE source_lineage = ?
         ${exclusion}
         AND withdrawn = 0
       ORDER BY id`,
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
  supportedGame: string,
  observedCardIds: readonly string[],
): Promise<Record<string, unknown>[]> {
  const exclusion =
    observedCardIds.length === 0
      ? ""
      : `AND id NOT IN (${observedCardIds.map(() => "?").join(", ")})`;
  const result = await database
    .prepare(
      `SELECT id FROM reconciled_cards
       WHERE supported_game = ?
         ${exclusion}
         AND withdrawn = 0
       ORDER BY id`,
    )
    .bind(supportedGame, ...observedCardIds)
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
        `SELECT relationship_kind, relationship_value,
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
  for (const membership of memberships.results) {
    const key = projectionKey(membership.relationship_kind);
    if (membership.current === 1) {
      current[key].push(membership.relationship_value);
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
      first_revision_id: "",
      last_observed_revision_id: "",
      current: 1,
      last_missing_revision_id: null,
    })),
    ...memberships.distribution_contexts.map((relationship_value) => ({
      relationship_kind: "distribution_context" as const,
      relationship_value,
      first_revision_id: "",
      last_observed_revision_id: "",
      current: 1,
      last_missing_revision_id: null,
    })),
    ...memberships.source_buckets.map((relationship_value) => ({
      relationship_kind: "source_bucket" as const,
      relationship_value,
      first_revision_id: "",
      last_observed_revision_id: "",
      current: 1,
      last_missing_revision_id: null,
    })),
  ];
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
