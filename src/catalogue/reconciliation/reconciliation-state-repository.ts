import { nextLiveIngestionReservationSql } from "../shared";
import {
  atomicRepositoryStatement,
  type CatalogueStore,
  ingestionRunTransitionSql,
  repositoryStatements,
  runTransitionGuardStatement,
  runEventCommand,
  runEventStatement,
  runEventIdentitySql,
} from "../shared";
import { retainCandidateEvidenceStatement } from "./evidence-retention-repository";
// Prepared statements only; callers own execution and atomic batch composition.

export function createReconciliationContextStatement(
  database: CatalogueStore,
  input: Readonly<{
    runId: string;
    digestPayload: string;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciliation_contexts (
          ingestion_run_id, digest_payload_json
        ) VALUES (?, ?)`)
    .bind(input.runId, input.digestPayload);
}

export function beginReconciliationStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  const event = runEventCommand("stage_changed", { runId: runId });
  const statement = repositoryStatements(database)
    .prepare(`UPDATE ingestion_run_current
         SET ${runEventIdentitySql}, state = 'reconciling',
             completed_stage_count = 3
         WHERE ingestion_run_id = ? AND ${ingestionRunTransitionSql("parsing", "reconciling")}`)
    .bind(event.eventId, runId);
  return runEventStatement(database, {
    event,
    statement,
    guards: [runTransitionGuardStatement(database, { runId: runId, from: "parsing", to: "reconciling" })],
  });
}

export function reviewableCandidateStatement(
  database: CatalogueStore,
  input: Readonly<{
    candidatePayload: string;
    candidateDigest: string;
    catalogueDigest: string;
    createdAt: string;
    approvalDeadline: string;
    warningsJson: string;
    runId: string;
  }>,
): D1PreparedStatement {
  const event = runEventCommand("candidate_prepared", { runId: input.runId, occurredAt: input.createdAt });
  const statement = repositoryStatements(database)
    .prepare(`UPDATE ingestion_run_current
         SET ${runEventIdentitySql}, state = 'awaiting_approval',
             candidate_payload_event_sequence = last_event_sequence + 1,
             candidate_digest = ?,
             candidate_catalogue_digest = ?,
             candidate_created_at = ?,
             approval_deadline = ?,
             diagnostics_event_sequence = last_event_sequence + 1,
             completed_stage_count = 4
         WHERE ingestion_run_id = ? AND ${ingestionRunTransitionSql("reconciling", "awaiting_approval")}`)
    .bind(
      event.eventId,
      input.candidateDigest,
      input.catalogueDigest,
      input.createdAt,
      input.approvalDeadline,
      input.runId,
    );
  return runEventStatement(database, {
    event,
    statement,
    candidateJson: input.candidatePayload,
    diagnosticsJson: input.warningsJson,
    guards: [
      runTransitionGuardStatement(database, { runId: input.runId, from: "reconciling", to: "awaiting_approval" }),
    ],
  });
}

export function blockedCandidateStatement(
  database: CatalogueStore,
  input: Readonly<{
    candidatePayload: string;
    candidateDigest: string;
    catalogueDigest: string;
    createdAt: string;
    approvalDeadline: string;
    terminalAt: string;
    failureCode: string;
    diagnosticsJson: string;
    runId: string;
  }>,
): D1PreparedStatement {
  const event = runEventCommand("candidate_blocked", { runId: input.runId, occurredAt: input.terminalAt });
  const statement = repositoryStatements(database)
    .prepare(`UPDATE ingestion_run_current
         SET ${runEventIdentitySql}, state = 'failed',
             candidate_payload_event_sequence = last_event_sequence + 1,
             candidate_digest = ?,
             candidate_catalogue_digest = ?,
             candidate_created_at = ?,
             approval_deadline = ?,
             terminal_at = ?,
             failure_code = ?,
             diagnostics_event_sequence = last_event_sequence + 1,
             completed_stage_count = 4
         WHERE ingestion_run_id = ? AND ${ingestionRunTransitionSql("reconciling", "failed")}`)
    .bind(
      event.eventId,
      input.candidateDigest,
      input.catalogueDigest,
      input.createdAt,
      input.approvalDeadline,
      input.terminalAt,
      input.failureCode,
      input.runId,
    );
  return runEventStatement(database, {
    event,
    statement,
    candidateJson: input.candidatePayload,
    diagnosticsJson: input.diagnosticsJson,
    guards: [runTransitionGuardStatement(database, { runId: input.runId, from: "reconciling", to: "failed" })],
  });
}

export function releaseReconciliationRunStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE operation_state
         SET active_ingestion_run_id = ${nextLiveIngestionReservationSql}
         WHERE singleton = 1 AND active_ingestion_run_id = ?`)
    .bind(runId);
}

export function failedReconciliationStatement(
  database: CatalogueStore,
  input: Readonly<{ terminalAt: string; diagnosticsJson: string; runId: string }>,
): D1PreparedStatement {
  const event = runEventCommand("failed", { runId: input.runId, occurredAt: input.terminalAt });
  const statement = repositoryStatements(database)
    .prepare(`UPDATE ingestion_run_current
         SET ${runEventIdentitySql}, state = 'failed', terminal_at = ?,
             failure_code = 'printing_reconciliation_blocked',
             diagnostics_event_sequence = last_event_sequence + 1,
             completed_stage_count = 3
         WHERE ingestion_run_id = ? AND ${ingestionRunTransitionSql("reconciling", "failed")}`)
    .bind(event.eventId, input.terminalAt, input.runId);
  return runEventStatement(database, {
    event,
    statement,
    diagnosticsJson: input.diagnosticsJson,
    guards: [runTransitionGuardStatement(database, { runId: input.runId, from: "reconciling", to: "failed" })],
  });
}

export function failedReconciliationWorkflowStatement(
  database: CatalogueStore,
  input: Readonly<{ terminalAt: string; failureCode: string; diagnosticsJson: string; runId: string }>,
): D1PreparedStatement {
  const event = runEventCommand("failed", { runId: input.runId, occurredAt: input.terminalAt });
  const statement = repositoryStatements(database)
    .prepare(`UPDATE ingestion_run_current
         SET ${runEventIdentitySql}, state = 'failed', terminal_at = ?,
             failure_code = ?,
             diagnostics_event_sequence = last_event_sequence + 1,
             completed_stage_count = 3
         WHERE ingestion_run_id = ? AND ${ingestionRunTransitionSql(["parsing", "reconciling"], "failed")}`)
    .bind(event.eventId, input.terminalAt, input.failureCode, input.runId);
  return runEventStatement(database, {
    event,
    statement,
    diagnosticsJson: input.diagnosticsJson,
    guards: [
      runTransitionGuardStatement(database, { runId: input.runId, from: ["parsing", "reconciling"], to: "failed" }),
    ],
  });
}

export function releaseFailedReconciliationWorkflowStatement(
  database: CatalogueStore,
  input: Readonly<{ activeRunId: string; runId: string; failureCode: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE operation_state
         SET active_ingestion_run_id = ${nextLiveIngestionReservationSql}
         WHERE singleton = 1
           AND active_ingestion_run_id = ?
           AND EXISTS (
             SELECT 1 FROM ingestion_run_current
             WHERE ingestion_run_id = ? AND state = 'failed'
               AND failure_code = ?
           )`)
    .bind(input.activeRunId, input.runId, input.failureCode);
}

export function candidatePlansStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string; warningsJson: string; plansJson: string }>,
): D1PreparedStatement {
  return atomicRepositoryStatement(database, {
    after: [retainCandidateEvidenceStatement(database, input)],
    statement: repositoryStatements(database)
      .prepare(`INSERT INTO reconciliation_candidates (
         ingestion_run_id, source_observation_set_id, source_snapshot_id,
         source_observation_id, card_id, printing_id, source_lineage,
         locator, variant_key, compatibility_json, memberships_json,
         withdrawal_json, source_card_facts_json,
         warnings_json, digest_payload_json,
         observation_kind
       )
       SELECT ?, json_extract(planned.value, '$.observation_set_id'),
              json_extract(planned.value, '$.snapshot_id'),
              json_extract(planned.value, '$.observation_id'),
              json_extract(planned.value, '$.card_id'),
              json_extract(planned.value, '$.printing_id'),
              json_extract(planned.value, '$.source_lineage'),
              json_extract(planned.value, '$.locator'),
              json_extract(planned.value, '$.variant_key'),
              json_extract(planned.value, '$.compatibility_json'),
              json_extract(planned.value, '$.memberships_json'),
              json_extract(planned.value, '$.withdrawal_json'),
              json_extract(planned.value, '$.source_card_facts_json'), ?,
              '{"reconciliation_context":"shared"}',
              json_extract(planned.value, '$.observation_kind')
       FROM json_each(?) AS planned`)
      .bind(input.runId, input.warningsJson, input.plansJson),
  });
}

export function evidencePartitionsStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string; partitionsJson: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciliation_evidence_partitions (
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
         FROM json_each(?)`)
    .bind(input.runId, input.partitionsJson);
}

export function reconciliationCandidatePlansStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT *
       FROM reconciliation_candidates
       WHERE ingestion_run_id = ?
       ORDER BY source_lineage, card_id, printing_id,
                source_observation_id`)
    .bind(runId);
}

export function reconciliationDigestPayloadStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT digest_payload_json
       FROM reconciliation_contexts
       WHERE ingestion_run_id = ?`)
    .bind(runId);
}

export function retainedCandidateResultStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT run.candidate_json, run.candidate_digest,
              run.expected_current_revision_id,
              context.digest_payload_json
       FROM ingestion_run_read AS run
       JOIN reconciliation_contexts AS context
         ON context.ingestion_run_id = run.id
       WHERE run.id = ?`)
    .bind(runId);
}
