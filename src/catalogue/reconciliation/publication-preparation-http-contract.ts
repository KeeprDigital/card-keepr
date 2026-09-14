import { createRoute, z } from "@hono/zod-openapi";
import { boundedJson, digest, identifier, problemResponses, secured } from "../../http/openapi";

const count = z.number().int().nonnegative();
const preparationState = z.enum(["preparing", "verified", "retry_paused", "failed"]);
export const publicationPreparationSchema = z
  .strictObject({
    contract: z.literal("card-keepr-publication-preparation@1"),
    candidate_id: identifier,
    manifest_digest: digest,
    generation: count,
    sequence: count,
    state: preparationState,
    phase: z.enum(["images", "exports", "projections", "composition"]),
    failures: count,
    failure_code: identifier.nullable(),
    artifact_count: count,
    root_digest: digest.nullable(),
    created_at: identifier,
    preparation_id: identifier,
    ingestion_run_id: identifier,
    supported_game: identifier,
    expected_game_revision_id: identifier,
    deadline: identifier,
    progress: z.strictObject({
      partition: count,
      record: count,
      subrecord: count.optional(),
      text: count,
      chunk: count,
      chain: digest,
      search_offset: count.optional(),
      search_ordinal: count.optional(),
      text_hash: z
        .strictObject({
          words: z.array(z.number().int()).length(8),
          pending: z.array(z.number().int().min(0).max(255)).max(63),
          bytes: z.string().regex(/^\d+$/),
        })
        .optional(),
      text_bytes: count.optional(),
      level: count,
      after: z.number().int().min(-1),
      node: count,
    }),
  })
  .openapi("PublicationPreparation");

export const publicationPreparationIntentSchema = z.strictObject({
  manifest_digest: digest,
  generation: count,
  sequence: count,
  idempotency_key: identifier,
  resume: z.boolean().optional(),
});
export const advancePublicationPreparationRoute = createRoute({
  method: "post",
  path: "/v1/game-candidates/{candidate}/publication-preparation",
  operationId: "advancePublicationPreparation",
  security: secured,
  middleware: [boundedJson],
  request: {
    params: z.strictObject({ candidate: identifier }),
    body: { required: true, content: { "application/json": { schema: publicationPreparationIntentSchema } } },
  },
  responses: {
    200: {
      description:
        "One bounded artifact preparation unit. Exact replay returns its original checkpoint; inspect status separately.",
      content: { "application/json": { schema: publicationPreparationSchema } },
    },
    ...problemResponses,
  },
});

export const publicationPreparationAcceptanceSchema = z
  .strictObject({
    ...publicationPreparationSchema.shape,
    contract: z.literal("card-keepr-publication-preparation-acceptance@1"),
    links: z.strictObject({ status: z.url() }),
  })
  .openapi("PublicationPreparationAcceptance");
export const publicationPreparationStatusRoute = createRoute({
  method: "get",
  path: "/v1/game-candidates/{candidate}/publication-preparation",
  operationId: "getPublicationPreparation",
  security: secured,
  request: { params: z.strictObject({ candidate: identifier }) },
  responses: {
    200: {
      description:
        "Current artifact state, independent of candidate approval, publication and Backup Attempt verification.",
      content: { "application/json": { schema: publicationPreparationSchema } },
    },
    ...problemResponses,
  },
});
export const publicationPreparationDispatchRoutes = (["start", "resume"] as const).map((action) =>
  createRoute({
    method: "post",
    path: `/v1/game-candidates/{candidate}/publication-preparation/${action}`,
    operationId: action === "start" ? "startPublicationPreparation" : "resumePublicationPreparation",
    security: secured,
    middleware: [boundedJson],
    request: {
      params: z.strictObject({ candidate: identifier }),
      body: {
        required: true,
        content: {
          "application/json": {
            schema:
              action === "resume"
                ? publicationPreparationIntentSchema.extend({ resume: z.literal(true).optional() })
                : publicationPreparationIntentSchema,
          },
        },
      },
    },
    responses: {
      202: {
        description:
          "Original immutable artifact action acknowledgement, including on replay. Read status for current progress or dispatch failure; acceptance does not establish verified artifacts or publication.",
        headers: {
          Location: { required: true, schema: { type: "string" } },
          "Retry-After": { required: true, schema: { type: "string" } },
          "Cache-Control": { required: true, schema: { type: "string" } },
        },
        content: { "application/json": { schema: publicationPreparationAcceptanceSchema } },
      },
      ...problemResponses,
    },
  }),
);

export const publicationArtifactsSchema = z
  .strictObject({
    contract: z.literal("card-keepr-publication-artifacts@1"),
    candidate_id: identifier,
    manifest_digest: digest,
    artifacts: z
      .array(
        z.strictObject({
          ordinal: count,
          object_key: identifier,
          sha256: digest,
          byte_length: count,
          kind: identifier,
          reused: z.union([z.literal(0), z.literal(1)]),
        }),
      )
      .max(32),
    next_cursor: z.string().regex(/^\d+$/).nullable(),
  })
  .openapi("PublicationArtifacts");
export const publicationArtifactsRoute = createRoute({
  method: "get",
  path: "/v1/game-candidates/{candidate}/publication-preparation/artifacts",
  operationId: "getPublicationArtifacts",
  security: secured,
  request: {
    params: z.strictObject({ candidate: identifier }),
    query: z.strictObject({
      after: z
        .string()
        .regex(/^(?:-1|0|[1-9][0-9]*)$/)
        .refine((value) => Number.isSafeInteger(Number(value)))
        .optional(),
    }),
  },
  responses: {
    200: {
      description: "At most 32 verified artifact references and the next ordinal cursor.",
      content: { "application/json": { schema: publicationArtifactsSchema } },
    },
    ...problemResponses,
  },
});

const preparedQueryInput = z
  .strictObject({
    kind: z
      .enum([
        "selected_games",
        "cards",
        "printings",
        "printing_images",
        "products",
        "releases",
        "distribution_contexts",
        "errata",
        "relationships",
        "product_relationships",
        "identity_corrections",
        "game_profiles",
      ])
      .optional(),
    after: z.string().max(200).optional(),
    q: z
      .string()
      .refine((value) => [...value].length <= 500)
      .openapi({ maxLength: 500 })
      .optional(),
  })
  .refine((value) => value.q === undefined || (value.kind ?? "cards") === "cards", {
    path: ["q"],
    message: "Search is available for Cards only.",
  });
export const preparedQuerySchema = z
  .strictObject({
    contract: z.literal("card-keepr-prepared-query@1"),
    candidate_id: identifier,
    manifest_digest: digest,
    state: preparationState,
    // These are private, kind-specific prepared projections, including text
    // references. Retained/domain validation owns their catalogue semantics.
    records: z
      .array(
        z.strictObject({
          value: z.record(z.string(), z.unknown()),
          text_parts: z.array(
            z.strictObject({
              path: z.array(z.union([z.string(), count])),
              sha256: digest,
              chunks: count,
              byte_length: count,
            }),
          ),
        }),
      )
      .max(32)
      .refine(
        (records) =>
          records.reduce((bytes, record) => bytes + new TextEncoder().encode(JSON.stringify(record)).byteLength, 0) <=
          524288,
      )
      .describe("Prepared projection objects, at most 32 and 512 KiB of serialized records in total."),
    next_cursor: identifier.nullable(),
  })
  .openapi("PreparedPublicationQuery");
export const preparedQueryRoute = createRoute({
  method: "get",
  path: "/v1/game-candidates/{candidate}/publication-preparation/query",
  operationId: "queryPreparedPublication",
  security: secured,
  request: { params: z.strictObject({ candidate: identifier }), query: preparedQueryInput },
  responses: {
    200: {
      description: "Bounded private projections; preparing these does not publish them.",
      content: { "application/json": { schema: preparedQuerySchema } },
    },
    ...problemResponses,
  },
});
export const publicationCompositionSchema = z
  .strictObject({
    contract: z.literal("card-keepr-prepared-publication-composition@1"),
    games: z
      .array(
        z.strictObject({
          supported_game: identifier,
          candidate_id: identifier,
          root_digest: digest,
          public_root_digest: digest.optional(),
        }),
      )
      .min(1)
      .max(5),
    root_digest: digest,
    object_key: identifier,
    byte_length: count.max(16384),
  })
  .openapi("PreparedPublicationComposition");
export const publicationCompositionRoute = createRoute({
  method: "post",
  path: "/v1/publication-compositions",
  operationId: "preparePublicationComposition",
  security: secured,
  middleware: [boundedJson],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.strictObject({
            candidate_ids: z
              .array(identifier)
              .min(1)
              .max(5)
              .refine((ids) => new Set(ids).size === ids.length),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Verified component references in canonical game order, without switching published visibility.",
      content: { "application/json": { schema: publicationCompositionSchema } },
    },
    ...problemResponses,
  },
});
