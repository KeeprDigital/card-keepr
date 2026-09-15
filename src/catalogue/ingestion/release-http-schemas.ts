import { z } from "@hono/zod-openapi";
import { digest, identifier } from "../../http/openapi";

export const releaseIdentity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@|-]{0,255}$/);
export const releaseHead = z.string().regex(/^[0-9a-f]{40}$/);
export const releaseTargetSchema = z
  .strictObject({
    cloudflare_account_id: identifier,
    worker_scripts: z.array(identifier).min(2).max(2),
    d1_databases: z
      .array(z.strictObject({ name: identifier, id: identifier }))
      .min(2)
      .max(2),
    r2_buckets: z.array(identifier),
  })
  .openapi("ReleaseEnvironmentTarget");
export const releaseResponseHeaders = { "Cache-Control": { required: true, schema: { type: "string" as const } } };
export const releaseJsonResponse = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  headers: releaseResponseHeaders,
  content: { "application/json": { schema } },
});
export const releaseJsonBody = <T extends z.ZodType>(schema: T) => ({
  required: true,
  content: { "application/json": { schema } },
});

const dispatchFields = {
  release_id: releaseIdentity,
  expected_account_id: identifier,
  expected_head_sha: releaseHead,
  expected_actor: identifier,
  idempotency_key: releaseIdentity,
  dispatch_digest: digest,
  prepared_plan_json: identifier,
  expected_current_revision: releaseIdentity,
  expected_migration_level: z.string().regex(/^[1-9][0-9]*$/),
  production_target_json: identifier,
  production_target_digest: digest,
  bootstrap: z.enum(["true", "false"]),
  recovery_bookmark: identifier,
  recovery_backup_attempt_id: identifier,
  smoke_targets_json: identifier,
  retained_revision_evidence_json: identifier,
  replacement_recovery_id: identifier,
  replacement_database_id: identifier,
  retained_database_id: identifier,
  replacement_target_digest: identifier,
};
export const releaseReceiptFields = {
  contract: z.literal("card-keepr-production-release-request@1"),
  release_id: releaseIdentity,
  state: z.literal("requested"),
  dispatch_digest: digest,
  prepared_plan_json: identifier,
  dispatch_inputs: z
    .discriminatedUnion("operation", [
      z.strictObject({ ...dispatchFields, operation: z.literal("production_release") }),
      z.strictObject({ ...dispatchFields, operation: z.literal("cancel_fresh_baseline_handoff") }),
      z.strictObject({
        ...dispatchFields,
        operation: z.literal("correct_fresh_baseline_handoff"),
        correction_json: identifier,
        correction_digest: digest,
      }),
    ])
    .openapi("ReleaseDispatchInputs"),
};
export const releaseReceiptSchema = z.strictObject(releaseReceiptFields).openapi("ProductionReleaseReceipt");
