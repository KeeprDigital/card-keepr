// Fixed inspection/fault queries; handoff statements themselves come from production.
export function expireLease(database) {
  return database.prepare(
    "UPDATE operation_state SET active_production_release_expires_at='2000-01-01T00:00:00.000Z' WHERE singleton=1",
  );
}
export function mutateCatalogue(database) {
  return database.prepare("UPDATE catalogue_state SET current_revision_id=current_revision_id WHERE singleton=1");
}
export function cleanupLease(database) {
  return database.prepare(
    "UPDATE operation_state SET active_production_release_id=NULL,active_production_release_expires_at=NULL WHERE singleton=1",
  );
}
export function schemaRows(database) {
  return database.prepare(
    "SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
}
export function seedSharedReference(database) {
  return database.prepare(
    "INSERT INTO evidence_object_references VALUES ('shared/retained-snapshot','owner_decision','source_owner','2026-09-08T00:00:00.000Z')",
  );
}
export function sharedReferences(database) {
  return database.prepare("SELECT * FROM evidence_object_references WHERE object_key='shared/retained-snapshot'");
}
export function attemptSharedDelete(database) {
  return database.prepare(
    "INSERT INTO staging_object_deletes(token,binding,object_key,incarnation,cleanup_id,started_at) VALUES ('late_delete','SOURCE_EVIDENCE','shared/retained-snapshot',0,'unused_cleanup','2026-09-08T00:00:00.000Z')",
  );
}
export function forceUnsettledWriter(database) {
  return database.prepare(
    "INSERT INTO evidence_object_writers(token,ingestion_run_id,object_key,started_at) VALUES ('ambiguous_writer','synthetic_run','shared/retained-snapshot','2026-09-08T00:00:00.000Z')",
  );
}
export function completeUnsettledWriter(database) {
  return database.prepare(
    "UPDATE evidence_object_writers SET completed_at='2026-09-08T00:01:00.000Z' WHERE token='ambiguous_writer'",
  );
}
export function foreignKeys(database, enabled) {
  database.exec(enabled ? "PRAGMA foreign_keys=ON" : "PRAGMA foreign_keys=OFF");
}
export function lowerBaselineLevel(database) {
  database.exec("UPDATE catalogue_schema_state SET migration_level=1 WHERE singleton=1");
}
