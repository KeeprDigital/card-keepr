// One captured source response; tests own bytes, values and real parsing.
export function curatedEvidenceRequest(db: D1Database) {
  return db.prepare(`INSERT INTO source_requests
    (ingestion_run_id,request_id,sequence_number,method,url,request_headers_json,representation_fingerprint,state)
    VALUES (?,?,1,'GET',?,'{}','fixture','captured')`);
}
export function curatedEvidenceFetch(db: D1Database) {
  return db.prepare(`INSERT INTO source_fetch_attempts
    (id,ingestion_run_id,request_id,attempt_number,requested_at,completed_at,outcome,response_headers_json)
    VALUES (?,?,?,1,'2026-08-01T00:00:00.000Z','2026-08-01T00:00:00.000Z','success','{}')`);
}
export function curatedEvidenceSnapshot(db: D1Database) {
  return db.prepare(`INSERT INTO source_snapshots
    (id,ingestion_run_id,request_id,fetch_attempt_id,request_method,request_url,request_headers_json,representation_fingerprint,response_vary_json,retrieved_at,http_status,response_headers_json,media_type,content_digest,content_byte_length,content_object_key,source_lineage,supported_game,game_profile_version,adapter_version)
    VALUES (?,?,?,?,'GET',?,'{}','fixture','[]','2026-08-01T00:00:00.000Z',200,'{}','application/json',?,?,?,'riftbound-en','riftbound','riftbound@1','riftbound-en@1')`);
}

export function historicalCuratedStatus(db: D1Database) {
  return db.prepare("UPDATE curated_revisions SET status=?,event_version=2 WHERE id=?");
}
export function historicalCuratedBytes(db: D1Database) {
  return db.prepare("SELECT proposal_json,content_digest,schema_binding_json FROM curated_revisions WHERE id=?");
}

export function historicalCuratedReceipt(db: D1Database) {
  return db.prepare("SELECT response_json FROM curated_revision_idempotency WHERE idempotency_key=?");
}
