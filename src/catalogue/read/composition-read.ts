import { type PublicBase, publicUrl, absoluteDocumentLinks } from "../../http/public-base";
import {
  type CatalogueStore,
  consumerContent,
  normalizeCardSearchText,
  gameProfileFilterValue,
  gameProfileForGame,
} from "../shared";
import {
  canonicalEtag,
  conditionalResponse,
  revisionHeaders,
  ReadProblem,
  collectionLimit,
  collectionFilter,
  collectionParameters,
  invalidParameter,
  encodeCursor,
  decodeCursor,
} from "./collection-endpoint";
import {
  nativeRevisionStatement,
  composedDocumentStatement,
  composedTextStatement,
  composedCollectionStatement,
  composedRelationsStatement,
  type ComposedFilters,
} from "./composition-read-repository";

type Revision = { id: string; published_at: string; content_digest: string };
export type DocumentRow = {
  entity_id?: string;
  candidate_id: string;
  preparation_id: string;
  game_revision_id: string;
  content: string;
};
type Value = Record<string, unknown>;
const emptyFilters: ComposedFilters = {
  game: null,
  q: null,
  card_id: null,
  card_number: null,
  rarity: null,
  product_id: null,
  release_region: null,
};

async function hydrate(db: CatalogueStore, row: DocumentRow): Promise<Value> {
  const envelope = JSON.parse(row.content).records[0] as {
    value: Value;
    text_parts: { path: (string | number)[]; sha256: string; chunks: number; byte_length: number }[];
  };
  for (const part of envelope.text_parts) {
    if (part.byte_length > 4_000_000)
      throw new ReadProblem(503, "catalogue_query_unavailable", "The requested entity exceeds its response budget.");
    const chunks: string[] = [];
    for (let ordinal = 0; ordinal < part.chunks; ordinal++) {
      const chunk = await composedTextStatement(db, row.preparation_id, part.sha256, ordinal).first<{
        content: string;
      }>();
      if (!chunk)
        throw new ReadProblem(503, "catalogue_query_unavailable", "An immutable text component is unavailable.");
      chunks.push(chunk.content);
    }
    let target = envelope.value;
    for (const segment of part.path.slice(0, -1)) target = target[segment] as Value;
    target[part.path.at(-1)!] = chunks.join("");
  }
  return consumerContent(envelope.value) as Value;
}
async function related(db: CatalogueStore, revision: string, kind: string, field: string, id: string) {
  const records: Value[] = [];
  let after = "";
  let bytes = 0;
  for (;;) {
    const rows = (await composedRelationsStatement(db, revision, kind, field, id, after).all<DocumentRow>()).results;
    for (const row of rows) {
      bytes += new TextEncoder().encode(row.content).byteLength;
      if (bytes > 4_000_000)
        throw new ReadProblem(
          503,
          "catalogue_query_unavailable",
          "The requested relationships exceed their response budget.",
        );
      records.push(await hydrate(db, row));
    }
    if (rows.length < 32) break;
    after = rows.at(-1)!.entity_id!;
  }
  return records;
}
async function representation(db: CatalogueStore, revision: Revision, kind: string, row: DocumentRow) {
  const value = await hydrate(db, row);
  const id = String(value.id);
  const type = kind === "cards" ? "card" : kind === "printings" ? "printing" : "product";
  const data: Value = { type, ...value, links: { self: `/v1/${kind}/${id}` } };
  if (kind === "cards")
    data.printing_ids = (await related(db, revision.id, "printings", "card_id", id)).map((v) => v.id);
  if (kind === "printings") {
    const images = await related(db, revision.id, "printing_images", "printing_id", id);
    data.printing_images = images.map((image) => ({
      id: image.id,
      role: image.role,
      media_type: image.media_type,
      width: image.width,
      height: image.height,
      content_sha256: image.content_sha256,
      content_byte_length: image.content_byte_length,
      links: { content: `/v1/printing-images/${image.id}/content?revision=${revision.id}` },
    }));
    const relationships = await related(db, revision.id, "product_relationships", "from.id", id);
    const products: Value[] = [];
    const contexts: Value[] = [];
    for (const relation of relationships) {
      const to = relation.to as { id: string };
      if (relation.kind !== "printing-product" && relation.kind !== "printing-distribution-context") continue;
      const targetKind = relation.kind === "printing-product" ? "products" : "distribution_contexts";
      const target = await composedDocumentStatement(db, revision.id, targetKind, to.id).first<DocumentRow>();
      if (target) (targetKind === "products" ? products : contexts).push(await hydrate(db, target));
    }
    data.products = products;
    data.distribution_contexts = contexts;
  }
  if (kind === "products") data.releases = await related(db, revision.id, "releases", "product_id", id);
  return data;
}
async function jsonResponse(request: Request, revision: Revision, document: unknown) {
  const headers = revisionHeaders(revision.id, await canonicalEtag(document));
  return conditionalResponse(request, headers) ?? Response.json(document, { headers });
}

/** Same authenticated catalogue routes, selected by persisted revision authority. */
export async function compositionEntityResponse(
  db: CatalogueStore,
  request: Request,
  base: PublicBase,
  kind: string,
  id?: string,
): Promise<Response | null | undefined> {
  const url = new URL(request.url);
  const raw = url.searchParams.get("after");
  const cursor = raw
    ? (decodeCursor(raw) as {
        contract?: string;
        revision_id?: string;
        after?: string;
        filters?: string;
        limit?: number;
      })
    : null;
  if (cursor && cursor.contract !== "card-keepr-composition-cursor@1") return undefined;
  const pinned = url.searchParams.get("revision") ?? cursor?.revision_id ?? null;
  const revision = await nativeRevisionStatement(db, pinned).first<Revision>();
  if (!revision) {
    if (cursor?.contract === "card-keepr-composition-cursor@1")
      throw new ReadProblem(409, "cursor_revision_unavailable", "The cursor Catalogue Revision is unavailable.");
    return undefined;
  }
  if (id !== undefined) {
    collectionParameters(url, ["include", "revision"]);
    const include = url.searchParams.get("include");
    if (include !== null && !(kind === "cards" && include === "printings"))
      throw new ReadProblem(400, "invalid_parameter", "The detail include projection is invalid.");
    const row = await composedDocumentStatement(db, revision.id, kind, id).first<DocumentRow>();
    if (!row) return null;
    const data = await representation(db, revision, kind, row);
    return jsonResponse(request, revision, {
      data: absoluteDocumentLinks(data, base),
      ...(include === "printings"
        ? {
            included: await Promise.all(
              (data.printing_ids as string[]).map(async (printing) => {
                const value = await composedDocumentStatement(
                  db,
                  revision.id,
                  "printings",
                  printing,
                ).first<DocumentRow>();
                return absoluteDocumentLinks(await representation(db, revision, "printings", value!), base);
              }),
            ),
          }
        : {}),
      meta: { catalogue_revision_id: revision.id, published_at: revision.published_at },
      links: { self: publicUrl(base, url.pathname + url.search) },
    });
  }
  collectionParameters(url, [
    "limit",
    "after",
    "game",
    "q",
    "card_id",
    "card_number",
    "rarity",
    "product_id",
    "release_region",
    "revision",
    ...Array.from(url.searchParams.keys()).filter((k) => kind === "cards" && k.startsWith("attribute.")),
  ]);
  const limit = collectionLimit(url.searchParams.get("limit"));
  const filters = { ...emptyFilters };
  for (const key of Object.keys(filters) as (keyof ComposedFilters)[]) {
    if (key !== "attributes") filters[key] = collectionFilter(url, key);
  }
  if (filters.game !== null && !["one-piece", "fusion-world", "digimon", "gundam"].includes(filters.game))
    throw invalidParameter("game", "game is not a Supported Game.");
  if (
    filters.release_region !== null &&
    !["EN-OCEANIA", "EN-ASIA", "EN-US", "unknown"].includes(filters.release_region)
  )
    throw invalidParameter("release_region", "Release region is invalid.");
  if (filters.q !== null) {
    filters.q = normalizeCardSearchText(filters.q);
    if (!filters.q) throw invalidParameter("q", "q must contain at least one character.");
  }
  const attributes: Record<string, string> = {};
  for (const name of url.searchParams.keys())
    if (name.startsWith("attribute.")) {
      const profile = filters.game ? gameProfileForGame(filters.game) : null;
      const value = profile ? gameProfileFilterValue(profile, name.slice(10), collectionFilter(url, name)!) : null;
      if (value === null)
        throw invalidParameter(name, "The attribute requires its Supported Game and a defined Game Profile value.");
      attributes[name.slice(10)] = value;
    }
  if (Object.keys(attributes).length) filters.attributes = attributes;
  const fingerprint = JSON.stringify({ kind, filters });
  if (cursor && (cursor.filters !== fingerprint || cursor.limit !== limit || typeof cursor.after !== "string"))
    throw new ReadProblem(400, "invalid_cursor", "The cursor does not match these filters.");
  const rows = (
    await composedCollectionStatement(db, revision.id, kind, cursor?.after ?? "", limit + 1, filters).all<DocumentRow>()
  ).results;
  const selected: DocumentRow[] = [];
  const data: unknown[] = [];
  let bytes = 0;
  for (const row of rows.slice(0, limit)) {
    if (row.content === null) break;
    const value = absoluteDocumentLinks(await representation(db, revision, kind, row), base);
    const size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (bytes + size > 4_000_000) break;
    selected.push(row);
    data.push(value);
    bytes += size;
  }
  if (rows.length && !selected.length)
    throw new ReadProblem(503, "catalogue_query_unavailable", "One record exceeds its response budget.");
  const next =
    rows.length > selected.length
      ? encodeCursor({
          contract: "card-keepr-composition-cursor@1",
          revision_id: revision.id,
          after: selected.at(-1)!.entity_id,
          filters: fingerprint,
          limit,
        })
      : null;
  return jsonResponse(request, revision, {
    data,
    meta: { catalogue_revision_id: revision.id, published_at: revision.published_at },
    page: { limit, next_cursor: next },
    links: { self: publicUrl(base, url.pathname + url.search) },
  });
}

export async function compositionImageResponse(
  db: CatalogueStore,
  bucket: R2Bucket,
  request: Request,
  id: string,
): Promise<Response | null | undefined> {
  const url = new URL(request.url);
  collectionParameters(url, ["revision"]);
  const revision = await nativeRevisionStatement(db, url.searchParams.get("revision")).first<Revision>();
  if (!revision) return undefined;
  const row = await composedDocumentStatement(db, revision.id, "printing_images", id).first<DocumentRow>();
  if (!row) return null;
  const value = await hydrate(db, row);
  const headers = {
    ...revisionHeaders(revision.id, `"${value.content_sha256}"`),
    "content-type": String(value.media_type),
    "content-length": String(value.content_byte_length),
  };
  const conditional = conditionalResponse(request, headers);
  if (conditional) return conditional;
  if (request.method === "HEAD") return new Response(null, { headers });
  const object = await bucket.get(String(value.object_key));
  if (!object || object.size !== value.content_byte_length)
    throw new ReadProblem(503, "printing_image_unavailable", "The immutable image is unavailable.");
  return new Response(object.body, { headers });
}
