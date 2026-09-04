import { curatedRunStartGuardStatement } from "../curated";
import { atomicRepositoryStatement, runStartGuardStatement } from "../shared";
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
  lifecycleV2: boolean,
): D1PreparedStatement {
  const baseValues = [
    input.runId,
    canonicalJson(input.supportedGames),
    input.startedAt,
    input.linkedRunId,
    input.idempotencyKey,
    input.operationalRequestId ?? null,
  ];
  if (lifecycleV2) {
    return atomicRepositoryStatement(database, {
      statement: repositoryStatements(database)
        .prepare(
          `INSERT INTO ingestion_runs (
          id, state, selected_games_json, started_at,
          expected_current_revision_id, linked_run_id, idempotency_key,
          operational_request_id,
          candidate_digest, candidate_created_at, approval_deadline,
          approval_json, published_revision_id, export_manifest_digest,
          terminal_at, candidate_json, approval_idempotency_key,
          progress_json, warnings_json, approval_history_json
        ) SELECT
          ?, 'collecting', ?, ?, catalogue.current_revision_id, ?, ?, ?,
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{}', NULL,
          '{"completed_stages":["planning"],"current_stage":"collecting"}',
          '[]', '[]'
        FROM catalogue_state AS catalogue
        JOIN operation_state AS operation ON operation.singleton = 1
        WHERE catalogue.singleton = 1
          AND operation.recovery_health <> 'blocked'
          AND operation.active_ingestion_run_id IS NULL`,
        )
        .bind(...baseValues),
      after: [runStartGuardStatement(database), curatedRunStartGuardStatement(database, input.runId)],
    });
  }
  return atomicRepositoryStatement(database, {
    statement: repositoryStatements(database)
      .prepare(
        `INSERT INTO ingestion_runs (
        id, state, selected_games_json, started_at,
        expected_current_revision_id, linked_run_id, idempotency_key,
        operational_request_id,
        candidate_digest, candidate_created_at, approval_deadline,
        approval_json, published_revision_id, export_manifest_digest,
        terminal_at, candidate_json, approval_idempotency_key
      ) SELECT
        ?, 'collecting', ?, ?, catalogue.current_revision_id, ?, ?, ?,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{}', NULL
      FROM catalogue_state AS catalogue
      JOIN operation_state AS operation ON operation.singleton = 1
      WHERE catalogue.singleton = 1
        AND operation.recovery_health <> 'blocked'
        AND operation.active_ingestion_run_id IS NULL`,
      )
      .bind(...baseValues),
    after: [runStartGuardStatement(database), curatedRunStartGuardStatement(database, input.runId)],
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
       FROM ingestion_runs AS runs
       JOIN ingestion_evidence_plans AS plans
         ON plans.ingestion_run_id = runs.id
       WHERE runs.id = ?`,
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
       FROM ingestion_runs AS runs
       JOIN ingestion_evidence_plans AS plans
         ON plans.ingestion_run_id = runs.id
       WHERE runs.idempotency_key = ?`,
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
