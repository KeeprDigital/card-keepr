import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

const q = (value) => (value === null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`);
const hash = (text) => createHash("sha256").update(text).digest("hex");
const assertion = (condition) =>
  `SELECT CASE WHEN ${condition} THEN 1 ELSE json_extract('{}','fresh_baseline_guard_failed') END AS verified;`;

export const handoffPhases = Object.freeze({
  claimed: 1,
  baselineVerified: 2,
  transferred: 3,
  activationIntended: 4,
  bindingObserved: 5,
  accepted: 6,
});
const intentEvidenceIndex = handoffPhases.activationIntended - 2;
export function activationIntent(row) {
  return JSON.parse(row.evidence_json)[intentEvidenceIndex];
}
function executionId(environment) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_:.-]{0,255}$/.test(environment.HANDOFF_EXECUTION_ID ?? ""))
    throw new Error("fresh_baseline_execution_identity_missing");
  return environment.HANDOFF_EXECUTION_ID;
}
function correctionFence(environment) {
  const digest = environment.HANDOFF_CORRECTION_DIGEST;
  return digest
    ? `EXISTS(SELECT 1 FROM fresh_baseline_corrections WHERE handoff_dispatch_digest=${q(environment.DISPATCH_DIGEST)} AND correction_digest=${q(digest)} AND generation=(SELECT MAX(generation) FROM fresh_baseline_corrections WHERE handoff_dispatch_digest=${q(environment.DISPATCH_DIGEST)}))`
    : `NOT EXISTS(SELECT 1 FROM fresh_baseline_corrections WHERE handoff_dispatch_digest=${q(environment.DISPATCH_DIGEST)})`;
}
function leaseFence(environment) {
  const plan = handoffPlan(environment);
  return `${correctionFence(environment)} AND execution_id=${q(executionId(environment))} AND EXISTS(SELECT 1 FROM operation_state WHERE active_production_release_id=${q(plan.release_id)} AND active_production_release_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
}
export function renewHandoffSql(environment, role) {
  const identity = exact(environment, role);
  const plan = handoffPlan(environment);
  return `UPDATE fresh_baseline_handoffs SET execution_id=${q(executionId(environment))} WHERE ${identity} AND ${correctionFence(environment)};
 UPDATE operation_state SET active_production_release_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+45 minutes') WHERE active_production_release_id=${q(plan.release_id)} AND EXISTS(SELECT 1 FROM fresh_baseline_handoffs WHERE ${identity} AND execution_id=${q(executionId(environment))});
 ${assertion(`EXISTS(SELECT 1 FROM fresh_baseline_handoffs WHERE ${identity} AND ${leaseFence(environment)})`)}`;
}

/** The same server-confirmed bytes authenticate every two-D1 phase. */
export function handoffPlan(environment) {
  const plan = JSON.parse(environment.PREPARED_PLAN_JSON);
  const fresh = plan.fresh_baseline_handoff;
  if (
    !fresh ||
    Object.keys(fresh).sort().join("|") !==
      "baseline_sha256|destination_database_id|destination_migration_level|scope" ||
    !/^[0-9a-f]{64}$/.test(fresh.baseline_sha256) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/.test(fresh.destination_database_id) ||
    fresh.destination_migration_level !== 1 ||
    fresh.scope !== "fresh_database_regeneration" ||
    plan.replacement_handoff !== null ||
    plan.production_target.d1_databases.some((database) => database.id === fresh.destination_database_id) ||
    hash(environment.PREPARED_PLAN_JSON) !== environment.DISPATCH_DIGEST
  )
    throw new Error("invalid_fresh_baseline_plan");
  return plan;
}

function exact(environment, role) {
  const plan = handoffPlan(environment);
  return `release_id=${q(plan.release_id)} AND role=${q(role)} AND dispatch_digest=${q(environment.DISPATCH_DIGEST)} AND request_json=${q(environment.PREPARED_PLAN_JSON)}`;
}

export function handoffReadSql(environment, role) {
  return `SELECT * FROM fresh_baseline_handoffs WHERE ${exact(environment, role)};`;
}

export async function compileHandoffClaim(environment, directory) {
  const plan = handoffPlan(environment);
  const claim = await readFile(`${directory}/claim.sql`, "utf8");
  const prepared = `SELECT response_json FROM administration_idempotency WHERE idempotency_key=${q(plan.idempotency_key)} AND operation='prepare_production_release' AND request_json=${q(environment.PREPARED_PLAN_JSON)}`;
  const owns = `EXISTS(SELECT 1 FROM operation_state WHERE active_production_release_id=${q(plan.release_id)} AND active_production_release_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
  // Runs in one D1 query transaction: no new ticket can enter after quiescence.
  await writeFile(
    `${directory}/fresh-claim.sql`,
    `${claim}\n${assertion(owns)}
INSERT INTO fresh_baseline_handoffs(release_id,role,dispatch_digest,execution_id,request_json,preparation_json,phase,evidence_json,created_at)
VALUES(${q(plan.release_id)},'source',${q(environment.DISPATCH_DIGEST)},${q(executionId(environment))},${q(environment.PREPARED_PLAN_JSON)},(${prepared}),1,'[]',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
${assertion(`EXISTS(SELECT 1 FROM fresh_baseline_handoffs WHERE ${exact(environment, "source")} AND phase=1)`)}`,
  );
}

/** No catalogue, recovery operation, migration ledger or identity is fabricated. */
export function transferSql(environment, source) {
  const plan = handoffPlan(environment);
  if (
    source?.role !== "source" ||
    source.phase !== 2 ||
    source.release_id !== plan.release_id ||
    source.dispatch_digest !== environment.DISPATCH_DIGEST ||
    source.request_json !== environment.PREPARED_PLAN_JSON
  )
    throw new Error("invalid_fresh_baseline_source");
  const preparation = JSON.parse(source.preparation_json);
  if (
    preparation.contract !== "card-keepr-production-release-request@1" ||
    preparation.dispatch_digest !== environment.DISPATCH_DIGEST ||
    preparation.prepared_plan_json !== environment.PREPARED_PLAN_JSON ||
    preparation.release_id !== plan.release_id
  )
    throw new Error("invalid_fresh_baseline_preparation");
  const identity = exact(environment, "destination");
  return `${assertion(`EXISTS(SELECT 1 FROM catalogue_schema_state WHERE migration_level=1) AND EXISTS(SELECT 1 FROM catalogue_state WHERE current_revision_id='catrev_spine_000') AND NOT EXISTS(SELECT 1 FROM catalogue_revisions) AND NOT EXISTS(SELECT 1 FROM ingestion_runs)`)}
INSERT INTO administration_idempotency(idempotency_key,operation,request_json,response_json,http_status,outcome,created_at)
VALUES(${q(plan.idempotency_key)},'prepare_production_release',${q(source.request_json)},${q(source.preparation_json)},201,'success',${q(source.created_at)});
UPDATE operation_state SET active_production_release_id=${q(plan.release_id)},active_production_release_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+45 minutes') WHERE singleton=1 AND active_production_release_id IS NULL;
${assertion(`EXISTS(SELECT 1 FROM operation_state WHERE active_production_release_id=${q(plan.release_id)})`)}
INSERT INTO fresh_baseline_handoffs(release_id,role,dispatch_digest,execution_id,request_json,preparation_json,phase,evidence_json,created_at)
VALUES(${q(plan.release_id)},'destination',${q(source.dispatch_digest)},${q(executionId(environment))},${q(source.request_json)},${q(source.preparation_json)},1,'[]',${q(source.created_at)});
UPDATE fresh_baseline_handoffs SET phase=2,evidence_json=${q(source.evidence_json)} WHERE ${identity} AND phase=1;
${assertion(`EXISTS(SELECT 1 FROM fresh_baseline_handoffs WHERE ${identity} AND phase=2)`)}`;
}

export function phaseSql(environment, role, from, evidence) {
  if (
    !["source", "destination"].includes(role) ||
    !Number.isInteger(from) ||
    from < 1 ||
    from > 5 ||
    evidence === null ||
    typeof evidence !== "object"
  )
    throw new Error("invalid_fresh_baseline_phase");
  const identity = exact(environment, role);
  const encoded = JSON.stringify(evidence);
  return `UPDATE fresh_baseline_handoffs SET phase=${from + 1},evidence_json=json_insert(evidence_json,'$[#]',json(${q(encoded)})) WHERE ${identity} AND phase=${from} AND ${leaseFence(environment)};
${assertion(`EXISTS(SELECT 1 FROM fresh_baseline_handoffs WHERE ${identity} AND phase=${from + 1} AND ${leaseFence(environment)} AND json_extract(evidence_json,'$[#-1]')=json(${q(encoded)}))`)}`;
}

export function destinationReleaseSql(environment, source) {
  if (
    source?.role !== "source" ||
    source.phase !== 6 ||
    source.request_json !== environment.PREPARED_PLAN_JSON ||
    source.dispatch_digest !== environment.DISPATCH_DIGEST
  )
    throw new Error("source_not_retired");
  const plan = handoffPlan(environment);
  return `${phaseSql(environment, "destination", 5, { source_retired: source })}
UPDATE operation_state SET active_production_release_id=NULL,active_production_release_expires_at=NULL WHERE singleton=1 AND active_production_release_id=${q(plan.release_id)};
${assertion(`NOT EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence) AND EXISTS(SELECT 1 FROM operation_state WHERE active_production_release_id IS NULL)`)}`;
}

/** Baseline proof is executable against the exact bytes on an empty local D1. */
export async function baselineBytes(environment, path) {
  const plan = handoffPlan(environment);
  const bytes = await readFile(path);
  if (hash(bytes) !== plan.fresh_baseline_handoff.baseline_sha256) throw new Error("fresh_baseline_digest_mismatch");
  return bytes;
}

export function assertExactPhase(actual, expected) {
  if (!isDeepStrictEqual(actual, expected)) throw new Error("fresh_baseline_replay_conflict");
}

export function cancellationReadSql(environment) {
  return `SELECT response_json FROM fresh_baseline_cancellations WHERE dispatch_digest=${q(environment.DISPATCH_DIGEST)};`;
}
export function cancellationSql(environment, role, evidence) {
  if (!["source", "destination"].includes(role) || evidence?.source_still_active !== true)
    throw new Error("fresh_baseline_cancellation_unobserved");
  const authorized =
    role === "source"
      ? `AND EXISTS(SELECT 1 FROM fresh_baseline_cancellations WHERE dispatch_digest=${q(environment.DISPATCH_DIGEST)})`
      : "";
  const identity = exact(environment, role);
  const plan = handoffPlan(environment);
  return `UPDATE fresh_baseline_handoffs SET phase=7,evidence_json=json_insert(evidence_json,'$[#]',json(${q(JSON.stringify(evidence))})) WHERE ${identity} AND phase<4 AND ${leaseFence(environment)} ${authorized};
${assertion(`EXISTS(SELECT 1 FROM fresh_baseline_handoffs WHERE ${identity} AND phase=7)`)}
${role === "source" ? `UPDATE operation_state SET active_production_release_id=NULL,active_production_release_expires_at=NULL WHERE active_production_release_id=${q(plan.release_id)};` : ""}`;
}
