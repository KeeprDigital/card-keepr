import { type CatalogueStore, repositoryStatements } from "../shared";
import type { PreparationState } from "./publication-preparation-types";

export function publicationPreparationStatement(db: CatalogueStore, id: string) {
  return repositoryStatements(db).prepare(`SELECT * FROM publication_preparations WHERE candidate_id = ?`).bind(id);
}
export function publicationPreparationActionStatement(db: CatalogueStore, key: string) {
  return repositoryStatements(db)
    .prepare(`SELECT request_json, result_json FROM publication_preparation_actions WHERE idempotency_key = ?`)
    .bind(key);
}
export function publicationPreparationGuard(
  db: CatalogueStore,
  id: string,
  manifest: string,
  generation: number,
  at: string,
  sequence?: number,
) {
  return repositoryStatements(db)
    .prepare(`SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM game_candidates c JOIN reconciliation_operations o ON o.id = c.preparation_id
      JOIN game_candidate_slots s ON s.preparation_id = o.id AND s.supported_game = c.supported_game
      WHERE c.id = ?1 AND o.supported_game IS NOT NULL AND c.state = 'sealed' AND o.state = 'sealed'
      AND c.generation = ?3 AND o.generation = ?3 AND c.manifest_digest = ?2)
      THEN json_extract('{}','publication_ownership_conflict')
    WHEN EXISTS (SELECT 1 FROM game_candidates WHERE id = ?1 AND deadline <= ?4)
      THEN json_extract('{}','publication_deadline_expired')
    WHEN NOT EXISTS (SELECT 1 FROM game_candidates c JOIN game_catalogue_heads h
      ON h.supported_game = c.supported_game AND h.revision_id = c.expected_game_revision_id WHERE c.id = ?1)
      THEN json_extract('{}','game_revision_mismatch')
    WHEN EXISTS (SELECT 1 FROM operation_state WHERE singleton = 1 AND recovery_health <> 'healthy')
      THEN json_extract('{}','recovery_not_verified')
    WHEN ?5 IS NOT NULL AND COALESCE((SELECT sequence FROM publication_preparations WHERE candidate_id = ?1),0) <> ?5
      THEN json_extract('{}','publication_sequence_conflict') ELSE 1 END`)
    .bind(id, manifest, generation, at, sequence ?? null);
}
export function createPublicationPreparation(db: CatalogueStore, state: PreparationState) {
  return repositoryStatements(db)
    .prepare(`INSERT INTO publication_preparations
    (candidate_id,manifest_digest,generation,sequence,state,phase,cursor_json,created_at)
    VALUES (?,?,?,0,'preparing','images',?,?)`)
    .bind(state.candidate_id, state.manifest_digest, state.generation, state.cursor_json, state.created_at);
}
export function updatePublicationPreparation(db: CatalogueStore, s: PreparationState) {
  return repositoryStatements(db)
    .prepare(
      `UPDATE publication_preparations SET sequence=?,state=?,phase=?,cursor_json=?,failures=?,failure_code=?,artifact_count=?,root_digest=? WHERE candidate_id=?`,
    )
    .bind(
      s.sequence,
      s.state,
      s.phase,
      s.cursor_json,
      s.failures,
      s.failure_code,
      s.artifact_count,
      s.root_digest,
      s.candidate_id,
    );
}
export function retainPublicationAction(db: CatalogueStore, id: string, key: string, request: string, result: string) {
  return repositoryStatements(db)
    .prepare(`INSERT INTO publication_preparation_actions VALUES (?,?,?,?)`)
    .bind(key, id, request, result);
}
export function retainPublicationArtifact(
  db: CatalogueStore,
  id: string,
  ordinal: number,
  kind: string,
  key: string,
  sha: string,
  bytes: number,
  reused: boolean,
) {
  return repositoryStatements(db)
    .prepare(`INSERT INTO publication_preparation_artifacts VALUES (?,?,?,?,?,?,?)`)
    .bind(id, ordinal, kind, key, sha, bytes, reused ? 1 : 0);
}
export function publicationArtifacts(db: CatalogueStore, id: string, after: number, limit = 32) {
  return repositoryStatements(db)
    .prepare(
      `SELECT ordinal,kind,object_key,sha256,byte_length,reused FROM publication_preparation_artifacts WHERE candidate_id=? AND ordinal>? ORDER BY ordinal LIMIT ?`,
    )
    .bind(id, after, limit);
}
export function retainPublicationProjection(
  db: CatalogueStore,
  id: string,
  ordinal: number,
  kind: string,
  content: string,
  sha: string,
) {
  return repositoryStatements(db)
    .prepare(`INSERT INTO publication_projection_batches VALUES (?,?,?,?,?)`)
    .bind(id, ordinal, kind, content, sha);
}
export function retainPublicationNode(
  db: CatalogueStore,
  id: string,
  level: number,
  ordinal: number,
  key: string,
  sha: string,
  bytes: number,
) {
  return repositoryStatements(db)
    .prepare(`INSERT INTO publication_composition_nodes VALUES (?,?,?,?,?,?)`)
    .bind(id, level, ordinal, key, sha, bytes);
}
export function publicationNodes(db: CatalogueStore, id: string, level: number, after: number) {
  return repositoryStatements(db)
    .prepare(
      `SELECT ordinal,object_key,sha256,byte_length FROM publication_composition_nodes WHERE candidate_id=? AND level=? AND ordinal>? ORDER BY ordinal LIMIT 32`,
    )
    .bind(id, level, after);
}

export function publicationManifestPrefix(db: CatalogueStore, id: string) {
  return repositoryStatements(db)
    .prepare(`SELECT preparation_manifest_digest FROM game_candidates WHERE id=?`)
    .bind(id);
}

export function reservePublicationWorkflowAttempt(db: CatalogueStore, id: string, first: number) {
  return repositoryStatements(db)
    .prepare(`INSERT INTO publication_workflow_budgets VALUES (?,?,1)
    ON CONFLICT(candidate_id,first_sequence) DO UPDATE SET attempts=attempts+1 WHERE attempts<40 RETURNING attempts`)
    .bind(id, first);
}
export function retainVerifiedPublicationComposition(db: CatalogueStore, sha: string, content: string) {
  return repositoryStatements(db)
    .prepare(`INSERT INTO verified_publication_compositions VALUES (?,?) ON CONFLICT(sha256) DO NOTHING`)
    .bind(sha, content);
}

export function retainPublicationQueryDocument(
  db: CatalogueStore,
  id: string,
  kind: string,
  entityId: string,
  content: string,
) {
  return repositoryStatements(db)
    .prepare(`INSERT INTO publication_query_documents VALUES (?,?,?,?)`)
    .bind(id, kind, entityId, content);
}
export function retainPublicationSearchChunk(
  db: CatalogueStore,
  id: string,
  cardId: string,
  field: number,
  ordinal: number,
  text: string,
) {
  return repositoryStatements(db)
    .prepare(`INSERT INTO publication_search_chunks VALUES (?,?,?,?,?)`)
    .bind(id, cardId, field, ordinal, text);
}
export function publicationQueryDocuments(
  db: CatalogueStore,
  id: string,
  kind: string,
  after: string,
  search: string | null,
) {
  const fts = search && [...search].length >= 3;
  const predicate =
    search === null
      ? "1"
      : fts
        ? `document.entity_id IN (SELECT card_id FROM publication_search_fts WHERE publication_search_fts MATCH ?4 AND candidate_id=?1)`
        : `EXISTS (SELECT 1 FROM publication_search_chunks chunk WHERE chunk.candidate_id=?1 AND chunk.card_id=document.entity_id AND instr(chunk.search_text,?4)>0)`;
  const query = fts ? `candidate_token : "|${id}|" AND search_text : "${search!.replaceAll('"', '""')}"` : search;
  return repositoryStatements(db)
    .prepare(`SELECT entity_id,content FROM (SELECT document.entity_id,document.content,
    SUM(length(CAST(document.content AS BLOB))) OVER (ORDER BY document.entity_id) AS bytes
    FROM (SELECT document.entity_id,document.content FROM publication_query_documents document
      WHERE document.candidate_id=?1 AND document.kind=?2 AND document.entity_id>?3 AND ${predicate}
      ORDER BY document.entity_id LIMIT 32) document) WHERE bytes<=524288`)
    .bind(...(search === null ? [id, kind, after] : [id, kind, after, query]));
}

export function publicationTerminalGuard(
  db: CatalogueStore,
  id: string,
  manifest: string,
  generation: number,
  sequence: number,
) {
  return repositoryStatements(db)
    .prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM publication_preparations
    WHERE candidate_id=? AND manifest_digest=? AND generation=? AND sequence=? AND state='preparing')
    AND NOT EXISTS (SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_health<>'healthy')
    THEN 1 ELSE json_extract('{}','publication_sequence_conflict') END`)
    .bind(id, manifest, generation, sequence);
}
