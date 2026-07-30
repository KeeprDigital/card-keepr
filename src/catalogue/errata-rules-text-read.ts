type RevisionCardRow = {
  document_json: string;
};

type CardDocument = {
  type: "card";
  id: string;
  game: string;
  official_identity: { kind: string; value: string };
  name: string;
  game_data: Record<string, unknown>;
  effective_rules_text: string | null;
  lifecycle: Record<string, unknown>;
  links: { self: string };
};

type CardCursor = {
  contract: "card-keepr-card-cursor@1";
  revision_id: string;
  q: string | null;
  game: string | null;
  card_number: string | null;
  limit: number;
  after_id: string;
};

export async function currentCardCollectionResponse(
  database: D1Database,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const requestedLimit = url.searchParams.get("limit");
  const limit =
    requestedLimit === null ? 50 : Number.parseInt(requestedLimit, 10);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    String(limit) !== (requestedLimit ?? "50")
  ) {
    return invalidParameter("limit", "limit must be an integer from 1 to 100.");
  }
  const q = normalizedFilter(url.searchParams.get("q"));
  if (url.searchParams.has("q") && q === null) {
    return invalidParameter("q", "q must contain at least one character.");
  }
  if (q !== null && q.length > 500) {
    return invalidParameter("q", "q must contain at most 500 characters.");
  }
  const game = normalizedFilter(url.searchParams.get("game"));
  if (
    game !== null &&
    game !== "one-piece" &&
    game !== "fusion-world" &&
    game !== "digimon" &&
    game !== "gundam"
  ) {
    return invalidParameter("game", "game is not a Supported Game.");
  }
  const cardNumber = normalizedFilter(
    url.searchParams.get("card_number"),
  );
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
  const rows = await database
    .prepare(
      `SELECT document_json FROM revision_cards
       WHERE catalogue_revision_id = ?`,
    )
    .bind(state.current_revision_id)
    .all<RevisionCardRow>();
  const cursor = parseCursor(url.searchParams.get("after"));
  if (cursor === "invalid") return invalidCursor();
  if (
    cursor !== null &&
    cursor.revision_id !== state.current_revision_id
  ) {
    return cursorUnavailable();
  }
  if (
    cursor !== null &&
    (cursor.q !== q ||
      cursor.game !== game ||
      cursor.card_number !== cardNumber ||
      cursor.limit !== limit)
  ) {
    return invalidCursor();
  }
  const normalizedQuery = q?.toLocaleLowerCase("en") ?? null;
  const cards = rows.results
    .map((row) => JSON.parse(row.document_json) as CardDocument)
    .filter(
      (card) =>
        (game === null || card.game === game) &&
        (cardNumber === null ||
          (card.official_identity.kind === "card_number" &&
            card.official_identity.value === cardNumber)) &&
        (normalizedQuery === null ||
          card.official_identity.value
            .toLocaleLowerCase("en")
            .includes(normalizedQuery) ||
          card.name.toLocaleLowerCase("en").includes(normalizedQuery) ||
          (card.effective_rules_text
            ?.toLocaleLowerCase("en")
            .includes(normalizedQuery) ??
            false)),
    )
    .sort(compareCards);
  const cursorIndex =
    cursor === null
      ? null
      : cards.findIndex((card) => card.id === cursor.after_id);
  if (cursorIndex === -1) return invalidCursor();
  const afterIndex = cursorIndex === null ? 0 : cursorIndex + 1;
  const page = cards.slice(afterIndex, afterIndex + limit);
  const hasNext = afterIndex + page.length < cards.length;
  const nextCursor =
    hasNext && page.length > 0
      ? encodeCursor({
          contract: "card-keepr-card-cursor@1",
          revision_id: state.current_revision_id,
          q,
          game,
          card_number: cardNumber,
          limit,
          after_id: page.at(-1)!.id,
        })
      : null;
  const etag = `"cards:${state.current_revision_id}:${await digestFilters(url.search)}"`;
  const headers = {
    "cache-control": "private, no-cache",
    etag,
    "x-catalogue-revision": state.current_revision_id,
  };
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return Response.json(
    {
      data: page.map(cardSummary),
      meta: {
        catalogue_revision_id: state.current_revision_id,
        published_at: state.published_at,
      },
      page: { limit, next_cursor: nextCursor },
      links: { self: `/v1/cards${url.search}` },
    },
    { headers },
  );
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

function compareCards(left: CardDocument, right: CardDocument): number {
  return [
    left.game.localeCompare(right.game),
    left.official_identity.kind.localeCompare(
      right.official_identity.kind,
    ),
    left.official_identity.value.localeCompare(
      right.official_identity.value,
    ),
    left.id.localeCompare(right.id),
  ].find((difference) => difference !== 0) ?? 0;
}

function normalizedFilter(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.normalize("NFC").trim();
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
    if (
      value.contract !== "card-keepr-card-cursor@1" ||
      typeof value.revision_id !== "string" ||
      typeof value.after_id !== "string" ||
      typeof value.limit !== "number" ||
      (value.q !== null && typeof value.q !== "string") ||
      (value.game !== null && typeof value.game !== "string") ||
      (value.card_number !== null &&
        typeof value.card_number !== "string")
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

function invalidParameter(name: string, reason: string): Response {
  return problem(400, "invalid_parameter", "Invalid parameter", {
    invalid_params: [{ name, reason }],
  });
}

function invalidCursor(): Response {
  return problem(400, "invalid_cursor", "Invalid cursor");
}

function cursorUnavailable(): Response {
  return problem(
    409,
    "cursor_revision_unavailable",
    "Cursor revision unavailable",
    { links: { collection: "/v1/cards" } },
  );
}

function problem(
  status: number,
  code: string,
  title: string,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json(
    {
      type: `https://card-keepr.invalid/problems/${code}`,
      title,
      status,
      code,
      detail: title,
      request_id: crypto.randomUUID(),
      ...extra,
    },
    {
      status,
      headers: { "content-type": "application/problem+json" },
    },
  );
}
