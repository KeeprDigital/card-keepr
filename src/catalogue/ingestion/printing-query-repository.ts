import { type CatalogueStore, repositoryStatements } from "../shared";
// Named prepared statements; callers retain execution and atomic batch composition.

export function publishPrintingQueryFactsStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string; factsJson: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO revision_printing_query (
        catalogue_revision_id, printing_id, card_id, supported_game, normalized_rarity
      ) SELECT ?, json_extract(value, '$.printing_id'), json_extract(value, '$.card_id'),
               json_extract(value, '$.supported_game'), json_extract(value, '$.normalized_rarity')
        FROM json_each(?)`)
    .bind(input.revisionId, input.factsJson);
}

export function publishPrintingProductQueryFactsStatement(
  database: CatalogueStore,
  revisionId: string,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO revision_printing_product_query (
        catalogue_revision_id, printing_id, card_id, product_id, release_region
      )
      SELECT DISTINCT projection.catalogue_revision_id, projection.printing_id,
             projection.card_id, product.product_id, coalesce(region.value, '')
      FROM revision_product_relationships AS relationship
      JOIN revision_printing_query AS projection
        ON projection.catalogue_revision_id = relationship.catalogue_revision_id
       AND projection.printing_id = json_extract(relationship.document_json, '$.from.id')
      JOIN revision_products AS product
        ON product.catalogue_revision_id = relationship.catalogue_revision_id
       AND product.product_id = json_extract(relationship.document_json, '$.to.id')
      LEFT JOIN json_each(product.release_regions_json) AS region
      WHERE relationship.catalogue_revision_id = ?
        AND json_extract(relationship.document_json, '$.kind') = 'printing-product'
        AND coalesce(json_extract(relationship.document_json, '$.lifecycle.current'), 1) = 1`)
    .bind(revisionId);
}
