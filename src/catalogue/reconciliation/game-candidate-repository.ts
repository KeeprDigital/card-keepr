import { type CatalogueStore, repositoryStatements } from "../shared";

/** Collection provenance is distinct from the identity of each proposed game revision. */
export function createGameCandidateIdentitiesStatement(database: CatalogueStore, runId: string) {
  return repositoryStatements(database)
    .prepare(`WITH RECURSIVE ancestry(id, ingestion_run_id, previous_id, distance) AS (
      SELECT revision.id, revision.ingestion_run_id, revision.expected_previous_revision_id, 0
      FROM catalogue_revisions AS revision JOIN ingestion_runs AS run ON run.expected_current_revision_id = revision.id
      WHERE run.id = ?
      UNION ALL
      SELECT revision.id, revision.ingestion_run_id, revision.expected_previous_revision_id, ancestry.distance + 1
      FROM catalogue_revisions AS revision JOIN ancestry ON ancestry.previous_id = revision.id
    ) INSERT INTO game_candidates
    (id, preparation_id, ingestion_run_id, supported_game, expected_game_revision_id, created_at, deadline, state, generation)
    SELECT 'candidate_' || games.ingestion_run_id || '_' || games.game, operation.id, games.ingestion_run_id, games.game,
      COALESCE((SELECT revision.id FROM ancestry AS revision
        JOIN ingestion_run_selected_games AS previous ON previous.ingestion_run_id = revision.ingestion_run_id
        WHERE previous.game = games.game ORDER BY revision.distance LIMIT 1), 'catrev_spine_000'),
      operation.created_at, operation.deadline, 'preparing', operation.generation
    FROM ingestion_run_selected_games AS games JOIN reconciliation_operations AS operation ON operation.id = games.ingestion_run_id
    WHERE games.ingestion_run_id = ? ON CONFLICT (id) DO NOTHING`)
    .bind(runId, runId);
}

export function gameCandidatesForPreparationStatement(database: CatalogueStore, runId: string) {
  return repositoryStatements(database)
    .prepare(`SELECT * FROM game_candidates WHERE preparation_id = ? ORDER BY supported_game LIMIT 5`)
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
    (preparation_id, kind, id, supported_game)
    SELECT ?, ?, json_extract(record.value, '$.id'), ${kind === "cards" ? "json_extract(record.value, '$.game')" : "scope.supported_game"}
    FROM json_each(?) AS record ${
      kind === "printings"
        ? `JOIN game_candidate_entity_scopes AS scope
      ON scope.preparation_id = ? AND scope.kind = 'cards' AND scope.id = json_extract(record.value, '$.card_id')`
        : ""
    }
    WHERE 1 ON CONFLICT (preparation_id, kind, id) DO NOTHING`)
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
  const warningGame = `COALESCE(json_extract(record.value, '$.value.game'), json_extract(record.value, '$.value.supported_game'),
    CASE WHEN instr(json_extract(record.value, '$.value.profile'), '@') > 0 THEN
      substr(json_extract(record.value, '$.value.profile'), 1, instr(json_extract(record.value, '$.value.profile'), '@') - 1) END,
    (SELECT scope.supported_game FROM game_candidate_entity_scopes AS scope WHERE scope.preparation_id = ?2
      AND ((scope.kind = 'cards' AND scope.id = json_extract(record.value, '$.value.card_id'))
        OR (scope.kind = 'printings' AND scope.id = json_extract(record.value, '$.value.printing_id'))) LIMIT 1),
    (SELECT proposal.game FROM entity_proposals AS proposal WHERE proposal.id = json_extract(record.value, '$.value.proposal_id')),
    (SELECT json_extract(lineage.value, '$.supportedGame') FROM json_each(?4) AS lineage
      WHERE json_extract(lineage.value, '$.sourceLineage') = json_extract(record.value, '$.value.source_lineage') LIMIT 1))`;
  const predicate =
    kind === "printings" || kind === "printing_images"
      ? `EXISTS (SELECT 1 FROM game_candidate_entity_scopes AS scope WHERE scope.preparation_id = ?2
        AND scope.kind = 'printings' AND scope.id = json_extract(record.value, '${kind === "printings" ? "$.value.id" : "$.value.printing_id"}') AND scope.supported_game = ?3)`
      : kind === "selected_games" || kind === "card_observed_games" || kind === "product_observed_games"
        ? "json_extract(record.value, '$.value') = ?3"
        : kind === "product_observed_lineages"
          ? "json_extract(record.value, '$.value') IN (SELECT json_extract(value, '$.sourceLineage') FROM json_each(?4) WHERE json_extract(value, '$.supportedGame') = ?3)"
          : kind === "warnings"
            ? `${warningGame} = ?3`
            : kind === "shared_warnings"
              ? `${warningGame} IS NULL`
              : "json_extract(record.value, '$.value.game') = ?3";
  return repositoryStatements(database)
    .prepare(
      `SELECT record.value, record.type FROM json_each(?1) AS record WHERE ?2 IS NOT NULL AND ?3 IS NOT NULL AND ?4 IS NOT NULL AND ${predicate} ORDER BY CAST(record.key AS INTEGER)`,
    )
    .bind(content, runId, game, lineages);
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
  runId: string,
  candidateId: string,
  digest: string,
  count: number,
  preparationManifest: string,
) {
  return repositoryStatements(database)
    .prepare(`UPDATE game_candidates SET state = 'sealed', manifest_digest = ?, partition_count = ?, preparation_manifest_digest = ?
    WHERE id = ? AND state = 'preparing' AND CASE WHEN
      EXISTS (SELECT 1 FROM (
        SELECT content FROM reconciliation_checkpoints WHERE preparation_id = ? AND phase = 'game_preparation'
        ORDER BY ordinal DESC LIMIT 1
      ) AS checkpoint, json_each(checkpoint.content, '$.seals') AS seal
      WHERE json_extract(checkpoint.content, '$.stage') = 'complete'
        AND json_extract(checkpoint.content, '$.inputManifest') = ?
        AND json_extract(seal.value, '$.id') = ? AND json_extract(seal.value, '$.digest') = ?
        AND json_extract(seal.value, '$.count') = ?)
    THEN 1 ELSE json_extract('{}', 'game_candidate_partition_count_mismatch') END`)
    .bind(digest, count, preparationManifest, candidateId, runId, preparationManifest, candidateId, digest, count);
}

/** Temporary run-command adapter; game operation commands replace this as orchestration moves. */
export function synchronizeGameCandidatePauseStatement(database: CatalogueStore, runId: string) {
  return repositoryStatements(database)
    .prepare(`UPDATE game_candidates SET
    state = (SELECT state FROM reconciliation_operations WHERE id = ?),
    generation = (SELECT generation FROM reconciliation_operations WHERE id = ?)
    WHERE preparation_id = ? AND state IN ('preparing', 'paused')`)
    .bind(runId, runId, runId);
}
