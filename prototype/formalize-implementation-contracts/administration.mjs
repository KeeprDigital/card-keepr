export const contractVersion = "card-keepr-administration@1";

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_RUN_STATES = new Set([
  "planning",
  "collecting",
  "parsing",
  "reconciling",
  "awaiting_approval",
  "publishing"
]);
const TERMINAL_RUN_STATES = new Set(["published", "rejected", "expired", "failed"]);

const runNext = {
  planning: "collecting",
  collecting: "parsing",
  parsing: "reconciling"
};

const backupNext = {
  pending: "exporting",
  exporting: "restoring_verification",
  restoring_verification: "verifying",
  verifying: "verified"
};

const recoveryNext = {
  preparing: "restoring",
  restoring: "validating",
  validating: "awaiting_acceptance",
  awaiting_acceptance: "accepted"
};

const releaseNext = {
  requested: "preflight",
  preflight: "migrating",
  migrating: "deploying",
  deploying: "smoke_testing",
  smoke_testing: "succeeded"
};

const rotationNext = {
  replacement_installed: "replacement_verified",
  replacement_verified: "old_revoked"
};

function clone(value) {
  return structuredClone(value);
}

function at(state, action) {
  return action.at ?? state.now;
}

function outcome(state, action, accepted, code, detail) {
  state.now = at(state, action);
  state.last_transition = {
    action: action.type,
    accepted,
    code,
    detail,
    at: state.now
  };
  return state;
}

function reject(state, action, code, detail) {
  return outcome(state, action, false, code, detail);
}

function accept(state, action, detail) {
  return outcome(state, action, true, "ok", detail);
}

function expireIfDue(state, now) {
  if (!state.active_run_id) return null;
  const run = state.runs[state.active_run_id];
  if (
    run?.state === "awaiting_approval" &&
    now >= run.approval_deadline
  ) {
    run.state = "expired";
    run.terminal_at = now;
    state.active_run_id = null;
    return run;
  }
  return null;
}

function activeRun(state) {
  return state.active_run_id ? state.runs[state.active_run_id] : null;
}

function activeRelease(state) {
  return state.release && !["succeeded", "failed"].includes(state.release.state)
    ? state.release
    : null;
}

export function createInitialState({
  now = Date.parse("2026-07-28T00:00:00.000Z"),
  currentRevisionId = "catrev_demo_001",
  recoveryHealth = "healthy"
} = {}) {
  return {
    contract: contractVersion,
    now,
    current_revision_id: currentRevisionId,
    active_run_id: null,
    runs: {},
    backups: {},
    recovery: {
      health: recoveryHealth,
      verified_revision_id:
        recoveryHealth === "healthy" ? currentRevisionId : null,
      operation: null
    },
    release: null,
    credential_rotations: {},
    last_transition: null
  };
}

export function transition(input, action) {
  const state = clone(input);
  const now = at(state, action);

  if (action.type !== "TICK") {
    expireIfDue(state, now);
  }

  switch (action.type) {
    case "TICK": {
      const expired = expireIfDue(state, now);
      return accept(
        state,
        action,
        expired
          ? `Expired ${expired.id} and released the ingestion lock.`
          : "Clock advanced without an automatic transition."
      );
    }

    case "START_RUN": {
      if (activeRun(state)) {
        return reject(state, action, "active_run_exists", state.active_run_id);
      }
      if (state.recovery.health === "blocked") {
        return reject(state, action, "recovery_in_progress", "Ingestion is blocked.");
      }
      if (!action.run_id || !action.idempotency_key) {
        return reject(state, action, "invalid_precondition", "Run and idempotency identities are required.");
      }
      if (!Array.isArray(action.games) || action.games.length === 0) {
        return reject(state, action, "invalid_supported_games", "At least one Supported Game is required.");
      }
      if (state.runs[action.run_id]) {
        return reject(state, action, "identity_conflict", action.run_id);
      }
      state.runs[action.run_id] = {
        id: action.run_id,
        state: "planning",
        selected_games: [...new Set(action.games)].sort(),
        started_at: now,
        expected_current_revision_id: action.expected_current_revision_id,
        linked_run_id: action.linked_run_id ?? null,
        idempotency_key: action.idempotency_key,
        candidate_digest: null,
        candidate_created_at: null,
        approval_deadline: null,
        approval: null,
        published_revision_id: null,
        terminal_at: null
      };
      state.active_run_id = action.run_id;
      return accept(state, action, `Started ${action.run_id}.`);
    }

    case "ADVANCE_RUN": {
      const run = state.runs[action.run_id];
      if (!run || state.active_run_id !== action.run_id) {
        return reject(state, action, "run_not_active", action.run_id);
      }
      if (action.to === "failed" && ACTIVE_RUN_STATES.has(run.state)) {
        run.state = "failed";
        run.failure_code = action.failure_code ?? "unspecified_failure";
        run.terminal_at = now;
        state.active_run_id = null;
        return accept(state, action, `Terminally failed ${run.id}.`);
      }
      if (runNext[run.state] !== action.to) {
        return reject(state, action, "illegal_run_transition", `${run.state} → ${action.to}`);
      }
      run.state = action.to;
      return accept(state, action, `${run.id}: ${action.to}.`);
    }

    case "CANDIDATE_READY": {
      const run = state.runs[action.run_id];
      if (!run || state.active_run_id !== action.run_id || run.state !== "reconciling") {
        return reject(state, action, "run_not_reconciling", action.run_id);
      }
      if (!/^[a-f0-9]{64}$/.test(action.candidate_digest ?? "")) {
        return reject(state, action, "invalid_candidate_digest", "Expected lower-case SHA-256.");
      }
      run.state = "awaiting_approval";
      run.candidate_digest = action.candidate_digest;
      run.candidate_created_at = now;
      run.approval_deadline = now + 7 * DAY_MS;
      return accept(state, action, `${run.id} awaits approval for seven days.`);
    }

    case "APPROVE_RUN": {
      const run = state.runs[action.run_id];
      if (!run || state.active_run_id !== action.run_id || run.state !== "awaiting_approval") {
        const wasExpired = run?.state === "expired";
        return reject(
          state,
          action,
          wasExpired ? "candidate_expired" : "run_not_awaiting_approval",
          action.run_id
        );
      }
      if (action.candidate_digest !== run.candidate_digest) {
        return reject(state, action, "candidate_digest_mismatch", "Candidate changed or stale input.");
      }
      if (action.expected_current_revision_id !== state.current_revision_id) {
        return reject(state, action, "current_revision_mismatch", state.current_revision_id);
      }
      if (
        state.recovery.health !== "healthy" ||
        state.recovery.verified_revision_id !== state.current_revision_id
      ) {
        return reject(state, action, "recovery_not_verified", state.current_revision_id);
      }
      run.state = "publishing";
      run.approval = {
        approved_at: now,
        candidate_digest: action.candidate_digest,
        expected_current_revision_id: action.expected_current_revision_id
      };
      return accept(state, action, `Approved ${run.id}; publication began.`);
    }

    case "REJECT_RUN": {
      const run = state.runs[action.run_id];
      if (!run || state.active_run_id !== action.run_id || run.state !== "awaiting_approval") {
        return reject(state, action, "run_not_awaiting_approval", action.run_id);
      }
      if (action.candidate_digest !== run.candidate_digest) {
        return reject(state, action, "candidate_digest_mismatch", "Candidate changed or stale input.");
      }
      run.state = "rejected";
      run.terminal_at = now;
      state.active_run_id = null;
      return accept(state, action, `Rejected ${run.id}.`);
    }

    case "PUBLISH_SUCCEEDED": {
      const run = state.runs[action.run_id];
      if (!run || state.active_run_id !== action.run_id || run.state !== "publishing") {
        return reject(state, action, "run_not_publishing", action.run_id);
      }
      if (!action.export_verified || !action.export_manifest_digest) {
        return reject(state, action, "export_not_verified", "Publication remains invisible.");
      }
      if (action.previous_revision_id !== state.current_revision_id) {
        return reject(state, action, "current_revision_mismatch", state.current_revision_id);
      }
      run.state = "published";
      run.published_revision_id = action.catalogue_revision_id;
      run.export_manifest_digest = action.export_manifest_digest;
      run.terminal_at = now;
      state.current_revision_id = action.catalogue_revision_id;
      state.active_run_id = null;
      const backupId = action.backup_attempt_id;
      state.backups[backupId] = {
        id: backupId,
        catalogue_revision_id: action.catalogue_revision_id,
        state: "pending",
        manifest_digest: null,
        linked_attempt_id: null
      };
      state.recovery.health = "degraded";
      state.recovery.verified_revision_id = null;
      return accept(
        state,
        action,
        `Published ${action.catalogue_revision_id}; recovery is degraded pending verification.`
      );
    }

    case "RETRY_RUN": {
      const source = state.runs[action.source_run_id];
      if (!source || !TERMINAL_RUN_STATES.has(source.state)) {
        return reject(state, action, "source_run_not_terminal", action.source_run_id);
      }
      return transition(state, {
        type: "START_RUN",
        at: now,
        run_id: action.new_run_id,
        linked_run_id: source.id,
        games: action.games ?? source.selected_games,
        expected_current_revision_id: state.current_revision_id,
        idempotency_key: action.idempotency_key
      });
    }

    case "ADVANCE_BACKUP": {
      const backup = state.backups[action.backup_attempt_id];
      if (!backup) {
        return reject(state, action, "backup_not_found", action.backup_attempt_id);
      }
      if (action.to === "failed" && !["verified", "failed"].includes(backup.state)) {
        backup.state = "failed";
        backup.failure_code = action.failure_code ?? "backup_verification_failed";
        return accept(state, action, `Failed ${backup.id}; recovery remains degraded.`);
      }
      if (backupNext[backup.state] !== action.to) {
        return reject(state, action, "illegal_backup_transition", `${backup.state} → ${action.to}`);
      }
      backup.state = action.to;
      if (action.to === "verified") {
        backup.manifest_digest = action.manifest_digest;
        if (backup.catalogue_revision_id === state.current_revision_id) {
          state.recovery.health = "healthy";
          state.recovery.verified_revision_id = state.current_revision_id;
        }
      }
      return accept(state, action, `${backup.id}: ${action.to}.`);
    }

    case "RETRY_BACKUP": {
      const source = state.backups[action.source_attempt_id];
      if (!source || source.state !== "failed") {
        return reject(state, action, "source_backup_not_failed", action.source_attempt_id);
      }
      if (source.catalogue_revision_id !== state.current_revision_id) {
        return reject(state, action, "backup_not_current_revision", source.catalogue_revision_id);
      }
      state.backups[action.new_attempt_id] = {
        id: action.new_attempt_id,
        catalogue_revision_id: source.catalogue_revision_id,
        state: "pending",
        manifest_digest: null,
        linked_attempt_id: source.id
      };
      return accept(state, action, `Created ${action.new_attempt_id}.`);
    }

    case "BEGIN_RECOVERY": {
      if (activeRun(state) || activeRelease(state)) {
        return reject(state, action, "mutation_not_idle", "Ingestion and release must be idle.");
      }
      if (state.recovery.operation && !["accepted", "failed"].includes(state.recovery.operation.state)) {
        return reject(state, action, "recovery_exists", state.recovery.operation.id);
      }
      state.recovery = {
        health: "blocked",
        verified_revision_id: null,
        operation: {
          id: action.recovery_id,
          state: "preparing",
          target_revision_id: action.target_revision_id,
          target_digest: action.target_digest,
          linked_operation_id: action.linked_operation_id ?? null
        }
      };
      return accept(state, action, `Recovery ${action.recovery_id} blocked mutation.`);
    }

    case "ADVANCE_RECOVERY": {
      const operation = state.recovery.operation;
      if (!operation || operation.id !== action.recovery_id) {
        return reject(state, action, "recovery_not_found", action.recovery_id);
      }
      if (action.to === "failed" && !["accepted", "failed"].includes(operation.state)) {
        operation.state = "failed";
        operation.failure_code = action.failure_code ?? "recovery_failed";
        return accept(state, action, "Recovery failed; mutation remains blocked.");
      }
      if (recoveryNext[operation.state] !== action.to) {
        return reject(state, action, "illegal_recovery_transition", `${operation.state} → ${action.to}`);
      }
      if (
        action.to === "awaiting_acceptance" &&
        action.verified_target_digest !== operation.target_digest
      ) {
        return reject(state, action, "recovery_digest_mismatch", operation.target_digest);
      }
      operation.state = action.to;
      if (action.to === "accepted") {
        if (action.expected_restored_revision_id !== operation.target_revision_id) {
          operation.state = "awaiting_acceptance";
          return reject(state, action, "restored_revision_mismatch", operation.target_revision_id);
        }
        state.current_revision_id = operation.target_revision_id;
        state.recovery.health = "healthy";
        state.recovery.verified_revision_id = operation.target_revision_id;
      }
      return accept(state, action, `${operation.id}: ${action.to}.`);
    }

    case "REQUEST_RELEASE": {
      if (action.environment !== "production") {
        return reject(state, action, "production_target_required", action.environment);
      }
      if (activeRelease(state)) {
        return reject(state, action, "release_exists", state.release.id);
      }
      if (activeRun(state)) {
        return reject(state, action, "ingestion_not_idle", state.active_run_id);
      }
      if (
        state.recovery.health !== "healthy" ||
        state.recovery.verified_revision_id !== state.current_revision_id
      ) {
        return reject(state, action, "recovery_not_verified", state.current_revision_id);
      }
      if (action.expected_current_revision_id !== state.current_revision_id) {
        return reject(state, action, "current_revision_mismatch", state.current_revision_id);
      }
      state.release = {
        id: action.release_id,
        state: "requested",
        environment: "production",
        expected_current_revision_id: action.expected_current_revision_id,
        workflow_dispatch_id: action.workflow_dispatch_id
      };
      return accept(state, action, `Dispatched ${action.release_id}.`);
    }

    case "ADVANCE_RELEASE": {
      const release = state.release;
      if (!release || release.id !== action.release_id) {
        return reject(state, action, "release_not_found", action.release_id);
      }
      if (action.to === "failed" && !["succeeded", "failed"].includes(release.state)) {
        release.state = "failed";
        release.failure_code = action.failure_code ?? "release_failed";
        return accept(state, action, `${release.id} failed; use a compatible roll-forward.`);
      }
      if (releaseNext[release.state] !== action.to) {
        return reject(state, action, "illegal_release_transition", `${release.state} → ${action.to}`);
      }
      release.state = action.to;
      return accept(state, action, `${release.id}: ${action.to}.`);
    }

    case "BEGIN_CREDENTIAL_ROTATION": {
      if (state.credential_rotations[action.rotation_id]) {
        return reject(state, action, "identity_conflict", action.rotation_id);
      }
      state.credential_rotations[action.rotation_id] = {
        id: action.rotation_id,
        credential_class: action.credential_class,
        state: "replacement_installed",
        old_fingerprint: action.old_fingerprint,
        replacement_fingerprint: action.replacement_fingerprint
      };
      return accept(state, action, `Installed replacement for ${action.credential_class}.`);
    }

    case "ADVANCE_CREDENTIAL_ROTATION": {
      const rotation = state.credential_rotations[action.rotation_id];
      if (!rotation) {
        return reject(state, action, "rotation_not_found", action.rotation_id);
      }
      if (rotationNext[rotation.state] !== action.to) {
        return reject(state, action, "illegal_rotation_transition", `${rotation.state} → ${action.to}`);
      }
      if (
        action.to === "old_revoked" &&
        action.old_fingerprint !== rotation.old_fingerprint
      ) {
        return reject(state, action, "credential_fingerprint_mismatch", rotation.old_fingerprint);
      }
      rotation.state = action.to;
      return accept(state, action, `${rotation.id}: ${action.to}.`);
    }

    default:
      return reject(state, action, "unknown_action", action.type);
  }
}

export const transitionTables = {
  ingestion_run: {
    ...runNext,
    reconciling: "awaiting_approval",
    awaiting_approval: ["publishing", "rejected", "expired", "failed"],
    publishing: ["published", "failed"]
  },
  backup_attempt: backupNext,
  recovery_operation: recoveryNext,
  production_release: releaseNext,
  credential_rotation: rotationNext
};
