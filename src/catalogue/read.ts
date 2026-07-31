import {
  parseCatalogueRevisionId,
  parsePublicationInstant,
} from "../http/catalogue";
import { ifNoneMatch } from "../http/conditional";
import { canonicalJson, sha256Text } from "./serialization";
import {
  canonicalDetailSelf,
  detailIncludeProjection,
  detailRepresentationKey,
} from "./detail-representation";

type CatalogueStateRow = {
  current_revision_id: string;
  published_at: string;
};

type FreshnessRow = {
  game: "one-piece" | "fusion-world" | "digimon" | "gundam";
  area:
    | "cards-and-printings"
    | "products-and-releases"
    | "legality-rules"
    | "errata";
  checked_at: string;
};

type RevisionDocumentRow = CatalogueStateRow & {
  document_json: string;
};

type PrintingEnvelope = {
  data: unknown;
  included: unknown[];
  provenance: Record<string, string[]>;
  disagreements: unknown[];
};

type PrintingImageRow = {
  media_type: string;
  content_sha256: string;
  content_byte_length: number;
  object_key: string;
  current_revision_id: string;
};

export class PrintingReadProblem extends Error {
  readonly status = 400;
  readonly code = "invalid_parameter";
}

type ExportRow = {
  catalogue_revision_id: string;
  published_at: string;
  manifest_key: string;
  manifest_digest: string;
};

type ExportManifest = {
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

export async function currentCatalogueStatus(database: D1Database) {
  const [state, freshness] = await Promise.all([
    database
      .prepare(
        "SELECT current_revision_id, published_at FROM catalogue_state WHERE singleton = 1",
      )
      .first<CatalogueStateRow>(),
    database
      .prepare(
        `SELECT game, area, checked_at
         FROM source_freshness
         ORDER BY game, area`,
      )
      .all<FreshnessRow>(),
  ]);
  if (state === null) throw new Error("Catalogue state is unavailable");
  const lastSuccessfulChecks = freshness.results.map((row) => ({
    game: row.game,
    area: row.area,
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
  return revisionDocumentResponse(
    JSON.parse(row.document_json),
    row,
    `/v1/cards/${encodeURIComponent(cardId)}`,
    `card:${cardId}:${row.current_revision_id}`,
  );
}

export async function currentPrintingResponse(
  database: D1Database,
  printingId: string,
  request: Request,
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
    () => new PrintingReadProblem("Printing include projection is invalid."),
  );
  const envelope = printingEnvelope(row.document_json);
  const etag = `"printing:${printingId}:${row.current_revision_id}:` +
    `${detailRepresentationKey(include)}"`;
  const headers = revisionHeaders(row.current_revision_id, etag);
  if (ifNoneMatch(request, etag)) {
    return new Response(null, { status: 304, headers });
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
      links: { self: canonicalDetailSelf(url, include) },
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
      `SELECT
         image.media_type,
         image.content_sha256,
         image.content_byte_length,
         image.object_key,
         catalogue.current_revision_id
       FROM catalogue_state AS catalogue
       JOIN revision_printing_images AS membership
         ON membership.catalogue_revision_id =
           catalogue.current_revision_id
       JOIN reconciled_printing_images AS image
         ON image.id = membership.image_id
       JOIN revision_printings AS printing
         ON printing.catalogue_revision_id = catalogue.current_revision_id
        AND printing.printing_id = membership.printing_id
       WHERE catalogue.singleton = 1 AND image.id = ?`,
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
  const range = isHead
    ? null
    : parseRange(
        request.headers.get("range"),
        row.content_byte_length,
      );
  if (range === "unsatisfiable") {
    baseHeaders.set(
      "content-range",
      `bytes */${row.content_byte_length}`,
    );
    baseHeaders.set("cache-control", "no-store");
    return new Response(null, { status: 416, headers: baseHeaders });
  }
  const object =
    isHead
      ? await bucket.head(row.object_key)
      : await bucket.get(
          row.object_key,
          range === null ? {} : { range },
        );
  if (object === null || object.size !== row.content_byte_length) {
    throw new Error("Published Printing Image content is unavailable.");
  }
  const responseLength =
    range === null ? row.content_byte_length : range.length;
  baseHeaders.set("content-length", String(responseLength));
  baseHeaders.set("content-type", row.media_type);
  if (range !== null) {
    baseHeaders.set(
      "content-range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/` +
        row.content_byte_length,
    );
  }
  return new Response(
    isHead ? null : (object as R2ObjectBody).body,
    {
      status: range === null ? 200 : 206,
      headers: baseHeaders,
    },
  );
}

function printingEnvelope(documentJson: string): PrintingEnvelope {
  const parsed: unknown = JSON.parse(documentJson);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("A revision-pinned Printing document is invalid.");
  }
  const value = parsed as Record<string, unknown>;
  const data =
    value.data !== null &&
    typeof value.data === "object" &&
    !Array.isArray(value.data)
      ? value.data
      : value;
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

export async function catalogueExportResponse(
  database: D1Database,
  bucket: R2Bucket,
  revisionId: string,
): Promise<Response | null> {
  const verifiedExport = await loadVerifiedExportManifest(
    database,
    bucket,
    revisionId,
  );
  if (verifiedExport === null) return null;
  const { exportRow, manifest } = verifiedExport;
  return Response.json(
    {
      data: manifest,
      meta: {
        catalogue_revision_id: exportRow.catalogue_revision_id,
        published_at: exportRow.published_at,
      },
      links: {
        self: `/v1/catalogue-exports/${encodeURIComponent(revisionId)}`,
      },
    },
    {
      headers: revisionHeaders(
        exportRow.catalogue_revision_id,
        exportRow.manifest_digest,
      ),
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
  const verifiedExport = await loadVerifiedExportManifest(
    database,
    bucket,
    revisionId,
  );
  if (verifiedExport === null) return null;
  const { manifest } = verifiedExport;
  const component = manifest.components.find(
    (candidate) => candidate.name === componentName,
  );
  if (component === undefined) return null;

  const etag = `"${component.compressed_sha256}"`;
  if (ifNoneMatch(request, etag)) {
    return new Response(null, {
      status: 304,
      headers: {
        etag,
        "x-catalogue-revision": revisionId,
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  }

  const key = `catalogue-exports/${revisionId}/components/${component.compressed_sha256}.ndjson.gz`;
  const range = parseRange(
    request.headers.get("range"),
    component.compressed_bytes,
  );
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: {
        "content-range": `bytes */${component.compressed_bytes}`,
        "x-catalogue-revision": revisionId,
        "cache-control": "no-store",
      },
    });
  }
  const object =
    request.method === "HEAD"
      ? await bucket.head(key)
      : await bucket.get(key, range === null ? {} : { range });
  if (object === null) {
    throw new Error("Verified Catalogue Export component is unavailable");
  }

  const partial = range !== null;
  const responseLength = partial
    ? range.length
    : component.compressed_bytes;
  const headers = new Headers({
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=31536000, immutable",
    "content-disposition": `attachment; filename="${componentName}.ndjson.gz"`,
    "content-length": String(responseLength),
    "content-type": "application/octet-stream",
    etag,
    "x-catalogue-revision": revisionId,
  });
  if (partial) {
    headers.set(
      "content-range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${component.compressed_bytes}`,
    );
  }
  return new Response(
    request.method === "HEAD" ? null : (object as R2ObjectBody).body,
    {
      status: partial ? 206 : 200,
      headers,
    },
  );
}

async function findExport(
  database: D1Database,
  revisionId: string,
): Promise<ExportRow | null> {
  return database
    .prepare(
      `SELECT
        export.catalogue_revision_id,
        revision.published_at,
        export.manifest_key,
        export.manifest_digest
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
  const object = await bucket.get(exportRow.manifest_key);
  if (object === null || object.size > 1_048_576) {
    throw new Error("Verified Catalogue Export manifest is unavailable");
  }
  const manifest = await object.json<ExportManifest>();
  if (
    manifest.catalogue_revision.id !== exportRow.catalogue_revision_id ||
    manifest.manifest_sha256 !== exportRow.manifest_digest
  ) {
    throw new Error("Verified Catalogue Export manifest changed");
  }
  return { exportRow, manifest };
}

function revisionDocumentResponse(
  data: unknown,
  state: CatalogueStateRow,
  self: string,
  etag: string,
  request?: Request,
): Response {
  const headers = revisionHeaders(state.current_revision_id, etag);
  const responseEtag = `"${etag.replaceAll('"', "")}"`;
  if (request !== undefined && ifNoneMatch(request, responseEtag)) {
    return new Response(null, { status: 304, headers });
  }
  return Response.json(
    {
      data,
      meta: {
        catalogue_revision_id: state.current_revision_id,
        published_at: state.published_at,
      },
      links: { self },
    },
    {
      headers,
    },
  );
}

function revisionHeaders(revisionId: string, etag: string): HeadersInit {
  return {
    "cache-control": "private, no-cache",
    etag: `"${etag.replaceAll('"', "")}"`,
    "x-catalogue-revision": revisionId,
  };
}

function parseRange(
  header: string | null,
  size: number,
): { offset: number; length: number } | "unsatisfiable" | null {
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
  const requestedEnd =
    match[2] === "" ? size - 1 : Number.parseInt(match[2]!, 10);
  if (offset >= size || requestedEnd < offset) return "unsatisfiable";
  const end = Math.min(requestedEnd, size - 1);
  return { offset, length: end - offset + 1 };
}
