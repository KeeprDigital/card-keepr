import { verifiedRunCurrentSql } from "../shared";
import { curatedRunStartGuardStatement } from "../curated";
import { createRunEventStatement, runStartGuardStatement } from "../shared";
import type { SourceAdapterRegistration } from "../adapters";
import { type CatalogueStore, canonicalJson, type IngestionRunState, repositoryStatements } from "../shared";

export type IngestionEvidenceRow = {
  id: string;
  state: IngestionRunState;
  selected_games_json: string;
  started_at: string;
  expected_current_revision_id: string;
  linked_run_id: string | null;
  idempotency_key: string;
  operational_request_id: string | null;
  terminal_at: string | null;
  source_lineage: string;
  supported_game: string;
  game_profile_version: string;
  adapter_version: string;
  plan_origin: SourceAdapterRegistration["origin"];
  request_plan_json: string;
  parent_workflow_id: string | null;
  child_workflow_ids_json: string | null;
  collection_completed_at: string | null;
  failure_code: string | null;
  candidate_digest: string | null;
  progress_json: string;
  warnings_json: string;
  approval_history_json: string;
  published_revision_id: string | null;
  resulting_revision_id: string | null;
  publication_outcome: string | null;
};

export type IngestionRunInsertInput = {
  runId: string;
  supportedGames: readonly string[];
  startedAt: string;
  linkedRunId: string | null;
  idempotencyKey: string;
  operationalRequestId?: string | null;
};

export function ingestionRunInsertStatement(
  database: CatalogueStore,
  input: IngestionRunInsertInput,
): D1PreparedStatement {
  return createRunEventStatement(database, {
    ...input,
    selectedGamesJson: canonicalJson(input.supportedGames),
    state: "collecting",
    guards: [runStartGuardStatement(database), curatedRunStartGuardStatement(database, input.runId)],
  });
}

export function evidenceRunByIdStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(
      `SELECT runs.*, plans.source_lineage, plans.supported_game,
              plans.game_profile_version, plans.adapter_version,
              plans.request_plan_json, plans.plan_origin,
              plans.parent_workflow_id,
              plans.child_workflow_ids_json,
              plans.collection_completed_at
       FROM ingestion_run_read AS runs
       JOIN ingestion_run_current AS current ON current.ingestion_run_id = runs.id
       JOIN ingestion_evidence_plans AS plans
         ON plans.ingestion_run_id = runs.id
       WHERE runs.id = ? AND CASE WHEN ${verifiedRunCurrentSql} THEN 1 ELSE json_extract('{}', 'ingestion_run_projection_mismatch') END`,
    )
    .bind(runId);
}

export function evidenceRunByIdempotencyKeyStatement(database: CatalogueStore, key: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(
      `SELECT runs.*, plans.source_lineage, plans.supported_game,
              plans.game_profile_version, plans.adapter_version,
              plans.request_plan_json, plans.plan_origin,
              plans.parent_workflow_id,
              plans.child_workflow_ids_json,
              plans.collection_completed_at
       FROM ingestion_run_read AS runs
       JOIN ingestion_run_current AS current ON current.ingestion_run_id = runs.id
       JOIN ingestion_evidence_plans AS plans
         ON plans.ingestion_run_id = runs.id
       WHERE runs.idempotency_key = ? AND CASE WHEN ${verifiedRunCurrentSql} THEN 1 ELSE json_extract('{}', 'ingestion_run_projection_mismatch') END`,
    )
    .bind(key);
}

export function bindInitialParentWorkflowStatement(
  database: CatalogueStore,
  input: Readonly<{ workflowId: string; runId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE ingestion_evidence_plans SET parent_workflow_id = ?
         WHERE ingestion_run_id = ? AND parent_workflow_id IS NULL`)
    .bind(input.workflowId, input.runId);
}
