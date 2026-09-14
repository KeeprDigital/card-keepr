import assert from "node:assert/strict";
import test from "node:test";

test("server-owned transition scope rejects omitted mandatory checks and incomplete success", async () => {
  const { stagingValidationRequirements, selectStagingValidation, validateStagingOutcome } =
    await import("../src/catalogue/shared/staging-validation.mjs");
  assert.deepEqual(stagingValidationRequirements("full"), [
    "exact-commit-ci",
    "migration-rehearsal",
    "retained-source-rehearsal",
    "live-smoke",
  ]);
  for (const scope of ["smoke", "none", null])
    assert.throws(() => stagingValidationRequirements(scope), /invalid_staging_validation_scope/u);
  assert.equal(selectStagingValidation(null).reason, "unknown_transition");
  assert.equal(selectStagingValidation(["docs/runbooks/maintenance.md"]).scope, "routine");
  assert.equal(selectStagingValidation(["src/catalogue/backup-recovery/recovery.ts"]).scope, "recovery");
  assert.equal(selectStagingValidation(["src/catalogue/adapters/source-adapters.ts"]).scope, "sources");
  assert.equal(selectStagingValidation(["src/catalogue/shared/types.ts"]).scope, "full");
  assert.equal(selectStagingValidation(["future-module.ts"]).scope, "full");
  const intent = {
    expected_head_sha: "a".repeat(40),
    validation_scope: "full",
    production_start: { migration_level: 31 },
  };
  const result = {
    contract: "card-keepr-staging-outcome@1",
    intent_digest: "c".repeat(64),
    expected_head_sha: "a".repeat(40),
    state: "succeeded",
    deployment: { state: "succeeded", release_id: "staging-237", dispatch_digest: "d".repeat(64) },
    migration: { state: "succeeded", starting_level: 31, ending_level: 32, migration_digest: "f".repeat(64) },
    checks: ["exact-commit-ci", "migration-rehearsal", "retained-source-rehearsal", "live-smoke"].map((name) => ({
      name,
      state: "succeeded",
      evidence_sha256: "f".repeat(64),
    })),
    failure_code: null,
  };
  assert.equal(validateStagingOutcome(result, intent, "c".repeat(64)).state, "succeeded");
  for (const changed of [
    { expected_head_sha: "b".repeat(40) },
    { checks: result.checks.slice(1) },
    { checks: result.checks.map((check) => ({ ...check, state: "pending" })) },
    { migration: { ...result.migration, starting_level: 32 } },
    { migration: { ...result.migration, migration_digest: "e".repeat(64) } },
    { state: "failed", failure_code: "rehearsal_failed", migration: { ...result.migration, state: "failed" } },
    { deployment: { ...result.deployment, state: "requested" } },
  ])
    assert.throws(() => validateStagingOutcome({ ...result, ...changed }, intent, "c".repeat(64)));
});
