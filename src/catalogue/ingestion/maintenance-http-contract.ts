import { createRoute, z } from "@hono/zod-openapi";
import { boundedJson, digest, identifier, problemResponses, secured } from "../../http/openapi";
import { backupRecoveryTargetCommand } from "../backup-recovery";
import { retainedCuratedTargetSchema } from "../curated";
import { registeredSupportedGames } from "../shared";
import { administrationStatusSchema } from "./administration-status-schema";
import { releaseTargetSchema, releaseJsonBody as body, releaseJsonResponse as response } from "./release-http-schemas";

const expected = { expected_current_revision_id: identifier };
const lifecycle = {
  curated_revision_id: identifier,
  expected_event_version: z.number().int().min(1),
  conflict_digest: digest.nullable(),
  idempotency_key: identifier,
};
export const administrationTargetCommand = z.union([
  backupRecoveryTargetCommand,
  z.strictObject(expected),
  z.strictObject({ ...expected, ingestion_run_id: identifier }),
  z.strictObject({ ...expected, repair_revision_id: identifier }),
  z.strictObject({
    ...expected,
    curated_operation: z.literal("create"),
    curated_binding: z.strictObject({
      affected_supported_game: z.enum(registeredSupportedGames()),
      target: retainedCuratedTargetSchema,
      content_digest: digest,
      idempotency_key: identifier,
    }),
  }),
  z.strictObject({
    ...expected,
    curated_operation: z.enum(["reaffirm", "retire"]),
    curated_binding: z.strictObject(lifecycle),
  }),
  z.strictObject({
    ...expected,
    curated_operation: z.literal("supersede"),
    curated_binding: z.strictObject({
      ...lifecycle,
      replacement_supported_game: z.enum(registeredSupportedGames()),
      replacement_target: retainedCuratedTargetSchema,
      replacement_content_digest: digest,
    }),
  }),
]);
export const administrationTargetSchema = z
  .strictObject({
    contract: z.literal("card-keepr-administration-target@1"),
    resolved_target: z.strictObject({ production_target: releaseTargetSchema, confirmation: identifier }),
  })
  .openapi("AdministrationTarget");
export const resolveAdministrationTargetRoute = createRoute({
  method: "post",
  path: "/v1/administration-targets/resolve",
  operationId: "resolveAdministrationTarget",
  security: secured,
  middleware: [boundedJson],
  request: { body: body(administrationTargetCommand) },
  responses: {
    200: response(
      administrationTargetSchema,
      "Read-only exact target and server-owned confirmation. Mutation guards are checked again by the chosen command.",
    ),
    ...problemResponses,
  },
});
export const administrationStatusRoute = createRoute({
  method: "get",
  path: "/v1/status",
  operationId: "administrationStatus",
  security: secured,
  request: { query: z.strictObject({}) },
  responses: {
    200: response(
      administrationStatusSchema,
      "Current operational state, retained runs, repair window and release preflight.",
    ),
    ...problemResponses,
  },
});
export const searchRepairSchema = z
  .strictObject({
    contract: z.literal("card-keepr-card-search-repair@1"),
    complete: z.boolean(),
    processed_cards: z.number().int().nonnegative(),
    revisions_available: z.number().int().nonnegative(),
    maximum_bound_parameter_bytes: z.number().int().nonnegative(),
  })
  .openapi("CatalogueSearchRepair");
const repairIdentity = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/);
export const searchRepairRoute = createRoute({
  method: "post",
  path: "/v1/catalogue-search-materialization/repair",
  operationId: "repairCatalogueSearch",
  security: secured,
  middleware: [boundedJson],
  request: {
    body: body(
      z.strictObject({
        expected_current_revision_id: repairIdentity,
        target_revision_id: repairIdentity,
        idempotency_key: repairIdentity,
      }),
    ),
  },
  responses: {
    200: response(
      searchRepairSchema,
      "One bounded repair step. Completed exact replay returns its retained result; incomplete repair continues under current guards.",
    ),
    ...problemResponses,
  },
});
