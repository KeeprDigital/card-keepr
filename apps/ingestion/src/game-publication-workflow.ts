import { advancePublicationExports } from "../../../src/catalogue/ingestion";
import { snapshotRecoveryWait } from "./snapshot-recovery-wait";
import { startOrObserveCatalogueBackupWorkflow } from "../../../src/catalogue/backup-recovery";
import type { WorkflowStep } from "cloudflare:workers";
import { advanceGamePublication, pauseGamePublication } from "../../../src/catalogue/reconciliation";
import { catalogueStore } from "../../../src/catalogue/shared";

/** The operation's persisted deadline, never this Workflow's lifetime, governs approval. */
export async function runGamePublicationWorkflow(
  env: Env,
  step: WorkflowStep,
  work: { id: string; generation: number },
) {
  step = snapshotRecoveryWait(env, step);
  let waits = 0;
  for (let attempt = 0; ; attempt++) {
    const exports = await step
      .do(
        `prepare public export ${attempt}`,
        { retries: { limit: 3, delay: 250, backoff: "exponential" }, timeout: "1 minute" },
        () =>
          advancePublicationExports(
            { ...env, CATALOGUE_DB: catalogueStore(env.CATALOGUE_DB) },
            work.id,
            work.generation,
            `public-export:${work.id}:${work.generation}:${attempt}`,
          ),
      )
      .catch(async (error) => {
        await step.do("pause public export after retry exhaustion", () =>
          pauseGamePublication(
            catalogueStore(env.CATALOGUE_DB),
            work.id,
            work.generation,
            "public_export_retry_exhausted",
          ),
        );
        throw error;
      });
    if (exports.state === "preparing") {
      waits = 0;
      continue;
    }
    const result = await step
      .do(
        `publication switch ${attempt}`,
        { retries: { limit: 3, delay: 250, backoff: "exponential" }, timeout: "1 minute" },
        () =>
          advanceGamePublication({ ...env, CATALOGUE_DB: catalogueStore(env.CATALOGUE_DB) }, work.id, work.generation),
      )
      .catch(async (error) => {
        await step.do("pause publication after retry exhaustion", () =>
          pauseGamePublication(catalogueStore(env.CATALOGUE_DB), work.id, work.generation, "workflow_retry_exhausted"),
        );
        throw error;
      });
    if (result.state === "published") {
      await step.do(
        "dispatch composition backup",
        { retries: { limit: 3, delay: 500 }, timeout: "1 minute" },
        async () => {
          await startOrObserveCatalogueBackupWorkflow(
            catalogueStore(env.CATALOGUE_DB),
            env.CATALOGUE_BACKUP_WORKFLOW,
            {
              expected_current_revision_id: String(result.resulting_revision_id),
              idempotency_key: String(result.backup_attempt_id),
            },
            new Date().toISOString(),
          );
          return { dispatched: true };
        },
      );
    }
    if (result.state === "published" || result.state === "failed" || result.state === "retry_paused")
      return { result_json: JSON.stringify(result) };
    // Backoff bounds polling during a long backup wait; approval retains its exact deadline.
    await step.sleep(`publication wait ${attempt}`, `${Math.min(900, 2 ** Math.min(waits++, 10))} seconds`);
  }
}
