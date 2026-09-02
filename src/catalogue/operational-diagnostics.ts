const terminalRunStates = new Set([
  "published",
  "rejected",
  "expired",
  "failed",
]);

export function operationalDiagnostics(
  run: Record<string, unknown>,
): Record<string, unknown> {
  const runId = safeReference(run.id);
  const state = safeReference(run.state);
  const candidateDigest = safeReference(run.candidate_digest);
  const resultingRevisionId = safeReference(run.resulting_revision_id) ??
    safeReference(run.published_revision_id);
  const warnings = Array.isArray(run.warnings) ? run.warnings : [];
  const approvalHistory = Array.isArray(run.approval_history)
    ? run.approval_history
    : [];
  const evidenceBacked = Array.isArray(run.evidence_plans) &&
    run.evidence_plans.length > 0;
  const failure = terminalFailure(run, state, evidenceBacked);
  const retryAvailable = state !== null && terminalRunStates.has(state);
  const adapterVersions = retainedAdapterVersions(run);
  const diagnosisSequence: Array<Record<string, string>> = [
    { code: "check_status", method: "GET", path: "/v1/status" },
  ];
  if (runId !== null) {
    diagnosisSequence.push({
      code: "inspect_run",
      method: "GET",
      path: `/v1/ingestion-runs/${encodeURIComponent(runId)}`,
    });
    if (candidateDigest !== null && state === "awaiting_approval") {
      diagnosisSequence.push({
        code: "inspect_candidate",
        method: "GET",
        path: `/v1/ingestion-runs/${encodeURIComponent(runId)}/candidate`,
      });
    }
  }
  if (resultingRevisionId !== null) {
    diagnosisSequence.push({
      code: "inspect_backup",
      method: "GET",
      path: `/v1/catalogue-revisions/${
        encodeURIComponent(resultingRevisionId)
      }/backups`,
    });
  }
  const retry = retryAvailable && runId !== null &&
      !(evidenceBacked && state === "published")
    ? evidenceBacked && state !== "published"
      ? {
        code: "evidence_collection_retry_available",
        source_run_id: runId,
        method: "POST",
        path: `/v1/ingestion-runs/${encodeURIComponent(runId)}/collection/retry`,
      }
      : {
        code: "ingestion_run_retry_available",
        source_run_id: runId,
        method: "POST",
        path: `/v1/ingestion-runs/${encodeURIComponent(runId)}/retry`,
      }
    : null;
  if (retry !== null) {
    diagnosisSequence.push({
      code: evidenceBacked
        ? "retry_evidence_collection"
        : "retry_ingestion_run",
      method: retry.method,
      path: retry.path,
    });
  }
  return {
    contract: "card-keepr-operational-diagnostics@1",
    references: {
      run_id: runId,
      request_id: safeReference(run.operational_request_id),
      expected_catalogue_revision_id:
        safeReference(run.expected_current_revision_id),
      resulting_catalogue_revision_id: resultingRevisionId,
      candidate_digest: candidateDigest,
      adapter_versions: adapterVersions,
      workflow: {
        status_path: runId === null
          ? null
          : `/v1/ingestion-runs/${encodeURIComponent(runId)}`,
        ...safeWorkflowReferences(run.workflow),
      },
      backup: {
        status_path: resultingRevisionId === null
          ? null
          : `/v1/catalogue-revisions/${
            encodeURIComponent(resultingRevisionId)
          }/backups`,
      },
      recovery: { status_path: "/v1/status" },
    },
    terminal_evidence: {
      state,
      terminal_at: safeReference(run.terminal_at) ??
        safeReference(run.collection_completed_at),
      failure,
      warning_count: warnings.length,
      approval_decision_count: approvalHistory.length,
      coverage: safeCoverage(run),
    },
    retry,
    retry_available: retry !== null,
    diagnosis_sequence: diagnosisSequence,
  };
}

function terminalFailure(
  run: Record<string, unknown>,
  state: string | null,
  evidenceBacked: boolean,
): Record<string, unknown> | null {
  const retainedCode = safeMachineCode(run.failure_code);
  const code = retainedCode ?? (state === "rejected"
    ? "ingestion_run_rejected"
    : state === "expired"
      ? "ingestion_run_expired"
      : state === "failed"
        ? "ingestion_run_failed"
        : null);
  if (code === null) return null;
  return {
    code,
    retryability_code: evidenceBacked
      ? "retryable_evidence_collection"
      : state === "rejected"
        ? "retryable_rejection"
        : state === "expired"
          ? "retryable_expiration"
          : "retryable_failure",
    retryable: true,
  };
}

function retainedAdapterVersions(run: Record<string, unknown>): string[] {
  const plans = Array.isArray(run.evidence_plans) ? run.evidence_plans : [];
  const versions = plans.flatMap((plan) => {
    if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
      return [];
    }
    const value = safeReference(
      (plan as Record<string, unknown>).adapter_version,
    );
    return value === null ? [] : [value];
  });
  const direct = safeReference(run.adapter_version);
  if (direct !== null) versions.push(direct);
  return [...new Set(versions)].sort();
}

function safeWorkflowReferences(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const workflow = value as Record<string, unknown>;
  const childIds = Array.isArray(workflow.child_ids)
    ? workflow.child_ids.flatMap((id) => {
      const safe = safeReference(id);
      return safe === null ? [] : [safe];
    })
    : [];
  const currentAttempt =
    workflow.current_attempt !== null &&
      typeof workflow.current_attempt === "object" &&
      !Array.isArray(workflow.current_attempt)
      ? (workflow.current_attempt as Record<string, unknown>)
      : null;
  return {
    parent_id: safeReference(workflow.parent_id),
    child_ids: childIds,
    current_attempt_id: currentAttempt === null
      ? null
      : safeReference(currentAttempt.id),
    status: safeMachineCode(workflow.status),
    classification: safeMachineCode(workflow.classification),
    last_progress_at: safeReference(workflow.last_progress_at),
    attempt_count: Array.isArray(workflow.attempts)
      ? workflow.attempts.length
      : 0,
  };
}

// Coverage prefers the aggregate evidence counts when the status document
// carries them: its per-request detail lists are bounded, so their lengths
// understate a production-sized run.
function safeCoverage(run: Record<string, unknown>): Record<string, number> {
  const counts = run.evidence_counts !== null &&
      typeof run.evidence_counts === "object" &&
      !Array.isArray(run.evidence_counts)
    ? (run.evidence_counts as Record<string, unknown>)
    : null;
  const count = (key: string, list: unknown): number => {
    const aggregate = counts?.[key];
    if (typeof aggregate === "number" && Number.isSafeInteger(aggregate)) {
      return aggregate;
    }
    return Array.isArray(list) ? list.length : 0;
  };
  return {
    evidence_plan_count: Array.isArray(run.evidence_plans)
      ? run.evidence_plans.length
      : 0,
    source_snapshot_count: count("snapshot_count", run.snapshots),
    source_observation_set_count: count(
      "observation_set_count",
      run.observation_sets,
    ),
    fetch_attempt_count: count("fetch_attempt_count", run.diagnostics),
  };
}

function safeReference(value: unknown): string | null {
  return typeof value === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,511}$/u.test(value)
    ? value
    : null;
}

function safeMachineCode(value: unknown): string | null {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,127}$/u.test(value)
    ? value
    : null;
}
