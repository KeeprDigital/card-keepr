import { type CatalogueStore, repositoryStatements } from "../shared";
export type SourceAuxiliaryRow = { ordinal: number; content: string; sha256: string };
export type SourceAuxiliaryKind = "request" | "text" | "discovery" | "manifest";
export function retainSourceAuxiliary(
  db: CatalogueStore,
  set: string,
  kind: SourceAuxiliaryKind,
  key: string,
  row: SourceAuxiliaryRow,
) {
  return repositoryStatements(db)
    .prepare(`INSERT INTO source_record_auxiliary(observation_set_id,kind,record_key,ordinal,content,sha256)
    VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
    .bind(set, kind, key, row.ordinal, row.content, row.sha256);
}
export function sourceAuxiliaryPage(
  db: CatalogueStore,
  set: string,
  kind: SourceAuxiliaryKind,
  key: string,
  after: number,
  limit = 8,
) {
  return repositoryStatements(db)
    .prepare(`SELECT ordinal,content,sha256 FROM (
    SELECT *,SUM(length(CAST(content AS BLOB))) OVER (ORDER BY ordinal) AS page_bytes FROM (
      SELECT ordinal,content,sha256 FROM source_record_auxiliary WHERE observation_set_id=? AND kind=? AND record_key=? AND ordinal>? ORDER BY ordinal LIMIT ?
    )) WHERE page_bytes<=512000 ORDER BY ordinal`)
    .bind(set, kind, key, after, Math.min(8, limit));
}
export function advanceSourceRequests(
  db: CatalogueStore,
  set: string,
  after: number,
  next: number,
  digest: string,
  complete = false,
) {
  return repositoryStatements(db)
    .prepare(`UPDATE source_record_progress SET requests_next_ordinal=?,requests_digest=?,requests_complete=?
    WHERE observation_set_id=? AND requests_next_ordinal=? AND sealed=0`)
    .bind(next, digest, complete ? 1 : 0, set, after);
}
export function deleteSourceAuxiliaryForObject(db: CatalogueStore, key: string) {
  return repositoryStatements(db)
    .prepare(`DELETE FROM source_record_auxiliary WHERE rowid IN (
    SELECT a.rowid FROM source_record_auxiliary a JOIN source_parse_operations p ON p.observation_set_id=a.observation_set_id WHERE p.content_object_key=? LIMIT 8
  ) AND EXISTS(SELECT 1 FROM evidence_cleanup_objects WHERE object_key=? AND state='deleting')`)
    .bind(key, key);
}

export function discoveryFactsForSurface(db: CatalogueStore, run: string, lineage: string, surface: string) {
  return repositoryStatements(db)
    .prepare(`SELECT a.content,a.sha256 FROM source_snapshots s
 JOIN source_parse_operations p ON p.source_snapshot_id=s.id AND p.intent='collection'
 JOIN source_record_progress progress ON progress.observation_set_id=p.observation_set_id AND progress.sealed=1
 JOIN source_record_auxiliary a ON a.observation_set_id=p.observation_set_id AND a.kind='discovery' AND a.record_key=?
 WHERE s.ingestion_run_id=? AND s.source_lineage=? ORDER BY a.observation_set_id,a.ordinal LIMIT 2`)
    .bind(surface, run, lineage);
}
export function discoveryParentFact(db: CatalogueStore, run: string, lineage: string, url: string) {
  return repositoryStatements(db)
    .prepare(`SELECT a.content,a.sha256 FROM source_snapshots s
 JOIN source_parse_operations p ON p.source_snapshot_id=s.id AND p.intent='collection'
 JOIN source_record_progress progress ON progress.observation_set_id=p.observation_set_id AND progress.sealed=1
 JOIN source_record_auxiliary a ON a.observation_set_id=p.observation_set_id AND a.kind='discovery'
 WHERE s.ingestion_run_id=? AND s.source_lineage=? AND a.record_key LIKE '@seed:%'
 AND json_extract(a.content,'$.url')=? AND json_extract(a.content,'$.discovered_from.kind')='publisher_navigation'
 ORDER BY a.observation_set_id,a.ordinal LIMIT 1`)
    .bind(run, lineage, url);
}
export function discoveryRootSet(db: CatalogueStore, run: string, lineage: string) {
  return repositoryStatements(db)
    .prepare(`SELECT p.observation_set_id FROM source_snapshots s
 JOIN source_parse_operations p ON p.source_snapshot_id=s.id AND p.intent='collection'
 JOIN source_record_progress progress ON progress.observation_set_id=p.observation_set_id AND progress.sealed=1
 WHERE s.ingestion_run_id=? AND s.source_lineage=? AND s.request_id=? ORDER BY s.retrieved_at,p.id LIMIT 1`)
    .bind(run, lineage, `${lineage}:discovery`);
}

export function recordManifest(db: CatalogueStore, set: string) {
  return repositoryStatements(db)
    .prepare(
      `SELECT content,sha256 FROM source_record_auxiliary WHERE observation_set_id=? AND kind='manifest' AND record_key='' AND ordinal=0`,
    )
    .bind(set);
}
export function attachRecordManifest(
  db: CatalogueStore,
  set: string,
  digest: string,
  requests?: { count: number; sha256: string },
) {
  return repositoryStatements(db)
    .prepare(`UPDATE source_record_progress SET manifest_digest=?,
    requests_next_ordinal=COALESCE(?,requests_next_ordinal),requests_digest=COALESCE(?,requests_digest),requests_complete=1
    WHERE observation_set_id=? AND (manifest_digest IS NULL OR manifest_digest=?)`)
    .bind(digest, requests?.count ?? null, requests?.sha256 ?? null, set, digest);
}
export function observationSetForRecordMigration(db: CatalogueStore, set: string) {
  return repositoryStatements(db).prepare(`SELECT * FROM source_observation_sets WHERE id=?`).bind(set);
}
