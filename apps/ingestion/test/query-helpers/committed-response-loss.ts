// Fixed reads of the durable effects around native preparation and publication response-loss boundaries.
export function preparationTextChunks(database: D1Database) {
  return database.prepare(`SELECT sha256, ordinal, content FROM reconciliation_text_chunks
    WHERE preparation_id = ? ORDER BY sha256, ordinal`);
}

export function preparationNormalizedObservations(database: D1Database) {
  return database.prepare(`SELECT observation_id, content, sha256, card_erratum_target_digest
    FROM reconciliation_normalized_observations WHERE preparation_id = ? ORDER BY observation_id`);
}

export function preparationSourceMappings(database: D1Database) {
  return database.prepare(`SELECT entity_id, source_observation_id, entity_kind, evidence_json, mapped_at
    FROM reconciliation_source_mappings WHERE preparation_id = ? ORDER BY entity_id, source_observation_id`);
}

export function identityAllocations(database: D1Database) {
  return database.prepare(`SELECT allocation_key, entity_id, entity_kind, allocated_at
    FROM canonical_identity_allocations ORDER BY allocation_key`);
}

export function preparationCheckpoints(database: D1Database) {
  return database.prepare(`SELECT phase, ordinal, sha256 FROM reconciliation_checkpoints
    WHERE preparation_id = ? ORDER BY phase, ordinal`);
}

export function preparationSeal(database: D1Database) {
  return database.prepare(`SELECT operation.state AS operation_state, operation.candidate_digest,
    operation.manifest_digest AS operation_manifest, candidate.state AS candidate_state,
    candidate.manifest_digest, candidate.partition_count, receipt.content_digest AS semantic_digest
    FROM reconciliation_operations AS operation
    JOIN game_candidates AS candidate ON candidate.preparation_id = operation.id
    LEFT JOIN game_candidate_semantic_receipts AS receipt ON receipt.candidate_id = candidate.id
    WHERE operation.id = ?`);
}

export function curatedPins(database: D1Database) {
  return database.prepare(`SELECT preparation_id, revision_cutoff, event_cutoff
    FROM reconciliation_curated_pins ORDER BY preparation_id`);
}

export function curatedRevisionRowid(database: D1Database) {
  return database.prepare(`SELECT rowid FROM curated_revisions WHERE id = ?`);
}

export function publicationSwitchEffects(database: D1Database) {
  return database.prepare(`SELECT publication.state, publication.resulting_revision_id, publication.backup_attempt_id,
    (SELECT current_revision_id FROM catalogue_state WHERE singleton = 1) AS composition_head,
    (SELECT revision_id FROM game_catalogue_heads WHERE supported_game = ?2) AS game_head,
    (SELECT COUNT(*) FROM catalogue_revisions WHERE publication_operation_id = publication.id) AS revisions,
    (SELECT COUNT(*) FROM catalogue_composition_games WHERE catalogue_revision_id = publication.resulting_revision_id)
      AS members,
    (SELECT COUNT(*) FROM catalogue_backup_attempts WHERE publication_operation_id = publication.id) AS backups,
    (SELECT state FROM catalogue_backup_attempts WHERE idempotency_key = publication.backup_attempt_id) AS backup_state,
    (SELECT COUNT(*) FROM catalogue_candidate_publications WHERE candidate_id = publication.candidate_id)
      AS candidate_publications
    FROM game_publication_operations AS publication WHERE publication.id = ?1`);
}
