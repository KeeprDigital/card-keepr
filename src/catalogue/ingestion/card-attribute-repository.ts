import { type CatalogueStore, repositoryStatements } from "../shared";
/** Extract scalar Game Profile leaves once, preserving array membership without positions. */
export function cardAttributeProjectionStatement(database: CatalogueStore, revisionId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`
    INSERT INTO revision_card_attributes (catalogue_revision_id, card_id, profile, attribute, value)
    WITH RECURSIVE attributes(catalogue_revision_id, card_id, profile, attribute, value, kind) AS (
      SELECT card.catalogue_revision_id, card.card_id,
             coalesce(json_extract(card.document_json, '$.data.game_data.profile'), json_extract(card.document_json, '$.game_data.profile')),
             field.key, field.value, field.type
      FROM revision_cards AS card,
           json_each(coalesce(json_extract(card.document_json, '$.data.game_data.attributes'), json_extract(card.document_json, '$.game_data.attributes'))) AS field
      WHERE card.catalogue_revision_id = ?
      UNION ALL
      SELECT parent.catalogue_revision_id, parent.card_id, parent.profile,
             parent.attribute || CASE WHEN parent.kind = 'array' THEN '' ELSE '.' || child.key END,
             child.value, child.type
      FROM attributes AS parent,
           json_each(CASE WHEN parent.kind IN ('array', 'object') THEN parent.value ELSE '[]' END) AS child
    )
    SELECT DISTINCT catalogue_revision_id, card_id, profile, attribute,
           CASE kind WHEN 'text' THEN json_quote(value) WHEN 'null' THEN 'null'
             WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE CAST(value AS TEXT) END
    FROM attributes WHERE kind NOT IN ('array', 'object')
  `)
    .bind(revisionId);
}
