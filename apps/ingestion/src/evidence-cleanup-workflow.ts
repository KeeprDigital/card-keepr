import type { WorkflowStep } from "cloudflare:workers";
import {
  advanceEvidenceCleanup,
  advanceStagingCleanup,
  inspectEvidenceCleanup,
  pauseEvidenceCleanup,
} from "../../../src/catalogue/source-evidence";
import { dispatchEvidenceCleanup, type ReconciliationWorkflowParams } from "../../../src/catalogue/reconciliation";
import { catalogueStore } from "../../../src/catalogue/shared";

/** A bounded shard continues automatically; all progress remains in D1. */
export async function runEvidenceCleanupWorkflow(
  env: Env,
  step: WorkflowStep,
  params: NonNullable<ReconciliationWorkflowParams["evidence_cleanup"]>,
) {
  const db = catalogueStore(env.CATALOGUE_DB);
  let last = await inspectEvidenceCleanup(db, params.id);
  try {
    for (let unit = 0; unit < 16; unit++) {
      last = await step.do(
        `cleanup unit ${unit}`,
        { retries: { limit: 3, delay: 250, backoff: "exponential" }, timeout: "1 minute" },
        async () => {
          const current = await inspectEvidenceCleanup(db, params.id);
          if (current.generation !== params.generation || current.state === "completed") return current;
          return current.scope === "staging"
            ? advanceStagingCleanup(db, env, params.id, new Date().toISOString())
            : advanceEvidenceCleanup(db, env.EVIDENCE_OBJECTS, params.id, new Date().toISOString());
        },
      );
      if (last.generation !== params.generation || last.state === "completed" || last.state === "paused")
        return { result_json: JSON.stringify(last) };
    }
    await step.do("dispatch cleanup continuation", async () => {
      await dispatchEvidenceCleanup(
        env.RECONCILIATION_WORKFLOW,
        params.id,
        last.ingestion_run_id,
        params.generation,
        params.shard + 1,
      );
      return { dispatched: true };
    });
    return { result_json: JSON.stringify(last) };
  } catch {
    last = await step.do("retain cleanup failure", async () =>
      pauseEvidenceCleanup(db, params.id, params.generation, "evidence_cleanup_workflow_retry_required"),
    );
    return { result_json: JSON.stringify(last) };
  }
}
