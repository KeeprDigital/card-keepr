import { createRoute, z } from "@hono/zod-openapi";
import { boundedJson, digest, identifier, problemResponses, secured } from "../../http/openapi";
import { gameProfileRegistrations } from "../adapters";
import { correctionAction, correctionRequest, correctionEvidence } from "./game-candidate-evidence-schemas";
import { historyCursor } from "./entity-admission-http-contract";

const game = z.enum(gameProfileRegistrations().map(({ game }) => game));
const nonblank = identifier.refine((value) => value.trim().length > 0);
const ids = z
  .array(identifier)
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length);
const proposal = correctionRequest
  .extend({
    game,
    action: correctionAction,
    source_ids: ids,
    replacement_ids: ids,
    expected_current_revision_id: nonblank,
    rationale: nonblank,
    evidence: z.strictObject({ attestation: nonblank }),
  })
  .openapi("IdentityCorrectionProposal");
// These reviewed records share the retained candidate-evidence contract, including
// historical published shapes and native text descriptors. Never rewrite their bytes.
const reviewed = correctionEvidence.shape.reviewed.openapi("RetainedIdentityCorrectionReview");
export const correctionValidationSchema = z
  .strictObject({
    valid: z.literal(true),
    review_digest: digest,
    reviewed,
  })
  .openapi("IdentityCorrectionValidation");
const decisionSummary = correctionRequest.extend({
  id: identifier,
  sequence: z.number().int().nonnegative(),
  decided_at: z.iso.datetime(),
});
export const correctionInspectionSchema = decisionSummary
  .extend({
    review_digest: digest,
    reviewed,
  })
  .openapi("IdentityCorrectionInspection");
export const correctionsSchema = z
  .strictObject({
    decisions: z.array(decisionSummary).max(100),
    next_cursor: z.number().int().nonnegative().nullable(),
  })
  .openapi("IdentityCorrectionList");
const headers = { "Cache-Control": { required: true, schema: { type: "string" as const } } };
export const validateCorrectionRoute = createRoute({
  method: "post",
  path: "/v1/identity-corrections/validate",
  operationId: "validateIdentityCorrection",
  security: secured,
  middleware: [boundedJson],
  request: { body: { required: true, content: { "application/json": { schema: proposal } } } },
  responses: {
    200: {
      description:
        "Review binds published identities, relationships and preceding decisions; it does not record a correction or publish a candidate.",
      headers,
      content: { "application/json": { schema: correctionValidationSchema } },
    },
    ...problemResponses,
  },
});
export const createCorrectionRoute = createRoute({
  method: "post",
  path: "/v1/identity-corrections",
  operationId: "createIdentityCorrection",
  security: secured,
  middleware: [boundedJson],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          // Extending the named strict proposal emits incompatible closed allOf
          // branches. Build the complete command shape for the generated request.
          schema: z.strictObject({
            ...proposal.shape,
            action: correctionRequest.shape.action,
            printing_assignments: correctionRequest.shape.printing_assignments,
            review_digest: digest,
            idempotency_key: nonblank,
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description:
        "Immutable reviewed correction, including exact replay of historical array-action intent after the published revision changes. Fresh commands require a scalar action. A fresh whole-candidate approval remains required.",
      headers,
      content: { "application/json": { schema: correctionInspectionSchema } },
    },
    ...problemResponses,
  },
});
export const inspectCorrectionRoute = createRoute({
  method: "get",
  path: "/v1/identity-corrections/{correction}",
  operationId: "inspectIdentityCorrection",
  security: secured,
  request: { params: z.strictObject({ correction: identifier }) },
  responses: {
    200: {
      description:
        "Retained correction and exact reviewed evidence; split replacements never select a consumer-owned copy.",
      headers,
      content: { "application/json": { schema: correctionInspectionSchema } },
    },
    ...problemResponses,
  },
});
export const listCorrectionsRoute = createRoute({
  method: "get",
  path: "/v1/identity-corrections",
  operationId: "listIdentityCorrections",
  security: secured,
  request: { query: z.strictObject({ game, after: historyCursor.optional() }) },
  responses: {
    200: {
      description: "Append-only correction history ordered by sequence.",
      headers,
      content: { "application/json": { schema: correctionsSchema } },
    },
    ...problemResponses,
  },
});
