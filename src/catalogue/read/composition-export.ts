import { type PublicBase, publicUrl } from "../../http/public-base";
import { type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import { parseRange } from "./byte-range";
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
  composedSupportedGamesStatement,
  composedPublicExportReadyStatement,
} from "./composition-read-repository";

async function requirePublicExport(db: CatalogueStore, revisionId: string) {
  if (!(await composedPublicExportReadyStatement(db, revisionId).first()))
    throw new ReadProblem(503, "catalogue_export_unavailable", "The current public export artifacts are unavailable.");
}

type Artifact = {
  supported_game: string;
  ordinal: number;
  kind: string;
  object_key: string;
  sha256: string;
  byte_length: number;
  descriptor_json: string;
};
/** Four deterministic record components per page; host links never enter content hashes. */
export async function compositionExportResponse(
  db: CatalogueStore,
  request: Request,
  base: PublicBase,
  revisionId: string,
): Promise<Response | undefined> {
  const revision = await nativeRevisionStatement(db, revisionId, false).first<{
    id: string;
    published_at: string;
    content_digest: string;
  }>();
  if (!revision) return undefined;
  await requirePublicExport(db, revisionId);
  const url = new URL(request.url);
  collectionParameters(url, ["after"]);
  const raw = url.searchParams.get("after");
  const cursor = raw ? (decodeCursor(raw) as { revision_id?: string; game?: string; ordinal?: number }) : null;
  if (
    cursor &&
    (cursor.revision_id !== revisionId ||
      !["one-piece", "fusion-world", "digimon", "gundam"].includes(cursor.game ?? "") ||
      !Number.isSafeInteger(cursor.ordinal) ||
      cursor.ordinal! < 0)
  )
    throw new ReadProblem(400, "invalid_cursor", "Use this export composition cursor.");
  const artifacts = (
    await composedExportArtifactsStatement(db, revisionId, cursor?.game ?? "", cursor?.ordinal ?? -1).all<Artifact>()
  ).results;
  const components = artifacts.map((artifact) => JSON.parse(artifact.descriptor_json) as { name: string });
  const next =
    artifacts.length === 4
      ? encodeCursor({
          revision_id: revisionId,
          game: artifacts.at(-1)!.supported_game,
          ordinal: artifacts.at(-1)!.ordinal,
        })
      : null;
  const games = (await composedSupportedGamesStatement(db, revisionId).all<{ supported_game: string }>()).results.map(
    (g) => g.supported_game,
  );
  const manifest = {
    format: "card-keepr-catalogue-export-manifest@5",
    serialization_profile: "card-keepr-ndjson-gzip@1",
    export_schema_major: 5,
    catalogue_revision: { id: revisionId, content_sha256: revision.content_digest },
    published_at: revision.published_at,
    export_created_at: revision.published_at,
    supported_games: games,
    components,
    page: { next_cursor: next },
    manifest_sha256: "0".repeat(64),
  };
  manifest.manifest_sha256 = await sha256Text(canonicalJson(manifest));
  const document = {
    data: manifest,
    meta: { catalogue_revision_id: revisionId, published_at: revision.published_at },
    links: {
      self: publicUrl(base, url.pathname + url.search),
      components: Object.fromEntries(
        components.map((c) => [c.name, publicUrl(base, `/v1/catalogue-exports/${revisionId}/components/${c.name}`)]),
      ),
    },
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
  if (!(await nativeRevisionStatement(db, revisionId, false).first())) return undefined;
  await requirePublicExport(db, revisionId);
  const match = /^(one-piece|fusion-world|digimon|gundam)\.(0|[1-9]\d*)$/.exec(name);
  if (!match || !Number.isSafeInteger(Number(match[2]))) return null;
  const artifact = await composedExportArtifactStatement(db, revisionId, match[1]!, Number(match[2])).first<Artifact>();
  if (!artifact) return null;
  const size = artifact.byte_length;
  const headers: Record<string, string> = {
    ...revisionHeaders(revisionId, `"${artifact.sha256}"`),
    "accept-ranges": "bytes",
    "content-type": "application/gzip",
  };
  const objectHead = await bucket.head(artifact.object_key);
  if (!objectHead || objectHead.size !== size)
    throw new ReadProblem(503, "catalogue_export_unavailable", "The verified public component is unavailable.");
  const conditional = conditionalResponse(request, headers);
  if (conditional) return conditional;
  const range =
    request.method === "HEAD" || (request.headers.has("if-range") && request.headers.get("if-range") !== headers.etag)
      ? null
      : parseRange(request.headers.get("range"), size);
  if (range === "unsatisfiable")
    throw new ReadProblem(
      416,
      "range_not_satisfiable",
      "The requested Catalogue Export byte range is not satisfiable.",
      null,
      { headers: { ...headers, "content-range": `bytes */${size}` } },
    );
  headers["content-length"] = String(range?.length ?? size);
  if (range) headers["content-range"] = `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`;
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  const object = await bucket.get(artifact.object_key, range ? { range } : {});
  if (!object || object.size !== size)
    throw new ReadProblem(503, "catalogue_export_unavailable", "The verified public component is unavailable.");
  return new Response(object.body, { status: range ? 206 : 200, headers });
}
