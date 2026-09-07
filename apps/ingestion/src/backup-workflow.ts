import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  type CatalogueBackupWorkflowParams,
  createVerifiedCatalogueBackup,
  failActiveCatalogueBackupAttempt,
} from "../../../src/catalogue/backup-recovery";
import { canonicalJson, catalogueStore, workflowSteps } from "../../../src/catalogue/shared";
import { observeOperationalWorkflow } from "../../../src/http/operational-log";

const backupStep = {
  retries: { limit: 3, delay: 500, backoff: "exponential" as const },
  timeout: "30 minutes" as const,
};

export class CatalogueBackupWorkflow extends WorkflowEntrypoint<Env, CatalogueBackupWorkflowParams> {
  override run(
    event: Readonly<WorkflowEvent<CatalogueBackupWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<{ result_json: string }> {
    return runCatalogueBackupWorkflow(this.env, event, step);
  }
}

export async function runCatalogueBackupWorkflow(
  env: Env,
  event: Readonly<WorkflowEvent<CatalogueBackupWorkflowParams>>,
  step: WorkflowStep,
): Promise<{ result_json: string }> {
  ({ env, step } = observeOperationalWorkflow(step, event, env));
  const params = event.payload;
  try {
    const document = await step.do(workflowSteps.backup.backup, backupStep, async () => {
      return createVerifiedCatalogueBackup(
        catalogueStore(env.CATALOGUE_DB),
        env.BACKUPS,
        {
          expectedCurrentRevisionId: params.expected_current_revision_id,
          idempotencyKey: params.idempotency_key,
          observedAt: params.observed_at,
          cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID,
          catalogueDatabaseId: env.CATALOGUE_D1_DATABASE_ID,
          disposableDatabaseId: env.DISPOSABLE_D1_DATABASE_ID,
          exportToken: env.D1_EXPORT_TOKEN,
          verificationToken: env.D1_VERIFICATION_TOKEN,
          failedAttemptId: params.failed_attempt_id,
          failedAttemptDigest: params.failed_attempt_digest,
        },
        undefined,
        { terminalFailure: false, publicationArtifacts: env.CATALOGUE_EXPORTS, printingImages: env.PRINTING_IMAGES },
      );
    });
    return {
      result_json: canonicalJson({
        contract: "card-keepr-catalogue-backup-workflow-result@1",
        idempotency_key: params.idempotency_key,
        ok: true,
        document,
      }),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "The Catalogue backup Workflow exhausted its retries.";
    await step.do(workflowSteps.backup.failure, backupStep, () =>
      failActiveCatalogueBackupAttempt(
        catalogueStore(env.CATALOGUE_DB),
        params.idempotency_key,
        params.observed_at,
        detail,
      ),
    );
    return {
      result_json: canonicalJson({
        contract: "card-keepr-catalogue-backup-workflow-result@1",
        idempotency_key: params.idempotency_key,
        ok: false,
        code: "backup_failed",
        detail,
      }),
    };
  }
}
