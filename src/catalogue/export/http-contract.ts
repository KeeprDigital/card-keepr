import { createRoute, z } from "@hono/zod-openapi";
import { boundedJson, digest, identifier, problemResponses, secured } from "../../http/openapi";

const timestamp = z.string().datetime();
export const exportDeletionPlanSchema = z
  .strictObject({
    contract: z.literal("card-keepr-catalogue-export-deletion-plan@1"),
    id: identifier,
    catalogue_revision_id: identifier,
    manifest_digest: digest,
    expected_current_revision_id: identifier,
    object_keys: z.array(identifier),
    object_set_digest: digest,
    dependencies: z.array(
      z.strictObject({ code: identifier, severity: z.enum(["warning", "blocking"]), detail: identifier }),
    ),
    created_at: timestamp,
    expires_at: timestamp,
    plan_digest: digest,
  })
  .openapi("CatalogueExportDeletionPlan");
const fields = {
  contract: z.literal("card-keepr-catalogue-export-deletion@1"),
  id: identifier,
  plan_id: identifier,
  catalogue_revision_id: identifier,
  manifest_digest: digest,
  expected_current_revision_id: identifier,
  object_set_digest: digest,
  idempotency_key: identifier,
  requested_at: timestamp,
};
export const exportDeletionPendingSchema = z.strictObject({
  ...fields,
  state: z.literal("deleting"),
  completed_at: z.null(),
  failure_code: z.null(),
});
export const exportDeletionTerminalSchema = z.discriminatedUnion("state", [
  z.strictObject({ ...fields, state: z.literal("deleted"), completed_at: timestamp, failure_code: z.null() }),
  z.strictObject({ ...fields, state: z.literal("failed"), completed_at: z.null(), failure_code: identifier }),
]);
export const exportDeletionSchema = z
  .union([exportDeletionPendingSchema, exportDeletionTerminalSchema])
  .openapi("CatalogueExportDeletion");
const response = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  headers: { "Cache-Control": { required: true, schema: { type: "string" as const } } },
  content: { "application/json": { schema } },
});
const body = <T extends z.ZodType>(schema: T) => ({ required: true, content: { "application/json": { schema } } });
const planFields = {
  catalogue_revision_id: identifier,
  manifest_digest: digest,
  expected_current_revision_id: identifier,
  plan_id: identifier,
};
const attemptResponses = {
  200: response(
    exportDeletionTerminalSchema,
    "Original terminal attempt receipt, including exact replay after a later retry.",
  ),
  202: response(
    exportDeletionPendingSchema,
    "Original pending attempt acknowledgement, including exact replay after execution finishes. Use GET /v1/catalogue-export-deletions/{deletion} for current state.",
  ),
  ...problemResponses,
};
export const planExportDeletionRoute = createRoute({
  method: "post",
  path: "/v1/catalogue-export-deletion-plans",
  operationId: "prepareCatalogueExportDeletion",
  security: secured,
  middleware: [boundedJson],
  request: { body: body(z.strictObject(planFields)) },
  responses: {
    201: response(
      exportDeletionPlanSchema,
      "New exact object-set plan. Reusing a plan identity conflicts; planning is not idempotent.",
    ),
    ...problemResponses,
  },
});
export const confirmExportDeletionRoute = createRoute({
  method: "post",
  path: "/v1/catalogue-export-deletions",
  operationId: "confirmCatalogueExportDeletion",
  security: secured,
  middleware: [boundedJson],
  request: {
    body: body(
      z.strictObject({
        ...planFields,
        plan_digest: digest,
        confirmation_revision_id: identifier,
        deletion_id: identifier,
        idempotency_key: identifier,
      }),
    ),
  },
  responses: attemptResponses,
});
export const retryExportDeletionRoute = createRoute({
  method: "post",
  path: "/v1/catalogue-export-deletions/{deletion}/retry",
  operationId: "retryCatalogueExportDeletion",
  security: secured,
  middleware: [boundedJson],
  request: {
    params: z.strictObject({ deletion: identifier }),
    body: body(z.strictObject({ object_set_digest: digest, idempotency_key: identifier })),
  },
  responses: attemptResponses,
});
export const inspectExportDeletionRoute = createRoute({
  method: "get",
  path: "/v1/catalogue-export-deletions/{deletion}",
  operationId: "inspectCatalogueExportDeletion",
  security: secured,
  request: { params: z.strictObject({ deletion: identifier }) },
  responses: {
    200: response(exportDeletionSchema, "Current deletion state, independent of each immutable attempt receipt."),
    ...problemResponses,
  },
});
