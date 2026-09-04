import type { ProductRow } from "./published-read-repository";
import {
  currentProductStatement,
  productCuratedEvidenceStatement,
  productCollectionStatement,
} from "./published-read-repository";
import { absoluteDocumentLinks, type PublicBase, publicUrl } from "../../http/public-base";
import {
  canonicalEtag,
  collectionFilter,
  collectionLimit,
  collectionPage,
  collectionParameters,
  collectionSelf,
  conditionalResponse,
  decodeCursor,
  encodeCursor,
  pinRevision,
  ReadProblem,
  revisionHeaders,
  singleParameter,
} from "./collection-endpoint";
import { canonicalDetailSelf, detailIncludeProjection, detailRepresentationKey } from "./detail-representation";

type ProductOrderValue = {
  id: string;
  game: string;
  official_code: string | null;
  name: string | null;
};

export type StoredProductApiProjection = ProductOrderValue & {
  releases: ({ id: string; region: string } & Record<string, unknown>)[];
} & Record<string, unknown>;

type ProductEnvelope = {
  data: StoredProductApiProjection;
  included: unknown[];
  provenance: Record<string, string[]>;
  disagreements: unknown[];
};

const productRoute = "/v1/products";
const productOrder = "supported-game,official-code-null-last,name-null-last,id";

export async function currentProductResponse(
  database: D1Database,
  productId: string,
  request: Request,
  base: PublicBase,
): Promise<Response | null> {
  const url = new URL(request.url);
  const row = await currentProductStatement(database, productId).first<ProductRow>();
  if (row === null) return null;
  const include = detailIncludeProjection(
    url,
    () =>
      new ReadProblem(400, "invalid_parameter", "Product include projection is invalid.", {
        name: "include",
        reason: "Product include projection is invalid.",
      }),
  );
  const envelope = productEnvelope(row.document_json);
  const etag = await canonicalEtag(
    `product:${productId}:${row.current_revision_id}:${detailRepresentationKey(include)}`,
  );
  const conditional = conditionalResponse(request, revisionHeaders(row.current_revision_id, etag));
  if (conditional !== null) return conditional;
  const evidenceSidecar = include.has("evidence")
    ? await productEvidenceProjection(database, row.current_revision_id, envelope)
    : {};
  return Response.json(
    {
      data: absoluteDocumentLinks(envelope.data, base),
      ...evidenceSidecar,
      ...(include.has("disagreements") ? { disagreements: envelope.disagreements } : {}),
      meta: {
        catalogue_revision_id: row.current_revision_id,
        published_at: row.published_at,
      },
      links: { self: publicUrl(base, canonicalDetailSelf(url, include)) },
    },
    {
      headers: revisionHeaders(row.current_revision_id, etag),
    },
  );
}

async function productEvidenceProjection(
  database: D1Database,
  catalogueRevisionId: string,
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
  const revisionIds = [...new Set(references.map(({ revisionId }) => revisionId))];
  // Publication projects every Curated Revision the revision carries into
  // catalogue_curated_provenance with its author and creation instant, so
  // the evidence sidecar reads the projection, not curated_revisions
  // (issue #98).
  const rows = await productCuratedEvidenceStatement(database, {
    revisionId: catalogueRevisionId,
    revisionIdsJson: JSON.stringify(revisionIds),
  }).all<{ id: string; created_at: unknown; author: unknown }>();
  const rowsById = new Map(
    rows.results.map((row) => {
      if (typeof row.created_at !== "string" || typeof row.author !== "string") {
        throw new Error("A revision-pinned Product references unavailable Curated Revision evidence.");
      }
      return [row.id, { id: row.id, created_at: row.created_at, author: row.author }];
    }),
  );
  if (rowsById.size !== revisionIds.length) {
    throw new Error("A revision-pinned Product references unavailable Curated Revision evidence.");
  }
  const provenance = structuredClone(envelope.provenance);
  for (const { path } of references) {
    provenance[path] = [
      ...new Set(references.filter((reference) => reference.path === path).map(({ revisionId }) => revisionId)),
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

function curatedRevisionReferences(data: ProductEnvelope["data"]): { path: string; revisionId: string }[] {
  return [
    ...curatedFieldReferences(data, "/data", "product", data.id),
    ...data.releases.flatMap((release, index) =>
      curatedFieldReferences(release, `/data/releases/${index}`, "release", release.id),
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
    return [
      {
        path: `${responsePath}${field.path}`,
        revisionId: provenance.curated_revision_id,
      },
    ];
  });
}

export async function currentProductsResponse(
  database: D1Database,
  request: Request,
  base: PublicBase,
): Promise<Response> {
  const url = new URL(request.url);
  collectionParameters(url);
  const limit = collectionLimit(singleParameter(url, "limit"));
  const q = parseQuery(url);
  const fts = q === null ? null : ftsQuery(q);
  const game = collectionFilter(url, "game");
  const region = collectionFilter(url, "release_region");
  assertFilter(game, region);
  const filters = { q, game, region, limit };
  const requestedAfter = singleParameter(url, "after");
  const cursor = parseCursor(requestedAfter, filters);
  const revision = await pinRevision(database, cursor?.revision ?? null, productRoute, base);
  const revisionId = revision.id;
  const after = cursor?.last ?? null;
  const etag = await canonicalEtag(
    `products:${revisionId}:${JSON.stringify({
      route: productRoute,
      ordering: productOrder,
      filters,
      after,
    })}`,
  );
  const conditional = conditionalResponse(request, revisionHeaders(revisionId, etag));
  if (conditional !== null) return conditional;
  const page = await collectionPage<{ document_json: string }>(
    productCollectionStatement(database, {
      revisionId: revisionId,
      game: game,
      query: q,
      fts: fts,
      region: region,
      hasAfter: after === null ? 0 : 1,
      afterGame: after?.game ?? "",
      afterCodeNull: after?.official_code === null ? 1 : 0,
      afterCode: after?.official_code ?? "",
      afterNameNull: after?.name === null ? 1 : 0,
      afterName: after?.name ?? "",
      afterId: after?.id ?? "",
      rowLimit: limit + 1,
    }),
    limit,
  );
  const selected = page.rows.map(({ document_json }) => storedProductApiProjection(document_json));
  const data = selected.slice(0, limit).map((product) => absoluteDocumentLinks(product, base));
  const next = page.hasMore
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
        self: publicUrl(
          base,
          canonicalProductSelf(url, {
            q,
            game,
            region,
            limit,
            after:
              cursor === null
                ? null
                : encodeCursor({
                    route: productRoute,
                    ordering: productOrder,
                    revision: revisionId,
                    filters,
                    last: cursor.last,
                  }),
          }),
        ),
      },
    },
    {
      headers: revisionHeaders(revisionId, etag),
    },
  );
}

function ftsQuery(value: string): string {
  const tokens = value.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length === 0) {
    throw new ReadProblem(400, "invalid_parameter", "Product search query has no searchable terms.", {
      name: "q",
      reason: "Product search query has no searchable terms.",
    });
  }
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(" AND ");
}

function productEnvelope(documentJson: string): ProductEnvelope {
  const parsed = JSON.parse(documentJson) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("A revision-pinned Product document is invalid.");
  }
  const value = parsed as Record<string, unknown>;
  const data =
    value.data !== null && typeof value.data === "object" && !Array.isArray(value.data)
      ? (value.data as ProductEnvelope["data"])
      : (value as ProductEnvelope["data"]);
  if (
    typeof data.id !== "string" ||
    typeof data.game !== "string" ||
    (data.official_code !== null && typeof data.official_code !== "string") ||
    (data.name !== null && typeof data.name !== "string") ||
    !Array.isArray(data.releases)
  ) {
    throw new Error("A revision-pinned Product document is invalid.");
  }
  return {
    data,
    included: Array.isArray(value.included) ? value.included : [],
    provenance:
      value.provenance !== null && typeof value.provenance === "object" && !Array.isArray(value.provenance)
        ? (value.provenance as Record<string, string[]>)
        : {},
    disagreements: Array.isArray(value.disagreements) ? value.disagreements : [],
  };
}

export function storedProductApiProjection(documentJson: string): StoredProductApiProjection {
  return productEnvelope(documentJson).data;
}

function parseQuery(url: URL): string | null {
  const raw = collectionFilter(url, "q");
  if (raw === null) return null;
  const q = raw.normalize("NFKC").trim().toLocaleLowerCase("en");
  if (q.length < 1 || [...q].length > 500) {
    throw new ReadProblem(400, "invalid_parameter", "Product search query is invalid.", {
      name: "q",
      reason: "Product search query is invalid.",
    });
  }
  return q;
}

function canonicalProductSelf(
  url: URL,
  representation: {
    q: string | null;
    game: string | null;
    region: string | null;
    limit: number;
    after: string | null;
  },
): string {
  return collectionSelf(url.pathname, {
    q: representation.q,
    game: representation.game,
    release_region: representation.region,
    limit: representation.limit,
    after: representation.after,
  });
}

function assertFilter(game: string | null, region: string | null): void {
  if (game !== null && !["one-piece", "fusion-world", "digimon", "gundam"].includes(game)) {
    throw new ReadProblem(400, "invalid_parameter", "Product game is invalid.", {
      name: "game",
      reason: "Product game is invalid.",
    });
  }
  if (region !== null && !["EN-OCEANIA", "EN-ASIA", "EN-US", "unknown"].includes(region)) {
    throw new ReadProblem(400, "invalid_parameter", "Product Release region is invalid.", {
      name: "release_region",
      reason: "Product Release region is invalid.",
    });
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
    cursor = decodeCursor(value) as typeof cursor;
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
  return { revision: cursor.revision, last: orderValue(cursor.last) };
}

function invalidCursor(): ReadProblem {
  return new ReadProblem(400, "invalid_cursor", "Product cursor is invalid.");
}

function validOrderValue(value: unknown): value is ProductOrderValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const product = value as Record<string, unknown>;
  return (
    typeof product.id === "string" &&
    typeof product.game === "string" &&
    (product.official_code === null || typeof product.official_code === "string") &&
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
