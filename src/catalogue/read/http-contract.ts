import { createRoute, z } from "@hono/zod-openapi";
import { identifier, problemResponses, revisionResponseHeaders, secured } from "../../http/openapi";
import { gameProfileRegistrations } from "../adapters";
import { requiredProfileContract } from "../shared";

// Project the profile's declared primitives into wire schemas. The profile's
// semantic validators and all persisted-document validators remain independent.
type ProfileSchema = ReturnType<typeof requiredProfileContract>["card"]["properties"][string];
function profileWire(schema: ProfileSchema): z.ZodType {
  switch (schema.kind) {
    case "string": {
      const value = z.string().min(schema.minimumLength ?? 0);
      return schema.nullable ? value.nullable() : value;
    }
    case "integer": {
      const value = z
        .number()
        .int()
        .min(schema.minimum ?? 0);
      return schema.nullable ? value.nullable() : value;
    }
    case "boolean":
      return z.boolean();
    case "enum":
      return z.enum(schema.values);
    case "array":
      return z
        .array(profileWire(schema.items))
        .min(schema.minimumItems ?? 0)
        .max(schema.maximumItems ?? Number.MAX_SAFE_INTEGER);
    case "object":
      return z.strictObject(
        Object.fromEntries(
          Object.entries(schema.properties).map(([key, value]) => [
            key,
            schema.required.includes(key) ? profileWire(value) : profileWire(value).optional(),
          ]),
        ),
      );
  }
}
const profiles = gameProfileRegistrations();
const supportedGame = z.enum(profiles.map(({ game }) => game));
const gameData = z.union(
  profiles.map(({ id }) =>
    z.strictObject({ profile: z.literal(id), attributes: profileWire(requiredProfileContract(id).card) }),
  ),
);
const officialIdentity = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("card_number"), value: identifier }),
  z.strictObject({ kind: z.literal("publisher_name"), value: identifier }),
  z.strictObject({ kind: z.literal("functional_designation"), value: z.literal("DON!!") }),
  z.strictObject({ kind: z.literal("unknown"), value: z.null() }),
]);
const link = z.strictObject({ self: z.url() });
export const cardCollectionSchema = z
  .strictObject({
    data: z.array(
      z.strictObject({
        type: z.literal("card"),
        id: identifier,
        game: supportedGame,
        official_identity: officialIdentity,
        name: identifier,
        game_data: gameData,
        lifecycle: z.strictObject({
          first_revision_id: identifier,
          last_observed_revision_id: identifier,
          withdrawn: z.boolean(),
          withdrawal: z.strictObject({ revision_id: identifier }).nullable().optional(),
        }),
        links: link,
      }),
    ),
    meta: z.strictObject({ catalogue_revision_id: identifier, published_at: identifier }),
    page: z.strictObject({ limit: z.number().int().min(1).max(100), next_cursor: identifier.nullable() }),
    links: link,
  })
  .openapi("CardCollection");
function filterPaths(schema: ProfileSchema, prefix = ""): string[] {
  if (schema.kind === "array") return filterPaths(schema.items, prefix);
  if (schema.kind !== "object") return [prefix];
  return Object.entries(schema.properties).flatMap(([name, value]) =>
    filterPaths(value, prefix ? `${prefix}.${name}` : name),
  );
}
const textFilter = (name: string) =>
  z
    .string()
    .min(1, { error: `${name} must contain at least one character.` })
    .refine((value) => [...value].length <= 500, { error: `${name} must contain at most 500 characters.` })
    .openapi({ maxLength: 500 });
export const cardQuerySchema = z.strictObject({
  q: textFilter("q").optional(),
  game: textFilter("game")
    .optional()
    .openapi({ description: "Supported Game; normalized with NFKC and trimmed before profile validation." }),
  card_number: textFilter("card_number").optional(),
  card_id: textFilter("card_id").optional(),
  product_id: textFilter("product_id").optional(),
  release_region: z.enum(["EN-OCEANIA", "EN-ASIA", "EN-US", "unknown"]).optional(),
  rarity: textFilter("rarity").optional(),
  revision: identifier.optional().openapi({
    description:
      "Pin an available Catalogue Revision. When after is supplied, revision must match the cursor's pinned composition.",
  }),
  limit: z
    .string()
    .regex(/^(?:[1-9]|[1-9][0-9]|100)$/)
    .optional(),
  after: z.string().max(16_384).optional(),
  ...Object.fromEntries(
    [...new Set(profiles.flatMap(({ id }) => filterPaths(requiredProfileContract(id).card)))].sort().map((path) => [
      `attribute.${path}`,
      textFilter(`attribute.${path}`).optional().openapi({
        description:
          "Equality (array membership) against the selected Game Profile. Requires game; names and values are validated by that profile and the published revision.",
      }),
    ]),
  ),
});
export const cardsRoute = createRoute({
  method: "get",
  path: "/v1/cards",
  operationId: "searchCards",
  security: secured,
  request: { query: cardQuerySchema, headers: z.object({ "if-none-match": z.string().optional() }) },
  responses: {
    200: {
      description: "Published Card page, pinned to one Catalogue Revision.",
      headers: revisionResponseHeaders,
      content: { "application/json": { schema: cardCollectionSchema } },
    },
    304: { description: "Unchanged validated query; no body.", headers: revisionResponseHeaders },
    ...problemResponses,
  },
});
const imageHeaders = {
  ETag: { schema: { type: "string" as const } },
  "Accept-Ranges": { schema: { type: "string" as const } },
  "Content-Length": { schema: { type: "string" as const } },
  "Content-Range": { schema: { type: "string" as const } },
  "Cache-Control": { schema: { type: "string" as const } },
};
export function imageRoute(method: "get" | "head") {
  const content =
    method === "head"
      ? {}
      : {
          content: {
            "image/avif": { schema: z.string().openapi({ format: "binary" }) },
            "image/gif": { schema: z.string().openapi({ format: "binary" }) },
            "image/jpeg": { schema: z.string().openapi({ format: "binary" }) },
            "image/png": { schema: z.string().openapi({ format: "binary" }) },
            "image/webp": { schema: z.string().openapi({ format: "binary" }) },
          },
        };
  return createRoute({
    method,
    path: "/v1/printing-images/{image}/content",
    operationId: method === "get" ? "getPrintingImageContent" : "headPrintingImageContent",
    security: secured,
    request: {
      params: z.strictObject({ image: identifier }),
      query: z.strictObject({
        revision: identifier
          .optional()
          .openapi({ description: "Pin the Printing Image to an available Catalogue Revision." }),
      }),
      headers: z.object({
        range: z.string().optional(),
        "if-range": z.string().optional(),
        "if-none-match": z.string().optional(),
      }),
    },
    responses: {
      ...(method === "head"
        ? Object.fromEntries(
            Object.entries(problemResponses).map(([status, { content: _content, ...response }]) => [status, response]),
          )
        : problemResponses),
      200: {
        description: "Retained Printing Image bytes. HEAD returns metadata only and ignores conditional/range headers.",
        headers: imageHeaders,
        ...content,
      },
      ...(method === "head"
        ? {}
        : {
            206: {
              description: "One satisfiable byte range.",
              headers: imageHeaders,
              ...content,
            },
            304: { description: "Unchanged; no body.", headers: imageHeaders },
            416: {
              description: "Unsatisfiable range.",
              headers: imageHeaders,
              content: problemResponses[400]!.content,
            },
          }),
    },
  });
}
