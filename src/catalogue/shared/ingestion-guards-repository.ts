import { type CatalogueStore, repositoryStatements } from "./catalogue-store-repository";
import { canTransitionIngestionRun, type IngestionRunState } from "./ingestion-run-state";

/** Run immediately after the named UPDATE whose WHERE compares these source states. */
export function runTransitionGuardStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string; from: IngestionRunState | readonly IngestionRunState[]; to: IngestionRunState }>,
): D1PreparedStatement {
  const sources = typeof input.from === "string" ? [input.from] : input.from;
  if (
    sources.length === 0 ||
    sources.some(
      (from) =>
        !canTransitionIngestionRun(from, input.to, {
          failureCode: "ingestion_run_terminated",
          terminationRecorded: true,
        }),
    )
  )
    throw new TypeError("A repository run mutation must name a legal state edge.");
  if (input.to === "failed" && sources.includes("paused") && sources.length !== 1) {
    throw new TypeError("A termination mutation must compare only the paused source state.");
  }
  return repositoryStatements(database)
    .prepare(`WITH run AS (
    SELECT * FROM ingestion_runs WHERE id = ?
  ) SELECT CASE
    WHEN changes() = 0 THEN 1
    WHEN NOT EXISTS (SELECT 1 FROM run WHERE state = ? AND (
      ? = 0 OR (failure_code IS 'ingestion_run_terminated' AND EXISTS (
        SELECT 1 FROM ingestion_run_terminations WHERE ingestion_run_id = run.id
      ))
    )) THEN json_extract('{}', 'illegal_ingestion_transition')
    WHEN NOT EXISTS (SELECT 1 FROM run WHERE
      EXISTS (SELECT 1 FROM operation_state WHERE singleton = 1 AND active_ingestion_run_id = run.id)
      OR (? = 1 AND state = 'failed' AND failure_code IN (
        'publication_abandoned', 'publication_precondition_failed', 'export_verification_failed'
      ))
      OR (? = 1 AND state = 'expired' AND approval_deadline IS NOT NULL AND terminal_at >= approval_deadline)
    ) THEN json_extract('{}', 'run_not_active')
    WHEN ? = 'awaiting_approval' AND NOT EXISTS (SELECT 1 FROM run WHERE
      candidate_digest IS NOT NULL AND candidate_catalogue_digest IS NOT NULL
      AND candidate_created_at IS NOT NULL AND approval_deadline IS NOT NULL
      AND approval_deadline = strftime('%Y-%m-%dT%H:%M:%fZ', candidate_created_at, '+7 days')
    ) THEN json_extract('{}', 'invalid_candidate_deadline')
    WHEN ? = 'publishing' AND NOT EXISTS (
      SELECT 1 FROM run
      JOIN catalogue_state AS catalogue ON catalogue.singleton = 1
      JOIN operation_state AS operation ON operation.singleton = 1
      WHERE run.approval_json IS NOT NULL
        AND json_extract(run.approval_json, '$.candidate_digest') = run.candidate_digest
        AND json_extract(run.approval_json, '$.expected_current_revision_id') = run.expected_current_revision_id
        AND json_extract(run.approval_json, '$.approved_at') < run.approval_deadline
        AND catalogue.current_revision_id = run.expected_current_revision_id
        AND operation.active_ingestion_run_id = run.id AND operation.recovery_health = 'healthy'
    ) THEN json_extract('{}', 'approval_guard_failed')
    ELSE 1 END`)
    .bind(
      input.runId,
      input.to,
      Number(input.to === "failed" && sources.includes("paused")),
      Number(sources.length === 1 && sources[0] === "publishing"),
      Number(sources.includes("awaiting_approval")),
      input.to,
      input.to,
    );
}

/** Run immediately after insertion, before acquiring the new run's reservation. */
export function runStartGuardStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(`SELECT CASE
    WHEN changes() = 0 THEN 1
    WHEN EXISTS (SELECT 1 FROM operation_state WHERE singleton = 1 AND (
      active_ingestion_run_id IS NOT NULL OR (
        active_production_release_id IS NOT NULL
        AND active_production_release_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      )
    )) THEN json_extract('{}', 'active_ingestion_run_or_release')
    WHEN EXISTS (SELECT 1 FROM operation_state WHERE singleton = 1
      AND (recovery_health = 'blocked' OR recovery_restore_guard = 'blocked')
    ) THEN json_extract('{}', 'recovery_in_progress')
    ELSE 1 END`);
}
