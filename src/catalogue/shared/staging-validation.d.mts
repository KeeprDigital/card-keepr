export type StagingOutcome = {
  contract: "card-keepr-staging-outcome@1";
  intent_digest: string;
  expected_head_sha: string;
  state: "succeeded" | "failed";
  deployment: { state: "succeeded" | "failed" | "not_run"; release_id: string; dispatch_digest: string | null };
  migration: {
    state: "succeeded" | "failed" | "not_run";
    starting_level: number;
    ending_level: number;
    migration_digest: string | null;
  };
  checks: Array<{ name: string; state: "succeeded" | "failed" | "not_run"; evidence_sha256: string | null }>;
  failure_code: string | null;
};
export const stagingValidationChecks: readonly ["exact-commit-ci", "migration-rehearsal", "live-smoke"];
export function validateStagingOutcome(
  value: unknown,
  intent: {
    expected_head_sha: string;
    required_checks: readonly string[];
    production_start: { migration_level: number };
  },
  intentDigest: string,
): StagingOutcome;
