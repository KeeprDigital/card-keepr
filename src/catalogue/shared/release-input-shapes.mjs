/** Wire-safe release identities shared by server validation and workflow decoding. */
export const isReleaseIdentity = (value) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:@|-]{0,255}$/u.test(value);
export const isReleaseDigest = (value) => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
export const isReleaseHead = (value) => typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
export const isReleaseActor = (value) =>
  typeof value === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\[bot\]$/u.test(value);
/**
 * The production_release dispatch inputs a production promotion returns (#238),
 * which staging-deploy.yml passes unchanged to the reusable production-release.yml.
 */
export const promotionDispatchInputNames = Object.freeze([
  "operation",
  "release_id",
  "expected_account_id",
  "expected_head_sha",
  "expected_actor",
  "idempotency_key",
  "dispatch_digest",
  "prepared_plan_json",
  "expected_current_revision",
  "expected_migration_level",
  "production_target_json",
  "production_target_digest",
  "bootstrap",
  "recovery_bookmark",
  "recovery_backup_attempt_id",
  "smoke_targets_json",
  "retained_revision_evidence_json",
  "replacement_recovery_id",
  "replacement_database_id",
  "retained_database_id",
  "replacement_target_digest",
]);
