import { byteBoundedJsonArrays, type SupportedGame } from "../shared";

export type PrintingQueryFact = {
  printing_id: string;
  card_id: string;
  supported_game: SupportedGame;
  normalized_rarity: string | null;
};

/** One publication step owns Printing filters and the Printing-derived facts #52 consumes. */
export function printingQueryProjectionStatements(
  database: D1Database,
  revisionId: string,
  printings: readonly PrintingQueryFact[],
): D1PreparedStatement[] {
  return [
    ...byteBoundedJsonArrays(printings).map((chunk) =>
      database
        .prepare(
          `INSERT INTO revision_printing_query (
        catalogue_revision_id, printing_id, card_id, supported_game, normalized_rarity
      ) SELECT ?, json_extract(value, '$.printing_id'), json_extract(value, '$.card_id'),
               json_extract(value, '$.supported_game'), json_extract(value, '$.normalized_rarity')
        FROM json_each(?)`,
        )
        .bind(revisionId, chunk),
    ),
    // Match the published relationship lifecycle and Product's published regions,
    // including a Product with no regions. No source/reconciliation table is read.
    database
      .prepare(
        `INSERT INTO revision_printing_product_query (
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
        AND coalesce(json_extract(relationship.document_json, '$.lifecycle.current'), 1) = 1`,
      )
      .bind(revisionId),
  ];
}
