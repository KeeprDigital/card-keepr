import { createRoute, z } from "@hono/zod-openapi";
import { boundedJson, identifier, problemResponses, secured } from "../../http/openapi";

const count = z.number().int().nonnegative();
const timestamp = z.string().datetime();
export const cleanupSchema = z
  .strictObject({
    scope: z.enum(["capture", "staging"]),
    preparation_id: identifier.nullable(),
    id: identifier,
    ingestion_run_id: identifier,
    idempotency_key: identifier,
    retention_days: z.number().int().min(1).max(36500),
    terminal_at: timestamp,
    eligible_at: timestamp,
    created_at: timestamp,
    completed_at: timestamp.nullable(),
    last_attempt_at: timestamp.nullable(),
    state: z.enum(["pending", "running", "paused", "completed"]),
    cursor: z.string(),
    retry_cursor: z.string(),
    deleted_objects: count,
    protected_objects: count,
    generation: count,
    failure_code: identifier.nullable(),
  })
  .openapi("EvidenceCleanup");
export const cleanupObjectsSchema = z
  .strictObject({
    objects: z
      .array(
        z.strictObject({
          object_key: identifier,
          state: z.enum(["deleted", "protected", "waiting"]),
          reason: identifier.nullable(),
        }),
      )
      .max(50),
    next_after: identifier.nullable(),
  })
  .openapi("EvidenceCleanupObjects");
const response = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  headers: { "Cache-Control": { required: true, schema: { type: "string" as const } } },
  content: { "application/json": { schema } },
});
const body = <T extends z.ZodType>(schema: T) => ({ required: true, content: { "application/json": { schema } } });
const cleanupParams = z.strictObject({ cleanup: identifier });
const startBody = body(
  z.strictObject({ idempotency_key: identifier, retention_days: z.number().int().min(1).max(36500).optional() }),
);
const accepted = response(
  cleanupSchema,
  "Current cleanup state after exact original owner, scope and retention matching. Replay never renews eligibility.",
);
export const captureCleanupRoute = createRoute({
  method: "post",
  path: "/v1/ingestion-runs/{run}/evidence-cleanup",
  operationId: "startEvidenceCleanup",
  security: secured,
  middleware: [boundedJson],
  request: { params: z.strictObject({ run: identifier }), body: startBody },
  responses: { 202: accepted, ...problemResponses },
});
export const stagingCleanupRoute = createRoute({
  method: "post",
  path: "/v1/reconciliation-operations/{preparation}/evidence-cleanup",
  operationId: "startStagingCleanup",
  security: secured,
  middleware: [boundedJson],
  request: { params: z.strictObject({ preparation: identifier }), body: startBody },
  responses: { 202: accepted, ...problemResponses },
});
export const retryCleanupRoute = createRoute({
  method: "post",
  path: "/v1/evidence-cleanups/{cleanup}/retry",
  operationId: "retryEvidenceCleanup",
  security: secured,
  middleware: [boundedJson],
  request: { params: cleanupParams, body: body(z.strictObject({ expected_generation: count })) },
  responses: { 202: accepted, ...problemResponses },
});
export const inspectCleanupRoute = createRoute({
  method: "get",
  path: "/v1/evidence-cleanups/{cleanup}",
  operationId: "inspectEvidenceCleanup",
  security: secured,
  request: { params: cleanupParams },
  responses: { 200: response(cleanupSchema, "Current cleanup state."), ...problemResponses },
});
export const cleanupObjectsRoute = createRoute({
  method: "get",
  path: "/v1/evidence-cleanups/{cleanup}/objects",
  operationId: "inspectEvidenceCleanupObjects",
  security: secured,
  request: { params: cleanupParams, query: z.strictObject({ after: z.string().optional() }) },
  responses: {
    200: response(cleanupObjectsSchema, "Bounded results after the literal object key, in key order."),
    ...problemResponses,
  },
});
export const advanceCleanupRoute = createRoute({
  method: "post",
  path: "/v1/evidence-cleanups/{cleanup}/advance",
  operationId: "advanceEvidenceCleanup",
  security: secured,
  middleware: [boundedJson],
  request: { params: cleanupParams, body: body(z.strictObject({})) },
  responses: {
    200: response(cleanupSchema, "Current state after one bounded, reference-guarded cleanup unit."),
    ...problemResponses,
  },
});
