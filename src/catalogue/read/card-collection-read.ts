import { absoluteDocumentLinks, type PublicBase, publicUrl } from "../../http/public-base";
import { canonicalJson, gameProfileForGame, gameProfileFilterValue } from "../shared";
import { cardSearchFtsQuery, cardSearchQuery } from "./card-search";
import {
  canonicalEtag,
  collectionFilter,
  collectionFilterValue,
  collectionLimit,
  collectionParameters,
  collectionSelf,
  conditionalResponse,
  decodeCursor,
  encodeCursor,
  invalidParameter,
  pinRevision,
  ReadProblem,
  revisionHeaders,
} from "./collection-endpoint";

type CardRow = {
  summary_json: string;
  sort_game: string;
  sort_identity_kind: string;
  sort_identity_value: string;
  sort_id: string;
};

const maximumCollectionResponseBytes = 4 * 1024 * 1024;
const collectionEnvelopeAllowanceBytes = 32 * 1024;
const encoder = new TextEncoder();

type CardCursor = {
  contract: "card-keepr-card-cursor@1";
  route: "/v1/cards";
  order: typeof cardCollectionOrder;
  revision_id: string;
  filters: CollectionFilters;
  after: {
    game: string;
    identity_kind: string;
    identity_value: string;
    id: string;
  };
};

const cardCollectionOrder = "game,official_identity.kind,official_identity.value,id" as const;

type CollectionFilters = {
  q: string | null;
  game: string | null;
  cardNumber: string | null;
  productId: string | null;
  rarity: string | null;
  attributes: Record<string, string>;
  limit: number;
};

export async function cardCollectionResponse(
  database: D1Database,
  request: Request,
  base: PublicBase,
): Promise<Response> {
  const url = new URL(request.url);
  const filters = parseFilters(url);
  const cursor = parseCursor(url.searchParams.get("after"), filters);
  if (cursor === "invalid") throw invalidCursor();
  const revision = await pinRevision(database, cursor?.revision_id ?? null, "/v1/cards", base, { search: true });
  await validatePublishedFilters(database, revision.id, filters);
  const etag = await canonicalEtag({
    route: "/v1/cards",
    revision: revision.id,
    filters,
    after: cursor?.after ?? null,
  });
  const headers = revisionHeaders(revision.id, etag);
  const conditional = conditionalResponse(request, headers);
  if (conditional !== null) return conditional;

  const queried = await queryCardPage(database, revision.id, filters, cursor?.after ?? null);
  const serializedRows = queried.rows.map((row) =>
    JSON.stringify(absoluteDocumentLinks(JSON.parse(row.summary_json), base)),
  );
  let count = serializedRows.length;
  let dataBytes =
    serializedRows.reduce((total, row) => total + encoder.encode(row).byteLength, 0) + Math.max(0, count - 1);
  while (true) {
    const nextCursor =
      (queried.hasMore || count < queried.rows.length) && count > 0
        ? encodeCursor({
            contract: "card-keepr-card-cursor@1",
            route: "/v1/cards",
            order: cardCollectionOrder,
            revision_id: revision.id,
            filters,
            after: rowCursor(queried.rows[count - 1]!),
          })
        : null;
    // Only the small envelope changes while trimming. Each Card is parsed,
    // link-expanded, and serialized once, even when link expansion exceeds
    // the allowance used by the database byte window.
    const envelope = JSON.stringify({
      meta: {
        catalogue_revision_id: revision.id,
        published_at: revision.published_at,
      },
      page: { limit: filters.limit, next_cursor: nextCursor },
      links: {
        self: publicUrl(
          base,
          collectionSelf("/v1/cards", {
            q: filters.q,
            game: filters.game,
            card_number: filters.cardNumber,
            product_id: filters.productId,
            rarity: filters.rarity,
            ...Object.fromEntries(
              Object.entries(filters.attributes).map(([name, value]) => [
                `attribute.${name}`,
                attributeQueryValue(value),
              ]),
            ),
            limit: filters.limit,
            after: cursor === null ? null : encodeCursor(cursor),
          }),
        ),
      },
    });
    const suffix = `],${envelope.slice(1)}`;
    if (dataBytes + encoder.encode(`{"data":[${suffix}`).byteLength <= maximumCollectionResponseBytes) {
      return new Response(`{"data":[${serializedRows.slice(0, count).join(",")}${suffix}`, {
        headers: {
          ...headers,
          "content-type": "application/json",
        },
      });
    }
    if (count <= 1) {
      throw new ReadProblem(503, "catalogue_query_unavailable", "The Card page exceeds its response budget.");
    }
    count -= 1;
    dataBytes -= encoder.encode(serializedRows[count]!).byteLength + 1;
  }
}

async function queryCardPage(
  database: D1Database,
  revisionId: string,
  filters: CollectionFilters,
  after: CardCursor["after"] | null,
): Promise<{ rows: CardRow[]; hasMore: boolean }> {
  // First select only keys and byte lengths. The window bounds the documents
  // crossing D1's binding without fetching every candidate into Worker memory.
  const query = cardCollectionPageQuery(revisionId, filters, after, filters.limit + 1, true);
  const result = await database
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
    .bind(
      ...query.bindings,
      revisionId,
      filters.limit,
      maximumCollectionResponseBytes - collectionEnvelopeAllowanceBytes,
    )
    .all<Omit<CardRow, "summary_json"> & { summary_json: string | null }>();
  const rows: CardRow[] = [];
  for (const row of result.results) {
    if (row.summary_json === null) return { rows, hasMore: true };
    rows.push({ ...row, summary_json: row.summary_json });
  }
  return { rows, hasMore: false };
}

export function cardCollectionPageQuery(
  revisionId: string,
  filters: CollectionFilters,
  after: CardCursor["after"] | null,
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
  after: CardCursor["after"] | null,
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

function parseFilters(url: URL): CollectionFilters {
  collectionParameters(url, [
    "q",
    "game",
    "card_number",
    "product_id",
    "rarity",
    "limit",
    "after",
    ...[...url.searchParams.keys()].filter((name) => name.startsWith("attribute.")),
  ]);
  const limit = collectionLimit(url.searchParams.get("limit"));
  const rawQuery = collectionFilter(url, "q");
  const q = collectionFilterValue(cardSearchQuery(rawQuery)?.text ?? null, "q");
  if (rawQuery !== null && q === null) throw invalidParameter("q", "q must contain at least one character.");
  const rawGame = collectionFilter(url, "game");
  const game = normalizedFilter(rawGame);
  if (rawGame !== null && game === null) throw invalidParameter("game", "game must contain at least one character.");
  if (game !== null && !["one-piece", "fusion-world", "digimon", "gundam"].includes(game))
    throw invalidParameter("game", "game is not a Supported Game.");
  const rawCardNumber = collectionFilter(url, "card_number");
  const cardNumber = collectionFilterValue(normalizedFilter(rawCardNumber), "card_number");
  if (rawCardNumber !== null && cardNumber === null)
    throw invalidParameter("card_number", "card_number must contain at least one character.");
  const productId = collectionFilter(url, "product_id");
  const rarity = collectionFilter(url, "rarity")?.normalize("NFC").trim().toLowerCase() ?? null;
  if (rarity !== null && !/^[a-z0-9_-]{1,100}$/u.test(rarity))
    throw invalidParameter("rarity", "rarity must be a normalized rarity value.");
  const attributes: Record<string, string> = {};
  for (const name of [...url.searchParams.keys()].filter((name) => name.startsWith("attribute.")).sort()) {
    if (game === null) throw invalidParameter(name, "Game Profile attribute filters require game.");
    const path = name.slice("attribute.".length);
    const raw = collectionFilter(url, name)!;
    const profile = gameProfileForGame(game)!;
    const value = gameProfileFilterValue(profile, path, raw);
    if (value === null) throw invalidParameter(name, `${name} or its value is not defined by ${profile}.`);
    attributes[path] = value;
  }
  return { q, game, cardNumber, productId, rarity, attributes, limit };
}

function rowCursor(row: CardRow): CardCursor["after"] {
  return {
    game: row.sort_game,
    identity_kind: row.sort_identity_kind,
    identity_value: row.sort_identity_value,
    id: row.sort_id,
  };
}

function normalizedFilter(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.normalize("NFKC").trim();
  return normalized.length === 0 ? null : normalized;
}

function parseCursor(encoded: string | null, filters: CollectionFilters): CardCursor | "invalid" | null {
  if (encoded === null) return null;
  try {
    const value = decodeCursor(encoded) as Partial<CardCursor>;
    const after = value.after;
    if (
      value.contract !== "card-keepr-card-cursor@1" ||
      value.route !== "/v1/cards" ||
      value.order !== cardCollectionOrder ||
      typeof value.revision_id !== "string" ||
      value.revision_id.length === 0 ||
      canonicalJson(value.filters) !== canonicalJson(filters) ||
      after === null ||
      typeof after !== "object" ||
      typeof after.game !== "string" ||
      after.game.length === 0 ||
      typeof after.identity_kind !== "string" ||
      after.identity_kind.length === 0 ||
      typeof after.identity_value !== "string" ||
      after.identity_value.length === 0 ||
      typeof after.id !== "string" ||
      after.id.length === 0
    ) {
      throw new Error("invalid cursor");
    }
    return {
      contract: "card-keepr-card-cursor@1",
      route: "/v1/cards",
      order: cardCollectionOrder,
      revision_id: value.revision_id,
      filters,
      after: {
        game: after.game,
        identity_kind: after.identity_kind,
        identity_value: after.identity_value,
        id: after.id,
      },
    };
  } catch {
    return "invalid";
  }
}

function invalidCursor(): ReadProblem {
  return new ReadProblem(400, "invalid_cursor", "The Card cursor is invalid.");
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

async function validatePublishedFilters(
  database: D1Database,
  revisionId: string,
  filters: CollectionFilters,
): Promise<void> {
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
  if (checks.length === 0) return;
  const results = await database.batch(
    checks.map(({ sql, values }) => database.prepare(sql).bind(revisionId, ...values)),
  );
  for (const [index, check] of checks.entries()) {
    if (results[index]!.results.length === 0)
      throw invalidParameter(check.parameter, `${check.parameter} is not known in the pinned Catalogue Revision.`);
  }
}

function attributeQueryValue(value: string): string {
  const parsed: unknown = JSON.parse(value);
  return typeof parsed === "string" ? parsed : String(parsed);
}
