import {
  activeRunStages,
  canTransitionIngestionRun,
  isIngestionRunState,
  type IngestionRunState,
} from "./ingestion-run-state";

export const runEventKinds = [
  "created",
  "stage_changed",
  "collection_paused",
  "collection_resumed",
  "collection_terminated",
  "candidate_prepared",
  "candidate_blocked",
  "approval_reserved",
  "rejected",
  "expired",
  "failed",
  "published",
] as const;
export type RunEventKind = (typeof runEventKinds)[number];
export const runCurrentNullableColumns = [
  "candidate_digest",
  "candidate_catalogue_digest",
  "candidate_created_at",
  "approval_deadline",
  "approved_at",
  "approved_candidate_digest",
  "approved_expected_revision_id",
  "failure_code",
  "terminal_at",
  "publication_revision_id",
  "publication_started_at",
  "publication_reconcile_after",
  "publication_manifest_digest",
  "publication_writer_token",
  "published_revision_id",
  "export_manifest_digest",
  "publication_outcome",
  "resulting_revision_id",
  "freshness_checked_at",
] as const;
export const runCurrentColumns = [
  "ingestion_run_id",
  "last_event_sequence",
  "last_event_id",
  "previous_state",
  "state",
  "completed_stage_count",
  "candidate_payload_event_sequence",
  "diagnostics_event_sequence",
  ...runCurrentNullableColumns,
] as const;
export type RunCurrent = {
  ingestion_run_id: string;
  last_event_sequence: number;
  last_event_id: string;
  previous_state: IngestionRunState | null;
  state: IngestionRunState;
  completed_stage_count: number;
  candidate_payload_event_sequence: number | null;
  diagnostics_event_sequence: number | null;
} & Record<(typeof runCurrentNullableColumns)[number], string | null>;
export type RunEventRow = {
  ingestion_run_id: string;
  sequence_number: number;
  event_id: string;
  event_kind: string;
  occurred_at: string;
  from_state: string | null;
  to_state: string;
  payload_json: string;
};

export function emptyRunCurrent(runId: string, eventId: string, state: "planning" | "collecting"): RunCurrent {
  return {
    ...Object.fromEntries(runCurrentNullableColumns.map((column) => [column, null])),
    ingestion_run_id: runId,
    last_event_sequence: 1,
    last_event_id: eventId,
    previous_state: null,
    state,
    completed_stage_count: state === "planning" ? 0 : 1,
    candidate_payload_event_sequence: null,
    diagnostics_event_sequence: null,
  } as RunCurrent;
}

/** A retained event is the complete accepted scalar result, not an arbitrary patch.
 * Payload references keep large immutable facts out of later transition events.
 * No live lease, wall clock, or external side effect participates in replay.
 */
export function projectIngestionRunEvent(previous: RunCurrent | null, event: RunEventRow): RunCurrent {
  const fail = (): never => {
    throw new Error("Invalid Ingestion Run event history.");
  };
  if (
    !runEventKinds.includes(event.event_kind as RunEventKind) ||
    !isIngestionRunState(event.to_state) ||
    !Number.isFinite(Date.parse(event.occurred_at))
  )
    fail();
  const payload: unknown = JSON.parse(event.payload_json);
  if (payload === null || typeof payload !== "object" || !("current" in payload)) return fail();
  const current = (payload as { current: RunCurrent }).current;
  if (
    !current ||
    runCurrentColumns.some((key) => !Object.hasOwn(current, key)) ||
    Object.keys(current).some((key) => !(runCurrentColumns as readonly string[]).includes(key))
  )
    fail();
  if (
    current.ingestion_run_id !== event.ingestion_run_id ||
    current.last_event_id !== event.event_id ||
    current.last_event_sequence !== event.sequence_number ||
    current.state !== event.to_state ||
    current.previous_state !== event.from_state
  )
    fail();
  if (
    !Number.isInteger(current.completed_stage_count) ||
    current.completed_stage_count < 0 ||
    current.completed_stage_count > activeRunStages.length ||
    runCurrentNullableColumns.some((key) => current[key] !== null && typeof current[key] !== "string")
  )
    fail();
  for (const ref of [current.candidate_payload_event_sequence, current.diagnostics_event_sequence])
    if (ref !== null && (!Number.isInteger(ref) || ref < 1 || ref > event.sequence_number)) fail();
  const payloadFacts = payload as { payloads?: unknown };
  if (!payloadFacts.payloads || typeof payloadFacts.payloads !== "object" || Array.isArray(payloadFacts.payloads))
    fail();
  const retainedPayloads = payloadFacts.payloads as Record<string, { chunks?: unknown; bytes?: unknown }>;
  for (const [kind, metadata] of Object.entries(retainedPayloads)) {
    if (
      !["candidate", "diagnostics"].includes(kind) ||
      metadata === null ||
      typeof metadata !== "object" ||
      !Number.isSafeInteger(metadata.chunks) ||
      Number(metadata.chunks) < 1 ||
      !Number.isSafeInteger(metadata.bytes) ||
      Number(metadata.bytes) < 1
    )
      fail();
  }
  if (
    current.candidate_payload_event_sequence === event.sequence_number &&
    !Object.hasOwn(retainedPayloads, "candidate")
  )
    fail();
  if (current.diagnostics_event_sequence === event.sequence_number && !Object.hasOwn(retainedPayloads, "diagnostics"))
    fail();
  if (previous === null) {
    if (
      event.sequence_number !== 1 ||
      event.event_kind !== "created" ||
      event.from_state !== null ||
      !["planning", "collecting"].includes(event.to_state)
    )
      fail();
    const games = (payload as { selected_games?: unknown }).selected_games;
    if (
      !Array.isArray(games) ||
      games.length === 0 ||
      new Set(games).size !== games.length ||
      games.some((game) => !["one-piece", "fusion-world", "digimon", "gundam", "riftbound"].includes(game))
    )
      fail();
  } else {
    if (
      event.event_kind === "created" ||
      event.ingestion_run_id !== previous.ingestion_run_id ||
      event.sequence_number !== previous.last_event_sequence + 1 ||
      event.from_state !== previous.state ||
      !canTransitionIngestionRun(previous.state, current.state, {
        failureCode: current.failure_code,
        terminationRecorded: event.event_kind === "collection_terminated",
      })
    )
      fail();
    if (current.completed_stage_count < previous.completed_stage_count) fail();
    for (const column of [
      "candidate_digest",
      "candidate_catalogue_digest",
      "candidate_created_at",
      "approval_deadline",
      "approved_at",
      "approved_candidate_digest",
      "approved_expected_revision_id",
    ] as const)
      if (previous[column] !== null && previous[column] !== current[column]) fail();
    for (const column of ["candidate_payload_event_sequence", "diagnostics_event_sequence"] as const)
      if (current[column] !== previous[column] && current[column] !== event.sequence_number) fail();
  }
  const kindStates: Partial<Record<RunEventKind, readonly IngestionRunState[]>> = {
    collection_paused: ["paused"],
    collection_resumed: ["collecting"],
    collection_terminated: ["failed"],
    candidate_prepared: ["awaiting_approval"],
    candidate_blocked: ["failed"],
    approval_reserved: ["publishing"],
    rejected: ["rejected"],
    expired: ["expired"],
    failed: ["failed"],
    published: ["published"],
    stage_changed: ["collecting", "parsing", "reconciling"],
  };
  if (kindStates[event.event_kind as RunEventKind]?.includes(current.state) === false) fail();
  return { ...current };
}

export function runCompletedStageCount(progressJson: string): number {
  const progress = JSON.parse(progressJson) as { completed_stages?: unknown };
  if (
    !Array.isArray(progress.completed_stages) ||
    progress.completed_stages.some((stage, index) => stage !== activeRunStages[index])
  )
    throw new TypeError("Ingestion Run progress must be a completed stage prefix.");
  return progress.completed_stages.length;
}
