import {
  createInitialState,
  digest,
  proposalDigest,
  targetKey,
  transition
} from "./curated-revisions.mjs";

const sourceA = digest("official-source-value-a");
const sourceB = digest("official-source-value-b");
const sourceC = digest("official-source-value-c");
const observationDigest = digest("owner-reference");

const fieldProposal = {
  game: "one-piece",
  target: {
    kind: "field",
    entity_type: "card",
    entity_id: "card_demo_op01-001",
    path: "/effective_rules_text"
  },
  assertion: {
    kind: "field",
    value: "Synthetic corrected rules text."
  },
  rationale: "Synthetic prototype correction.",
  evidence: [
    { kind: "source_observation", id: "srcobs_demo_001" },
    {
      kind: "owner_reference",
      uri: "https://example.invalid/evidence",
      content_digest: observationDigest
    }
  ],
  effective_interval: { from: "2026-07-01", to: null },
  reviewed_source_digest: sourceA,
  supersedes_revision_id: null
};

const replacementProposal = {
  ...fieldProposal,
  assertion: {
    kind: "field",
    value: "Synthetic replacement rules text."
  },
  rationale: "Synthetic superseding correction.",
  reviewed_source_digest: sourceB,
  supersedes_revision_id: "currev_demo_001"
};

const overlappingProposal = {
  ...fieldProposal,
  rationale: "Synthetic overlapping correction."
};

const relationshipProposal = {
  game: "digimon",
  target: {
    kind: "relationship",
    relationship_kind: "printing-distribution-context",
    from: { type: "printing", id: "printing_demo_001" },
    to: { type: "distribution_context", id: "distribution_demo_001" }
  },
  assertion: {
    kind: "relationship",
    presence: "present"
  },
  rationale: "Synthetic relationship supplement.",
  evidence: [{ kind: "source_observation", id: "srcobs_demo_002" }],
  effective_interval: { from: null, to: null },
  reviewed_source_digest: sourceC,
  supersedes_revision_id: null
};

const productionBindings = {
  environment: "production",
  expected_current_revision_id: "catrev_demo_001"
};

function step(action, expected) {
  return { action, expected };
}

const createField = {
  type: "CREATE_REVISION",
  ...productionBindings,
  revision_id: "currev_demo_001",
  proposal: fieldProposal,
  proposal_digest: proposalDigest(fieldProposal),
  idempotency_key: "create-currev-demo-001"
};

const fieldTargetKey = targetKey(fieldProposal);
const replacementTargetKey = targetKey(replacementProposal);

const conflictId = "crconf_demo_002";
const conflictDigest = digest({
  conflict_id: conflictId,
  run_id: "run_source_changed",
  revision_id: "currev_demo_001",
  previous_source_digest: sourceA,
  observed_source_digest: sourceB
});

export const scenarios = [
  {
    key: "1",
    name: "Author and apply one Curated Revision",
    question:
      "Does a validated immutable proposal become active, pin into a run, and appear as curated candidate evidence?",
    initial: {},
    steps: [
      step(
        { type: "VALIDATE_PROPOSAL", proposal: fieldProposal },
        { accepted: true, code: "ok" }
      ),
      step(createField, { accepted: true, code: "ok" }),
      step(
        {
          type: "START_RUN",
          run_id: "run_apply",
          games: ["one-piece"],
          effective_on: "2026-07-28"
        },
        { accepted: true, code: "ok" }
      ),
      step(
        {
          type: "APPLY_CURATED_REVISIONS",
          run_id: "run_apply",
          source_digests: { [fieldTargetKey]: sourceA }
        },
        { accepted: true, code: "ok" }
      )
    ]
  },
  {
    key: "2",
    name: "Source change requires exact reaffirmation",
    question:
      "Does changed Official Source evidence fail the run, block the affected game, and require a conflict-bound owner decision?",
    initial: {},
    steps: [
      step(createField, { accepted: true, code: "ok" }),
      step(
        {
          type: "START_RUN",
          run_id: "run_source_changed",
          games: ["one-piece"]
        },
        { accepted: true, code: "ok" }
      ),
      step(
        {
          type: "APPLY_CURATED_REVISIONS",
          run_id: "run_source_changed",
          source_digests: { [fieldTargetKey]: sourceB }
        },
        { accepted: true, code: "ok" }
      ),
      step(
        {
          type: "START_RUN",
          run_id: "run_blocked",
          games: ["one-piece"]
        },
        {
          accepted: false,
          code: "curated_revision_attention_required"
        }
      ),
      step(
        {
          type: "REAFFIRM_REVISION",
          ...productionBindings,
          revision_id: "currev_demo_001",
          expected_event_version: 2,
          conflict_digest: digest("wrong-conflict"),
          rationale: "Synthetic owner review.",
          idempotency_key: "reaffirm-wrong-conflict"
        },
        {
          accepted: false,
          code: "curated_revision_conflict_digest_mismatch"
        }
      ),
      step(
        {
          type: "REAFFIRM_REVISION",
          ...productionBindings,
          revision_id: "currev_demo_001",
          expected_event_version: 2,
          conflict_digest: conflictDigest,
          rationale: "The correction remains required after reviewing the new source.",
          idempotency_key: "reaffirm-currev-demo-001"
        },
        { accepted: true, code: "ok" }
      ),
      step(
        {
          type: "START_RUN",
          run_id: "run_after_reaffirmation",
          linked_run_id: "run_source_changed",
          games: ["one-piece"]
        },
        { accepted: true, code: "ok" }
      ),
      step(
        {
          type: "APPLY_CURATED_REVISIONS",
          run_id: "run_after_reaffirmation",
          source_digests: { [fieldTargetKey]: sourceB }
        },
        { accepted: true, code: "ok" }
      )
    ]
  },
  {
    key: "3",
    name: "Supersession preserves both revisions",
    question:
      "Does changing an assertion create a new immutable Curated Revision while making the old one inapplicable?",
    initial: {},
    steps: [
      step(createField, { accepted: true, code: "ok" }),
      step(
        {
          type: "SUPERSEDE_REVISION",
          ...productionBindings,
          revision_id: "currev_demo_001",
          expected_event_version: 1,
          conflict_digest: null,
          new_revision_id: "currev_demo_002",
          proposal: replacementProposal,
          proposal_digest: proposalDigest(replacementProposal),
          rationale: "The asserted value changed.",
          idempotency_key: "supersede-currev-demo-001"
        },
        { accepted: true, code: "ok" }
      ),
      step(
        {
          type: "START_RUN",
          run_id: "run_replacement",
          games: ["one-piece"]
        },
        { accepted: true, code: "ok" }
      ),
      step(
        {
          type: "APPLY_CURATED_REVISIONS",
          run_id: "run_replacement",
          source_digests: { [replacementTargetKey]: sourceB }
        },
        { accepted: true, code: "ok" }
      )
    ]
  },
  {
    key: "4",
    name: "Retirement removes applicability, not history",
    question:
      "Does retirement leave the immutable record and events visible while later runs pin no assertion?",
    initial: {},
    steps: [
      step(createField, { accepted: true, code: "ok" }),
      step(
        {
          type: "RETIRE_REVISION",
          ...productionBindings,
          revision_id: "currev_demo_001",
          expected_event_version: 1,
          conflict_digest: null,
          rationale: "Official Source now supplies the accepted value.",
          idempotency_key: "retire-currev-demo-001"
        },
        { accepted: true, code: "ok" }
      ),
      step(
        {
          type: "START_RUN",
          run_id: "run_after_retirement",
          games: ["one-piece"]
        },
        { accepted: true, code: "ok" }
      ),
      step(
        {
          type: "APPLY_CURATED_REVISIONS",
          run_id: "run_after_retirement",
          source_digests: {}
        },
        { accepted: true, code: "ok" }
      )
    ]
  },
  {
    key: "5",
    name: "Stale, overlapping, and active-run mutations fail closed",
    question:
      "Do content, target, event-version, and ingestion concurrency guards prevent ambiguous or stale mutation?",
    initial: {},
    steps: [
      step(
        {
          ...createField,
          proposal_digest: digest("wrong-content"),
          idempotency_key: "create-wrong-content"
        },
        {
          accepted: false,
          code: "curated_revision_content_digest_mismatch"
        }
      ),
      step(createField, { accepted: true, code: "ok" }),
      step(
        {
          type: "CREATE_REVISION",
          ...productionBindings,
          revision_id: "currev_demo_overlap",
          proposal: overlappingProposal,
          proposal_digest: proposalDigest(overlappingProposal),
          idempotency_key: "create-overlap"
        },
        { accepted: false, code: "curated_revision_target_conflict" }
      ),
      step(
        {
          type: "START_RUN",
          run_id: "run_holds_lock",
          games: ["one-piece"]
        },
        { accepted: true, code: "ok" }
      ),
      step(
        {
          type: "RETIRE_REVISION",
          ...productionBindings,
          revision_id: "currev_demo_001",
          expected_event_version: 1,
          conflict_digest: null,
          rationale: "Should be blocked while run is active.",
          idempotency_key: "retire-during-run"
        },
        { accepted: false, code: "ingestion_not_idle" }
      ),
      step(
        {
          type: "FAIL_RUN",
          run_id: "run_holds_lock",
          failure_code: "synthetic"
        },
        { accepted: true, code: "ok" }
      ),
      step(
        {
          type: "RETIRE_REVISION",
          ...productionBindings,
          revision_id: "currev_demo_001",
          expected_event_version: 0,
          conflict_digest: null,
          rationale: "Stale owner view.",
          idempotency_key: "retire-stale"
        },
        {
          accepted: false,
          code: "curated_revision_event_version_mismatch"
        }
      )
    ]
  },
  {
    key: "6",
    name: "Idempotency is exact",
    question:
      "Does an identical retry return the original outcome while changed reuse of its key fails?",
    initial: {},
    steps: [
      step(createField, { accepted: true, code: "ok" }),
      step(createField, { accepted: true, code: "ok" }),
      step(
        {
          ...createField,
          revision_id: "currev_demo_changed",
          idempotency_key: "create-currev-demo-001"
        },
        { accepted: false, code: "idempotency_conflict" }
      )
    ]
  },
  {
    key: "7",
    name: "Production release blocks Curated Revision mutation",
    question:
      "Does a serialized production release prevent concurrent Curated Revision writes?",
    initial: { activeReleaseId: "release_demo_active" },
    steps: [
      step(createField, { accepted: false, code: "release_not_idle" })
    ]
  },
  {
    key: "8",
    name: "Active recovery blocks Curated Revision mutation",
    question:
      "Does blocked recovery prevent Curated Revision writes while degraded-but-idle recovery remains a separate approval concern?",
    initial: { recoveryHealth: "blocked" },
    steps: [
      step(createField, { accepted: false, code: "recovery_in_progress" })
    ]
  },
  {
    key: "9",
    name: "Relationship assertion uses the same lifecycle",
    question:
      "Can an exceptional canonical relationship be represented without turning owner evidence into an Official Source?",
    initial: {},
    steps: [
      step(
        {
          type: "CREATE_REVISION",
          ...productionBindings,
          revision_id: "currev_demo_relationship",
          proposal: relationshipProposal,
          proposal_digest: proposalDigest(relationshipProposal),
          idempotency_key: "create-currev-relationship"
        },
        { accepted: true, code: "ok" }
      ),
      step(
        {
          type: "START_RUN",
          run_id: "run_relationship",
          games: ["digimon"]
        },
        { accepted: true, code: "ok" }
      ),
      step(
        {
          type: "APPLY_CURATED_REVISIONS",
          run_id: "run_relationship",
          source_digests: {
            [targetKey(relationshipProposal)]: sourceC
          }
        },
        { accepted: true, code: "ok" }
      )
    ]
  }
];

export function runScenario(scenario) {
  let state = createInitialState(scenario.initial);
  const outcomes = [];
  for (const { action, expected } of scenario.steps) {
    state = transition(state, action);
    const actual = {
      accepted: state.last_transition.accepted,
      code: state.last_transition.code
    };
    outcomes.push({
      action: action.type,
      expected,
      actual,
      matches: actual.accepted === expected.accepted && actual.code === expected.code
    });
  }
  return { state, outcomes };
}
