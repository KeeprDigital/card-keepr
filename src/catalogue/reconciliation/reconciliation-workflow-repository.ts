import { correctionPinStatementsForPreparation } from "./identity-correction-repository";
import { type CatalogueStore, repositoryStatements, atomicRepositoryStatement } from "../shared";
// Prepared statements only; callers own execution and atomic batch composition.

export function reconciliationWorkflowRunStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT run.id, run.state, run.selected_games_json, run.expected_current_revision_id,
              state.current_revision_id, (SELECT ingestion_run_id FROM ingestion_collection_reservations WHERE ingestion_run_id = run.id) AS active_ingestion_run_id,
              operation.recovery_health
       FROM ingestion_run_read AS run
       CROSS JOIN catalogue_state AS state
       CROSS JOIN operation_state AS operation
       WHERE run.id = ?`)
    .bind(runId);
}

export function createReconciliationWorkflowRequestStatement(
  database: CatalogueStore,
  input: Readonly<{
    games: readonly string[];
    idempotencyKey: string;
    runId: string;
    expectedRevisionId: string;
    requestJson: string;
    paramsJson: string;
    workflowId: string;
    observedAt: string;
  }>,
): D1PreparedStatement {
  return atomicRepositoryStatement(database, {
    after: correctionPinStatementsForPreparation(database, input.runId, input.games),
    statement: repositoryStatements(database)
      .prepare(`INSERT OR IGNORE INTO reconciliation_workflow_requests (
         idempotency_key, ingestion_run_id,
         expected_current_revision_id, request_json,
         workflow_params_json, workflow_instance_id, observed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        input.idempotencyKey,
        input.runId,
        input.expectedRevisionId,
        input.requestJson,
        input.paramsJson,
        input.workflowId,
        input.observedAt,
      ),
  });
}

export function reconciliationWorkflowCandidateDigestStatement(
  database: CatalogueStore,
  runId: string,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT candidate_digest
       FROM ingestion_run_current
       WHERE ingestion_run_id = ?`)
    .bind(runId);
}

export function reconciliationWorkflowRequestStatement(
  database: CatalogueStore,
  idempotencyKey: string,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT idempotency_key, ingestion_run_id,
              expected_current_revision_id, request_json,
              workflow_params_json, workflow_instance_id, observed_at
       FROM reconciliation_workflow_requests
       WHERE idempotency_key = ?`)
    .bind(idempotencyKey);
}
