import { cardCollectionPageQuery, printingCollectionQuery } from "../../../../src/catalogue/read";

// These helpers execute only the production collection builders under test.
// Keeping their plans and rows together prevents testing a different SQL shape.
export function inspectCardCollectionQuery(
  database: D1Database,
  ...arguments_: Parameters<typeof cardCollectionPageQuery>
) {
  const query = cardCollectionPageQuery(...arguments_);
  return {
    ...query,
    plan: () => database.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.bindings),
    rows: () => database.prepare(query.sql).bind(...query.bindings),
  };
}

export function inspectPrintingCollectionQuery(
  database: D1Database,
  ...arguments_: Parameters<typeof printingCollectionQuery>
) {
  const query = printingCollectionQuery(...arguments_);
  return {
    ...query,
    plan: () => database.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.bindings),
    rows: () => database.prepare(query.sql).bind(...query.bindings),
  };
}
