import type { FixtureCandidate } from "./fixture";
import type {
  Memberships,
  PrintingCompatibility,
  ReconciliationWarning,
  Withdrawal,
} from "./reconciliation-model";
import { canonicalJson } from "./serialization";

export type CandidatePlanRow = {
  ingestion_run_id: string;
  source_observation_set_id: string;
  source_snapshot_id: string;
  source_observation_id: string;
  card_id: string;
  printing_id: string | null;
  source_lineage: string;
  locator: string | null;
  compatibility_json: string | null;
  memberships_json: string;
  warnings_json: string;
  withdrawal_json: string | null;
  digest_payload_json: string;
};

export async function persistReviewableCandidate(
  database: D1Database,
  input: {
    runId: string;
    observationSetId: string;
    sourceSnapshotId: string;
    sourceLineage: string;
    plans: readonly {
      sourceObservationId: string;
      cardId: string;
      printingId: string | null;
      locator: string | null;
      compatibility: PrintingCompatibility | null;
      memberships: Memberships;
      withdrawal: Withdrawal | null;
    }[];
    warnings: readonly (ReconciliationWarning | Record<string, unknown>)[];
    candidate: FixtureCandidate;
    digestPayloadJson: string;
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
    ...input.plans.map((plan) =>
      database
        .prepare(
          `INSERT INTO reconciliation_candidates (
            ingestion_run_id, source_observation_set_id, source_snapshot_id,
            source_observation_id, card_id, printing_id, source_lineage,
            locator, compatibility_json, memberships_json, withdrawal_json,
            warnings_json, digest_payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.runId,
          input.observationSetId,
          input.sourceSnapshotId,
          plan.sourceObservationId,
          plan.cardId,
          plan.printingId,
          input.sourceLineage,
          plan.locator,
          plan.compatibility === null
            ? null
            : canonicalJson(plan.compatibility),
          canonicalJson(plan.memberships),
          plan.withdrawal === null
            ? null
            : canonicalJson(plan.withdrawal),
          canonicalJson(input.warnings),
          input.digestPayloadJson,
        ),
    ),
    database
      .prepare(
        `UPDATE ingestion_runs
         SET state = 'awaiting_approval',
             candidate_json = ?,
             candidate_digest = ?,
             selected_games_json = ?,
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
        canonicalJson(input.candidate.selected_games),
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

export async function reconciliationCandidatePlans(
  database: D1Database,
  runId: string,
): Promise<CandidatePlanRow[]> {
  const rows = await database
    .prepare("SELECT * FROM reconciliation_candidates WHERE ingestion_run_id = ?")
    .bind(runId)
    .all<CandidatePlanRow>();
  return rows.results;
}

export async function digestBoundCandidatePayload(
  database: D1Database,
  runId: string,
): Promise<string | null> {
  const row = await database
    .prepare(
      `SELECT digest_payload_json
       FROM reconciliation_candidates
       WHERE ingestion_run_id = ?`,
    )
    .bind(runId)
    .first<{ digest_payload_json: string }>();
  return row?.digest_payload_json ?? null;
}
