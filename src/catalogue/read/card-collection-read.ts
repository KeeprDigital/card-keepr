import { absoluteDocumentLinks, type PublicBase, publicUrl } from "../../http/public-base";
import { type CatalogueStore, canonicalJson, gameProfileFilterValue, gameProfileForGame } from "../shared";
import {
  type CardRow,
  type CollectionFilters,
  cardCollectionPageStatement,
  cardPublishedFilterStatements,
} from "./card-collection-repository";
import { cardSearchQuery } from "./card-search";
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

const maximumCollectionResponseBytes = 4 * 1024 * 1024;
const collectionEnvelopeAllowanceBytes = 32 * 1024;
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

export async function cardCollectionResponse(
  database: CatalogueStore,
  request: Request,
  base: PublicBase,
): Promise<Response> {
  const url = new URL(request.url);
  const filters = parseFilters(url);
  const cursor = parseCursor(url.searchParams.get("after"), filters);
  if (cursor === "invalid") throw invalidCursor();
  const revision = await pinRevision(database, cursor?.revision_id ?? null, "/v1/cards", base, { search: true });
  await validatePublishedFilters(database, revision.id, filters);
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
  const serializedRows = queried.rows.map((row) =>
    JSON.stringify(absoluteDocumentLinks(JSON.parse(row.summary_json), base)),
  );
  let count = serializedRows.length;
  let dataBytes =
    serializedRows.reduce((total, row) => total + encoder.encode(row).byteLength, 0) + Math.max(0, count - 1);
  while (true) {
    const nextCursor =
      (queried.hasMore || count < queried.rows.length) && count > 0
        ? encodeCursor({
            contract: "card-keepr-card-cursor@1",
            route: "/v1/cards",
            order: cardCollectionOrder,
            revision_id: revision.id,
            filters,
            after: rowCursor(queried.rows[count - 1]!),
          })
        : null;
    // Only the small envelope changes while trimming. Each Card is parsed,
    // link-expanded, and serialized once, even when link expansion exceeds
    // the allowance used by the database byte window.
    const envelope = JSON.stringify({
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
            product_id: filters.productId,
            rarity: filters.rarity,
            ...Object.fromEntries(
              Object.entries(filters.attributes).map(([name, value]) => [
                `attribute.${name}`,
                attributeQueryValue(value),
              ]),
            ),
            limit: filters.limit,
            after: cursor === null ? null : encodeCursor(cursor),
          }),
        ),
      },
    });
    const suffix = `],${envelope.slice(1)}`;
    if (dataBytes + encoder.encode(`{"data":[${suffix}`).byteLength <= maximumCollectionResponseBytes) {
      return new Response(`{"data":[${serializedRows.slice(0, count).join(",")}${suffix}`, {
        headers: {
          ...headers,
          "content-type": "application/json",
        },
      });
    }
    if (count <= 1) {
      throw new ReadProblem(503, "catalogue_query_unavailable", "The Card page exceeds its response budget.");
    }
    count -= 1;
    dataBytes -= encoder.encode(serializedRows[count]!).byteLength + 1;
  }
}

async function queryCardPage(
  database: CatalogueStore,
  revisionId: string,
  filters: CollectionFilters,
  after: CardCursor["after"] | null,
): Promise<{ rows: CardRow[]; hasMore: boolean }> {
  // First select only keys and byte lengths. The window bounds the documents
  // crossing D1's binding without fetching every candidate into Worker memory.

  const result = await cardCollectionPageStatement(
    database,
    revisionId,
    filters,
    after,
    maximumCollectionResponseBytes - collectionEnvelopeAllowanceBytes,
  ).all<Omit<CardRow, "summary_json"> & { summary_json: string | null }>();
  const rows: CardRow[] = [];
  for (const row of result.results) {
    if (row.summary_json === null) return { rows, hasMore: true };
    rows.push({ ...row, summary_json: row.summary_json });
  }
  return { rows, hasMore: false };
}

function parseFilters(url: URL): CollectionFilters {
  collectionParameters(url, [
    "q",
    "game",
    "card_number",
    "product_id",
    "rarity",
    "limit",
    "after",
    ...[...url.searchParams.keys()].filter((name) => name.startsWith("attribute.")),
  ]);
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
  const productId = collectionFilter(url, "product_id");
  const rarity = collectionFilter(url, "rarity")?.normalize("NFC").trim().toLowerCase() ?? null;
  if (rarity !== null && !/^[a-z0-9_-]{1,100}$/u.test(rarity))
    throw invalidParameter("rarity", "rarity must be a normalized rarity value.");
  const attributes: Record<string, string> = {};
  for (const name of [...url.searchParams.keys()].filter((name) => name.startsWith("attribute.")).sort()) {
    if (game === null) throw invalidParameter(name, "Game Profile attribute filters require game.");
    const path = name.slice("attribute.".length);
    const raw = collectionFilter(url, name)!;
    const profile = gameProfileForGame(game)!;
    const value = gameProfileFilterValue(profile, path, raw);
    if (value === null) throw invalidParameter(name, `${name} or its value is not defined by ${profile}.`);
    attributes[path] = value;
  }
  return { q, game, cardNumber, productId, rarity, attributes, limit };
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

async function validatePublishedFilters(
  database: CatalogueStore,
  revisionId: string,
  filters: CollectionFilters,
): Promise<void> {
  const checks = cardPublishedFilterStatements(database, revisionId, filters);
  if (checks.length === 0) return;
  const results = await database.batch(checks.map(({ statement }) => statement));
  for (const [index, check] of checks.entries()) {
    if (results[index]!.results.length === 0)
      throw invalidParameter(check.parameter, `${check.parameter} is not known in the pinned Catalogue Revision.`);
  }
}

function attributeQueryValue(value: string): string {
  const parsed: unknown = JSON.parse(value);
  return typeof parsed === "string" ? parsed : String(parsed);
}
