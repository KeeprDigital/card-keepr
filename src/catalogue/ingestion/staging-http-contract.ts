import { createRoute, z } from "@hono/zod-openapi";
import { boundedJson, digest, identifier, problemResponses, secured } from "../../http/openapi";
import {
  releaseHead,
  releaseIdentity,
  releaseTargetSchema,
  releaseReceiptFields,
  releaseJsonResponse as response,
  releaseJsonBody as body,
} from "./release-http-schemas";

const scope = z.enum(["routine", "recovery", "sources", "full"]);
export const freshStagingScope = z.union([z.literal("auto"), scope]);
type RetainedScope = z.infer<typeof scope> | RetainedScope[];
// The old boundary retained singleton arrays after validating String(scope).
// This branch admits exact historical replay only; the domain checks fresh input.
const retainedScope: z.ZodType<RetainedScope> = z
  .lazy(() => z.union([scope, z.array(retainedScope).min(1).max(1)]))
  .openapi("RetainedStagingScope");
const command = z.strictObject({
  release_id: releaseIdentity,
  idempotency_key: releaseIdentity,
  expected_head_sha: releaseHead,
  expected_actor: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/),
  ci_run_id: z.string().regex(/^\d+$/),
  validation_scope: z.union([freshStagingScope, retainedScope]),
  prepare: z.literal(true).optional(),
  confirmation: identifier.optional(),
});
const timestamp = z.string().datetime();
export const stagingIntentSchema = z
  .strictObject({
    release_id: releaseIdentity,
    idempotency_key: releaseIdentity,
    expected_head_sha: releaseHead,
    expected_actor: identifier,
    ci_run_id: z.string().regex(/^\d+$/),
    validation_scope: scope,
    validation_reason: z.enum(["unknown_transition", "shared_or_unclassified_change", "verified_transition"]),
    required_checks: z.array(identifier),
    extended_scenarios: z.array(identifier),
    production_start: z.strictObject({
      target: releaseTargetSchema,
      target_digest: digest,
      migration_level: z.number().int().min(1),
      head_sha: releaseHead.nullable(),
      worker_versions: z.array(z.strictObject({ worker: identifier, version_id: identifier })).nullable(),
      comparison_sha256: digest.nullable(),
    }),
    authorized_at: timestamp,
    expires_at: timestamp,
  })
  .openapi("StagingReleaseIntent");
const stagingReceiptFields = {
  contract: z.literal("card-keepr-staging-release-request@1"),
  release_id: releaseIdentity,
  intent: stagingIntentSchema,
  intent_digest: digest,
  confirmation: identifier,
  dispatch_inputs: z.strictObject({
    release_id: releaseIdentity,
    expected_head_sha: releaseHead,
    intent_digest: digest,
  }),
};
export const stagingReceiptSchema = z.strictObject(stagingReceiptFields).openapi("StagingReleaseReceipt");
export const stagingAuthorizationSchema = z
  .strictObject({
    contract: z.literal("card-keepr-staging-authorization@1"),
    intent: stagingIntentSchema,
    intent_digest: digest,
    workflow_run_id: identifier,
    workflow_run_attempt: identifier,
    authorized_at: timestamp,
    preparation_expires_at: timestamp,
    expires_at: timestamp,
  })
  .openapi("StagingWorkflowAuthorization");
const authorization = stagingAuthorizationSchema;
export const stagingInspectionSchema = z
  .strictObject({ ...stagingReceiptFields, authorization: z.union([authorization, z.null()]) })
  .openapi("StagingReleaseInspection");
const state = z.enum(["succeeded", "failed", "not_run"]);
export const stagingOutcomeSchema = z
  .strictObject({
    contract: z.literal("card-keepr-staging-outcome@1"),
    intent_digest: digest,
    expected_head_sha: releaseHead,
    state: z.enum(["succeeded", "failed"]),
    deployment: z.strictObject({ state, release_id: releaseIdentity, dispatch_digest: digest.nullable() }),
    migration: z.strictObject({
      state,
      starting_level: z.number().int().min(1),
      ending_level: z.number().int().min(1),
      migration_digest: digest.nullable(),
    }),
    checks: z.array(z.strictObject({ name: identifier, state, evidence_sha256: digest.nullable() })),
    failure_code: identifier.nullable(),
  })
  .openapi("StagingOutcome");
const outcome = stagingOutcomeSchema;
export const stagingDeploymentSchema = z
  .union([
    z.strictObject({ release_id: releaseIdentity, authorization, outcome, recorded_at: timestamp }),
    z.strictObject({
      release_id: releaseIdentity,
      authorization,
      outcome: z.null(),
      deployment: z.strictObject({ ...releaseReceiptFields, environment: z.literal("staging"), authorization }),
    }),
  ])
  .openapi("StagingDeploymentInspection");
export const stagingConfirmationSchema = z.strictObject({ confirmation: identifier });
export const stagingReleaseRoute = createRoute({
  method: "post",
  path: "/v1/staging-releases",
  operationId: "prepareStagingRelease",
  security: secured,
  middleware: [boundedJson],
  request: { body: body(command) },
  responses: {
    200: response(stagingConfirmationSchema, "Read-only exact owner confirmation."),
    201: response(stagingReceiptSchema, "Immutable original intent and deadline, including exact replay."),
    ...problemResponses,
  },
});
export const stagingInspectionRoute = createRoute({
  method: "get",
  path: "/v1/staging-releases/{release}",
  operationId: "inspectStagingRelease",
  security: secured,
  request: { params: z.strictObject({ release: releaseIdentity }) },
  responses: {
    200: response(
      stagingInspectionSchema,
      "Original owner intent with its separately signed workflow claim, if claimed.",
    ),
    ...problemResponses,
  },
});
export const stagingDeploymentRoute = createRoute({
  method: "get",
  path: "/v1/staging-deployments/{release}",
  operationId: "inspectStagingDeployment",
  security: secured,
  request: { params: z.strictObject({ release: releaseIdentity }) },
  responses: {
    200: response(
      stagingDeploymentSchema,
      "Current staging preparation or immutable outcome. Available only on staging.",
    ),
    ...problemResponses,
  },
});
