import { createRoute, z } from "@hono/zod-openapi";
import { digest, identifier, problemResponses } from "../../http/openapi";
import { releaseHead, releaseIdentity, releaseReceiptFields, releaseJsonResponse } from "./release-http-schemas";
import { stagingAuthorizationSchema, stagingOutcomeSchema } from "./staging-http-contract";

export const devDeploymentIntentSchema = z.strictObject({
  head_sha: releaseHead,
  ci_run_id: z.string().regex(/^\d+$/),
});
export const stagingIntentIdentitySchema = z.strictObject({ release_id: releaseIdentity, intent_digest: digest });
export const stagingOutcomeRequestSchema = z.strictObject({ intent_digest: digest, outcome: stagingOutcomeSchema });
const devReceiptSchema = z
  .strictObject({
    ...releaseReceiptFields,
    environment: z.literal("dev"),
    workflow_run_id: identifier,
    authorization_expires_at: z.string().datetime(),
  })
  .openapi("DevDeploymentReceipt");
const stagingPreparationSchema = z
  .strictObject({
    ...releaseReceiptFields,
    environment: z.literal("staging"),
    authorization: stagingAuthorizationSchema,
  })
  .openapi("StagingDeploymentPreparation");
const stagingOutcomeReceiptSchema = z
  .strictObject({
    release_id: releaseIdentity,
    authorization: stagingAuthorizationSchema,
    outcome: stagingOutcomeSchema,
    recorded_at: z.string().datetime(),
  })
  .openapi("StagingOutcomeReceipt");
const security = [{ workflowAttestation: [], githubWorkflowToken: [] }];
// These signed endpoints retain their media-independent, 16 KiB streamed JSON
// decoder. A wildcard avoids Hono eagerly consuming JSON ahead of environment
// and signature checks. Their owning handlers validate these same schemas.
const body = (schema: z.ZodType) => ({
  required: true,
  description: "A JSON object, limited to 16 KiB by streamed bytes. Content-Type does not change decoding.",
  content: { "*/*": { schema } },
});
const response = <T extends z.ZodType>(schema: T, description: string) => ({
  ...releaseJsonResponse(schema, description),
  headers: { "Cache-Control": { required: true, schema: { type: "string" as const, const: "no-store" } } },
});

export const devDeploymentRoute = createRoute({
  method: "post",
  path: "/v1/dev-deployments",
  operationId: "prepareDevDeployment",
  security,
  description:
    "Dev only. Requires a signed GitHub dev Workflow identity and its short-lived X-GitHub-Token. The exact main commit and complete CI success are verified. One preparation per Workflow attempt; replay is refused. An owner or consumer bearer key cannot authorize this operation.",
  request: { body: body(devDeploymentIntentSchema) },
  responses: {
    ...problemResponses,
    201: response(
      devReceiptSchema,
      "Exact dev release preparation, bound to this Workflow attempt and its five-minute authorization.",
    ),
  },
});
export const stagingAuthorizationRoute = createRoute({
  method: "post",
  path: "/v1/staging-release-authorizations",
  operationId: "authorizeStagingWorkflow",
  security,
  description:
    "Production only. Requires a signed manual staging Workflow identity and X-GitHub-Token, the exact retained owner intent, selected commit/CI and expected actor. Exact replay returns the original claim, attempt and expiry. Another attempt or expired intent is refused. This does not grant owner administration access.",
  request: { body: body(stagingIntentIdentitySchema) },
  responses: {
    ...problemResponses,
    200: response(stagingAuthorizationSchema, "Original immutable claim on exact replay, including concurrent claims."),
    201: response(
      stagingAuthorizationSchema,
      "New signed Workflow claim with original preparation and authorization deadlines.",
    ),
  },
});
export const signedStagingDeploymentRoute = createRoute({
  method: "post",
  path: "/v1/staging-deployments",
  operationId: "prepareSignedStagingDeployment",
  security,
  description:
    "Staging only. Forwards the signed manual Workflow identity and X-GitHub-Token to production for exact authorization. Isolated staging resources, the original preparation window and immutable replay remain binding. Owner-authenticated GET inspection is a separate operation.",
  request: { body: body(stagingIntentIdentitySchema) },
  responses: {
    ...problemResponses,
    200: response(stagingPreparationSchema, "Original preparation returned on exact replay."),
    201: response(
      stagingPreparationSchema,
      "Staging preparation bound to the production authorization and original clock.",
    ),
  },
});
export const stagingOutcomeRoute = createRoute({
  method: "post",
  path: "/v1/staging-deployments/{release}/outcome",
  operationId: "recordStagingOutcome",
  security,
  description:
    "Staging only. Requires the same signed manual Workflow identity, X-GitHub-Token and production authorization. Validates exact release/digest, required evidence, actual deployment success and ending schema. Exact replay preserves the first recorded outcome; conflicting or expired claims are refused.",
  request: { params: z.object({ release: z.string().min(1) }), body: body(stagingOutcomeRequestSchema) },
  responses: {
    ...problemResponses,
    200: response(
      stagingOutcomeReceiptSchema,
      "Original outcome returned on exact replay or an identical concurrent record.",
    ),
    201: response(stagingOutcomeReceiptSchema, "First immutable staging outcome and observation time."),
  },
});
