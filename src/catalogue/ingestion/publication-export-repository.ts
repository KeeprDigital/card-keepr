import { type CatalogueStore, repositoryStatements } from "../shared";
export type PublicExportState = {
  publication_operation_id: string;
  candidate_id: string;
  revision_id: string;
  state: "preparing" | "verified" | "failed";
  sequence: number;
  cursor_json: string;
  component_count: number;
  root_digest: string | null;
  root_object_key: string | null;
  root_bytes: number | null;
  failure_code: string | null;
};
export function reserveExportAttempt(db: CatalogueStore, id: string, generation: number, shard: number) {
  const prefix = `public-export-attempt:${id}:${generation}:${shard}:`;
  return repositoryStatements(db)
    .prepare(`INSERT INTO game_publication_actions
 SELECT ?,id,?,? FROM game_publication_operations WHERE id=? AND generation=?
 AND state IN ('approved','waiting_artifacts','waiting_backup') AND julianday(deadline)>julianday('now')
 AND (SELECT count(*) FROM game_publication_actions WHERE idempotency_key>=? AND idempotency_key<?)<40
 RETURNING idempotency_key`)
    .bind(
      `${prefix}${crypto.randomUUID()}`,
      JSON.stringify({ contract: "public-export-attempt@1", generation, shard }),
      "{}",
      id,
      generation,
      prefix,
      `${prefix}~`,
    );
}
export function exportPreparation(db: CatalogueStore, id: string) {
  return repositoryStatements(db)
    .prepare("SELECT * FROM publication_export_preparations WHERE publication_operation_id=?")
    .bind(id);
}
export function exportOwner(db: CatalogueStore, id: string) {
  return repositoryStatements(db)
    .prepare(`SELECT p.*,c.supported_game,a.state AS private_state,a.root_digest AS private_root_digest,
 (SELECT state FROM card_search_fts_state WHERE singleton=1) AS search_state,
 (SELECT recovery_health FROM operation_state WHERE singleton=1) AS recovery_health,
 (SELECT revision_id FROM game_catalogue_heads WHERE supported_game=c.supported_game) AS current_game_revision
 FROM game_publication_operations p JOIN game_candidates c ON c.id=p.candidate_id
 LEFT JOIN publication_preparations a ON a.candidate_id=p.candidate_id WHERE p.id=?`)
    .bind(id);
}
export function exportReplay(db: CatalogueStore, key: string) {
  return repositoryStatements(db)
    .prepare("SELECT request_json,result_json FROM game_publication_actions WHERE idempotency_key=?")
    .bind(key);
}
export function guardExportUnit(db: CatalogueStore, id: string, generation: number, sequence: number) {
  return repositoryStatements(db)
    .prepare(`SELECT CASE
 WHEN NOT EXISTS (SELECT 1 FROM game_publication_operations p JOIN game_candidates c ON c.id=p.candidate_id JOIN game_catalogue_heads h ON h.supported_game=c.supported_game AND h.revision_id=p.expected_game_revision_id
 JOIN publication_preparations a ON a.candidate_id=c.id AND a.state='verified' AND a.manifest_digest=p.manifest_digest
 WHERE p.id=?1 AND p.generation=?2 AND p.state IN ('approved','waiting_artifacts','waiting_backup') AND julianday(p.deadline)>julianday('now') AND c.state='sealed' AND c.generation=p.candidate_generation)
 THEN json_extract('{}','publication_export_owner_conflict')
 WHEN COALESCE((SELECT sequence FROM publication_export_preparations WHERE publication_operation_id=?1),0)<>?3 THEN json_extract('{}','publication_export_sequence_conflict')
 ELSE 1 END`)
    .bind(id, generation, sequence);
}
export function createExportPreparation(db: CatalogueStore, s: PublicExportState) {
  return repositoryStatements(db)
    .prepare("INSERT INTO publication_export_preparations VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .bind(
      s.publication_operation_id,
      s.candidate_id,
      s.revision_id,
      s.state,
      s.sequence,
      s.cursor_json,
      s.component_count,
      s.root_digest,
      s.root_object_key,
      s.root_bytes,
      s.failure_code,
    );
}
export function updateExportPreparation(db: CatalogueStore, s: PublicExportState) {
  return repositoryStatements(db)
    .prepare(
      "UPDATE publication_export_preparations SET state=?,sequence=?,cursor_json=?,component_count=?,root_digest=?,root_object_key=?,root_bytes=?,failure_code=? WHERE publication_operation_id=?",
    )
    .bind(
      s.state,
      s.sequence,
      s.cursor_json,
      s.component_count,
      s.root_digest,
      s.root_object_key,
      s.root_bytes,
      s.failure_code,
      s.publication_operation_id,
    );
}
export function retainExportReplay(db: CatalogueStore, id: string, key: string, request: string, result: string) {
  return repositoryStatements(db)
    .prepare("INSERT INTO game_publication_actions VALUES (?,?,?,?)")
    .bind(key, id, request, result);
}
export function priorExportComponent(
  db: CatalogueStore,
  revision: string,
  game: string,
  kind: string,
  entity: string,
  digest: string,
) {
  return repositoryStatements(db)
    .prepare(`SELECT e.* FROM catalogue_composition_games m JOIN publication_export_components e ON e.candidate_id=m.candidate_id
 WHERE m.catalogue_revision_id=? AND m.supported_game=? AND e.kind=? AND e.entity_id=? AND e.input_digest=?`)
    .bind(revision, game, kind, entity, digest);
}
export function retainExportComponent(
  db: CatalogueStore,
  candidate: string,
  ordinal: number,
  kind: string,
  id: string,
  input: string,
  ref: { object_key: string; sha256: string; byte_length: number },
  descriptor: string,
) {
  return repositoryStatements(db)
    .prepare("INSERT INTO publication_export_components VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(candidate, ordinal, kind, id, input, ref.object_key, ref.sha256, ref.byte_length, descriptor);
}
export function exportComponents(db: CatalogueStore, candidate: string, after: number) {
  return repositoryStatements(db)
    .prepare(
      "SELECT ordinal,object_key,sha256,byte_length,descriptor_json FROM publication_export_components WHERE candidate_id=? AND ordinal>? ORDER BY ordinal LIMIT 16",
    )
    .bind(candidate, after);
}
export function exportNodes(db: CatalogueStore, id: string, level: number, after: number) {
  return repositoryStatements(db)
    .prepare(
      "SELECT ordinal,object_key,sha256,byte_length FROM publication_export_nodes WHERE publication_operation_id=? AND level=? AND ordinal>? ORDER BY ordinal LIMIT 32",
    )
    .bind(id, level, after);
}
export function retainExportNode(
  db: CatalogueStore,
  id: string,
  level: number,
  ordinal: number,
  ref: { object_key: string; sha256: string; byte_length: number },
) {
  return repositoryStatements(db)
    .prepare("INSERT INTO publication_export_nodes VALUES (?,?,?,?,?,?)")
    .bind(id, level, ordinal, ref.object_key, ref.sha256, ref.byte_length);
}
