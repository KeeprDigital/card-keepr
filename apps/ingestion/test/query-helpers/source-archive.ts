import type { CatalogueStore } from "../../../../src/catalogue/shared";
import { repositoryStatements } from "../../../../src/catalogue/shared";

export function insertArchiveFixtureAttempt(db: CatalogueStore) {
  return repositoryStatements(db).prepare(`INSERT INTO source_fetch_attempts
    (id,ingestion_run_id,request_id,attempt_number,requested_at,completed_at,outcome,response_headers_json)
    VALUES (?,?,?,?,?,?,?,?)`);
}
export function insertArchiveFixtureSnapshot(db: CatalogueStore) {
  return repositoryStatements(db).prepare(`INSERT INTO source_snapshots
    (id,ingestion_run_id,request_id,fetch_attempt_id,request_method,request_url,request_headers_json,
    representation_fingerprint,response_vary_json,retrieved_at,http_status,response_headers_json,media_type,
    content_digest,content_byte_length,content_object_key,source_lineage,supported_game,game_profile_version,adapter_version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
}
export function markArchiveFixtureCaptured(db: CatalogueStore) {
  return repositoryStatements(db).prepare(`UPDATE source_requests SET state='captured',source_snapshot_id=?
    WHERE ingestion_run_id=? AND request_id=?`);
}
export function archiveFixtureSnapshot(db: CatalogueStore) {
  return repositoryStatements(db).prepare("SELECT * FROM source_snapshots WHERE id=?");
}
export function archiveImageSnapshot(db: CatalogueStore) {
  return repositoryStatements(db).prepare(`SELECT snapshot.* FROM source_requests request
    JOIN source_snapshots snapshot ON snapshot.id=request.source_snapshot_id
    WHERE request.ingestion_run_id=? AND request.request_id=?`);
}
export function archiveReplacementFetch(db: CatalogueStore) {
  return repositoryStatements(db).prepare(`INSERT INTO source_fetch_attempts
    (id,ingestion_run_id,request_id,attempt_number,requested_at,completed_at,outcome,response_headers_json)
    SELECT ?1,s.ingestion_run_id,s.request_id,
      (SELECT COALESCE(MAX(attempt_number),0)+1 FROM source_fetch_attempts WHERE ingestion_run_id=s.ingestion_run_id AND request_id=s.request_id),
      ?2,?2,?3,?4 FROM source_snapshots s WHERE s.id=?5`);
}
export function archiveReplacementSnapshot(db: CatalogueStore) {
  return repositoryStatements(db).prepare(`INSERT INTO source_snapshots
    (id,ingestion_run_id,request_id,fetch_attempt_id,request_method,request_url,request_headers_json,
     representation_fingerprint,response_vary_json,retrieved_at,http_status,response_headers_json,media_type,
     content_digest,content_byte_length,content_object_key,source_lineage,supported_game,game_profile_version,adapter_version,reused_source_snapshot_id)
    SELECT ?1,ingestion_run_id,request_id,?1,request_method,request_url,request_headers_json,
      representation_fingerprint,response_vary_json,?2,?3,response_headers_json,media_type,
      content_digest,content_byte_length,?4,source_lineage,supported_game,game_profile_version,adapter_version,?5
    FROM source_snapshots WHERE id=?6`);
}
export function archiveMoveSnapshotPointer(db: CatalogueStore) {
  return repositoryStatements(db).prepare(
    "UPDATE source_requests SET source_snapshot_id=? WHERE ingestion_run_id=? AND request_id=?",
  );
}
export function archiveDecodeReceipt(db: CatalogueStore) {
  return repositoryStatements(db).prepare(
    "SELECT next_block,next_record,state,digest FROM source_archive_decodes WHERE source_snapshot_id=?",
  );
}
export function archiveBlockReceipts(db: CatalogueStore) {
  return repositoryStatements(db).prepare(
    "SELECT * FROM source_archive_blocks WHERE source_snapshot_id=? ORDER BY ordinal",
  );
}
export function archiveObservationCount(db: CatalogueStore) {
  return repositoryStatements(db).prepare(
    "SELECT count(*) AS count FROM source_observation_sets WHERE source_snapshot_id=?",
  );
}
export function archiveRecordCount(db: CatalogueStore) {
  return repositoryStatements(db).prepare("SELECT MAX(next_ordinal) AS count FROM source_record_progress");
}
export function archiveParseCursor(db: CatalogueStore) {
  return repositoryStatements(db).prepare(`SELECT p.next_record,p.next_variant,p.observation_count
    FROM source_archive_parse_progress p JOIN source_parse_operations o ON o.observation_set_id=p.observation_set_id
    WHERE o.source_snapshot_id=?`);
}
export function archiveRequestCount(db: CatalogueStore) {
  return repositoryStatements(db).prepare("SELECT count(*) AS count FROM source_requests WHERE ingestion_run_id=?");
}

export function uploadedArchiveObservationInput(db: CatalogueStore) {
  return repositoryStatements(db).prepare(`SELECT p.observation_set_id AS observationSetId,p.id AS operationId,
    s.id AS snapshotId,s.source_lineage AS sourceLineage,s.supported_game AS supportedGame,
    s.game_profile_version AS gameProfileVersion,p.adapter_version AS adapterVersion,p.parsed_at AS parsedAt,
    p.content_digest AS digest,p.content_byte_length AS byteLength,p.content_object_key AS objectKey,
    p.observation_count AS observationCount FROM source_parse_operations p JOIN source_snapshots s ON s.id=p.source_snapshot_id
    WHERE s.id=? AND p.state='uploaded'`);
}

export function restoredArchiveFaultQueries(
  kind: "block" | "record",
  snapshot: string,
  set: string,
  ordinal: number,
  digest: string,
) {
  const table = kind === "block" ? "source_archive_blocks" : "source_record_pages";
  return {
    triggers: {
      sql: "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=? ORDER BY name",
      params: [table],
    },
    mutate:
      kind === "block"
        ? {
            sql: "UPDATE source_archive_blocks SET sha256=? WHERE source_snapshot_id=? AND ordinal=?",
            params: [digest, snapshot, ordinal],
          }
        : { sql: "DELETE FROM source_record_pages WHERE observation_set_id=? AND ordinal=?", params: [set, ordinal] },
    foreignKeys: { sql: "PRAGMA foreign_key_check", params: [] },
  };
}

export function dropRestoredArchiveTrigger(name: string) {
  if (!/^[a-z_]+$/u.test(name)) throw new Error("Unexpected archive fixture trigger name.");
  return { sql: `DROP TRIGGER "${name}"`, params: [] };
}

export function archiveBoundarySnapshot(db: CatalogueStore) {
  return repositoryStatements(db).prepare(`INSERT INTO source_snapshots
    (id,ingestion_run_id,request_id,fetch_attempt_id,request_method,request_url,request_headers_json,
     representation_fingerprint,response_vary_json,retrieved_at,http_status,response_headers_json,media_type,
     content_digest,content_byte_length,content_object_key,source_lineage,supported_game,game_profile_version,adapter_version)
    SELECT ?1,ingestion_run_id,request_id,?1,request_method,request_url,request_headers_json,
      representation_fingerprint,response_vary_json,?2,?7,response_headers_json,media_type,
      ?3,?4,?5,source_lineage,supported_game,game_profile_version,adapter_version
    FROM source_snapshots WHERE id=?6`);
}
export function archiveBoundaryParse(db: CatalogueStore) {
  return repositoryStatements(db).prepare(`INSERT INTO source_parse_operations
    (id,source_snapshot_id,adapter_version,intent,idempotency_key,observation_set_id,content_object_key,
     parsed_at,state,content_digest,content_byte_length,observation_count)
    SELECT ?1,id,adapter_version,?7,?1,?1,?3,?4,?8,?5,?6,?9 FROM source_snapshots WHERE id=?2`);
}
export function archiveBoundaryObservationSet(db: CatalogueStore) {
  return repositoryStatements(db).prepare(`INSERT INTO source_observation_sets
    (id,parse_operation_id,source_snapshot_id,source_lineage,supported_game,game_profile_version,adapter_version,
     parsed_at,content_digest,content_byte_length,content_object_key,observation_count)
    SELECT ?1,?1,id,source_lineage,supported_game,game_profile_version,adapter_version,?3,?4,?5,?6,?7
    FROM source_snapshots WHERE id=?2`);
}
