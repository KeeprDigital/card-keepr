import { type CatalogueStore, repositoryStatements } from "../shared";
export type SourceRecordRow = {
  ordinal: number;
  source_key: string;
  content: string;
  sha256: string;
  request_json: string;
};
export type SourceRecordProgress = {
  next_ordinal: number;
  digest: string;
  header_json: string;
  sealed: number;
  authoritative: number;
};
export function sourceRecordProgress(db: CatalogueStore, id: string) {
  return repositoryStatements(db)
    .prepare(`SELECT next_ordinal,digest,header_json,sealed,
      EXISTS(SELECT 1 FROM source_observation_sets s WHERE s.id=p.observation_set_id
        AND NOT EXISTS(SELECT 1 FROM evidence_cleanup_objects d WHERE d.object_key=s.content_object_key)) AS authoritative
      FROM source_record_progress p WHERE observation_set_id=?`)
    .bind(id);
}
export function sourceRecordPage(db: CatalogueStore, id: string, after: number, limit = 8) {
  return repositoryStatements(db)
    .prepare(`SELECT ordinal,source_key,content,sha256,request_json FROM (
SELECT *,SUM(length(CAST(content AS BLOB))) OVER (ORDER BY ordinal) AS page_bytes FROM (
SELECT ordinal,source_key,content,sha256,request_json FROM source_record_pages WHERE observation_set_id=? AND ordinal>? ORDER BY ordinal LIMIT ?
)) WHERE page_bytes<=512000 ORDER BY ordinal`)
    .bind(id, after, Math.min(8, limit));
}
export function sourceRecordAt(db: CatalogueStore, id: string, ordinal: number) {
  return repositoryStatements(db)
    .prepare(
      "SELECT ordinal,source_key,content,sha256,request_json FROM source_record_pages WHERE observation_set_id=? AND ordinal=?",
    )
    .bind(id, ordinal);
}
export function initializeSourceRecords(db: CatalogueStore, id: string, digest: string, header: string) {
  return repositoryStatements(db)
    .prepare(
      "INSERT INTO source_record_progress(observation_set_id,next_ordinal,digest,header_json) VALUES (?,0,?,?) ON CONFLICT DO NOTHING",
    )
    .bind(id, digest, header);
}
export function insertSourceRecord(db: CatalogueStore, id: string, row: SourceRecordRow) {
  return repositoryStatements(db)
    .prepare(
      "INSERT INTO source_record_pages(observation_set_id,ordinal,source_key,content,sha256,request_json) VALUES (?,?,?,?,?,?) ON CONFLICT(observation_set_id,ordinal) DO NOTHING",
    )
    .bind(id, row.ordinal, row.source_key, row.content, row.sha256, row.request_json);
}
export function advanceSourceRecords(db: CatalogueStore, id: string, after: number, next: number, digest: string) {
  return repositoryStatements(db)
    .prepare(
      "UPDATE source_record_progress SET next_ordinal=?,digest=? WHERE observation_set_id=? AND next_ordinal=? AND sealed=0",
    )
    .bind(next, digest, id, after);
}
export function sealSourceRecords(db: CatalogueStore, id: string) {
  return repositoryStatements(db)
    .prepare("UPDATE source_record_progress SET sealed=1 WHERE observation_set_id=?")
    .bind(id);
}

/** Delete at most eight retained record payloads after the existing evidence closure authorizes removal. */
export function deleteSourceRecordsForObject(db: CatalogueStore, key: string) {
  return repositoryStatements(db)
    .prepare(`DELETE FROM source_record_pages WHERE rowid IN (
    SELECT records.rowid FROM source_record_pages records JOIN source_parse_operations parse
    ON parse.observation_set_id=records.observation_set_id WHERE parse.content_object_key=? LIMIT 8
  ) AND EXISTS(SELECT 1 FROM evidence_cleanup_objects WHERE object_key=? AND state='deleting')`)
    .bind(key, key);
}
