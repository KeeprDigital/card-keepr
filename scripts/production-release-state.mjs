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

export function productionReleaseLeaseAssignmentsSql(releaseId, expiresAt) {
  const identity = quote(releaseId);
  const expiry = quote(expiresAt);
  return `active_production_release_id=${identity},active_production_release_expires_at=CASE WHEN (${identity} IS NULL) <> (${expiry} IS NULL) OR (${expiry} IS NOT NULL AND (${expiry} NOT GLOB '????-??-??T??:??:??.???Z' OR julianday(${expiry}) IS NULL)) THEN json_extract('{}', 'production_release_lease_invalid') ELSE ${expiry} END`;
}
