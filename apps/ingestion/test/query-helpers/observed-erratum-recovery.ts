// Fixed retained effects at the source-observed Erratum merge boundary.
export function observedErratumEffects(database: D1Database) {
  return database.prepare(`SELECT namespace, key_digest, observation_ordinal, content, sha256
    FROM reconciliation_reducer_state WHERE preparation_id = ?
    AND namespace IN ('prior_errata', 'observed_errata', 'current_errata')
    ORDER BY namespace, observation_ordinal`);
}
