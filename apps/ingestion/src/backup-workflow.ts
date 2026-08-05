import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import {
  createVerifiedCatalogueBackup,
  failActiveCatalogueBackupAttempt,
} from "../../../src/catalogue/backup-recovery";
import type {
  CatalogueBackupWorkflowParams,
} from "../../../src/catalogue/backup-workflow";
import { canonicalJson } from "../../../src/catalogue/serialization";
import { observeOperationalWorkflow } from "../../../src/http/operational-log";

const backupStep = {
  retries: { limit: 3, delay: 500, backoff: "exponential" as const },
  timeout: "30 minutes" as const,
};

export class CatalogueBackupWorkflow extends WorkflowEntrypoint<
  Env,
  CatalogueBackupWorkflowParams
> {
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
    const document = await step.do(
      "export, retain, restore, and verify Catalogue D1",
      backupStep,
      async () => {
        const slots = await activeD1CredentialSlots(env.CATALOGUE_DB);
        return createVerifiedCatalogueBackup(
          env.CATALOGUE_DB,
          env.BACKUPS,
          {
            expectedCurrentRevisionId: params.expected_current_revision_id,
            idempotencyKey: params.idempotency_key,
            observedAt: params.observed_at,
            cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID,
            catalogueDatabaseId: env.CATALOGUE_D1_DATABASE_ID,
            disposableDatabaseId: env.DISPOSABLE_D1_DATABASE_ID,
            exportToken: slots.export === "a"
              ? env.D1_EXPORT_TOKEN
              : env.D1_EXPORT_TOKEN_REPLACEMENT,
            verificationToken: slots.verification === "a"
              ? env.D1_VERIFICATION_TOKEN
              : env.D1_VERIFICATION_TOKEN_REPLACEMENT,
            failedAttemptId: params.failed_attempt_id,
            failedAttemptDigest: params.failed_attempt_digest,
          },
          undefined,
          { terminalFailure: false },
        );
      },
    );
    return {
      result_json: canonicalJson({
        contract: "card-keepr-catalogue-backup-workflow-result@1",
        idempotency_key: params.idempotency_key,
        ok: true,
        document,
      }),
    };
  } catch (error) {
    const detail = error instanceof Error
      ? error.message
      : "The Catalogue backup Workflow exhausted its retries.";
    await step.do(
      "finalize exhausted Catalogue backup failure",
      backupStep,
      () => failActiveCatalogueBackupAttempt(
        env.CATALOGUE_DB,
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

export async function activeD1CredentialSlots(database: D1Database): Promise<{
  export: "a" | "b";
  verification: "a" | "b";
}> {
  const rows = await database.prepare(
    `SELECT credential_class, current_consumer_slot
     FROM credential_rotations
     WHERE credential_class IN ('d1_export_token', 'd1_verification_token')
     ORDER BY installed_at DESC`,
  ).all<{
    credential_class: "d1_export_token" | "d1_verification_token";
    current_consumer_slot: "a" | "b";
  }>();
  const latest = new Map<string, "a" | "b">();
  for (const row of rows.results) {
    if (!latest.has(row.credential_class)) {
      latest.set(row.credential_class, row.current_consumer_slot);
    }
  }
  return {
    export: latest.get("d1_export_token") ?? "a",
    verification: latest.get("d1_verification_token") ?? "a",
  };
}
