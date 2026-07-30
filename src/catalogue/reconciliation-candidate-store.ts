import type { FixtureCandidate } from "./fixture";
import type {
  Memberships,
  PrintingCompatibility,
  ProvenancedWithdrawal,
  ReconciliationWarning,
} from "./reconciliation-model";
import { canonicalJson } from "./serialization";
import {
  byteBoundedJsonArrays,
  chunkedPayloadMarker,
  guardedAtomicBatch,
  payloadChunkStatements,
  retainedPayload,
} from "./reconciliation-payload";

type EvidencePartitionInput = {
  sequenceNumber: number;
  requestId: string;
  observationSetId: string;
  sourceSnapshotId: string;
  sourceLineage: string;
  supportedGame: string;
  gameProfileVersion: string;
  adapterVersion: string;
};

export type CandidatePlanRow = {
  ingestion_run_id: string;
  source_observation_set_id: string;
  source_snapshot_id: string;
  source_observation_id: string;
  card_id: string;
  printing_id: string | null;
  source_lineage: string;
  locator: string | null;
  variant_key: string | null;
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
    partitions: readonly EvidencePartitionInput[];
    plans: readonly {
      sourceObservationSetId: string;
      sourceSnapshotId: string;
      sourceObservationId: string;
      cardId: string;
      printingId: string | null;
      locator: string | null;
      variantKey: string | null;
      compatibility: PrintingCompatibility | null;
      memberships: Memberships;
      withdrawal: ProvenancedWithdrawal | null;
    }[];
    warnings: readonly (ReconciliationWarning | Record<string, unknown>)[];
    candidate: FixtureCandidate;
    digestPayloadJson: string;
    candidateDigest: string;
    candidateCatalogueDigest: string;
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
  const statements = [
    database
      .prepare(
        `INSERT INTO reconciliation_contexts (
          ingestion_run_id, source_observation_set_id,
          source_snapshot_id, source_lineage, digest_payload_json
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        input.runId,
        input.observationSetId,
        input.sourceSnapshotId,
        input.sourceLineage,
        chunkedPayloadMarker("digest"),
      ),
    ...evidencePartitionStatements(database, input.runId, input.partitions),
    ...payloadChunkStatements(
      database,
      input.runId,
      "candidate",
      canonicalJson(input.candidate),
    ),
    ...payloadChunkStatements(
      database,
      input.runId,
      "digest",
      input.digestPayloadJson,
    ),
    database
      .prepare(
        `UPDATE ingestion_runs
         SET state = 'reconciling',
             progress_json =
               '{"completed_stages":["planning","collecting","parsing"],"current_stage":"reconciling"}'
         WHERE id = ? AND state = 'parsing'`,
      )
      .bind(input.runId),
    ...candidatePlanInsertionStatements(
      database,
      input.runId,
      input.sourceLineage,
      input.plans,
      canonicalJson(input.warnings),
    ),
    database
      .prepare(
        `UPDATE ingestion_runs
         SET state = 'awaiting_approval',
             candidate_json = ?,
             candidate_digest = ?,
             candidate_catalogue_digest = ?,
             candidate_created_at = ?,
             approval_deadline = ?,
             warnings_json = ?,
             progress_json =
               '{"completed_stages":["planning","collecting","parsing","reconciling"],"current_stage":"awaiting_approval"}'
         WHERE id = ? AND state = 'reconciling'`,
      )
      .bind(
        chunkedPayloadMarker("candidate"),
        input.candidateDigest,
        input.candidateCatalogueDigest,
        input.observedAt,
        approvalDeadline,
        canonicalJson(runWarnings),
        input.runId,
      ),
  ];
  await database.batch(guardedAtomicBatch(statements));
}

export async function persistBlockedCandidate(
  database: D1Database,
  input: {
    runId: string;
    observationSetId: string;
    sourceSnapshotId: string;
    sourceLineage: string;
    partitions: readonly EvidencePartitionInput[];
    plans: readonly {
      sourceObservationSetId: string;
      sourceSnapshotId: string;
      sourceObservationId: string;
      cardId: string;
      printingId: string | null;
      locator: string | null;
      variantKey: string | null;
      compatibility: PrintingCompatibility | null;
      memberships: Memberships;
      withdrawal: ProvenancedWithdrawal | null;
    }[];
    diagnostics: readonly Record<string, unknown>[];
    candidate: FixtureCandidate;
    digestPayloadJson: string;
    candidateDigest: string;
    candidateCatalogueDigest: string;
    observedAt: string;
  },
): Promise<void> {
  const approvalDeadline = new Date(
    Date.parse(input.observedAt) + 7 * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const runDiagnostics = input.diagnostics.map((diagnostic) => ({
    code: String(diagnostic.code),
    detail: String(diagnostic.detail),
  }));
  const statements = [
    database
      .prepare(
        `INSERT INTO reconciliation_contexts (
          ingestion_run_id, source_observation_set_id,
          source_snapshot_id, source_lineage, digest_payload_json
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        input.runId,
        input.observationSetId,
        input.sourceSnapshotId,
        input.sourceLineage,
        chunkedPayloadMarker("digest"),
      ),
    ...evidencePartitionStatements(database, input.runId, input.partitions),
    ...payloadChunkStatements(
      database,
      input.runId,
      "candidate",
      canonicalJson(input.candidate),
    ),
    ...payloadChunkStatements(
      database,
      input.runId,
      "digest",
      input.digestPayloadJson,
    ),
    database
      .prepare(
        `UPDATE ingestion_runs
         SET state = 'reconciling',
             progress_json =
               '{"completed_stages":["planning","collecting","parsing"],"current_stage":"reconciling"}'
         WHERE id = ? AND state = 'parsing'`,
      )
      .bind(input.runId),
    ...candidatePlanInsertionStatements(
      database,
      input.runId,
      input.sourceLineage,
      input.plans,
      canonicalJson(input.diagnostics),
    ),
    database
      .prepare(
        `UPDATE ingestion_runs
         SET state = 'failed',
             candidate_json = ?,
             candidate_digest = ?,
             candidate_catalogue_digest = ?,
             candidate_created_at = ?,
             approval_deadline = ?,
             terminal_at = ?,
             failure_code = 'printing_reconciliation_blocked',
             warnings_json = ?,
             progress_json =
               '{"completed_stages":["planning","collecting","parsing","reconciling"],"current_stage":"failed"}'
         WHERE id = ? AND state = 'reconciling'`,
      )
      .bind(
        chunkedPayloadMarker("candidate"),
        input.candidateDigest,
        input.candidateCatalogueDigest,
        input.observedAt,
        approvalDeadline,
        input.observedAt,
        canonicalJson(runDiagnostics),
        input.runId,
      ),
    database
      .prepare(
        `UPDATE operation_state
         SET active_ingestion_run_id = NULL
         WHERE singleton = 1 AND active_ingestion_run_id = ?`,
      )
      .bind(input.runId),
  ];
  await database.batch(guardedAtomicBatch(statements));
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

type CandidatePlanInput = {
  sourceObservationSetId: string;
  sourceSnapshotId: string;
  sourceObservationId: string;
  cardId: string;
  printingId: string | null;
  locator: string | null;
  variantKey: string | null;
  compatibility: PrintingCompatibility | null;
  memberships: Memberships;
  withdrawal: ProvenancedWithdrawal | null;
};

function candidatePlanInsertionStatements(
  database: D1Database,
  runId: string,
  sourceLineage: string,
  plans: readonly CandidatePlanInput[],
  warningsJson: string,
): D1PreparedStatement[] {
  const rows = plans.map((plan) => ({
    observation_set_id: plan.sourceObservationSetId,
    snapshot_id: plan.sourceSnapshotId,
    observation_id: plan.sourceObservationId,
    card_id: plan.cardId,
    printing_id: plan.printingId,
    locator: plan.locator,
    variant_key: plan.variantKey,
    compatibility_json:
      plan.compatibility === null ? null : canonicalJson(plan.compatibility),
    memberships_json: canonicalJson(plan.memberships),
    withdrawal_json:
      plan.withdrawal === null ? null : canonicalJson(plan.withdrawal),
  }));
  return byteBoundedJsonArrays(rows).map((chunk) =>
    database.prepare(
      `INSERT INTO reconciliation_candidates (
         ingestion_run_id, source_observation_set_id, source_snapshot_id,
         source_observation_id, card_id, printing_id, source_lineage,
         locator, variant_key, compatibility_json, memberships_json,
         withdrawal_json, warnings_json, digest_payload_json
       )
       SELECT ?, json_extract(planned.value, '$.observation_set_id'),
              json_extract(planned.value, '$.snapshot_id'),
              json_extract(planned.value, '$.observation_id'),
              json_extract(planned.value, '$.card_id'),
              json_extract(planned.value, '$.printing_id'), ?,
              json_extract(planned.value, '$.locator'),
              json_extract(planned.value, '$.variant_key'),
              json_extract(planned.value, '$.compatibility_json'),
              json_extract(planned.value, '$.memberships_json'),
              json_extract(planned.value, '$.withdrawal_json'), ?,
              '{"reconciliation_context":"shared"}'
       FROM json_each(?) AS planned`,
    )
    .bind(
      runId,
      sourceLineage,
      warningsJson,
      chunk,
    ),
  );
}

function evidencePartitionStatements(
  database: D1Database,
  runId: string,
  partitions: readonly EvidencePartitionInput[],
): D1PreparedStatement[] {
  const rows = partitions.map((partition) => ({
    sequence_number: partition.sequenceNumber,
    request_id: partition.requestId,
    observation_set_id: partition.observationSetId,
    snapshot_id: partition.sourceSnapshotId,
    source_lineage: partition.sourceLineage,
    supported_game: partition.supportedGame,
    profile_version: partition.gameProfileVersion,
    adapter_version: partition.adapterVersion,
  }));
  return byteBoundedJsonArrays(rows).map((chunk) =>
    database
      .prepare(
        `INSERT INTO reconciliation_evidence_partitions (
           ingestion_run_id, sequence_number, request_id,
           source_observation_set_id, source_snapshot_id, source_lineage,
           supported_game, game_profile_version, adapter_version
         )
         SELECT ?, json_extract(value, '$.sequence_number'),
                json_extract(value, '$.request_id'),
                json_extract(value, '$.observation_set_id'),
                json_extract(value, '$.snapshot_id'),
                json_extract(value, '$.source_lineage'),
                json_extract(value, '$.supported_game'),
                json_extract(value, '$.profile_version'),
                json_extract(value, '$.adapter_version')
         FROM json_each(?)`,
      )
      .bind(runId, chunk),
  );
}

export async function reconciliationCandidatePlans(
  database: D1Database,
  runId: string,
): Promise<CandidatePlanRow[]> {
  const rows = await database
    .prepare(
      `SELECT *
       FROM reconciliation_candidates
       WHERE ingestion_run_id = ?
       ORDER BY source_lineage, card_id, printing_id,
                source_observation_id`,
    )
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
       FROM reconciliation_contexts
       WHERE ingestion_run_id = ?`,
    )
    .bind(runId)
    .first<{ digest_payload_json: string }>();
  return row === null
    ? null
    : retainedPayload(database, runId, "digest", row.digest_payload_json);
}
