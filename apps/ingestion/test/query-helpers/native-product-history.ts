// Dedicated native Product storage oracles; callers own binding and execution.
export function nativeProductIdentity(database: D1Database) {
  return database.prepare(`SELECT entity_id AS id, official_code FROM publication_read_entities
    WHERE candidate_id = ? AND kind = 'products' AND entity_id = ?`);
}

export function mutateNativeProductOfficialCode(database: D1Database) {
  return database.prepare(`UPDATE publication_read_entities SET official_code = 'INCOMPATIBLE-CODE'
    WHERE candidate_id = ? AND kind = 'products' AND entity_id = ?`);
}

// Also executed against the disposable SQL restore through the verification query endpoint.
export const nativeReleaseDocumentSql = `SELECT batch.content FROM publication_read_entities entity
  JOIN publication_projection_batches batch
    ON batch.candidate_id = entity.candidate_id AND batch.ordinal = entity.batch_ordinal
  WHERE entity.candidate_id = ?1 AND entity.kind = 'releases' AND entity.entity_id = ?2`;

export function nativeReleaseDocument(database: D1Database) {
  return database.prepare(nativeReleaseDocumentSql);
}
