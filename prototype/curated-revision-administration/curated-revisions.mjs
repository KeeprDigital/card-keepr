import { createHash } from "node:crypto";

export const contractVersion = "card-keepr-curated-revisions@1";

const SUPPORTED_GAMES = new Set([
  "one-piece",
  "fusion-world",
  "digimon",
  "gundam"
]);

const FIELD_ENTITY_TYPES = new Set([
  "card",
  "printing",
  "product",
  "release",
  "distribution_context",
  "erratum",
  "legality_rule"
]);

const FORBIDDEN_FIELD_PATHS = [
  "/id",
  "/game",
  "/official_identity",
  "/source_snapshots",
  "/source_observations",
  "/provenance"
];

const MUTATIONS = new Set([
  "CREATE_REVISION",
  "REAFFIRM_REVISION",
  "SUPERSEDE_REVISION",
  "RETIRE_REVISION"
]);

function clone(value) {
  return structuredClone(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    );
  }
  return value;
}

export function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

export function proposalDigest(proposal) {
  return digest(proposal);
}

export function targetKey(proposal) {
  const { game, target } = proposal;
  if (target.kind === "field") {
    return [
      game,
      "field",
      target.entity_type,
      target.entity_id,
      target.path
    ].join("|");
  }
  return [
    game,
    "relationship",
    target.relationship_kind,
    target.from.type,
    target.from.id,
    target.to.type,
    target.to.id
  ].join("|");
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

function accept(state, action, detail, code = "ok") {
  return outcome(state, action, true, code, detail);
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/.test(value ?? "");
}

function isOpaqueId(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  );
}

function isDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value ?? "");
}

function intervalOf(proposal) {
  return proposal.effective_interval ?? { from: null, to: null };
}

function intervalsOverlap(left, right) {
  const a = intervalOf(left);
  const b = intervalOf(right);
  const startsBeforeBEnds = b.to === null || a.from === null || a.from < b.to;
  const bStartsBeforeAEnds = a.to === null || b.from === null || b.from < a.to;
  return startsBeforeBEnds && bStartsBeforeAEnds;
}

function intervalContains(proposal, on) {
  const interval = intervalOf(proposal);
  return (
    (interval.from === null || interval.from <= on) &&
    (interval.to === null || on < interval.to)
  );
}

function validateEvidence(evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return "At least one supporting evidence reference is required.";
  }
  for (const item of evidence) {
    if (item?.kind === "source_observation" && isOpaqueId(item.id)) continue;
    if (
      item?.kind === "owner_reference" &&
      typeof item.uri === "string" &&
      item.uri.length > 0 &&
      isSha256(item.content_digest)
    ) {
      continue;
    }
    return "Evidence must be a Source Observation identity or a digested owner reference.";
  }
  return null;
}

export function validateProposal(proposal) {
  if (!proposal || typeof proposal !== "object") {
    return { valid: false, code: "curated_revision_schema_invalid", detail: "Proposal is required." };
  }
  const proposalFields = [
    "game", "target", "assertion", "rationale", "evidence",
    "effective_interval", "reviewed_source_digest",
    "supersedes_revision_id"
  ];
  if (
    !proposalFields.every((field) => Object.hasOwn(proposal, field)) ||
    Object.keys(proposal).some((field) => !proposalFields.includes(field))
  ) {
    return {
      valid: false,
      code: "curated_revision_schema_invalid",
      detail: "The proposal must have the exact canonical fields."
    };
  }
  if (!SUPPORTED_GAMES.has(proposal.game)) {
    return { valid: false, code: "invalid_supported_game", detail: proposal.game };
  }
  if (
    typeof proposal.rationale !== "string" ||
    proposal.rationale.trim().length === 0
  ) {
    return {
      valid: false,
      code: "curated_revision_schema_invalid",
      detail: "A non-empty rationale is required."
    };
  }
  if (!isSha256(proposal.reviewed_source_digest)) {
    return {
      valid: false,
      code: "curated_revision_schema_invalid",
      detail: "reviewed_source_digest must be a lower-case SHA-256."
    };
  }
  const evidenceError = validateEvidence(proposal.evidence);
  if (evidenceError) {
    return {
      valid: false,
      code: "curated_revision_schema_invalid",
      detail: evidenceError
    };
  }

  const interval = proposal.effective_interval;
  if (
    !interval || typeof interval !== "object" || Array.isArray(interval) ||
    Object.keys(interval).length !== 2 ||
    !Object.hasOwn(interval, "from") || !Object.hasOwn(interval, "to") ||
    (interval.from !== null && !isDate(interval.from)) ||
    (interval.to !== null && !isDate(interval.to)) ||
    (interval.from !== null &&
      interval.to !== null &&
      interval.from >= interval.to)
  ) {
    return {
      valid: false,
      code: "curated_revision_interval_invalid",
      detail: "The optional interval is closed-open and from must precede to."
    };
  }

  const { target, assertion } = proposal;
  if (target?.kind === "field") {
    if (
      !FIELD_ENTITY_TYPES.has(target.entity_type) ||
      !isOpaqueId(target.entity_id) ||
      typeof target.path !== "string" ||
      !target.path.startsWith("/")
    ) {
      return {
        valid: false,
        code: "curated_revision_target_invalid",
        detail: "Field target is incomplete."
      };
    }
    if (
      FORBIDDEN_FIELD_PATHS.some(
        (path) => target.path === path || target.path.startsWith(`${path}/`)
      )
    ) {
      return {
        valid: false,
        code: "curated_revision_identity_forbidden",
        detail: target.path
      };
    }
    if (assertion?.kind !== "field" || !Object.hasOwn(assertion, "value")) {
      return {
        valid: false,
        code: "curated_revision_schema_invalid",
        detail: "A field target requires a field assertion with an explicit value."
      };
    }
  } else if (target?.kind === "relationship") {
    if (
      typeof target.relationship_kind !== "string" ||
      target.relationship_kind.length === 0 ||
      !isOpaqueId(target.from?.id) ||
      !isOpaqueId(target.to?.id) ||
      typeof target.from?.type !== "string" ||
      typeof target.to?.type !== "string"
    ) {
      return {
        valid: false,
        code: "curated_revision_target_invalid",
        detail: "Relationship target is incomplete."
      };
    }
    if (
      assertion?.kind !== "relationship" ||
      !["present", "absent"].includes(assertion.presence)
    ) {
      return {
        valid: false,
        code: "curated_revision_schema_invalid",
        detail: "A relationship target requires present or absent."
      };
    }
  } else {
    return {
      valid: false,
      code: "curated_revision_target_invalid",
      detail: "Target kind must be field or relationship."
    };
  }

  if (
    proposal.supersedes_revision_id !== null &&
    !isOpaqueId(proposal.supersedes_revision_id)
  ) {
    return {
      valid: false,
      code: "curated_revision_schema_invalid",
      detail: "supersedes_revision_id must be an opaque identity or null."
    };
  }

  return { valid: true, code: "ok", detail: targetKey(proposal) };
}

function appendEvent(state, revision, type, details = {}) {
  revision.event_version += 1;
  const event = {
    id: `crevt_demo_${String(state.events.length + 1).padStart(3, "0")}`,
    revision_id: revision.id,
    type,
    event_version: revision.event_version,
    at: state.now,
    details: clone(details)
  };
  state.events.push(event);

  if (type === "authored" || type === "reaffirmed") {
    revision.status = "active";
    revision.pending_conflict = null;
  } else if (type === "source_change_detected") {
    revision.status = "reconfirmation_required";
    revision.pending_conflict = {
      id: details.conflict_id,
      digest: details.conflict_digest,
      run_id: details.run_id,
      previous_source_digest: details.previous_source_digest,
      observed_source_digest: details.observed_source_digest
    };
  } else if (type === "superseded") {
    revision.status = "superseded";
    revision.pending_conflict = null;
  } else if (type === "retired") {
    revision.status = "retired";
    revision.pending_conflict = null;
  }
  return event;
}

function reviewedSourceDigest(state, revision) {
  return [...state.events]
    .reverse()
    .find(
      (event) =>
        event.revision_id === revision.id &&
        ["authored", "reaffirmed"].includes(event.type)
    )?.details.reviewed_source_digest;
}

function activeTargetConflict(state, proposal, exceptRevisionId = null) {
  const key = targetKey(proposal);
  return Object.values(state.revisions).find(
    (revision) =>
      revision.id !== exceptRevisionId &&
      revision.status === "active" &&
      targetKey(revision.content) === key &&
      intervalsOverlap(revision.content, proposal)
  );
}

function requestFingerprint(action) {
  const copy = clone(action);
  delete copy.at;
  return digest(copy);
}

function replayOrConflict(state, action) {
  const prior = state.idempotency[action.idempotency_key];
  if (!prior) return null;
  if (prior.fingerprint !== requestFingerprint(action)) {
    return reject(
      state,
      action,
      "idempotency_conflict",
      action.idempotency_key
    );
  }
  return accept(state, action, prior.detail, prior.code);
}

function rememberMutation(state, action) {
  state.idempotency[action.idempotency_key] = {
    fingerprint: requestFingerprint(action),
    code: state.last_transition.code,
    detail: state.last_transition.detail
  };
  return state;
}

function mutationGate(state, action) {
  if (action.environment !== "production") {
    return reject(
      state,
      action,
      "production_target_required",
      action.environment
    );
  }
  if (!isOpaqueId(action.idempotency_key)) {
    return reject(
      state,
      action,
      "invalid_precondition",
      "An idempotency key is required."
    );
  }
  const replay = replayOrConflict(state, action);
  if (replay) return replay;
  if (action.expected_current_revision_id !== state.current_revision_id) {
    return reject(
      state,
      action,
      "current_revision_mismatch",
      state.current_revision_id
    );
  }
  if (state.active_run_id !== null) {
    return reject(state, action, "ingestion_not_idle", state.active_run_id);
  }
  if (state.operational.active_production_release_id !== null) {
    return reject(
      state,
      action,
      "release_not_idle",
      state.operational.active_production_release_id
    );
  }
  if (state.operational.recovery_health === "blocked") {
    return reject(
      state,
      action,
      "recovery_in_progress",
      "Curated Revision mutation is blocked."
    );
  }
  return null;
}

function revisionPrecondition(state, action) {
  const revision = state.revisions[action.revision_id];
  if (!revision) {
    return {
      result: reject(
        state,
        action,
        "curated_revision_not_found",
        action.revision_id
      )
    };
  }
  if (revision.event_version !== action.expected_event_version) {
    return {
      result: reject(
        state,
        action,
        "curated_revision_event_version_mismatch",
        String(revision.event_version)
      )
    };
  }
  const pending = revision.pending_conflict;
  if (pending && action.conflict_digest !== pending.digest) {
    return {
      result: reject(
        state,
        action,
        "curated_revision_conflict_digest_mismatch",
        pending.digest
      )
    };
  }
  if (!pending && action.conflict_digest !== null && action.conflict_digest !== undefined) {
    return {
      result: reject(
        state,
        action,
        "curated_revision_has_no_pending_conflict",
        revision.id
      )
    };
  }
  if (!["active", "reconfirmation_required"].includes(revision.status)) {
    return {
      result: reject(
        state,
        action,
        "curated_revision_state_conflict",
        revision.status
      )
    };
  }
  return { revision };
}

export function createInitialState({
  now = Date.parse("2026-07-28T00:00:00.000Z"),
  currentRevisionId = "catrev_demo_001",
  recoveryHealth = "healthy",
  activeProductionReleaseId = null
} = {}) {
  return {
    contract: contractVersion,
    now,
    current_revision_id: currentRevisionId,
    operational: {
      recovery_health: recoveryHealth,
      active_production_release_id: activeProductionReleaseId
    },
    active_run_id: null,
    runs: {},
    revisions: {},
    events: [],
    idempotency: {},
    last_transition: null
  };
}

export function transition(input, action) {
  const state = clone(input);
  state.now = at(state, action);

  if (MUTATIONS.has(action.type)) {
    const gated = mutationGate(state, action);
    if (gated) return gated;
  }

  switch (action.type) {
    case "VALIDATE_PROPOSAL": {
      const validation = validateProposal(action.proposal);
      return validation.valid
        ? accept(state, action, `Valid proposal for ${validation.detail}.`)
        : reject(state, action, validation.code, validation.detail);
    }

    case "CREATE_REVISION": {
      const validation = validateProposal(action.proposal);
      if (!validation.valid) {
        return reject(state, action, validation.code, validation.detail);
      }
      if (action.proposal.supersedes_revision_id) {
        return reject(
          state,
          action,
          "curated_revision_schema_invalid",
          "Use supersede for a proposal with supersedes_revision_id."
        );
      }
      const expectedDigest = proposalDigest(action.proposal);
      if (action.proposal_digest !== expectedDigest) {
        return reject(
          state,
          action,
          "curated_revision_content_digest_mismatch",
          expectedDigest
        );
      }
      if (!isOpaqueId(action.revision_id) || state.revisions[action.revision_id]) {
        return reject(
          state,
          action,
          "identity_conflict",
          action.revision_id
        );
      }
      const conflict = activeTargetConflict(state, action.proposal);
      if (conflict) {
        return reject(
          state,
          action,
          "curated_revision_target_conflict",
          conflict.id
        );
      }
      const revision = {
        id: action.revision_id,
        content: clone(action.proposal),
        content_digest: expectedDigest,
        author: action.authenticated_author ?? "owner",
        created_at: state.now,
        status: null,
        event_version: 0,
        pending_conflict: null
      };
      state.revisions[revision.id] = revision;
      appendEvent(state, revision, "authored", {
        reviewed_source_digest: revision.content.reviewed_source_digest
      });
      accept(state, action, `Authored and activated ${revision.id}.`);
      return rememberMutation(state, action);
    }

    case "START_RUN": {
      if (state.active_run_id !== null) {
        return reject(state, action, "active_run_exists", state.active_run_id);
      }
      if (state.operational.recovery_health === "blocked") {
        return reject(state, action, "recovery_in_progress", "Ingestion is blocked.");
      }
      if (state.operational.active_production_release_id !== null) {
        return reject(
          state,
          action,
          "release_not_idle",
          state.operational.active_production_release_id
        );
      }
      const games = [...new Set(action.games ?? [])].sort();
      if (games.length === 0 || games.some((game) => !SUPPORTED_GAMES.has(game))) {
        return reject(
          state,
          action,
          "invalid_supported_games",
          "At least one Supported Game is required."
        );
      }
      if (!isOpaqueId(action.run_id) || state.runs[action.run_id]) {
        return reject(state, action, "identity_conflict", action.run_id);
      }
      if (!isDate(action.effective_on ?? "2026-07-28")) {
        return reject(
          state,
          action,
          "invalid_effective_date",
          action.effective_on
        );
      }
      const attention = Object.values(state.revisions).find(
        (revision) =>
          revision.status === "reconfirmation_required" &&
          games.includes(revision.content.game)
      );
      if (attention) {
        return reject(
          state,
          action,
          "curated_revision_attention_required",
          attention.id
        );
      }
      const effectiveOn = action.effective_on ?? "2026-07-28";
      const pinned = Object.values(state.revisions)
        .filter(
          (revision) =>
            revision.status === "active" &&
            games.includes(revision.content.game) &&
            intervalContains(revision.content, effectiveOn)
        )
        .map((revision) => revision.id)
        .sort();
      const run = {
        id: action.run_id,
        state: "reconciling",
        selected_games: games,
        effective_on: effectiveOn,
        curated_revision_ids: pinned,
        curated_revision_set_digest: digest(pinned),
        candidate_digest: null,
        curated_effects: [],
        failure_code: null,
        linked_run_id: action.linked_run_id ?? null
      };
      state.runs[run.id] = run;
      state.active_run_id = run.id;
      return accept(
        state,
        action,
        `Started ${run.id} with ${pinned.length} pinned Curated Revision(s).`
      );
    }

    case "APPLY_CURATED_REVISIONS": {
      const run = state.runs[action.run_id];
      if (
        !run ||
        state.active_run_id !== run.id ||
        run.state !== "reconciling"
      ) {
        return reject(state, action, "run_not_reconciling", action.run_id);
      }
      const conflicts = [];
      const effects = [];
      for (const revisionId of run.curated_revision_ids) {
        const revision = state.revisions[revisionId];
        const key = targetKey(revision.content);
        const observedDigest = action.source_digests?.[key];
        if (!isSha256(observedDigest)) {
          return reject(
            state,
            action,
            "curated_revision_source_digest_missing",
            key
          );
        }
        const previousDigest = reviewedSourceDigest(state, revision);
        if (observedDigest !== previousDigest) {
          const conflictId = `crconf_demo_${String(
            state.events.length + conflicts.length + 1
          ).padStart(3, "0")}`;
          const conflictDigest = digest({
            conflict_id: conflictId,
            run_id: run.id,
            revision_id: revision.id,
            previous_source_digest: previousDigest,
            observed_source_digest: observedDigest
          });
          appendEvent(state, revision, "source_change_detected", {
            conflict_id: conflictId,
            conflict_digest: conflictDigest,
            run_id: run.id,
            previous_source_digest: previousDigest,
            observed_source_digest: observedDigest
          });
          conflicts.push(revision.id);
        } else {
          effects.push({
            revision_id: revision.id,
            target: key,
            assertion: clone(revision.content.assertion),
            evidence_category: "curated"
          });
        }
      }
      if (conflicts.length > 0) {
        run.state = "failed";
        run.failure_code = "curated_revision_reconfirmation_required";
        state.active_run_id = null;
        return accept(
          state,
          action,
          `Terminally failed ${run.id}; review ${conflicts.join(", ")}.`
        );
      }
      run.state = "awaiting_approval";
      run.curated_effects = effects;
      run.candidate_digest = digest({
        run_id: run.id,
        curated_revision_set_digest: run.curated_revision_set_digest,
        effects
      });
      return accept(
        state,
        action,
        `Applied ${effects.length} Curated Revision(s) to ${run.id}.`
      );
    }

    case "FAIL_RUN": {
      const run = state.runs[action.run_id];
      if (!run || state.active_run_id !== run.id) {
        return reject(state, action, "run_not_active", action.run_id);
      }
      run.state = "failed";
      run.failure_code = action.failure_code ?? "prototype_failure";
      state.active_run_id = null;
      return accept(state, action, `Terminally failed ${run.id}.`);
    }

    case "REAFFIRM_REVISION": {
      const checked = revisionPrecondition(state, action);
      if (checked.result) return checked.result;
      const revision = checked.revision;
      if (revision.status !== "reconfirmation_required") {
        return reject(
          state,
          action,
          "curated_revision_state_conflict",
          revision.status
        );
      }
      if (typeof action.rationale !== "string" || action.rationale.trim() === "") {
        return reject(
          state,
          action,
          "curated_revision_schema_invalid",
          "A reaffirmation rationale is required."
        );
      }
      const pending = clone(revision.pending_conflict);
      appendEvent(state, revision, "reaffirmed", {
        conflict_id: pending.id,
        conflict_digest: pending.digest,
        reviewed_source_digest: pending.observed_source_digest,
        rationale: action.rationale
      });
      accept(state, action, `Reaffirmed ${revision.id} without changing its assertion.`);
      return rememberMutation(state, action);
    }

    case "SUPERSEDE_REVISION": {
      const checked = revisionPrecondition(state, action);
      if (checked.result) return checked.result;
      const oldRevision = checked.revision;
      const validation = validateProposal(action.proposal);
      if (!validation.valid) {
        return reject(state, action, validation.code, validation.detail);
      }
      if (action.proposal.supersedes_revision_id !== oldRevision.id) {
        return reject(
          state,
          action,
          "curated_revision_supersession_mismatch",
          oldRevision.id
        );
      }
      if (
        oldRevision.pending_conflict &&
        action.proposal.reviewed_source_digest !==
          oldRevision.pending_conflict.observed_source_digest
      ) {
        return reject(
          state,
          action,
          "curated_revision_reviewed_source_mismatch",
          oldRevision.pending_conflict.observed_source_digest
        );
      }
      if (typeof action.rationale !== "string" || action.rationale.trim() === "") {
        return reject(
          state,
          action,
          "curated_revision_schema_invalid",
          "A supersession rationale is required."
        );
      }
      const expectedDigest = proposalDigest(action.proposal);
      if (action.proposal_digest !== expectedDigest) {
        return reject(
          state,
          action,
          "curated_revision_content_digest_mismatch",
          expectedDigest
        );
      }
      if (
        !isOpaqueId(action.new_revision_id) ||
        state.revisions[action.new_revision_id]
      ) {
        return reject(
          state,
          action,
          "identity_conflict",
          action.new_revision_id
        );
      }
      const conflict = activeTargetConflict(
        state,
        action.proposal,
        oldRevision.id
      );
      if (conflict) {
        return reject(
          state,
          action,
          "curated_revision_target_conflict",
          conflict.id
        );
      }
      const newRevision = {
        id: action.new_revision_id,
        content: clone(action.proposal),
        content_digest: expectedDigest,
        author: action.authenticated_author ?? "owner",
        created_at: state.now,
        status: null,
        event_version: 0,
        pending_conflict: null
      };
      state.revisions[newRevision.id] = newRevision;
      appendEvent(state, oldRevision, "superseded", {
        superseded_by_revision_id: newRevision.id,
        rationale: action.rationale
      });
      appendEvent(state, newRevision, "authored", {
        reviewed_source_digest: newRevision.content.reviewed_source_digest,
        supersedes_revision_id: oldRevision.id
      });
      accept(
        state,
        action,
        `Superseded ${oldRevision.id} with ${newRevision.id}.`
      );
      return rememberMutation(state, action);
    }

    case "RETIRE_REVISION": {
      const checked = revisionPrecondition(state, action);
      if (checked.result) return checked.result;
      const revision = checked.revision;
      if (typeof action.rationale !== "string" || action.rationale.trim() === "") {
        return reject(
          state,
          action,
          "curated_revision_schema_invalid",
          "A retirement rationale is required."
        );
      }
      appendEvent(state, revision, "retired", {
        conflict_id: revision.pending_conflict?.id ?? null,
        conflict_digest: revision.pending_conflict?.digest ?? null,
        rationale: action.rationale
      });
      accept(state, action, `Retired ${revision.id}; history remains immutable.`);
      return rememberMutation(state, action);
    }

    default:
      return reject(state, action, "unknown_action", action.type);
  }
}
