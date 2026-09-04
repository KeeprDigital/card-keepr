import { advancesCollectionProgress, type CatalogueStore, type WorkflowProgress } from "../shared";
import { workflowAttemptStatements } from "./source-evidence-repository";
import { recordWorkflowProgressStatement } from "./workflow-progress-repository";

/** Identity is immutable; a callback advances only its own retained progress fact. */
export async function recordIngestionWorkflowProgress(
  database: CatalogueStore,
  runId: string,
  instanceId: string,
  kind: "parent" | "child",
  progress: WorkflowProgress,
): Promise<void> {
  await database.batch([
    ...workflowAttemptStatements(database, runId, [instanceId]),
    recordWorkflowProgressStatement(database, {
      instanceId: instanceId,
      progressAt: progress.at,
      workAt: advancesCollectionProgress(kind, progress.name) ? progress.at : null,
      stepName: progress.name,
      phase: progress.phase,
    }),
  ]);
}
