import { isReleaseDigest, isReleaseHead, isReleaseIdentity } from "./release-input-shapes.mjs";

const scenarios = {
  routine: [],
  recovery: ["composed-recovery"],
  sources: ["one-piece-two-source", "riftbound-catalogue"],
  full: ["composed-recovery", "one-piece-two-source", "riftbound-catalogue"],
};

export function stagingValidationScenarios(scope) {
  if (!Object.hasOwn(scenarios, scope)) throw new Error("invalid_staging_validation_scope");
  return [...scenarios[scope]];
}

export function stagingValidationRequirements(scope) {
  return [
    "exact-commit-ci",
    "migration-rehearsal",
    ...(stagingValidationScenarios(scope).length ? ["retained-source-rehearsal"] : []),
    "live-smoke",
  ];
}

/** Call only with complete, provider-verified starting-to-selected paths, including rename sources. */
export function selectStagingValidation(paths) {
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string"))
    return { scope: "full", reason: "unknown_transition" };
  const families = new Set();
  for (const path of paths) {
    if (/^src\/catalogue\/backup-recovery\//u.test(path)) families.add("recovery");
    else if (/^src\/catalogue\/(?:adapters|source-evidence)\//u.test(path)) families.add("sources");
    else if (/^(?:docs\/|README\.md$|cli\/|acceptance\/|test\/|apps\/(?:api|ingestion)\/test\/)/u.test(path)) continue;
    else return { scope: "full", reason: "shared_or_unclassified_change" };
  }
  const scope = families.size > 1 ? "full" : ([...families][0] ?? "routine");
  return { scope, reason: "verified_transition" };
}

/** Deployment acknowledgement alone is never a staging validation result. */
export function validateStagingOutcome(value, intent, intentDigest) {
  const invalid = () => {
    throw new Error("invalid_staging_outcome");
  };
  const fields = [
    "contract",
    "intent_digest",
    "expected_head_sha",
    "state",
    "deployment",
    "migration",
    "checks",
    "failure_code",
  ];
  if (
    !exactKeys(value, fields) ||
    value.contract !== "card-keepr-staging-outcome@1" ||
    !isReleaseDigest(value.intent_digest) ||
    value.intent_digest !== intentDigest ||
    !isReleaseHead(value.expected_head_sha) ||
    value.expected_head_sha !== intent.expected_head_sha ||
    !["succeeded", "failed"].includes(value.state)
  )
    invalid();
  const required = stagingValidationRequirements(intent.validation_scope);
  if (
    !Array.isArray(value.checks) ||
    value.checks.length !== required.length ||
    value.checks.some(
      (check, index) =>
        !exactKeys(check, ["name", "state", "evidence_sha256"]) ||
        check.name !== required[index] ||
        !["succeeded", "failed", "not_run"].includes(check.state) ||
        (check.state === "not_run" ? check.evidence_sha256 !== null : !isReleaseDigest(check.evidence_sha256)),
    )
  )
    invalid();
  const deployment = value.deployment;
  if (
    !exactKeys(deployment, ["state", "release_id", "dispatch_digest"]) ||
    !["succeeded", "failed", "not_run"].includes(deployment.state) ||
    !isReleaseIdentity(deployment.release_id) ||
    (deployment.state === "not_run"
      ? deployment.dispatch_digest !== null
      : !isReleaseDigest(deployment.dispatch_digest))
  )
    invalid();
  const migration = value.migration;
  if (
    !exactKeys(migration, ["state", "starting_level", "ending_level", "migration_digest"]) ||
    !["succeeded", "failed", "not_run"].includes(migration.state) ||
    migration.starting_level !== intent.production_start.migration_level ||
    !Number.isSafeInteger(migration.ending_level) ||
    migration.ending_level < migration.starting_level ||
    (migration.state === "not_run" ? migration.migration_digest !== null : !isReleaseDigest(migration.migration_digest))
  )
    invalid();
  const migrationCheck = value.checks.find((check) => check.name === "migration-rehearsal");
  if (migration.state !== migrationCheck.state || migration.migration_digest !== migrationCheck.evidence_sha256)
    invalid();
  if (value.state === "succeeded") {
    if (
      value.failure_code !== null ||
      deployment.state !== "succeeded" ||
      migration.state !== "succeeded" ||
      value.checks.some((check) => check.state !== "succeeded")
    )
      invalid();
  } else if (typeof value.failure_code !== "string" || !/^[a-z][a-z0-9_]{0,127}$/u.test(value.failure_code)) invalid();
  return value;
}

function exactKeys(value, fields) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("|") === [...fields].sort().join("|")
  );
}
