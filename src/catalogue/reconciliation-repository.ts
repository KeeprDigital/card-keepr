import type { FixtureCandidate } from "./fixture";
import {
  compatibilityFields,
  type Memberships,
  type PrintingCompatibility,
  type VocabularyWarning,
  type Withdrawal,
} from "./reconciliation-model";
import { canonicalJson } from "./serialization";

export type ReconciledCardRow = {
  id: string;
  supported_game: string;
  official_identity_kind: string;
  official_identity_value: string;
  first_revision_id: string;
  last_observed_revision_id: string;
  withdrawn: number;
  withdrawal_revision_id: string | null;
  withdrawal_evidence_json: string | null;
};

export type ReconciledPrintingRow = PrintingCompatibility & {
  id: string;
  first_revision_id: string;
  last_observed_revision_id: string;
  withdrawn: number;
  withdrawal_revision_id: string | null;
  withdrawal_evidence_json: string | null;
};

type CandidatePlanRow = {
  ingestion_run_id: string;
  source_observation_set_id: string;
  source_snapshot_id: string;
  source_observation_id: string;
  card_id: string;
  printing_id: string;
  source_lineage: string;
  locator: string;
  compatibility_json: string;
  memberships_json: string;
  warnings_json: string;
  withdrawal_json: string | null;
};

type MembershipRow = {
  relationship_kind:
    | "product"
    | "distribution_context"
    | "source_bucket";
  relationship_value: string;
};

const compatibilityPredicate = compatibilityFields
  .map((field) => `${field} IS ?`)
  .join(" AND ");

export async function existingCard(
  database: D1Database,
  input: {
    supportedGame: string;
    identityKind: string;
    identityValue: string;
  },
): Promise<ReconciledCardRow | null> {
  return database
    .prepare(
      `SELECT * FROM reconciled_cards
       WHERE supported_game = ?
         AND official_identity_kind = ?
         AND official_identity_value = ?`,
    )
    .bind(input.supportedGame, input.identityKind, input.identityValue)
    .first<ReconciledCardRow>();
}

export async function compatiblePrintings(
  database: D1Database,
  compatibility: PrintingCompatibility,
): Promise<ReconciledPrintingRow[]> {
  const result = await database
    .prepare(
      `SELECT * FROM reconciled_printings
       WHERE ${compatibilityPredicate}
       ORDER BY id`,
    )
    .bind(...compatibilityValues(compatibility))
    .all<ReconciledPrintingRow>();
  return result.results;
}

export async function printingAtLocator(
  database: D1Database,
  sourceLineage: string,
  locator: string,
): Promise<ReconciledPrintingRow | null> {
  return database
    .prepare(
      `SELECT printing.*
       FROM reconciled_printing_locators AS locator
       JOIN reconciled_printings AS printing
         ON printing.id = locator.printing_id
       WHERE locator.source_lineage = ? AND locator.locator = ?`,
    )
    .bind(sourceLineage, locator)
    .first<ReconciledPrintingRow>();
}

export async function relationshipDisappearanceWarnings(
  database: D1Database,
  printingId: string,
  memberships: Memberships,
): Promise<Record<string, unknown>[]> {
  const existing = await database
    .prepare(
      `SELECT relationship_kind, relationship_value
       FROM reconciled_printing_memberships
       WHERE printing_id = ?
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
  observedPrintingId: string,
): Promise<Record<string, unknown>[]> {
  const result = await database
    .prepare(
      `SELECT id FROM reconciled_printings
       WHERE source_lineage = ? AND id <> ?
       ORDER BY id`,
    )
    .bind(sourceLineage, observedPrintingId)
    .all<{ id: string }>();
  return result.results.map((row) => ({
    code: "record_not_observed",
    printing_id: row.id,
    detail:
      "The Printing was not observed in this complete run; it remains historical and is not withdrawn.",
  }));
}

export async function persistReviewableCandidate(
  database: D1Database,
  input: {
    runId: string;
    observationSetId: string;
    sourceSnapshotId: string;
    sourceObservationId: string;
    sourceLineage: string;
    locator: string;
    compatibility: PrintingCompatibility;
    memberships: Memberships;
    withdrawal: Withdrawal | null;
    warnings: readonly (VocabularyWarning | Record<string, unknown>)[];
    candidate: FixtureCandidate;
    candidateDigest: string;
    observedAt: string;
  },
): Promise<void> {
  const approvalDeadline = new Date(
    Date.parse(input.observedAt) + 7 * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const runWarnings = input.warnings.map((warning) => ({
    code: String(warning.code),
    detail: String(warning.detail),
  }));
  await database.batch([
    database
      .prepare(
        `UPDATE ingestion_runs
         SET state = 'reconciling',
             progress_json =
               '{"completed_stages":["planning","collecting","parsing"],"current_stage":"reconciling"}'
         WHERE id = ? AND state = 'parsing'`,
      )
      .bind(input.runId),
    database
      .prepare(
        `INSERT INTO reconciliation_candidates (
          ingestion_run_id, source_observation_set_id, source_snapshot_id,
          source_observation_id, card_id, printing_id, source_lineage,
          locator, compatibility_json, memberships_json, withdrawal_json,
          warnings_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.runId,
        input.observationSetId,
        input.sourceSnapshotId,
        input.sourceObservationId,
        input.compatibility.card_id,
        input.candidate.printings[0].id,
        input.sourceLineage,
        input.locator,
        canonicalJson(input.compatibility),
        canonicalJson(input.memberships),
        input.withdrawal === null
          ? null
          : canonicalJson(input.withdrawal),
        canonicalJson(input.warnings),
      ),
    database
      .prepare(
        `UPDATE ingestion_runs
         SET state = 'awaiting_approval',
             candidate_json = ?,
             candidate_digest = ?,
             candidate_created_at = ?,
             approval_deadline = ?,
             warnings_json = ?,
             progress_json =
               '{"completed_stages":["planning","collecting","parsing","reconciling"],"current_stage":"awaiting_approval"}'
         WHERE id = ? AND state = 'reconciling'`,
      )
      .bind(
        canonicalJson(input.candidate),
        input.candidateDigest,
        input.observedAt,
        approvalDeadline,
        canonicalJson(runWarnings),
        input.runId,
      ),
  ]);
}

export async function failReconciliation(
  database: D1Database,
  runId: string,
  diagnostics: readonly Record<string, unknown>[],
  observedAt: string,
): Promise<void> {
  const runDiagnostics = diagnostics.map((diagnostic) => ({
    code: String(diagnostic.code),
    detail: String(diagnostic.detail),
  }));
  await database.batch([
    database
      .prepare(
        `UPDATE ingestion_runs
         SET state = 'reconciling',
             progress_json =
               '{"completed_stages":["planning","collecting","parsing"],"current_stage":"reconciling"}'
         WHERE id = ? AND state = 'parsing'`,
      )
      .bind(runId),
    database
      .prepare(
        `UPDATE ingestion_runs
         SET state = 'failed', terminal_at = ?,
             failure_code = 'printing_reconciliation_blocked',
             warnings_json = ?,
             progress_json =
               '{"completed_stages":["planning","collecting","parsing"],"current_stage":"failed"}'
         WHERE id = ? AND state = 'reconciling'`,
      )
      .bind(observedAt, canonicalJson(runDiagnostics), runId),
    database
      .prepare(
        `UPDATE operation_state
         SET active_ingestion_run_id = NULL
         WHERE singleton = 1 AND active_ingestion_run_id = ?`,
      )
      .bind(runId),
  ]);
}

export async function reconciliationPublication(
  database: D1Database,
  runId: string,
  revisionId: string,
): Promise<{
  cardLifecycle: Record<string, unknown>;
  printingLifecycle: Record<string, unknown>;
  statements: D1PreparedStatement[];
} | null> {
  const plan = await database
    .prepare("SELECT * FROM reconciliation_candidates WHERE ingestion_run_id = ?")
    .bind(runId)
    .first<CandidatePlanRow>();
  if (plan === null) return null;
  const compatibility = JSON.parse(
    plan.compatibility_json,
  ) as PrintingCompatibility;
  const memberships = JSON.parse(plan.memberships_json) as Memberships;
  const withdrawal =
    plan.withdrawal_json === null
      ? null
      : (JSON.parse(plan.withdrawal_json) as Withdrawal);
  const candidate = JSON.parse(
    await requiredRunCandidate(database, runId),
  ) as FixtureCandidate;
  const candidateCard = candidate.cards[0];
  const [card, printing] = await Promise.all([
    database
      .prepare("SELECT * FROM reconciled_cards WHERE id = ?")
      .bind(plan.card_id)
      .first<ReconciledCardRow>(),
    database
      .prepare("SELECT * FROM reconciled_printings WHERE id = ?")
      .bind(plan.printing_id)
      .first<ReconciledPrintingRow>(),
  ]);
  const withdrawCard =
    withdrawal?.entity === "card" ||
    withdrawal?.entity === "card_and_printing";
  const withdrawPrinting =
    withdrawal?.entity === "printing" ||
    withdrawal?.entity === "card_and_printing";
  const withdrawalJson =
    withdrawal === null ? null : canonicalJson(withdrawal);
  const cardLifecycle = lifecycle(
    card?.first_revision_id ?? revisionId,
    revisionId,
    card?.withdrawn === 1 || withdrawCard,
    withdrawCard ? revisionId : (card?.withdrawal_revision_id ?? null),
    withdrawCard
      ? withdrawalJson
      : (card?.withdrawal_evidence_json ?? null),
  );
  const printingLifecycle = lifecycle(
    printing?.first_revision_id ?? revisionId,
    revisionId,
    printing?.withdrawn === 1 || withdrawPrinting,
    withdrawPrinting
      ? revisionId
      : (printing?.withdrawal_revision_id ?? null),
    withdrawPrinting
      ? withdrawalJson
      : (printing?.withdrawal_evidence_json ?? null),
  );
  return {
    cardLifecycle,
    printingLifecycle,
    statements: [
      database
        .prepare(
          `INSERT INTO reconciled_cards (
            id, supported_game, official_identity_kind,
            official_identity_value, first_revision_id,
            last_observed_revision_id, withdrawn,
            withdrawal_revision_id, withdrawal_evidence_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET
            last_observed_revision_id = excluded.last_observed_revision_id,
            withdrawn = CASE
              WHEN ? IN ('card', 'card_and_printing') THEN 1
              ELSE reconciled_cards.withdrawn
            END,
            withdrawal_revision_id = CASE
              WHEN ? IN ('card', 'card_and_printing') THEN ?
              ELSE reconciled_cards.withdrawal_revision_id
            END,
            withdrawal_evidence_json = CASE
              WHEN ? IN ('card', 'card_and_printing') THEN ?
              ELSE reconciled_cards.withdrawal_evidence_json
            END`,
        )
        .bind(
          plan.card_id,
          candidateCard.game,
          candidateCard.official_identity.kind,
          candidateCard.official_identity.value,
          card?.first_revision_id ?? revisionId,
          revisionId,
          withdrawCard ? 1 : 0,
          withdrawCard ? revisionId : null,
          withdrawCard ? withdrawalJson : null,
          withdrawal?.entity ?? "",
          withdrawal?.entity ?? "",
          revisionId,
          withdrawal?.entity ?? "",
          withdrawal === null ? null : canonicalJson(withdrawal),
        ),
      database
        .prepare(
          `INSERT INTO reconciled_printings (
            id, card_id, source_lineage, artwork_fingerprint,
            printed_fields_digest, rarity_normalized, treatment,
            first_revision_id, last_observed_revision_id, withdrawn,
            withdrawal_revision_id, withdrawal_evidence_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET
            last_observed_revision_id = excluded.last_observed_revision_id,
            withdrawn = CASE
              WHEN ? IN ('printing', 'card_and_printing') THEN 1
              ELSE reconciled_printings.withdrawn
            END,
            withdrawal_revision_id = CASE
              WHEN ? IN ('printing', 'card_and_printing') THEN ?
              ELSE reconciled_printings.withdrawal_revision_id
            END,
            withdrawal_evidence_json = CASE
              WHEN ? IN ('printing', 'card_and_printing') THEN ?
              ELSE reconciled_printings.withdrawal_evidence_json
            END`,
        )
        .bind(
          plan.printing_id,
          compatibility.card_id,
          compatibility.source_lineage,
          compatibility.artwork_fingerprint,
          compatibility.printed_fields_digest,
          compatibility.rarity_normalized,
          compatibility.treatment,
          printing?.first_revision_id ?? revisionId,
          revisionId,
          withdrawPrinting ? 1 : 0,
          withdrawPrinting ? revisionId : null,
          withdrawPrinting ? withdrawalJson : null,
          withdrawal?.entity ?? "",
          withdrawal?.entity ?? "",
          revisionId,
          withdrawal?.entity ?? "",
          withdrawal === null ? null : canonicalJson(withdrawal),
        ),
      database
        .prepare(
          `INSERT INTO reconciled_printing_locators (
            printing_id, source_lineage, locator,
            first_revision_id, last_observed_revision_id
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (source_lineage, locator) DO UPDATE SET
            last_observed_revision_id = excluded.last_observed_revision_id`,
        )
        .bind(
          plan.printing_id,
          plan.source_lineage,
          plan.locator,
          revisionId,
          revisionId,
        ),
      ...membershipEntries(memberships).map((membership) =>
        database
          .prepare(
            `INSERT INTO reconciled_printing_memberships (
              printing_id, relationship_kind, relationship_value,
              first_revision_id, last_observed_revision_id
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (
              printing_id, relationship_kind, relationship_value
            ) DO UPDATE SET
              last_observed_revision_id =
                excluded.last_observed_revision_id`,
          )
          .bind(
            plan.printing_id,
            membership.relationship_kind,
            membership.relationship_value,
            revisionId,
            revisionId,
          ),
      ),
    ],
  };
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
        `SELECT relationship_kind, relationship_value
         FROM reconciled_printing_memberships
         WHERE printing_id = ?
         ORDER BY relationship_kind, relationship_value`,
      )
      .bind(printingId)
      .all<MembershipRow>(),
  ]);
  const grouped = {
    products: [] as string[],
    distribution_contexts: [] as string[],
    source_buckets: [] as string[],
  };
  for (const membership of memberships.results) {
    if (membership.relationship_kind === "product") {
      grouped.products.push(membership.relationship_value);
    } else if (membership.relationship_kind === "distribution_context") {
      grouped.distribution_contexts.push(membership.relationship_value);
    } else {
      grouped.source_buckets.push(membership.relationship_value);
    }
  }
  return {
    id: printing.id,
    card_id: printing.card_id,
    locators: locators.results.map((row) => row.locator),
    memberships: grouped,
    lifecycle: lifecycle(
      printing.first_revision_id,
      printing.last_observed_revision_id,
      printing.withdrawn === 1,
      printing.withdrawal_revision_id,
      printing.withdrawal_evidence_json,
    ),
  };
}

function compatibilityValues(
  compatibility: PrintingCompatibility,
): (string | null)[] {
  return compatibilityFields.map((field) => compatibility[field]);
}

function membershipEntries(memberships: Memberships): MembershipRow[] {
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

function membershipKey(row: MembershipRow): string {
  return `${row.relationship_kind}\u0000${row.relationship_value}`;
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

async function requiredRunCandidate(
  database: D1Database,
  runId: string,
): Promise<string> {
  const row = await database
    .prepare("SELECT candidate_json FROM ingestion_runs WHERE id = ?")
    .bind(runId)
    .first<{ candidate_json: string }>();
  if (row === null) throw new Error("Reconciled candidate is unavailable.");
  return row.candidate_json;
}
