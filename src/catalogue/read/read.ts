import { parseCatalogueRevisionId, parsePublicationInstant } from "../../http/catalogue";
import { ifNoneMatchMatches as ifNoneMatch } from "../../http/conditional-request";
import { absoluteDocumentLinks, type PublicBase, publicUrl } from "../../http/public-base";
import { canonicalJson, sha256Text } from "../shared";
import {
  canonicalEtag,
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
} from "./collection-endpoint";
import { canonicalDetailSelf, detailIncludeProjection, detailRepresentationKey } from "./detail-representation";
import { type SourceFreshnessStorageRow, sourceFreshnessFromStorage } from "./source-freshness";

type CatalogueStateRow = {
  current_revision_id: string;
  published_at: string;
};

type RevisionDocumentRow = CatalogueStateRow & {
  document_json: string;
};

type DetailEnvelope = {
  data: unknown;
  included: unknown[];
  provenance: Record<string, string[]>;
  disagreements: unknown[];
};

type PrintingDocumentRow = {
  document_json: string;
};

type PrintingImageRow = {
  media_type: string;
  content_sha256: string;
  content_byte_length: number;
  object_key: string;
  current_revision_id: string;
};

type ExportRow = {
  catalogue_revision_id: string;
  published_at: string;
  manifest_key: string;
  manifest_digest: string;
  maintenance_state: "available" | "deleting" | "deleted";
};

type ExportManifest = {
  export_schema_major: number;
  catalogue_revision: {
    id: string;
    content_sha256: string;
  };
  manifest_sha256: string;
  components: readonly {
    name: string;
    compressed_sha256: string;
    compressed_bytes: number;
  }[];
};

export async function catalogueExportsResponse(
  request: Request,
  database: D1Database,
  bucket: R2Bucket,
  base: PublicBase,
): Promise<Response> {
  const url = new URL(request.url);
  assertCatalogueExportCollectionParameters(url);
  const limit = collectionLimit(url.searchParams.get("limit"));
  const cursor = decodeCatalogueExportCursor(url.searchParams.get("after"));
  if (cursor !== null && cursor.limit !== limit) {
    throw new ReadProblem(400, "invalid_cursor", "The Catalogue Export cursor does not match the requested limit.");
  }
  const revision = await pinRevision(database, cursor?.revision_id ?? null, "/v1/catalogue-exports", base, {
    projection: false,
  });
  const revisionId = revision.id;
  const page = await collectionPage<ExportRow>(
    database
      .prepare(
        `WITH RECURSIVE pinned_revision(id) AS (
         SELECT ?
         UNION ALL
         SELECT revision.expected_previous_revision_id
         FROM catalogue_revisions AS revision
         JOIN pinned_revision ON revision.id = pinned_revision.id
       )
       SELECT export.catalogue_revision_id, revision.published_at,
              export.manifest_key, export.manifest_digest,
              export.maintenance_state
       FROM catalogue_exports AS export
       JOIN catalogue_revisions AS revision
         ON revision.id = export.catalogue_revision_id
       JOIN pinned_revision AS pinned
         ON pinned.id = export.catalogue_revision_id
       WHERE export.verified = 1
         AND export.maintenance_state = 'available'
         AND (
           ? IS NULL OR revision.published_at < ? OR (
             revision.published_at = ? AND
             export.catalogue_revision_id < ?
           )
         )
       ORDER BY revision.published_at DESC,
                export.catalogue_revision_id DESC
       LIMIT ?`,
      )
      .bind(
        revisionId,
        cursor?.after.published_at ?? null,
        cursor?.after.published_at ?? "",
        cursor?.after.published_at ?? "",
        cursor?.after.catalogue_revision_id ?? "",
        limit + 1,
      ),
    limit,
  );
  const selected = page.rows;
  const data = await Promise.all(
    selected.map(async (exportRow) => {
      const verified = await loadVerifiedExportManifest(database, bucket, exportRow.catalogue_revision_id);
      if (verified === null) {
        throw new Error("Verified Catalogue Export is unavailable");
      }
      return {
        type: "catalogue_export",
        catalogue_revision_id: exportRow.catalogue_revision_id,
        export_schema_major: verified.manifest.export_schema_major,
        published_at: exportRow.published_at,
        manifest_sha256: exportRow.manifest_digest,
        links: {
          self: publicUrl(base, `/v1/catalogue-exports/${encodeURIComponent(exportRow.catalogue_revision_id)}`),
        },
      };
    }),
  );
  const next = page.hasMore
    ? encodeCursor({
        contract: "card-keepr-catalogue-export-cursor@1",
        route: "/v1/catalogue-exports",
        order: "published_at:desc,catalogue_revision_id:desc",
        revision_id: revisionId,
        limit,
        after: {
          published_at: selected.at(-1)!.published_at,
          catalogue_revision_id: selected.at(-1)!.catalogue_revision_id,
        },
      })
    : null;
  const document = {
    data,
    meta: {
      catalogue_revision_id: revisionId,
      published_at: revision.published_at,
    },
    page: { limit, next_cursor: next },
    links: { self: publicUrl(base, collectionSelf(url.pathname, { limit, after: url.searchParams.get("after") })) },
  };
  const etag = await canonicalEtag(document);
  const headers = revisionHeaders(revisionId, etag);
  const conditional = conditionalResponse(request, headers);
  if (conditional !== null) return conditional;
  return Response.json(document, { headers });
}

type CatalogueExportCursor = {
  contract: "card-keepr-catalogue-export-cursor@1";
  route: "/v1/catalogue-exports";
  order: "published_at:desc,catalogue_revision_id:desc";
  revision_id: string;
  limit: number;
  after: {
    published_at: string;
    catalogue_revision_id: string;
  };
};

function decodeCatalogueExportCursor(value: string | null): CatalogueExportCursor | null {
  if (value === null) return null;
  try {
    const parsed = decodeCursor(value);
    if (!isCatalogueExportCursor(parsed)) throw new Error("invalid shape");
    return parsed;
  } catch {
    throw new ReadProblem(400, "invalid_cursor", "The Catalogue Export cursor is invalid.");
  }
}

function isCatalogueExportCursor(value: unknown): value is CatalogueExportCursor {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const cursor = value as Record<string, unknown>;
  const after = cursor.after;
  return (
    Object.keys(cursor).sort().join(",") === "after,contract,limit,order,revision_id,route" &&
    cursor.contract === "card-keepr-catalogue-export-cursor@1" &&
    cursor.route === "/v1/catalogue-exports" &&
    cursor.order === "published_at:desc,catalogue_revision_id:desc" &&
    typeof cursor.revision_id === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(cursor.revision_id) &&
    Number.isInteger(cursor.limit) &&
    Number(cursor.limit) >= 1 &&
    Number(cursor.limit) <= 100 &&
    after !== null &&
    typeof after === "object" &&
    !Array.isArray(after) &&
    Object.keys(after).sort().join(",") === "catalogue_revision_id,published_at" &&
    typeof (after as Record<string, unknown>).published_at === "string" &&
    !Number.isNaN(Date.parse((after as Record<string, string>).published_at!)) &&
    typeof (after as Record<string, unknown>).catalogue_revision_id === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test((after as Record<string, string>).catalogue_revision_id!)
  );
}

function assertCatalogueExportCollectionParameters(url: URL): void {
  collectionParameters(url, ["limit", "after"]);
}

export async function currentCatalogueStatus(database: D1Database) {
  const [state, freshness] = await Promise.all([
    database
      .prepare("SELECT current_revision_id, published_at FROM catalogue_state WHERE singleton = 1")
      .first<CatalogueStateRow>(),
    database
      .prepare(
        `SELECT game, area, source_lineage, region, checked_at
         FROM source_freshness
         ORDER BY game, area, source_lineage, region`,
      )
      .all<SourceFreshnessStorageRow>(),
  ]);
  if (state === null) throw new Error("Catalogue state is unavailable");
  const lastSuccessfulChecks = freshness.results.map((row) => ({
    ...sourceFreshnessFromStorage(row),
    checked_at: parsePublicationInstant(row.checked_at),
  }));
  return {
    revisionId: parseCatalogueRevisionId(state.current_revision_id),
    publishedAt: parsePublicationInstant(state.published_at),
    lastSuccessfulChecks,
    etag: await sha256Text(
      canonicalJson({
        revision_id: state.current_revision_id,
        last_successful_checks: lastSuccessfulChecks,
      }),
    ),
  };
}

export async function currentCardResponse(
  database: D1Database,
  cardId: string,
  request: Request,
  base: PublicBase,
): Promise<Response | null> {
  const row = await database
    .prepare(
      `SELECT
        card.document_json,
        catalogue.current_revision_id,
        catalogue.published_at
      FROM catalogue_state AS catalogue
      JOIN revision_cards AS card
        ON card.catalogue_revision_id = catalogue.current_revision_id
      WHERE catalogue.singleton = 1 AND card.card_id = ?`,
    )
    .bind(cardId)
    .first<RevisionDocumentRow>();
  if (row === null) return null;
  const url = new URL(request.url);
  const include = detailIncludeProjection(
    url,
    () => new ReadProblem(400, "invalid_parameter", "Card include projection is invalid."),
    ["printings", "evidence", "disagreements"],
  );
  const envelope = detailEnvelope(row.document_json);
  const etag = `"card:${cardId}:${row.current_revision_id}:` + `${detailRepresentationKey(include)}"`;
  const headers = revisionHeaders(row.current_revision_id, etag);
  if (ifNoneMatch(request, etag)) {
    return new Response(null, { status: 304, headers });
  }
  const printings = include.has("printings")
    ? await database
        .prepare(
          `SELECT document_json
           FROM revision_printings
           WHERE catalogue_revision_id = ? AND card_id = ?
           ORDER BY printing_id`,
        )
        .bind(row.current_revision_id, cardId)
        .all<PrintingDocumentRow>()
    : { results: [] as PrintingDocumentRow[] };
  return Response.json(
    {
      data: absoluteDocumentLinks(envelope.data, base),
      ...(include.has("printings") || include.has("evidence")
        ? {
            included: [
              ...printings.results.map(({ document_json }) =>
                absoluteDocumentLinks(detailEnvelope(document_json).data, base),
              ),
              ...(include.has("evidence") ? envelope.included : []),
            ],
          }
        : {}),
      ...(include.has("evidence") ? { provenance: envelope.provenance } : {}),
      ...(include.has("disagreements") ? { disagreements: envelope.disagreements } : {}),
      meta: {
        catalogue_revision_id: row.current_revision_id,
        published_at: row.published_at,
      },
      links: { self: publicUrl(base, canonicalDetailSelf(url, include)) },
    },
    { headers },
  );
}

export async function currentPrintingResponse(
  database: D1Database,
  printingId: string,
  request: Request,
  base: PublicBase,
): Promise<Response | null> {
  const row = await database
    .prepare(
      `SELECT
        printing.document_json,
        catalogue.current_revision_id,
        catalogue.published_at
      FROM catalogue_state AS catalogue
      JOIN revision_printings AS printing
        ON printing.catalogue_revision_id = catalogue.current_revision_id
      WHERE catalogue.singleton = 1 AND printing.printing_id = ?`,
    )
    .bind(printingId)
    .first<RevisionDocumentRow>();
  if (row === null) return null;
  const url = new URL(request.url);
  const include = detailIncludeProjection(
    url,
    () => new ReadProblem(400, "invalid_parameter", "Printing include projection is invalid."),
  );
  const envelope = detailEnvelope(row.document_json);
  const etag = `"printing:${printingId}:${row.current_revision_id}:` + `${detailRepresentationKey(include)}"`;
  const headers = revisionHeaders(row.current_revision_id, etag);
  if (ifNoneMatch(request, etag)) {
    return new Response(null, { status: 304, headers });
  }
  return Response.json(
    {
      data: absoluteDocumentLinks(envelope.data, base),
      ...(include.has("evidence")
        ? {
            included: envelope.included,
            provenance: envelope.provenance,
          }
        : {}),
      ...(include.has("disagreements") ? { disagreements: envelope.disagreements } : {}),
      meta: {
        catalogue_revision_id: row.current_revision_id,
        published_at: row.published_at,
      },
      links: { self: publicUrl(base, canonicalDetailSelf(url, include)) },
    },
    { headers },
  );
}

export async function printingImageContentResponse(
  request: Request,
  database: D1Database,
  bucket: R2Bucket,
  imageId: string,
): Promise<Response | null> {
  const row = await database
    .prepare(
      // The content facts come from the revision projection alone;
      // reconciled_printing_images belongs to the reconciliation cluster
      // and the api serves what the revision published (issue #98).
      `SELECT
         image.media_type,
         image.content_sha256,
         image.content_byte_length,
         image.object_key,
         catalogue.current_revision_id
       FROM catalogue_state AS catalogue
       JOIN revision_printing_images AS image
         ON image.catalogue_revision_id = catalogue.current_revision_id
       JOIN revision_printings AS printing
         ON printing.catalogue_revision_id = catalogue.current_revision_id
        AND printing.printing_id = image.printing_id
       WHERE catalogue.singleton = 1 AND image.image_id = ?`,
    )
    .bind(imageId)
    .first<PrintingImageRow>();
  if (row === null) return null;

  const etag = `"${row.content_sha256}"`;
  const baseHeaders = new Headers({
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=31536000, immutable",
    etag,
    "x-catalogue-revision": row.current_revision_id,
  });
  const isHead = request.method === "HEAD";
  if (!isHead && ifNoneMatch(request, etag)) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }
  const range = isHead ? null : parseRange(request.headers.get("range"), row.content_byte_length);
  if (range === "unsatisfiable") {
    throw new ReadProblem(
      416,
      "range_not_satisfiable",
      "The requested Printing Image byte range is not satisfiable.",
      null,
      {
        headers: {
          "accept-ranges": "bytes",
          "content-range": `bytes */${row.content_byte_length}`,
          etag,
          "x-catalogue-revision": row.current_revision_id,
        },
      },
    );
  }
  const object = isHead
    ? await bucket.head(row.object_key)
    : await bucket.get(row.object_key, range === null ? {} : { range });
  if (object === null || object.size !== row.content_byte_length) {
    throw new Error("Published Printing Image content is unavailable.");
  }
  const responseLength = range === null ? row.content_byte_length : range.length;
  baseHeaders.set("content-length", String(responseLength));
  baseHeaders.set("content-type", row.media_type);
  if (range !== null) {
    baseHeaders.set(
      "content-range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${row.content_byte_length}`,
    );
  }
  return new Response(isHead ? null : (object as R2ObjectBody).body, {
    status: range === null ? 200 : 206,
    headers: baseHeaders,
  });
}

function detailEnvelope(documentJson: string): DetailEnvelope {
  const parsed: unknown = JSON.parse(documentJson);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("A revision-pinned detail document is invalid.");
  }
  const value = parsed as Record<string, unknown>;
  const data = value.data !== null && typeof value.data === "object" && !Array.isArray(value.data) ? value.data : value;
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

export async function catalogueExportResponse(
  request: Request,
  database: D1Database,
  bucket: R2Bucket,
  revisionId: string,
  base: PublicBase,
): Promise<Response | null> {
  const verifiedExport = await loadVerifiedExportManifest(database, bucket, revisionId);
  if (verifiedExport === null) return null;
  const { exportRow, manifest } = verifiedExport;
  const headers = revisionHeaders(exportRow.catalogue_revision_id, `"${exportRow.manifest_digest}"`);
  if (ifNoneMatch(request, `"${exportRow.manifest_digest}"`)) {
    return new Response(null, { status: 304, headers });
  }
  return Response.json(
    {
      data: manifest,
      meta: {
        catalogue_revision_id: exportRow.catalogue_revision_id,
        published_at: exportRow.published_at,
      },
      links: {
        self: publicUrl(base, `/v1/catalogue-exports/${encodeURIComponent(revisionId)}`),
      },
    },
    {
      headers,
    },
  );
}

export async function catalogueExportComponentResponse(
  request: Request,
  database: D1Database,
  bucket: R2Bucket,
  revisionId: string,
  componentName: string,
): Promise<Response | null> {
  const exportRow = await findExport(database, revisionId);
  if (exportRow === null) return null;
  if (exportRow.maintenance_state !== "available") {
    const knownComponent = await database
      .prepare(
        `SELECT 1 AS present
       FROM catalogue_exports AS export
       JOIN catalogue_export_deletions AS deletion
         ON deletion.id = export.deletion_operation_id
       JOIN catalogue_export_deletion_plans AS plan
         ON plan.id = deletion.plan_id
       JOIN json_each(plan.component_names_json) AS component
       WHERE export.catalogue_revision_id = ? AND component.value = ?`,
      )
      .bind(revisionId, componentName)
      .first();
    if (knownComponent === null) return null;
    throw new ReadProblem(410, "catalogue_export_deleted", "This known Catalogue Export component has been deleted.");
  }
  const verifiedExport = await loadVerifiedExportManifest(database, bucket, revisionId);
  if (verifiedExport === null) return null;
  const { manifest } = verifiedExport;
  const component = manifest.components.find((component) => component.name === componentName);
  if (component === undefined) return null;

  const etag = `"${component.compressed_sha256}"`;
  const baseHeaders = new Headers({
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=31536000, immutable",
    etag,
    "x-catalogue-revision": revisionId,
  });
  const key = `catalogue-exports/${revisionId}/components/${component.compressed_sha256}.ndjson.gz`;
  const verifiedObject = await verifyExportComponentObject(
    bucket,
    key,
    component.compressed_bytes,
    component.compressed_sha256,
  );
  if (verifiedObject === null) {
    throw new ReadProblem(404, "not_found", "The Catalogue Export component is unavailable.");
  }
  if (ifNoneMatch(request, etag)) {
    return new Response(null, {
      status: 304,
      headers: baseHeaders,
    });
  }

  const range = request.method === "HEAD" ? null : parseRange(request.headers.get("range"), component.compressed_bytes);
  if (range === "unsatisfiable") {
    throw new ReadProblem(
      416,
      "range_not_satisfiable",
      "The requested Catalogue Export component byte range is not satisfiable.",
      null,
      {
        headers: {
          "accept-ranges": "bytes",
          "content-range": `bytes */${component.compressed_bytes}`,
          etag,
          "x-catalogue-revision": revisionId,
        },
      },
    );
  }
  const object = request.method === "HEAD" ? null : await bucket.get(key, range === null ? {} : { range });
  if (
    request.method !== "HEAD" &&
    !exportComponentReadMatches(object, verifiedObject.etag, component.compressed_bytes, component.compressed_sha256)
  ) {
    throw new ReadProblem(404, "not_found", "The Catalogue Export component is unavailable.");
  }

  const partial = range !== null;
  const responseLength = partial ? range.length : component.compressed_bytes;
  const headers = new Headers(baseHeaders);
  Object.entries({
    "content-disposition": `attachment; filename="${componentName}.ndjson.gz"`,
    "content-length": String(responseLength),
    "content-type": "application/octet-stream",
  }).forEach(([name, value]) => headers.set(name, value));
  if (partial) {
    headers.set(
      "content-range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${component.compressed_bytes}`,
    );
  }
  return new Response(request.method === "HEAD" ? null : (object as R2ObjectBody).body, {
    status: partial ? 206 : 200,
    headers,
  });
}

async function verifyExportComponentObject(
  bucket: R2Bucket,
  key: string,
  expectedBytes: number,
  expectedSha256: string,
): Promise<{ etag: string } | null> {
  const metadata = await bucket.head(key);
  if (metadata === null || metadata.size !== expectedBytes) return null;
  const metadataChecksum = metadata.checksums.toJSON().sha256;
  if (metadataChecksum !== undefined) {
    return metadataChecksum === expectedSha256 ? { etag: metadata.etag } : null;
  }
  const object = await bucket.get(key);
  if (object === null || object.size !== expectedBytes || object.etag !== metadata.etag) {
    return null;
  }
  const objectChecksum = object.checksums.toJSON().sha256;
  if (objectChecksum !== undefined) {
    return objectChecksum === expectedSha256 ? { etag: object.etag } : null;
  }
  return (await readableSha256(object.body)) === expectedSha256 ? { etag: object.etag } : null;
}

function exportComponentReadMatches(
  object: R2Object | null,
  verifiedEtag: string,
  expectedBytes: number,
  expectedSha256: string,
): object is R2ObjectBody {
  if (object === null || object.size !== expectedBytes || object.etag !== verifiedEtag) {
    return false;
  }
  const checksum = object.checksums.toJSON().sha256;
  return checksum === undefined || checksum === expectedSha256;
}

async function readableSha256(readable: ReadableStream<Uint8Array>): Promise<string> {
  const digest = new crypto.DigestStream("SHA-256");
  await readable.pipeTo(digest);
  return [...new Uint8Array(await digest.digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function findExport(database: D1Database, revisionId: string): Promise<ExportRow | null> {
  return database
    .prepare(
      `SELECT
        export.catalogue_revision_id,
        revision.published_at,
        export.manifest_key,
        export.manifest_digest,
        export.maintenance_state
      FROM catalogue_exports AS export
      JOIN catalogue_revisions AS revision
        ON revision.id = export.catalogue_revision_id
      WHERE export.catalogue_revision_id = ? AND export.verified = 1`,
    )
    .bind(revisionId)
    .first<ExportRow>();
}

async function loadVerifiedExportManifest(
  database: D1Database,
  bucket: R2Bucket,
  revisionId: string,
): Promise<{
  exportRow: ExportRow;
  manifest: ExportManifest;
} | null> {
  const exportRow = await findExport(database, revisionId);
  if (exportRow === null) return null;
  if (exportRow.maintenance_state !== "available") {
    throw new ReadProblem(410, "catalogue_export_deleted", "This known Catalogue Export has been deleted.");
  }
  const object = await bucket.get(exportRow.manifest_key);
  if (object === null || object.size > 1_048_576) {
    throw new Error("Verified Catalogue Export manifest is unavailable");
  }
  const text = await object.text();
  const manifest = JSON.parse(text) as ExportManifest;
  const canonicalManifest = `${canonicalJson(manifest)}\n`;
  const selfDigest = await sha256Text(
    `${canonicalJson({
      ...manifest,
      manifest_sha256: "0".repeat(64),
    })}\n`,
  );
  if (
    text !== canonicalManifest ||
    manifest.catalogue_revision.id !== exportRow.catalogue_revision_id ||
    manifest.manifest_sha256 !== exportRow.manifest_digest ||
    selfDigest !== exportRow.manifest_digest
  ) {
    throw new Error("Verified Catalogue Export manifest changed");
  }
  return { exportRow, manifest };
}

function parseRange(header: string | null, size: number): { offset: number; length: number } | "unsatisfiable" | null {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (match === null || (match[1] === "" && match[2] === "")) {
    return "unsatisfiable";
  }
  if (match[1] === "") {
    const suffix = Number.parseInt(match[2]!, 10);
    if (suffix < 1) return "unsatisfiable";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const offset = Number.parseInt(match[1]!, 10);
  const requestedEnd = match[2] === "" ? size - 1 : Number.parseInt(match[2]!, 10);
  if (offset >= size || requestedEnd < offset) return "unsatisfiable";
  const end = Math.min(requestedEnd, size - 1);
  return { offset, length: end - offset + 1 };
}
