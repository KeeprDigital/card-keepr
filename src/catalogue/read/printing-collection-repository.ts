export type PrintingCollectionFilters = {
  card_id: string | null;
  game: string | null;
  rarity: string | null;
  product_id: string | null;
  release_region: string | null;
};

/** Select a bounded keyset from indexed publication facts before loading documents. */
export function printingCollectionQuery(
  revisionId: string,
  filters: PrintingCollectionFilters,
  after: { card_id: string; id: string } | null,
  limit: number,
): { sql: string; bindings: (string | number)[] } {
  const bindings: (string | number)[] = [revisionId];
  const membershipDriven = filters.card_id === null && (filters.product_id !== null || filters.release_region !== null);
  const source = membershipDriven ? "membership" : "projection";
  const predicates = [`${source}.catalogue_revision_id = ?`];
  const equal = (column: string, value: string | null) => {
    if (value === null) return;
    predicates.push(`${column} = ?`);
    bindings.push(value);
  };
  equal("projection.card_id", filters.card_id);
  equal("projection.supported_game", filters.game);
  equal("projection.normalized_rarity", filters.rarity);
  if (after !== null) {
    predicates.push(`(${source}.card_id, ${source}.printing_id) > (?, ?)`);
    bindings.push(after.card_id, after.id);
  }
  let from: string;
  if (membershipDriven) {
    const index =
      filters.product_id !== null
        ? filters.release_region !== null
          ? "revision_printing_products_by_product_region"
          : "revision_printing_products_by_product"
        : "revision_printing_products_by_region";
    from = `revision_printing_product_query AS membership INDEXED BY ${index}
      JOIN revision_printing_query AS projection
        ON projection.catalogue_revision_id = membership.catalogue_revision_id
       AND projection.printing_id = membership.printing_id`;
    equal("membership.product_id", filters.product_id);
    equal("membership.release_region", filters.release_region);
  } else {
    const index =
      filters.card_id !== null
        ? "revision_printing_query_by_card"
        : filters.game !== null && filters.rarity !== null
          ? "revision_printing_query_by_game_rarity"
          : filters.rarity !== null
            ? "revision_printing_query_by_rarity"
            : filters.game !== null
              ? "revision_printing_query_by_game"
              : "revision_printing_query_by_card";
    from = `revision_printing_query AS projection INDEXED BY ${index}`;
    if (filters.product_id !== null || filters.release_region !== null) {
      const membershipPredicates = [
        "membership.catalogue_revision_id = projection.catalogue_revision_id",
        "membership.printing_id = projection.printing_id",
      ];
      if (filters.product_id !== null) {
        membershipPredicates.push("membership.product_id = ?");
        bindings.push(filters.product_id);
      }
      if (filters.release_region !== null) {
        membershipPredicates.push("membership.release_region = ?");
        bindings.push(filters.release_region);
      }
      predicates.push(`EXISTS (SELECT 1 FROM revision_printing_product_query AS membership
        WHERE ${membershipPredicates.join(" AND ")})`);
    }
  }
  bindings.push(limit, revisionId);
  return {
    sql: `WITH page AS (
      SELECT ${membershipDriven ? "DISTINCT" : ""} ${source}.card_id, ${source}.printing_id
      FROM ${from}
      WHERE ${predicates.join(" AND ")}
      ORDER BY ${source}.card_id, ${source}.printing_id
      LIMIT ?
    )
    SELECT printing.printing_id, printing.card_id, printing.document_json
    FROM page
    JOIN revision_printings AS printing
      ON printing.catalogue_revision_id = ? AND printing.printing_id = page.printing_id
    ORDER BY page.card_id, page.printing_id`,
    bindings,
  };
}

export function printingCollectionStatement(
  database: D1Database,
  revisionId: string,
  filters: PrintingCollectionFilters,
  after: { card_id: string; id: string } | null,
  limit: number,
): D1PreparedStatement {
  const query = printingCollectionQuery(revisionId, filters, after, limit);
  return database.prepare(query.sql).bind(...query.bindings);
}
