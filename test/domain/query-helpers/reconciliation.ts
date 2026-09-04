import type { DatabaseSync, StatementSync } from "node:sqlite";

// Dedicated test queries. Tests retain binding, execution, and atomic batch composition.

export function insertReconciliationWorkflowRequests(database: DatabaseSync): StatementSync {
  return database.prepare(`INSERT INTO reconciliation_workflow_requests (
         idempotency_key, ingestion_run_id, expected_current_revision_id,
         request_json, workflow_params_json, workflow_instance_id, observed_at
       ) VALUES (?, ?, ?, '{}', '{}', ?, ?)`);
}

export function insertReconciliationTerminalResults(database: DatabaseSync): StatementSync {
  return database.prepare(`INSERT INTO reconciliation_terminal_results (
             ingestion_run_id, result_json
           ) VALUES (?, ?)`);
}

export function insertReconciliationTerminalResultsForBaselineEnforcesReconciliationWorkflowErrataConstraints(
  database: DatabaseSync,
): StatementSync {
  return database.prepare(`INSERT INTO reconciliation_terminal_results (
         ingestion_run_id, result_json
       ) VALUES (?, '{}')`);
}

export function insertReconciledErrata(database: DatabaseSync): StatementSync {
  return database.prepare(`INSERT INTO reconciled_errata (
         id, game, target_type, target_id, effective_from,
         official_wording, corrected_value_json, first_revision_id,
         last_observed_revision_id
       ) VALUES (?, ?, ?, ?, NULL, 'Official correction', ?,
                 'catrev_schema', 'catrev_schema')`);
}
