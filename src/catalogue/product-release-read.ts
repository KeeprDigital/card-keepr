type ProductRow = {
  document_json: string;
  current_revision_id: string;
  published_at: string;
};

type ProductOrderValue = {
  id: string;
  game: string;
  official_code: string | null;
  name: string | null;
};

type ProductEnvelope = {
  data: ProductOrderValue & {
    releases: { region: string }[];
  } & Record<string, unknown>;
  included: unknown[];
  provenance: Record<string, string[]>;
  disagreements: unknown[];
};

const productRoute = "/v1/products";
const productOrder =
  "supported-game,official-code-null-last,name-null-last,id";

export class ProductReadProblem extends Error {
  constructor(
    readonly status: 400 | 409,
    readonly code:
      | "invalid_parameter"
      | "invalid_cursor"
      | "cursor_revision_unavailable",
    message: string,
  ) {
    super(message);
  }
}

export async function currentProductResponse(
  database: D1Database,
  productId: string,
  request: Request,
): Promise<Response | null> {
  const url = new URL(request.url);
  const row = await database
    .prepare(
      `SELECT product.document_json, catalogue.current_revision_id,
              catalogue.published_at
       FROM catalogue_state AS catalogue
       JOIN revision_products AS product
         ON product.catalogue_revision_id = catalogue.current_revision_id
       WHERE catalogue.singleton = 1 AND product.product_id = ?`,
    )
    .bind(productId)
    .first<ProductRow>();
  if (row === null) return null;
  const include = includeProjection(url);
  const envelope = productEnvelope(row.document_json);
  const etag = quotedEtag(
    `product:${productId}:${row.current_revision_id}:${[
      ...include,
    ].sort().join(",")}`,
  );
  if (ifNoneMatch(request, etag)) {
    return notModified(etag, row.current_revision_id);
  }
  return Response.json(
    {
      data: envelope.data,
      ...(include.has("evidence")
        ? {
            included: envelope.included,
            provenance: envelope.provenance,
          }
        : {}),
      ...(include.has("disagreements")
        ? { disagreements: envelope.disagreements }
        : {}),
      meta: {
        catalogue_revision_id: row.current_revision_id,
        published_at: row.published_at,
      },
      links: { self: `${url.pathname}${url.search}` },
    },
    {
      headers: productHeaders(row.current_revision_id, etag),
    },
  );
}

export async function currentProductsResponse(
  database: D1Database,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const state = await database
    .prepare(
      `SELECT current_revision_id, published_at
       FROM catalogue_state WHERE singleton = 1`,
    )
    .first<{ current_revision_id: string; published_at: string }>();
  if (state === null) throw new Error("Catalogue state is unavailable");
  const limit = parseLimit(url.searchParams.get("limit"));
  const q = url.searchParams.get("q")?.trim().toLocaleLowerCase() ?? null;
  const game = url.searchParams.get("game");
  const region = url.searchParams.get("release_region");
  assertFilter(game, region);
  const filters = { q, game, region, limit };
  const after = parseCursor(
    url.searchParams.get("after"),
    state.current_revision_id,
    filters,
  );
  const etag = quotedEtag(
    `products:${state.current_revision_id}:${JSON.stringify({
      route: productRoute,
      ordering: productOrder,
      filters,
      after,
    })}`,
  );
  if (ifNoneMatch(request, etag)) {
    return notModified(etag, state.current_revision_id);
  }
  const rows = await database
    .prepare(
      `SELECT document_json
       FROM revision_products
       WHERE catalogue_revision_id = ?
         AND (? IS NULL OR supported_game = ?)
         AND (? IS NULL OR instr(search_text, ?) > 0)
         AND (
           ? IS NULL OR EXISTS (
             SELECT 1 FROM json_each(release_regions_json)
             WHERE value = ?
           )
         )
         AND (
           ? = 0 OR (
             supported_game,
             official_code IS NULL,
             coalesce(official_code, ''),
             name IS NULL,
             coalesce(name, ''),
             product_id
           ) > (?, ?, ?, ?, ?, ?)
         )
       ORDER BY supported_game,
                official_code IS NULL,
                official_code,
                name IS NULL,
                name,
                product_id
       LIMIT ?`,
    )
    .bind(
      state.current_revision_id,
      game,
      game,
      q,
      q,
      region,
      region,
      after === null ? 0 : 1,
      after?.game ?? "",
      after?.official_code === null ? 1 : 0,
      after?.official_code ?? "",
      after?.name === null ? 1 : 0,
      after?.name ?? "",
      after?.id ?? "",
      limit + 1,
    )
    .all<{ document_json: string }>();
  const selected = rows.results.map(
    ({ document_json }) => productEnvelope(document_json).data,
  );
  const data = selected.slice(0, limit);
  const next =
    selected.length > limit
      ? encodeCursor({
          route: productRoute,
          ordering: productOrder,
          revision: state.current_revision_id,
          filters,
          last: orderValue(data.at(-1)!),
        })
      : null;
  return Response.json(
    {
      data,
      meta: {
        catalogue_revision_id: state.current_revision_id,
        published_at: state.published_at,
      },
      page: { limit, next_cursor: next },
      links: { self: `${url.pathname}${url.search}` },
    },
    {
      headers: productHeaders(state.current_revision_id, etag),
    },
  );
}

function productEnvelope(documentJson: string): ProductEnvelope {
  const parsed = JSON.parse(documentJson) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("A revision-pinned Product document is invalid.");
  }
  const value = parsed as Record<string, unknown>;
  const data =
    value.data !== null &&
    typeof value.data === "object" &&
    !Array.isArray(value.data)
      ? (value.data as ProductEnvelope["data"])
      : (value as ProductEnvelope["data"]);
  if (
    typeof data.id !== "string" ||
    typeof data.game !== "string" ||
    (data.official_code !== null &&
      typeof data.official_code !== "string") ||
    (data.name !== null && typeof data.name !== "string") ||
    !Array.isArray(data.releases)
  ) {
    throw new Error("A revision-pinned Product document is invalid.");
  }
  return {
    data,
    included: Array.isArray(value.included) ? value.included : [],
    provenance:
      value.provenance !== null &&
      typeof value.provenance === "object" &&
      !Array.isArray(value.provenance)
        ? (value.provenance as Record<string, string[]>)
        : {},
    disagreements: Array.isArray(value.disagreements)
      ? value.disagreements
      : [],
  };
}

function includeProjection(url: URL): Set<string> {
  const include = new Set(
    (url.searchParams.get("include") ?? "")
      .split(",")
      .filter((value) => value.length > 0),
  );
  if (
    [...include].some(
      (value) => value !== "evidence" && value !== "disagreements",
    )
  ) {
    throw new ProductReadProblem(
      400,
      "invalid_parameter",
      "Product include projection is invalid.",
    );
  }
  return include;
}

function parseLimit(value: string | null): number {
  if (value === null) return 50;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new ProductReadProblem(
      400,
      "invalid_parameter",
      "Product page limit is invalid.",
    );
  }
  return parsed;
}

function assertFilter(game: string | null, region: string | null): void {
  if (
    game !== null &&
    !["one-piece", "fusion-world", "digimon", "gundam"].includes(game)
  ) {
    throw new ProductReadProblem(
      400,
      "invalid_parameter",
      "Product game is invalid.",
    );
  }
  if (
    region !== null &&
    !["EN-OCEANIA", "EN-ASIA", "EN-US", "unknown"].includes(region)
  ) {
    throw new ProductReadProblem(
      400,
      "invalid_parameter",
      "Product Release region is invalid.",
    );
  }
}

function parseCursor(
  value: string | null,
  currentRevision: string,
  filters: {
    q: string | null;
    game: string | null;
    region: string | null;
    limit: number;
  },
): ProductOrderValue | null {
  if (value === null) return null;
  let cursor: {
    route?: unknown;
    ordering?: unknown;
    revision?: unknown;
    filters?: unknown;
    last?: unknown;
  };
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      "=",
    );
    cursor = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(padded), (character) =>
          character.charCodeAt(0),
        ),
      ),
    ) as typeof cursor;
  } catch {
    throw invalidCursor();
  }
  if (
    cursor.route !== productRoute ||
    cursor.ordering !== productOrder ||
    JSON.stringify(cursor.filters) !== JSON.stringify(filters) ||
    !validOrderValue(cursor.last)
  ) {
    throw invalidCursor();
  }
  if (cursor.revision !== currentRevision) {
    throw new ProductReadProblem(
      409,
      "cursor_revision_unavailable",
      "The Product cursor Catalogue Revision is unavailable.",
    );
  }
  return cursor.last;
}

function invalidCursor(): ProductReadProblem {
  return new ProductReadProblem(
    400,
    "invalid_cursor",
    "Product cursor is invalid.",
  );
}

function encodeCursor(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function validOrderValue(value: unknown): value is ProductOrderValue {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const product = value as Record<string, unknown>;
  return (
    typeof product.id === "string" &&
    typeof product.game === "string" &&
    (product.official_code === null ||
      typeof product.official_code === "string") &&
    (product.name === null || typeof product.name === "string")
  );
}

function orderValue(value: ProductOrderValue): ProductOrderValue {
  return {
    id: value.id,
    game: value.game,
    official_code: value.official_code,
    name: value.name,
  };
}

function quotedEtag(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `"${btoa(binary)}"`;
}

function ifNoneMatch(request: Request, etag: string): boolean {
  const header = request.headers.get("if-none-match");
  if (header === null) return false;
  const comparable = etag.replace(/^W\//u, "");
  return header
    .split(",")
    .map((value) => value.trim())
    .some(
      (value) =>
        value === "*" || value.replace(/^W\//u, "") === comparable,
    );
}

function notModified(etag: string, revisionId: string): Response {
  return new Response(null, {
    status: 304,
    headers: productHeaders(revisionId, etag),
  });
}

function productHeaders(revisionId: string, etag: string): HeadersInit {
  return {
    "cache-control": "private, no-cache",
    etag,
    "x-catalogue-revision": revisionId,
  };
}
