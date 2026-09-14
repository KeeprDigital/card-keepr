import { createRoute, z } from "@hono/zod-openapi";
import { boundedJson, digest, identifier, problemResponses, secured } from "../../http/openapi";

const count = z.number().int().nonnegative();
export const publicationExportPreparationSchema = z
  .union([
    z.strictObject({ state: z.enum(["complete", "retry_paused", "invalid"]) }),
    z.strictObject({ state: z.enum(["waiting_private", "waiting_recovery"]), sequence: count }),
    z.strictObject({
      contract: z.literal("card-keepr-public-export-preparation@5"),
      publication_operation_id: identifier,
      candidate_id: identifier,
      revision_id: identifier,
      state: z.enum(["preparing", "verified", "failed"]),
      sequence: count,
      cursor_json: z.string().max(1024),
      cursor: z.strictObject({
        phase: z.enum(["records", "nodes"]),
        after: z.number().int().min(-1),
        level: count,
        node: count,
      }),
      component_count: count,
      root_digest: digest.nullable(),
      root_object_key: identifier.nullable(),
      root_bytes: count.max(4_000_000).nullable(),
      failure_code: identifier.nullable(),
    }),
  ])
  .openapi("PublicationExportPreparation");

export const advancePublicationExportsRoute = createRoute({
  method: "post",
  path: "/v1/publications/{publication}/export-preparation/advance",
  operationId: "advancePublicationExports",
  security: secured,
  middleware: [boundedJson],
  request: {
    params: z.strictObject({ publication: identifier }),
    body: {
      required: true,
      content: { "application/json": { schema: z.strictObject({ generation: count, idempotency_key: identifier }) } },
    },
  },
  responses: {
    200: {
      description:
        "One bounded export unit or the current waiting/terminal condition. Committed units replay their original result; waiting responses observe current guards. Export preparation is distinct from publication and backup verification.",
      content: { "application/json": { schema: publicationExportPreparationSchema } },
    },
    ...problemResponses,
  },
});
