import { reserveIngestionCollectionStatement } from "../../../../src/catalogue/shared/ingestion-reservation-repository";
import {
  atomicRepositoryStatement,
  catalogueStore,
  repositoryStatements,
  runEventCommand,
  runEventIdentitySql,
  runEventStatement,
  runStartGuardStatement,
} from "../../../../src/catalogue/shared";
import {
  emptyRunCurrent,
  runCurrentColumns,
  runCurrentNullableColumns,
  type RunEventKind,
} from "../../../../src/catalogue/shared/ingestion-run-events";
import { activeRunStages, type IngestionRunState } from "../../../../src/catalogue/shared/ingestion-run-state";

type FixtureRun = Record<string, unknown> & { id: unknown; state: unknown; idempotency_key?: unknown };
/** Test data is authored as facts with an explicit state path. This seam never
 * interprets SQL or installs compatibility triggers in the application schema.
 */
export function seedRunFixtureStatement(
  database: D1Database,
  input: FixtureRun,
  guardStart = false,
): D1PreparedStatement {
  const store = catalogueStore(database);
  const runId = String(input.id);
  const state = String(input.state) as IngestionRunState;
  const stages = [
    "planning",
    "collecting",
    "parsing",
    "reconciling",
    "awaiting_approval",
    "publishing",
    "published",
  ] as const;
  const targetIndex = stages.indexOf(state as (typeof stages)[number]);
  const path: readonly IngestionRunState[] =
    targetIndex >= 0
      ? stages.slice(0, targetIndex + 1)
      : state === "paused"
        ? ["planning", "collecting", "paused"]
        : state === "rejected" || state === "expired"
          ? [...stages.slice(0, 5), state]
          : state === "failed"
            ? input.failure_code === "ingestion_run_terminated"
              ? ["planning", "collecting", "paused", "failed"]
              : ["planning", "failed"]
            : (() => {
                throw new TypeError("Unknown fixture Ingestion Run state.");
              })();
  const startedAt = text(input.started_at) ?? "2026-09-01T00:00:00.000Z";
  const statements: D1PreparedStatement[] = [fixtureBirthStatement(database, input, state === "planning", guardStart)];
  // A planning fixture can carry candidate/diagnostic facts at birth; scalar
  // identity facts for later states are supplied on the accepted final event.
  for (const [index, next] of path.entries()) {
    if (index === 0) continue;
    const final = index === path.length - 1;
    const kind: RunEventKind =
      next === "paused"
        ? "collection_paused"
        : next === "awaiting_approval"
          ? "candidate_prepared"
          : next === "publishing"
            ? "approval_reserved"
            : next === "published"
              ? "published"
              : next === "rejected"
                ? "rejected"
                : next === "expired"
                  ? "expired"
                  : next === "failed"
                    ? input.failure_code === "ingestion_run_terminated"
                      ? "collection_terminated"
                      : "failed"
                    : "stage_changed";
    const event = runEventCommand(kind, {
      runId,
      occurredAt: text(input.terminal_at) ?? text(input.candidate_created_at) ?? startedAt,
    });
    const approval =
      input.approval_json === undefined || input.approval_json === null
        ? {}
        : (JSON.parse(String(input.approval_json)) as Record<string, unknown>);
    const progress =
      final && typeof input.progress_json === "string"
        ? (JSON.parse(input.progress_json) as { completed_stages?: unknown[] })
        : null;
    const completed =
      progress?.completed_stages?.length ??
      (next === "paused"
        ? 1
        : next === "rejected" || next === "expired"
          ? 4
          : next === "failed"
            ? input.failure_code === "ingestion_run_terminated"
              ? 1
              : 0
            : next === "published"
              ? 6
              : activeRunStages.indexOf(next as (typeof activeRunStages)[number]));
    const scalars = runCurrentNullableColumns.map((column) =>
      !final
        ? null
        : column === "approved_at"
          ? text(approval.approved_at)
          : column === "approved_candidate_digest"
            ? text(approval.candidate_digest)
            : column === "approved_expected_revision_id"
              ? text(approval.expected_current_revision_id)
              : text(input[column]),
    );
    const history =
      final && typeof input.approval_history_json === "string"
        ? (JSON.parse(input.approval_history_json) as unknown[])
        : [];
    statements.push(
      runEventStatement(store, {
        event,
        statement: repositoryStatements(store)
          .prepare(
            `UPDATE ingestion_run_current SET ${runEventIdentitySql}, state = ?, completed_stage_count = ?, ${runCurrentNullableColumns.map((column) => `${column} = ?`).join(", ")} WHERE ingestion_run_id = ?`,
          )
          .bind(event.eventId, next, completed, ...scalars, runId),
        ...(final && input.approval_idempotency_key != null
          ? { approvalIdempotencyKey: String(input.approval_idempotency_key) }
          : {}),
        ...(history.length > 0 ? { decisionJson: JSON.stringify(history.at(-1)) } : {}),
      }),
    );
  }
  const primary = statements.pop();
  if (primary === undefined) throw new Error("Fixture run has no birth event.");
  return atomicRepositoryStatement(store, { statement: primary, before: statements });
}

/** Retain the established named fixture factories' bind-at-call-site interface. */
export function bindRunFixtureStatement(
  database: D1Database,
  input: (...values: unknown[]) => FixtureRun,
  guardStart = false,
): D1PreparedStatement {
  const bind = (...values: unknown[]) => seedRunFixtureStatement(database, input(...values), guardStart);
  return {
    bind,
    run: () => bind().run(),
    all: () => bind().all(),
    first: (column?: string) => (column === undefined ? bind().first() : bind().first(column)),
    raw: () => bind().raw(),
  } as D1PreparedStatement;
}
function text(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}

function fixtureBirthStatement(
  database: D1Database,
  input: FixtureRun,
  final: boolean,
  guardStart: boolean,
): D1PreparedStatement {
  const store = catalogueStore(database);
  const runId = String(input.id);
  const startedAt = text(input.started_at) ?? "2026-09-01T00:00:00.000Z";
  const event = runEventCommand("created", { runId, occurredAt: startedAt });
  const selectedGamesJson = text(input.selected_games_json) ?? '["one-piece"]';
  const current = emptyRunCurrent(runId, event.eventId, "planning");
  current.candidate_payload_event_sequence = 1;
  current.diagnostics_event_sequence = 1;
  if (final) for (const column of runCurrentNullableColumns) current[column] = text(input[column]);
  const anchor = repositoryStatements(store)
    .prepare(`INSERT INTO ingestion_runs
    (id, started_at, expected_current_revision_id, linked_run_id, idempotency_key, operational_request_id)
    SELECT ?, ?, COALESCE(?, current_revision_id), ?, ?, ? FROM catalogue_state WHERE singleton=1`)
    .bind(
      runId,
      startedAt,
      text(input.expected_current_revision_id),
      text(input.linked_run_id),
      text(input.idempotency_key) ?? runId,
      text(input.operational_request_id),
    );
  const games = repositoryStatements(store)
    .prepare(`INSERT INTO ingestion_run_selected_games (ingestion_run_id, ordinal, game)
    SELECT ?, CAST(key AS INTEGER), value FROM json_each(?)`)
    .bind(runId, selectedGamesJson);
  return runEventStatement(store, {
    event,
    selectedGamesJson,
    candidateJson: text(input.candidate_json) ?? "{}",
    diagnosticsJson: text(input.warnings_json) ?? "[]",
    before: [anchor, games],
    guards: guardStart ? [runStartGuardStatement(store)] : [],
    after: guardStart ? [reserveIngestionCollectionStatement(store, runId)] : [],
    statement: repositoryStatements(store)
      .prepare(
        `INSERT INTO ingestion_run_current (${runCurrentColumns.join(", ")}) VALUES (${runCurrentColumns.map(() => "?").join(", ")})`,
      )
      .bind(...runCurrentColumns.map((column) => current[column])),
  });
}
