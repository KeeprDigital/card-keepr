/** @param {unknown} value */
function quote(value) {
  return value === null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;
}

// The compiler owns this closed state machine; SQL compares the live source
// state so a stale or replayed phase cannot skip a stage or mutate a terminal row.
const sources = {
  preflight: ["requested"],
  migrating: ["preflight"],
  deploying: ["migrating"],
  smoke_testing: ["deploying"],
  succeeded: ["smoke_testing"],
  failed: ["requested", "preflight", "migrating", "deploying", "smoke_testing"],
};
/**
 * @param {string} releaseId
 * @param {keyof typeof sources} target
 * @param {{apiVersionId?: string, ingestionVersionId?: string, evidenceJson?: string, rollForwardRequired?: boolean}} [facts]
 * @param {string} [condition]
 */
export function productionReleaseTransitionSql(releaseId, target, facts = {}, condition = "1") {
  if (!Object.hasOwn(sources, target)) throw new Error("illegal production release transition");
  const assignments = [`state=${quote(target)}`];
  if (target === "deploying")
    assignments.push(
      `api_version_id=${quote(facts.apiVersionId)}`,
      `ingestion_version_id=${quote(facts.ingestionVersionId)}`,
    );
  if (target === "smoke_testing") assignments.push(`binding_observation_json=${quote(facts.evidenceJson)}`);
  if (target === "succeeded") assignments.push(`smoke_evidence_json=${quote(facts.evidenceJson)}`);
  if (target === "succeeded" || target === "failed")
    assignments.push("terminal_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  if (target === "failed")
    assignments.push(
      `roll_forward_required=CASE WHEN state IN ('migrating','deploying','smoke_testing') AND ${facts.rollForwardRequired ? 1 : 0} <> 1 THEN json_extract('{}', 'roll_forward_required') ELSE ${facts.rollForwardRequired ? 1 : 0} END`,
      "failure_code='production_release_failed'",
      "failure_detail='Inspect the GitHub run and continue with a compatible roll-forward.'",
    );
  return `UPDATE production_releases SET ${assignments.join(",")} WHERE id=${quote(releaseId)} AND state IN (${sources[target].map(quote).join(",")}) AND (${condition});`;
}

/** @param {string | null} releaseId @param {string | null} expiresAt */
export function productionReleaseLeaseAssignmentsSql(releaseId, expiresAt) {
  const identity = quote(releaseId);
  const expiry = quote(expiresAt);
  return `active_production_release_id=${identity},active_production_release_expires_at=CASE WHEN (${identity} IS NULL) <> (${expiry} IS NULL) OR (${expiry} IS NOT NULL AND (${expiry} NOT GLOB '????-??-??T??:??:??.???Z' OR julianday(${expiry}) IS NULL)) THEN json_extract('{}', 'production_release_lease_invalid') ELSE ${expiry} END`;
}

// Generated outcomes carry no claim token/version. Any existing claim therefore
// belongs to another writer. Evaluate inside the INSERT so zero-row SELECTs stay
// no-ops and rejection cannot leave a partial outcome or overwrite changes().
/** @param {string} idempotencyKey @param {string | null} [createdAt] */
export function productionReleaseOutcomeTimestampSql(idempotencyKey, createdAt = null) {
  const timestamp = createdAt === null ? "strftime('%Y-%m-%dT%H:%M:%fZ','now')" : quote(createdAt);
  return `CASE WHEN EXISTS (SELECT 1 FROM administration_idempotency_claims WHERE idempotency_key=${quote(idempotencyKey)}) THEN json_extract('{}', 'administration_idempotency_owner_changed') ELSE ${timestamp} END`;
}
