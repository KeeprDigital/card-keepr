import {
  parseCatalogueRevisionId,
  parsePublicationInstant,
} from "../http/catalogue";

type CatalogueStateRow = {
  current_revision_id: string;
  published_at: string;
};

type RevisionDocumentRow = CatalogueStateRow & {
  document_json: string;
};

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
  const state = await database
    .prepare(
      "SELECT current_revision_id, published_at FROM catalogue_state WHERE singleton = 1",
    )
    .first<CatalogueStateRow>();
  if (state === null) throw new Error("Catalogue state is unavailable");
  return {
    revisionId: parseCatalogueRevisionId(state.current_revision_id),
    publishedAt: parsePublicationInstant(state.published_at),
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
  return revisionDocumentResponse(
    JSON.parse(row.document_json),
    row,
    `/v1/printings/${encodeURIComponent(printingId)}`,
    `printing:${printingId}:${row.current_revision_id}`,
  );
}

export async function catalogueExportResponse(
  database: D1Database,
  bucket: R2Bucket,
  revisionId: string,
): Promise<Response | null> {
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
  const exportRow = await findExport(database, revisionId);
  if (exportRow === null) return null;
  const manifestObject = await bucket.get(exportRow.manifest_key);
  if (manifestObject === null || manifestObject.size > 1_048_576) {
    throw new Error("Verified Catalogue Export manifest is unavailable");
  }
  const manifest = await manifestObject.json<ExportManifest>();
  const component = manifest.components.find(
    (candidate) => candidate.name === componentName,
  );
  if (component === undefined) return null;

  const etag = `"${component.compressed_sha256}"`;
  if (request.headers.get("if-none-match") === etag) {
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

function revisionDocumentResponse(
  data: unknown,
  state: CatalogueStateRow,
  self: string,
  etag: string,
): Response {
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
      headers: revisionHeaders(state.current_revision_id, etag),
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
