import { absoluteDocumentLinks, type PublicBase, publicUrl } from "../../http/public-base";
import {
  type CatalogueStore,
  consumerContent,
  gameProfileFilterValue,
  gameProfileForGame,
  normalizeCardSearchText,
  sha256Text,
} from "../shared";
import { parseRange } from "./byte-range";
import {
  canonicalEtag,
  collectionFilter,
  collectionLimit,
  collectionParameters,
  conditionalResponse,
  decodeCursor,
  encodeCursor,
  invalidParameter,
  ReadProblem,
  revisionHeaders,
} from "./collection-endpoint";
import {
  type ComposedFilters,
  type PublicRecordSelection,
  composedCollectionStatement,
  composedDocumentStatement,
  composedFilterValueStatement,
  composedRelationsStatement,
  composedTextStatement,
  nativeRevisionStatement,
} from "./composition-read-repository";

type Revision = {
  id: string;
  selection?: PublicRecordSelection;
  published_at: string;
  content_digest: string;
  query_state: string;
  publication_operation_id: string | null;
  search_state: string;
};
export type DocumentRow = {
  entity_id?: string;
  printing_ids?: string;
  lifecycle_json?: string | null;
  position?: string;
  candidate_id: string;
  preparation_id: string;
  game_revision_id: string;
  content: string;
  sha256: string;
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

export async function hydrate(db: CatalogueStore, row: DocumentRow): Promise<Value> {
  if ((await sha256Text(row.content)) !== row.sha256)
    throw new ReadProblem(503, "catalogue_query_unavailable", "An immutable entity failed verification.");
  const envelope = JSON.parse(row.content).records[0] as {
    value: Value;
    text_parts: { path: (string | number)[]; sha256: string; chunks: number; byte_length: number }[];
  };
  if (
    new TextEncoder().encode(row.content).byteLength +
      envelope.text_parts.reduce((bytes, part) => bytes + part.byte_length, 0) >
    4_000_000
  )
    throw new ReadProblem(503, "catalogue_query_unavailable", "The requested entity exceeds its response budget.");
  for (const part of envelope.text_parts) {
    if (part.byte_length > 4_000_000)
      throw new ReadProblem(503, "catalogue_query_unavailable", "The requested entity exceeds its response budget.");
    const chunks: string[] = [];
    for (let ordinal = 0; ordinal < part.chunks; ordinal++) {
      const chunk = await composedTextStatement(db, row.candidate_id, part.sha256, ordinal).first<{
        content: string;
      }>();
      if (!chunk)
        throw new ReadProblem(503, "catalogue_query_unavailable", "An immutable text component is unavailable.");
      chunks.push(chunk.content);
    }
    let target = envelope.value;
    for (const segment of part.path.slice(0, -1)) target = target[segment] as Value;
    const text = chunks.join("");
    if (new TextEncoder().encode(text).byteLength !== part.byte_length || (await sha256Text(text)) !== part.sha256)
      throw new ReadProblem(503, "catalogue_query_unavailable", "An immutable text component failed verification.");
    target[part.path.at(-1)!] = text;
  }
  if (row.lifecycle_json) envelope.value.lifecycle = JSON.parse(row.lifecycle_json);
  return consumerContent(envelope.value) as Value;
}
async function related(db: CatalogueStore, revision: PublicRecordSelection, kind: string, field: string, id: string) {
  const records: Value[] = [];
  let after = "";
  let bytes = 0;
  for (;;) {
    const rows = (await composedRelationsStatement(db, revision, kind, field, id, after).all<DocumentRow>()).results;
    for (const row of rows) {
      const value = await hydrate(db, row);
      bytes += new TextEncoder().encode(JSON.stringify(value)).byteLength;
      if (bytes > 4_000_000)
        throw new ReadProblem(
          503,
          "catalogue_query_unavailable",
          "The requested relationships exceed their response budget.",
        );
      records.push(value);
    }
    if (rows.length < 32) break;
    after = rows.at(-1)!.entity_id!;
  }
  return records;
}
async function representation(
  db: CatalogueStore,
  revision: Revision,
  kind: string,
  row: DocumentRow,
  includeImages = true,
) {
  const value = await hydrate(db, row);
  const id = String(value.id);
  const type = kind === "cards" ? "card" : kind === "printings" ? "printing" : "product";
  const data: Value = { type, ...value, links: { self: `/v1/${kind}/${id}` } };
  if (kind === "cards")
    data.printing_ids = row.printing_ids
      ? JSON.parse(row.printing_ids)
      : (await related(db, revision.selection ?? revision.id, "printings", "card_id", id)).map((v) => v.id);
  if (kind === "printings") {
    const images = includeImages
      ? await related(db, revision.selection ?? revision.id, "printing_images", "printing_id", id)
      : [];
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
    const relationships = await related(db, revision.selection ?? revision.id, "product_relationships", "from.id", id);
    const products: Value[] = [];
    const contexts: Value[] = [];
    let targetBytes = 0;
    for (const relation of relationships) {
      const to = relation.to as { id: string };
      if (
        (relation.lifecycle as Value | undefined)?.current !== true ||
        (relation.kind !== "printing-product" && relation.kind !== "printing-distribution-context")
      )
        continue;
      const targetKind = relation.kind === "printing-product" ? "products" : "distribution_contexts";
      const target = await composedDocumentStatement(
        db,
        revision.selection ?? revision.id,
        targetKind,
        to.id,
      ).first<DocumentRow>();
      if (target) {
        const document = await hydrate(db, target);
        targetBytes += new TextEncoder().encode(JSON.stringify(document)).byteLength;
        if (targetBytes > 4_000_000)
          throw new ReadProblem(
            503,
            "catalogue_query_unavailable",
            "The requested Printing relationships exceed their response budget.",
          );
        (targetKind === "products" ? products : contexts).push(
          pickPublicFields(
            document,
            targetKind === "products" ? ["id", "official_code", "name"] : ["id", "kind", "label", "product_id"],
          ),
        );
      }
    }
    data.products = products;
    data.distribution_contexts = contexts;
  }
  if (kind === "products")
    data.releases = (await related(db, revision.selection ?? revision.id, "releases", "product_id", id)).map(
      (release) => pickPublicFields(release, ["id", "event_key", "region", "date", "status"]),
    );
  return data;
}
const publicRecordFields: Record<string, [string, string[]]> = {
  cards: ["card", ["id", "game", "official_identity", "name", "effective_rules_text", "game_data", "lifecycle"]],
  printings: [
    "printing",
    ["id", "card_id", "rarity", "printed_rules_text", "game_data", "products", "distribution_contexts", "lifecycle"],
  ],
  products: ["product", ["id", "game", "official_code", "name", "lifecycle"]],
  releases: ["release", ["id", "product_id", "event_key", "region", "date", "status"]],
  printing_images: ["printing_image", ["id", "printing_id", "role", "media_type", "width", "height", "content_sha256"]],
  distribution_contexts: ["distribution_context", ["id", "game", "kind", "label", "product_id"]],
  errata: [
    "erratum",
    ["id", "game", "target_type", "target_id", "effective_from", "official_wording", "corrected_value"],
  ],
  relationships: ["relationship", ["id", "kind", "from", "to", "relationship_value", "lifecycle"]],
  product_relationships: ["relationship", ["id", "kind", "from", "to", "relationship_value", "lifecycle"]],
  identity_corrections: ["identity_correction", ["id", "game", "entity_kind", "action", "replacement_ids"]],
  supported_games: ["supported_game", ["id", "key", "name", "supported_locales", "game_profile"]],
  game_profiles: ["game_profile", ["profile", "game", "schema"]],
};
function pickPublicFields(value: Value, fields: string[]) {
  return Object.fromEntries(fields.filter((f) => Object.hasOwn(value, f)).map((f) => [f, value[f]]));
}
/** Public exports use the same verified immutable facts as the native read model. */
export async function composedPublicRecord(
  db: CatalogueStore,
  selection: PublicRecordSelection,
  kind: string,
  row: DocumentRow,
) {
  const definition = publicRecordFields[kind];
  if (!definition)
    throw new ReadProblem(503, "catalogue_export_unavailable", "The current public record contract is unavailable.");
  const value =
    kind === "printings"
      ? await representation(
          db,
          { id: typeof selection === "string" ? selection : selection.revisionId, selection } as Revision,
          kind,
          row,
          false,
        )
      : await hydrate(db, row);
  return { type: definition[0], ...pickPublicFields(value, definition[1]) };
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
  legacy?: (revision: { id: string; published_at: string }) => Promise<Response>,
): Promise<Response | null | undefined> {
  const url = new URL(request.url);
  if (id !== undefined) collectionParameters(url, ["include", "revision"]);
  if (id === undefined)
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
  if (cursor && url.searchParams.has("revision") && url.searchParams.get("revision") !== cursor.revision_id)
    throw new ReadProblem(400, "invalid_cursor", "The revision must match the cursor's pinned composition.");
  const limit = collectionLimit(url.searchParams.get("limit"));
  const filters = { ...emptyFilters };
  for (const key of Object.keys(filters) as (keyof ComposedFilters)[]) {
    if (key !== "attributes") filters[key] = collectionFilter(url, key);
  }
  for (const field of ["game", "card_number"] as const)
    if (filters[field] !== null) {
      filters[field] = filters[field].normalize("NFC").trim();
      if (!filters[field]) throw invalidParameter(field, `${field} must contain at least one character.`);
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
  if (filters.rarity !== null) {
    filters.rarity = filters.rarity.normalize("NFC").trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,100}$/u.test(filters.rarity))
      throw invalidParameter("rarity", "rarity must be a normalized rarity value.");
  }
  const attributes: Record<string, string> = {};
  for (const name of [...url.searchParams.keys()].sort())
    if (name.startsWith("attribute.")) {
      const profile = filters.game ? gameProfileForGame(filters.game) : null;
      const value = profile ? gameProfileFilterValue(profile, name.slice(10), collectionFilter(url, name)!) : null;
      if (value === null)
        throw invalidParameter(name, "The attribute requires its Supported Game and a defined Game Profile value.");
      attributes[name.slice(10)] = value;
    }
  if (Object.keys(attributes).length) filters.attributes = attributes;
  const pinned = url.searchParams.get("revision") ?? cursor?.revision_id ?? null;
  const revision = await nativeRevisionStatement(db, pinned, false, !legacy).first<Revision>();
  if (!revision) {
    if (cursor?.contract === "card-keepr-composition-cursor@1")
      throw new ReadProblem(409, "cursor_revision_unavailable", "The cursor Catalogue Revision is unavailable.", null, {
        extensions: { links: { collection: publicUrl(base, url.pathname) } },
      });
    return undefined;
  }
  if (!revision.publication_operation_id) {
    if (legacy && revision.query_state === "available" && revision.search_state === "ready") return legacy(revision);
    return undefined;
  }
  if (revision.query_state !== "available")
    throw new ReadProblem(
      cursor ? 409 : 503,
      cursor ? "cursor_revision_unavailable" : "catalogue_query_unavailable",
      "The pinned Catalogue Revision query projection is unavailable.",
      null,
      { extensions: { links: { collection: publicUrl(base, url.pathname) } } },
    );
  if (id !== undefined) {
    collectionParameters(url, ["include", "revision"]);
    const include = url.searchParams.get("include");
    if (include !== null && !(kind === "cards" && include === "printings"))
      throw new ReadProblem(400, "invalid_parameter", "The detail include projection is invalid.");
    const row = await composedDocumentStatement(db, revision.id, kind, id).first<DocumentRow>();
    if (!row) {
      const correctionRow = await composedDocumentStatement(
        db,
        revision.id,
        "identity_corrections",
        id,
      ).first<DocumentRow>();
      if (!correctionRow) return null;
      const correction = await hydrate(db, correctionRow);
      if (correction.entity_kind !== (kind === "cards" ? "card" : "printing")) return null;
      const replacements = (correction.replacement_ids as string[]).map((replacement) =>
        publicUrl(base, `/v1/${kind}/${replacement}`),
      );
      return jsonResponse(request, revision, {
        data: {
          type: "identity_correction",
          ...correction,
          links: correction.action === "merge" ? { survivor: replacements[0] } : { replacements },
        },
        meta: { catalogue_revision_id: revision.id, published_at: revision.published_at },
        links: { self: publicUrl(base, url.pathname) },
      });
    }
    const data = await representation(db, revision, kind, row);
    const included: unknown[] = [];
    let bytes = new TextEncoder().encode(JSON.stringify(data)).byteLength;
    if (include === "printings")
      for (const printing of data.printing_ids as string[]) {
        const row = await composedDocumentStatement(db, revision.id, "printings", printing).first<DocumentRow>();
        if (!row) throw new ReadProblem(503, "catalogue_query_unavailable", "A pinned Printing is unavailable.");
        const value = absoluteDocumentLinks(await representation(db, revision, "printings", row), base);
        bytes += new TextEncoder().encode(JSON.stringify(value)).byteLength;
        if (bytes > 4_000_000)
          throw new ReadProblem(
            503,
            "catalogue_query_unavailable",
            "The included Printings exceed their response budget.",
          );
        included.push(value);
      }
    return jsonResponse(request, revision, {
      data: absoluteDocumentLinks(data, base),
      ...(include === "printings" ? { included } : {}),
      meta: { catalogue_revision_id: revision.id, published_at: revision.published_at },
      links: { self: publicUrl(base, url.pathname + url.search) },
    });
  }
  if (kind === "cards" && filters.q !== null && revision.search_state !== "ready")
    throw new ReadProblem(
      503,
      "catalogue_query_unavailable",
      "The pinned Card search projection is temporarily unavailable.",
    );
  for (const [field, value] of Object.entries({
    product_id: filters.product_id,
    rarity: filters.rarity,
    ...Object.fromEntries(
      Object.entries(filters.attributes ?? {}).map(([name, value]) => [`attribute.${name}`, value]),
    ),
  })) {
    if (value !== null && !(await composedFilterValueStatement(db, revision.id, field, value, filters.game).first()))
      throw invalidParameter(field, "This value is not present in the pinned catalogue revision.");
  }
  const fingerprint = JSON.stringify({ kind, filters });
  if (cursor) {
    let position: unknown;
    try {
      position = JSON.parse(cursor.after ?? "");
    } catch {
      throw new ReadProblem(400, "invalid_cursor", "The cursor position is invalid.");
    }
    if (!Array.isArray(position) || position.length !== 6 || position.some((value) => typeof value !== "string"))
      throw new ReadProblem(400, "invalid_cursor", "The cursor position is invalid.");
  }
  const canonical = new URLSearchParams({ limit: String(limit) });
  for (const [key, value] of Object.entries(filters))
    if (key !== "attributes" && value !== null) canonical.set(key, String(value));
  for (const name of Object.keys(attributes))
    canonical.set(`attribute.${name}`, url.searchParams.get(`attribute.${name}`)!);
  if (pinned) canonical.set("revision", pinned);
  if (raw) canonical.set("after", raw);
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
          after: selected.at(-1)!.position,
          filters: fingerprint,
          limit,
        })
      : null;
  return jsonResponse(request, revision, {
    data,
    meta: { catalogue_revision_id: revision.id, published_at: revision.published_at },
    page: { limit, next_cursor: next },
    links: { self: publicUrl(base, `${url.pathname}?${canonical.toString()}`) },
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
  const revision = await nativeRevisionStatement(db, url.searchParams.get("revision"), false).first<Revision>();
  if (!revision) return undefined;
  if (revision.query_state !== "available")
    throw new ReadProblem(
      503,
      "catalogue_query_unavailable",
      "The pinned Catalogue Revision query projection is unavailable.",
    );
  const row = await composedDocumentStatement(db, revision.id, "printing_images", id).first<DocumentRow>();
  if (!row) return null;
  const value = await hydrate(db, row);
  const etag = `"${value.content_sha256}"`;
  const size = Number(value.content_byte_length);
  const headers = new Headers({
    ...revisionHeaders(revision.id, etag),
    "accept-ranges": "bytes",
    "content-type": String(value.media_type),
    "cache-control": "private, max-age=31536000, immutable",
  });
  const isHead = request.method === "HEAD";
  const conditional = isHead ? null : conditionalResponse(request, Object.fromEntries(headers));
  if (conditional) return conditional;
  const range = isHead ? null : parseRange(request.headers.get("range"), size);
  if (range === "unsatisfiable")
    throw new ReadProblem(
      416,
      "range_not_satisfiable",
      "The requested Printing Image byte range is not satisfiable.",
      null,
      {
        headers: {
          "accept-ranges": "bytes",
          "content-range": `bytes */${size}`,
          etag,
          "x-catalogue-revision": revision.id,
        },
      },
    );
  const object = isHead
    ? await bucket.head(String(value.object_key))
    : await bucket.get(String(value.object_key), range === null ? {} : { range });
  if (!object || object.size !== size)
    throw new ReadProblem(503, "printing_image_unavailable", "The immutable image is unavailable.");
  headers.set("content-length", String(range === null ? size : range.length));
  if (range !== null) headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`);
  return new Response(isHead ? null : (object as R2ObjectBody).body, { status: range === null ? 200 : 206, headers });
}
