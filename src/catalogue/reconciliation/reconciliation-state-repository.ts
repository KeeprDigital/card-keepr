import { type CatalogueStore, ingestionRunTransitionSql, repositoryStatements } from "../shared";
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
  return repositoryStatements(database)
    .prepare(`UPDATE ingestion_runs
         SET state = 'reconciling',
             progress_json =
               '{"completed_stages":["planning","collecting","parsing"],"current_stage":"reconciling"}'
         WHERE id = ? AND ${ingestionRunTransitionSql("parsing", "reconciling")}`)
    .bind(runId);
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
  return repositoryStatements(database)
    .prepare(`UPDATE ingestion_runs
         SET state = 'awaiting_approval',
             candidate_json = ?,
             candidate_digest = ?,
             candidate_catalogue_digest = ?,
             candidate_created_at = ?,
             approval_deadline = ?,
             warnings_json = ?,
             progress_json =
               '{"completed_stages":["planning","collecting","parsing","reconciling"],"current_stage":"awaiting_approval"}'
         WHERE id = ? AND ${ingestionRunTransitionSql("reconciling", "awaiting_approval")}`)
    .bind(
      input.candidatePayload,
      input.candidateDigest,
      input.catalogueDigest,
      input.createdAt,
      input.approvalDeadline,
      input.warningsJson,
      input.runId,
    );
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
  return repositoryStatements(database)
    .prepare(`UPDATE ingestion_runs
         SET state = 'failed',
             candidate_json = ?,
             candidate_digest = ?,
             candidate_catalogue_digest = ?,
             candidate_created_at = ?,
             approval_deadline = ?,
             terminal_at = ?,
             failure_code = ?,
             warnings_json = ?,
             progress_json =
               '{"completed_stages":["planning","collecting","parsing","reconciling"],"current_stage":"failed"}'
         WHERE id = ? AND ${ingestionRunTransitionSql("reconciling", "failed")}`)
    .bind(
      input.candidatePayload,
      input.candidateDigest,
      input.catalogueDigest,
      input.createdAt,
      input.approvalDeadline,
      input.terminalAt,
      input.failureCode,
      input.diagnosticsJson,
      input.runId,
    );
}

export function releaseReconciliationRunStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE operation_state
         SET active_ingestion_run_id = NULL
         WHERE singleton = 1 AND active_ingestion_run_id = ?`)
    .bind(runId);
}

export function failedReconciliationStatement(
  database: CatalogueStore,
  input: Readonly<{ terminalAt: string; diagnosticsJson: string; runId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE ingestion_runs
         SET state = 'failed', terminal_at = ?,
             failure_code = 'printing_reconciliation_blocked',
             warnings_json = ?,
             progress_json =
               '{"completed_stages":["planning","collecting","parsing"],"current_stage":"failed"}'
         WHERE id = ? AND ${ingestionRunTransitionSql("reconciling", "failed")}`)
    .bind(input.terminalAt, input.diagnosticsJson, input.runId);
}

export function failedReconciliationWorkflowStatement(
  database: CatalogueStore,
  input: Readonly<{ terminalAt: string; failureCode: string; diagnosticsJson: string; runId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE ingestion_runs
         SET state = 'failed', terminal_at = ?,
             failure_code = ?,
             warnings_json = ?,
             progress_json =
               '{"completed_stages":["planning","collecting","parsing"],"current_stage":"failed"}'
         WHERE id = ? AND ${ingestionRunTransitionSql(["parsing", "reconciling"], "failed")}`)
    .bind(input.terminalAt, input.failureCode, input.diagnosticsJson, input.runId);
}

export function releaseFailedReconciliationWorkflowStatement(
  database: CatalogueStore,
  input: Readonly<{ activeRunId: string; runId: string; failureCode: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE operation_state
         SET active_ingestion_run_id = NULL
         WHERE singleton = 1
           AND active_ingestion_run_id = ?
           AND EXISTS (
             SELECT 1 FROM ingestion_runs
             WHERE id = ? AND state = 'failed'
               AND failure_code = ?
           )`)
    .bind(input.activeRunId, input.runId, input.failureCode);
}

export function candidatePlansStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string; warningsJson: string; plansJson: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
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
    .bind(input.runId, input.warningsJson, input.plansJson);
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
       FROM ingestion_runs AS run
       JOIN reconciliation_contexts AS context
         ON context.ingestion_run_id = run.id
       WHERE run.id = ?`)
    .bind(runId);
}
