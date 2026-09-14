// Fixed queries for the Erratum write/restore boundary; callers own execution and values.
export function priorErratumEffects(database: D1Database) {
  return database.prepare(`SELECT namespace, key_digest, observation_ordinal, content, sha256
    FROM reconciliation_reducer_state WHERE preparation_id = ?
    AND namespace IN ('prior_errata', 'current_errata') ORDER BY namespace, observation_ordinal`);
}

export const restoredErratumPublicationSql = `SELECT publication.candidate_id, publication.state,
  publication.request_json, publication.approval_json, predecessor.predecessor_candidate_id,
  accepted.candidate_id AS accepted_candidate_id,
  (SELECT json_group_array(json(document)) FROM (
    SELECT json_object('kind', entity.kind, 'id', entity.entity_id,
    'content', batch.content, 'sha256', batch.sha256) AS document
    FROM publication_read_entities entity JOIN publication_projection_batches batch
      ON batch.candidate_id = entity.candidate_id AND batch.ordinal = entity.batch_ordinal
    WHERE entity.candidate_id = publication.candidate_id AND entity.kind IN ('cards', 'printings', 'errata')
    ORDER BY entity.kind, entity.entity_id))
    AS documents,
  (SELECT json_group_array(json(document)) FROM (
    SELECT json_object('preparation_id', mapping.preparation_id, 'entity_id', mapping.entity_id,
    'source_observation_id', mapping.source_observation_id, 'source_lineage', mapping.source_lineage,
    'source_snapshot_id', mapping.source_snapshot_id, 'source_observation_set_id', mapping.source_observation_set_id,
    'ingestion_run_id', mapping.ingestion_run_id, 'evidence_json', mapping.evidence_json) AS document
    FROM reconciliation_source_mappings mapping
    WHERE mapping.preparation_id IN (publication.candidate_id, predecessor.predecessor_candidate_id)
    AND mapping.entity_id IN (?2, ?3)
    ORDER BY mapping.preparation_id, mapping.entity_id, mapping.source_observation_id)) AS source_mappings
  FROM game_publication_operations publication
  JOIN game_candidate_predecessors predecessor ON predecessor.candidate_id = publication.candidate_id
  JOIN game_accepted_candidates accepted ON accepted.supported_game = 'one-piece'
  WHERE publication.id = ?1`;

export function erratumPublication(database: D1Database) {
  return database.prepare(restoredErratumPublicationSql);
}
