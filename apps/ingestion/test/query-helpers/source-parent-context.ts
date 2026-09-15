import { compositionVerificationQuery } from "../../../../src/catalogue/backup-recovery/composition-verification-repository";

export function parentContextArtifactPlan(db: D1Database) {
  const query = compositionVerificationQuery({ kind: "composition-parent-context-artifacts", after: "" });
  return db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.params);
}

export function parentContextRequest(db: D1Database) {
  return db.prepare(`INSERT INTO source_requests
    (ingestion_run_id,request_id,sequence_number,method,url,request_headers_json,
     representation_fingerprint,state,source_snapshot_id,request_role,discovered_from_request_id)
    VALUES (?,?,?,'GET',?,'{}','fixture','captured',NULL,'listing',?)`);
}

export function parentContextAttachSnapshot(db: D1Database) {
  return db.prepare(`UPDATE source_requests SET source_snapshot_id=? WHERE ingestion_run_id=? AND request_id=?`);
}

export function parentContextFetch(db: D1Database) {
  return db.prepare(`INSERT INTO source_fetch_attempts
    (id,ingestion_run_id,request_id,attempt_number,requested_at,completed_at,outcome,response_headers_json)
    VALUES (?,?,?,?,?,?,'success','{}')`);
}

export function parentContextSnapshot(db: D1Database) {
  return db.prepare(`INSERT INTO source_snapshots
    (id,ingestion_run_id,request_id,fetch_attempt_id,request_method,request_url,request_headers_json,
     representation_fingerprint,response_vary_json,retrieved_at,http_status,response_headers_json,media_type,
     content_digest,content_byte_length,content_object_key,source_lineage,supported_game,game_profile_version,adapter_version)
    VALUES (?,?,?,?,'GET',?,'{}','fixture','[]',?,200,'{}','application/json',?,?,?,
      'tcgdex-pokemon-en','pokemon','pokemon@1','fixture-retained-parent-context@1')`);
}

export function parentContextProposalEvidence(db: D1Database) {
  return db.prepare(`INSERT INTO entity_proposal_source_evidence
    (proposal_id,ingestion_run_id,source_snapshot_id,source_observation_id) VALUES (?,?,?,?)`);
}

// Exact canonical identity storage boundary, independent of matching policy.
export function parentContextIdentityReview(db: D1Database) {
  return db.prepare(`INSERT INTO canonical_identity_reviews
    (id,ingestion_run_id,source_lineage,source_observation_id,source_snapshot_id,evidence_json,candidate_printing_ids_json,created_at)
    VALUES (?,?,'tcgdex-pokemon-en',?,?,'{}','[]','2026-09-15T03:00:00.000Z')`);
}

export function parentContextIdentityReviewRun(db: D1Database) {
  return db.prepare(`INSERT INTO canonical_identity_review_runs
    (review_id,ingestion_run_id,source_observation_id,source_snapshot_id) VALUES (?,?,?,?)`);
}

export function parentContextBindingCounts(db: D1Database) {
  return db.prepare(`SELECT
    (SELECT COUNT(*) FROM source_parse_contexts c JOIN source_parse_operations p ON p.id=c.parse_operation_id
      WHERE p.source_snapshot_id=?1) AS contexts,
    (SELECT COUNT(*) FROM source_parse_dependencies d JOIN source_parse_operations p ON p.id=d.parse_operation_id
      WHERE p.source_snapshot_id=?1) AS dependencies`);
}

export function parentContextPlannedParse(db: D1Database) {
  return db.prepare(`SELECT p.id FROM source_parse_operations p
    WHERE p.source_snapshot_id=? AND p.state='planned'
      AND NOT EXISTS(SELECT 1 FROM source_parse_contexts c WHERE c.parse_operation_id=p.id)`);
}

export function restoredParentContextFault(kind: "context" | "dependency", childSnapshot: string, replacement: string) {
  const table = kind === "context" ? "source_parse_contexts" : "source_parse_dependencies";
  return {
    triggers: {
      sql: "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=? ORDER BY name",
      params: [table],
    },
    mutate:
      kind === "context"
        ? {
            sql: "UPDATE source_parse_contexts SET maximum_context_bytes=512 WHERE parse_operation_id IN (SELECT id FROM source_parse_operations WHERE source_snapshot_id=?)",
            params: [childSnapshot],
          }
        : {
            sql: "UPDATE source_parse_dependencies SET parent_source_snapshot_id=? WHERE parse_operation_id IN (SELECT id FROM source_parse_operations WHERE source_snapshot_id=?)",
            params: [replacement, childSnapshot],
          },
    foreignKeys: { sql: "PRAGMA foreign_key_check", params: [] },
  };
}

export function dropRestoredParentContextTrigger(name: string) {
  if (!/^[a-z_]+$/u.test(name)) throw new Error("Invalid parent context fixture trigger name.");
  return { sql: `DROP TRIGGER ${name}`, params: [] };
}

export function parentSnapshotReceiptTrigger(db: D1Database) {
  return db.prepare(
    "SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='source_snapshots_are_immutable_on_update'",
  );
}

export function dropParentSnapshotReceiptTrigger(db: D1Database) {
  return db.prepare("DROP TRIGGER source_snapshots_are_immutable_on_update");
}

export function corruptParentSnapshotReceipt(db: D1Database, kind: "digest" | "length") {
  return db.prepare(
    kind === "digest"
      ? "UPDATE source_snapshots SET content_digest=? WHERE id=?"
      : "UPDATE source_snapshots SET content_byte_length=? WHERE id=?",
  );
}
