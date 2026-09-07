import { type PublicBase, publicUrl } from "../../http/public-base";
import { type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import {
  canonicalEtag,
  conditionalResponse,
  revisionHeaders,
  ReadProblem,
  collectionParameters,
  encodeCursor,
  decodeCursor,
} from "./collection-endpoint";
import {
  nativeRevisionStatement,
  composedExportArtifactsStatement,
  composedExportArtifactStatement,
} from "./composition-read-repository";

type Artifact = {
  supported_game: string;
  ordinal: number;
  kind: string;
  object_key: string;
  sha256: string;
  byte_length: number;
};

/** Bounded immutable component index; component bodies reuse verified private artifacts. */
export async function compositionExportResponse(
  db: CatalogueStore,
  request: Request,
  base: PublicBase,
  revisionId: string,
): Promise<Response | undefined> {
  const revision = await nativeRevisionStatement(db, revisionId).first<{
    id: string;
    published_at: string;
    content_digest: string;
  }>();
  if (!revision) return undefined;
  const url = new URL(request.url);
  collectionParameters(url, ["after"]);
  const raw = url.searchParams.get("after");
  const cursor = raw ? (decodeCursor(raw) as { revision_id?: string; game?: string; ordinal?: number }) : null;
  if (
    cursor &&
    (cursor.revision_id !== revisionId || typeof cursor.game !== "string" || !Number.isSafeInteger(cursor.ordinal))
  )
    throw new ReadProblem(400, "invalid_cursor", "Use this export composition cursor.");
  const artifacts = (
    await composedExportArtifactsStatement(db, revisionId, cursor?.game ?? "", cursor?.ordinal ?? -1).all<Artifact>()
  ).results;
  const next =
    artifacts.length === 32
      ? encodeCursor({
          revision_id: revisionId,
          game: artifacts.at(-1)!.supported_game,
          ordinal: artifacts.at(-1)!.ordinal,
        })
      : null;
  const manifest = {
    export_schema_major: 1,
    catalogue_revision: { id: revisionId, content_sha256: revision.content_digest },
    components: artifacts.map((a) => ({
      name: `${a.supported_game}.${a.ordinal}`,
      kind: a.kind,
      sha256: a.sha256,
      bytes: a.byte_length,
      media_type: a.kind === "text" ? "text/plain; charset=utf-8" : "application/json",
      links: {
        content: publicUrl(base, `/v1/catalogue-exports/${revisionId}/components/${a.supported_game}.${a.ordinal}`),
      },
    })),
    page: { next_cursor: next },
    manifest_sha256: "0".repeat(64),
  };
  manifest.manifest_sha256 = await sha256Text(canonicalJson(manifest));
  const document = {
    data: {
      type: "catalogue_export",
      catalogue_revision_id: revisionId,
      export_schema_major: 1,
      published_at: revision.published_at,
      manifest_sha256: manifest.manifest_sha256,
      manifest,
    },
    meta: { catalogue_revision_id: revisionId, published_at: revision.published_at },
    links: { self: publicUrl(base, url.pathname + url.search) },
  };
  const headers = revisionHeaders(revisionId, await canonicalEtag(document));
  return conditionalResponse(request, headers) ?? Response.json(document, { headers });
}
export async function compositionExportComponentResponse(
  db: CatalogueStore,
  bucket: R2Bucket,
  request: Request,
  revisionId: string,
  name: string,
): Promise<Response | null | undefined> {
  const revision = await nativeRevisionStatement(db, revisionId).first();
  if (!revision) return undefined;
  const match = /^(one-piece|fusion-world|digimon|gundam)\.(\d+)$/.exec(name);
  if (!match) return null;
  const artifact = await composedExportArtifactStatement(db, revisionId, match[1]!, Number(match[2])).first<Artifact>();
  if (!artifact) return null;
  const headers: Record<string, string> = {
    ...revisionHeaders(revisionId, `"${artifact.sha256}"`),
    "accept-ranges": "bytes",
    "content-type": artifact.kind === "text" ? "text/plain; charset=utf-8" : "application/json",
  };
  const conditional = conditionalResponse(request, headers);
  if (conditional) return conditional;
  const range = request.headers.get("range");
  let offset = 0,
    length = artifact.byte_length;
  if (range && (!request.headers.has("if-range") || request.headers.get("if-range") === headers.etag)) {
    const parsed = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!parsed || (!parsed[1] && !parsed[2]))
      return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${length}` } });
    if (!parsed[1]) {
      length = Math.min(length, Number(parsed[2]));
      offset = artifact.byte_length - length;
    } else {
      offset = Number(parsed[1]);
      length = Math.min(parsed[2] ? Number(parsed[2]) + 1 : artifact.byte_length, artifact.byte_length) - offset;
    }
    if (length <= 0 || offset < 0)
      return new Response(null, {
        status: 416,
        headers: { ...headers, "content-range": `bytes */${artifact.byte_length}` },
      });
    headers["content-range"] = `bytes ${offset}-${offset + length - 1}/${artifact.byte_length}`;
  }
  headers["content-length"] = String(length);
  const status = headers["content-range"] ? 206 : 200;
  const object = await bucket.get(artifact.object_key, { range: { offset, length } });
  if (!object || object.size !== artifact.byte_length)
    throw new ReadProblem(503, "catalogue_export_unavailable", "The immutable component is unavailable.");
  if (request.method === "HEAD") {
    await object.body.cancel();
    return new Response(null, { status, headers });
  }
  return new Response(object.body, { status, headers });
}
