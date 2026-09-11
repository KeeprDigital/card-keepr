import { atomicRepositoryStatement, type CatalogueStore, repositoryStatements } from "../shared";
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
    .prepare(
      `SELECT CASE
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
      THEN json_extract('{}','publication_sequence_conflict') ELSE 1 END`,
    )
    .bind(id, manifest, generation, at, sequence ?? null);
}
export function createPublicationPreparation(db: CatalogueStore, state: PreparationState) {
  return repositoryStatements(db)
    .prepare(
      `INSERT INTO publication_preparations
    (candidate_id,manifest_digest,generation,sequence,state,phase,cursor_json,created_at)
    VALUES (?,?,?,0,'preparing','images',?,?)`,
    )
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
    .prepare(
      `INSERT INTO publication_workflow_budgets VALUES (?,?,1)
    ON CONFLICT(candidate_id,first_sequence) DO UPDATE SET attempts=attempts+1 WHERE attempts<40 RETURNING attempts`,
    )
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
  ordinal: number,
) {
  return repositoryStatements(db)
    .prepare(`INSERT INTO publication_query_documents VALUES (?,?,?,?)`)
    .bind(id, kind, entityId, ordinal);
}
export function retainPublicationSearchChunk(
  db: CatalogueStore,
  id: string,
  cardId: string,
  field: number,
  ordinal: number,
  text: string,
) {
  return atomicRepositoryStatement(db, {
    statement: repositoryStatements(db)
      .prepare(`INSERT INTO publication_search_chunks VALUES (?,?,?,?,?)`)
      .bind(id, cardId, field, ordinal, text),
    after: [
      repositoryStatements(db)
        .prepare(
          `INSERT INTO publication_search_fts(rowid,candidate_token,candidate_id,card_id,search_text)
      SELECT rowid,'|' || candidate_id || '|',candidate_id,card_id,search_text FROM publication_search_chunks
      WHERE candidate_id=? AND card_id=? AND field=? AND ordinal=?`,
        )
        .bind(id, cardId, field, ordinal),
    ],
  });
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
    .prepare(
      `SELECT entity_id,content FROM (SELECT document.entity_id,document.content,
    SUM(length(CAST(document.content AS BLOB))) OVER (ORDER BY document.entity_id) AS bytes
    FROM (SELECT document.entity_id,json_extract(batch.content,'$.records[0]') AS content FROM publication_query_documents document
      JOIN publication_projection_batches batch ON batch.candidate_id=document.candidate_id AND batch.ordinal=document.batch_ordinal
      WHERE document.candidate_id=?1 AND document.kind=?2 AND document.entity_id>?3 AND ${predicate}
      ORDER BY document.entity_id LIMIT 32) document) WHERE bytes<=524288`,
    )
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
    .prepare(
      `SELECT CASE WHEN EXISTS (SELECT 1 FROM publication_preparations
    WHERE candidate_id=? AND manifest_digest=? AND generation=? AND sequence=? AND state='preparing')
    AND NOT EXISTS (SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_health<>'healthy')
    THEN 1 ELSE json_extract('{}','publication_sequence_conflict') END`,
    )
    .bind(id, manifest, generation, sequence);
}

/** Extract typed public facts once; consumer queries never inspect document JSON. */
export function retainPublicReadFacts(
  db: CatalogueStore,
  id: string,
  ordinals: number[],
  preparation: string,
  game: string,
) {
  if (ordinals.length < 1 || ordinals.length > 6) throw new Error("Public facts require one to six projections.");
  const selected = JSON.stringify(ordinals);
  const sql = repositoryStatements(db);
  return [
    sql
      .prepare(
        `INSERT INTO publication_read_entities
 SELECT ?1,b.kind,json_extract(b.content,'$.records[0].value.id'),b.ordinal,?3,?4,
 coalesce(json_extract(b.content,'$.records[0].value.card_id'),json_extract(b.content,'$.records[0].value.printing_id')),json_extract(b.content,'$.records[0].value.official_identity.kind'),
 json_extract(b.content,'$.records[0].value.official_identity.value'),json_extract(b.content,'$.records[0].value.name'),
 json_extract(b.content,'$.records[0].value.official_code'),lower(json_extract(b.content,'$.records[0].value.rarity.normalized')),
 json_extract(b.content,'$.records[0].value.kind'),json_extract(b.content,'$.records[0].value.from.id'),json_extract(b.content,'$.records[0].value.to.id'),json_extract(b.content,'$.records[0].value.product_id'),
 CASE WHEN b.kind='printings' THEN coalesce(json_extract(b.content,'$.records[0].value.card_id'),'') ELSE ?4 END,
 CASE WHEN b.kind='cards' THEN coalesce(json_extract(b.content,'$.records[0].value.official_identity.kind'),'unknown') WHEN b.kind='products' THEN CASE WHEN json_extract(b.content,'$.records[0].value.official_code') IS NULL THEN '1' ELSE '0' END ELSE '' END,
 CASE WHEN b.kind='cards' THEN coalesce(json_extract(b.content,'$.records[0].value.official_identity.value'),'') WHEN b.kind='products' THEN coalesce(json_extract(b.content,'$.records[0].value.official_code'),'') ELSE '' END,
 CASE WHEN b.kind='products' THEN CASE WHEN json_extract(b.content,'$.records[0].value.name') IS NULL THEN '1' ELSE '0' END ELSE '' END,
 CASE WHEN b.kind='products' THEN coalesce(json_extract(b.content,'$.records[0].value.name'),'') ELSE '' END,
 length(CAST(b.content AS BLOB))+coalesce((SELECT sum(json_extract(value,'$.byte_length')) FROM json_each(b.content,'$.records[0].text_parts')),0)
 FROM publication_projection_batches b WHERE b.candidate_id=?1 AND b.ordinal IN (SELECT value FROM json_each(?2))`,
      )
      .bind(id, selected, preparation, game),
    sql
      .prepare(
        `INSERT INTO publication_read_attributes
 WITH RECURSIVE attributes(card_id,profile,attribute,value,kind) AS (
 SELECT json_extract(b.content,'$.records[0].value.id'),json_extract(b.content,'$.records[0].value.game_data.profile'),field.key,field.value,field.type
 FROM publication_projection_batches b,json_each(b.content,'$.records[0].value.game_data.attributes') field WHERE b.candidate_id=?1 AND b.ordinal IN (SELECT value FROM json_each(?2)) AND b.kind='cards'
 UNION ALL SELECT p.card_id,p.profile,p.attribute || CASE WHEN p.kind='array' THEN '' ELSE '.' || child.key END,child.value,child.type
 FROM attributes p,json_each(CASE WHEN p.kind IN ('array','object') THEN p.value ELSE '[]' END) child)
 SELECT DISTINCT ?1,card_id,profile,attribute,CASE kind WHEN 'text' THEN json_quote(value) WHEN 'null' THEN 'null' WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE CAST(value AS TEXT) END FROM attributes WHERE kind NOT IN ('array','object')`,
      )
      .bind(id, selected),
    sql
      .prepare(
        `INSERT INTO publication_read_release_regions SELECT DISTINCT ?1,json_extract(b.content,'$.records[0].value.id'),json_extract(release.value,'$.region')
 FROM publication_projection_batches b,json_each(b.content,'$.records[0].value.releases') release
 WHERE b.candidate_id=?1 AND b.ordinal IN (SELECT value FROM json_each(?2)) AND b.kind='products' AND json_extract(release.value,'$.region') IS NOT NULL`,
      )
      .bind(id, selected),
  ];
}
export function retainPublicReadText(db: CatalogueStore, id: string, sha: string, ordinal: number, content: string) {
  return repositoryStatements(db)
    .prepare(
      `INSERT INTO publication_read_text_chunks VALUES (?,?,?,?) ON CONFLICT(candidate_id,sha256,ordinal) DO NOTHING`,
    )
    .bind(id, sha, ordinal, content);
}
