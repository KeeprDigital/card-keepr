import { ifNoneMatchMatches } from "../http/conditional-request";
import { problemResponse } from "../http/problem";
import { cardSearchFtsQuery, cardSearchQuery } from "./card-search";

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
  q: string | null;
  game: string | null;
  card_number: string | null;
  limit: number;
  after: {
    game: string;
    identity_kind: string;
    identity_value: string;
    id: string;
  };
};

const cardCollectionOrder =
  "game,official_identity.kind,official_identity.value,id" as const;

type CollectionFilters = {
  q: string | null;
  game: string | null;
  cardNumber: string | null;
  limit: number;
};

export async function cardCollectionResponse(
  database: D1Database,
  request: Request,
  requestId: string,
): Promise<Response> {
  const url = new URL(request.url);
  const filters = parseFilters(url, requestId);
  if (filters instanceof Response) return filters;
  const cursor = parseCursor(url.searchParams.get("after"));
  if (cursor === "invalid") return invalidCursor(requestId);
  if (
    cursor !== null &&
    (cursor.route !== url.pathname ||
      cursor.order !== cardCollectionOrder ||
      cursor.q !== filters.q ||
      cursor.game !== filters.game ||
      cursor.card_number !== filters.cardNumber ||
      cursor.limit !== filters.limit)
  ) {
    return invalidCursor(requestId);
  }
  const current = await currentRevision(database);
  const revision = await availableRevision(
    database,
    cursor?.revision_id ?? current.id,
  );
  if (revision === null) {
    return cursor === null
      ? catalogueQueryUnavailable(requestId)
      : cursorUnavailable(requestId);
  }

  const etag = `"cards:${revision.id}:${await digestFilters(url.search)}"`;
  const headers = {
    "cache-control": "private, no-cache",
    etag,
    "x-catalogue-revision": revision.id,
  };
  if (ifNoneMatchMatches(request, etag)) {
    return new Response(null, { status: 304, headers });
  }

  const queried = await queryCardPage(
    database,
    revision.id,
    filters,
    cursor?.after ?? null,
  );
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
            q: filters.q,
            game: filters.game,
            card_number: filters.cardNumber,
            limit: filters.limit,
            after: rowCursor(pageRows.at(-1)!),
          })
        : null;
    const serialized = JSON.stringify({
      data: pageRows.map((row) => JSON.parse(row.summary_json)),
      meta: {
        catalogue_revision_id: revision.id,
        published_at: revision.publishedAt,
      },
      page: { limit: filters.limit, next_cursor: nextCursor },
      links: { self: `/v1/cards${url.search}` },
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
      return catalogueQueryUnavailable(requestId);
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
  while (rows.length < filters.limit + 1) {
    const remaining = filters.limit + 1 - rows.length;
    const rowLimit = Math.min(maximumRowsPerDatabaseRead, remaining);
    const query = cardCollectionPageQuery(
      revisionId,
      filters,
      position,
      rowLimit,
    );
    const result = await database
      .prepare(query.sql)
      .bind(...query.bindings)
      .all<CardRow>();
    if (result.results.length === 0) {
      return { rows, hasMore: false };
    }
    for (const row of result.results) {
      const rowBytes = encoder.encode(row.summary_json).byteLength +
        (rows.length === 0 ? 0 : 1);
      if (
        rows.length > 0 &&
        dataBytes + rowBytes >
          maximumCollectionResponseBytes - collectionEnvelopeAllowanceBytes
      ) {
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
  const ftsQuery = search === null
    ? null
    : cardSearchFtsQuery(search.text, revisionId);
  const ftsSearch = search !== null && ftsQuery !== null;
  const shortSearch = search !== null && ftsQuery === null;
  const orderTable = shortSearch ? "search" : "cards";
  const conditions = ["cards.catalogue_revision_id = ?"];
  const bindings: (string | number)[] = ftsSearch
    ? [ftsQuery, revisionId, search.text, revisionId]
    : [revisionId];
  if (filters.game !== null) {
    conditions.push("cards.sort_game = ?");
    bindings.push(filters.game);
  }
  if (filters.cardNumber !== null) {
    conditions.push(
      "cards.sort_identity_kind = 'card_number'",
      "cards.sort_identity_value = ?",
    );
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
    bindings.push(
      after.game,
      after.identity_kind,
      after.identity_value,
      after.id,
    );
  }
  bindings.push(rowLimit);
  const searchCandidates = ftsSearch
    ? `WITH search_candidates AS MATERIALIZED (
         SELECT DISTINCT catalogue_revision_id, card_id
         FROM revision_card_search_fts
         WHERE revision_card_search_fts MATCH ?
           AND catalogue_revision_id = ?
           AND instr(search_text, ?) > 0
       )
       `
    : "";
  return {
    sql:
      `${searchCandidates}SELECT cards.summary_json,
              ${orderTable}.sort_game,
              ${orderTable}.sort_identity_kind,
              ${orderTable}.sort_identity_value,
              ${orderTable}.sort_id
       FROM ${
        ftsSearch
          ? `search_candidates AS candidate
             JOIN revision_card_query_documents AS cards
               ON cards.catalogue_revision_id =
                    candidate.catalogue_revision_id
              AND cards.card_id = candidate.card_id`
          : shortSearch
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

function parseFilters(
  url: URL,
  requestId: string,
): CollectionFilters | Response {
  const requestedLimit = url.searchParams.get("limit");
  const limit =
    requestedLimit === null ? 50 : Number.parseInt(requestedLimit, 10);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    String(limit) !== (requestedLimit ?? "50")
  ) {
    return invalidParameter(
      requestId,
      "limit",
      "limit must be an integer from 1 to 100.",
    );
  }
  const rawQuery = url.searchParams.get("q");
  if (rawQuery !== null && rawQuery.length === 0) {
    return invalidParameter(
      requestId,
      "q",
      "q must contain at least one character.",
    );
  }
  if (rawQuery !== null && [...rawQuery].length > 500) {
    return invalidParameter(
      requestId,
      "q",
      "q must contain at most 500 characters.",
    );
  }
  const q = cardSearchQuery(rawQuery)?.text ?? null;
  if (rawQuery !== null && q === null) {
    return invalidParameter(
      requestId,
      "q",
      "q must contain at least one character.",
    );
  }
  const rawGame = url.searchParams.get("game");
  const game = normalizedFilter(rawGame);
  if (rawGame !== null && game === null) {
    return invalidParameter(
      requestId,
      "game",
      "game must contain at least one character.",
    );
  }
  if (
    game !== null &&
    game !== "one-piece" &&
    game !== "fusion-world" &&
    game !== "digimon" &&
    game !== "gundam"
  ) {
    return invalidParameter(
      requestId,
      "game",
      "game is not a Supported Game.",
    );
  }
  const rawCardNumber = url.searchParams.get("card_number");
  const cardNumber = normalizedFilter(rawCardNumber);
  if (rawCardNumber !== null && cardNumber === null) {
    return invalidParameter(
      requestId,
      "card_number",
      "card_number must contain at least one character.",
    );
  }
  return {
    q,
    game,
    cardNumber,
    limit,
  };
}

async function currentRevision(database: D1Database) {
  const state = await database
    .prepare(
      `SELECT current_revision_id, published_at
       FROM catalogue_state WHERE singleton = 1`,
    )
    .first<{
      current_revision_id: string;
      published_at: string;
    }>();
  if (state === null) {
    throw new Error("Catalogue state is unavailable.");
  }
  return { id: state.current_revision_id, publishedAt: state.published_at };
}

async function availableRevision(database: D1Database, id: string) {
  const revision = await database
    .prepare(
      `SELECT revision.id, revision.published_at
       FROM catalogue_revisions AS revision
       JOIN catalogue_query_revisions AS query
         ON query.catalogue_revision_id = revision.id
        AND query.state = 'available'
       JOIN card_search_fts_state AS search_index
         ON search_index.singleton = 1
        AND search_index.state = 'ready'
       WHERE revision.id = ?`,
    )
    .bind(id)
    .first<{ id: string; published_at: string }>();
  return revision === null
    ? null
    : { id: revision.id, publishedAt: revision.published_at };
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

function encodeCursor(cursor: CardCursor): string {
  return btoa(
    String.fromCharCode(
      ...new TextEncoder().encode(JSON.stringify(cursor)),
    ),
  );
}

function parseCursor(
  encoded: string | null,
): CardCursor | "invalid" | null {
  if (encoded === null) return null;
  try {
    const bytes = Uint8Array.from(
      atob(encoded),
      (character) => character.charCodeAt(0),
    );
    const value = JSON.parse(
      new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: false,
      }).decode(bytes),
    ) as Partial<CardCursor>;
    const after = value.after;
    if (
      value.contract !== "card-keepr-card-cursor@1" ||
      value.route !== "/v1/cards" ||
      value.order !== cardCollectionOrder ||
      typeof value.revision_id !== "string" ||
      value.revision_id.length === 0 ||
      typeof value.limit !== "number" ||
      (value.q !== null && typeof value.q !== "string") ||
      (value.game !== null && typeof value.game !== "string") ||
      (value.card_number !== null &&
        typeof value.card_number !== "string") ||
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
    return value as CardCursor;
  } catch {
    return "invalid";
  }
}

async function digestFilters(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function invalidParameter(
  requestId: string,
  name: string,
  reason: string,
): Response {
  return problemResponse({
    requestId,
    status: 400,
    code: "invalid_parameter",
    title: "Invalid parameter",
    detail: "Invalid parameter",
    extensions: { invalid_params: [{ name, reason }] },
  });
}

function invalidCursor(requestId: string): Response {
  return problemResponse({
    requestId,
    status: 400,
    code: "invalid_cursor",
    title: "Invalid cursor",
    detail: "Invalid cursor",
  });
}

function cursorUnavailable(requestId: string): Response {
  return problemResponse({
    requestId,
    status: 409,
    code: "cursor_revision_unavailable",
    title: "Cursor revision unavailable",
    detail: "Cursor revision unavailable",
    extensions: { links: { collection: "/v1/cards" } },
  });
}

function catalogueQueryUnavailable(requestId: string): Response {
  return problemResponse({
    requestId,
    status: 503,
    code: "catalogue_query_unavailable",
    title: "Catalogue query unavailable",
    detail:
      "The current Catalogue Revision is not yet available through the Card query projection.",
  });
}
