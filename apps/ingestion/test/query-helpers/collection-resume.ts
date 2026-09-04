// Test-only schema seam: exercise collection recovery after its unused audit
// history has been removed, before the final schema migration lands.
export async function removeIngestionTransitionAudit(database: D1Database): Promise<void> {
  await database.batch([
    database.prepare("DROP TRIGGER IF EXISTS record_initial_ingestion_state"),
    database.prepare("DROP TRIGGER IF EXISTS record_ingestion_transition"),
    database.prepare("DROP TABLE IF EXISTS ingestion_run_transitions"),
  ]);
}
