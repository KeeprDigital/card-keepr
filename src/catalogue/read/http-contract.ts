import { createRoute, z } from "@hono/zod-openapi";
import { identifier, digest, problemResponses, revisionResponseHeaders, secured } from "../../http/openapi";

import { registeredGameProfiles, requiredProfileContract } from "../shared";

// Project the profile's declared primitives into wire schemas. The profile's
// semantic validators and all persisted-document validators remain independent.
type ProfileSchema = ReturnType<typeof requiredProfileContract>["card"]["properties"][string];
export function profileWire(schema: ProfileSchema): z.ZodType {
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
export const profiles = registeredGameProfiles();
export const supportedGame = z.enum(profiles.map(({ game }) => game));
const gameData = z.union(
  profiles.map(({ id }) =>
    z.strictObject({ profile: z.literal(id), attributes: profileWire(requiredProfileContract(id).card) }),
  ),
);
const artGameData = z.union(
  profiles.map(({ id }) => z.strictObject({ profile: z.literal(id), attributes: z.strictObject({}) })),
);
const cardCategory = z.enum(["gameplay", "token", "art"]);
const officialIdentity = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("card_number"), value: identifier }),
  z.strictObject({ kind: z.literal("publisher_name"), value: identifier }),
  z.strictObject({ kind: z.literal("functional_designation"), value: z.literal("DON!!") }),
  z.strictObject({ kind: z.literal("unknown"), value: z.null() }),
]);
export const link = z.strictObject({ self: z.url() });
const cardFields = {
  type: z.literal("card"),
  id: identifier,
  game: supportedGame,
  official_identity: officialIdentity,
  name: identifier,
  related_cards: z.array(z.strictObject({ kind: z.literal("shared_artwork"), card_id: identifier })).max(8),
  lifecycle: z.strictObject({
    first_revision_id: identifier,
    last_observed_revision_id: identifier,
    withdrawn: z.boolean(),
    withdrawal: z.strictObject({ revision_id: identifier }).nullable().optional(),
  }),
  links: link,
};
export const cardCollectionSchema = z
  .strictObject({
    data: z.array(
      z.union([
        z.strictObject({
          ...cardFields,
          category: z.enum(["gameplay", "token"]),
          gameplay_applicability: z.literal("applicable"),
          game_data: gameData,
        }),
        z.strictObject({
          ...cardFields,
          category: z.literal("art"),
          gameplay_applicability: z.literal("inapplicable"),
          game_data: artGameData,
        }),
      ]),
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
  category: cardCategory
    .optional()
    .openapi({ description: "Select one Card category. All categories are visible by default." }),
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

const profileFieldSchema = z.strictObject({
  path: identifier,
  type: z.enum(["string", "integer", "boolean", "enum"]),
  nullable: z.boolean(),
  multiple: z.boolean(),
  values: z.array(z.string()).optional(),
});
export function profileFields(
  schema: ProfileSchema,
  prefix = "",
  multiple = false,
): z.infer<typeof profileFieldSchema>[] {
  if (schema.kind === "array") return profileFields(schema.items, prefix, true);
  if (schema.kind === "object")
    return Object.entries(schema.properties).flatMap(([key, value]) =>
      profileFields(value, prefix ? `${prefix}.${key}` : key, multiple),
    );
  return [
    {
      path: prefix,
      type: schema.kind,
      nullable: "nullable" in schema && schema.nullable === true,
      multiple,
      ...(schema.kind === "enum" ? { values: [...schema.values] } : {}),
    },
  ];
}
export const gamesSchema = z
  .strictObject({
    data: z.array(
      z.strictObject({
        type: z.literal("supported_game"),
        id: identifier,
        key: supportedGame,
        name: identifier,
        supported_locales: z.array(z.enum(["EN", "EN-OCEANIA", "EN-ASIA", "EN-US"])),
        game_profile: z.strictObject({
          id: z.enum(profiles.map(({ id }) => id)),
          card_fields: z.array(profileFieldSchema),
          printing_fields: z.array(profileFieldSchema),
        }),
        filters: z.strictObject({
          cards: z.array(identifier),
          printings: z.array(identifier),
          products: z.array(identifier),
        }),
        links: z.strictObject({ cards: z.url(), printings: z.url(), products: z.url() }),
      }),
    ),
    meta: z.strictObject({ catalogue_revision_id: identifier, published_at: identifier }),
    links: link,
  })
  .openapi("PublishedGames");
export const gamesRoute = createRoute({
  method: "get",
  path: "/v1/games",
  operationId: "listPublishedGames",
  security: secured,
  request: { query: z.strictObject({}), headers: z.object({ "if-none-match": z.string().optional() }) },
  responses: {
    200: {
      description: "Games present in the published catalogue.",
      headers: revisionResponseHeaders,
      content: { "application/json": { schema: gamesSchema } },
    },
    304: { description: "Unchanged published discovery; no body.", headers: revisionResponseHeaders },
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

export const meta = cardCollectionSchema.shape.meta;
const cardDetailData = z.union(
  cardCollectionSchema.shape.data.element.options.map((schema) =>
    schema.extend({
      effective_rules_text: schema.shape.category.safeParse("art").success ? z.null() : z.string().nullable(),
      printing_ids: z.array(identifier),
    }),
  ),
);
const identityCorrection = z.strictObject({
  type: z.literal("identity_correction"),
  id: identifier,
  game: supportedGame,
  entity_kind: z.enum(["card", "printing"]),
  action: z.enum(["merge", "split"]),
  replacement_ids: z.array(identifier),
  links: z.union([z.strictObject({ survivor: z.url() }), z.strictObject({ replacements: z.array(z.url()) })]),
});
export const printingSchema = z
  .strictObject({
    type: z.literal("printing"),
    id: identifier,
    card_id: identifier,
    category: cardCategory,
    gameplay_applicability: z.enum(["applicable", "inapplicable"]),
    rarity: z.strictObject({ normalized: z.string().nullable(), raw: z.string().nullable() }),
    printed_rules_text: z.string().nullable(),
    game_data: z
      .union(
        profiles.map(({ id }) =>
          z.strictObject({ profile: z.literal(id), attributes: profileWire(requiredProfileContract(id).printing) }),
        ),
      )
      .nullable(),
    printing_images: z.array(
      z.strictObject({
        id: identifier,
        role: z.enum(["front", "back", "other"]),
        media_type: z.string().regex(/^image\//),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        content_sha256: digest,
        content_byte_length: z.number().int().nonnegative(),
        links: z.strictObject({ content: z.url() }),
      }),
    ),
    products: z.array(
      z.strictObject({ id: identifier, official_code: z.string().nullable(), name: z.string().nullable() }),
    ),
    distribution_contexts: z.array(
      z.strictObject({
        id: identifier,
        kind: identifier,
        label: z.string().nullable(),
        product_id: identifier.nullable(),
      }),
    ),
    lifecycle: cardFields.lifecycle,
    links: link,
  })
  .openapi("Printing");
export const cardDetailSchema = z
  .strictObject({
    data: z.union([cardDetailData, identityCorrection]),
    included: z.array(printingSchema).optional(),
    meta,
    links: link,
  })
  .openapi("CardDocument");
export const catalogueSchema = z
  .strictObject({
    data: z.strictObject({
      type: z.literal("catalogue"),
      current_revision_id: identifier,
      published_at: identifier,
      current_export: z.url(),
    }),
    meta,
    links: z.strictObject({
      self: z.url(),
      cards: z.url(),
      printings: z.url(),
      products: z.url(),
      catalogue_exports: z.url(),
      games: z.url(),
    }),
  })
  .openapi("CatalogueDocument");
export const catalogueRoute = createRoute({
  method: "get",
  path: "/v1/catalogue",
  operationId: "getCatalogue",
  security: secured,
  request: { query: z.strictObject({}), headers: z.object({ "if-none-match": z.string().optional() }) },
  responses: {
    200: {
      description: "Current Catalogue Revision and consumer links.",
      headers: revisionResponseHeaders,
      content: { "application/json": { schema: catalogueSchema } },
    },
    304: { description: "Unchanged catalogue; no body.", headers: revisionResponseHeaders },
    ...problemResponses,
  },
});
export const cardDetailRoute = createRoute({
  method: "get",
  path: "/v1/cards/{card}",
  operationId: "getCard",
  security: secured,
  request: {
    params: z.strictObject({ card: identifier }),
    query: z.strictObject({ include: z.literal("printings").optional(), revision: identifier.optional() }),
    headers: z.object({ "if-none-match": z.string().optional() }),
  },
  responses: {
    200: {
      description: "Published Card or retained identity correction.",
      headers: revisionResponseHeaders,
      content: { "application/json": { schema: cardDetailSchema } },
    },
    304: { description: "Unchanged validated detail; no body.", headers: revisionResponseHeaders },
    ...problemResponses,
  },
});

export const printingQuerySchema = cardQuerySchema.pick({
  category: true,
  game: true,
  card_id: true,
  rarity: true,
  product_id: true,
  release_region: true,
  limit: true,
  after: true,
  revision: true,
});
export const productQuerySchema = cardQuerySchema.pick({
  q: true,
  game: true,
  release_region: true,
  limit: true,
  after: true,
  revision: true,
});
export const printingCollectionSchema = z
  .strictObject({ data: z.array(printingSchema), meta, page: cardCollectionSchema.shape.page, links: link })
  .openapi("PrintingCollection");
export const printingDetailSchema = z
  .strictObject({ data: z.union([printingSchema, identityCorrection]), meta, links: link })
  .openapi("PrintingDocument");
export const productSchema = z
  .strictObject({
    type: z.literal("product"),
    id: identifier,
    game: supportedGame,
    official_code: z.string().nullable(),
    name: z.string().nullable(),
    releases: z.array(
      z.strictObject({
        id: identifier,
        event_key: identifier,
        region: z.enum(["EN-OCEANIA", "EN-ASIA", "EN-US", "unknown"]),
        date: z.strictObject({
          precision: z.enum(["day", "month", "quarter", "season", "year", "unknown"]).nullable(),
          value: z.string().nullable(),
        }),
        status: z.enum(["announced", "released"]).nullable(),
      }),
    ),
    lifecycle: cardFields.lifecycle,
    links: link,
  })
  .openapi("Product");
export const productCollectionSchema = z
  .strictObject({ data: z.array(productSchema), meta, page: cardCollectionSchema.shape.page, links: link })
  .openapi("ProductCollection");
export const productDetailSchema = z
  .strictObject({ data: productSchema, meta, links: link })
  .openapi("ProductDocument");
export const printingsRoute = createRoute({
  method: "get",
  path: "/v1/printings",
  operationId: "listPrintings",
  security: secured,
  request: { query: printingQuerySchema, headers: z.object({ "if-none-match": z.string().optional() }) },
  responses: {
    200: {
      description: "Published Printings pinned to one composition.",
      headers: revisionResponseHeaders,
      content: { "application/json": { schema: printingCollectionSchema } },
    },
    304: { description: "Unchanged validated query; no body.", headers: revisionResponseHeaders },
    ...problemResponses,
  },
});
export const printingDetailRoute = createRoute({
  method: "get",
  path: "/v1/printings/{printing}",
  operationId: "getPrinting",
  security: secured,
  request: {
    params: z.strictObject({ printing: identifier }),
    query: z.strictObject({ revision: identifier.optional() }),
    headers: z.object({ "if-none-match": z.string().optional() }),
  },
  responses: {
    200: {
      description: "Published Printing or retained identity correction.",
      headers: revisionResponseHeaders,
      content: { "application/json": { schema: printingDetailSchema } },
    },
    304: { description: "Unchanged validated detail; no body.", headers: revisionResponseHeaders },
    ...problemResponses,
  },
});
export const productsRoute = createRoute({
  method: "get",
  path: "/v1/products",
  operationId: "listProducts",
  security: secured,
  request: { query: productQuerySchema, headers: z.object({ "if-none-match": z.string().optional() }) },
  responses: {
    200: {
      description: "Published Products and Releases pinned to one composition.",
      headers: revisionResponseHeaders,
      content: { "application/json": { schema: productCollectionSchema } },
    },
    304: { description: "Unchanged validated query; no body.", headers: revisionResponseHeaders },
    ...problemResponses,
  },
});
export const productDetailRoute = createRoute({
  method: "get",
  path: "/v1/products/{product}",
  operationId: "getProduct",
  security: secured,
  request: {
    params: z.strictObject({ product: identifier }),
    query: z.strictObject({ revision: identifier.optional() }),
    headers: z.object({ "if-none-match": z.string().optional() }),
  },
  responses: {
    200: {
      description: "Published Product and Releases.",
      headers: revisionResponseHeaders,
      content: { "application/json": { schema: productDetailSchema } },
    },
    304: { description: "Unchanged validated detail; no body.", headers: revisionResponseHeaders },
    ...problemResponses,
  },
});
