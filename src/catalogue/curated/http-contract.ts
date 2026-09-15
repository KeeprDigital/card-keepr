import { createRoute, z } from "@hono/zod-openapi";
import { boundedJson, digest, identifier, problemResponses, secured } from "../../http/openapi";
import { registeredSupportedGames, sourceValue } from "../shared";

import {
  curatedIdentity as identity,
  curatedProposalSchema,
  retainedCuratedProposalSchema,
} from "./proposal-http-schema";

const game = z.enum(registeredSupportedGames());
const status = z.enum(["active", "reconfirmation_required", "superseded", "retired"]);
const version = z.number().int().min(1);
function historicalObject<T extends z.ZodRawShape>(shape: T) {
  return z.union([z.strictObject(shape), z.looseObject({ ...shape, "": sourceValue })]);
}
const binding = z.strictObject({ catalogue_revision_id: identifier, game_profile: identifier });
export const curatedValidationSchema = z
  .strictObject({
    contract: z.literal("card-keepr-curated-revision-validation@1"),
    valid: z.literal(true),
    target_key: identifier,
    proposal_digest: digest,
    schema_binding: binding,
  })
  .openapi("CuratedRevisionValidation");
export const curatedReceiptSchema = z
  .strictObject({
    operation_id: identifier,
    curated_revision_id: identifier,
    status,
    event_version: version,
    content_digest: digest,
    current_catalogue_revision_id: identifier,
    code: z.enum([
      "curated_revision_created",
      "curated_revision_reaffirmed",
      "curated_revision_retired",
      "curated_revision_superseded",
    ]),
  })
  .openapi("CuratedRevisionReceipt");
const conflict = z.strictObject({
  id: identifier,
  digest,
  run_id: identifier,
  preparation_id: identifier.optional(),
  previous_source_digest: digest,
  observed_source_digest: digest,
});
const revision = z.strictObject({
  id: identifier,
  content: retainedCuratedProposalSchema,
  content_digest: digest,
  author: identifier,
  created_at: z.number().int(),
  status,
  event_version: version,
  pending_conflict: conflict.nullable(),
});
const eventFields = {
  id: identifier,
  revision_id: identifier,
  event_version: version,
  at: z.number().int(),
};
const ownerEventFields = { rationale: identifier, expected_current_revision_id: identifier };
const event = z.discriminatedUnion("type", [
  z.strictObject({
    ...eventFields,
    type: z.literal("authored"),
    details: z.strictObject({ reviewed_source_digest: digest, supersedes_revision_id: identity.optional() }),
  }),
  z.strictObject({
    ...eventFields,
    type: z.literal("source_change_detected"),
    details: z.strictObject({
      conflict_id: identifier,
      conflict_digest: digest,
      run_id: identifier,
      preparation_id: identifier.optional(),
      previous_source_digest: digest,
      observed_source_digest: digest,
    }),
  }),
  z.strictObject({
    ...eventFields,
    type: z.literal("reaffirmed"),
    details: z.strictObject({
      ...ownerEventFields,
      conflict_id: identifier,
      conflict_digest: digest,
      reviewed_source_digest: digest,
    }),
  }),
  z.strictObject({
    ...eventFields,
    type: z.literal("retired"),
    details: z.strictObject({
      ...ownerEventFields,
      conflict_id: identifier.nullable(),
      conflict_digest: digest.nullable(),
    }),
  }),
  z.strictObject({
    ...eventFields,
    type: z.literal("superseded"),
    details: z.strictObject({
      ...ownerEventFields,
      superseded_by_revision_id: identity,
      conflict_digest: digest.nullable(),
    }),
  }),
]);
export const curatedInspectionSchema = z
  .strictObject({ revision, events: z.array(event) })
  .openapi("CuratedRevisionInspection");
export const curatedListSchema = z
  .strictObject({ items: z.array(revision), next_cursor: z.null() })
  .openapi("CuratedRevisionList");
const mutationFields = {
  environment: identifier,
  expected_current_revision_id: identifier,
  idempotency_key: identifier,
};
const createCommand = historicalObject({
  ...mutationFields,
  proposal: retainedCuratedProposalSchema,
  proposal_digest: digest,
});
const lifecycleFields = {
  ...mutationFields,
  expected_event_version: version,
  conflict_digest: digest.nullable(),
  rationale: identifier,
};
const params = z.strictObject({ revision: identity });
const headers = { "Cache-Control": { required: true, schema: { type: "string" as const } } };
const response = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  headers,
  content: { "application/json": { schema } },
});
const body = <T extends z.ZodType>(schema: T) => ({ required: true, content: { "application/json": { schema } } });
const receipt = response(
  curatedReceiptSchema,
  "Original immutable lifecycle receipt. Exact replay preserves this receipt after subsequent lifecycle or catalogue changes.",
);
export const validateCuratedRoute = createRoute({
  method: "post",
  path: "/v1/curated-revisions/validate",
  operationId: "validateCuratedRevision",
  security: secured,
  middleware: [boundedJson],
  request: { body: body(z.strictObject({ proposal: curatedProposalSchema, catalogue_revision_id: identifier })) },
  responses: {
    200: response(
      curatedValidationSchema,
      "Validated immutable proposal bound to the exact current catalogue and Game Profile; no owner decision is created.",
    ),
    ...problemResponses,
  },
});
export const createCuratedRoute = createRoute({
  method: "post",
  path: "/v1/curated-revisions",
  operationId: "createCuratedRevision",
  security: secured,
  middleware: [boundedJson],
  request: { body: body(createCommand) },
  responses: { 201: receipt, 200: receipt, ...problemResponses },
});
export const listCuratedRoute = createRoute({
  method: "get",
  path: "/v1/curated-revisions",
  operationId: "listCuratedRevisions",
  security: secured,
  request: {
    query: z.strictObject({ game: game.optional(), target: z.string().optional(), status: status.optional() }),
  },
  responses: {
    200: response(curatedListSchema, "Current inspection of matching retained owner decisions."),
    ...problemResponses,
  },
});
export const showCuratedRoute = createRoute({
  method: "get",
  path: "/v1/curated-revisions/{revision}",
  operationId: "showCuratedRevision",
  security: secured,
  request: { params },
  responses: {
    200: response(
      curatedInspectionSchema,
      "Current lifecycle status with immutable proposal content and append-only events.",
    ),
    ...problemResponses,
  },
});
export const reaffirmCuratedRoute = createRoute({
  method: "post",
  path: "/v1/curated-revisions/{revision}/reaffirm",
  operationId: "reaffirmCuratedRevision",
  security: secured,
  middleware: [boundedJson],
  request: { params, body: body(historicalObject({ ...lifecycleFields, conflict_digest: digest })) },
  responses: { 200: receipt, ...problemResponses },
});
export const retireCuratedRoute = createRoute({
  method: "post",
  path: "/v1/curated-revisions/{revision}/retire",
  operationId: "retireCuratedRevision",
  security: secured,
  middleware: [boundedJson],
  request: { params, body: body(historicalObject(lifecycleFields)) },
  responses: { 200: receipt, ...problemResponses },
});
export const supersedeCuratedRoute = createRoute({
  method: "post",
  path: "/v1/curated-revisions/{revision}/supersede",
  operationId: "supersedeCuratedRevision",
  security: secured,
  middleware: [boundedJson],
  request: {
    params,
    body: body(
      historicalObject({ ...lifecycleFields, proposal: retainedCuratedProposalSchema, proposal_digest: digest }),
    ),
  },
  responses: { 201: receipt, 200: receipt, ...problemResponses },
});
