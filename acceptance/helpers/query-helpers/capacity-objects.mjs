export function hasObjectInventory(database) {
  return database.prepare("SELECT 1 FROM sqlite_schema WHERE name='_mf_objects'");
}

export function objectBytesByPrefix(database) {
  return database.prepare(`SELECT
    CASE WHEN instr(key, '/') > 0 THEN substr(key, 1, instr(key, '/') - 1) ELSE key END AS prefix,
    count(*) AS objects, sum(size) AS logical_bytes
    FROM _mf_objects GROUP BY prefix ORDER BY prefix`);
}

export function pilotPublicationApprovals(database) {
  return database.prepare(`SELECT id, candidate_id, manifest_digest, expected_game_revision_id,
    approved_at, approval_json FROM game_publication_operations ORDER BY id`);
}

export function pilotSnapshotEvidence(database) {
  return database.prepare(`SELECT id, ingestion_run_id, content_digest, content_byte_length,
    retrieved_at, reused_source_snapshot_id FROM source_snapshots ORDER BY id`);
}
