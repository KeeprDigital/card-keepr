export function seedMigrationRun(database) {
  return database.prepare(
    "INSERT INTO ingestion_runs(id,started_at,expected_current_revision_id,idempotency_key) VALUES (?,?,?,?)",
  );
}
export function seedMigrationRevision(database) {
  return database.prepare(
    "INSERT INTO catalogue_revisions(id,ingestion_run_id,published_at,content_digest,expected_previous_revision_id,approved_candidate_digest) VALUES (?,?,?,?,?,?)",
  );
}
export function seedMigrationCard(database) {
  return database.prepare("INSERT INTO revision_cards(catalogue_revision_id,card_id,document_json) VALUES (?,?,?)");
}
export function migrationRevisions(database) {
  return database.prepare("SELECT * FROM catalogue_revisions ORDER BY id");
}
export function migrationCards(database) {
  return database.prepare("SELECT * FROM revision_cards ORDER BY catalogue_revision_id,card_id");
}
export function migrationAdapters(database) {
  return database.prepare("SELECT * FROM source_adapter_versions ORDER BY adapter_version");
}
export function migrationLevel(database) {
  return database.prepare("SELECT migration_level FROM catalogue_schema_state WHERE singleton=1");
}
export function migrationForeignKeys(database) {
  return database.prepare("PRAGMA foreign_key_check");
}
