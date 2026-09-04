// Prepared statements only; callers own execution and atomic batch composition.

export function recordWorkflowProgressStatement(
  database: D1Database,
  input: Readonly<{ instanceId: string; progressAt: string; workAt: string | null; stepName: string; phase: string }>,
): D1PreparedStatement {
  return database
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
    .bind(input.instanceId, input.progressAt, input.workAt, input.stepName, input.phase);
}
