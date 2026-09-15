import { createRoute, z } from "@hono/zod-openapi";
import { boundedJson, digest, identifier, problemResponses, secured } from "../../http/openapi";
import { sourceValue } from "../shared";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const workflowIdentifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/);
const runParams = z.strictObject({ run: identifier });
const headers = { "Cache-Control": { required: true, schema: { type: "string" as const } } };
const historical = {
  tags: ["Historical run reconciliation"],
  description:
    "Retained aggregate preparation and replay. Ordinary per-game preparation uses /v1/game-candidates and separate whole-candidate publication.",
  security: secured,
};
export const retainedReconciliationStatusSchema = z
  .strictObject({
    contract: z.literal("card-keepr-reconciliation-status@1"),
    reconciliation_id: identifier,
    ingestion_run_id: identifier,
    state: z.enum(["preparing", "paused", "sealed", "failed", "abandoned"]),
    generation: count,
    created_at: z.iso.datetime(),
    deadline: z.iso.datetime(),
    completed_partitions: count,
    completed_batches: count,
    completed_input_partitions: count,
    completed_documents: count,
    completed_reducer_records: count,
    completed_observations: count,
    admission_selection_pinned: z.union([z.literal(0), z.literal(1)]),
    admission_decision_count: count,
    candidate_digest: digest.nullable(),
    manifest_digest: digest.nullable(),
    input_manifest_digest: digest.nullable(),
    failure_code: identifier.nullable(),
    definition_pins_json: z.string(),
    observation_cutoff: count,
    identity_decision_cutoff: count,
    authority_decision_cutoff: count,
    candidates: z.array(
      z.strictObject({
        id: identifier,
        preparation_id: identifier,
        ingestion_run_id: identifier,
        supported_game: identifier,
        expected_game_revision_id: identifier,
        state: z.enum(["preparing", "paused", "sealed", "failed", "abandoned", "rejected", "expired", "published"]),
        generation: count,
        created_at: z.iso.datetime(),
        deadline: z.iso.datetime(),
        manifest_digest: digest.nullable(),
        preparation_manifest_digest: digest.nullable(),
        partition_count: count,
      }),
    ),
    checkpoints: z.array(
      z.strictObject({
        phase: identifier,
        ordinal: count,
        cursor: z.record(z.string(), sourceValue).openapi({
          description: "Decoded retained phase cursor; phase-owned fields preserve their original JSON values.",
        }),
        sha256: digest,
      }),
    ),
  })
  .openapi("RetainedReconciliationStatus");

export const retainedReconciliationActionRoutes = (["pause", "resume", "abandon"] as const).map((action) => ({
  action,
  definition: createRoute({
    ...historical,
    method: "post",
    path: `/v1/ingestion-runs/{run}/reconciliation/${action}`,
    operationId: `${action}RetainedRunReconciliation`,
    middleware: [boundedJson],
    request: {
      params: runParams,
      body: {
        required: true,
        content: { "application/json": { schema: z.strictObject({ generation: count, idempotency_key: identifier }) } },
      },
    },
    responses: {
      200: {
        description:
          "Original immutable action receipt, including exact replay after later state or deadline changes. Generation is the numeric retained intent.",
        headers,
        content: { "application/json": { schema: retainedReconciliationStatusSchema } },
      },
      ...problemResponses,
    },
  }),
}));

import {
  pendingRetainedWorkflowSchema,
  retainedWorkflowSchema,
  retainedInputListSchema,
  retainedInputSchema,
  retainedPartitionListSchema,
  retainedPartitionSchema,
  retainedTextSchema,
} from "./retained-reconciliation-schemas";
export {
  pendingRetainedWorkflowSchema,
  retainedWorkflowSchema,
  retainedInputListSchema,
  retainedInputSchema,
  retainedPartitionListSchema,
  retainedPartitionSchema,
  retainedTextSchema,
};
const readResponse = <S extends z.ZodType>(schema: S) => ({
  200: {
    description: "Retained historical inspection; this does not approve or publish a per-game candidate.",
    headers,
    content: { "application/json": { schema } },
  },
  ...problemResponses,
});
const ordinal = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .refine((value) => Number.isSafeInteger(Number(value)));
const page = z.strictObject({
  after: z
    .string()
    .regex(/^(?:-1|0|[1-9]\d*)$/)
    .refine((value) => Number.isSafeInteger(Number(value)))
    .optional(),
});
export const retainedReconciliationStatusRoute = createRoute({
  ...historical,
  method: "get",
  path: "/v1/ingestion-runs/{run}/reconciliation",
  operationId: "getRetainedRunReconciliation",
  request: { params: runParams },
  responses: readResponse(retainedReconciliationStatusSchema),
});
export const retainedReconciliationStartRoute = createRoute({
  ...historical,
  method: "post",
  path: "/v1/ingestion-runs/{run}/reconciliation",
  operationId: "startRetainedRunReconciliation",
  middleware: [boundedJson],
  request: {
    params: z.strictObject({ run: workflowIdentifier }),
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.strictObject({
            expected_current_revision_id: workflowIdentifier,
            idempotency_key: workflowIdentifier,
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description:
        "Current observed Workflow status for exact replay, or a result already complete during creation. Immutable result binding stays verified.",
      headers,
      content: { "application/json": { schema: retainedWorkflowSchema } },
    },
    202: {
      description:
        "New request with a non-complete Workflow observation; acknowledgement does not imply reconciliation succeeded.",
      headers,
      content: { "application/json": { schema: pendingRetainedWorkflowSchema } },
    },
    ...problemResponses,
  },
});
export const retainedInputListRoute = createRoute({
  ...historical,
  method: "get",
  path: "/v1/ingestion-runs/{run}/reconciliation/inputs",
  operationId: "listRetainedRunReconciliationInputs",
  request: { params: runParams, query: page },
  responses: readResponse(retainedInputListSchema),
});
export const retainedInputRoute = createRoute({
  ...historical,
  method: "get",
  path: "/v1/ingestion-runs/{run}/reconciliation/inputs/{ordinal}",
  operationId: "getRetainedRunReconciliationInput",
  request: { params: runParams.extend({ ordinal }) },
  responses: readResponse(retainedInputSchema),
});
export const retainedPartitionListRoute = createRoute({
  ...historical,
  method: "get",
  path: "/v1/ingestion-runs/{run}/reconciliation/partitions",
  operationId: "listRetainedRunReconciliationPartitions",
  request: { params: runParams, query: page },
  responses: readResponse(retainedPartitionListSchema),
});
export const retainedPartitionRoute = createRoute({
  ...historical,
  method: "get",
  path: "/v1/ingestion-runs/{run}/reconciliation/partitions/{ordinal}",
  operationId: "getRetainedRunReconciliationPartition",
  request: { params: runParams.extend({ ordinal }) },
  responses: readResponse(retainedPartitionSchema),
});
export const retainedTextRoute = createRoute({
  ...historical,
  method: "get",
  path: "/v1/ingestion-runs/{run}/reconciliation/text/{digest}/{ordinal}",
  operationId: "getRetainedRunReconciliationText",
  request: { params: runParams.extend({ ordinal, digest }) },
  responses: readResponse(retainedTextSchema),
});
