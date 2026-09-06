import { type CatalogueStore, repositoryStatements } from "../shared";

/** Collection provenance is distinct from the identity of each proposed game revision. */
export function createGameCandidateIdentitiesStatement(database: CatalogueStore, runId: string) {
  return repositoryStatements(database)
    .prepare(`INSERT INTO game_candidates
    (id, ingestion_run_id, supported_game, expected_game_revision_id, created_at, deadline, state, generation)
    SELECT 'candidate_' || games.ingestion_run_id || '_' || games.game, games.ingestion_run_id, games.game,
      COALESCE((SELECT revision.id FROM catalogue_revisions AS revision
        JOIN ingestion_run_selected_games AS previous ON previous.ingestion_run_id = revision.ingestion_run_id
        WHERE previous.game = games.game ORDER BY revision.published_at DESC, revision.id DESC LIMIT 1), 'catrev_spine_000'),
      operation.created_at, operation.deadline, 'preparing', operation.generation
    FROM ingestion_run_selected_games AS games JOIN reconciliation_operations AS operation ON operation.ingestion_run_id = games.ingestion_run_id
    WHERE games.ingestion_run_id = ? ON CONFLICT (id) DO NOTHING`)
    .bind(runId);
}

export function gameCandidatesForRunStatement(database: CatalogueStore, runId: string) {
  return repositoryStatements(database)
    .prepare(`SELECT * FROM game_candidates WHERE ingestion_run_id = ? ORDER BY supported_game`)
    .bind(runId);
}

export function gameCandidateStatement(database: CatalogueStore, candidateId: string) {
  return repositoryStatements(database).prepare(`SELECT * FROM game_candidates WHERE id = ?`).bind(candidateId);
}

export function gameCandidatePartitionsStatement(database: CatalogueStore, candidateId: string, after: number) {
  return repositoryStatements(database)
    .prepare(`SELECT ordinal, kind, sha256, byte_length, record_count
    FROM game_candidate_partitions WHERE candidate_id = ? AND ordinal > ? ORDER BY ordinal LIMIT 100`)
    .bind(candidateId, after);
}

export function gameCandidatePartitionStatement(database: CatalogueStore, candidateId: string, ordinal: number) {
  return repositoryStatements(database)
    .prepare(`SELECT ordinal, kind, content, sha256, byte_length, record_count
    FROM game_candidate_partitions WHERE candidate_id = ? AND ordinal = ?`)
    .bind(candidateId, ordinal);
}

export function retainGameEntityScopesStatement(
  database: CatalogueStore,
  runId: string,
  kind: "cards" | "printings",
  content: string,
) {
  return repositoryStatements(database)
    .prepare(`INSERT INTO game_candidate_entity_scopes
    (ingestion_run_id, kind, id, supported_game)
    SELECT ?, ?, json_extract(record.value, '$.id'), ${kind === "cards" ? "json_extract(record.value, '$.game')" : "scope.supported_game"}
    FROM json_each(?) AS record ${
      kind === "printings"
        ? `JOIN game_candidate_entity_scopes AS scope
      ON scope.ingestion_run_id = ? AND scope.kind = 'cards' AND scope.id = json_extract(record.value, '$.card_id')`
        : ""
    }
    WHERE 1 ON CONFLICT (ingestion_run_id, kind, id) DO NOTHING`)
    .bind(...(kind === "cards" ? [runId, kind, content] : [runId, kind, content, runId]));
}

export function scopedGamePartitionStatement(
  database: CatalogueStore,
  runId: string,
  game: string,
  kind: string,
  content: string,
  lineages: string,
) {
  const predicate =
    kind === "printings" || kind === "printing_images"
      ? `EXISTS (SELECT 1 FROM game_candidate_entity_scopes AS scope WHERE scope.ingestion_run_id = ?
        AND scope.kind = 'printings' AND scope.id = json_extract(record.value, '${kind === "printings" ? "$.value.id" : "$.value.printing_id"}') AND scope.supported_game = ?)`
      : kind === "selected_games" || kind === "card_observed_games" || kind === "product_observed_games"
        ? "json_extract(record.value, '$.value') = ?"
        : kind === "product_observed_lineages"
          ? "json_extract(record.value, '$.value') IN (SELECT value FROM json_each(?))"
          : kind === "warnings"
            ? "1"
            : "json_extract(record.value, '$.value.game') = ?";
  const bindings =
    kind === "printings" || kind === "printing_images"
      ? [content, runId, game]
      : kind === "warnings"
        ? [content]
        : [content, kind === "product_observed_lineages" ? lineages : game];
  return repositoryStatements(database)
    .prepare(
      `SELECT record.value, record.type FROM json_each(?) AS record WHERE ${predicate} ORDER BY CAST(record.key AS INTEGER)`,
    )
    .bind(...bindings);
}

export function insertGameCandidatePartitionStatement(
  database: CatalogueStore,
  candidateId: string,
  ordinal: number,
  kind: string,
  content: string,
  sha256: string,
  records: number,
) {
  return repositoryStatements(database)
    .prepare(`INSERT INTO game_candidate_partitions
    (candidate_id, ordinal, kind, content, sha256, byte_length, record_count) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (candidate_id, ordinal) DO NOTHING`)
    .bind(candidateId, ordinal, kind, content, sha256, new TextEncoder().encode(content).byteLength, records);
}

export function sealGameCandidateStatement(
  database: CatalogueStore,
  candidateId: string,
  digest: string,
  count: number,
  preparationManifest: string,
) {
  return repositoryStatements(database)
    .prepare(`UPDATE game_candidates SET state = 'sealed', manifest_digest = ?, partition_count = ?, preparation_manifest_digest = ?
    WHERE id = ? AND state = 'preparing' AND CASE WHEN
      (SELECT count(*) FROM game_candidate_partitions WHERE candidate_id = ?) = ?
    THEN 1 ELSE json_extract('{}', 'game_candidate_partition_count_mismatch') END`)
    .bind(digest, count, preparationManifest, candidateId, candidateId, count);
}

/** Temporary run-command adapter; game operation commands replace this as orchestration moves. */
export function synchronizeGameCandidatePauseStatement(database: CatalogueStore, runId: string) {
  return repositoryStatements(database)
    .prepare(`UPDATE game_candidates SET
    state = (SELECT state FROM reconciliation_operations WHERE ingestion_run_id = ?),
    generation = (SELECT generation FROM reconciliation_operations WHERE ingestion_run_id = ?)
    WHERE ingestion_run_id = ? AND state IN ('preparing', 'paused')`)
    .bind(runId, runId, runId);
}
