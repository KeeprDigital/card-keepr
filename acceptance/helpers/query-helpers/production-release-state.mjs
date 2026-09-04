import { DatabaseSync } from "node:sqlite";

export function releaseStateDatabase(state) {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE production_releases (
    id TEXT PRIMARY KEY, state TEXT NOT NULL, api_version_id TEXT, ingestion_version_id TEXT,
    binding_observation_json TEXT, smoke_evidence_json TEXT, terminal_at TEXT,
    roll_forward_required INTEGER NOT NULL DEFAULT 0, failure_code TEXT, failure_detail TEXT
  )`);
  database.prepare("INSERT INTO production_releases (id,state) VALUES ('release_matrix',?)").run(state);
  return database;
}

export function leaseStateDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(
    "CREATE TABLE operation_state (singleton INTEGER PRIMARY KEY,active_production_release_id TEXT,active_production_release_expires_at TEXT); INSERT INTO operation_state VALUES (1,NULL,NULL)",
  );
  return database;
}

export function changedReleaseRows(database) {
  return database.prepare("SELECT changes() AS changes");
}

export function releaseState(database) {
  return database.prepare("SELECT state, roll_forward_required FROM production_releases");
}

export function leaseState(database) {
  return database.prepare("SELECT active_production_release_id FROM operation_state");
}
