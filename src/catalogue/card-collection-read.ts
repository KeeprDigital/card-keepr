import { ifNoneMatchMatches } from "../http/conditional-request";
import { problemResponse } from "../http/problem";
import { cardSearchQuery } from "./card-search";

type CardDocument = {
  type: "card";
  id: string;
  game: string;
  official_identity: { kind: string; value: string };
  name: string;
  game_data: Record<string, unknown>;
  lifecycle: Record<string, unknown>;
  links: { self: string };
};

type CardRow = {
  document_json: string;
  sort_game: string;
  sort_identity_kind: string;
  sort_identity_value: string;
  sort_id: string;
};

type CardCursor = {
  contract: "card-keepr-card-cursor@1";
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
    (cursor.q !== filters.q ||
      cursor.game !== filters.game ||
      cursor.card_number !== filters.cardNumber ||
      cursor.limit !== filters.limit)
  ) {
    return invalidCursor(requestId);
  }
  const current = await currentRevision(database);
  const revision =
    cursor === null || cursor.revision_id === current.id
      ? current
      : await availableRevision(database, cursor.revision_id);
  if (revision === null) return cursorUnavailable(requestId);

  const etag = `"cards:${revision.id}:${await digestFilters(url.search)}"`;
  const headers = {
    "cache-control": "private, no-cache",
    etag,
    "x-catalogue-revision": revision.id,
  };
  if (ifNoneMatchMatches(request, etag)) {
    return new Response(null, { status: 304, headers });
  }

  const rows = await queryCardPage(
    database,
    revision.id,
    filters,
    cursor?.after ?? null,
  );
  const pageRows = rows.slice(0, filters.limit);
  const nextCursor =
    rows.length > filters.limit && pageRows.length > 0
      ? encodeCursor({
          contract: "card-keepr-card-cursor@1",
          revision_id: revision.id,
          q: filters.q,
          game: filters.game,
          card_number: filters.cardNumber,
          limit: filters.limit,
          after: rowCursor(pageRows.at(-1)!),
        })
      : null;
  return Response.json(
    {
      data: pageRows.map((row) =>
        cardSummary(JSON.parse(row.document_json) as CardDocument),
      ),
      meta: {
        catalogue_revision_id: revision.id,
        published_at: revision.publishedAt,
      },
      page: { limit: filters.limit, next_cursor: nextCursor },
      links: { self: `/v1/cards${url.search}` },
    },
    { headers },
  );
}

async function queryCardPage(
  database: D1Database,
  revisionId: string,
  filters: CollectionFilters,
  after: CardCursor["after"] | null,
): Promise<CardRow[]> {
  const query = cardCollectionPageQuery(
    revisionId,
    filters,
    after,
  );
  const result = await database
    .prepare(query.sql)
    .bind(...query.bindings)
    .all<CardRow>();
  return result.results;
}

export function cardCollectionPageQuery(
  revisionId: string,
  filters: CollectionFilters,
  after: CardCursor["after"] | null,
): { sql: string; bindings: (string | number)[] } {
  const searched = filters.q !== null;
  const conditions = [
    `${searched ? "search" : "cards"}.catalogue_revision_id = ?`,
  ];
  const bindings: (string | number)[] = [revisionId];
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
  if (filters.q !== null) {
    const search = cardSearchQuery(filters.q);
    if (search === null) {
      throw new Error("The validated Card search query is unavailable.");
    }
    conditions.push(
      "search.term = ?",
      "instr(cards.search_text, ?) > 0",
    );
    bindings.push(search.anchorTerm, search.text);
  }
  if (after !== null) {
    conditions.push(
      `(cards.sort_game, cards.sort_identity_kind,
        cards.sort_identity_value, cards.sort_id)
       > (?, ?, ?, ?)`,
    );
    bindings.push(
      after.game,
      after.identity_kind,
      after.identity_value,
      after.id,
    );
  }
  bindings.push(filters.limit + 1);
  return {
    sql:
      `SELECT cards.document_json, cards.sort_game,
              cards.sort_identity_kind, cards.sort_identity_value,
              cards.sort_id
       FROM ${
        searched
          ? `revision_card_search_terms AS search
             INDEXED BY revision_card_search_by_term
             JOIN revision_cards AS cards
               ON cards.catalogue_revision_id =
                    search.catalogue_revision_id
              AND cards.card_id = search.card_id`
          : "revision_cards AS cards"
      }
       WHERE ${conditions.join("\nAND ")}
       ORDER BY cards.sort_game, cards.sort_identity_kind,
                cards.sort_identity_value, cards.sort_id
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
  const q = cardSearchQuery(url.searchParams.get("q"))?.text ?? null;
  if (url.searchParams.has("q") && q === null) {
    return invalidParameter(
      requestId,
      "q",
      "q must contain at least one character.",
    );
  }
  if (q !== null && q.length > 500) {
    return invalidParameter(
      requestId,
      "q",
      "q must contain at most 500 characters.",
    );
  }
  const game = normalizedFilter(url.searchParams.get("game"));
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
  return {
    q,
    game,
    cardNumber: normalizedFilter(url.searchParams.get("card_number")),
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
       WHERE revision.id = ?`,
    )
    .bind(id)
    .first<{ id: string; published_at: string }>();
  return revision === null
    ? null
    : { id: revision.id, publishedAt: revision.published_at };
}

function cardSummary(card: CardDocument) {
  return {
    type: card.type,
    id: card.id,
    game: card.game,
    official_identity: card.official_identity,
    name: card.name,
    game_data: card.game_data,
    lifecycle: card.lifecycle,
    links: card.links,
  };
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
      typeof value.revision_id !== "string" ||
      typeof value.limit !== "number" ||
      (value.q !== null && typeof value.q !== "string") ||
      (value.game !== null && typeof value.game !== "string") ||
      (value.card_number !== null &&
        typeof value.card_number !== "string") ||
      after === null ||
      typeof after !== "object" ||
      typeof after.game !== "string" ||
      typeof after.identity_kind !== "string" ||
      typeof after.identity_value !== "string" ||
      typeof after.id !== "string"
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
