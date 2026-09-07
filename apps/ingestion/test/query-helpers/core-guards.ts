import { seedRunFixtureStatement } from "./run-events";
import {
  catalogueStore,
  runEventCommand,
  runEventIdentitySql,
  runEventStatement,
  runTransitionGuardStatement,
  type CatalogueStore,
  repositoryStatements,
} from "../../../../src/catalogue/shared";

export async function removeCoreRunGuards(database: D1Database): Promise<void> {
  await database.batch([
    database.prepare("DROP TRIGGER IF EXISTS guard_active_ingestion_identity"),
    database.prepare("DROP TRIGGER IF EXISTS guard_legal_ingestion_transition"),
    database.prepare("DROP TRIGGER IF EXISTS guard_candidate_finalization"),
    database.prepare("DROP TRIGGER IF EXISTS guard_approval_transition"),
  ]);
}

export async function seedCoreGuardRun(database: D1Database, id: string, state: string, active = true): Promise<void> {
  await catalogueStore(database).batch([
    database.prepare("UPDATE operation_state SET active_ingestion_run_id = NULL WHERE singleton = 1"),
    seedRunFixtureStatement(database, {
      id,
      state,
      selected_games_json: '["one-piece"]',
      started_at: "2026-09-01T00:00:00.000Z",
      expected_current_revision_id: "catrev_spine_000",
      idempotency_key: id,
      candidate_json: "{}",
      candidate_digest: "candidate",
      candidate_catalogue_digest: "catalogue",
      candidate_created_at: "2026-09-01T00:00:00.000Z",
      approval_deadline: "2026-09-08T00:00:00.000Z",
    }),
  ]);
  if (active)
    await catalogueStore(database).batch([
      database.prepare("INSERT INTO ingestion_collection_reservations (ingestion_run_id) VALUES (?)").bind(id),
      database.prepare("UPDATE operation_state SET active_ingestion_run_id = ? WHERE singleton = 1").bind(id),
    ]);
}

export function coreGuardRun(database: CatalogueStore, id: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("SELECT state, failure_code, candidate_digest FROM ingestion_run_read WHERE id = ?")
    .bind(id);
}

export function markCoreGuardSibling(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(
    "UPDATE catalogue_state SET published_at = 'guard sibling' WHERE singleton = 1",
  );
}

export function coreGuardPublicationTime(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare("SELECT published_at FROM catalogue_state WHERE singleton = 1");
}

export async function removeAdministrationGuards(database: D1Database): Promise<void> {
  await database.batch([
    database.prepare("DROP TRIGGER IF EXISTS guard_idempotency_claim_after_completion"),
    database.prepare("DROP TRIGGER IF EXISTS guard_idempotency_outcome_owner"),
    database.prepare("DROP TRIGGER IF EXISTS guard_cleanup_idempotency_completion"),
  ]);
}

export async function retainCoreTermination(database: D1Database, runId: string): Promise<void> {
  await database
    .prepare(`INSERT INTO ingestion_run_terminations (
    ingestion_run_id, pause_reason, paused_at, terminated_at, idempotency_key, request_digest, response_json
  ) VALUES (?, 'owner_requested', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', ?, ?, '{}')`)
    .bind(runId, runId, "a".repeat(64))
    .run();
}

export function terminateCoreRunWithFailureCode(
  database: CatalogueStore,
  runId: string,
  failureCode: string | null,
): D1PreparedStatement {
  const event = runEventCommand("collection_terminated", { runId, occurredAt: "2026-09-01T00:00:00.000Z" });
  return runEventStatement(database, {
    event,
    statement: repositoryStatements(database)
      .prepare(`UPDATE ingestion_run_current SET ${runEventIdentitySql}, state = 'failed', failure_code = ?,
        terminal_at = ? WHERE ingestion_run_id = ? AND state = 'paused'`)
      .bind(event.eventId, failureCode, event.occurredAt, runId),
    guards: [runTransitionGuardStatement(database, { runId, from: "paused", to: "failed" })],
  });
}

export async function removePublicationGuards(database: D1Database): Promise<void> {
  await database.batch([
    database.prepare("DROP TRIGGER IF EXISTS guard_catalogue_publication"),
    database.prepare("DROP TRIGGER IF EXISTS guard_no_change_result"),
    database.prepare("DROP TRIGGER IF EXISTS revision_printing_image_content_projected"),
  ]);
}

export function coreRevisionImageCount(database: CatalogueStore, revisionId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("SELECT count(*) AS count FROM revision_printing_images WHERE catalogue_revision_id = ?")
    .bind(revisionId);
}

export async function setCoreRunStartRecoveryBlock(
  database: D1Database,
  mode: "health" | "restore" | "clear",
): Promise<void> {
  await database.batch([
    database.prepare("DROP TRIGGER IF EXISTS require_idle_ingestion"),
    database.prepare("DROP TRIGGER IF EXISTS require_recovery_idle_ingestion"),
    database.prepare("DROP TRIGGER IF EXISTS catalogue_recovery_health_remains_blocked"),
    database
      .prepare(
        "UPDATE operation_state SET active_ingestion_run_id = NULL, recovery_health = ?, recovery_restore_guard = ? WHERE singleton = 1",
      )
      .bind(mode === "health" ? "blocked" : "healthy", mode === "restore" ? "blocked" : "clear"),
  ]);
}
