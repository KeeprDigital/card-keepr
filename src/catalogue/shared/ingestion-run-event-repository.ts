import { atomicRepositoryStatement, type CatalogueStore, repositoryStatements } from "./catalogue-store-repository";
import {
  runCurrentColumns,
  type RunEventKind,
  type RunEventRow,
  type RunCurrent,
  projectIngestionRunEvent,
} from "./ingestion-run-events";
import { byteChunks } from "./reconciliation-payload";

export type RunEventCommand = Readonly<{ eventId: string; kind: RunEventKind; runId: string; occurredAt: string }>;
export function runEventCommand(kind: RunEventKind, input: { runId: string; occurredAt?: string }): RunEventCommand {
  return {
    kind,
    runId: input.runId,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    eventId: crypto.randomUUID(),
  };
}
/** Fixed assignments for named repository UPDATEs; bind eventId first. */
export const runEventIdentitySql =
  "previous_state = state, last_event_sequence = last_event_sequence + 1, last_event_id = ?";
const currentSnapshotSql = `json_object(${runCurrentColumns.map((column) => `'${column}', current.${column}`).join(", ")})`;

type RunEventMutation = Readonly<{
  event: RunEventCommand;
  statement: D1PreparedStatement;
  before?: readonly D1PreparedStatement[];
  guards?: readonly D1PreparedStatement[];
  after?: readonly D1PreparedStatement[];
  candidateJson?: string;
  diagnosticsJson?: string;
  selectedGamesJson?: string;
  decisionJson?: string;
  approvalIdempotencyKey?: string;
}>;

/** The primary CAS, authority guards, immutable result, and payloads share the
 * caller's native transaction. Guards remain adjacent to the primary so their
 * changes() predicate cannot be replaced by an event or payload INSERT result.
 */
export function runEventStatement(database: CatalogueStore, input: RunEventMutation): D1PreparedStatement {
  const { event } = input;
  const payloads = (
    [
      ["candidate", input.candidateJson],
      ["diagnostics", input.diagnosticsJson],
    ] as const
  )
    .filter((entry): entry is readonly ["candidate" | "diagnostics", string] => entry[1] !== undefined)
    .map(([kind, value]) => {
      JSON.parse(value);
      return { kind, chunks: byteChunks(value), bytes: new TextEncoder().encode(value).byteLength };
    });
  const metadata = JSON.stringify(
    Object.fromEntries(payloads.map(({ kind, chunks, bytes }) => [kind, { chunks: chunks.length, bytes }])),
  );
  const append = repositoryStatements(database)
    .prepare(`INSERT INTO ingestion_run_events
    (ingestion_run_id, sequence_number, event_id, event_kind, occurred_at, from_state, to_state, payload_json)
    SELECT current.ingestion_run_id, current.last_event_sequence, current.last_event_id, ?, ?, current.previous_state, current.state,
      json_object('current', ${currentSnapshotSql}, 'selected_games', json(?), 'decision', json(?), 'payloads', json(?), 'approval_idempotency_key', ?)
    FROM ingestion_run_current AS current
    WHERE current.ingestion_run_id = ? AND current.last_event_id = ? AND changes() > 0`)
    .bind(
      event.kind,
      event.occurredAt,
      input.selectedGamesJson ?? "null",
      input.decisionJson ?? "null",
      metadata,
      input.approvalIdempotencyKey ?? null,
      event.runId,
      event.eventId,
    );
  const chunks = payloads.flatMap(({ kind, chunks }) =>
    chunks.map((content, index) =>
      repositoryStatements(database)
        .prepare(`INSERT OR IGNORE INTO ingestion_run_event_payload_chunks
      (ingestion_run_id, event_sequence, payload_kind, chunk_index, content)
      SELECT ingestion_run_id, sequence_number, ?, ?, ? FROM ingestion_run_events WHERE event_id = ? AND ingestion_run_id = ?`)
        .bind(kind, index, content, event.eventId, event.runId),
    ),
  );
  const claim =
    input.approvalIdempotencyKey === undefined
      ? []
      : [
          repositoryStatements(database)
            .prepare(`UPDATE ingestion_runs SET approval_idempotency_key = ? WHERE id = ?
      AND EXISTS (SELECT 1 FROM ingestion_run_events WHERE event_id = ? AND ingestion_run_id = ingestion_runs.id)`)
            .bind(input.approvalIdempotencyKey, event.runId, event.eventId),
        ];
  return atomicRepositoryStatement(database, {
    statement: input.statement,
    before: [
      ...(input.before ?? []),
      runCurrentIntegrityGuardStatement(database, event.runId, event.kind === "created"),
    ],
    after: [...(input.guards ?? []), append, ...chunks, ...claim, ...(input.after ?? [])],
  });
}

export function createRunEventStatement(
  database: CatalogueStore,
  input: Readonly<{
    runId: string;
    selectedGamesJson: string;
    startedAt: string;
    expectedRevisionId?: string;
    linkedRunId: string | null;
    idempotencyKey: string;
    operationalRequestId?: string | null;
    state: "planning" | "collecting";
    candidateJson?: string;
    diagnosticsJson?: string;
    guards?: readonly D1PreparedStatement[];
  }>,
): D1PreparedStatement {
  const event = runEventCommand("created", { runId: input.runId, occurredAt: input.startedAt });
  const anchor = repositoryStatements(database)
    .prepare(`INSERT INTO ingestion_runs
    (id, started_at, expected_current_revision_id, linked_run_id, idempotency_key, operational_request_id)
    SELECT ?, ?, COALESCE(?, current_revision_id), ?, ?, ? FROM catalogue_state WHERE singleton = 1`)
    .bind(
      input.runId,
      input.startedAt,
      input.expectedRevisionId ?? null,
      input.linkedRunId,
      input.idempotencyKey,
      input.operationalRequestId ?? null,
    );
  const games = repositoryStatements(database)
    .prepare(`INSERT INTO ingestion_run_selected_games (ingestion_run_id, ordinal, game)
    SELECT ?, CAST(key AS INTEGER), value FROM json_each(?)`)
    .bind(input.runId, input.selectedGamesJson);
  const current = repositoryStatements(database)
    .prepare(`INSERT INTO ingestion_run_current
    (ingestion_run_id, last_event_sequence, last_event_id, previous_state, state, completed_stage_count, candidate_payload_event_sequence, diagnostics_event_sequence)
    VALUES (?, 1, ?, NULL, ?, ?, ?, ?)`)
    .bind(
      input.runId,
      event.eventId,
      input.state,
      input.state === "planning" ? 0 : 1,
      input.candidateJson === undefined ? null : 1,
      input.diagnosticsJson === undefined ? null : 1,
    );
  return runEventStatement(database, {
    event,
    statement: current,
    before: [anchor, games],
    guards: input.guards,
    candidateJson: input.candidateJson,
    diagnosticsJson: input.diagnosticsJson,
    selectedGamesJson: input.selectedGamesJson,
  });
}

export function runEventsPageStatement(
  database: CatalogueStore,
  runId: string,
  afterSequence: number,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT * FROM ingestion_run_events
    WHERE ingestion_run_id = ? AND sequence_number > ? ORDER BY sequence_number LIMIT 100`)
    .bind(runId, afterSequence);
}
export async function foldRunEvents(database: CatalogueStore, runId: string): Promise<RunCurrent> {
  let current: RunCurrent | null = null;
  for (;;) {
    const page = await runEventsPageStatement(database, runId, current?.last_event_sequence ?? 0).all<RunEventRow>();
    for (const event of page.results) current = projectIngestionRunEvent(current, event);
    if (page.results.length < 100) break;
  }
  if (current === null) throw new Error("Ingestion Run event history is missing.");
  return current;
}

const selectedGamesMatchSql = `COALESCE((SELECT json_group_array(game) FROM (
  SELECT game FROM ingestion_run_selected_games WHERE ingestion_run_id = current.ingestion_run_id ORDER BY ordinal
)), '[]') = (SELECT json_extract(payload_json, '$.selected_games') FROM ingestion_run_events
  WHERE ingestion_run_id = current.ingestion_run_id AND sequence_number = 1)`;
export const verifiedRunCurrentSql = `EXISTS (SELECT 1 FROM ingestion_run_events AS event
  WHERE event.ingestion_run_id = current.ingestion_run_id AND event.sequence_number = current.last_event_sequence
  AND event.event_id = current.last_event_id AND json_extract(event.payload_json, '$.current') = ${currentSnapshotSql}
  AND event.sequence_number = (SELECT max(sequence_number) FROM ingestion_run_events WHERE ingestion_run_id = current.ingestion_run_id)
) AND ${selectedGamesMatchSql}`;

export function runCurrentIntegrityGuardStatement(
  database: CatalogueStore,
  runId: string,
  creating = false,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT CASE
    WHEN ? = 0 AND EXISTS (SELECT 1 FROM ingestion_runs WHERE id = ?)
      AND NOT EXISTS (SELECT 1 FROM ingestion_run_current WHERE ingestion_run_id = ?)
      THEN json_extract('{}', 'ingestion_run_projection_missing')
    WHEN EXISTS (SELECT 1 FROM ingestion_run_current AS current WHERE ingestion_run_id = ? AND (${verifiedRunCurrentSql}) IS NOT 1)
      THEN json_extract('{}', 'ingestion_run_projection_mismatch') ELSE 1 END`)
    .bind(Number(creating), runId, runId, runId);
}

/** A disposable projection can never establish that an absent run is terminal. */
export function releaseTerminalRunEventLockStatement(
  database: CatalogueStore,
  activeStatesJson: string,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE operation_state SET active_ingestion_run_id = NULL
    WHERE singleton = 1 AND (NOT EXISTS (SELECT 1 FROM ingestion_runs WHERE id = operation_state.active_ingestion_run_id) OR active_ingestion_run_id IN (
      SELECT current.ingestion_run_id FROM ingestion_run_current AS current
      WHERE current.state NOT IN (SELECT value FROM json_each(?)) AND ${verifiedRunCurrentSql}
    ))`)
    .bind(activeStatesJson);
}

/** One set-based CAS and one event INSERT preserve the previous sweep count. */
export function expireRunEventsStatement(database: CatalogueStore, observedAt: string): D1PreparedStatement {
  const sweepId = crypto.randomUUID();
  const integrity = repositoryStatements(database)
    .prepare(`SELECT CASE WHEN EXISTS (
    SELECT 1 FROM ingestion_run_current AS current WHERE state = 'awaiting_approval'
      AND approval_deadline <= ? AND (${verifiedRunCurrentSql}) IS NOT 1
  ) THEN json_extract('{}', 'ingestion_run_projection_mismatch') ELSE 1 END`)
    .bind(observedAt);
  const statement = repositoryStatements(database)
    .prepare(`UPDATE ingestion_run_current
    SET previous_state = state, state = 'expired', terminal_at = approval_deadline,
      last_event_sequence = last_event_sequence + 1, last_event_id = ? || ':' || ingestion_run_id
    WHERE state = 'awaiting_approval' AND approval_deadline IS NOT NULL AND approval_deadline <= ?`)
    .bind(sweepId, observedAt);
  const append = repositoryStatements(database)
    .prepare(`INSERT INTO ingestion_run_events
    (ingestion_run_id, sequence_number, event_id, event_kind, occurred_at, from_state, to_state, payload_json)
    SELECT current.ingestion_run_id, current.last_event_sequence, current.last_event_id, 'expired', current.terminal_at,
      current.previous_state, current.state, json_object('current', ${currentSnapshotSql}, 'payloads', json('{}'))
    FROM ingestion_run_current AS current
    WHERE current.last_event_id = ? || ':' || current.ingestion_run_id AND changes() > 0`)
    .bind(sweepId);
  return atomicRepositoryStatement(database, { statement, before: [integrity], after: [append] });
}

export type RunProjectionMaintenance = Readonly<{ ownerId: string; observedAt: string }>;
function projectionMaintenanceGuardStatement(
  database: CatalogueStore,
  input: RunProjectionMaintenance,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN EXISTS (
    SELECT 1 FROM operation_state WHERE singleton = 1 AND (
      (active_production_release_id = ? AND active_production_release_expires_at > ?)
      OR (active_recovery_id = ? AND recovery_health = 'blocked' AND recovery_restore_guard = 'blocked')
    )
  ) THEN 1 ELSE json_extract('{}', 'ingestion_run_rebuild_requires_maintenance') END`)
    .bind(input.ownerId, input.observedAt, input.ownerId);
}

/** Rebuild one bounded aggregate without issuing commands or replaying effects.
 * The final event CAS rejects history advanced during the fold. All replacement
 * rows are committed together, so readers never observe a half-built run.
 */
export async function rebuildRunProjection(
  database: CatalogueStore,
  runId: string,
  maintenance: RunProjectionMaintenance,
): Promise<RunCurrent> {
  await projectionMaintenanceGuardStatement(database, maintenance).all();
  const current = await foldRunEvents(database, runId);
  const eventFence = repositoryStatements(database)
    .prepare(`SELECT CASE WHEN EXISTS (
    SELECT 1 FROM ingestion_run_events WHERE ingestion_run_id = ? AND sequence_number = ? AND event_id = ?
      AND sequence_number = (SELECT max(sequence_number) FROM ingestion_run_events WHERE ingestion_run_id = ?)
  ) THEN 1 ELSE json_extract('{}', 'ingestion_run_history_advanced') END`)
    .bind(runId, current.last_event_sequence, current.last_event_id, runId);
  const payloadGuard = repositoryStatements(database)
    .prepare(`SELECT CASE WHEN EXISTS (
    SELECT 1 FROM ingestion_run_events AS event, json_each(event.payload_json, '$.payloads') AS payload
    WHERE event.ingestion_run_id = ? AND (
      (SELECT count(*) FROM ingestion_run_event_payload_chunks AS chunk WHERE chunk.ingestion_run_id = event.ingestion_run_id AND chunk.event_sequence = event.sequence_number AND chunk.payload_kind = payload.key) <> json_extract(payload.value, '$.chunks')
      OR (SELECT min(chunk_index) FROM ingestion_run_event_payload_chunks AS chunk WHERE chunk.ingestion_run_id = event.ingestion_run_id AND chunk.event_sequence = event.sequence_number AND chunk.payload_kind = payload.key) IS NOT 0
      OR (SELECT max(chunk_index) FROM ingestion_run_event_payload_chunks AS chunk WHERE chunk.ingestion_run_id = event.ingestion_run_id AND chunk.event_sequence = event.sequence_number AND chunk.payload_kind = payload.key) + 1 <> json_extract(payload.value, '$.chunks')
      OR (SELECT sum(length(CAST(content AS BLOB))) FROM ingestion_run_event_payload_chunks AS chunk WHERE chunk.ingestion_run_id = event.ingestion_run_id AND chunk.event_sequence = event.sequence_number AND chunk.payload_kind = payload.key) <> json_extract(payload.value, '$.bytes')
    )
  ) THEN json_extract('{}', 'ingestion_run_payload_incomplete') ELSE 1 END`)
    .bind(runId);
  const projection = repositoryStatements(database)
    .prepare(`INSERT INTO ingestion_run_current (${runCurrentColumns.join(", ")})
    VALUES (${runCurrentColumns.map(() => "?").join(", ")}) ON CONFLICT (ingestion_run_id) DO UPDATE SET
    ${runCurrentColumns
      .filter((column) => column !== "ingestion_run_id")
      .map((column) => `${column} = excluded.${column}`)
      .join(", ")}`)
    .bind(...runCurrentColumns.map((column) => current[column]));
  await database.batch([
    projectionMaintenanceGuardStatement(database, maintenance),
    eventFence,
    payloadGuard,
    projection,
    repositoryStatements(database)
      .prepare("DELETE FROM ingestion_run_selected_games WHERE ingestion_run_id = ?")
      .bind(runId),
    repositoryStatements(database)
      .prepare(`INSERT INTO ingestion_run_selected_games (ingestion_run_id, ordinal, game)
      SELECT event.ingestion_run_id, CAST(game.key AS INTEGER), game.value FROM ingestion_run_events AS event,
        json_each(event.payload_json, '$.selected_games') AS game WHERE event.ingestion_run_id = ? AND event.sequence_number = 1`)
      .bind(runId),
  ]);
  return current;
}
