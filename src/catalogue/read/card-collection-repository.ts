import { type CatalogueStore, gameProfileForGame, repositoryStatements } from "../shared";
import { cardSearchFtsQuery, cardSearchQuery } from "./card-search";
export type CardPagePosition = { game: string; identity_kind: string; identity_value: string; id: string };
export type CardRow = {
  summary_json: string;
  sort_game: string;
  sort_identity_kind: string;
  sort_identity_value: string;
  sort_id: string;
};

export type CollectionFilters = {
  q: string | null;
  game: string | null;
  cardNumber: string | null;
  productId: string | null;
  rarity: string | null;
  attributes: Record<string, string>;
  limit: number;
};

export function cardCollectionPageQuery(
  revisionId: string,
  filters: CollectionFilters,
  after: CardPagePosition | null,
  rowLimit = filters.limit + 1,
  sizesOnly = false,
): { sql: string; bindings: (string | number)[] } {
  const search = filters.q === null ? null : cardSearchQuery(filters.q);
  if (filters.q !== null && search === null) {
    throw new Error("The validated Card search query is unavailable.");
  }
  const ftsQuery = search === null ? null : cardSearchFtsQuery(search.text, revisionId);
  const ftsSearch = search !== null && ftsQuery !== null;
  const shortSearch = search !== null && ftsQuery === null;
  if (ftsSearch) {
    return ftsCardCollectionPageQuery(revisionId, filters, search.text, ftsQuery, after, rowLimit, sizesOnly);
  }
  const orderTable = shortSearch ? "search" : "cards";
  const conditions = ["cards.catalogue_revision_id = ?"];
  const bindings: (string | number)[] = [revisionId];
  if (filters.game !== null) {
    conditions.push("cards.sort_game = ?");
    bindings.push(filters.game);
  }
  if (filters.cardNumber !== null) {
    conditions.push("cards.sort_identity_kind = 'card_number'", "cards.sort_identity_value = ?");
    bindings.push(filters.cardNumber);
  }
  addCardFilterPredicates(conditions, bindings, "cards", filters);
  if (shortSearch) {
    conditions.push(
      "search.term = ?",
      `EXISTS (
         SELECT 1
         FROM revision_card_search_chunks AS chunk
         WHERE chunk.catalogue_revision_id = cards.catalogue_revision_id
           AND chunk.card_id = cards.card_id
           AND instr(chunk.search_text, ?) > 0
       )`,
    );
    bindings.push(search.anchorTerm, search.text);
  }
  if (after !== null) {
    conditions.push(
      `(${orderTable}.sort_game, ${orderTable}.sort_identity_kind,
        ${orderTable}.sort_identity_value, ${orderTable}.sort_id)
       > (?, ?, ?, ?)`,
    );
    bindings.push(after.game, after.identity_kind, after.identity_value, after.id);
  }
  bindings.push(rowLimit);
  return {
    sql: `SELECT ${sizesOnly ? "length(CAST(cards.summary_json AS BLOB)) AS summary_bytes" : "cards.summary_json"},
              ${orderTable}.sort_game,
              ${orderTable}.sort_identity_kind,
              ${orderTable}.sort_identity_value,
              ${orderTable}.sort_id
       FROM ${
         shortSearch
           ? `revision_card_search_terms AS search
             INDEXED BY revision_card_search_by_term
             JOIN revision_card_query_documents AS cards
               ON cards.catalogue_revision_id =
                    search.catalogue_revision_id
              AND cards.card_id = search.card_id`
           : `revision_card_query_documents AS cards
             INDEXED BY revision_card_query_documents_by_order`
}
       WHERE ${conditions.join("\nAND ")}
       ORDER BY ${orderTable}.sort_game,
                ${orderTable}.sort_identity_kind,
                ${orderTable}.sort_identity_value,
                ${orderTable}.sort_id
       LIMIT ?`,
    bindings,
  };
}

function ftsCardCollectionPageQuery(
  revisionId: string,
  filters: CollectionFilters,
  searchText: string,
  ftsQuery: string,
  after: CardPagePosition | null,
  rowLimit: number,
  sizesOnly: boolean,
): { sql: string; bindings: (string | number)[] } {
  const conditions = [
    "revision_card_search_fts MATCH ?",
    "search.catalogue_revision_id = ?",
    "instr(search.search_text, ?) > 0",
    "filtered.catalogue_revision_id = ?",
  ];
  const bindings: (string | number)[] = [ftsQuery, revisionId, searchText, revisionId];
  if (filters.game !== null) {
    conditions.push("filtered.sort_game = ?");
    bindings.push(filters.game);
  }
  if (filters.cardNumber !== null) {
    conditions.push("filtered.sort_identity_kind = 'card_number'", "filtered.sort_identity_value = ?");
    bindings.push(filters.cardNumber);
  }
  addCardFilterPredicates(conditions, bindings, "filtered", filters);
  if (after !== null) {
    conditions.push(
      `(filtered.sort_game, filtered.sort_identity_kind,
        filtered.sort_identity_value, filtered.sort_id)
       > (?, ?, ?, ?)`,
    );
    bindings.push(after.game, after.identity_kind, after.identity_value, after.id);
  }
  bindings.push(rowLimit);
  return {
    sql: `WITH search_matches AS MATERIALIZED (
         SELECT ${sizesOnly ? "length(CAST(filtered.summary_json AS BLOB)) AS summary_bytes" : "filtered.summary_json"},
                filtered.sort_game,
                filtered.sort_identity_kind,
                filtered.sort_identity_value,
                filtered.sort_id
         FROM revision_card_search_fts AS search
         JOIN revision_card_query_documents AS filtered
           ON filtered.catalogue_revision_id =
                search.catalogue_revision_id
          AND filtered.card_id = search.card_id
         WHERE ${conditions.join("\nAND ")}
         GROUP BY search.catalogue_revision_id, search.card_id
         ORDER BY filtered.sort_game,
                  filtered.sort_identity_kind,
                  filtered.sort_identity_value,
                  filtered.sort_id
         LIMIT ?
       )
       SELECT ${sizesOnly ? "summary_bytes" : "summary_json"}, sort_game, sort_identity_kind,
              sort_identity_value, sort_id
       FROM search_matches
       ORDER BY sort_game, sort_identity_kind, sort_identity_value, sort_id`,
    bindings,
  };
}

function addCardFilterPredicates(
  conditions: string[],
  bindings: (string | number)[],
  alias: string,
  filters: CollectionFilters,
): void {
  if (filters.productId !== null) {
    conditions.push(`EXISTS (SELECT 1 FROM revision_printing_product_query AS product INDEXED BY revision_printing_products_by_product
      WHERE product.catalogue_revision_id = ${alias}.catalogue_revision_id AND product.product_id = ? AND product.card_id = ${alias}.card_id)`);
    bindings.push(filters.productId);
  }
  if (filters.rarity !== null) {
    conditions.push(`EXISTS (SELECT 1 FROM revision_printing_query AS rarity INDEXED BY revision_printing_query_by_rarity
      WHERE rarity.catalogue_revision_id = ${alias}.catalogue_revision_id AND rarity.normalized_rarity = ? AND rarity.card_id = ${alias}.card_id)`);
    bindings.push(filters.rarity);
  }
  for (const [attribute, value] of Object.entries(filters.attributes)) {
    conditions.push(`EXISTS (SELECT 1 FROM revision_card_attributes AS attribute INDEXED BY revision_card_attributes_by_value
      WHERE attribute.catalogue_revision_id = ${alias}.catalogue_revision_id AND attribute.profile = ? AND attribute.attribute = ? AND attribute.value = ? AND attribute.card_id = ${alias}.card_id)`);
    bindings.push(gameProfileForGame(filters.game!)!, attribute, value);
  }
}
export function cardCollectionPageStatement(
  database: CatalogueStore,
  revisionId: string,
  filters: CollectionFilters,
  after: CardPagePosition | null,
  maximumDocumentBytes: number,
): D1PreparedStatement {
  const query = cardCollectionPageQuery(revisionId, filters, after, filters.limit + 1, true);
  return repositoryStatements(database)
    .prepare(`
    WITH candidates AS MATERIALIZED (${query.sql}),
    sized AS (
      SELECT *,
        sum(summary_bytes + 1) OVER page_order + 1 AS cumulative_bytes,
        row_number() OVER page_order AS ordinal
      FROM candidates
      WINDOW page_order AS (
        ORDER BY sort_game, sort_identity_kind, sort_identity_value, sort_id
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      )
    )
    SELECT sized.sort_game, sized.sort_identity_kind,
           sized.sort_identity_value, sized.sort_id, documents.summary_json
    FROM sized
    LEFT JOIN revision_card_query_documents AS documents
      ON documents.catalogue_revision_id = ?
     AND documents.card_id = sized.sort_id
     AND sized.ordinal <= ?
     AND (sized.cumulative_bytes <= ? OR sized.ordinal = 1)
    ORDER BY sized.sort_game, sized.sort_identity_kind,
             sized.sort_identity_value, sized.sort_id
  `)
    .bind(...query.bindings, revisionId, filters.limit, maximumDocumentBytes);
}
export function cardPublishedFilterStatements(
  database: CatalogueStore,
  revisionId: string,
  filters: CollectionFilters,
): { parameter: string; statement: D1PreparedStatement }[] {
  const checks: { parameter: string; sql: string; values: string[] }[] = [];
  if (filters.productId !== null)
    checks.push({
      parameter: "product_id",
      sql: "SELECT 1 FROM revision_products WHERE catalogue_revision_id = ? AND product_id = ? LIMIT 1",
      values: [filters.productId],
    });
  if (filters.rarity !== null)
    checks.push({
      parameter: "rarity",
      sql: "SELECT 1 FROM revision_printing_query WHERE catalogue_revision_id = ? AND normalized_rarity = ? LIMIT 1",
      values: [filters.rarity],
    });
  for (const [attribute, value] of Object.entries(filters.attributes)) {
    checks.push({
      parameter: `attribute.${attribute}`,
      sql: "SELECT 1 FROM revision_card_attributes WHERE catalogue_revision_id = ? AND profile = ? AND attribute = ? AND value = ? LIMIT 1",
      values: [gameProfileForGame(filters.game!)!, attribute, value],
    });
  }

  return checks.map(({ parameter, sql, values }) => ({
    parameter,
    statement: repositoryStatements(database)
      .prepare(sql)
      .bind(revisionId, ...values),
  }));
}
