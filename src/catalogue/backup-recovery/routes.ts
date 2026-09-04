import { assertOnlyFields, readAdministrationBody, requiredString } from "../../http/administration";
import { type RouteContext, route } from "../../http/routes";
import { AdministrationProblem, type CatalogueStore } from "../shared";
import { catalogueBackupAttemptStatus, catalogueRevisionBackupStatus } from "./backup-recovery";
import { startOrObserveCatalogueBackupWorkflow } from "./backup-workflow";
import {
  acceptCatalogueRecovery,
  beginCatalogueRecovery,
  inspectCatalogueRecovery,
  verifyCatalogueRecovery,
} from "./recovery";

type Environment = {
  BACKUPS: R2Bucket;
  CATALOGUE_BACKUP_WORKFLOW: Parameters<typeof startOrObserveCatalogueBackupWorkflow>[1];
  CATALOGUE_D1_DATABASE_ID: string;
  CATALOGUE_DB: CatalogueStore;
  CLOUDFLARE_ACCOUNT_ID: string;
  D1_VERIFICATION_TOKEN: string;
};
type Context = RouteContext<Environment> & { observedAt: string };

export const backupRecoveryRoutes = [
  route<Context>("GET", "/v1/backups/:attempt", async ({ env }, params) => {
    return Response.json(await catalogueBackupAttemptStatus(env.CATALOGUE_DB, params.attempt!));
  }),
  route<Context>("GET", "/v1/catalogue-revisions/:revision/backups", async ({ env }, params) => {
    return Response.json(await catalogueRevisionBackupStatus(env.CATALOGUE_DB, params.revision!));
  }),
  route<Context>("POST", "/v1/backups", async ({ request, env, observedAt }) => {
    const body = await readAdministrationBody(request);
    assertOnlyFields(body, [
      "expected_current_revision_id",
      "idempotency_key",
      "failed_attempt_id",
      "failed_attempt_digest",
    ]);
    const result = await startOrObserveCatalogueBackupWorkflow(
      env.CATALOGUE_DB,
      env.CATALOGUE_BACKUP_WORKFLOW,
      {
        expected_current_revision_id: requiredString(body, "expected_current_revision_id"),
        idempotency_key: requiredString(body, "idempotency_key"),
        ...(body.failed_attempt_id === undefined
          ? {}
          : {
              failed_attempt_id: requiredString(body, "failed_attempt_id"),
            }),
        ...(body.failed_attempt_digest === undefined
          ? {}
          : {
              failed_attempt_digest: requiredString(body, "failed_attempt_digest"),
            }),
      },
      observedAt,
    );
    return Response.json(result.document, {
      status: result.created && result.document.status !== "complete" ? 202 : 200,
    });
  }),
  route<Context>("GET", "/v1/recoveries/:recovery", async ({ env }, params) => {
    return Response.json(await inspectCatalogueRecovery(env.CATALOGUE_DB, env.BACKUPS, params.recovery!));
  }),
  route<Context>("POST", "/v1/recoveries", async ({ request, env, observedAt }) => {
    const body = await readAdministrationBody(request);
    assertOnlyFields(body, [
      "environment",
      "recovery_id",
      "method",
      "target_revision_id",
      "target_bookmark",
      "target_digest",
      "backup_attempt_id",
      "expected_current_revision_id",
      "idempotency_key",
      "linked_operation_id",
    ]);
    if (requiredString(body, "environment") !== "production") {
      throw new AdministrationProblem(
        422,
        "production_target_required",
        "Catalogue recovery requires environment production.",
      );
    }
    const method = requiredString(body, "method");
    if (method !== "time_travel" && method !== "replacement_database") {
      throw new AdministrationProblem(
        422,
        "invalid_recovery_method",
        "method must be time_travel or replacement_database.",
      );
    }
    const document = await beginCatalogueRecovery(env.CATALOGUE_DB, env.BACKUPS, {
      recoveryId: requiredString(body, "recovery_id"),
      method,
      targetRevisionId: requiredString(body, "target_revision_id"),
      targetBookmark: requiredString(body, "target_bookmark"),
      targetDigest: requiredString(body, "target_digest"),
      backupAttemptId: requiredString(body, "backup_attempt_id"),
      expectedCurrentRevisionId: requiredString(body, "expected_current_revision_id"),
      idempotencyKey: requiredString(body, "idempotency_key"),
      ...(body.linked_operation_id === undefined
        ? {}
        : {
            linkedOperationId: requiredString(body, "linked_operation_id"),
          }),
      observedAt,
      cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID,
      catalogueDatabaseId: env.CATALOGUE_D1_DATABASE_ID,
      verificationToken: env.D1_VERIFICATION_TOKEN,
    });
    return Response.json(document, { status: 201 });
  }),
  route<Context>("POST", "/v1/recoveries/:recovery/verification", async ({ request, env, observedAt }, params) => {
    const body = await readAdministrationBody(request);
    assertOnlyFields(body, ["target_digest", "idempotency_key"]);
    return Response.json(
      await verifyCatalogueRecovery(env.CATALOGUE_DB, env.BACKUPS, params.recovery!, {
        targetDigest: requiredString(body, "target_digest"),
        idempotencyKey: requiredString(body, "idempotency_key"),
        observedAt,
        cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID,
        verificationToken: env.D1_VERIFICATION_TOKEN,
      }),
    );
  }),
  route<Context>("POST", "/v1/recoveries/:recovery/acceptance", async ({ request, env, observedAt }, params) => {
    const body = await readAdministrationBody(request);
    assertOnlyFields(body, [
      "expected_restored_revision_id",
      "target_digest",
      "confirmation_recovery_id",
      "idempotency_key",
    ]);
    return Response.json(
      await acceptCatalogueRecovery(env.CATALOGUE_DB, env.BACKUPS, params.recovery!, {
        expectedRestoredRevisionId: requiredString(body, "expected_restored_revision_id"),
        targetDigest: requiredString(body, "target_digest"),
        confirmationRecoveryId: requiredString(body, "confirmation_recovery_id"),
        idempotencyKey: requiredString(body, "idempotency_key"),
        observedAt,
        boundDatabaseId: env.CATALOGUE_D1_DATABASE_ID,
      }),
    );
  }),
];
