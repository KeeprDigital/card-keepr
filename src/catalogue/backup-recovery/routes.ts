import { type Route, type RouteContext } from "../../http/routes";
import { httpRoute, retainedWireValue } from "../../http/openapi";
import {
  backupStartRoute,
  backupStatusRoute,
  revisionBackupsRoute,
  backupWorkflowSchema,
  pendingBackupWorkflowSchema,
  backupStatusSchema,
  revisionBackupsSchema,
  recoveryStatusRoute,
  recoveryBeginRoute,
  recoveryVerifyRoute,
  recoveryAcceptRoute,
  recoverySchema,
} from "./http-contract";
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
  KEEPR_ENVIRONMENT?: string;
  BACKUPS: R2Bucket;
  CATALOGUE_EXPORTS: R2Bucket;
  PRINTING_IMAGES: R2Bucket;
  CATALOGUE_BACKUP_WORKFLOW: Parameters<typeof startOrObserveCatalogueBackupWorkflow>[1];
  CATALOGUE_D1_DATABASE_ID: string;
  CATALOGUE_DB: CatalogueStore;
  CLOUDFLARE_ACCOUNT_ID: string;
  D1_VERIFICATION_TOKEN: string;
};
type Context = RouteContext<Environment> & { observedAt: string };

export const backupRecoveryRoutes: Route<Context>[] = [
  httpRoute<Context>()(backupStatusRoute, async (c) => {
    const { env } = c.env;
    const value = await catalogueBackupAttemptStatus(env.CATALOGUE_DB, c.req.valid("param").attempt);
    c.header("Cache-Control", "no-store");
    return c.json(retainedWireValue(backupStatusSchema, value), 200);
  }),
  httpRoute<Context>()(revisionBackupsRoute, async (c) => {
    const value = await catalogueRevisionBackupStatus(c.env.env.CATALOGUE_DB, c.req.valid("param").revision);
    c.header("Cache-Control", "no-store");
    return c.json(retainedWireValue(revisionBackupsSchema, value), 200);
  }),
  httpRoute<Context>()(backupStartRoute, async (c) => {
    const { env, observedAt } = c.env;
    const result = await startOrObserveCatalogueBackupWorkflow(
      env.CATALOGUE_DB,
      env.CATALOGUE_BACKUP_WORKFLOW,
      c.req.valid("json"),
      observedAt,
    );
    c.header("Cache-Control", "no-store");
    if (result.created && result.document.status !== "complete")
      return c.json(retainedWireValue(pendingBackupWorkflowSchema, result.document), 202);
    return c.json(retainedWireValue(backupWorkflowSchema, result.document), 200);
  }),
  httpRoute<Context>()(recoveryStatusRoute, async (c) => {
    const { env } = c.env;
    const value = await inspectCatalogueRecovery(env.CATALOGUE_DB, env.BACKUPS, c.req.valid("param").recovery);
    return c.json(retainedWireValue(recoverySchema, value), 200, { "Cache-Control": "no-store" });
  }),
  httpRoute<Context>()(recoveryBeginRoute, async (c) => {
    const { env, observedAt } = c.env;
    const body = c.req.valid("json");
    if (body.environment !== (env.KEEPR_ENVIRONMENT ?? "production")) {
      throw new AdministrationProblem(
        422,
        "production_target_required",
        `Catalogue recovery requires environment ${env.KEEPR_ENVIRONMENT ?? "production"}.`,
      );
    }
    const document = await beginCatalogueRecovery(env.CATALOGUE_DB, env.BACKUPS, {
      recoveryId: body.recovery_id,
      method: body.method,
      targetRevisionId: body.target_revision_id,
      targetBookmark: body.target_bookmark,
      targetDigest: body.target_digest,
      backupAttemptId: body.backup_attempt_id,
      expectedCurrentRevisionId: body.expected_current_revision_id,
      idempotencyKey: body.idempotency_key,
      ...(body.linked_operation_id === undefined
        ? {}
        : {
            linkedOperationId: body.linked_operation_id,
          }),
      observedAt,
      cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID,
      catalogueDatabaseId: env.CATALOGUE_D1_DATABASE_ID,
      verificationToken: env.D1_VERIFICATION_TOKEN,
    });
    return c.json(retainedWireValue(recoverySchema, document), 201, { "Cache-Control": "no-store" });
  }),
  httpRoute<Context>()(recoveryVerifyRoute, async (c) => {
    const { env, observedAt } = c.env;
    const body = c.req.valid("json");
    const document = await verifyCatalogueRecovery(
      env.CATALOGUE_DB,
      env.BACKUPS,
      c.req.valid("param").recovery,
      {
        targetDigest: body.target_digest,
        idempotencyKey: body.idempotency_key,
        observedAt,
        cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID,
        verificationToken: env.D1_VERIFICATION_TOKEN,
      },
      undefined,
      { catalogue: env.CATALOGUE_EXPORTS, images: env.PRINTING_IMAGES },
    );
    return c.json(retainedWireValue(recoverySchema, document), 200, { "Cache-Control": "no-store" });
  }),
  httpRoute<Context>()(recoveryAcceptRoute, async (c) => {
    const { env, observedAt } = c.env;
    const body = c.req.valid("json");
    const document = await acceptCatalogueRecovery(env.CATALOGUE_DB, env.BACKUPS, c.req.valid("param").recovery, {
      expectedRestoredRevisionId: body.expected_restored_revision_id,
      targetDigest: body.target_digest,
      confirmationRecoveryId: body.confirmation_recovery_id,
      idempotencyKey: body.idempotency_key,
      observedAt,
      boundDatabaseId: env.CATALOGUE_D1_DATABASE_ID,
    });
    return c.json(retainedWireValue(recoverySchema, document), 200, { "Cache-Control": "no-store" });
  }),
];
