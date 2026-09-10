import { retainGamePredecessorStatement } from "./game-publication-no-change-repository";
import { atomicRepositoryStatement, type CatalogueStore, repositoryStatements } from "../shared";
import { curatedPreparationStartGuardStatement } from "../curated";

export type GamePreparationIntent = {
  ingestion_run_id: string;
  supported_game: string;
  expected_game_revision_id: string;
  idempotency_key: string;
};

export type GamePreparationCreation = GamePreparationIntent & {
  id: string;
  requestJson: string;
  workflowParamsJson: string;
  workflowId: string;
};

export function collectionGamePredecessorStatement(database: CatalogueStore, game: string) {
  return repositoryStatements(database)
    .prepare(`SELECT revision_id FROM game_catalogue_heads WHERE supported_game = ?`)
    .bind(game);
}

export function gamePreparationRequestStatement(database: CatalogueStore, key: string) {
  return repositoryStatements(database)
    .prepare(`SELECT preparation_id, request_json, workflow_params_json, workflow_instance_id
      FROM game_reconciliation_requests WHERE idempotency_key = ?`)
    .bind(key);
}

export function gamePreparationRequestByIdStatement(database: CatalogueStore, id: string) {
  return repositoryStatements(database)
    .prepare(`SELECT preparation_id, request_json, workflow_params_json, workflow_instance_id
      FROM game_reconciliation_requests WHERE preparation_id = ?`)
    .bind(id);
}

export function createGamePreparationStatement(
  database: CatalogueStore,
  input: GamePreparationCreation,
  at: string,
  definitions: string,
) {
  return atomicRepositoryStatement(database, {
    before: [
      repositoryStatements(database)
        .prepare(`SELECT CASE
          WHEN NOT EXISTS (SELECT 1 FROM ingestion_run_selected_games WHERE ingestion_run_id = ? AND game = ?)
            THEN json_extract('{}', 'game_evidence_not_found')
          WHEN NOT EXISTS (SELECT 1 FROM game_catalogue_heads WHERE supported_game = ? AND revision_id = ?)
            THEN json_extract('{}', 'game_revision_mismatch')
          WHEN EXISTS (SELECT 1 FROM game_candidate_slots WHERE supported_game = ?)
            THEN json_extract('{}', 'game_candidate_slot_occupied')
          WHEN EXISTS (SELECT 1 FROM operation_state WHERE singleton = 1 AND recovery_health <> 'healthy')
            THEN json_extract('{}', 'recovery_not_verified')
          ELSE 1 END`)
        .bind(
          input.ingestion_run_id,
          input.supported_game,
          input.supported_game,
          input.expected_game_revision_id,
          input.supported_game,
        ),
      curatedPreparationStartGuardStatement(database, input.supported_game),
    ],
    statement: repositoryStatements(database)
      .prepare(`INSERT INTO reconciliation_operations
        (id, ingestion_run_id, supported_game, expected_game_revision_id, state, created_at, deadline,
         definition_pins_json, observation_cutoff, identity_decision_cutoff, authority_decision_cutoff)
        VALUES (?, ?, ?, ?, 'preparing', ?, ?, ?,
          COALESCE((SELECT MAX(rowid) FROM source_observation_sets), 0),
          COALESCE((SELECT MAX(rowid) FROM canonical_identity_decisions), 0),
          COALESCE((SELECT MAX(rowid) FROM source_authority_decisions), 0))`)
      .bind(
        input.id,
        input.ingestion_run_id,
        input.supported_game,
        input.expected_game_revision_id,
        at,
        new Date(Date.parse(at) + 604800000).toISOString(),
        definitions,
      ),
    after: [
      repositoryStatements(database)
        .prepare(`INSERT INTO game_candidate_slots (supported_game, preparation_id, ingestion_run_id) VALUES (?, ?, ?)`)
        .bind(input.supported_game, input.id, input.ingestion_run_id),
      repositoryStatements(database)
        .prepare(`INSERT INTO game_candidates
          (id, preparation_id, ingestion_run_id, supported_game, expected_game_revision_id, created_at, deadline, state, generation)
          SELECT id, id, ingestion_run_id, supported_game, expected_game_revision_id, created_at, deadline, state, generation
          FROM reconciliation_operations WHERE id = ?`)
        .bind(input.id),
      retainGamePredecessorStatement(database, input.id),
      repositoryStatements(database)
        .prepare(`INSERT INTO game_reconciliation_requests
          (idempotency_key, preparation_id, request_json, workflow_params_json, workflow_instance_id) VALUES (?, ?, ?, ?, ?)`)
        .bind(input.idempotency_key, input.id, input.requestJson, input.workflowParamsJson, input.workflowId),
    ],
  });
}

export function releaseGamePreparationSlotStatement(database: CatalogueStore, id: string) {
  return repositoryStatements(database)
    .prepare(`DELETE FROM game_candidate_slots WHERE preparation_id = ? AND EXISTS
      (SELECT 1 FROM reconciliation_operations WHERE id = ? AND state IN ('failed', 'abandoned'))`)
    .bind(id, id);
}

export function failGamePreparationStatement(database: CatalogueStore, id: string, code: string, outcome: string) {
  return repositoryStatements(database)
    .prepare(`UPDATE reconciliation_operations SET state = 'failed', failure_code = ?, terminal_result_json = ?
      WHERE id = ? AND supported_game IS NOT NULL AND state = 'preparing'`)
    .bind(code, outcome, id);
}

export function gamePreparationResumeGuardStatement(database: CatalogueStore, id: string, at: string) {
  return repositoryStatements(database)
    .prepare(`SELECT CASE
      WHEN preparation.deadline <= ?2 OR preparation.deadline <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        THEN json_extract('{}', 'reconciliation_deadline_expired')
      WHEN NOT EXISTS (SELECT 1 FROM game_catalogue_heads WHERE supported_game = preparation.supported_game AND revision_id = preparation.expected_game_revision_id)
        THEN json_extract('{}', 'game_revision_mismatch')
      WHEN NOT EXISTS (SELECT 1 FROM game_candidate_slots WHERE supported_game = preparation.supported_game AND preparation_id = preparation.id)
        THEN json_extract('{}', 'reconciliation_generation_conflict')
      WHEN EXISTS (SELECT 1 FROM operation_state WHERE singleton = 1 AND recovery_health <> 'healthy')
        THEN json_extract('{}', 'recovery_not_verified')
      ELSE 1 END FROM reconciliation_operations AS preparation WHERE preparation.id = ?1`)
    .bind(id, at);
}
