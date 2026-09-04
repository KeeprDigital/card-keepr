// Wrangler's migration ledger, shared by the in-process acceptance runner.
export function createMigrationLedger(database) {
  return database.prepare(`CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`);
}

export function appliedMigrations(database) {
  return database.prepare("SELECT name FROM d1_migrations");
}

export function recordMigration(database, name) {
  return database.prepare("INSERT INTO d1_migrations(name) VALUES (?)").bind(name);
}
