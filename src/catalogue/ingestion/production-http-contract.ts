import { createRoute, z } from "@hono/zod-openapi";
import { boundedJson, digest, identifier, problemResponses, secured } from "../../http/openapi";
import {
  releaseIdentity,
  releaseHead,
  releaseReceiptSchema,
  releaseJsonBody as body,
  releaseJsonResponse as response,
} from "./release-http-schemas";

export const freshBaselineChoiceSchema = z.strictObject({
  destination_database_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/),
  baseline_sha256: digest,
  destination_migration_level: z.literal(1),
  scope: z.literal("fresh_database_regeneration"),
});
export const replacementChoiceSchema = z.strictObject({
  recovery_id: identifier,
  replacement_database_id: identifier,
  retained_database_id: identifier,
});
const command = z.strictObject({
  release_id: releaseIdentity,
  idempotency_key: releaseIdentity,
  expected_current_revision_id: releaseIdentity,
  expected_head_sha: releaseHead,
  expected_actor: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\[bot\]$/),
  expected_migration_level: z.number().int().min(1),
  bootstrap: z.boolean(),
  replacement_handoff: replacementChoiceSchema.nullable(),
  fresh_baseline_handoff: freshBaselineChoiceSchema.nullable().optional(),
  cancel_handoff: z.literal(true).optional(),
  correct_handoff: z.strictObject({ expected_head_sha: releaseHead, idempotency_key: releaseIdentity }).optional(),
  prepare: z.literal(true).optional(),
  confirmation: identifier.optional(),
});
export const releaseConfirmationSchema = z
  .strictObject({
    contract: z.literal("card-keepr-production-release-confirmation@1"),
    release_id: releaseIdentity,
    confirmation: identifier,
  })
  .openapi("ProductionReleaseConfirmation");
export const productionReleaseRoute = createRoute({
  method: "post",
  path: "/v1/production-releases",
  operationId: "prepareProductionRelease",
  security: secured,
  middleware: [boundedJson],
  request: { body: body(command) },
  responses: {
    200: response(releaseConfirmationSchema, "Read-only server-owned exact confirmation."),
    201: response(
      releaseReceiptSchema,
      "Original requested receipt and serialized plan, even after execution. Cancellation and correction retain separate dispatch branches. All dispatch values are strings.",
    ),
    ...problemResponses,
  },
});
