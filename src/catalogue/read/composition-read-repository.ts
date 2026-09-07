import { type CatalogueStore, repositoryStatements } from "../shared";

export function nativeRevisionStatement(db: CatalogueStore, revision: string | null) {
  return repositoryStatements(db)
    .prepare(`SELECT r.id,r.published_at,r.content_digest FROM catalogue_revisions r
 JOIN catalogue_query_revisions q ON q.catalogue_revision_id=r.id AND q.state='available'
 WHERE r.id=COALESCE(?,(SELECT current_revision_id FROM catalogue_state WHERE singleton=1)) AND r.publication_operation_id IS NOT NULL`)
    .bind(revision);
}
export function composedDocumentStatement(db: CatalogueStore, revision: string, kind: string, id: string) {
  return repositoryStatements(db)
    .prepare(`SELECT m.candidate_id,c.preparation_id,m.game_revision_id,b.content FROM catalogue_composition_games m
 JOIN game_candidates c ON c.id=m.candidate_id JOIN publication_query_documents d ON d.candidate_id=m.candidate_id
 JOIN publication_projection_batches b ON b.candidate_id=d.candidate_id AND b.ordinal=d.batch_ordinal
 WHERE m.catalogue_revision_id=? AND d.kind=? AND d.entity_id=? LIMIT 1`)
    .bind(revision, kind, id);
}
export function composedTextStatement(db: CatalogueStore, preparation: string, digest: string, ordinal: number) {
  return repositoryStatements(db)
    .prepare(`SELECT content FROM reconciliation_text_chunks WHERE preparation_id=? AND sha256=? AND ordinal=?`)
    .bind(preparation, digest, ordinal);
}
export type ComposedFilters = {
  game: string | null;
  q: string | null;
  card_id: string | null;
  card_number: string | null;
  rarity: string | null;
  product_id: string | null;
  release_region: string | null;
  attributes?: Record<string, string>;
};
export function composedCollectionStatement(
  db: CatalogueStore,
  revision: string,
  kind: string,
  after: string,
  limit: number,
  filters: ComposedFilters,
) {
  const sql = repositoryStatements(db);
  const predicates = ["m.catalogue_revision_id=?", "d.kind=?", "d.entity_id>?"];
  const bindings: (string | number)[] = [revision, kind, after];
  const equal = (expression: string, value: string | null) => {
    if (value !== null) {
      predicates.push(`${expression}=?`);
      bindings.push(value);
    }
  };
  equal("m.supported_game", filters.game);
  equal("json_extract(b.content,'$.records[0].value.card_id')", filters.card_id);
  equal("json_extract(b.content,'$.records[0].value.official_identity.value')", filters.card_number);
  equal("lower(json_extract(b.content,'$.records[0].value.rarity'))", filters.rarity?.toLowerCase() ?? null);
  if (filters.q !== null) {
    if (kind === "cards") {
      predicates.push(
        [...filters.q].length >= 3
          ? `d.entity_id IN (SELECT card_id FROM publication_search_fts WHERE publication_search_fts MATCH ('candidate_token : "|' || m.candidate_id || '|" AND search_text : "' || replace(?, '"', '""') || '"') AND candidate_id=m.candidate_id)`
          : `EXISTS (SELECT 1 FROM publication_search_chunks search WHERE search.candidate_id=m.candidate_id AND search.card_id=d.entity_id AND instr(search.search_text,?)>0)`,
      );
      bindings.push(filters.q);
    } else {
      predicates.push(`instr(lower(json_extract(b.content,'$.records[0].value.name')),?)>0`);
      bindings.push(filters.q);
    }
  }
  if (filters.product_id !== null || filters.release_region !== null) {
    predicates.push(`EXISTS (SELECT 1 FROM publication_query_documents rel JOIN publication_projection_batches rb ON rb.candidate_id=rel.candidate_id AND rb.ordinal=rel.batch_ordinal
 WHERE rel.candidate_id=m.candidate_id AND rel.kind='product_relationships'
 AND json_extract(rb.content,'$.records[0].value.kind')='printing-product'
 AND (json_extract(rb.content,'$.records[0].value.from.id')=d.entity_id OR EXISTS(SELECT 1 FROM publication_query_documents printing
 JOIN publication_projection_batches pb ON pb.candidate_id=printing.candidate_id AND pb.ordinal=printing.batch_ordinal
 WHERE printing.candidate_id=m.candidate_id AND printing.kind='printings' AND printing.entity_id=json_extract(rb.content,'$.records[0].value.from.id')
 AND json_extract(pb.content,'$.records[0].value.card_id')=d.entity_id))
 ${filters.product_id !== null ? "AND json_extract(rb.content,'$.records[0].value.to.id')=?" : ""}
 ${
   filters.release_region !== null
     ? `AND EXISTS(SELECT 1 FROM publication_query_documents release JOIN publication_projection_batches release_body ON release_body.candidate_id=release.candidate_id AND release_body.ordinal=release.batch_ordinal
 WHERE release.candidate_id=m.candidate_id AND release.kind='releases' AND json_extract(release_body.content,'$.records[0].value.product_id')=json_extract(rb.content,'$.records[0].value.to.id') AND json_extract(release_body.content,'$.records[0].value.region')=?)`
     : ""
})`);
    if (filters.product_id !== null) bindings.push(filters.product_id);
    if (filters.release_region !== null) bindings.push(filters.release_region);
  }
  for (const [name, value] of Object.entries(filters.attributes ?? {})) {
    predicates.push(`json_extract(b.content,?)=?`);
    bindings.push(`$.records[0].value.game_data.attributes.${name}`, value);
  }
  bindings.push(limit);
  return sql
    .prepare(`WITH page AS (
 SELECT d.entity_id,m.candidate_id,c.preparation_id,m.game_revision_id,b.content,
 length(CAST(b.content AS BLOB))+COALESCE((SELECT sum(json_extract(value,'$.byte_length')) FROM json_each(b.content,'$.records[0].text_parts')),0) AS record_bytes
 FROM catalogue_composition_games m JOIN game_candidates c ON c.id=m.candidate_id
 JOIN publication_query_documents d ON d.candidate_id=m.candidate_id
 JOIN publication_projection_batches b ON b.candidate_id=d.candidate_id AND b.ordinal=d.batch_ordinal
 WHERE ${predicates.join(" AND ")} ORDER BY d.entity_id LIMIT ?),
 bounded AS (SELECT *,sum(record_bytes) OVER (ORDER BY entity_id) AS response_bytes FROM page)
 SELECT entity_id,candidate_id,preparation_id,game_revision_id,CASE WHEN response_bytes<=4000000 THEN content ELSE NULL END AS content
 FROM bounded WHERE response_bytes-record_bytes<4000000 ORDER BY entity_id`)
    .bind(...bindings);
}
export function composedRelationsStatement(
  db: CatalogueStore,
  revision: string,
  kind: string,
  field: string,
  id: string,
  after: string,
) {
  // Field choices come only from this module's callers, never request text.
  return repositoryStatements(db)
    .prepare(`SELECT d.entity_id,m.candidate_id,c.preparation_id,m.game_revision_id,b.content FROM catalogue_composition_games m
 JOIN game_candidates c ON c.id=m.candidate_id JOIN publication_query_documents d ON d.candidate_id=m.candidate_id
 JOIN publication_projection_batches b ON b.candidate_id=d.candidate_id AND b.ordinal=d.batch_ordinal
 WHERE m.catalogue_revision_id=? AND d.kind=? AND json_extract(b.content,?)=? AND d.entity_id>? ORDER BY d.entity_id LIMIT 32`)
    .bind(revision, kind, `$.records[0].value.${field}`, id, after);
}
export function composedExportArtifactsStatement(
  db: CatalogueStore,
  revision: string,
  afterGame: string,
  afterOrdinal: number,
) {
  return repositoryStatements(db)
    .prepare(`SELECT m.supported_game,a.ordinal,a.kind,a.object_key,a.sha256,a.byte_length FROM catalogue_composition_games m
 JOIN publication_preparation_artifacts a ON a.candidate_id=m.candidate_id
 WHERE m.catalogue_revision_id=? AND (m.supported_game>? OR (m.supported_game=? AND a.ordinal>?))
 AND a.kind NOT IN ('query_search','search','composition','root') AND (a.kind<>'printing_images' OR a.object_key LIKE 'publication-artifacts/%')
 ORDER BY m.supported_game,a.ordinal LIMIT 32`)
    .bind(revision, afterGame, afterGame, afterOrdinal);
}
export function composedExportArtifactStatement(db: CatalogueStore, revision: string, game: string, ordinal: number) {
  return repositoryStatements(db)
    .prepare(`SELECT a.* FROM catalogue_composition_games m JOIN publication_preparation_artifacts a ON a.candidate_id=m.candidate_id
 WHERE m.catalogue_revision_id=? AND m.supported_game=? AND a.ordinal=? AND a.kind NOT IN ('query_search','search','composition','root') AND (a.kind<>'printing_images' OR a.object_key LIKE 'publication-artifacts/%')`)
    .bind(revision, game, ordinal);
}
