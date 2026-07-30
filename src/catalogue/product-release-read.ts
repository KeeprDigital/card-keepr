type ProductRow = {
  document_json: string;
  current_revision_id: string;
  published_at: string;
};

export class ProductReadProblem extends Error {
  constructor(
    readonly status: 400 | 409,
    readonly code: "invalid_parameter" | "invalid_cursor" | "cursor_revision_unavailable",
    message: string,
  ) {
    super(message);
  }
}

export async function currentProductResponse(
  database: D1Database,
  productId: string,
  url?: URL,
): Promise<Response | null> {
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
  const data = JSON.parse(row.document_json) as {
    official_code: string | null;
    name: string;
    releases: unknown[];
  };
  const include = new Set(
    (url?.searchParams.get("include") ?? "")
      .split(",")
      .filter((value) => value.length > 0),
  );
  if ([...include].some((value) => value !== "evidence" && value !== "disagreements")) {
    throw new ProductReadProblem(
      400,
      "invalid_parameter",
      "Product include projection is invalid.",
    );
  }
  const evidence = include.has("evidence")
    ? await productEvidence(database, data.official_code ?? data.name, row)
    : null;
  return productResponse(
    data,
    row,
    `/v1/products/${encodeURIComponent(productId)}`,
    `product:${productId}:${row.current_revision_id}`,
    {
      ...(evidence === null ? {} : evidence),
      ...(include.has("disagreements") ? { disagreements: [] } : {}),
    },
  );
}

export async function currentProductsResponse(
  database: D1Database,
  url: URL,
): Promise<Response> {
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
  const after = parseCursor(url.searchParams.get("after"), state.current_revision_id, filters);
  const rows = await database
    .prepare(
      `SELECT document_json
       FROM revision_products
       WHERE catalogue_revision_id = ?`,
    )
    .bind(state.current_revision_id)
    .all<{ document_json: string }>();
  const selected = rows.results
    .map(({ document_json }) => JSON.parse(document_json) as {
      id: string;
      game: string;
      official_code: string | null;
      name: string;
      releases: { region: string }[];
    })
    .filter(
      (product) =>
        (game === null || product.game === game) &&
        (region === null ||
          product.releases.some((release) => release.region === region)) &&
        (q === null ||
          product.name.toLocaleLowerCase().includes(q) ||
          product.official_code?.toLocaleLowerCase().includes(q) === true),
    )
    .sort(productOrder)
    .filter((product) =>
      after === null ? true : productOrder(product, after) > 0,
    );
  const data = selected.slice(0, limit);
  const next =
    selected.length > limit
      ? encodeCursor({
          revision: state.current_revision_id,
          filters,
          last: data.at(-1)!,
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
      links: { self: `/v1/products${url.search}` },
    },
    {
      headers: {
        "cache-control": "private, no-cache",
        etag: `"products:${state.current_revision_id}:${url.search}"`,
        "x-catalogue-revision": state.current_revision_id,
      },
    },
  );
}

function productResponse(
  data: unknown,
  state: { current_revision_id: string; published_at: string },
  self: string,
  etag: string,
  sidecars: Record<string, unknown>,
): Response {
  return Response.json(
    {
      data,
      ...sidecars,
      meta: {
        catalogue_revision_id: state.current_revision_id,
        published_at: state.published_at,
      },
      links: { self },
    },
    {
      headers: {
        "cache-control": "private, no-cache",
        etag: `"${etag}"`,
        "x-catalogue-revision": state.current_revision_id,
      },
    },
  );
}

async function productEvidence(
  database: D1Database,
  relationshipValue: string,
  state: { current_revision_id: string; published_at: string },
): Promise<Record<string, unknown>> {
  const rows = await database
    .prepare(
      `SELECT DISTINCT source_observation_id, source_lineage
       FROM reconciled_printing_memberships
       WHERE relationship_kind = 'product' AND relationship_value = ?
       ORDER BY source_observation_id`,
    )
    .bind(relationshipValue)
    .all<{ source_observation_id: string; source_lineage: string }>();
  if (rows.results.length === 0) {
    return { included: [], provenance: {} };
  }
  const ids = rows.results.map(({ source_observation_id }) => source_observation_id);
  return {
    included: rows.results.map((evidence) => ({
      type: "source_observation",
      id: evidence.source_observation_id,
      captured_at: state.published_at,
      source: evidence.source_lineage,
    })),
    provenance: {
      "/data/official_code": ids,
      "/data/name": ids,
      ...Object.fromEntries(
        ids.length === 0
          ? []
          : [
              ["/data/releases/0/date/value", ids],
              ["/data/releases/0/status", ids],
            ],
      ),
    },
  };
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

type ProductOrderValue = {
  id: string;
  game: string;
  official_code: string | null;
  name: string;
};

function productOrder(left: ProductOrderValue, right: ProductOrderValue): number {
  return (
    left.game.localeCompare(right.game) ||
    Number(left.official_code === null) - Number(right.official_code === null) ||
    (left.official_code ?? "").localeCompare(right.official_code ?? "") ||
    left.name.localeCompare(right.name) ||
    left.id.localeCompare(right.id)
  );
}

function assertFilter(game: string | null, region: string | null): void {
  if (
    game !== null &&
    !["one-piece", "fusion-world", "digimon", "gundam"].includes(game)
  ) {
    throw new ProductReadProblem(400, "invalid_parameter", "Product game is invalid.");
  }
  if (
    region !== null &&
    !["EN-OCEANIA", "EN-ASIA", "EN-US"].includes(region)
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
  filters: { q: string | null; game: string | null; region: string | null; limit: number },
): ProductOrderValue | null {
  if (value === null) return null;
  let cursor: {
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
    throw new ProductReadProblem(400, "invalid_cursor", "Product cursor is invalid.");
  }
  if (cursor.revision !== currentRevision) {
    throw new ProductReadProblem(
      409,
      "cursor_revision_unavailable",
      "The Product cursor Catalogue Revision is unavailable.",
    );
  }
  if (JSON.stringify(cursor.filters) !== JSON.stringify(filters) || !validOrderValue(cursor.last)) {
    throw new ProductReadProblem(400, "invalid_cursor", "Product cursor is invalid.");
  }
  return cursor.last;
}

function encodeCursor(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function validOrderValue(value: unknown): value is ProductOrderValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const product = value as Record<string, unknown>;
  return (
    typeof product.id === "string" &&
    typeof product.game === "string" &&
    (product.official_code === null || typeof product.official_code === "string") &&
    typeof product.name === "string"
  );
}
