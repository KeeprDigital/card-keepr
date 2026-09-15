export function createVerifiedBackupFixture(database) {
  return database.prepare("CREATE TABLE catalogue_state (current_revision_id TEXT)");
}
