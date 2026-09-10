// Dedicated native Product storage oracles; callers own binding and execution.
export function nativeProductIdentity(database: D1Database) {
  return database.prepare(`SELECT entity_id AS id, official_code FROM publication_read_entities
    WHERE candidate_id = ? AND kind = 'products' AND entity_id = ?`);
}

export function mutateNativeProductOfficialCode(database: D1Database) {
  return database.prepare(`UPDATE publication_read_entities SET official_code = 'INCOMPATIBLE-CODE'
    WHERE candidate_id = ? AND kind = 'products' AND entity_id = ?`);
}
