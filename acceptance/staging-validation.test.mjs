import assert from "node:assert/strict";
import test from "node:test";

test("staging requires exactly exact-commit CI, migration rehearsal and live smoke, and rejects incomplete success", async () => {
  const validation = await import("../src/catalogue/shared/staging-validation.mjs");
  const { stagingValidationChecks, validateStagingOutcome } = validation;
  // Extended scenarios are a per-commit CI record (#238), never a release-time staging check.
  assert.deepEqual(stagingValidationChecks, ["exact-commit-ci", "migration-rehearsal", "live-smoke"]);
  assert.ok(Object.isFrozen(stagingValidationChecks));
  assert.equal(validation.selectStagingValidation, undefined);
  const intent = {
    expected_head_sha: "a".repeat(40),
    required_checks: [...stagingValidationChecks],
    production_start: { migration_level: 31 },
  };
  const result = {
    contract: "card-keepr-staging-outcome@1",
    intent_digest: "c".repeat(64),
    expected_head_sha: "a".repeat(40),
    state: "succeeded",
    deployment: { state: "succeeded", release_id: "staging-237", dispatch_digest: "d".repeat(64) },
    migration: { state: "succeeded", starting_level: 31, ending_level: 32, migration_digest: "f".repeat(64) },
    checks: stagingValidationChecks.map((name) => ({ name, state: "succeeded", evidence_sha256: "f".repeat(64) })),
    failure_code: null,
  };
  assert.equal(validateStagingOutcome(result, intent, "c".repeat(64)).state, "succeeded");
  for (const changed of [
    { expected_head_sha: "b".repeat(40) },
    { checks: result.checks.slice(1) },
    {
      checks: [
        ...result.checks,
        { name: "retained-source-rehearsal", state: "succeeded", evidence_sha256: "f".repeat(64) },
      ],
    },
    { checks: result.checks.map((check) => ({ ...check, state: "pending" })) },
    { migration: { ...result.migration, starting_level: 32 } },
    { migration: { ...result.migration, migration_digest: "e".repeat(64) } },
    { state: "failed", failure_code: "rehearsal_failed", migration: { ...result.migration, state: "failed" } },
    { deployment: { ...result.deployment, state: "requested" } },
  ])
    assert.throws(() => validateStagingOutcome({ ...result, ...changed }, intent, "c".repeat(64)));
  // A retained intent from the classifier era demanded the replay; no outcome can satisfy it now.
  const classified = {
    ...intent,
    required_checks: ["exact-commit-ci", "migration-rehearsal", "retained-source-rehearsal", "live-smoke"],
  };
  assert.throws(() => validateStagingOutcome(result, classified, "c".repeat(64)), /invalid_staging_outcome/u);
});
