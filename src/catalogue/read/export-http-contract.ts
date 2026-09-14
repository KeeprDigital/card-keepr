import { createRoute, z } from "@hono/zod-openapi";
import { identifier, digest, problemResponses, revisionResponseHeaders, secured } from "../../http/openapi";
import { cardQuerySchema, cardCollectionSchema, link, meta, supportedGame, profiles } from "./http-contract";

const readProblems = { ...problemResponses, 410: { ...problemResponses[404]!, description: "Known export deleted." } };
const componentName = z
  .string()
  .regex(new RegExp(`^(${profiles.map(({ game }) => game).join("|")})\\.(0|[1-9][0-9]*)$`));
const exportKinds = [
  "supported-games",
  "game-profiles",
  "cards",
  "printings",
  "printing-images",
  "products",
  "releases",
  "distribution-contexts",
  "errata",
  "relationships",
  "identity-corrections",
] as const;
const recordNames = [
  "SupportedGameRecord",
  "GameProfileRecord",
  "CardRecord",
  "PrintingRecord",
  "PrintingImageRecord",
  "ProductRecord",
  "ReleaseRecord",
  "DistributionContextRecord",
  "ErratumRecord",
  "RelationshipRecord",
  "IdentityCorrectionRecord",
];
const componentSchema = z.strictObject({
  name: componentName,
  kind: z.enum(exportKinds),
  media_type: z.literal("application/x-ndjson"),
  compression: z.literal("gzip"),
  record_schema: z.enum(
    recordNames.map((name) => `https://card-keepr.invalid/schemas/catalogue-export-record@5#/$defs/${name}`),
  ),
  records: z.literal(1),
  uncompressed_bytes: z.number().int().nonnegative(),
  compressed_bytes: z.number().int().nonnegative(),
  content_sha256: digest,
  compressed_sha256: digest,
});
export const exportManifestSchema = z
  .strictObject({
    data: z.strictObject({
      format: z.literal("card-keepr-catalogue-export-manifest@5"),
      serialization_profile: z.literal("card-keepr-ndjson-gzip@1"),
      export_schema_major: z.literal(5),
      catalogue_revision: z.strictObject({ id: identifier, content_sha256: digest }),
      published_at: identifier,
      export_created_at: identifier,
      supported_games: z.array(supportedGame).min(1),
      components: z.array(componentSchema).max(4),
      page: z.strictObject({ next_cursor: identifier.nullable() }),
      manifest_sha256: digest,
    }),
    meta,
    links: z.strictObject({ self: z.url(), components: z.record(z.string(), z.url()) }),
  })
  .openapi("CatalogueExportDocument");
export const exportCollectionSchema = z
  .strictObject({
    data: z.array(
      z.strictObject({
        type: z.literal("catalogue_export"),
        catalogue_revision_id: identifier,
        export_schema_major: z.literal(5),
        published_at: identifier,
        content_sha256: digest,
        links: link,
      }),
    ),
    meta,
    page: cardCollectionSchema.shape.page,
    links: link,
  })
  .openapi("CatalogueExportCollection");
export const exportsRoute = createRoute({
  method: "get",
  path: "/v1/catalogue-exports",
  operationId: "listCatalogueExports",
  security: secured,
  request: {
    query: cardQuerySchema.pick({ limit: true, after: true }),
    headers: z.object({ "if-none-match": z.string().optional() }),
  },
  responses: {
    200: {
      description: "Available Catalogue Exports in a revision-pinned page.",
      headers: revisionResponseHeaders,
      content: { "application/json": { schema: exportCollectionSchema } },
    },
    304: { description: "Unchanged validated export listing; no body.", headers: revisionResponseHeaders },
    ...readProblems,
  },
});
export const exportManifestRoute = createRoute({
  method: "get",
  path: "/v1/catalogue-exports/{revision}",
  operationId: "getCatalogueExport",
  security: secured,
  request: {
    params: z.strictObject({ revision: identifier }),
    query: cardQuerySchema.pick({ after: true }),
    headers: z.object({ "if-none-match": z.string().optional() }),
  },
  responses: {
    200: {
      description: "Verified current-model export manifest page.",
      headers: revisionResponseHeaders,
      content: { "application/json": { schema: exportManifestSchema } },
    },
    304: { description: "Unchanged validated manifest; no body.", headers: revisionResponseHeaders },
    ...readProblems,
  },
});
const header = (pattern?: string) => ({
  required: true,
  schema: { type: "string" as const, ...(pattern ? { pattern } : {}) },
});
const binaryHeaders = { ...revisionResponseHeaders, "Accept-Ranges": header("^bytes$") };
const contentHeaders = { ...binaryHeaders, "Content-Length": header("^[0-9]+$"), "Content-Disposition": header() };
export function exportComponentRoute(method: "get" | "head") {
  const body =
    method === "head" ? {} : { content: { "application/gzip": { schema: z.string().openapi({ format: "binary" }) } } };
  return createRoute({
    method,
    path: "/v1/catalogue-exports/{revision}/components/{component}",
    operationId: method === "head" ? "headCatalogueExportComponent" : "getCatalogueExportComponent",
    security: secured,
    request: {
      params: z.strictObject({ revision: identifier, component: identifier }),
      query: z.strictObject({}),
      headers: z.object({
        range: z.string().optional(),
        "if-range": z.string().optional(),
        "if-none-match": z.string().optional(),
      }),
    },
    responses: {
      ...(method === "head"
        ? Object.fromEntries(
            Object.entries(readProblems).map(([status, { content: _content, ...response }]) => [status, response]),
          )
        : readProblems),
      200: {
        description: "Verified immutable gzip bytes; HEAD returns metadata and ignores Range.",
        headers: contentHeaders,
        ...body,
      },
      304: { description: "Verified immutable component is unchanged; no body.", headers: binaryHeaders },
      ...(method === "head"
        ? {}
        : {
            206: {
              description: "One satisfiable byte range.",
              headers: { ...contentHeaders, "Content-Range": header("^bytes [0-9]+-[0-9]+/[0-9]+$") },
              ...body,
            },
            416: {
              description: "Unsatisfiable byte range.",
              headers: { ...binaryHeaders, "Content-Range": header("^bytes \\*/[0-9]+$") },
              content: problemResponses[400]!.content,
            },
          }),
    },
  });
}
