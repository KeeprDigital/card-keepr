import { createRoute, z } from "@hono/zod-openapi";
import { boundedJson, digest, identifier, problemResponses, secured } from "../../http/openapi";
import { gameProfileRegistrations } from "../adapters";

export const candidateIdentifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/);
export const candidateGeneration = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const candidateGame = z.enum(gameProfileRegistrations().map(({ game }) => game));
export const candidateParams = z.strictObject({ candidate: candidateIdentifier });
const identity = {
  id: candidateIdentifier,
  preparation_id: candidateIdentifier,
  ingestion_run_id: candidateIdentifier,
  supported_game: candidateGame,
  expected_game_revision_id: candidateIdentifier,
  created_at: z.iso.datetime(),
  deadline: z.iso.datetime(),
};
export const candidateStatusSchema = z
  .strictObject({
    contract: z.literal("card-keepr-game-candidate@1"),
    ...identity,
    state: z.enum(["preparing", "paused", "sealed", "failed", "abandoned", "rejected", "expired", "published"]),
    generation: candidateGeneration,
    manifest_digest: digest.nullable(),
    preparation_manifest_digest: digest.nullable(),
    partition_count: candidateGeneration,
    failure_code: identifier.nullable(),
    outcome: z
      .strictObject({
        contract: z.literal("card-keepr-game-reconciliation-outcome@1"),
        preparation_id: candidateIdentifier,
        run_id: candidateIdentifier,
        state: z.literal("failed"),
        publishable: z.literal(false),
        failure_code: identifier,
        diagnostics: z.array(z.strictObject({ code: identifier, detail: z.string() })),
        diagnostics_truncated: z.boolean(),
      })
      .nullable(),
  })
  .openapi("GameCandidateStatus");
export const candidateAcceptanceSchema = z
  .strictObject({
    contract: z.literal("card-keepr-game-preparation-acceptance@1"),
    ...identity,
    action: z.enum(["prepare", "pause", "resume", "abandon"]),
    state: z.literal("accepted"),
    generation: candidateGeneration,
    idempotency_key: candidateIdentifier,
    links: z.strictObject({ status: z.url() }),
  })
  .openapi("GamePreparationAcceptance");
const acceptance = {
  description:
    "Immutable command acceptance, including exact replay. Follow status for current preparation; intake admission does not approve this whole candidate.",
  headers: {
    Location: { required: true, schema: { type: "string" as const } },
    "Retry-After": { required: true, schema: { type: "string" as const } },
    "Cache-Control": { required: true, schema: { type: "string" as const } },
  },
  content: { "application/json": { schema: candidateAcceptanceSchema } },
};
export const createCandidateRoute = createRoute({
  method: "post",
  path: "/v1/game-candidates",
  operationId: "prepareGameCandidate",
  security: secured,
  middleware: [boundedJson],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.strictObject({
            ingestion_run_id: candidateIdentifier,
            supported_game: candidateGame,
            expected_game_revision_id: candidateIdentifier,
            idempotency_key: candidateIdentifier,
          }),
        },
      },
    },
  },
  responses: { 202: acceptance, ...problemResponses },
});
export function candidateActionRoute(action: "pause" | "resume" | "abandon") {
  return createRoute({
    method: "post",
    path: `/v1/game-candidates/{candidate}/${action}`,
    operationId: `${action}GameCandidate`,
    security: secured,
    middleware: [boundedJson],
    request: {
      params: candidateParams,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.strictObject({
              generation: candidateGeneration,
              idempotency_key: candidateIdentifier,
            }),
          },
        },
      },
    },
    responses: { 202: acceptance, ...problemResponses },
  });
}
export const candidateStatusRoute = createRoute({
  method: "get",
  path: "/v1/game-candidates/{candidate}",
  operationId: "getGameCandidate",
  security: secured,
  request: { params: candidateParams },
  responses: {
    200: {
      description:
        "Current candidate facts and preparation outcome; sealing is separate from whole-candidate approval.",
      headers: { "Cache-Control": { required: true, schema: { type: "string" as const } } },
      content: { "application/json": { schema: candidateStatusSchema } },
    },
    ...problemResponses,
  },
});

export const candidateOrdinal = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .refine((value) => Number.isSafeInteger(Number(value)));
export const candidatePinQuery = z.strictObject({ manifest: digest.optional() });
export const candidatePageQuery = candidatePinQuery.extend({ after: z.string().min(1).max(16_384).optional() });
export const candidatePartitionParams = candidateParams.extend({ ordinal: candidateOrdinal });
const partitionHeader = z.strictObject({
  ordinal: candidateGeneration,
  kind: identifier,
  sha256: digest,
  byte_length: candidateGeneration,
  record_count: candidateGeneration,
});
export const candidatePartitionsSchema = z
  .strictObject({
    contract: z.literal("card-keepr-game-candidate-partitions@1"),
    candidate: candidateStatusSchema,
    partitions: z.array(partitionHeader).max(100),
    next_cursor: z.string().nullable(),
  })
  .openapi("GameCandidatePartitions");
export const candidateListSchema = z
  .strictObject({
    contract: z.literal("card-keepr-collection-game-candidates@1"),
    ingestion_run_id: candidateIdentifier,
    candidates: z
      .array(candidateStatusSchema.omit({ contract: true, outcome: true, preparation_manifest_digest: true }))
      .max(100),
    next_cursor: candidateIdentifier.nullable(),
  })
  .openapi("CollectionGameCandidates");
export const candidateProgressSchema = z
  .strictObject({
    contract: z.literal("card-keepr-game-preparation-progress@1"),
    preparation_id: candidateIdentifier,
    candidate: candidateStatusSchema,
    checkpoint: z
      .strictObject({
        phase: identifier,
        ordinal: candidateGeneration,
        sha256: digest,
        byte_length: candidateGeneration,
      })
      .nullable(),
  })
  .openapi("GamePreparationProgress");
import { inspectionCounts, inspectionIntegrity, candidatePartitionSchema } from "./game-candidate-record-schemas";
import { candidateInputSchema } from "./game-candidate-input-schemas";
import { candidateEvidenceSchema } from "./game-candidate-evidence-schemas";
export { candidatePartitionSchema, candidateInputSchema, candidateEvidenceSchema };
const inspectionIdentity = {
  contract: z.literal("card-keepr-candidate-inspection@1"),
  candidate_id: candidateIdentifier,
  preparation_id: candidateIdentifier,
  manifest_digest: digest.nullable(),
  expected_game_revision_id: candidateIdentifier,
  approval_scope: z.literal("whole_candidate"),
};
export const candidateInspectionSchema = z
  .union([
    z.strictObject({ ...inspectionIdentity, ready: z.literal(false), reason: z.literal("inspection_not_prepared") }),
    z.strictObject({
      ...inspectionIdentity,
      ingestion_run_id: candidateIdentifier,
      deadline: z.iso.datetime(),
      ready: z.boolean(),
      reason: z.enum(["candidate_not_sealed", "candidate_expired", "game_predecessor_changed"]).nullable(),
      integrity: inspectionIntegrity,
      counts: inspectionCounts,
      record_count: candidateGeneration,
      evidence_counts: z.strictObject({
        identity: candidateGeneration,
        admission: candidateGeneration,
        correction: candidateGeneration,
        curated: candidateGeneration,
      }),
    }),
  ])
  .openapi("GameCandidateInspection");
export const candidateInputsSchema = z
  .strictObject({
    contract: z.literal("card-keepr-reconciliation-input-partitions@1"),
    ingestion_run_id: candidateIdentifier,
    preparation_id: candidateIdentifier,
    verified: z.boolean(),
    manifest_digest: digest.nullable(),
    partitions: z.array(partitionHeader).max(100),
    next_cursor: z.string().nullable(),
  })
  .openapi("GameCandidateInputs");
export const candidateTextSchema = z
  .strictObject({
    contract: z.literal("card-keepr-reconciliation-text-chunk@1"),
    ingestion_run_id: candidateIdentifier,
    preparation_id: candidateIdentifier,
    text_sha256: digest,
    ordinal: candidateGeneration,
    content: z.string(),
    sha256: digest,
  })
  .openapi("GameCandidateTextChunk");
const readResponse = <S extends z.ZodType>(schema: S) => ({
  200: {
    description: "Retained candidate inspection with complete pinned provenance and integrity metadata.",
    headers: { "Cache-Control": { required: true, schema: { type: "string" as const } } },
    content: { "application/json": { schema } },
  },
  ...problemResponses,
});
export const candidateListRoute = createRoute({
  method: "get",
  path: "/v1/ingestion-runs/{run}/game-candidates",
  operationId: "listCollectionGameCandidates",
  security: secured,
  request: {
    params: z.strictObject({ run: candidateIdentifier }),
    query: z.strictObject({ after: candidateIdentifier.optional() }),
  },
  responses: readResponse(candidateListSchema),
});
export const candidateProgressRoute = createRoute({
  method: "get",
  path: "/v1/game-candidates/{candidate}/progress",
  operationId: "getGamePreparationProgress",
  security: secured,
  request: { params: candidateParams },
  responses: readResponse(candidateProgressSchema),
});
export const candidateInspectionRoute = createRoute({
  method: "get",
  path: "/v1/game-candidates/{candidate}/inspection",
  operationId: "inspectGameCandidate",
  security: secured,
  request: { params: candidateParams, query: candidatePinQuery },
  responses: readResponse(candidateInspectionSchema),
});
export const candidatePartitionsRoute = createRoute({
  method: "get",
  path: "/v1/game-candidates/{candidate}/partitions",
  operationId: "listGameCandidatePartitions",
  security: secured,
  request: { params: candidateParams, query: candidatePageQuery },
  responses: readResponse(candidatePartitionsSchema),
});
export const candidatePartitionRoute = createRoute({
  method: "get",
  path: "/v1/game-candidates/{candidate}/partitions/{ordinal}",
  operationId: "getGameCandidatePartition",
  security: secured,
  request: { params: candidatePartitionParams, query: candidatePinQuery },
  responses: readResponse(candidatePartitionSchema),
});
export const candidateInputsRoute = createRoute({
  method: "get",
  path: "/v1/game-candidates/{candidate}/inputs",
  operationId: "listGameCandidateInputs",
  security: secured,
  request: {
    params: candidateParams,
    query: z.strictObject({
      after: z
        .string()
        .regex(/^(?:-1|0|[1-9]\d*)$/)
        .optional(),
    }),
  },
  responses: readResponse(candidateInputsSchema),
});
export const candidateInputRoute = createRoute({
  method: "get",
  path: "/v1/game-candidates/{candidate}/inputs/{ordinal}",
  operationId: "getGameCandidateInput",
  security: secured,
  request: { params: candidatePartitionParams },
  responses: readResponse(candidateInputSchema),
});
export const candidateTextRoute = createRoute({
  method: "get",
  path: "/v1/game-candidates/{candidate}/text/{digest}/{ordinal}",
  operationId: "getGameCandidateText",
  security: secured,
  request: { params: candidatePartitionParams.extend({ digest }) },
  responses: readResponse(candidateTextSchema),
});
export const candidateEvidenceRoute = createRoute({
  method: "get",
  path: "/v1/game-candidates/{candidate}/inspection/evidence/{kind}",
  operationId: "getGameCandidateEvidence",
  security: secured,
  request: {
    params: candidateParams.extend({ kind: z.enum(["identity", "admission", "correction", "curated"]) }),
    query: candidatePageQuery,
  },
  responses: readResponse(candidateEvidenceSchema),
});

export const candidateImageRoute = createRoute({
  method: "get",
  path: "/v1/game-candidates/{candidate}/partitions/{ordinal}/images/{record}",
  operationId: "getGameCandidateImage",
  security: secured,
  request: {
    params: candidatePartitionParams.extend({ record: candidateOrdinal }),
    query: candidatePinQuery.extend({ side: z.enum(["before", "after"]).optional() }),
  },
  responses: {
    200: {
      description: "Verified retained Printing Image bytes, streamed without buffering.",
      headers: {
        "Content-Type": { required: true, schema: { type: "string" } },
        "Content-Length": { required: true, schema: { type: "string" } },
        "Cache-Control": { required: true, schema: { type: "string" } },
        ETag: { required: true, schema: { type: "string" } },
      },
      content: Object.fromEntries(
        ["image/avif", "image/gif", "image/jpeg", "image/jpg", "image/png", "image/webp"].map((media) => [
          media,
          { schema: z.string().openapi({ format: "binary" }) },
        ]),
      ),
    },
    ...problemResponses,
  },
});
