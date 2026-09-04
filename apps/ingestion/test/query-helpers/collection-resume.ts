// Test-only schema seam: exercise collection recovery after its unused audit
// history has been removed, before the final schema migration lands.
export async function removeIngestionTransitionAudit(database: D1Database): Promise<void> {
  await database.batch([
    database.prepare("DROP TRIGGER IF EXISTS record_initial_ingestion_state"),
    database.prepare("DROP TRIGGER IF EXISTS record_ingestion_transition"),
    database.prepare("DROP TABLE IF EXISTS ingestion_run_transitions"),
  ]);
}

export function dropSourceRequestPlanGuard(database: D1Database): D1PreparedStatement {
  return database.prepare("DROP TRIGGER IF EXISTS source_requests_must_match_immutable_plan");
}

export function dropCollectionPlanDiscoveryGuard(database: D1Database): D1PreparedStatement {
  return database.prepare("DROP TRIGGER IF EXISTS official_source_collection_plan_discovery_owner");
}

export function dropEvidencePlanOriginGuard(database: D1Database): D1PreparedStatement {
  return database.prepare("DROP TRIGGER IF EXISTS ingestion_evidence_plan_origin_matches_adapter");
}

export function inspectEvidencePlanCount(database: D1Database, runId: string): D1PreparedStatement {
  return database
    .prepare("SELECT COUNT(*) AS count FROM ingestion_evidence_plans WHERE ingestion_run_id = ?")
    .bind(runId);
}

export async function dropPausePrerequisiteGuards(database: D1Database): Promise<void> {
  await database.batch([
    database.prepare("DROP TRIGGER IF EXISTS guard_capacity_extension_requires_paused_run"),
    database.prepare("DROP TRIGGER IF EXISTS guard_capacity_pause_requires_paused_run"),
    database.prepare("DROP TRIGGER IF EXISTS guard_retry_pause_requires_paused_run"),
    database.prepare("DROP TRIGGER IF EXISTS guard_termination_requires_paused_run"),
    database.prepare("DROP TRIGGER IF EXISTS guard_workflow_pause_requires_paused_run"),
  ]);
}

export function inspectSourceRequestIds(database: D1Database, runId: string): D1PreparedStatement {
  return database
    .prepare("SELECT request_id FROM source_requests WHERE ingestion_run_id = ? ORDER BY sequence_number")
    .bind(runId);
}

export function inspectCollectionPlanCount(database: D1Database, runId: string): D1PreparedStatement {
  return database
    .prepare("SELECT COUNT(*) AS count FROM official_source_collection_plans WHERE ingestion_run_id = ?")
    .bind(runId);
}

export function requireCuratedReconfirmation(database: D1Database, revisionId: string): D1PreparedStatement {
  return database
    .prepare("UPDATE curated_revisions SET status = 'reconfirmation_required' WHERE id = ?")
    .bind(revisionId);
}

export function inspectRunCount(database: D1Database, runId: string): D1PreparedStatement {
  return database.prepare("SELECT COUNT(*) AS count FROM ingestion_runs WHERE id = ?").bind(runId);
}
