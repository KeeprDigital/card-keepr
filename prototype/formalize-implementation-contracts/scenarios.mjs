const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const digestC = "c".repeat(64);

const startAndReachCandidate = (runId = "run_demo_002") => [
  {
    type: "START_RUN",
    run_id: runId,
    games: ["digimon", "gundam", "one-piece", "fusion-world"],
    expected_current_revision_id: "catrev_demo_001",
    idempotency_key: `start-${runId}`
  },
  { type: "ADVANCE_RUN", run_id: runId, to: "collecting" },
  { type: "ADVANCE_RUN", run_id: runId, to: "parsing" },
  { type: "ADVANCE_RUN", run_id: runId, to: "reconciling" },
  { type: "CANDIDATE_READY", run_id: runId, candidate_digest: digestA }
];

export const scenarios = [
  {
    key: "1",
    name: "Atomic publication and verified backup",
    question:
      "Can exact approval publish Catalogue Data and its verified Export together, then gate the next approval until backup verification?",
    actions: [
      ...startAndReachCandidate(),
      {
        type: "APPROVE_RUN",
        run_id: "run_demo_002",
        candidate_digest: digestA,
        expected_current_revision_id: "catrev_demo_001"
      },
      {
        type: "PUBLISH_SUCCEEDED",
        run_id: "run_demo_002",
        previous_revision_id: "catrev_demo_001",
        catalogue_revision_id: "catrev_demo_002",
        export_verified: true,
        export_manifest_digest: digestB,
        backup_attempt_id: "backup_demo_002a"
      },
      { type: "ADVANCE_BACKUP", backup_attempt_id: "backup_demo_002a", to: "exporting" },
      {
        type: "ADVANCE_BACKUP",
        backup_attempt_id: "backup_demo_002a",
        to: "restoring_verification"
      },
      { type: "ADVANCE_BACKUP", backup_attempt_id: "backup_demo_002a", to: "verifying" },
      {
        type: "ADVANCE_BACKUP",
        backup_attempt_id: "backup_demo_002a",
        to: "verified",
        manifest_digest: digestC
      }
    ]
  },
  {
    key: "2",
    name: "Seven-day candidate expiry",
    question:
      "Does an unapproved candidate expire at the deadline, release the lock, and reject late approval?",
    actions: [
      ...startAndReachCandidate("run_expiring"),
      {
        type: "TICK",
        at: Date.parse("2026-08-04T00:00:00.000Z")
      },
      {
        type: "APPROVE_RUN",
        run_id: "run_expiring",
        candidate_digest: digestA,
        expected_current_revision_id: "catrev_demo_001"
      },
      {
        type: "RETRY_RUN",
        source_run_id: "run_expiring",
        new_run_id: "run_after_expiry",
        idempotency_key: "retry-run-after-expiry"
      }
    ]
  },
  {
    key: "3",
    name: "Stale approval fails closed",
    question:
      "Do a stale candidate digest and stale expected Catalogue Revision both fail without mutating the candidate?",
    actions: [
      ...startAndReachCandidate("run_stale"),
      {
        type: "APPROVE_RUN",
        run_id: "run_stale",
        candidate_digest: digestB,
        expected_current_revision_id: "catrev_demo_001"
      },
      {
        type: "APPROVE_RUN",
        run_id: "run_stale",
        candidate_digest: digestA,
        expected_current_revision_id: "catrev_demo_000"
      },
      {
        type: "APPROVE_RUN",
        run_id: "run_stale",
        candidate_digest: digestA,
        expected_current_revision_id: "catrev_demo_001"
      }
    ]
  },
  {
    key: "4",
    name: "Mutation gates",
    question:
      "Are release dispatch and later approval blocked by active ingestion or degraded recovery?",
    actions: [
      {
        type: "START_RUN",
        run_id: "run_gate",
        games: ["one-piece"],
        expected_current_revision_id: "catrev_demo_001",
        idempotency_key: "start-run-gate"
      },
      {
        type: "REQUEST_RELEASE",
        release_id: "release_blocked",
        environment: "production",
        expected_current_revision_id: "catrev_demo_001",
        workflow_dispatch_id: "dispatch_blocked"
      },
      { type: "ADVANCE_RUN", run_id: "run_gate", to: "failed", failure_code: "synthetic" },
      {
        type: "REQUEST_RELEASE",
        release_id: "release_allowed",
        environment: "production",
        expected_current_revision_id: "catrev_demo_001",
        workflow_dispatch_id: "dispatch_allowed"
      },
      { type: "ADVANCE_RELEASE", release_id: "release_allowed", to: "preflight" },
      { type: "ADVANCE_RELEASE", release_id: "release_allowed", to: "migrating" },
      { type: "ADVANCE_RELEASE", release_id: "release_allowed", to: "deploying" },
      { type: "ADVANCE_RELEASE", release_id: "release_allowed", to: "smoke_testing" },
      { type: "ADVANCE_RELEASE", release_id: "release_allowed", to: "succeeded" }
    ]
  },
  {
    key: "5",
    name: "Recovery blocks mutation",
    question:
      "Does recovery hold a global mutation block until digest validation and explicit owner acceptance?",
    actions: [
      {
        type: "BEGIN_RECOVERY",
        recovery_id: "recovery_demo",
        target_revision_id: "catrev_demo_001",
        target_digest: digestC
      },
      {
        type: "START_RUN",
        run_id: "run_during_recovery",
        games: ["gundam"],
        expected_current_revision_id: "catrev_demo_001",
        idempotency_key: "blocked-during-recovery"
      },
      { type: "ADVANCE_RECOVERY", recovery_id: "recovery_demo", to: "restoring" },
      { type: "ADVANCE_RECOVERY", recovery_id: "recovery_demo", to: "validating" },
      {
        type: "ADVANCE_RECOVERY",
        recovery_id: "recovery_demo",
        to: "awaiting_acceptance",
        verified_target_digest: digestB
      },
      {
        type: "ADVANCE_RECOVERY",
        recovery_id: "recovery_demo",
        to: "awaiting_acceptance",
        verified_target_digest: digestC
      },
      {
        type: "ADVANCE_RECOVERY",
        recovery_id: "recovery_demo",
        to: "accepted",
        expected_restored_revision_id: "catrev_demo_001"
      }
    ]
  },
  {
    key: "6",
    name: "Credential replacement before revocation",
    question:
      "Can the old credential be revoked only after the replacement passes its owning boundary's harmless probe?",
    actions: [
      {
        type: "BEGIN_CREDENTIAL_ROTATION",
        rotation_id: "rotation_admin_key",
        credential_class: "ingestion_admin_key",
        old_fingerprint: "sha256:old-demo",
        replacement_fingerprint: "sha256:new-demo"
      },
      {
        type: "ADVANCE_CREDENTIAL_ROTATION",
        rotation_id: "rotation_admin_key",
        to: "old_revoked",
        old_fingerprint: "sha256:old-demo"
      },
      {
        type: "ADVANCE_CREDENTIAL_ROTATION",
        rotation_id: "rotation_admin_key",
        to: "replacement_verified"
      },
      {
        type: "ADVANCE_CREDENTIAL_ROTATION",
        rotation_id: "rotation_admin_key",
        to: "old_revoked",
        old_fingerprint: "sha256:wrong"
      },
      {
        type: "ADVANCE_CREDENTIAL_ROTATION",
        rotation_id: "rotation_admin_key",
        to: "old_revoked",
        old_fingerprint: "sha256:old-demo"
      }
    ]
  }
];
