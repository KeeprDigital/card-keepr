import { advancesCollectionProgress, type WorkflowProgress } from "../shared";
import { workflowAttemptStatements } from "./source-evidence-repository";

/** Identity is immutable; a callback advances only its own retained progress fact. */
export async function recordIngestionWorkflowProgress(
  database: D1Database,
  runId: string,
  instanceId: string,
  kind: "parent" | "child",
  progress: WorkflowProgress,
): Promise<void> {
  await database.batch([
    ...workflowAttemptStatements(database, runId, [instanceId]),
    database
      .prepare(`INSERT INTO ingestion_workflow_progress (
      workflow_instance_id, last_progress_at, last_work_at, last_step_name, last_phase
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (workflow_instance_id) DO UPDATE SET
      last_progress_at = excluded.last_progress_at,
      last_work_at = CASE WHEN excluded.last_work_at IS NULL THEN ingestion_workflow_progress.last_work_at
        WHEN ingestion_workflow_progress.last_work_at IS NULL THEN excluded.last_work_at
        ELSE MAX(ingestion_workflow_progress.last_work_at, excluded.last_work_at) END,
      last_step_name = excluded.last_step_name,
      last_phase = excluded.last_phase
    WHERE excluded.last_progress_at >= ingestion_workflow_progress.last_progress_at`)
      .bind(
        instanceId,
        progress.at,
        advancesCollectionProgress(kind, progress.name) ? progress.at : null,
        progress.name,
        progress.phase,
      ),
  ]);
}
