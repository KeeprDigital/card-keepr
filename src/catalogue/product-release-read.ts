import { ifNoneMatch } from "../http/conditional";
import {
  canonicalDetailSelf,
  detailIncludeProjection,
  detailRepresentationKey,
} from "./detail-representation";

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
    releases: ({ id: string; region: string } & Record<string, unknown>)[];
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
  const include = detailIncludeProjection(
    url,
    () =>
      new ProductReadProblem(
        400,
        "invalid_parameter",
        "Product include projection is invalid.",
      ),
  );
  const envelope = productEnvelope(row.document_json);
  const etag = quotedEtag(
    `product:${productId}:${row.current_revision_id}:` +
      detailRepresentationKey(include),
  );
  if (ifNoneMatch(request, etag)) {
    return notModified(etag, row.current_revision_id);
  }
  const evidenceSidecar = include.has("evidence")
    ? await productEvidenceProjection(database, envelope)
    : {};
  return Response.json(
    {
      data: envelope.data,
      ...evidenceSidecar,
      ...(include.has("disagreements")
        ? { disagreements: envelope.disagreements }
        : {}),
      meta: {
        catalogue_revision_id: row.current_revision_id,
        published_at: row.published_at,
      },
      links: { self: canonicalDetailSelf(url, include) },
    },
    {
      headers: productHeaders(row.current_revision_id, etag),
    },
  );
}

async function productEvidenceProjection(
  database: D1Database,
  envelope: ProductEnvelope,
): Promise<{
  included: unknown[];
  provenance: Record<string, string[]>;
}> {
  const references = curatedRevisionReferences(envelope.data);
  if (references.length === 0) {
    return {
      included: envelope.included,
      provenance: envelope.provenance,
    };
  }
  const revisionIds = [
    ...new Set(references.map(({ revisionId }) => revisionId)),
  ];
  const rows = await database
    .prepare(
      `SELECT id, created_at, author
       FROM curated_revisions
       WHERE id IN (SELECT value FROM json_each(?))`,
    )
    .bind(JSON.stringify(revisionIds))
    .all<{ id: string; created_at: string; author: string }>();
  const rowsById = new Map(rows.results.map((row) => [row.id, row]));
  if (rowsById.size !== revisionIds.length) {
    throw new Error(
      "A revision-pinned Product references unavailable Curated Revision evidence.",
    );
  }
  const provenance = structuredClone(envelope.provenance);
  for (const { path } of references) {
    provenance[path] = [
      ...new Set(
        references
          .filter((reference) => reference.path === path)
          .map(({ revisionId }) => revisionId),
      ),
    ];
  }
  return {
    included: [
      ...envelope.included,
      ...revisionIds.map((revisionId) => {
        const row = rowsById.get(revisionId)!;
        return {
          type: "curated_revision",
          id: row.id,
          captured_at: row.created_at,
          source: row.author,
        };
      }),
    ],
    provenance,
  };
}

function curatedRevisionReferences(
  data: ProductEnvelope["data"],
): { path: string; revisionId: string }[] {
  return [
    ...curatedFieldReferences(data, "/data", "product", data.id),
    ...data.releases.flatMap((release, index) =>
      curatedFieldReferences(
        release,
        `/data/releases/${index}`,
        "release",
        release.id,
      )
    ),
  ];
}

function curatedFieldReferences(
  value: Record<string, unknown>,
  responsePath: string,
  entityType: "product" | "release",
  entityId: string,
): { path: string; revisionId: string }[] {
  if (!Array.isArray(value.curated_provenance)) return [];
  return value.curated_provenance.flatMap((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("A revision-pinned Product has invalid curated provenance.");
    }
    const provenance = item as Record<string, unknown>;
    const target = provenance.target;
    if (
      typeof provenance.curated_revision_id !== "string" ||
      target === null ||
      typeof target !== "object" ||
      Array.isArray(target)
    ) {
      throw new Error("A revision-pinned Product has invalid curated provenance.");
    }
    const field = target as Record<string, unknown>;
    if (
      field.kind !== "field" ||
      field.entity_type !== entityType ||
      field.entity_id !== entityId ||
      typeof field.path !== "string" ||
      !field.path.startsWith("/")
    ) {
      throw new Error("A revision-pinned Product has invalid curated provenance.");
    }
    return [{
      path: `${responsePath}${field.path}`,
      revisionId: provenance.curated_revision_id,
    }];
  });
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
  const limit = parseLimit(singleParameter(url, "limit"));
  const q = parseQuery(url);
  const fts = q === null ? null : ftsQuery(q);
  const game = singleParameter(url, "game");
  const region = singleParameter(url, "release_region");
  assertFilter(game, region);
  const filters = { q, game, region, limit };
  const requestedAfter = singleParameter(url, "after");
  const cursor = parseCursor(requestedAfter, filters);
  const revisionId = cursor?.revision ?? state.current_revision_id;
  const revision =
    revisionId === state.current_revision_id
      ? { published_at: state.published_at }
      : await database
          .prepare(
            `SELECT revision.published_at
             FROM catalogue_revisions AS revision
             JOIN catalogue_query_revisions AS query
               ON query.catalogue_revision_id = revision.id
              AND query.state = 'available'
             WHERE revision.id = ?`,
          )
          .bind(revisionId)
          .first<{ published_at: string }>();
  if (revision === null) {
    throw new ProductReadProblem(
      409,
      "cursor_revision_unavailable",
      "The Product cursor Catalogue Revision is unavailable.",
    );
  }
  const after = cursor?.last ?? null;
  const etag = quotedEtag(
    `products:${revisionId}:${JSON.stringify({
      route: productRoute,
      ordering: productOrder,
      filters,
      after,
    })}`,
  );
  if (ifNoneMatch(request, etag)) {
    return notModified(etag, revisionId);
  }
  const rows = await database
    .prepare(
      `SELECT document_json
       FROM revision_products
       WHERE catalogue_revision_id = ?
         AND (? IS NULL OR supported_game = ?)
         AND (
           ? IS NULL OR product_id IN (
             SELECT product_id
             FROM revision_products_fts
             WHERE catalogue_revision_id = ?
               AND search_text MATCH ?
           )
         )
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
      revisionId,
      game,
      game,
      q,
      revisionId,
      fts,
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
          revision: revisionId,
          filters,
          last: orderValue(data.at(-1)!),
        })
      : null;
  return Response.json(
    {
      data,
      meta: {
        catalogue_revision_id: revisionId,
        published_at: revision.published_at,
      },
      page: { limit, next_cursor: next },
      links: {
        self: canonicalProductSelf(url, {
          q,
          game,
          region,
          limit,
          after: requestedAfter,
        }),
      },
    },
    {
      headers: productHeaders(revisionId, etag),
    },
  );
}

function ftsQuery(value: string): string {
  const tokens = value.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length === 0) {
    throw new ProductReadProblem(
      400,
      "invalid_parameter",
      "Product search query has no searchable terms.",
    );
  }
  return tokens.map((token) => `"${token.replaceAll("\"", "\"\"")}"*`)
    .join(" AND ");
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

function parseQuery(url: URL): string | null {
  const values = url.searchParams.getAll("q");
  if (values.length === 0) return null;
  const raw = values[0]!;
  const q = raw
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en");
  if (
    values.length !== 1 ||
    [...raw].length > 500 ||
    q.length < 1 ||
    [...q].length > 500
  ) {
    throw new ProductReadProblem(
      400,
      "invalid_parameter",
      "Product search query is invalid.",
    );
  }
  return q;
}

function singleParameter(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  if (values.length === 0) return null;
  if (values.length !== 1) {
    throw new ProductReadProblem(
      400,
      "invalid_parameter",
      `Product ${name} parameter is repeated.`,
    );
  }
  return values[0]!;
}

function canonicalProductSelf(
  url: URL,
  representation:
    {
      q: string | null;
      game: string | null;
      region: string | null;
      limit: number;
      after: string | null;
    },
): string {
  const query = new URLSearchParams();
  if (representation.q !== null) query.set("q", representation.q);
  if (representation.game !== null) query.set("game", representation.game);
  if (representation.region !== null) {
    query.set("release_region", representation.region);
  }
  if (representation.limit !== 50) {
    query.set("limit", String(representation.limit));
  }
  if (representation.after !== null) {
    query.set("after", representation.after);
  }
  const serialized = query.toString();
  return serialized.length === 0
    ? url.pathname
    : `${url.pathname}?${serialized}`;
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
  filters: {
    q: string | null;
    game: string | null;
    region: string | null;
    limit: number;
  },
): { revision: string; last: ProductOrderValue } | null {
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
    typeof cursor.revision !== "string" ||
    !validOrderValue(cursor.last)
  ) {
    throw invalidCursor();
  }
  return { revision: cursor.revision, last: cursor.last };
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
