import { atomicRepositoryStatement, type CatalogueStore, repositoryStatements } from "../shared";

export function createReconciliationOperationStatement(
  database: CatalogueStore,
  runId: string,
  at: string,
  definitions: string,
) {
  const statement = repositoryStatements(database)
    .prepare(`INSERT OR IGNORE INTO reconciliation_operations
    (ingestion_run_id, id, state, created_at, deadline, definition_pins_json, observation_cutoff, identity_decision_cutoff, authority_decision_cutoff)
    VALUES (?, ?, 'preparing', ?, ?, ?,
      COALESCE((SELECT MAX(rowid) FROM source_observation_sets), 0),
      COALESCE((SELECT MAX(rowid) FROM canonical_identity_decisions), 0),
      COALESCE((SELECT MAX(rowid) FROM source_authority_decisions), 0))`)
    .bind(runId, `reconciliation_${runId}`, at, new Date(Date.parse(at) + 604800000).toISOString(), definitions);
  return atomicRepositoryStatement(database, {
    statement,
    before: [
      repositoryStatements(database)
        .prepare(`SELECT CASE WHEN
      NOT EXISTS (SELECT 1 FROM reconciliation_operations WHERE ingestion_run_id = ?)
      AND EXISTS (SELECT 1 FROM game_candidate_slots AS slot
        JOIN ingestion_run_selected_games AS game ON game.game = slot.supported_game
        WHERE game.ingestion_run_id = ? AND slot.ingestion_run_id <> ?)
      THEN json_extract('{}', 'game_candidate_slot_occupied') ELSE 1 END`)
        .bind(runId, runId, runId),
    ],
    after: [
      repositoryStatements(database)
        .prepare(`INSERT INTO game_candidate_slots (supported_game, ingestion_run_id)
      SELECT game, ingestion_run_id FROM ingestion_run_selected_games WHERE ingestion_run_id = ? AND changes() = 1`)
        .bind(runId),
    ],
  });
}

export function reconciliationOperationStatement(database: CatalogueStore, runId: string) {
  return repositoryStatements(database)
    .prepare(`SELECT id AS reconciliation_id, ingestion_run_id,
    state, generation, created_at, deadline, completed_partitions,
    (SELECT count(*) FROM reconciliation_preparation_batches WHERE ingestion_run_id = reconciliation_operations.ingestion_run_id) AS completed_batches,
    (SELECT count(*) FROM reconciliation_input_partitions WHERE ingestion_run_id = reconciliation_operations.ingestion_run_id) AS completed_input_partitions,
    (SELECT count(*) FROM reconciliation_verified_documents WHERE ingestion_run_id = reconciliation_operations.ingestion_run_id) AS completed_documents,
    (SELECT count(*) FROM reconciliation_reducer_state WHERE ingestion_run_id = reconciliation_operations.ingestion_run_id) AS completed_reducer_records,
    (SELECT count(*) FROM reconciliation_normalized_observations WHERE ingestion_run_id = reconciliation_operations.ingestion_run_id) AS completed_observations,
    EXISTS (SELECT 1 FROM entity_admission_run_pins WHERE ingestion_run_id = reconciliation_operations.ingestion_run_id) AS admission_selection_pinned,
    (SELECT count(*) FROM entity_admission_pinned_decisions WHERE ingestion_run_id = reconciliation_operations.ingestion_run_id) AS admission_decision_count,
    candidate_digest, manifest_digest, input_manifest_digest, failure_code, definition_pins_json, observation_cutoff, identity_decision_cutoff, authority_decision_cutoff
    FROM reconciliation_operations WHERE ingestion_run_id = ?`)
    .bind(runId);
}

export function sealReconciliationOperationStatement(
  database: CatalogueStore,
  runId: string,
  digest: string,
  manifestDigest: string,
  partitionCount: number,
) {
  return repositoryStatements(database)
    .prepare(`UPDATE reconciliation_operations SET state = 'sealed',
    candidate_digest = ?, manifest_digest = ? WHERE ingestion_run_id = ? AND state = 'preparing'
    AND CASE WHEN input_manifest_digest IS NOT NULL AND completed_partitions = ? THEN 1 ELSE json_extract('{}', 'reconciliation_partition_count_mismatch') END`)
    .bind(digest, manifestDigest, runId, partitionCount);
}

export function insertReconciliationPartitionStatement(
  database: CatalogueStore,
  input: {
    runId: string;
    ordinal: number;
    kind: string;
    content: string;
    sha256: string;
    bytes: number;
    records: number;
  },
) {
  const statement = repositoryStatements(database)
    .prepare(`INSERT INTO reconciliation_record_partitions
    (ingestion_run_id, ordinal, kind, content, sha256, byte_length, record_count) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (ingestion_run_id, ordinal) DO NOTHING`)
    .bind(input.runId, input.ordinal, input.kind, input.content, input.sha256, input.bytes, input.records);
  return atomicRepositoryStatement(database, {
    statement,
    before: [
      repositoryStatements(database)
        .prepare(`SELECT CASE WHEN EXISTS (
      SELECT 1 FROM reconciliation_operations WHERE ingestion_run_id = ? AND state = 'preparing'
    ) THEN 1 ELSE json_extract('{}', 'reconciliation_not_preparing') END`)
        .bind(input.runId),
    ],
    after: [
      repositoryStatements(database)
        .prepare(`UPDATE reconciliation_operations
      SET completed_partitions = completed_partitions + 1 WHERE ingestion_run_id = ? AND changes() = 1`)
        .bind(input.runId),
    ],
  });
}

export function reconciliationPartitionsStatement(database: CatalogueStore, runId: string, after: number) {
  return repositoryStatements(database)
    .prepare(`SELECT ordinal, kind, sha256, byte_length, record_count
    FROM reconciliation_record_partitions WHERE ingestion_run_id = ? AND ordinal > ? ORDER BY ordinal LIMIT 100`)
    .bind(runId, after);
}

export function reconciliationWriterGuard(database: CatalogueStore, runId: string, generation: number) {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN EXISTS (
    SELECT 1 FROM reconciliation_operations AS reconciliation CROSS JOIN operation_state AS operation
    WHERE reconciliation.ingestion_run_id = ? AND reconciliation.generation = ? AND reconciliation.state = 'preparing'
      AND operation.singleton = 1 AND operation.recovery_health <> 'blocked'
  ) THEN 1 ELSE json_extract('{}', 'reconciliation_writer_fenced') END`)
    .bind(runId, generation);
}

export function reconciliationActionStatement(database: CatalogueStore, key: string) {
  return repositoryStatements(database)
    .prepare(`SELECT request_json, result_json FROM reconciliation_actions WHERE idempotency_key = ?`)
    .bind(key);
}

export function reconciliationActionUpdate(
  database: CatalogueStore,
  runId: string,
  action: "pause" | "resume" | "abandon",
  generation: number,
) {
  const from = action === "resume" || action === "abandon" ? "paused" : "preparing";
  const to = action === "pause" ? "paused" : action === "resume" ? "preparing" : "abandoned";
  return repositoryStatements(database)
    .prepare(`UPDATE reconciliation_operations SET state = ?, generation = generation + ?
    WHERE ingestion_run_id = ? AND state = ? AND generation = ?`)
    .bind(to, action === "resume" ? 0 : 1, runId, from, generation);
}

export function reconciliationActionGuard(
  database: CatalogueStore,
  runId: string,
  action: "pause" | "resume" | "abandon",
  generation: number,
) {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN EXISTS (
    SELECT 1 FROM reconciliation_operations WHERE ingestion_run_id = ? AND state = ? AND generation = ?
  ) THEN 1 ELSE json_extract('{}', 'reconciliation_generation_conflict') END`)
    .bind(runId, action === "pause" ? "preparing" : "paused", generation);
}

export function retainReconciliationAction(
  database: CatalogueStore,
  runId: string,
  key: string,
  request: string,
  result: string,
) {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciliation_actions (ingestion_run_id, idempotency_key, request_json, result_json)
    VALUES (?, ?, ?, ?)`)
    .bind(runId, key, request, result);
}

export function pauseFailedReconciliationStatement(
  database: CatalogueStore,
  runId: string,
  generation: number,
  detail: string,
) {
  return repositoryStatements(database)
    .prepare(`UPDATE reconciliation_operations SET state = 'paused',
    generation = generation + 1, failure_code = ? WHERE ingestion_run_id = ? AND generation = ? AND state = 'preparing'`)
    .bind(detail.slice(0, 1024), runId, generation);
}

export function reconciliationRequestForRunStatement(database: CatalogueStore, runId: string) {
  return repositoryStatements(database)
    .prepare(`SELECT * FROM reconciliation_workflow_requests WHERE ingestion_run_id = ?`)
    .bind(runId);
}

export function reconciliationPartitionStatement(database: CatalogueStore, runId: string, ordinal: number) {
  return repositoryStatements(database)
    .prepare(`SELECT kind, content, sha256, byte_length, record_count
    FROM reconciliation_record_partitions WHERE ingestion_run_id = ? AND ordinal = ?`)
    .bind(runId, ordinal);
}

export function reconciliationSelectedGamesStatement(database: CatalogueStore, runId: string) {
  return repositoryStatements(database)
    .prepare(`SELECT json_group_array(game) AS games_json FROM (
    SELECT game FROM ingestion_run_selected_games WHERE ingestion_run_id = ? ORDER BY game
  )`)
    .bind(runId);
}
