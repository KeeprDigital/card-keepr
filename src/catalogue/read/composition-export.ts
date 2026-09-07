import { type PublicBase, publicUrl } from "../../http/public-base";
import { type CatalogueStore, canonicalJson, deterministicGzip, sha256, sha256Text } from "../shared";
import { composedPublicRecord, type DocumentRow } from "./composition-read";
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
} from "./composition-read-repository";

type Artifact = DocumentRow & { supported_game: string; ordinal: number; kind: string };
const definitions: Record<string, string> = {
  supported_games: "SupportedGameRecord",
  game_profiles: "GameProfileRecord",
  cards: "CardRecord",
  printings: "PrintingRecord",
  printing_images: "PrintingImageRecord",
  products: "ProductRecord",
  releases: "ReleaseRecord",
  distribution_contexts: "DistributionContextRecord",
  errata: "ErratumRecord",
  relationships: "RelationshipRecord",
  product_relationships: "RelationshipRecord",
  identity_corrections: "IdentityCorrectionRecord",
};
async function component(db: CatalogueStore, revision: string, artifact: Artifact) {
  const value = await composedPublicRecord(db, revision, artifact.kind, artifact);
  const raw = new TextEncoder().encode(`${canonicalJson(value)}\n`);
  if (raw.byteLength > 4_000_000)
    throw new ReadProblem(503, "catalogue_export_unavailable", "The public record exceeds its component budget.");
  const bytes = deterministicGzip(raw);
  return {
    bytes,
    descriptor: {
      name: `${artifact.supported_game}.${artifact.ordinal}`,
      kind: artifact.kind === "product_relationships" ? "relationships" : artifact.kind.replaceAll("_", "-"),
      media_type: "application/x-ndjson",
      compression: "gzip",
      record_schema: `https://card-keepr.invalid/schemas/catalogue-export-record@5#/$defs/${definitions[artifact.kind]}`,
      records: 1,
      uncompressed_bytes: raw.byteLength,
      content_sha256: await sha256(raw),
      compressed_bytes: bytes.byteLength,
      compressed_sha256: await sha256(bytes),
    },
  };
}

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
  const components = [];
  for (const artifact of artifacts) components.push((await component(db, revisionId, artifact)).descriptor);
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
  _bucket: R2Bucket,
  request: Request,
  revisionId: string,
  name: string,
): Promise<Response | null | undefined> {
  if (!(await nativeRevisionStatement(db, revisionId, false).first())) return undefined;
  const match = /^(one-piece|fusion-world|digimon|gundam)\.(0|[1-9]\d*)$/.exec(name);
  if (!match || !Number.isSafeInteger(Number(match[2]))) return null;
  const artifact = await composedExportArtifactStatement(db, revisionId, match[1]!, Number(match[2])).first<Artifact>();
  if (!artifact) return null;
  const { bytes, descriptor } = await component(db, revisionId, artifact);
  const headers: Record<string, string> = {
    ...revisionHeaders(revisionId, `"${descriptor.compressed_sha256}"`),
    "accept-ranges": "bytes",
    "content-type": "application/gzip",
  };
  const conditional = conditionalResponse(request, headers);
  if (conditional) return conditional;
  const range =
    request.method === "HEAD" || (request.headers.has("if-range") && request.headers.get("if-range") !== headers.etag)
      ? null
      : parseRange(request.headers.get("range"), bytes.byteLength);
  if (range === "unsatisfiable")
    throw new ReadProblem(
      416,
      "range_not_satisfiable",
      "The requested Catalogue Export byte range is not satisfiable.",
      null,
      { headers: { ...headers, "content-range": `bytes */${bytes.byteLength}` } },
    );
  headers["content-length"] = String(range?.length ?? bytes.byteLength);
  if (range) headers["content-range"] = `bytes ${range.offset}-${range.offset + range.length - 1}/${bytes.byteLength}`;
  return new Response(
    request.method === "HEAD"
      ? null
      : bytes.slice(range?.offset ?? 0, range ? range.offset + range.length : bytes.byteLength),
    { status: range ? 206 : 200, headers },
  );
}
