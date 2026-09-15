import { createRoute, z } from "@hono/zod-openapi";
import { boundedJson, digest, identifier, problemResponses, secured } from "../../http/openapi";

const count = z.number().int().nonnegative();
const time = z.string().datetime();
const backupIntent = {
  expected_current_revision_id: identifier,
  idempotency_key: identifier,
};
// Backup keys are retained nonempty strings, including keys longer than 200
// characters. They are not recovery IDs or Workflow execution IDs.
export const backupCommand = z.union([
  z.strictObject(backupIntent),
  z.strictObject({ ...backupIntent, failed_attempt_id: identifier, failed_attempt_digest: digest }),
]);
const resumeCommand = z.strictObject({
  ...backupIntent,
  failed_attempt_id: identifier.optional(),
  failed_attempt_digest: digest.optional(),
});
export const backupDispatchSchema = z
  .strictObject({
    state: z.enum(["pending", "failed", "dispatched"]),
    attempt_count: count,
    updated_at: time,
    workflow_instance_id: identifier,
    failure: z.strictObject({ code: z.literal("catalogue_backup_dispatch_failed"), detail: z.string() }).nullable(),
    retry: z
      .strictObject({
        method: z.literal("POST"),
        path: z.literal("/v1/backups"),
        body: backupCommand,
        maximum_attempts_per_request: count,
      })
      .nullable(),
  })
  .openapi("BackupDispatch");
export const verifiedBackupSchema = z
  .strictObject({
    contract: z.literal("card-keepr-catalogue-backup@1"),
    catalogue_revision_id: identifier,
    object_key: identifier,
    d1_bookmark: identifier,
    content_sha256: digest,
    manifest_key: identifier,
    manifest_sha256: digest,
    linked_attempt_id: identifier.nullable(),
    retention: z.strictObject({ newest_success: z.boolean(), retain_until: time.nullable() }),
    verified: z.literal(true),
  })
  .openapi("VerifiedCatalogueBackup");
export const backupFailureSchema = z
  .strictObject({
    contract: z.literal("card-keepr-catalogue-backup-workflow-failure@1"),
    code: identifier,
    detail: z.string(),
  })
  .openapi("CatalogueBackupWorkflowFailure");
const workflowIdentity = {
  contract: z.literal("card-keepr-catalogue-backup-workflow@1"),
  ...backupIntent,
  workflow_instance_id: identifier,
};
export const pendingBackupWorkflowSchema = z
  .union([
    z.strictObject({
      ...workflowIdentity,
      status: z.enum(["queued", "running", "paused", "waiting", "waitingForPause", "unknown"]),
      output: z.null(),
    }),
    z.strictObject({
      ...workflowIdentity,
      status: z.enum(["dispatch_failed", "unknown"]),
      output: z.null(),
      dispatch: z.union([backupDispatchSchema, z.null()]),
    }),
  ])
  .openapi("PendingCatalogueBackupWorkflow");
export const backupWorkflowSchema = z
  .union([
    pendingBackupWorkflowSchema,
    z.strictObject({
      ...workflowIdentity,
      status: z.literal("complete"),
      output: z.union([verifiedBackupSchema, backupFailureSchema]),
    }),
  ])
  .openapi("CatalogueBackupWorkflow");
export const backupStatusSchema = z
  .strictObject({
    contract: z.literal("card-keepr-catalogue-backup-status@1"),
    idempotency_key: identifier,
    catalogue_revision_id: identifier,
    state: z.enum(["pending", "exporting", "restoring_verification", "verifying", "verified", "failed"]),
    attempt_digest: digest,
    object_key: identifier,
    content_sha256: digest.nullable(),
    manifest_sha256: digest.nullable(),
    d1_bookmark: identifier.nullable(),
    publication_operation_id: identifier.nullable(),
    publication_ingestion_run_id: identifier.nullable(),
    linked_attempt_id: identifier.nullable(),
    disposable_database_id: identifier.nullable(),
    restore_generation: count,
    restore_phase: z.enum(["prepared", "importing", "imported", "verified"]).nullable(),
    failure: z.strictObject({ code: z.string().nullable(), detail: z.string().nullable() }).nullable(),
    workflow_instance_id: identifier.nullable(),
    dispatch: z.union([backupDispatchSchema, z.null()]),
    resume: z
      .strictObject({ method: z.literal("POST"), path: z.literal("/v1/backups"), body: resumeCommand })
      .nullable(),
    retry: z.strictObject({ failed_attempt_id: identifier, failed_attempt_digest: digest }).nullable(),
  })
  .openapi("CatalogueBackupStatus");
export const revisionBackupsSchema = z
  .strictObject({
    contract: z.literal("card-keepr-catalogue-revision-backups@1"),
    catalogue_revision_id: identifier,
    attempts: z.array(backupStatusSchema),
  })
  .openapi("CatalogueRevisionBackups");

function body<T extends z.ZodType>(schema: T) {
  return { required: true as const, content: { "application/json": { schema } } };
}
function response<T extends z.ZodType>(schema: T, description: string) {
  return {
    description,
    headers: { "Cache-Control": { required: true, schema: { type: "string" as const, const: "no-store" } } },
    content: { "application/json": { schema } },
  };
}
export const backupStatusRoute = createRoute({
  method: "get",
  path: "/v1/backups/{attempt}",
  operationId: "catalogueBackupAttemptStatus",
  security: secured,
  request: { params: z.object({ attempt: identifier }) },
  responses: {
    200: response(backupStatusSchema, "Current retained attempt, dispatch, resume and failed-leaf retry evidence."),
    ...problemResponses,
  },
});
export const revisionBackupsRoute = createRoute({
  method: "get",
  path: "/v1/catalogue-revisions/{revision}/backups",
  operationId: "catalogueRevisionBackupStatus",
  security: secured,
  request: { params: z.object({ revision: identifier }) },
  responses: {
    200: response(revisionBackupsSchema, "Current attempts for this exact Catalogue Revision."),
    ...problemResponses,
  },
});
export const backupStartRoute = createRoute({
  method: "post",
  path: "/v1/backups",
  operationId: "startOrObserveCatalogueBackup",
  security: secured,
  middleware: [boundedJson],
  request: { body: body(backupCommand) },
  responses: {
    200: response(
      backupWorkflowSchema,
      "Current Workflow observation on exact replay, or a newly retained completed request. Completion may contain a structured failure; only verified output proves recovery.",
    ),
    202: response(
      pendingBackupWorkflowSchema,
      "Newly retained request with current non-complete observation, including a dispatch failure. Retry the exact original intent.",
    ),
    ...problemResponses,
  },
});

const recoveryIdentity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const recoveryMethod = z.enum(["time_travel", "replacement_database"]);
export const recoveryBeginCommand = z.strictObject({
  environment: identifier,
  recovery_id: recoveryIdentity,
  method: recoveryMethod,
  target_revision_id: recoveryIdentity,
  target_bookmark: identifier,
  target_digest: digest,
  backup_attempt_id: recoveryIdentity,
  expected_current_revision_id: recoveryIdentity,
  idempotency_key: recoveryIdentity,
  linked_operation_id: recoveryIdentity.optional(),
});
export const recoveryVerifyCommand = z.strictObject({ target_digest: digest, idempotency_key: recoveryIdentity });
export const recoveryAcceptCommand = z.strictObject({
  expected_restored_revision_id: identifier,
  target_digest: digest,
  confirmation_recovery_id: identifier,
  idempotency_key: recoveryIdentity,
});
const recoveryVerificationSchema = z
  .strictObject({
    schema: z.literal(true),
    integrity: z.literal(true),
    current_revision: z.literal(true),
    representative_entities: z.literal(true),
    search: z.literal(true),
    provenance: z.literal(true),
    audit: z.literal(true),
    api: z.literal(true),
  })
  .openapi("CatalogueRecoveryVerification");
export const recoverySchema = z
  .strictObject({
    contract: z.literal("card-keepr-catalogue-recovery@1"),
    restored_work: z
      .array(
        z.strictObject({
          classification: z.enum(["published_retained", "terminal_retained", "abandoned_after_restore"]),
          operations: count,
        }),
      )
      .max(3),
    restored_collections: z
      .array(
        z.strictObject({
          classification: z.enum(["retained_source", "abandoned_after_restore"]),
          collections: count,
        }),
      )
      .max(2),
    snapshot_scope: identifier,
    id: recoveryIdentity,
    state: z.enum(["preparing", "restoring", "validating", "awaiting_acceptance", "accepted", "failed"]),
    method: recoveryMethod,
    target_revision_id: recoveryIdentity,
    target_bookmark: identifier,
    target_digest: digest,
    source_backup_attempt_id: identifier,
    linked_operation_id: recoveryIdentity.nullable(),
    expected_current_revision_id: recoveryIdentity,
    current_bookmark: identifier.nullable(),
    restored_bookmark: identifier.nullable(),
    undo_bookmark: identifier.nullable(),
    original_database_id: identifier,
    restored_database_id: identifier.nullable(),
    retained_database_id: identifier.nullable(),
    // This is the persisted verification result, never the private expected-evidence manifest.
    verification: z.union([recoveryVerificationSchema, z.null()]),
    started_at: time,
    restored_at: time.nullable(),
    verified_at: time.nullable(),
    accepted_at: time.nullable(),
    failure: z.strictObject({ code: z.string().nullable(), detail: z.string().nullable() }).nullable(),
    operation_digest: digest,
  })
  .openapi("CatalogueRecovery");
const recoveryParams = z.object({ recovery: recoveryIdentity });
export const recoveryStatusRoute = createRoute({
  method: "get",
  path: "/v1/recoveries/{recovery}",
  operationId: "inspectCatalogueRecovery",
  security: secured,
  request: { params: recoveryParams },
  responses: {
    200: response(
      recoverySchema,
      "Current recovery document and persisted verification, including retained journal hydration.",
    ),
    ...problemResponses,
  },
});
export const recoveryBeginRoute = createRoute({
  method: "post",
  path: "/v1/recoveries",
  operationId: "beginCatalogueRecovery",
  security: secured,
  middleware: [boundedJson],
  request: { body: body(recoveryBeginCommand) },
  responses: {
    201: response(
      recoverySchema,
      "Begins recovery of the exact verified backup. Exact replay returns the current recovery document with its original decision and schema binding, even after verification or acceptance.",
    ),
    ...problemResponses,
  },
});
export const recoveryVerifyRoute = createRoute({
  method: "post",
  path: "/v1/recoveries/{recovery}/verification",
  operationId: "verifyCatalogueRecovery",
  security: secured,
  middleware: [boundedJson],
  request: { params: recoveryParams, body: body(recoveryVerifyCommand) },
  responses: {
    200: response(
      recoverySchema,
      "Verifies the restored database and retained artifacts while keeping mutation fenced. Exact replay persists the journal and returns the current recovery document.",
    ),
    ...problemResponses,
  },
});
export const recoveryAcceptRoute = createRoute({
  method: "post",
  path: "/v1/recoveries/{recovery}/acceptance",
  operationId: "acceptCatalogueRecovery",
  security: secured,
  middleware: [boundedJson],
  request: { params: recoveryParams, body: body(recoveryAcceptCommand) },
  responses: {
    200: response(
      recoverySchema,
      "Explicit owner acceptance binds the observed database and releases recovery only when safe. Exact replay preserves the decision and never resets a later publication.",
    ),
    ...problemResponses,
  },
});
