import { createRoute, z } from "@hono/zod-openapi";
import { boundedJson, digest, identifier, problemResponses, secured } from "../../http/openapi";

const publicationFields = {
  id: identifier,
  candidate_id: identifier,
  preparation_id: identifier,
  ingestion_run_id: identifier,
  supported_game: identifier,
  manifest_digest: digest,
  expected_game_revision_id: identifier,
  candidate_generation: z.number().int().nonnegative(),
  deadline: identifier,
  approved_at: identifier,
  inspection_receipt: digest,
  generation: z.number().int().nonnegative(),
  state: z.enum(["approved", "waiting_artifacts", "waiting_backup", "retry_paused", "published", "failed"]),
  failure_code: identifier.nullable(),
  resulting_revision_id: identifier.nullable(),
  backup_attempt_id: identifier.nullable(),
  published_at: identifier.nullable(),
  approval_scope: z.literal("whole_candidate"),
};
export const publicationStatusSchema = z
  .strictObject({ contract: z.literal("card-keepr-game-publication@1"), ...publicationFields })
  .openapi("PublicationStatus");
export const publicationAcceptanceSchema = z
  .strictObject({
    ...publicationFields,
    contract: z.literal("card-keepr-publication-acceptance@1"),
    state: z.literal("approved"),
    links: z.strictObject({ status: z.url() }),
  })
  .openapi("PublicationAcceptance");
export const startPublicationRoute = createRoute({
  method: "post",
  path: "/v1/publications/start",
  operationId: "startPublication",
  security: secured,
  middleware: [boundedJson],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.strictObject({
            candidate_id: identifier,
            manifest_digest: digest,
            expected_game_revision_id: identifier,
            generation: z.number().int().nonnegative(),
            idempotency_key: identifier,
          }),
        },
      },
    },
  },
  responses: {
    202: {
      description:
        "Immutable original approval acknowledgement, including on exact replay. Poll status for current work; acceptance does not establish publication or verified backup.",
      headers: {
        Location: { required: true, schema: { type: "string" } },
        "Retry-After": { required: true, schema: { type: "string" } },
        "Cache-Control": { required: true, schema: { type: "string" } },
      },
      content: { "application/json": { schema: publicationAcceptanceSchema } },
    },
    ...problemResponses,
  },
});
export const publicationStatusRoute = createRoute({
  method: "get",
  path: "/v1/publications/{publication}",
  operationId: "getPublication",
  security: secured,
  request: { params: z.strictObject({ publication: identifier }) },
  responses: {
    200: {
      description: "Current publication state. Published is distinct from its Backup Attempt's verification.",
      content: { "application/json": { schema: publicationStatusSchema } },
    },
    ...problemResponses,
  },
});

export const approvePublicationRoute = createRoute({
  method: "post",
  path: "/v1/publications",
  operationId: "approvePublication",
  security: secured,
  middleware: [boundedJson],
  request: startPublicationRoute.request,
  responses: {
    202: {
      description:
        "Immutable whole-candidate approval without Workflow dispatch. Replay returns the original approval, even after publication advances.",
      headers: {
        Location: { required: true, schema: { type: "string" } },
        "Cache-Control": { required: true, schema: { type: "string" } },
      },
      content: {
        "application/json": {
          schema: z
            .strictObject({ ...publicationStatusSchema.shape, state: z.literal("approved") })
            .openapi("PublicationApproval"),
        },
      },
    },
    ...problemResponses,
  },
});
export const resumePublicationRoute = createRoute({
  method: "post",
  path: "/v1/publications/{publication}/resume",
  operationId: "resumePublication",
  security: secured,
  middleware: [boundedJson],
  request: {
    params: z.strictObject({ publication: identifier }),
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.strictObject({ generation: z.number().int().nonnegative(), idempotency_key: identifier }),
        },
      },
    },
  },
  responses: {
    202: {
      description:
        "Immutable resume acknowledgement for the incremented generation; original candidate and deadline remain pinned. Read status for current progress and inspect backup separately.",
      headers: startPublicationRoute.responses[202].headers,
      content: { "application/json": { schema: publicationAcceptanceSchema } },
    },
    ...problemResponses,
  },
});
export const advancePublicationRoute = createRoute({
  method: "post",
  path: "/v1/publications/{publication}/advance",
  operationId: "advancePublication",
  security: secured,
  middleware: [boundedJson],
  request: {
    params: z.strictObject({ publication: identifier }),
    body: {
      required: true,
      content: { "application/json": { schema: z.strictObject({ generation: z.number().int().nonnegative() }) } },
    },
  },
  responses: {
    200: {
      description:
        "Current operation after a bounded advance. Published visibility switches atomically only after all candidate and recovery guards pass; backup verification is separate.",
      content: { "application/json": { schema: publicationStatusSchema } },
    },
    ...problemResponses,
  },
});
