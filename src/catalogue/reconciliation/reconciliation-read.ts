import type { Memberships } from "./reconciliation-model";
import type { LocatorEvidence, LocatorEvidenceCollection } from "./reconciliation-publication";
import {
  disappearedCardsStatement,
  disappearedPrintingsStatement,
  printingRelationshipsForLineageStatement,
  reconciledPrintingDocumentStatement,
  reconciledPrintingLocatorsStatement,
  reconciledPrintingRelationshipsStatement,
} from "./reconciliation-read-repository";
import {
  aggregateRelationshipEvidence,
  membershipEntries,
  type RelationshipEvidenceRow,
} from "./reconciliation-relationships";
import type { ReconciledPrintingRow } from "./reconciliation-repository";

type MembershipRow = RelationshipEvidenceRow;

export async function relationshipDisappearanceWarnings(
  database: D1Database,
  printingId: string,
  sourceLineage: string,
  memberships: Memberships,
): Promise<Record<string, unknown>[]> {
  const existing = await printingRelationshipsForLineageStatement(database, {
    printingId: printingId,
    sourceLineage: sourceLineage,
  }).all<MembershipRow>();
  const current = new Set(membershipEntries(memberships).map(membershipKey));
  const disappeared = new Map(
    existing.results.filter((row) => !current.has(membershipKey(row))).map((row) => [membershipKey(row), row]),
  );
  return [...disappeared.values()].map((row) => ({
    code: "relationship_not_observed",
    printing_id: printingId,
    relationship_kind: row.relationship_kind,
    relationship_value: row.relationship_value,
    detail: "The relationship was not observed in this complete run; it remains historical and is not withdrawn.",
  }));
}

export async function printingDisappearanceWarnings(
  database: D1Database,
  sourceLineage: string,
  observedPrintingIds: readonly string[],
): Promise<Record<string, unknown>[]> {
  const result = await disappearedPrintingsStatement(database, {
    sourceLineage: sourceLineage,
    observedPrintingIdsJson: JSON.stringify(observedPrintingIds),
  }).all<{ id: string }>();
  return result.results.map((row) => ({
    code: "record_not_observed",
    printing_id: row.id,
    detail: "The Printing was not observed in this complete run; it remains historical and is not withdrawn.",
  }));
}

export async function cardDisappearanceWarnings(
  database: D1Database,
  sourceLineage: string,
  observedCardIds: readonly string[],
): Promise<Record<string, unknown>[]> {
  const result = await disappearedCardsStatement(database, {
    sourceLineage: sourceLineage,
    observedCardIdsJson: JSON.stringify(observedCardIds),
  }).all<{ id: string }>();
  return result.results.map((row) => ({
    code: "record_not_observed",
    card_id: row.id,
    detail: "The Card was not observed in this complete run; it remains historical and is not withdrawn.",
  }));
}

export async function publicReconciledPrinting(
  database: D1Database,
  printingId: string,
): Promise<Record<string, unknown> | null> {
  const printing = await reconciledPrintingDocumentStatement(database, printingId).first<ReconciledPrintingRow>();
  if (printing === null) return null;
  const [locators, memberships] = await Promise.all([
    reconciledPrintingLocatorsStatement(database, printingId).all<
      Omit<LocatorEvidence, "current"> & { current: number }
    >(),
    reconciledPrintingRelationshipsStatement(database, printingId).all<MembershipRow>(),
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
  const allRelationshipEvidence = aggregateRelationshipEvidence(memberships.results);
  for (const membership of allRelationshipEvidence) {
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
    locators: locatorEvidenceCollection(locators.results),
    memberships: { current, historical },
    relationship_evidence: allRelationshipEvidence.filter(
      (relationship) => relationship.relationship_kind !== "source_bucket",
    ),
    lifecycle: lifecycle(
      printing.first_revision_id,
      printing.last_observed_revision_id,
      printing.withdrawn === 1,
      printing.withdrawal_revision_id,
      printing.withdrawal_evidence_json,
    ),
  };
}

function locatorEvidenceCollection(
  rows: readonly (Omit<LocatorEvidence, "current"> & { current: number })[],
): LocatorEvidenceCollection {
  const evidence = rows.map((row) => ({
    ...row,
    current: row.current === 1,
  }));
  return {
    current: evidence.filter((locator) => locator.current),
    historical: evidence.filter((locator) => !locator.current),
  };
}

function membershipKey(row: Pick<MembershipRow, "relationship_kind" | "relationship_value">): string {
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
  return kind === "product" ? "products" : kind === "distribution_context" ? "distribution_contexts" : "source_buckets";
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
