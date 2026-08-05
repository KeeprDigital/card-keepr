#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export function assertReleaseInputs(input) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(input.releaseId ?? "") ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(input.expectedRevision ?? "") ||
      !/^[0-9a-f]{40}$/.test(input.expectedHeadSha ?? "") ||
      !/^[0-9a-f]{64}$/.test(input.productionTargetDigest ?? "") ||
      !Number.isSafeInteger(input.expectedMigrationLevel) || input.expectedMigrationLevel < 1) {
    throw new Error("invalid_release_input");
  }
  return input;
}

export async function writeReplacementConfigs(databaseId, apiOutput, ingestionOutput) {
  if (!/^[0-9a-f-]{36}$/.test(databaseId) && !/^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/.test(databaseId)) throw new Error("invalid_replacement_database_id");
  await Promise.all([
    replaceDatabase("apps/api/wrangler.jsonc", databaseId, apiOutput, false),
    replaceDatabase("apps/ingestion/wrangler.jsonc", databaseId, ingestionOutput, true),
  ]);
}

export async function validateDispatchAndWriteSql(environment, directory) {
  const json = (name) => {
    try { return JSON.parse(required(environment, name)); } catch { throw new Error(`invalid_${name.toLowerCase()}`); }
  };
  const replacementId = required(environment, "REPLACEMENT_RECOVERY_ID");
  const replacement = replacementId === "none" ? null : {
    recovery_id: opaque(replacementId),
    target_revision_id: opaque(required(environment, "EXPECTED_CURRENT_REVISION")),
    target_digest: digest(required(environment, "REPLACEMENT_TARGET_DIGEST")),
    replacement_database_id: opaque(required(environment, "REPLACEMENT_DATABASE_ID")),
    retained_database_id: opaque(required(environment, "RETAINED_DATABASE_ID")),
  };
  if (replacement !== null && replacement.replacement_database_id === replacement.retained_database_id) throw new Error("replacement_database_not_distinct");
  const plan = {
    expected_actor: bot(required(environment, "EXPECTED_ACTOR")),
    expected_current_revision_id: opaque(required(environment, "EXPECTED_CURRENT_REVISION")),
    expected_head_sha: head(required(environment, "EXPECTED_HEAD_SHA")),
    expected_migration_level: positiveInteger(required(environment, "EXPECTED_MIGRATION_LEVEL")),
    idempotency_key: opaque(required(environment, "IDEMPOTENCY_KEY")),
    production_target: json("PRODUCTION_TARGET_JSON"),
    production_target_digest: digest(required(environment, "PRODUCTION_TARGET_DIGEST")),
    recovery_backup_attempt_id: opaque(required(environment, "RECOVERY_BACKUP_ATTEMPT_ID")),
    recovery_bookmark: opaque(required(environment, "RECOVERY_BOOKMARK")),
    release_id: opaque(required(environment, "RELEASE_ID")),
    replacement_handoff: replacement,
    retained_revision_evidence: json("RETAINED_REVISION_EVIDENCE_JSON"),
    smoke_targets: json("SMOKE_TARGETS_JSON"),
  };
  if (!validReleaseEvidence(plan)) throw new Error("invalid_release_evidence");
  const targetJson = stableJson(plan.production_target);
  if (createHash("sha256").update(targetJson).digest("hex") !== plan.production_target_digest) throw new Error("production_target_digest_mismatch");
  if (stableJson(plan) !== stableJson(json("PREPARED_PLAN_JSON"))) throw new Error("prepared_plan_mismatch");
  if (createHash("sha256").update(stableJson(plan)).digest("hex") !== digest(required(environment, "DISPATCH_DIGEST"))) throw new Error("dispatch_digest_mismatch");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const q = sqlQuote;
  const expires = new Date(Date.now() + 45 * 60_000).toISOString();
  const bootstrap = `release-bootstrap|${expires}|${plan.release_id}`;
  const preparedWhere = `idempotency_key=${q(plan.idempotency_key)} AND operation='prepare_production_release' AND request_json=${q(stableJson(plan))} AND json_extract(response_json,'$.release_id')=${q(plan.release_id)} AND json_extract(response_json,'$.dispatch_digest')=${q(environment.DISPATCH_DIGEST)}`;
  const recoveryGate = replacement === null
    ? `operation.recovery_health='healthy' AND operation.active_recovery_id IS NULL`
    : `operation.recovery_health='blocked' AND operation.active_recovery_id=${q(replacement.recovery_id)} AND EXISTS (SELECT 1 FROM catalogue_recovery_operations AS recovery WHERE recovery.id=${q(replacement.recovery_id)} AND recovery.state='awaiting_acceptance' AND recovery.method='replacement_database' AND recovery.target_revision_id=${q(replacement.target_revision_id)} AND recovery.target_digest=${q(replacement.target_digest)} AND recovery.restored_database_id=${q(replacement.replacement_database_id)} AND recovery.retained_database_id=${q(replacement.retained_database_id)} AND recovery.verification_json IS NOT NULL)`;
  const expectedRetention = plan.retained_revision_evidence.map((item) => `(${q(item.revision_id)},${item.depth})`).join(",");
  const liveGate = `EXISTS (SELECT 1 FROM catalogue_state AS catalogue JOIN operation_state AS operation ON operation.singleton=1 JOIN catalogue_schema_state AS schema_state ON schema_state.singleton=1 WHERE catalogue.singleton=1 AND catalogue.current_revision_id=${q(plan.expected_current_revision_id)} AND schema_state.migration_level=${plan.expected_migration_level} AND operation.active_ingestion_run_id IS NULL AND (operation.active_release_id IS NULL OR operation.active_release_expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND ${recoveryGate} AND EXISTS (SELECT 1 FROM catalogue_backup_attempts AS backup WHERE backup.idempotency_key=${q(plan.recovery_backup_attempt_id)} AND backup.catalogue_revision_id=${q(plan.expected_current_revision_id)} AND backup.state='verified' AND backup.d1_bookmark=${q(plan.recovery_bookmark)} AND backup.manifest_sha256 IS NOT NULL) AND 3=(WITH RECURSIVE retained(revision_id,depth) AS (SELECT catalogue.current_revision_id,0 UNION ALL SELECT revision.expected_previous_revision_id,retained.depth+1 FROM retained JOIN catalogue_revisions AS revision ON revision.id=retained.revision_id WHERE retained.depth<2 AND revision.expected_previous_revision_id IS NOT NULL), expected(revision_id,depth) AS (VALUES ${expectedRetention}) SELECT COUNT(*) FROM retained JOIN expected USING (revision_id,depth) JOIN catalogue_exports AS export ON export.catalogue_revision_id=retained.revision_id WHERE export.verified=1 AND export.maintenance_state='available' AND EXISTS (SELECT 1 FROM catalogue_backup_attempts AS backup WHERE backup.catalogue_revision_id=retained.revision_id AND backup.state='verified' AND backup.d1_bookmark IS NOT NULL AND backup.manifest_sha256 IS NOT NULL)) AND EXISTS (SELECT 1 FROM catalogue_query_revisions WHERE catalogue_revision_id=${q(plan.smoke_targets.stale_revision_id)} AND state='archived'))`;
  const claimKey = `release-dispatch:${environment.DISPATCH_DIGEST}`;
  const migrationKey = `release-migration-started:${environment.DISPATCH_DIGEST}`;
  const durableClaim = `INSERT INTO administration_idempotency (idempotency_key,operation,request_json,response_json,http_status,outcome,created_at) SELECT ${q(claimKey)},'claim_production_release',request_json,${q(stableJson({ release_id: plan.release_id, state: "preflight", dispatch_digest: environment.DISPATCH_DIGEST }))},201,'success',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM administration_idempotency WHERE ${preparedWhere} AND ${liveGate};`;
  const claimedEvidence = `EXISTS (SELECT 1 FROM administration_idempotency WHERE idempotency_key=${q(claimKey)} AND operation='claim_production_release')`;
  const claim = replacement === null
    ? `INSERT OR IGNORE INTO ingestion_runs (id,state,selected_games_json,started_at,expected_current_revision_id,idempotency_key,candidate_json) SELECT ${q(bootstrap)},'planning','[]',strftime('%Y-%m-%dT%H:%M:%fZ','now'),${q(plan.expected_current_revision_id)},${q(bootstrap)},'{"production_release_bootstrap":true}' WHERE ${claimedEvidence} AND ${liveGate}; UPDATE operation_state SET active_ingestion_run_id=${q(bootstrap)} WHERE singleton=1 AND active_ingestion_run_id IS NULL AND recovery_health='healthy' AND ${claimedEvidence} AND ${liveGate};`
    : `UPDATE operation_state SET active_release_id=${q(plan.release_id)},active_release_expires_at=${q(expires)} WHERE singleton=1 AND active_ingestion_run_id IS NULL AND active_release_id IS NULL AND recovery_health='blocked' AND active_recovery_id=${q(replacement.recovery_id)} AND ${claimedEvidence} AND ${liveGate};`;
  await writeFile(`${directory}/live-preflight.sql`, `SELECT CASE WHEN EXISTS (SELECT 1 FROM administration_idempotency WHERE ${preparedWhere}) AND ${liveGate} THEN 1 ELSE 0 END AS ready;\n`, { mode: 0o600 });
  await writeFile(`${directory}/claim.sql`, `${durableClaim}\n${claim}\nSELECT changes() AS changed_rows, CASE WHEN ${replacement === null ? `active_ingestion_run_id=${q(bootstrap)}` : `active_release_id=${q(plan.release_id)}`} AND ${claimedEvidence} THEN 1 ELSE 0 END AS claimed FROM operation_state WHERE singleton=1;\n`, { mode: 0o600 });
  const activeFence = replacement === null
    ? `active_ingestion_run_id=${q(bootstrap)}`
    : `active_release_id=${q(plan.release_id)}`;
  await writeFile(`${directory}/migration-started.sql`, `INSERT INTO administration_idempotency (idempotency_key,operation,request_json,response_json,http_status,outcome,created_at) SELECT ${q(migrationKey)},'production_release_migration_started',request_json,${q(stableJson({ release_id: plan.release_id, migration_started: true, dispatch_digest: environment.DISPATCH_DIGEST }))},201,'success',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM administration_idempotency WHERE idempotency_key=${q(claimKey)} AND operation='claim_production_release' AND EXISTS (SELECT 1 FROM operation_state WHERE singleton=1 AND ${activeFence}); SELECT changes() AS changed_rows, CASE WHEN changes()=1 AND EXISTS (SELECT 1 FROM administration_idempotency WHERE idempotency_key=${q(migrationKey)} AND operation='production_release_migration_started') THEN 1 ELSE 0 END AS migration_started;\n`, { mode: 0o600 });
  const migrationMarked = `EXISTS (SELECT 1 FROM administration_idempotency WHERE idempotency_key=${q(migrationKey)} AND operation='production_release_migration_started')`;
  await writeFile(`${directory}/migration-status.sql`, `SELECT CASE WHEN ${migrationMarked} THEN 1 ELSE 0 END AS migration_started;\n`, { mode: 0o600 });
  const materialize = `INSERT INTO production_releases (id,state,request_json,idempotency_key,expected_current_revision_id,expected_head_sha,production_target_digest,expected_migration_level,recovery_bookmark,recovery_backup_attempt_id,replacement_recovery_id,replacement_database_id,retained_database_id,requested_at) SELECT ${q(plan.release_id)},'requested',request_json,${q(plan.idempotency_key)},${q(plan.expected_current_revision_id)},${q(plan.expected_head_sha)},${q(plan.production_target_digest)},${plan.expected_migration_level},${q(plan.recovery_bookmark)},${q(plan.recovery_backup_attempt_id)},${replacement === null ? "NULL,NULL,NULL" : `${q(replacement.recovery_id)},${q(replacement.replacement_database_id)},${q(replacement.retained_database_id)}`},created_at FROM administration_idempotency WHERE ${preparedWhere}; UPDATE production_releases SET state='preflight' WHERE id=${q(plan.release_id)} AND state='requested'; UPDATE production_releases SET state='migrating' WHERE id=${q(plan.release_id)} AND state='preflight'; ${replacement === null ? `UPDATE operation_state SET active_release_id=${q(plan.release_id)},active_release_expires_at=${q(expires)},active_ingestion_run_id=NULL WHERE singleton=1 AND active_ingestion_run_id=${q(bootstrap)}; DELETE FROM ingestion_run_transitions WHERE ingestion_run_id=${q(bootstrap)}; DELETE FROM ingestion_runs WHERE id=${q(bootstrap)};` : ""} SELECT (SELECT COUNT(*) FROM production_release_transitions WHERE release_id=${q(plan.release_id)}) AS transition_rows, CASE WHEN EXISTS (SELECT 1 FROM production_releases WHERE id=${q(plan.release_id)} AND state='migrating') AND 3=(SELECT COUNT(*) FROM production_release_transitions WHERE release_id=${q(plan.release_id)}) AND EXISTS (SELECT 1 FROM operation_state WHERE singleton=1 AND active_release_id=${q(plan.release_id)}) THEN 1 ELSE 0 END AS transferred;`;
  await writeFile(`${directory}/materialize.sql`, `${materialize}\n`, { mode: 0o600 });
  await writeFile(`${directory}/deploying.sql`, `UPDATE production_releases SET state='deploying',api_version_id=${q(`release-${plan.release_id}-api`)},ingestion_version_id=${q(`release-${plan.release_id}-ingestion`)} WHERE id=${q(plan.release_id)} AND state='migrating'; SELECT changes() AS changed_rows, CASE WHEN changes()=1 AND EXISTS (SELECT 1 FROM production_releases WHERE id=${q(plan.release_id)} AND state='deploying' AND api_version_id=${q(`release-${plan.release_id}-api`)} AND ingestion_version_id=${q(`release-${plan.release_id}-ingestion`)}) THEN 1 ELSE 0 END AS transitioned;\n`, { mode: 0o600 });
  const failedInsert = `INSERT OR IGNORE INTO production_releases (id,state,request_json,idempotency_key,expected_current_revision_id,expected_head_sha,production_target_digest,expected_migration_level,recovery_bookmark,recovery_backup_attempt_id,replacement_recovery_id,replacement_database_id,retained_database_id,requested_at) SELECT ${q(plan.release_id)},'requested',request_json,${q(plan.idempotency_key)},${q(plan.expected_current_revision_id)},${q(plan.expected_head_sha)},${q(plan.production_target_digest)},${plan.expected_migration_level},${q(plan.recovery_bookmark)},${q(plan.recovery_backup_attempt_id)},${replacement === null ? "NULL,NULL,NULL" : `${q(replacement.recovery_id)},${q(replacement.replacement_database_id)},${q(replacement.retained_database_id)}`},created_at FROM administration_idempotency WHERE ${preparedWhere} AND ${migrationMarked};`;
  await writeFile(`${directory}/failed.sql`, `${failedInsert} SELECT changes() AS inserted_rows; UPDATE production_releases SET state='failed',failure_code='production_release_failed',failure_detail='Inspect the GitHub run and continue with a compatible roll-forward.',roll_forward_required=1,terminal_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=${q(plan.release_id)} AND state IN ('requested','preflight','migrating','deploying','smoke_testing') AND ${migrationMarked}; SELECT changes() AS transitioned_rows, CASE WHEN changes()=1 AND ${migrationMarked} AND EXISTS (SELECT 1 FROM production_releases WHERE id=${q(plan.release_id)} AND state='failed' AND roll_forward_required=1 AND failure_code='production_release_failed') THEN 1 ELSE 0 END AS failed;\n`, { mode: 0o600 });
  await writeFile(`${directory}/cleanup.sql`, `UPDATE operation_state SET active_ingestion_run_id=NULL WHERE singleton=1 AND active_ingestion_run_id=${q(bootstrap)}; UPDATE operation_state SET active_release_id=NULL,active_release_expires_at=NULL WHERE singleton=1 AND active_release_id=${q(plan.release_id)} AND EXISTS (SELECT 1 FROM production_releases WHERE id=${q(plan.release_id)} AND state='failed' AND roll_forward_required=1); DELETE FROM ingestion_run_transitions WHERE ingestion_run_id=${q(bootstrap)}; DELETE FROM ingestion_runs WHERE id=${q(bootstrap)}; SELECT CASE WHEN EXISTS (SELECT 1 FROM operation_state WHERE singleton=1 AND active_ingestion_run_id IS NULL AND active_release_id IS NULL) AND NOT EXISTS (SELECT 1 FROM ingestion_runs WHERE id=${q(bootstrap)}) AND (NOT EXISTS (SELECT 1 FROM production_releases WHERE id=${q(plan.release_id)}) OR EXISTS (SELECT 1 FROM production_releases WHERE id=${q(plan.release_id)} AND state='failed' AND roll_forward_required=1)) THEN 1 ELSE 0 END AS fence_released;\n`, { mode: 0o600 });
  return plan;
}

export async function writeEvidenceSql(kind, releaseId, evidence, output) {
  const id = opaque(releaseId);
  const serialized = stableJson(JSON.parse(evidence));
  const sql = kind === "binding"
    ? `UPDATE production_releases SET binding_observation_json=${sqlQuote(serialized)},state='smoke_testing' WHERE id=${sqlQuote(id)} AND state='deploying'; SELECT changes() AS changed_rows, CASE WHEN changes()=1 AND EXISTS (SELECT 1 FROM production_releases WHERE id=${sqlQuote(id)} AND state='smoke_testing' AND binding_observation_json=${sqlQuote(serialized)}) THEN 1 ELSE 0 END AS transitioned;`
    : `UPDATE production_releases SET state='succeeded',smoke_evidence_json=${sqlQuote(serialized)},terminal_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=${sqlQuote(id)} AND state='smoke_testing'; SELECT changes() AS changed_rows, CASE WHEN changes()=1 AND EXISTS (SELECT 1 FROM production_releases WHERE id=${sqlQuote(id)} AND state='succeeded' AND smoke_evidence_json=${sqlQuote(serialized)}) THEN 1 ELSE 0 END AS transitioned; UPDATE operation_state SET active_release_id=NULL,active_release_expires_at=NULL WHERE singleton=1 AND active_release_id=${sqlQuote(id)} AND EXISTS (SELECT 1 FROM production_releases WHERE id=${sqlQuote(id)} AND state='succeeded' AND smoke_evidence_json=${sqlQuote(serialized)}); SELECT changes() AS changed_rows, CASE WHEN changes()=1 AND EXISTS (SELECT 1 FROM operation_state WHERE singleton=1 AND active_release_id IS NULL) THEN 1 ELSE 0 END AS fence_released;`;
  await writeFile(output, `${sql}\n`, { mode: 0o600 });
}

function stableJson(value) { if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`; if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function sqlQuote(value) { return `'${String(value).replaceAll("'", "''")}'`; }
function required(env, name) { const value = env[name]; if (typeof value !== "string" || value.length === 0) throw new Error(`missing_${name.toLowerCase()}`); return value; }
function opaque(value) { if (!/^[A-Za-z0-9][A-Za-z0-9_.:@|-]{0,255}$/u.test(value)) throw new Error("invalid_opaque_identity"); return value; }
function digest(value) { if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error("invalid_digest"); return value; }
function head(value) { if (!/^[0-9a-f]{40}$/u.test(value)) throw new Error("invalid_head_sha"); return value; }
function bot(value) { if (!/^[A-Za-z0-9-]+\[bot\]$/u.test(value)) throw new Error("invalid_actor"); return value; }
function positiveInteger(value) { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("invalid_migration_level"); return parsed; }

function validReleaseEvidence(plan) {
  const retained = plan.retained_revision_evidence;
  const smoke = plan.smoke_targets;
  if (!Array.isArray(retained) || retained.length !== 3 ||
      !retained.every((item, depth) => exactKeys(item, ["depth", "export_verified", "recovery_verified", "revision_id"]) && item.depth === depth && typeof item.revision_id === "string" && item.export_verified === true && item.recovery_verified === true) ||
      retained[0].revision_id !== plan.expected_current_revision_id || new Set(retained.map((item) => item.revision_id)).size !== 3 ||
      !exactKeys(smoke, ["legality_card_id", "legality_format", "legality_region", "printing_image_id", "revisions", "stale_cursor", "stale_revision_id"]) ||
      !Array.isArray(smoke.revisions) || smoke.revisions.length !== 3 || retained.some((item) => item.revision_id === smoke.stale_revision_id)) return false;
  const strings = [smoke.printing_image_id, smoke.legality_card_id, smoke.legality_format, smoke.legality_region, smoke.stale_cursor, smoke.stale_revision_id];
  if (strings.some((item) => typeof item !== "string" || item.length === 0)) return false;
  return smoke.revisions.every((fixture, index) =>
    exactKeys(fixture, ["card_cursor", "card_id", "printing_cursor", "printing_id", "revision_id", "search_cursor", "search_query"]) &&
    fixture.revision_id === retained[index].revision_id &&
    [fixture.card_id, fixture.printing_id, fixture.search_query, fixture.card_cursor, fixture.search_cursor, fixture.printing_cursor]
      .every((item) => typeof item === "string" && item.length > 0)
  );
}

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

async function replaceDatabase(source, databaseId, output, ingestion) {
  const document = JSON.parse(await readFile(source, "utf8"));
  const binding = document.d1_databases.find((item) => item.binding === "CATALOGUE_DB");
  if (!binding) throw new Error("catalogue_binding_missing");
  binding.database_id = databaseId;
  if (ingestion) document.vars.CATALOGUE_D1_DATABASE_ID = databaseId;
  await writeFile(output, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
}

if (process.argv[2] === "replacement-configs") {
  await writeReplacementConfigs(process.argv[3], process.argv[4], process.argv[5]);
} else if (process.argv[2] === "validate-dispatch") {
  await validateDispatchAndWriteSql(process.env, process.argv[3]);
} else if (process.argv[2] === "evidence-sql") {
  await writeEvidenceSql(process.argv[3], process.argv[4], process.env.KEEPR_RELEASE_EVIDENCE, process.argv[5]);
}
