/** Human administration output is derived by the Worker from its public document. */
export function administrationPresentation(document, status = 200) {
  const incomplete =
    (document.contract === "card-keepr-reconciliation-workflow@1" && document.status !== "complete") ||
    (document.contract === "card-keepr-catalogue-backup-workflow@1" && document.status !== "complete") ||
    (document.contract === "card-keepr-card-search-repair@1" && document.complete !== true) ||
    (document.contract === "card-keepr-catalogue-export-deletion@1" && document.state === "deleting" && status === 202);
  return {
    contract: "card-keepr-cli-presentation@1",
    document,
    text: formatAdministrationResult(document),
    exit_code: incomplete ? 10 : 0,
  };
}
function formatAdministrationResult(document) {
  if (document.contract === "card-keepr-administration-status@1") {
    return formatStatus(document);
  }
  if (document.contract === "card-keepr-capacity-extension@1") {
    return formatCapacityExtension(document);
  }
  if (document.contract === "card-keepr-collection-pause@1") {
    return formatCollectionPause(document);
  }
  if (document.contract === "card-keepr-collection-termination@1") {
    return formatCollectionTermination(document);
  }
  if (
    Array.isArray(document.snapshots) &&
    Array.isArray(document.observation_sets) &&
    Array.isArray(document.diagnostics) &&
    document.state &&
    document.id
  ) {
    const lines = [`Ingestion Run ${document.id} evidence: ${document.state}`, ...formatEvidenceVolume(document)];
    lines.push(...formatEvidencePause(document.pause));
    lines.push(...formatEvidenceTermination(document.termination));
    lines.push(...formatCollectionProgress(document.collection));
    lines.push(...formatEvidenceWorkflow(document.workflow));
    lines.push(...formatEvidenceActions(document.actions ?? document.pause?.actions));
    const requestId = safeDiagnosticReference(document.operational_diagnostics?.references?.request_id);
    if (requestId !== null) lines.push(`Request reference: ${requestId}`);
    return lines.join("; ");
  }
  if (document.source_snapshot_id && document.adapter_version && document.id) {
    return `Source Observation set ${document.id} for Source Snapshot ${document.source_snapshot_id} (${document.adapter_version})`;
  }
  if (document.state && document.id) {
    return formatRun(document);
  }
  if (document.run_id && document.candidate_digest) {
    return `Candidate ${document.candidate_digest} for Ingestion Run ${document.run_id}`;
  }
  return JSON.stringify(document);
}

function formatCount(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// Evidence volume prefers the aggregate counts of the collection block: the
// per-request detail lists are bounded, so their lengths understate a
// production-sized run.
function formatEvidenceVolume(document) {
  const evidence = document.collection?.evidence;
  if (
    typeof evidence === "object" &&
    evidence !== null &&
    Number.isSafeInteger(evidence.snapshot_count) &&
    Number.isSafeInteger(evidence.observation_set_count) &&
    Number.isSafeInteger(evidence.fetch_attempt_count)
  ) {
    return [
      `${formatCount(evidence.snapshot_count, "Source Snapshot")}${
        Number.isSafeInteger(evidence.retained_byte_total) ? ` (${evidence.retained_byte_total} bytes)` : ""
      }`,
      formatCount(evidence.observation_set_count, "Source Observation set"),
      `${formatCount(evidence.fetch_attempt_count, "fetch attempt")}${
        Number.isSafeInteger(evidence.retry_attempt_count) && Number.isSafeInteger(evidence.failed_attempt_count)
          ? ` (${evidence.retry_attempt_count} ${
              evidence.retry_attempt_count === 1 ? "retry" : "retries"
            }, ${formatCount(evidence.failed_attempt_count, "failure")})`
          : ""
      }`,
    ];
  }
  return [
    formatCount(document.snapshots.length, "Source Snapshot"),
    formatCount(document.observation_sets.length, "Source Observation set"),
    formatCount(document.diagnostics.length, "diagnostic"),
  ];
}

function formatCountMap(map) {
  if (typeof map !== "object" || map === null) return "";
  return Object.entries(map)
    .filter(([key, value]) => safeMachineCode(key) !== null && Number.isSafeInteger(value))
    .map(([key, value]) => `${key} ${value}`)
    .join(", ");
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${hours}h ${minutes}m ${seconds}s` : minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

// The aggregated collection progress: request counts by state and role,
// per-lineage capacity, the latest safe failure, the current safe request
// reference, host pacing, the advisory remaining-time floor, and the
// lifecycle timestamps. Human output carries the same material facts as the
// JSON document, in the same closed vocabulary.
function formatCollectionProgress(collection) {
  if (typeof collection !== "object" || collection === null) return [];
  const lines = [];
  const requests = collection.requests;
  if (typeof requests === "object" && requests !== null && Number.isSafeInteger(requests.total)) {
    const groups = [formatCountMap(requests.by_state), formatCountMap(requests.by_role)].filter(
      (group) => group !== "",
    );
    lines.push(`Requests: ${requests.total}${groups.length === 0 ? "" : ` (${groups.join("; ")})`}`);
    // Per-lineage counts only add information when a run spans lineages.
    const byLineage = Array.isArray(requests.by_lineage) ? requests.by_lineage : [];
    if (byLineage.length > 1) {
      for (const group of byLineage) {
        const lineage = safeDiagnosticReference(group?.source_lineage);
        if (lineage === null || !Number.isSafeInteger(group.total)) continue;
        const lineageGroups = [formatCountMap(group.by_state), formatCountMap(group.by_role)].filter(
          (part) => part !== "",
        );
        lines.push(
          `Requests ${lineage}: ${group.total}${lineageGroups.length === 0 ? "" : ` (${lineageGroups.join("; ")})`}`,
        );
      }
    }
  }
  for (const capacity of Array.isArray(collection.capacity) ? collection.capacity : []) {
    const lineage = safeDiagnosticReference(capacity?.source_lineage);
    if (
      lineage === null ||
      !Number.isSafeInteger(capacity.used_capacity) ||
      !Number.isSafeInteger(capacity.request_capacity) ||
      !Number.isSafeInteger(capacity.capacity_generation)
    ) {
      continue;
    }
    const details = [`generation ${capacity.capacity_generation}`];
    if (Number.isSafeInteger(capacity.remaining_capacity)) {
      details.push(`${capacity.remaining_capacity} remaining`);
    }
    if (Number.isSafeInteger(capacity.required_capacity)) {
      details.push(`${capacity.required_capacity} required`);
    }
    if (Number.isSafeInteger(capacity.overflow_request_count)) {
      details.push(`${formatCount(capacity.overflow_request_count, "overflow request")}`);
    }
    lines.push(
      `Capacity ${lineage}: ${capacity.used_capacity} used of ${capacity.request_capacity} (${details.join(", ")})`,
    );
  }
  const evidence = collection.evidence;
  if (typeof evidence === "object" && evidence !== null && Number.isSafeInteger(evidence.detail_limit)) {
    const truncated = [
      ["snapshots", evidence.snapshots_truncated],
      ["observation sets", evidence.observation_sets_truncated],
      ["diagnostics", evidence.diagnostics_truncated],
    ]
      .filter(([, flag]) => flag === true)
      .map(([name]) => name);
    if (truncated.length > 0) {
      lines.push(`Detail lists bounded to the newest ${evidence.detail_limit}: ${truncated.join(", ")} truncated`);
    }
  }
  const failure = collection.evidence?.latest_failure;
  if (typeof failure === "object" && failure !== null) {
    const classification = safeMachineCode(failure.classification);
    const requestId = safeDiagnosticReference(failure.request_id);
    if (classification !== null && requestId !== null) {
      const at = safeDiagnosticReference(failure.at);
      lines.push(
        `Latest failure: ${classification}${
          Number.isSafeInteger(failure.http_status) ? ` (HTTP ${failure.http_status})` : ""
        } on ${requestId}${
          Number.isSafeInteger(failure.attempt_number) ? ` attempt ${failure.attempt_number}` : ""
        }${at === null ? "" : ` at ${at}`}`,
      );
    }
  }
  const failedImages = collection.failed_images;
  if (
    typeof failedImages === "object" &&
    failedImages !== null &&
    Number.isSafeInteger(failedImages.count) &&
    failedImages.count > 0
  ) {
    const listed = (Array.isArray(failedImages.requests) ? failedImages.requests : [])
      .map((image) => safeDiagnosticReference(image?.request_id))
      .filter((requestId) => requestId !== null);
    lines.push(
      `Failed images: ${formatCount(failedImages.count, "Printing Image")}${
        failedImages.truncated === true ? ` (first ${listed.length} listed)` : ""
      } not collected; the run continued and a later run can collect them${
        listed.length === 0 ? "" : `: ${listed.join(", ")}`
      }`,
    );
  }
  const current = collection.progress?.current_request;
  if (typeof current === "object" && current !== null) {
    const requestId = safeDiagnosticReference(current.request_id);
    if (requestId !== null) {
      const facts = [
        safeDiagnosticReference(current.hostname),
        safeMachineCode(current.role),
        safeMachineCode(current.state),
        Number.isSafeInteger(current.attempt_count) ? formatCount(current.attempt_count, "attempt") : null,
      ].filter((fact) => fact !== null);
      lines.push(`Current request: ${requestId}${facts.length === 0 ? "" : ` (${facts.join(", ")})`}`);
    }
  }
  const pacing = collection.pacing;
  if (typeof pacing === "object" && pacing !== null) {
    const mode = safeMachineCode(pacing.mode);
    if (mode !== null) {
      const hosts = (Array.isArray(pacing.hosts) ? pacing.hosts : [])
        .map((host) => {
          const hostname = safeDiagnosticReference(host?.hostname);
          if (hostname === null || !Number.isSafeInteger(host.pending_request_count)) {
            return null;
          }
          return `${hostname} ${host.pending_request_count} pending${
            Number.isSafeInteger(host.captured_request_count) && host.captured_request_count > 0
              ? `, ${host.captured_request_count} captured`
              : ""
          }${Number.isSafeInteger(host.waiting_ms) && host.waiting_ms > 0 ? ` (waiting ${host.waiting_ms}ms)` : ""}`;
        })
        .filter((host) => host !== null);
      lines.push(
        `Pacing: ${mode}${Number.isSafeInteger(pacing.interval_ms) ? ` ${pacing.interval_ms}ms` : ""}${
          hosts.length === 0 ? "" : `; ${formatCount(hosts.length, "host")}: ${hosts.join(", ")}`
        }`,
      );
    }
  }
  const estimate = collection.estimate;
  if (typeof estimate === "object" && estimate !== null && Number.isSafeInteger(estimate.minimum_remaining_ms)) {
    lines.push(`Estimated minimum remaining: ${formatDuration(estimate.minimum_remaining_ms)} (advisory)`);
  }
  const expectedRevision = safeDiagnosticReference(collection.expected_catalogue_revision_id);
  if (expectedRevision !== null) {
    lines.push(`Expected Catalogue Revision: ${expectedRevision}`);
  }
  return lines;
}

// The confirmation facts of an applied capacity extension: which Ingestion
// Run and Source Lineage were extended, and how the compare-and-set advanced
// the capacity and its generation.
function formatCapacityExtension(document) {
  const lines = [];
  const runId = safeDiagnosticReference(document.ingestion_run_id);
  if (runId !== null) {
    lines.push(`Ingestion Run ${runId} capacity extended`);
  }
  if (
    Number.isSafeInteger(document.previous_request_capacity) &&
    Number.isSafeInteger(document.request_capacity) &&
    Number.isSafeInteger(document.previous_capacity_generation) &&
    Number.isSafeInteger(document.capacity_generation)
  ) {
    lines.push(
      `Request Capacity: ${document.previous_request_capacity} -> ` +
        `${document.request_capacity} (generation ` +
        `${document.previous_capacity_generation} -> ` +
        `${document.capacity_generation})`,
    );
  }
  const sourceLineage = safeDiagnosticReference(document.source_lineage);
  if (sourceLineage !== null) {
    lines.push(`Source Lineage: ${sourceLineage}`);
  }
  return lines.length === 0 ? JSON.stringify(document) : lines.join("; ");
}

// The minimum pause facts of a paused Ingestion Run: why collection stopped,
// and either the capacity consumption the rejected overflow batch requires
// (a Capacity Pause) or the exhausted request's safe reference, hostname,
// retry generation, and latest safe failure classification (a retry pause).
function formatEvidencePause(pause) {
  if (typeof pause !== "object" || pause === null) return [];
  const lines = [];
  const reason = safeMachineCode(pause.reason);
  const pausedAt = safeDiagnosticReference(pause.paused_at);
  if (reason !== null) {
    lines.push(`Paused: ${reason}${pausedAt === null ? "" : ` at ${pausedAt}`}`);
  }
  const sourceLineage = safeDiagnosticReference(pause.source_lineage);
  if (sourceLineage !== null) {
    lines.push(`Source Lineage: ${sourceLineage}`);
  }
  if (
    Number.isSafeInteger(pause.request_capacity) &&
    Number.isSafeInteger(pause.used_capacity) &&
    Number.isSafeInteger(pause.capacity_generation)
  ) {
    lines.push(
      `Request Capacity: ${pause.used_capacity} used of ` +
        `${pause.request_capacity} (generation ${pause.capacity_generation})`,
    );
  }
  if (Number.isSafeInteger(pause.overflow_request_count) && Number.isSafeInteger(pause.required_capacity)) {
    lines.push(
      `Overflow: ${formatCount(
        pause.overflow_request_count,
        "request",
      )} require${pause.overflow_request_count === 1 ? "s" : ""} capacity ${pause.required_capacity}`,
    );
  }
  const parentRequestId = safeDiagnosticReference(pause.parent_request_id);
  if (parentRequestId !== null) {
    lines.push(`Parent request: ${parentRequestId}`);
  }
  // A retry-exhaustion pause identifies the exhausted Source Request and its
  // bounded retry generation instead of lineage capacity facts.
  const requestId = safeDiagnosticReference(pause.request_id);
  if (requestId !== null) lines.push(`Request: ${requestId}`);
  const hostname = safeDiagnosticReference(pause.hostname);
  if (hostname !== null) lines.push(`Hostname: ${hostname}`);
  if (Number.isSafeInteger(pause.attempt_count) && Number.isSafeInteger(pause.retry_generation)) {
    lines.push(`Attempts: ${pause.attempt_count} in retry generation ` + `${pause.retry_generation}`);
  }
  const classification = safeMachineCode(pause.failure_classification);
  if (classification !== null) {
    lines.push(
      `Last failure: ${classification}${Number.isSafeInteger(pause.http_status) ? ` (HTTP ${pause.http_status})` : ""}`,
    );
  }
  // A Workflow Pause identifies the abandoned Workflow Attempt, the safe
  // status that classified it, and the deterministic last-progress time the
  // classification was derived from.
  const workflowInstanceId = safeDiagnosticReference(pause.workflow_instance_id);
  if (workflowInstanceId !== null) {
    const workflowStatus = safeMachineCode(pause.workflow_status);
    lines.push(
      `Workflow attempt: ${workflowInstanceId}${workflowStatus === null ? "" : ` (status ${workflowStatus})`}`,
    );
  }
  const lastProgressAt = safeDiagnosticReference(pause.last_progress_at);
  if (lastProgressAt !== null) {
    lines.push(`Last progress: ${lastProgressAt}`);
  }
  return lines;
}

// The exact owner actions the collection lifecycle currently admits, so an
// operator reading the human form sees the same choices automation reads
// from the JSON document.
function formatEvidenceActions(actions) {
  if (!Array.isArray(actions)) return [];
  const safe = actions.map((action) => safeMachineCode(action)).filter((action) => action !== null);
  return safe.length === 0 ? [] : [`Available actions: ${safe.join(", ")}`];
}

// The retained owner decision of a terminated run: the stable terminal
// reason, when it was taken, and which pause it abandoned.
function formatEvidenceTermination(termination) {
  if (typeof termination !== "object" || termination === null) return [];
  const reason = safeMachineCode(termination.reason);
  if (reason === null) return [];
  const terminatedAt = safeDiagnosticReference(termination.terminated_at);
  const pauseReason = safeMachineCode(termination.pause_reason);
  const pausedAt = safeDiagnosticReference(termination.paused_at);
  const abandoned = pauseReason === null ? "" : ` (paused ${pauseReason}${pausedAt === null ? "" : ` at ${pausedAt}`})`;
  return [`Terminated: ${reason}${terminatedAt === null ? "" : ` at ${terminatedAt}`}${abandoned}`];
}

// The confirmation facts of an applied owner pause: which run paused, when,
// which parent Workflow Attempt was abandoned with the safe status observed
// at the time, and the actions the paused run now admits.
function formatCollectionPause(document) {
  const lines = [];
  const runId = safeDiagnosticReference(document.ingestion_run_id);
  if (runId !== null) lines.push(`Ingestion Run ${runId} paused`);
  const pauseReason = safeMachineCode(document.pause_reason);
  const pausedAt = safeDiagnosticReference(document.paused_at);
  if (pauseReason !== null) {
    lines.push(`Paused: ${pauseReason}${pausedAt === null ? "" : ` at ${pausedAt}`}`);
  }
  const workflow = typeof document.workflow === "object" && document.workflow !== null ? document.workflow : {};
  const workflowId = safeDiagnosticReference(workflow.id);
  const status = safeMachineCode(workflow.status);
  if (workflowId !== null) {
    const attempt = Number.isSafeInteger(workflow.attempt_number)
      ? `Workflow attempt ${workflow.attempt_number} (${workflowId})`
      : `Workflow ${workflowId}`;
    lines.push(status === null ? attempt : `${attempt}: ${status}`);
  }
  const lastProgressAt = safeDiagnosticReference(document.last_progress_at);
  if (lastProgressAt !== null) lines.push(`Last progress: ${lastProgressAt}`);
  lines.push(...formatEvidenceActions(document.actions));
  return lines.length === 0 ? JSON.stringify(document) : lines.join("; ");
}

// The confirmation facts of an applied termination: which run became
// terminal, which pause it abandoned, and whether the single active-run
// reservation was released.
function formatCollectionTermination(document) {
  const lines = [];
  const runId = safeDiagnosticReference(document.ingestion_run_id);
  if (runId !== null) lines.push(`Ingestion Run ${runId} terminated`);
  const pauseReason = safeMachineCode(document.pause_reason);
  const pausedAt = safeDiagnosticReference(document.paused_at);
  if (pauseReason !== null) {
    lines.push(`Paused: ${pauseReason}${pausedAt === null ? "" : ` at ${pausedAt}`}`);
  }
  const terminatedAt = safeDiagnosticReference(document.terminated_at);
  if (terminatedAt !== null) lines.push(`Terminated at: ${terminatedAt}`);
  if (typeof document.active_run_released === "boolean") {
    lines.push(`Active run released: ${document.active_run_released ? "yes" : "no"}`);
  }
  return lines.length === 0 ? JSON.stringify(document) : lines.join("; ");
}

// The collection Workflow observability facts: the current Workflow Attempt
// with its safe status, its stall classification while collecting, and the
// deterministic last-progress time.
function formatEvidenceWorkflow(workflow) {
  if (typeof workflow !== "object" || workflow === null) return [];
  const lines = [];
  const current = workflow.current_attempt;
  if (typeof current === "object" && current !== null) {
    const id = safeDiagnosticReference(current.id);
    if (id !== null && Number.isSafeInteger(current.attempt_number)) {
      const status = safeMachineCode(workflow.status);
      lines.push(`Workflow attempt ${current.attempt_number}: ${id}${status === null ? "" : ` (status ${status})`}`);
    }
  }
  const classification = safeMachineCode(workflow.classification);
  if (classification !== null) {
    lines.push(`Workflow classification: ${classification}`);
  }
  const lastProgressAt = safeDiagnosticReference(workflow.last_progress_at);
  if (lastProgressAt !== null) {
    lines.push(`Last progress: ${lastProgressAt}`);
  }
  if (Array.isArray(workflow.attempts) && workflow.attempts.length > 0) {
    const attempts = workflow.attempts
      .map((attempt) => {
        const id = safeDiagnosticReference(attempt?.id);
        const kind = safeMachineCode(attempt?.kind);
        if (id === null || kind === null) return null;
        return {
          kind,
          current: attempt.current === true,
          text: `${kind} ${id}${
            Number.isSafeInteger(attempt.attempt_number) ? ` attempt ${attempt.attempt_number}` : ""
          }${
            safeMachineCode(attempt.status) === null ? "" : ` ${attempt.status}`
          }${attempt.current === true ? " (current)" : ""}`,
        };
      })
      .filter((attempt) => attempt !== null);
    // The current parent attempt already has its own line above.
    const listed = attempts.filter((attempt) => attempt.kind !== "parent" || !attempt.current);
    lines.push(
      `Workflow attempts: ${attempts.length} recorded, ${attempts.filter((attempt) => attempt.current).length} current${
        listed.length === 0 ? "" : `; ${listed.map((attempt) => attempt.text).join("; ")}`
      }`,
    );
  }
  return lines;
}

function formatStatus(document) {
  const safeState = document.safe_state ?? {};
  const lines = [
    `Catalogue Revision: ${safeState.current_revision_id ?? "unknown"}`,
    `Recovery health: ${safeState.recovery_health ?? "unknown"}`,
    `Mutation safe: ${safeState.mutation_safe === true ? "yes" : "no"}`,
    `Active Ingestion Run: ${safeState.active_ingestion_run_id ?? "none"}`,
    `Active Recovery: ${safeState.active_recovery_id ?? "none"}`,
  ];
  const diagnostics = document.diagnostics ?? {};
  lines.push(
    `Catalogue diagnostics: ${diagnostics.catalogue_revision_count ?? "unknown"} revisions, ${
      diagnostics.catalogue_export_count ?? "unknown"
    } exports`,
  );
  lines.push(
    `export_objects: ${diagnostics.catalogue_export_object_count ?? "unknown"}`,
    `orphaned_export_objects: ${diagnostics.orphaned_catalogue_export_object_count ?? "unknown"}`,
    `pending_publication_cleanups: ${diagnostics.pending_publication_cleanup_count ?? "unknown"}`,
  );
  const freshness = Array.isArray(document.source_freshness) ? document.source_freshness : [];
  lines.push("Source freshness:");
  if (freshness.length === 0) {
    lines.push("  none");
  } else {
    for (const item of freshness) {
      const scope = item.area === "legality-rules" ? `/${item.source_lineage}/${item.region}` : "";
      lines.push(`  ${item.game}/${item.area}${scope}: ${item.checked_at} (${item.ingestion_run_id})`);
    }
  }
  const recentRuns = Array.isArray(document.recent_runs) ? document.recent_runs : [];
  lines.push("Recent Ingestion Runs:");
  if (recentRuns.length === 0) {
    lines.push("  none");
  } else {
    for (const run of recentRuns) {
      lines.push(`  ${run.id}: ${run.state} (${run.progress?.current_stage ?? "unknown progress"})`);
    }
    const nextRunId = safeDiagnosticReference(recentRuns[0]?.id);
    if (nextRunId !== null) {
      lines.push(`Next: keepr run show --run-id ${nextRunId}`);
    }
  }
  return lines.join("\n");
}

function formatRun(document) {
  const lines = [
    `Ingestion Run ${document.id}: ${document.state}`,
    `Progress: ${document.progress?.current_stage ?? "unknown"}`,
  ];
  const completed = Array.isArray(document.progress?.completed_stages) ? document.progress.completed_stages : [];
  lines.push(`Completed stages: ${completed.length === 0 ? "none" : completed.join(", ")}`);
  const warnings = Array.isArray(document.warnings) ? document.warnings : [];
  if (warnings.length === 0) {
    lines.push("Warnings: none");
  } else {
    for (const warning of warnings) {
      lines.push(`Warning: ${safeMachineCode(warning.code) ?? "unspecified"}`);
    }
  }
  lines.push(`Failure: ${safeMachineCode(document.failure_code) ?? "none"}`);
  const cleanup = document.publication_cleanup;
  lines.push(
    `Publication cleanup: ${cleanup?.state ?? "not required"}${
      cleanup?.failure_code ? ` (${cleanup.failure_code})` : ""
    }`,
  );
  const history = Array.isArray(document.approval_history) ? document.approval_history : [];
  lines.push(`Approval history: ${history.length} ${history.length === 1 ? "decision" : "decisions"}`);
  for (const decision of history) {
    lines.push(`  ${decision.action ?? "decision"} at ${decision.approved_at ?? decision.rejected_at ?? "unknown"}`);
  }
  lines.push(`Publication outcome: ${document.publication_outcome ?? "none"}`);
  lines.push(`Resulting Catalogue Revision: ${document.resulting_revision_id ?? "none"}`);
  appendOperationalDiagnostics(lines, document.operational_diagnostics);
  return lines.join("\n");
}

function appendOperationalDiagnostics(lines, value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const references = value.references;
  if (references === null || typeof references !== "object" || Array.isArray(references)) return;
  lines.push(`Request reference: ${safeDiagnosticReference(references.request_id) ?? "none"}`);
  const workflow = references.workflow;
  lines.push(
    `Workflow: ${
      workflow !== null && typeof workflow === "object" && !Array.isArray(workflow)
        ? (safeDiagnosticReference(workflow.parent_id) ?? "none")
        : "none"
    }`,
  );
  const adapters = Array.isArray(references.adapter_versions)
    ? references.adapter_versions.flatMap((adapter) => {
        const safe = safeDiagnosticReference(adapter);
        return safe === null ? [] : [safe];
      })
    : [];
  lines.push(`Adapter versions: ${adapters.length === 0 ? "none" : adapters.join(", ")}`);
  lines.push(`Candidate: ${safeDiagnosticReference(references.candidate_digest) ?? "none"}`);
  const backup = references.backup;
  lines.push(
    `Backup: ${
      backup !== null && typeof backup === "object" && !Array.isArray(backup)
        ? (safeDiagnosticPath(backup.status_path) ?? "none")
        : "none"
    }`,
  );
  const recovery = references.recovery;
  lines.push(
    `Recovery: ${
      recovery !== null && typeof recovery === "object" && !Array.isArray(recovery)
        ? (safeDiagnosticPath(recovery.status_path) ?? "none")
        : "none"
    }`,
  );
  const retry = value.retry;
  lines.push(
    `Retry: ${
      retry !== null && typeof retry === "object" && !Array.isArray(retry)
        ? `${safeMachineCode(retry.code) ?? "unclassified"} (${
            safeDiagnosticReference(retry.source_run_id) ?? "unknown"
          })`
        : "not available"
    }`,
  );
  const terminalFailure = value.terminal_evidence?.failure;
  if (terminalFailure !== null && typeof terminalFailure === "object" && !Array.isArray(terminalFailure)) {
    lines.push(`Retry classification: ${safeMachineCode(terminalFailure.retryability_code) ?? "unclassified"}`);
  }
  const diagnosis = Array.isArray(value.diagnosis_sequence)
    ? value.diagnosis_sequence.flatMap((entry) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
          return [];
        }
        const method = safeDiagnosticMethod(entry.method);
        const path = safeDiagnosticPath(entry.path);
        const code = safeMachineCode(entry.code);
        return method === null || path === null || code === null ? [] : [{ method, path, code }];
      })
    : [];
  for (const entry of diagnosis) {
    lines.push(`Diagnosis: ${entry.method} ${entry.path} (${entry.code})`);
  }
  const retryMethod =
    retry !== null && typeof retry === "object" && !Array.isArray(retry) ? safeDiagnosticMethod(retry.method) : null;
  const retryPath =
    retry !== null && typeof retry === "object" && !Array.isArray(retry) ? safeDiagnosticPath(retry.path) : null;
  const next = retryMethod !== null && retryPath !== null ? { method: retryMethod, path: retryPath } : diagnosis[0];
  if (next !== undefined && next !== null) {
    lines.push(`Next: ${next.method} ${next.path}`);
  }
  const evidence = value.terminal_evidence;
  const coverage =
    evidence !== null &&
    typeof evidence === "object" &&
    !Array.isArray(evidence) &&
    evidence.coverage !== null &&
    typeof evidence.coverage === "object" &&
    !Array.isArray(evidence.coverage)
      ? evidence.coverage
      : {};
  lines.push(
    `Coverage: ${safeDiagnosticCount(coverage.source_snapshot_count)} snapshots, ${safeDiagnosticCount(
      coverage.source_observation_set_count,
    )} observation sets, ${safeDiagnosticCount(coverage.fetch_attempt_count)} attempts`,
  );
}

function safeDiagnosticReference(value) {
  return typeof value === "string" && value.length <= 512 && /^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/u.test(value)
    ? value
    : null;
}

function safeMachineCode(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,127}$/u.test(value) ? value : null;
}

function safeDiagnosticPath(value) {
  return typeof value === "string" && value.length <= 1024 && /^\/v1\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/u.test(value)
    ? value
    : null;
}

function safeDiagnosticMethod(value) {
  return value === "GET" || value === "POST" ? value : null;
}

function safeDiagnosticCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : "unknown";
}
