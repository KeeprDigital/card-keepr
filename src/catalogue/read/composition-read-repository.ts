import { type CatalogueStore, repositoryStatements } from "../shared";

export function nativeRevisionStatement(
  db: CatalogueStore,
  revision: string | null,
  queryable = true,
  nativeOnly = true,
) {
  return repositoryStatements(db)
    .prepare(`SELECT r.id,r.published_at,r.content_digest,r.publication_operation_id,(SELECT state FROM card_search_fts_state WHERE singleton=1) AS search_state,(SELECT state FROM catalogue_query_revisions WHERE catalogue_revision_id=r.id) AS query_state FROM catalogue_revisions r
 ${queryable ? "JOIN catalogue_query_revisions q ON q.catalogue_revision_id=r.id AND q.state='available'" : ""}
 WHERE r.id=COALESCE(?,(SELECT current_revision_id FROM catalogue_state WHERE singleton=1)) ${nativeOnly ? "AND r.publication_operation_id IS NOT NULL" : ""}`)
    .bind(revision);
}
export function composedDocumentStatement(db: CatalogueStore, revision: string, kind: string, id: string) {
  return repositoryStatements(db)
    .prepare(`SELECT e.candidate_id,e.preparation_id,m.game_revision_id,b.content FROM catalogue_composition_games m
 JOIN publication_read_entities e ON e.candidate_id=m.candidate_id
 JOIN publication_projection_batches b ON b.candidate_id=e.candidate_id AND b.ordinal=e.batch_ordinal
 WHERE m.catalogue_revision_id=? AND e.kind=? AND e.entity_id=? LIMIT 1`)
    .bind(revision, kind, id);
}
export function composedTextStatement(db: CatalogueStore, candidate: string, digest: string, ordinal: number) {
  return repositoryStatements(db)
    .prepare(`SELECT content FROM publication_read_text_chunks WHERE candidate_id=? AND sha256=? AND ordinal=?`)
    .bind(candidate, digest, ordinal);
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
  const conditions = ["m.catalogue_revision_id=?", "e.kind=?"];
  const bindings: (string | number)[] = [revision, kind];
  const equal = (column: string, value: string | null) => {
    if (value !== null) {
      conditions.push(`${column}=?`);
      bindings.push(value);
    }
  };
  equal("e.supported_game", filters.game);
  equal("e.card_id", filters.card_id);
  equal("e.identity_value", filters.card_number);
  if (after) {
    conditions.push(
      `(e.sort1,e.sort2,e.sort3,e.sort4,e.sort5,e.entity_id)>(json_extract(?,'$[0]'),json_extract(?,'$[1]'),json_extract(?,'$[2]'),json_extract(?,'$[3]'),json_extract(?,'$[4]'),json_extract(?,'$[5]'))`,
    );
    bindings.push(after, after, after, after, after, after);
  }
  if (filters.rarity !== null) {
    if (kind === "cards") {
      conditions.push(
        `EXISTS(SELECT 1 FROM publication_read_entities p WHERE p.candidate_id=e.candidate_id AND p.kind='printings' AND p.rarity=? AND p.card_id=e.entity_id)`,
      );
      bindings.push(filters.rarity.toLowerCase());
    } else equal("e.rarity", filters.rarity.toLowerCase());
  }
  if (filters.q !== null) {
    if (kind === "cards")
      conditions.push(
        [...filters.q].length >= 3
          ? `e.entity_id IN(SELECT card_id FROM publication_search_fts WHERE publication_search_fts MATCH ('candidate_token : "|' || e.candidate_id || '|" AND search_text : "' || replace(?, '"', '""') || '"') AND candidate_id=e.candidate_id)`
          : `EXISTS(SELECT 1 FROM publication_search_chunks search WHERE search.candidate_id=e.candidate_id AND search.card_id=e.entity_id AND instr(search.search_text,?)>0)`,
      );
    else conditions.push(`instr(lower(coalesce(e.official_code,'') || ' ' || coalesce(e.name,'')),?)>0`);
    bindings.push(filters.q);
  }
  if (filters.product_id !== null || filters.release_region !== null) {
    if (kind === "products") {
      conditions.push(
        `EXISTS(SELECT 1 FROM publication_read_release_regions r WHERE r.candidate_id=e.candidate_id AND r.product_id=e.entity_id AND r.region=?)`,
      );
      bindings.push(filters.release_region ?? "");
    } else {
      conditions.push(`EXISTS(SELECT 1 FROM publication_read_entities rel
 ${kind === "cards" ? `JOIN publication_read_entities printing ON printing.candidate_id=rel.candidate_id AND printing.kind='printings' AND printing.entity_id=rel.from_id` : ""}
 WHERE rel.candidate_id=e.candidate_id AND rel.kind='product_relationships' AND rel.relationship_kind='printing-product'
 AND ${kind === "cards" ? "printing.card_id=e.entity_id" : "rel.from_id=e.entity_id"}
 ${filters.product_id !== null ? "AND rel.to_id=?" : ""}
 ${filters.release_region !== null ? `AND EXISTS(SELECT 1 FROM publication_read_release_regions region WHERE region.candidate_id=e.candidate_id AND region.product_id=rel.to_id AND region.region=?)` : ""})`);
      if (filters.product_id !== null) bindings.push(filters.product_id);
      if (filters.release_region !== null) bindings.push(filters.release_region);
    }
  }
  for (const [attribute, value] of Object.entries(filters.attributes ?? {})) {
    conditions.push(
      `EXISTS(SELECT 1 FROM publication_read_attributes a WHERE a.candidate_id=e.candidate_id AND a.attribute=? AND a.value=? AND a.card_id=e.entity_id)`,
    );
    bindings.push(attribute, value);
  }
  bindings.push(limit);
  return repositoryStatements(db)
    .prepare(`WITH page AS MATERIALIZED (
 SELECT e.* FROM catalogue_composition_games m JOIN publication_read_entities e ON e.candidate_id=m.candidate_id
 WHERE ${conditions.join(" AND ")} ORDER BY e.sort1,e.sort2,e.sort3,e.sort4,e.sort5,e.entity_id LIMIT ?),
 facts AS MATERIALIZED (SELECT e.*,CASE WHEN e.kind='cards' THEN
 coalesce((SELECT sum(length(CAST(json_quote(entity_id) AS BLOB))+1) FROM publication_read_entities printing WHERE printing.candidate_id=e.candidate_id AND printing.kind='printings' AND printing.card_id=e.entity_id),1)+1 ELSE 2 END AS printing_id_bytes FROM page e),
 sized AS (SELECT *,sum(record_bytes+printing_id_bytes) OVER(ORDER BY sort1,sort2,sort3,sort4,sort5,entity_id) response_bytes FROM facts)
 SELECT e.entity_id,json_array(e.sort1,e.sort2,e.sort3,e.sort4,e.sort5,e.entity_id) AS position,e.candidate_id,e.preparation_id,
 m.game_revision_id,CASE WHEN e.response_bytes<=4000000 AND e.printing_id_bytes<=524288 THEN (SELECT json_group_array(entity_id) FROM (SELECT entity_id FROM publication_read_entities printing WHERE printing.candidate_id=e.candidate_id AND printing.kind='printings' AND printing.card_id=e.entity_id ORDER BY entity_id)) ELSE NULL END AS printing_ids,CASE WHEN e.response_bytes<=4000000 AND e.printing_id_bytes<=524288 THEN b.content ELSE NULL END AS content
 FROM sized e JOIN catalogue_composition_games m ON m.candidate_id=e.candidate_id AND m.catalogue_revision_id=?
 JOIN publication_projection_batches b ON b.candidate_id=e.candidate_id AND b.ordinal=e.batch_ordinal
 WHERE e.response_bytes-e.record_bytes-e.printing_id_bytes<4000000 ORDER BY e.sort1,e.sort2,e.sort3,e.sort4,e.sort5,e.entity_id`)
    .bind(...bindings, revision);
}
export function composedRelationsStatement(
  db: CatalogueStore,
  revision: string,
  kind: string,
  field: string,
  id: string,
  after: string,
) {
  const column = field === "from.id" ? "from_id" : field === "printing_id" ? "card_id" : field;
  if (!["from_id", "card_id", "product_id"].includes(column))
    throw new TypeError("Unknown published relationship field.");
  return repositoryStatements(db)
    .prepare(`SELECT e.entity_id,e.candidate_id,e.preparation_id,m.game_revision_id,b.content FROM catalogue_composition_games m
 JOIN publication_read_entities e ON e.candidate_id=m.candidate_id JOIN publication_projection_batches b ON b.candidate_id=e.candidate_id AND b.ordinal=e.batch_ordinal
 WHERE m.catalogue_revision_id=? AND e.kind=? AND e.${column}=? AND e.entity_id>? ORDER BY e.entity_id LIMIT 32`)
    .bind(revision, kind, id, after);
}
export function composedFilterValueStatement(
  db: CatalogueStore,
  revision: string,
  field: string,
  value: string,
  game: string | null,
) {
  const query =
    field === "product_id"
      ? `SELECT 1 FROM publication_read_entities e WHERE e.candidate_id=m.candidate_id AND e.kind='products' AND e.entity_id=?`
      : field === "rarity"
        ? `SELECT 1 FROM publication_read_entities e WHERE e.candidate_id=m.candidate_id AND e.kind='printings' AND e.rarity=?`
        : `SELECT 1 FROM publication_read_attributes a WHERE a.candidate_id=m.candidate_id AND m.supported_game=? AND a.attribute=? AND a.value=?`;
  return repositoryStatements(db)
    .prepare(
      `SELECT 1 AS present FROM catalogue_composition_games m WHERE m.catalogue_revision_id=? AND EXISTS(${query}) LIMIT 1`,
    )
    .bind(...(field.startsWith("attribute.") ? [revision, game, field.slice(10), value] : [revision, value]));
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
