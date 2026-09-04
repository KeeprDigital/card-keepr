import { seedRunFixtureStatement } from "./run-events";
export async function removeCuratedGuards(database: D1Database): Promise<void> {
  await database.batch([
    database.prepare("DROP TRIGGER IF EXISTS curated_revision_catalogue_revision_guard"),
    database.prepare("DROP TRIGGER IF EXISTS curated_revision_mutation_guard"),
    database.prepare("DROP TRIGGER IF EXISTS curated_revision_release_guard"),
    database.prepare("DROP TRIGGER IF EXISTS curated_revision_target_overlap_guard"),
    database.prepare("DROP TRIGGER IF EXISTS curated_revision_owner_event_catalogue_guard"),
    database.prepare("DROP TRIGGER IF EXISTS curated_revision_owner_event_operation_guard"),
    database.prepare("DROP TRIGGER IF EXISTS curated_revision_owner_event_release_guard"),
    database.prepare("DROP TRIGGER IF EXISTS curated_revision_pin_set_matches_run_start"),
    database.prepare("DROP TRIGGER IF EXISTS curated_revision_reconfirmation_blocks_run"),
  ]);
}

export function occupyCuratedAdministration(
  database: D1Database,
  kind: "ingestion" | "recovery" | "release",
): D1PreparedStatement {
  if (kind === "ingestion")
    return database.prepare("UPDATE operation_state SET active_ingestion_run_id = 'other_run' WHERE singleton = 1");
  if (kind === "recovery")
    return database.prepare("UPDATE operation_state SET recovery_health = 'blocked' WHERE singleton = 1");
  return database.prepare(
    "UPDATE operation_state SET active_production_release_id = 'other_release', active_production_release_expires_at = '9999-01-01T00:00:00.000Z' WHERE singleton = 1",
  );
}

export async function clearCuratedAdministration(database: D1Database): Promise<void> {
  await database.batch([
    database.prepare("DROP TRIGGER IF EXISTS catalogue_recovery_health_remains_blocked"),
    database.prepare(
      "UPDATE operation_state SET active_ingestion_run_id = NULL, recovery_health = 'healthy', active_production_release_id = NULL, active_production_release_expires_at = NULL WHERE singleton = 1",
    ),
  ]);
}

export function seedCuratedPinRun(database: D1Database, runId: string): D1PreparedStatement {
  return seedRunFixtureStatement(database, {
    id: runId,
    state: "planning",
    selected_games_json: '["one-piece"]',
    started_at: "2026-09-01T00:00:00.000Z",
    expected_current_revision_id: "catrev_spine_000",
    idempotency_key: runId,
    candidate_json: "{}",
  });
}
