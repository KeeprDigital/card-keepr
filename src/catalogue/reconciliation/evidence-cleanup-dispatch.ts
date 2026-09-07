import {
  beginEvidenceCleanup,
  beginStagingCleanup,
  inspectEvidenceCleanup,
  resumeEvidenceCleanup,
  pauseEvidenceCleanup,
} from "../source-evidence";
import { type CatalogueStore, sha256Text, workflowDriver } from "../shared";
import type { ReconciliationWorkflowParams } from "./reconciliation-workflow";

export async function dispatchEvidenceCleanup(
  workflow: Workflow<ReconciliationWorkflowParams>,
  id: string,
  run: string,
  generation: number,
  shard = 0,
) {
  const workflowId = `cleanup-${await sha256Text(`${id}:${generation}:${shard}`)}`;
  const params: ReconciliationWorkflowParams = {
    ingestion_run_id: run,
    expected_current_revision_id: "catrev_spine_000",
    idempotency_key: id,
    observed_at: new Date().toISOString(),
    evidence_cleanup: { id, generation, shard },
  };
  return workflowDriver(workflow).ensure(workflowId, params, { createRequested: true });
}
export async function startEvidenceCleanup(
  env: { CATALOGUE_DB: CatalogueStore; RECONCILIATION_WORKFLOW: Workflow<ReconciliationWorkflowParams> },
  run: string,
  key: string,
  days: unknown,
  at: string,
  scope: "capture" | "staging" = "capture",
) {
  const intent = await (scope === "capture"
    ? beginEvidenceCleanup(env.CATALOGUE_DB, run, key, days, at)
    : beginStagingCleanup(env.CATALOGUE_DB, run, key, days, at));
  if (intent.state !== "completed") {
    try {
      await dispatchEvidenceCleanup(env.RECONCILIATION_WORKFLOW, intent.id, intent.ingestion_run_id, intent.generation);
    } catch {
      return pauseEvidenceCleanup(
        env.CATALOGUE_DB,
        intent.id,
        intent.generation,
        "evidence_cleanup_dispatch_retry_required",
      );
    }
  }
  return intent;
}
export async function retryEvidenceCleanup(
  env: { CATALOGUE_DB: CatalogueStore; RECONCILIATION_WORKFLOW: Workflow<ReconciliationWorkflowParams> },
  id: string,
  generation: unknown,
) {
  await resumeEvidenceCleanup(env.CATALOGUE_DB, id, generation);
  const intent = await inspectEvidenceCleanup(env.CATALOGUE_DB, id);
  if (intent.state !== "completed") {
    try {
      await dispatchEvidenceCleanup(env.RECONCILIATION_WORKFLOW, id, intent.ingestion_run_id, intent.generation);
    } catch {
      return pauseEvidenceCleanup(env.CATALOGUE_DB, id, intent.generation, "evidence_cleanup_dispatch_retry_required");
    }
  }
  return intent;
}
