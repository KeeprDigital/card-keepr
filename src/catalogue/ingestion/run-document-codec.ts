import { AdministrationProblem, canonicalJson, decodeDocument, operationalDiagnostics } from "../shared";
import { parseCandidate } from "./candidate-codec";
import {
  type ApproveRunRequest,
  type PublicationCleanupRow,
  publicationLeaseMilliseconds,
  type RunRow,
  sevenDaysInMilliseconds,
} from "./run-types";
import {
  activeRunStages,
  isIsoInstant,
  parseJson,
  parseSelectedGames,
  publicationWriterToken,
  requiredPublicationValue,
  terminalRunStates,
} from "./run-values";

export function approvalInProgress(
  run: RunRow,
  request: ApproveRunRequest,
  requestJson: string,
): Record<string, unknown> {
  const reservedRequestJson = canonicalJson({
    run_id: run.id,
    candidate_digest: run.candidate_digest,
    expected_current_revision_id: run.expected_current_revision_id,
  });
  if (
    run.approval_idempotency_key !== request.idempotency_key ||
    run.candidate_digest !== request.candidate_digest ||
    run.expected_current_revision_id !== request.expected_current_revision_id ||
    reservedRequestJson !== requestJson
  ) {
    throw new AdministrationProblem(
      409,
      run.approval_idempotency_key === request.idempotency_key ? "idempotency_key_reused" : "publication_in_progress",
      run.approval_idempotency_key === request.idempotency_key
        ? "The idempotency key was already used for a different administration request."
        : "The Ingestion Run already has a publication in progress.",
    );
  }
  const approval = parseApproval(run.approval_json);
  if (
    approval.candidate_digest !== request.candidate_digest ||
    approval.expected_current_revision_id !== request.expected_current_revision_id
  ) {
    throw new Error("The reserved approval request is invalid.");
  }
  return {
    contract: "card-keepr-administration-operation@1",
    operation: "approve_ingestion_run",
    status: "in_progress",
    run_id: run.id,
    idempotency_key: request.idempotency_key,
    retry_after: run.publication_reconcile_after,
    links: {
      run: `/v1/ingestion-runs/${run.id}`,
      status: "/v1/status",
    },
  };
}

export function parseProgress(value: string, expectedState?: string): Record<string, unknown> {
  return decodeProgress(parseJson(value, "Ingestion Run progress"), expectedState);
}

function decodeProgress(input: unknown, expectedState?: string): Record<string, unknown> {
  const invalid = "The persisted Ingestion Run progress is invalid.";
  const value = decodeDocument<{ completed_stages: string[]; current_stage: string }>("progress", input, invalid);
  if (
    value.completed_stages.some((stage, index) => stage !== activeRunStages[index]) ||
    (expectedState !== undefined && value.current_stage !== expectedState) ||
    !validCompletedStageCount(value.current_stage, value.completed_stages.length)
  )
    throw new Error(invalid);
  return { completed_stages: [...value.completed_stages], current_stage: value.current_stage };
}

export function parseWarnings(value: string): Record<string, unknown>[] {
  return decodeWarnings(parseJson(value, "Ingestion Run warnings"));
}

function decodeWarnings(value: unknown): Record<string, unknown>[] {
  return decodeDocument("warnings", value, "The persisted Ingestion Run warnings are invalid.");
}

function validCompletedStageCount(state: string, completedCount: number): boolean {
  const activeIndex = activeRunStages.findIndex((knownStage) => knownStage === state);
  if (activeIndex >= 0) return completedCount === activeIndex;
  if (state === "paused") {
    return completedCount === activeRunStages.indexOf("collecting");
  }
  if (state === "published") {
    return completedCount === activeRunStages.length;
  }
  if (state === "rejected" || state === "expired") {
    return completedCount === activeRunStages.indexOf("awaiting_approval");
  }
  return state === "failed";
}

export function parseApproval(value: string | null): {
  action: "approved";
  approved_at: string;
  candidate_digest: string;
  expected_current_revision_id: string;
} {
  if (value === null) {
    throw new Error("The persisted Ingestion Run approval is missing.");
  }
  return decodeApproval(parseJson(value, "Ingestion Run approval"));
}

function decodeApproval(input: unknown): {
  action: "approved";
  approved_at: string;
  candidate_digest: string;
  expected_current_revision_id: string;
} {
  const invalid = "The persisted Ingestion Run approval is invalid.";
  const value = decodeDocument<{
    action: "approved";
    approved_at: string;
    candidate_digest: string;
    expected_current_revision_id: string;
  }>("approval", input, invalid);
  if (!isIsoInstant(value.approved_at)) throw new Error(invalid);
  return { ...value };
}

function parseApprovalHistory(value: string): Record<string, unknown>[] {
  return decodeApprovalHistory(parseJson(value, "Ingestion Run approval history"));
}

function decodeApprovalHistory(input: unknown): Record<string, unknown>[] {
  const invalid = "The persisted Ingestion Run approval history is invalid.";
  const value = decodeDocument<Record<string, unknown>[]>("approvalHistory", input, invalid);
  if (
    value.some(
      (decision) => !isIsoInstant(decision.action === "approved" ? decision.approved_at : decision.rejected_at),
    )
  )
    throw new Error(invalid);
  return value;
}

export function parseCleanupKeys(value: string, run: RunRow): string[] {
  const revisionId = requiredPublicationValue(run.publication_revision_id, "revision ID");
  const prefix = `catalogue-exports/${revisionId}/`;
  return decodeCleanupKeySet(parseJson(value, "Publication cleanup object keys"), prefix);
}

function decodeCleanupKeySet(input: unknown, prefix: string): string[] {
  const invalid = "The persisted publication cleanup object keys are invalid.";
  const value = decodeDocument<string[]>("cleanupKeys", input, invalid);
  if (
    value.some((key) => key.length <= prefix.length || !key.startsWith(prefix)) ||
    value.some((key, index) => key !== [...value].sort()[index])
  )
    throw new Error(invalid);
  return value;
}

export function publicRun(row: RunRow, cleanup: PublicationCleanupRow | null = null): Record<string, unknown> {
  const selectedGames = parseSelectedGames(row.selected_games_json);
  const progress = parseProgress(row.progress_json);
  const approval = row.approval_json === null ? null : parseApproval(row.approval_json);
  const approvalHistory = parseApprovalHistory(row.approval_history_json);
  if (
    row.candidate_digest !== null &&
    !selectedGames.every((game) => parseCandidate(row).selected_games.includes(game))
  ) {
    throw new Error("The persisted Ingestion Run document is inconsistent.");
  }
  const document = decodePublicRunDocument({
    id: row.id,
    state: row.state,
    selected_games: selectedGames,
    started_at: row.started_at,
    expected_current_revision_id: row.expected_current_revision_id,
    linked_run_id: row.linked_run_id,
    idempotency_key: row.idempotency_key,
    candidate_digest: row.candidate_digest,
    candidate_created_at: row.candidate_created_at,
    approval_deadline: row.approval_deadline,
    approval,
    approval_history: approvalHistory,
    progress,
    warnings: parseWarnings(row.warnings_json),
    failure_code: row.failure_code,
    publication_outcome: row.publication_outcome,
    published_revision_id: row.published_revision_id,
    resulting_revision_id: row.resulting_revision_id,
    ...(row.export_manifest_digest === null ? {} : { export_manifest_digest: row.export_manifest_digest }),
    freshness_checked_at: row.freshness_checked_at,
    terminal_at: row.terminal_at,
    publication_reservation: publicPublicationReservation(row),
    publication_cleanup: publicPublicationCleanup(cleanup),
  });
  return {
    ...document,
    operational_diagnostics: operationalDiagnostics({
      ...document,
      operational_request_id: row.operational_request_id,
    }),
  };
}

function publicPublicationReservation(row: RunRow): Record<string, unknown> | null {
  const values = [
    row.publication_revision_id,
    row.publication_started_at,
    row.publication_reconcile_after,
    row.publication_manifest_digest,
    row.publication_writer_token,
  ];
  return decodePublicationReservation(
    values.every((value) => value === null)
      ? null
      : {
          revision_id: row.publication_revision_id,
          started_at: row.publication_started_at,
          reconcile_after: row.publication_reconcile_after,
          manifest_digest: row.publication_manifest_digest,
          writer_token: row.publication_writer_token,
        },
  );
}

function publicPublicationCleanup(cleanup: PublicationCleanupRow | null): Record<string, unknown> | null {
  return decodePublicationCleanup(
    cleanup === null
      ? null
      : {
          state: cleanup.state,
          attempts: cleanup.attempts,
          failure_code: cleanup.failure_code,
          last_attempt_at: cleanup.last_attempt_at,
          completed_at: cleanup.completed_at,
          not_before: cleanup.not_before,
          generation: cleanup.claim_version,
        },
  );
}

export function decodePublicRunDocument(input: unknown): Record<string, unknown> {
  const invalid = "The persisted administration success outcome is invalid.";
  const value = decodeDocument<Record<string, unknown> & { state: string }>("publicRun", input, invalid);
  if (
    !isIsoInstant(value.started_at) ||
    ![value.candidate_created_at, value.approval_deadline, value.freshness_checked_at, value.terminal_at].every(
      isNullableIsoInstant,
    )
  )
    throw new Error(invalid);
  const progress = decodeProgress(value.progress, value.state);
  const warnings = decodeWarnings(value.warnings);
  const approval = value.approval === null ? null : decodeApproval(value.approval);
  const approvalHistory = decodeApprovalHistory(value.approval_history);
  const reservation = decodePublicationReservation(value.publication_reservation);
  const cleanup = decodePublicationCleanup(value.publication_cleanup);
  assertPublicRunCrossFieldInvariants(value, {
    progress,
    approval,
    approvalHistory,
    reservation,
    cleanup,
  });
  const operationalRequestId = retainedOperationalRequestId(value.operational_diagnostics);
  const { operational_diagnostics: _retainedOperationalDiagnostics, ...retainedValue } = value;
  const document = {
    ...retainedValue,
    progress,
    warnings,
    approval,
    approval_history: approvalHistory,
    publication_reservation: reservation,
    publication_cleanup: cleanup,
  };
  return {
    ...document,
    operational_diagnostics: operationalDiagnostics({
      ...document,
      operational_request_id: operationalRequestId,
    }),
  };
}

function retainedOperationalRequestId(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const references = (value as Record<string, unknown>).references;
  if (references === null || typeof references !== "object" || Array.isArray(references)) return null;
  const requestId = (references as Record<string, unknown>).request_id;
  return typeof requestId === "string" ? requestId : null;
}

function decodePublicationReservation(input: unknown): Record<string, unknown> | null {
  if (input === null) return null;
  const invalid = "The persisted publication reservation is invalid.";
  const value = decodeDocument<{
    revision_id: string;
    started_at: string;
    reconcile_after: string;
    manifest_digest: string;
    writer_token: string;
  }>("reservation", input, invalid);
  if (
    !isIsoInstant(value.started_at) ||
    !isIsoInstant(value.reconcile_after) ||
    Date.parse(value.reconcile_after) < Date.parse(value.started_at) ||
    value.writer_token !== publicationWriterToken(value.revision_id)
  )
    throw new Error(invalid);
  return {
    revision_id: value.revision_id,
    started_at: value.started_at,
    reconcile_after: value.reconcile_after,
    manifest_digest: value.manifest_digest,
    writer_token: value.writer_token,
  };
}

function decodePublicationCleanup(input: unknown): Record<string, unknown> | null {
  if (input === null) return null;
  const invalid = "The persisted publication cleanup state is invalid.";
  const value = decodeDocument<{
    state: string;
    attempts: number;
    failure_code: string | null;
    last_attempt_at: string | null;
    completed_at: string | null;
    not_before: string;
    generation: number;
  }>("cleanup", input, invalid);
  if (
    !isNullableIsoInstant(value.last_attempt_at) ||
    !isNullableIsoInstant(value.completed_at) ||
    !isIsoInstant(value.not_before) ||
    (value.state === "pending" &&
      (value.attempts !== 0 || value.last_attempt_at !== null || value.completed_at !== null)) ||
    (value.state === "cleaning" &&
      (value.attempts < 1 || value.last_attempt_at === null || value.completed_at !== null)) ||
    (value.state === "failed" &&
      (value.attempts < 1 ||
        value.failure_code === null ||
        value.last_attempt_at === null ||
        value.completed_at !== null)) ||
    (value.state === "completed" &&
      (value.attempts < 1 ||
        value.failure_code !== null ||
        value.last_attempt_at === null ||
        value.completed_at === null))
  ) {
    throw new Error("The persisted publication cleanup state is invalid.");
  }
  return {
    state: value.state,
    attempts: value.attempts,
    failure_code: value.failure_code,
    last_attempt_at: value.last_attempt_at,
    completed_at: value.completed_at,
    not_before: value.not_before,
    generation: value.generation,
  };
}

function assertPublicRunCrossFieldInvariants(
  value: Record<string, unknown>,
  decoded: {
    progress: Record<string, unknown>;
    approval: {
      action: "approved";
      approved_at: string;
      candidate_digest: string;
      expected_current_revision_id: string;
    } | null;
    approvalHistory: Record<string, unknown>[];
    reservation: Record<string, unknown> | null;
    cleanup: Record<string, unknown> | null;
  },
): void {
  const state = value.state;
  const terminal = typeof state === "string" && terminalRunStates.has(state);
  const completedStages = decoded.progress.completed_stages;
  const candidateRequired =
    state === "awaiting_approval" ||
    state === "publishing" ||
    state === "published" ||
    state === "rejected" ||
    state === "expired" ||
    (Array.isArray(completedStages) && completedStages.includes("reconciling"));
  if (
    (terminal && value.terminal_at === null) ||
    (!terminal && value.terminal_at !== null) ||
    (candidateRequired &&
      (typeof value.candidate_digest !== "string" ||
        typeof value.candidate_created_at !== "string" ||
        typeof value.approval_deadline !== "string" ||
        Date.parse(value.approval_deadline) - Date.parse(value.candidate_created_at) !== sevenDaysInMilliseconds)) ||
    (!candidateRequired &&
      (value.candidate_digest !== null || value.candidate_created_at !== null || value.approval_deadline !== null)) ||
    (decoded.approval !== null &&
      (decoded.approval.candidate_digest !== value.candidate_digest ||
        decoded.approval.expected_current_revision_id !== value.expected_current_revision_id ||
        typeof value.approval_deadline !== "string" ||
        Date.parse(decoded.approval.approved_at) >= Date.parse(value.approval_deadline) ||
        !["publishing", "published", "failed"].includes(String(state)) ||
        decoded.approvalHistory.length !== 1 ||
        canonicalJson(decoded.approvalHistory[0]) !== canonicalJson(decoded.approval))) ||
    (decoded.approval === null && decoded.approvalHistory.some((decision) => decision.action === "approved")) ||
    decoded.approvalHistory.some((decision) => decision.candidate_digest !== value.candidate_digest) ||
    (state === "rejected" &&
      (decoded.approvalHistory.length !== 1 || decoded.approvalHistory[0]?.action !== "rejected")) ||
    (state !== "rejected" && decoded.approvalHistory.some((decision) => decision.action === "rejected")) ||
    (state === "expired" && decoded.approvalHistory.length !== 0) ||
    (decoded.reservation !== null &&
      (decoded.approval === null ||
        !["publishing", "published", "failed"].includes(String(state)) ||
        decoded.reservation.started_at !== decoded.approval.approved_at ||
        typeof decoded.reservation.started_at !== "string" ||
        typeof decoded.reservation.reconcile_after !== "string" ||
        Date.parse(decoded.reservation.reconcile_after) - Date.parse(decoded.reservation.started_at) !==
          publicationLeaseMilliseconds)) ||
    (state === "publishing" && (decoded.approval === null || decoded.reservation === null)) ||
    (decoded.cleanup !== null &&
      (state !== "failed" ||
        decoded.reservation === null ||
        typeof decoded.cleanup.not_before !== "string" ||
        typeof decoded.reservation.reconcile_after !== "string" ||
        typeof value.terminal_at !== "string" ||
        Date.parse(decoded.cleanup.not_before) -
          Math.max(Date.parse(decoded.reservation.reconcile_after), Date.parse(value.terminal_at)) !==
          publicationLeaseMilliseconds)) ||
    (state === "failed" &&
      decoded.reservation !== null &&
      decoded.cleanup === null &&
      value.failure_code !== "publication_abandoned") ||
    (state === "failed" && (decoded.approval === null) !== (decoded.reservation === null)) ||
    (state === "failed" && (typeof value.failure_code !== "string" || value.failure_code.length === 0)) ||
    (state !== "failed" && value.failure_code !== null) ||
    !validPublicationOutcome(value, decoded)
  ) {
    throw new Error("The persisted Ingestion Run document is inconsistent.");
  }
}

function validPublicationOutcome(
  value: Record<string, unknown>,
  decoded: {
    approval: Record<string, unknown> | null;
    reservation: Record<string, unknown> | null;
  },
): boolean {
  if (value.state !== "published") {
    return (
      value.publication_outcome === null &&
      value.published_revision_id === null &&
      value.resulting_revision_id === null &&
      !("export_manifest_digest" in value) &&
      value.freshness_checked_at === null
    );
  }
  if (decoded.approval === null || value.terminal_at === null || value.freshness_checked_at === null) {
    return false;
  }
  if (value.publication_outcome === "no_change") {
    return (
      decoded.reservation === null &&
      value.published_revision_id === null &&
      value.resulting_revision_id === value.expected_current_revision_id &&
      !("export_manifest_digest" in value)
    );
  }
  return (
    value.publication_outcome === "revision" &&
    decoded.reservation !== null &&
    value.published_revision_id === decoded.reservation.revision_id &&
    value.resulting_revision_id === decoded.reservation.revision_id &&
    value.export_manifest_digest === decoded.reservation.manifest_digest
  );
}

function isNullableIsoInstant(value: unknown): boolean {
  return value === null || isIsoInstant(value);
}

export function progressFor(state: string): Record<string, unknown> {
  const position = activeRunStages.findIndex((knownStage) => knownStage === state);
  if (position >= 0) {
    return {
      completed_stages: activeRunStages.slice(0, position),
      current_stage: state,
    };
  }
  return {
    completed_stages: [...activeRunStages],
    current_stage: state,
  };
}

export function terminalProgress(
  run: RunRow,
  terminalState: "rejected" | "expired" | "failed",
): Record<string, unknown> {
  const progress = parseProgress(run.progress_json);
  return {
    ...progress,
    current_stage: terminalState,
  };
}
