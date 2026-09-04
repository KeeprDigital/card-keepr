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
  invalidParameter,
  pinRevision,
  ReadProblem,
  revisionHeaders,
} from "./collection-endpoint";
import { printingCollectionStatement } from "./printing-collection-repository";

const printingRoute = "/v1/printings";
const printingOrder = "card-id,printing-id";
const supportedGames = new Set(["one-piece", "fusion-world", "digimon", "gundam"]);
const releaseRegions = new Set(["EN-OCEANIA", "EN-ASIA", "EN-US", "unknown"]);

type PrintingCursor = {
  route: typeof printingRoute;
  ordering: typeof printingOrder;
  revision: string;
  filters: {
    card_id: string | null;
    game: string | null;
    rarity: string | null;
    product_id: string | null;
    release_region: string | null;
    limit: number;
  };
  last: { card_id: string; id: string };
};

export async function currentPrintingsResponse(
  database: D1Database,
  request: Request,
  base: PublicBase,
): Promise<Response> {
  const url = new URL(request.url);
  collectionParameters(url);
  const limit = collectionLimit(url.searchParams.get("limit"));
  const cardId = collectionFilter(url, "card_id");
  const game = collectionFilter(url, "game");
  const rarity = normalizedRarity(collectionFilter(url, "rarity"));
  const productId = collectionFilter(url, "product_id");
  const releaseRegion = collectionFilter(url, "release_region");
  if (game !== null && !supportedGames.has(game)) {
    throw invalidParameter("game", "Printing Supported Game is invalid.");
  }
  if (releaseRegion !== null && !releaseRegions.has(releaseRegion)) {
    throw invalidParameter("release_region", "Printing Release region is invalid.");
  }
  const filters = {
    card_id: cardId,
    game,
    rarity,
    product_id: productId,
    release_region: releaseRegion,
    limit,
  };
  const cursor = parseCursor(url.searchParams.get("after"), filters);
  const revision = await pinRevision(database, cursor?.revision ?? null, printingRoute, base);
  const revisionId = revision.id;
  const after = cursor?.last ?? null;
  const etag = await canonicalEtag(
    `printings:${revisionId}:${JSON.stringify({
      route: printingRoute,
      ordering: printingOrder,
      filters,
      after,
    })}`,
  );
  const conditional = conditionalResponse(request, revisionHeaders(revisionId, etag));
  if (conditional !== null) return conditional;

  const page = await collectionPage<{ printing_id: string; card_id: string; document_json: string }>(
    printingCollectionStatement(database, revisionId, filters, after, limit + 1),
    limit,
  );
  const selected = page.rows.map((row) => ({
    id: row.printing_id,
    card_id: row.card_id,
    document: printingData(JSON.parse(row.document_json) as unknown),
  }));
  const data = selected.slice(0, limit).map(({ document }) => absoluteDocumentLinks(document, base));
  const next = page.hasMore
    ? encodeCursor({
        route: printingRoute,
        ordering: printingOrder,
        revision: revisionId,
        filters,
        last: {
          card_id: selected[limit - 1]!.card_id,
          id: selected[limit - 1]!.id,
        },
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
          canonicalSelf(url.pathname, {
            cardId,
            game,
            rarity,
            productId,
            releaseRegion,
            limit,
            after: cursor === null ? null : encodeCursor(cursor),
          }),
        ),
      },
    },
    { headers: revisionHeaders(revisionId, etag) },
  );
}

function printingData(value: unknown): unknown {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).data !== null &&
    typeof (value as Record<string, unknown>).data === "object" &&
    !Array.isArray((value as Record<string, unknown>).data)
  ) {
    return (value as Record<string, unknown>).data;
  }
  return value;
}

function normalizedRarity(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.normalize("NFC").trim().toLocaleLowerCase();
  if (normalized.length < 1 || normalized.length > 100 || !/^[a-z0-9_-]+$/u.test(normalized)) {
    throw invalidParameter("rarity", "Printing rarity filter is invalid.");
  }
  return normalized;
}

function parseCursor(value: string | null, filters: PrintingCursor["filters"]): PrintingCursor | null {
  if (value === null) return null;
  try {
    const parsed = decodeCursor(value) as Partial<PrintingCursor>;
    if (
      parsed.route !== printingRoute ||
      parsed.ordering !== printingOrder ||
      typeof parsed.revision !== "string" ||
      JSON.stringify(parsed.filters) !== JSON.stringify(filters) ||
      parsed.last === undefined ||
      typeof parsed.last.card_id !== "string" ||
      typeof parsed.last.id !== "string"
    ) {
      throw new Error("invalid");
    }
    return {
      route: printingRoute,
      ordering: printingOrder,
      revision: parsed.revision,
      filters,
      last: { card_id: parsed.last.card_id, id: parsed.last.id },
    };
  } catch {
    throw new ReadProblem(400, "invalid_cursor", "Printing cursor is invalid.");
  }
}

function canonicalSelf(
  pathname: string,
  values: {
    cardId: string | null;
    game: string | null;
    rarity: string | null;
    productId: string | null;
    releaseRegion: string | null;
    limit: number;
    after: string | null;
  },
): string {
  return collectionSelf(pathname, {
    card_id: values.cardId,
    game: values.game,
    rarity: values.rarity,
    product_id: values.productId,
    release_region: values.releaseRegion,
    limit: values.limit,
    after: values.after,
  });
}
