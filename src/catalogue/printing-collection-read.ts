import { ifNoneMatch } from "../http/conditional";
import {
  absoluteDocumentLinks,
  publicUrl,
  type PublicBase,
} from "../http/public-base";

const printingRoute = "/v1/printings";
const printingOrder = "card-id,printing-id";
const supportedGames = new Set([
  "one-piece",
  "fusion-world",
  "digimon",
  "gundam",
]);
const releaseRegions = new Set([
  "EN-OCEANIA",
  "EN-ASIA",
  "EN-US",
  "unknown",
]);

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

export class PrintingCollectionReadProblem extends Error {
  constructor(
    readonly status: 400 | 409,
    readonly code:
      | "invalid_parameter"
      | "invalid_cursor"
      | "cursor_revision_unavailable",
    message: string,
    readonly invalidParameter: Readonly<{
      name: string;
      reason: string;
    }> | null = null,
  ) {
    super(message);
  }
}

export async function currentPrintingsResponse(
  database: D1Database,
  request: Request,
  base: PublicBase,
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
  const cardId = optionalSingle(url, "card_id");
  const game = optionalSingle(url, "game");
  const rarity = normalizedRarity(optionalSingle(url, "rarity"));
  const productId = optionalSingle(url, "product_id");
  const releaseRegion = optionalSingle(url, "release_region");
  if (game !== null && !supportedGames.has(game)) {
    throw invalidParameter("game", "Printing Supported Game is invalid.");
  }
  if (releaseRegion !== null && !releaseRegions.has(releaseRegion)) {
    throw invalidParameter(
      "release_region",
      "Printing Release region is invalid.",
    );
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
    throw new PrintingCollectionReadProblem(
      409,
      "cursor_revision_unavailable",
      "The Printing cursor Catalogue Revision is unavailable.",
    );
  }

  const after = cursor?.last ?? null;
  const etag = quotedEtag(
    `printings:${revisionId}:${JSON.stringify({
      route: printingRoute,
      ordering: printingOrder,
      filters,
      after,
    })}`,
  );
  if (ifNoneMatch(request, etag)) {
    return notModified(etag, revisionId);
  }

  const rows = await database
    .prepare(
      `SELECT printing.printing_id, printing.card_id,
              printing.document_json
       FROM revision_printings AS printing
       JOIN revision_cards AS card
         ON card.catalogue_revision_id = printing.catalogue_revision_id
        AND card.card_id = printing.card_id
       WHERE printing.catalogue_revision_id = ?
         AND (? IS NULL OR printing.card_id = ?)
         AND (
           ? IS NULL OR
           json_extract(card.document_json, '$.game') = ?
         )
         AND (
           ? IS NULL OR
           coalesce(
             json_extract(
               printing.document_json, '$.data.rarity.normalized'
             ),
             json_extract(
               printing.document_json, '$.rarity.normalized'
             )
           ) = ?
         )
         AND (
           ? = 0 OR
           (printing.card_id, printing.printing_id) > (?, ?)
         )
         AND (
           (? IS NULL AND ? IS NULL)
           OR EXISTS (
             SELECT 1
             FROM revision_product_relationships AS relationship
             JOIN revision_products AS product
               ON product.catalogue_revision_id =
                    relationship.catalogue_revision_id
              AND product.product_id =
                    json_extract(relationship.document_json, '$.to.id')
             WHERE relationship.catalogue_revision_id =
                     printing.catalogue_revision_id
               AND json_extract(
                     relationship.document_json, '$.kind'
                   ) = 'printing-product'
               AND json_extract(
                     relationship.document_json, '$.from.id'
                   ) = printing.printing_id
               AND coalesce(
                     json_extract(
                       relationship.document_json, '$.lifecycle.current'
                     ),
                     1
                   ) = 1
               AND (
                 ? IS NULL OR product.product_id = ?
               )
               AND (
                 ? IS NULL OR EXISTS (
                   SELECT 1 FROM json_each(product.release_regions_json)
                   WHERE value = ?
                 )
               )
           )
         )
       ORDER BY printing.card_id, printing.printing_id
       LIMIT ?`,
    )
    .bind(
      revisionId,
      cardId,
      cardId,
      game,
      game,
      rarity,
      rarity,
      after === null ? 0 : 1,
      after?.card_id ?? "",
      after?.id ?? "",
      productId,
      releaseRegion,
      productId,
      productId,
      releaseRegion,
      releaseRegion,
      limit + 1,
    )
    .all<{
      printing_id: string;
      card_id: string;
      document_json: string;
    }>();
  const selected = rows.results.map((row) => ({
    id: row.printing_id,
    card_id: row.card_id,
    document: printingData(JSON.parse(row.document_json) as unknown),
  }));
  const data = selected
    .slice(0, limit)
    .map(({ document }) => absoluteDocumentLinks(document, base));
  const next =
    selected.length > limit
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
            after: url.searchParams.get("after"),
          }),
        ),
      },
    },
    { headers: printingHeaders(revisionId, etag) },
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

function parseLimit(value: string | null): number {
  if (value === null) return 50;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw invalidParameter("limit", "Printing page limit is invalid.");
  }
  return parsed;
}

function optionalSingle(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  if (values.length === 0) return null;
  const value = values[0]!;
  if (values.length !== 1 || value.length < 1 || value.length > 500) {
    throw invalidParameter(name, `Printing ${name} filter is invalid.`);
  }
  return value;
}

function normalizedRarity(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.normalize("NFC").trim().toLocaleLowerCase();
  if (
    normalized.length < 1 ||
    normalized.length > 100 ||
    !/^[a-z0-9_-]+$/u.test(normalized)
  ) {
    throw invalidParameter("rarity", "Printing rarity filter is invalid.");
  }
  return normalized;
}

function parseCursor(
  value: string | null,
  filters: PrintingCursor["filters"],
): PrintingCursor | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(decodeBase64Url(value)) as Partial<PrintingCursor>;
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
    return parsed as PrintingCursor;
  } catch {
    throw new PrintingCollectionReadProblem(
      400,
      "invalid_cursor",
      "Printing cursor is invalid.",
    );
  }
}

function encodeCursor(value: PrintingCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): string {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4),
    "=",
  );
  return new TextDecoder().decode(
    Uint8Array.from(atob(padded), (character) =>
      character.charCodeAt(0),
    ),
  );
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
  const query = new URLSearchParams();
  if (values.cardId !== null) query.set("card_id", values.cardId);
  if (values.game !== null) query.set("game", values.game);
  if (values.rarity !== null) query.set("rarity", values.rarity);
  if (values.productId !== null) query.set("product_id", values.productId);
  if (values.releaseRegion !== null) {
    query.set("release_region", values.releaseRegion);
  }
  if (values.limit !== 50) query.set("limit", String(values.limit));
  if (values.after !== null) query.set("after", values.after);
  const serialized = query.toString();
  return serialized.length === 0 ? pathname : `${pathname}?${serialized}`;
}

function invalidParameter(
  name: string,
  message: string,
): PrintingCollectionReadProblem {
  return new PrintingCollectionReadProblem(
    400,
    "invalid_parameter",
    message,
    { name, reason: message },
  );
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
    headers: printingHeaders(revisionId, etag),
  });
}

function printingHeaders(revisionId: string, etag: string): HeadersInit {
  return {
    "cache-control": "private, no-cache",
    etag,
    "x-catalogue-revision": revisionId,
  };
}
