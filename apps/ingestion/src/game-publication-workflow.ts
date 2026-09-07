import { advancePublicationExports, reservePublicExportAttempt } from "../../../src/catalogue/ingestion";
import { snapshotRecoveryWait } from "./snapshot-recovery-wait";
import { startOrObserveCatalogueBackupWorkflow } from "../../../src/catalogue/backup-recovery";
import type { WorkflowStep } from "cloudflare:workers";
import {
  advanceGamePublication,
  pauseGamePublication,
  dispatchGamePublication,
  inspectPublication,
} from "../../../src/catalogue/reconciliation";
import { catalogueStore } from "../../../src/catalogue/shared";

/** The operation's persisted deadline, never this Workflow's lifetime, governs approval. */
export async function runGamePublicationWorkflow(
  env: Env,
  step: WorkflowStep,
  work: { id: string; generation: number; shard?: number; waits?: number },
) {
  step = snapshotRecoveryWait(env, step);
  let waits = work.waits ?? 0;
  const shard = work.shard ?? 0;
  let sequence = 0;
  for (let unit = 0; unit < 16; unit++) {
    const attempt = shard * 16 + unit;
    const exports = await step
      .do(
        `prepare public export ${attempt}`,
        { retries: { limit: 3, delay: 250, backoff: "exponential" }, timeout: "1 minute" },
        async () => {
          const db = catalogueStore(env.CATALOGUE_DB);
          const owner = await inspectPublication(db, work.id);
          if (owner.generation !== work.generation) return { state: "writer_fenced" };
          if (["published", "failed", "retry_paused"].includes(owner.state)) return { state: owner.state };
          if (owner.deadline <= new Date().toISOString()) return { state: "invalid" };
          if (!(await reservePublicExportAttempt(db, work.id, work.generation, shard))) {
            await pauseGamePublication(db, work.id, work.generation, "public_export_workflow_budget_exhausted");
            return { state: "retry_paused" };
          }
          return advancePublicationExports(
            { ...env, CATALOGUE_DB: catalogueStore(env.CATALOGUE_DB) },
            work.id,
            work.generation,
            `public-export:${work.id}:${work.generation}:${attempt}`,
          );
        },
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
    if ("sequence" in exports && typeof exports.sequence === "number") sequence = exports.sequence;
    if (exports.state === "retry_paused" || exports.state === "writer_fenced")
      return { result_json: JSON.stringify(await inspectPublication(catalogueStore(env.CATALOGUE_DB), work.id)) };
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
  await step
    .do("dispatch publication successor", { retries: { limit: 3, delay: 250 }, timeout: "1 minute" }, async () => {
      const owner = await inspectPublication(catalogueStore(env.CATALOGUE_DB), work.id);
      if (owner.generation === work.generation && !["published", "failed", "retry_paused"].includes(owner.state))
        await dispatchGamePublication(env.RECONCILIATION_WORKFLOW, owner, shard + 1, waits);
      return { state: owner.state };
    })
    .catch(async (error) => {
      await step.do("pause publication after successor dispatch exhaustion", () =>
        pauseGamePublication(
          catalogueStore(env.CATALOGUE_DB),
          work.id,
          work.generation,
          "publication_successor_dispatch_exhausted",
          { shard, sequence },
        ),
      );
      throw error;
    });
  return { result_json: JSON.stringify({ id: work.id, generation: work.generation, shard, state: "continued" }) };
}
