import { absoluteDocumentLinks, type PublicBase, publicUrl } from "../../http/public-base";
import { canonicalJson } from "../shared";
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
const maximumRowsPerDatabaseRead = 8;
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
  const pageRows = [...queried.rows];
  let truncated = false;
  while (true) {
    const nextCursor =
      (queried.hasMore || truncated) && pageRows.length > 0
        ? encodeCursor({
            contract: "card-keepr-card-cursor@1",
            route: "/v1/cards",
            order: cardCollectionOrder,
            revision_id: revision.id,
            filters,
            after: rowCursor(pageRows.at(-1)!),
          })
        : null;
    const serialized = JSON.stringify({
      data: pageRows.map((row) => absoluteDocumentLinks(JSON.parse(row.summary_json), base)),
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
            limit: filters.limit,
            after: cursor === null ? null : encodeCursor(cursor),
          }),
        ),
      },
    });
    if (encoder.encode(serialized).byteLength <= maximumCollectionResponseBytes) {
      return new Response(serialized, {
        headers: {
          ...headers,
          "content-type": "application/json",
        },
      });
    }
    if (pageRows.length <= 1) {
      throw new ReadProblem(503, "catalogue_query_unavailable", "The Card page exceeds its response budget.");
    }
    pageRows.pop();
    truncated = true;
  }
}

async function queryCardPage(
  database: D1Database,
  revisionId: string,
  filters: CollectionFilters,
  after: CardCursor["after"] | null,
): Promise<{ rows: CardRow[]; hasMore: boolean }> {
  const rows: CardRow[] = [];
  let dataBytes = 2;
  let position = after;
  const singleFtsRead = filters.q !== null && cardSearchFtsQuery(filters.q, revisionId) !== null;
  while (rows.length < filters.limit + 1) {
    const remaining = filters.limit + 1 - rows.length;
    const rowLimit = singleFtsRead ? remaining : Math.min(maximumRowsPerDatabaseRead, remaining);
    const query = cardCollectionPageQuery(revisionId, filters, position, rowLimit);
    const result = await database
      .prepare(query.sql)
      .bind(...query.bindings)
      .all<CardRow>();
    if (result.results.length === 0) {
      return { rows, hasMore: false };
    }
    for (const row of result.results) {
      const rowBytes = encoder.encode(row.summary_json).byteLength + (rows.length === 0 ? 0 : 1);
      if (rows.length > 0 && dataBytes + rowBytes > maximumCollectionResponseBytes - collectionEnvelopeAllowanceBytes) {
        return { rows, hasMore: true };
      }
      rows.push(row);
      dataBytes += rowBytes;
      if (rows.length > filters.limit) {
        return { rows: rows.slice(0, filters.limit), hasMore: true };
      }
      position = rowCursor(row);
    }
    if (result.results.length < rowLimit) {
      return { rows, hasMore: false };
    }
  }
  return { rows: rows.slice(0, filters.limit), hasMore: true };
}

export function cardCollectionPageQuery(
  revisionId: string,
  filters: CollectionFilters,
  after: CardCursor["after"] | null,
  rowLimit = filters.limit + 1,
): { sql: string; bindings: (string | number)[] } {
  const search = filters.q === null ? null : cardSearchQuery(filters.q);
  if (filters.q !== null && search === null) {
    throw new Error("The validated Card search query is unavailable.");
  }
  const ftsQuery = search === null ? null : cardSearchFtsQuery(search.text, revisionId);
  const ftsSearch = search !== null && ftsQuery !== null;
  const shortSearch = search !== null && ftsQuery === null;
  if (ftsSearch) {
    return ftsCardCollectionPageQuery(revisionId, filters, search.text, ftsQuery, after, rowLimit);
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
    sql: `SELECT cards.summary_json,
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
         SELECT filtered.summary_json,
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
       SELECT summary_json, sort_game, sort_identity_kind,
              sort_identity_value, sort_id
       FROM search_matches
       ORDER BY sort_game, sort_identity_kind, sort_identity_value, sort_id`,
    bindings,
  };
}

function parseFilters(url: URL): CollectionFilters {
  collectionParameters(url);
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
  return { q, game, cardNumber, limit };
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
