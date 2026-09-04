#!/usr/bin/env node
import { readWorkerConfig } from "../cli/lib/config.mjs";
import {
  productionReleaseTransitionSql,
  productionReleaseLeaseAssignmentsSql,
  productionReleaseOutcomeTimestampSql,
} from "./production-release-state.mjs";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { SPINE_REVISION_ID } from "../src/catalogue/shared/spine-revision.mjs";

export function assertReleaseInputs(input) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(input.releaseId ?? "") ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(input.expectedRevision ?? "") ||
    !/^[0-9a-f]{40}$/.test(input.expectedHeadSha ?? "") ||
    !/^[0-9a-f]{64}$/.test(input.productionTargetDigest ?? "") ||
    !Number.isSafeInteger(input.expectedMigrationLevel) ||
    input.expectedMigrationLevel < 1
  ) {
    throw new Error("invalid_release_input");
  }
  return input;
}

export async function writeReplacementConfigs(databaseId, apiOutput, ingestionOutput) {
  if (!/^[0-9a-f-]{36}$/.test(databaseId) && !/^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/.test(databaseId))
    throw new Error("invalid_replacement_database_id");
  await Promise.all([
    replaceDatabase("apps/api/wrangler.jsonc", databaseId, apiOutput, false),
    replaceDatabase("apps/ingestion/wrangler.jsonc", databaseId, ingestionOutput, true),
  ]);
}

export async function validateDispatchAndWriteSql(environment, directory) {
  const json = (name) => {
    try {
      return JSON.parse(required(environment, name));
    } catch {
      throw new Error(`invalid_${name.toLowerCase()}`);
    }
  };
  // Bootstrap Mode (issue #141): the catalogue is provably empty, so the plan
  // carries no recovery bookmark, backup attempt, retained window, or smoke
  // targets, and the live gate proves emptiness instead of recovery evidence.
  const bootstrap = booleanInput(required(environment, "BOOTSTRAP"));
  const preparedPlan = json("PREPARED_PLAN_JSON");
  if (preparedPlan?.bootstrap !== bootstrap) throw new Error("bootstrap_mismatch");
  const replacementId = required(environment, "REPLACEMENT_RECOVERY_ID");
  if (bootstrap && replacementId !== "none") throw new Error("bootstrap_replacement_not_allowed");
  const replacement =
    replacementId === "none"
      ? null
      : {
          recovery_id: opaque(replacementId),
          target_revision_id: opaque(required(environment, "EXPECTED_CURRENT_REVISION")),
          target_digest: digest(required(environment, "REPLACEMENT_TARGET_DIGEST")),
          replacement_database_id: opaque(required(environment, "REPLACEMENT_DATABASE_ID")),
          retained_database_id: opaque(required(environment, "RETAINED_DATABASE_ID")),
        };
  if (replacement !== null && replacement.replacement_database_id === replacement.retained_database_id)
    throw new Error("replacement_database_not_distinct");
  const noneOr = (name, parse) => {
    const value = required(environment, name);
    if (bootstrap) {
      if (value !== "none") throw new Error(`bootstrap_${name.toLowerCase()}_not_none`);
      return null;
    }
    return parse(value);
  };
  const plan = {
    bootstrap,
    expected_actor: bot(required(environment, "EXPECTED_ACTOR")),
    expected_current_revision_id: opaque(required(environment, "EXPECTED_CURRENT_REVISION")),
    expected_head_sha: head(required(environment, "EXPECTED_HEAD_SHA")),
    expected_migration_level: positiveInteger(required(environment, "EXPECTED_MIGRATION_LEVEL")),
    idempotency_key: opaque(required(environment, "IDEMPOTENCY_KEY")),
    production_target: json("PRODUCTION_TARGET_JSON"),
    production_target_digest: digest(required(environment, "PRODUCTION_TARGET_DIGEST")),
    recovery_backup_attempt_id: noneOr("RECOVERY_BACKUP_ATTEMPT_ID", opaque),
    recovery_bookmark: noneOr("RECOVERY_BOOKMARK", opaque),
    release_id: opaque(required(environment, "RELEASE_ID")),
    replacement_handoff: replacement,
    retained_revision_evidence: json("RETAINED_REVISION_EVIDENCE_JSON"),
    smoke_targets: json("SMOKE_TARGETS_JSON"),
  };
  if (!validReleaseEvidence(plan)) throw new Error("invalid_release_evidence");
  const targetJson = stableJson(plan.production_target);
  if (createHash("sha256").update(targetJson).digest("hex") !== plan.production_target_digest)
    throw new Error("production_target_digest_mismatch");
  if (stableJson(plan) !== stableJson(preparedPlan)) throw new Error("prepared_plan_mismatch");
  if (createHash("sha256").update(stableJson(plan)).digest("hex") !== digest(required(environment, "DISPATCH_DIGEST")))
    throw new Error("dispatch_digest_mismatch");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const q = sqlQuote;
  const expires = new Date(Date.now() + 45 * 60_000).toISOString();
  // This known cutover regenerates pre-Go-Live data instead of backfilling events.
  // Consult the checked-out migration level so ordinary releases after it stay valid.
  const localMigrationLevel = Math.max(
    ...(await readdir(new URL("../migrations/", import.meta.url)))
      .filter((name) => /^\d+_.*\.sql$/u.test(name))
      .map((name) => Number.parseInt(name, 10)),
  );
  const regenerationGate =
    plan.expected_migration_level < 12 && localMigrationLevel >= 12 ? "NOT EXISTS (SELECT 1 FROM ingestion_runs)" : "1";
  // The canonical lease exists before the run-event cutover and remains the
  // same reservation through migration; no synthetic Ingestion Run is needed.
  const preparedWhere = `idempotency_key=${q(plan.idempotency_key)} AND operation='prepare_production_release' AND request_json=${q(stableJson(plan))} AND json_extract(response_json,'$.release_id')=${q(plan.release_id)} AND json_extract(response_json,'$.dispatch_digest')=${q(environment.DISPATCH_DIGEST)}`;
  const recoveryGate =
    replacement === null
      ? `operation.recovery_health='healthy' AND operation.active_recovery_id IS NULL AND operation.recovery_restore_guard='clear'`
      : `operation.recovery_health='blocked' AND operation.active_recovery_id=${q(replacement.recovery_id)} AND EXISTS (SELECT 1 FROM catalogue_recovery_operations AS recovery WHERE recovery.id=${q(replacement.recovery_id)} AND recovery.state='awaiting_acceptance' AND recovery.method='replacement_database' AND recovery.target_revision_id=${q(replacement.target_revision_id)} AND recovery.target_digest=${q(replacement.target_digest)} AND recovery.restored_database_id=${q(replacement.replacement_database_id)} AND recovery.retained_database_id=${q(replacement.retained_database_id)} AND recovery.verification_json IS NOT NULL)`;
  const expectedRetention = bootstrap
    ? ""
    : plan.retained_revision_evidence.map((item) => `(${q(item.revision_id)},${item.depth})`).join(",");
  const idleGate = `catalogue.singleton=1 AND catalogue.current_revision_id=${q(plan.expected_current_revision_id)} AND schema_state.migration_level=${plan.expected_migration_level} AND operation.active_ingestion_run_id IS NULL AND (operation.active_production_release_id IS NULL OR operation.active_production_release_expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND ${recoveryGate} AND (${regenerationGate})`;
  const liveGate = bootstrap
    ? `EXISTS (SELECT 1 FROM catalogue_state AS catalogue JOIN operation_state AS operation ON operation.singleton=1 JOIN catalogue_schema_state AS schema_state ON schema_state.singleton=1 WHERE ${idleGate} AND catalogue.current_revision_id=${q(SPINE_REVISION_ID)} AND NOT EXISTS (SELECT 1 FROM catalogue_revisions))`
    : `EXISTS (SELECT 1 FROM catalogue_state AS catalogue JOIN operation_state AS operation ON operation.singleton=1 JOIN catalogue_schema_state AS schema_state ON schema_state.singleton=1 WHERE ${idleGate} AND EXISTS (SELECT 1 FROM catalogue_backup_attempts AS backup WHERE backup.idempotency_key=${q(plan.recovery_backup_attempt_id)} AND backup.catalogue_revision_id=${q(plan.expected_current_revision_id)} AND backup.state='verified' AND backup.d1_bookmark=${q(plan.recovery_bookmark)} AND backup.manifest_sha256 IS NOT NULL) AND 3=(WITH RECURSIVE retained(revision_id,depth) AS (SELECT catalogue.current_revision_id,0 UNION ALL SELECT revision.expected_previous_revision_id,retained.depth+1 FROM retained JOIN catalogue_revisions AS revision ON revision.id=retained.revision_id WHERE retained.depth<2 AND revision.expected_previous_revision_id IS NOT NULL), expected(revision_id,depth) AS (VALUES ${expectedRetention}) SELECT COUNT(*) FROM retained JOIN expected USING (revision_id,depth) JOIN catalogue_exports AS export ON export.catalogue_revision_id=retained.revision_id WHERE export.verified=1 AND export.maintenance_state='available' AND EXISTS (SELECT 1 FROM catalogue_backup_attempts AS backup WHERE backup.catalogue_revision_id=retained.revision_id AND backup.state='verified' AND backup.d1_bookmark IS NOT NULL AND backup.manifest_sha256 IS NOT NULL)) AND EXISTS (SELECT 1 FROM catalogue_query_revisions WHERE catalogue_revision_id=${q(plan.smoke_targets.stale_revision_id)} AND state='archived'))`;
  const claimKey = `release-dispatch:${environment.DISPATCH_DIGEST}`;
  const migrationKey = `release-migration-started:${environment.DISPATCH_DIGEST}`;
  const failureKey = `release-migration-failed:${environment.DISPATCH_DIGEST}`;
  const durableClaim = `INSERT INTO administration_idempotency (idempotency_key,operation,request_json,response_json,http_status,outcome,created_at) SELECT ${q(claimKey)},'claim_production_release',request_json,${q(stableJson({ release_id: plan.release_id, state: "preflight", dispatch_digest: environment.DISPATCH_DIGEST }))},201,'success',${productionReleaseOutcomeTimestampSql(claimKey)} FROM administration_idempotency WHERE ${preparedWhere} AND ${liveGate};`;
  const claimedEvidence = `EXISTS (SELECT 1 FROM administration_idempotency WHERE idempotency_key=${q(claimKey)} AND operation='claim_production_release')`;
  const leaseIdentity = `active_production_release_id=${q(plan.release_id)} AND active_production_release_expires_at=${q(expires)}`;
  const activeFence = `${leaseIdentity} AND active_ingestion_run_id IS NULL`;
  const leaseHeld = `EXISTS (SELECT 1 FROM operation_state WHERE singleton=1 AND ${activeFence})`;
  const claim = `UPDATE operation_state SET ${productionReleaseLeaseAssignmentsSql(plan.release_id, expires)} WHERE singleton=1 AND ${claimedEvidence} AND ${liveGate};`;
  await writeFile(
    `${directory}/live-preflight.sql`,
    `SELECT CASE WHEN EXISTS (SELECT 1 FROM administration_idempotency WHERE ${preparedWhere}) AND ${liveGate} THEN 1 ELSE 0 END AS ready, CASE WHEN NOT (${regenerationGate}) THEN 'ingestion_run_regeneration_required' ELSE NULL END AS problem;\n`,
    { mode: 0o600 },
  );
  await writeFile(
    `${directory}/claim.sql`,
    `${durableClaim}\n${claim}\nSELECT changes() AS changed_rows, CASE WHEN ${activeFence} AND ${claimedEvidence} THEN 1 ELSE 0 END AS claimed FROM operation_state WHERE singleton=1;\n`,
    { mode: 0o600 },
  );
  await writeFile(
    `${directory}/migration-started.sql`,
    `INSERT INTO administration_idempotency (idempotency_key,operation,request_json,response_json,http_status,outcome,created_at) SELECT ${q(migrationKey)},'production_release_migration_started',request_json,${q(stableJson({ release_id: plan.release_id, migration_started: true, dispatch_digest: environment.DISPATCH_DIGEST }))},201,'success',${productionReleaseOutcomeTimestampSql(migrationKey)} FROM administration_idempotency WHERE idempotency_key=${q(claimKey)} AND operation='claim_production_release' AND EXISTS (SELECT 1 FROM operation_state WHERE singleton=1 AND ${activeFence}); SELECT changes() AS changed_rows, CASE WHEN changes()=1 AND EXISTS (SELECT 1 FROM administration_idempotency WHERE idempotency_key=${q(migrationKey)} AND operation='production_release_migration_started') THEN 1 ELSE 0 END AS migration_started;\n`,
    { mode: 0o600 },
  );
  const migrationMarked = `EXISTS (SELECT 1 FROM administration_idempotency WHERE idempotency_key=${q(migrationKey)} AND operation='production_release_migration_started')`;
  await writeFile(
    `${directory}/migration-status.sql`,
    `SELECT CASE WHEN ${migrationMarked} THEN 1 ELSE 0 END AS migration_started;\n`,
    { mode: 0o600 },
  );
  const failureResponse = stableJson({
    release_id: plan.release_id,
    dispatch_digest: environment.DISPATCH_DIGEST,
    migration_started_key: migrationKey,
    state: "failed",
    roll_forward_required: true,
  });
  const failureRecorded = `EXISTS (SELECT 1 FROM administration_idempotency WHERE idempotency_key=${q(failureKey)} AND operation='production_release_migration_failed' AND request_json=${q(stableJson(plan))} AND response_json=${q(failureResponse)} AND outcome='problem')`;
  await writeFile(
    `${directory}/failure-evidence.sql`,
    `INSERT OR IGNORE INTO administration_idempotency (idempotency_key,operation,request_json,response_json,http_status,outcome,created_at) SELECT ${q(failureKey)},'production_release_migration_failed',request_json,${q(failureResponse)},500,'problem',${productionReleaseOutcomeTimestampSql(failureKey)} FROM administration_idempotency WHERE idempotency_key=${q(migrationKey)} AND operation='production_release_migration_started' AND request_json=${q(stableJson(plan))}; SELECT changes() AS inserted_rows, CASE WHEN ${migrationMarked} THEN 1 ELSE 0 END AS migration_started, CASE WHEN ${failureRecorded} THEN 1 ELSE 0 END AS failure_recorded;\n`,
    { mode: 0o600 },
  );
  await writeFile(
    `${directory}/post-schema-status.sql`,
    `SELECT CASE WHEN EXISTS (SELECT 1 FROM sqlite_schema WHERE type='table' AND name='production_releases') THEN 1 ELSE 0 END AS production_releases_available;\n`,
    { mode: 0o600 },
  );
  const materializationAuthority = `${claimedEvidence} AND ${migrationMarked} AND ${leaseHeld}`;
  const materialize = bootstrap
    ? `SELECT CASE WHEN ${materializationAuthority} AND EXISTS (SELECT 1 FROM administration_idempotency WHERE ${preparedWhere}) THEN 1 ELSE 0 END AS transferred;`
    : `INSERT INTO production_releases (id,state,request_json,idempotency_key,expected_current_revision_id,expected_head_sha,production_target_digest,expected_migration_level,recovery_bookmark,recovery_backup_attempt_id,replacement_recovery_id,replacement_database_id,retained_database_id,requested_at) SELECT ${q(plan.release_id)},'requested',request_json,${q(plan.idempotency_key)},${q(plan.expected_current_revision_id)},${q(plan.expected_head_sha)},${q(plan.production_target_digest)},${plan.expected_migration_level},${q(plan.recovery_bookmark)},${q(plan.recovery_backup_attempt_id)},${replacement === null ? "NULL,NULL,NULL" : `${q(replacement.recovery_id)},${q(replacement.replacement_database_id)},${q(replacement.retained_database_id)}`},created_at FROM administration_idempotency WHERE ${preparedWhere} AND ${materializationAuthority}; ${productionReleaseTransitionSql(plan.release_id, "preflight", {}, materializationAuthority)} ${productionReleaseTransitionSql(plan.release_id, "migrating", {}, materializationAuthority)} SELECT CASE WHEN EXISTS (SELECT 1 FROM production_releases WHERE id=${q(plan.release_id)} AND state='migrating' AND request_json=${q(stableJson(plan))} AND idempotency_key=${q(plan.idempotency_key)}) AND EXISTS (SELECT 1 FROM administration_idempotency WHERE ${preparedWhere}) AND ${materializationAuthority} THEN 1 ELSE 0 END AS transferred;`;
  await writeFile(`${directory}/materialize.sql`, `${materialize}\n`, { mode: 0o600 });
  if (bootstrap) {
    const deployingKey = `release-deploying:${environment.DISPATCH_DIGEST}`;
    const deployingResponse = stableJson({
      release_id: plan.release_id,
      state: "deploying",
      api_version_id: `release-${plan.release_id}-api`,
      ingestion_version_id: `release-${plan.release_id}-ingestion`,
      dispatch_digest: environment.DISPATCH_DIGEST,
    });
    await writeFile(
      `${directory}/deploying.sql`,
      `INSERT INTO administration_idempotency (idempotency_key,operation,request_json,response_json,http_status,outcome,created_at) SELECT ${q(deployingKey)},'production_release_deploying',request_json,${q(deployingResponse)},201,'success',${productionReleaseOutcomeTimestampSql(deployingKey)} FROM administration_idempotency WHERE idempotency_key=${q(claimKey)} AND operation='claim_production_release' AND ${migrationMarked} AND EXISTS (SELECT 1 FROM operation_state WHERE singleton=1 AND active_production_release_id=${q(plan.release_id)}); SELECT changes() AS changed_rows, CASE WHEN changes()=1 AND EXISTS (SELECT 1 FROM administration_idempotency WHERE idempotency_key=${q(deployingKey)} AND operation='production_release_deploying') THEN 1 ELSE 0 END AS transitioned;\n`,
      { mode: 0o600 },
    );
  } else {
    await writeFile(
      `${directory}/deploying.sql`,
      `${productionReleaseTransitionSql(plan.release_id, "deploying", { apiVersionId: `release-${plan.release_id}-api`, ingestionVersionId: `release-${plan.release_id}-ingestion` })} SELECT changes() AS changed_rows, CASE WHEN changes()=1 AND EXISTS (SELECT 1 FROM production_releases WHERE id=${q(plan.release_id)} AND state='deploying' AND api_version_id=${q(`release-${plan.release_id}-api`)} AND ingestion_version_id=${q(`release-${plan.release_id}-ingestion`)}) THEN 1 ELSE 0 END AS transitioned;\n`,
      { mode: 0o600 },
    );
  }
  const failedInsert = `INSERT OR IGNORE INTO production_releases (id,state,request_json,idempotency_key,expected_current_revision_id,expected_head_sha,production_target_digest,expected_migration_level,recovery_bookmark,recovery_backup_attempt_id,replacement_recovery_id,replacement_database_id,retained_database_id,requested_at) SELECT ${q(plan.release_id)},'requested',request_json,${q(plan.idempotency_key)},${q(plan.expected_current_revision_id)},${q(plan.expected_head_sha)},${q(plan.production_target_digest)},${plan.expected_migration_level},${q(plan.recovery_bookmark)},${q(plan.recovery_backup_attempt_id)},${replacement === null ? "NULL,NULL,NULL" : `${q(replacement.recovery_id)},${q(replacement.replacement_database_id)},${q(replacement.retained_database_id)}`},created_at FROM administration_idempotency WHERE ${preparedWhere} AND ${migrationMarked} AND ${failureRecorded};`;
  if (!bootstrap)
    await writeFile(
      `${directory}/failed.sql`,
      `${failedInsert} SELECT changes() AS inserted_rows; ${productionReleaseTransitionSql(plan.release_id, "failed", { rollForwardRequired: true }, `${migrationMarked} AND ${failureRecorded}`)} SELECT changes() AS transitioned_rows, CASE WHEN ${migrationMarked} AND ${failureRecorded} AND EXISTS (SELECT 1 FROM production_releases WHERE id=${q(plan.release_id)} AND state='failed' AND roll_forward_required=1 AND failure_code='production_release_failed') THEN 1 ELSE 0 END AS failed;\n`,
      { mode: 0o600 },
    );
  const cleanupAllowed = `(${failureRecorded} OR NOT ${migrationMarked})`;
  await writeFile(
    `${directory}/cleanup.sql`,
    `UPDATE operation_state SET ${productionReleaseLeaseAssignmentsSql(null, null)} WHERE singleton=1 AND ${leaseIdentity} AND ${cleanupAllowed}; SELECT CASE WHEN EXISTS (SELECT 1 FROM operation_state WHERE singleton=1 AND active_ingestion_run_id IS NULL AND active_production_release_id IS NULL) THEN 1 ELSE 0 END AS fence_released;\n`,
    { mode: 0o600 },
  );
  if (replacement !== null) {
    await writeFile(
      `${directory}/replacement-handoff.sql`,
      replacementHandoffSelect(plan, environment.DISPATCH_DIGEST),
      { mode: 0o600 },
    );
  }
  return plan;
}

export async function writeReplacementSeedSql(environment, serializedEvidence, output) {
  let evidence;
  let plan;
  try {
    evidence = JSON.parse(serializedEvidence);
    plan = JSON.parse(required(environment, "PREPARED_PLAN_JSON"));
  } catch {
    throw new Error("invalid_replacement_handoff_evidence");
  }
  if (!validReplacementHandoffEvidence(evidence, plan, environment)) {
    throw new Error("invalid_replacement_handoff_evidence");
  }
  const q = sqlQuote;
  const statements = ["PRAGMA foreign_keys = ON;"];
  for (const backup of evidence.backups) {
    statements.push(
      `INSERT OR IGNORE INTO catalogue_backup_attempts (idempotency_key,request_json,owner_token,catalogue_revision_id,state,object_key,d1_bookmark,failure_code,failure_detail,started_at,completed_at,manifest_key,content_sha256,manifest_sha256,export_bytes,schema_migration_level,linked_attempt_id,publication_ingestion_run_id,disposable_database_id,restore_generation,restore_phase) VALUES (${q(backup.idempotency_key)},${q(backup.request_json)},${q(backup.owner_token)},${q(backup.catalogue_revision_id)},'pending',${q(backup.object_key)},NULL,NULL,NULL,${q(backup.started_at)},NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL);`,
      `UPDATE catalogue_backup_attempts SET state='exporting' WHERE idempotency_key=${q(backup.idempotency_key)} AND state='pending';`,
      `UPDATE catalogue_backup_attempts SET state='restoring_verification',d1_bookmark=${q(backup.d1_bookmark)},manifest_key=${q(backup.manifest_key)},content_sha256=${q(backup.content_sha256)},manifest_sha256=${q(backup.manifest_sha256)},export_bytes=${backup.export_bytes},schema_migration_level=${backup.schema_migration_level},disposable_database_id=${q(backup.disposable_database_id)},restore_generation=${backup.restore_generation},restore_phase='prepared' WHERE idempotency_key=${q(backup.idempotency_key)} AND state='exporting';`,
      `UPDATE catalogue_backup_attempts SET state='verifying',restore_phase='imported' WHERE idempotency_key=${q(backup.idempotency_key)} AND state='restoring_verification';`,
      `UPDATE catalogue_backup_attempts SET state='verified',completed_at=${q(backup.completed_at)},restore_phase='verified' WHERE idempotency_key=${q(backup.idempotency_key)} AND state='verifying';`,
    );
  }
  for (const recovery of [...evidence.recoveries].reverse()) {
    statements.push(
      `INSERT OR IGNORE INTO catalogue_recovery_operations (id,state,method,request_json,idempotency_key,target_revision_id,target_bookmark,target_digest,source_backup_attempt_id,linked_operation_id,expected_current_revision_id,current_bookmark,restored_bookmark,undo_bookmark,original_database_id,restored_database_id,retained_database_id,expected_schema_migration_level,expected_verification_json,verification_json,verification_idempotency_key,verification_request_digest,acceptance_idempotency_key,acceptance_request_digest,started_at,restored_at,verified_at,accepted_at,failure_code,failure_detail,failed_at) VALUES (${recoveryValues(recovery).map(qNullable).join(",")});`,
    );
  }
  for (const item of evidence.idempotency) {
    statements.push(
      `INSERT OR IGNORE INTO administration_idempotency (idempotency_key,operation,request_json,response_json,http_status,outcome,created_at) VALUES (${q(item.idempotency_key)},${q(item.operation)},${q(item.request_json)},${q(item.response_json)},${item.http_status},${q(item.outcome)},${productionReleaseOutcomeTimestampSql(item.idempotency_key, item.created_at)});`,
    );
  }
  const productionRelease = evidence.production_release;
  statements.push(
    `UPDATE operation_state SET recovery_health='blocked',active_recovery_id=${q(plan.replacement_handoff.recovery_id)},recovery_restore_guard='blocked' WHERE singleton=1 AND active_ingestion_run_id IS NULL AND active_production_release_id IS NULL AND ((recovery_health='healthy' AND active_recovery_id IS NULL AND recovery_restore_guard='clear') OR (recovery_health='blocked' AND active_recovery_id=${q(plan.replacement_handoff.recovery_id)} AND recovery_restore_guard='blocked'));`,
    `INSERT OR IGNORE INTO production_releases (id,state,request_json,idempotency_key,expected_current_revision_id,expected_head_sha,production_target_digest,expected_migration_level,recovery_bookmark,recovery_backup_attempt_id,replacement_recovery_id,replacement_database_id,retained_database_id,requested_at) VALUES (${q(productionRelease.id)},'requested',${q(productionRelease.request_json)},${q(productionRelease.idempotency_key)},${q(productionRelease.expected_current_revision_id)},${q(productionRelease.expected_head_sha)},${q(productionRelease.production_target_digest)},${productionRelease.expected_migration_level},${q(productionRelease.recovery_bookmark)},${q(productionRelease.recovery_backup_attempt_id)},${q(productionRelease.replacement_recovery_id)},${q(productionRelease.replacement_database_id)},${q(productionRelease.retained_database_id)},${q(productionRelease.requested_at)});`,
    `${productionReleaseTransitionSql(productionRelease.id, "preflight")}`,
    `${productionReleaseTransitionSql(productionRelease.id, "migrating")}`,
    `UPDATE operation_state SET ${productionReleaseLeaseAssignmentsSql(productionRelease.id, evidence.operation_state.active_production_release_expires_at)} WHERE singleton=1 AND active_ingestion_run_id IS NULL AND recovery_health='blocked' AND recovery_restore_guard='blocked' AND active_recovery_id=${q(plan.replacement_handoff.recovery_id)} AND (active_production_release_id IS NULL OR (active_production_release_id=${q(productionRelease.id)} AND active_production_release_expires_at=${q(evidence.operation_state.active_production_release_expires_at)}));`,
    replacementTerminalAssertion(evidence, plan),
  );
  await writeFile(output, `${statements.join("\n")}\n`, { mode: 0o600 });
}

export async function writeEvidenceSql(kind, releaseId, evidence, output, environment = {}) {
  const id = opaque(releaseId);
  const serialized = stableJson(JSON.parse(evidence));
  const bootstrap = environment.BOOTSTRAP === undefined ? false : booleanInput(environment.BOOTSTRAP);
  if (bootstrap) {
    await writeFile(
      output,
      `${bootstrapEvidenceSql(kind, id, serialized, digest(required(environment, "DISPATCH_DIGEST")))}\n`,
      { mode: 0o600 },
    );
    return;
  }
  const sql =
    kind === "binding"
      ? `${productionReleaseTransitionSql(id, "smoke_testing", { evidenceJson: serialized })} SELECT changes() AS changed_rows, CASE WHEN changes()=1 AND EXISTS (SELECT 1 FROM production_releases WHERE id=${sqlQuote(id)} AND state='smoke_testing' AND binding_observation_json=${sqlQuote(serialized)}) THEN 1 ELSE 0 END AS transitioned;`
      : `${productionReleaseTransitionSql(id, "succeeded", { evidenceJson: serialized })} SELECT changes() AS changed_rows, CASE WHEN changes()=1 AND EXISTS (SELECT 1 FROM production_releases WHERE id=${sqlQuote(id)} AND state='succeeded' AND smoke_evidence_json=${sqlQuote(serialized)}) THEN 1 ELSE 0 END AS transitioned; UPDATE operation_state SET ${productionReleaseLeaseAssignmentsSql(null, null)} WHERE singleton=1 AND active_production_release_id=${sqlQuote(id)} AND EXISTS (SELECT 1 FROM production_releases WHERE id=${sqlQuote(id)} AND state='succeeded' AND smoke_evidence_json=${sqlQuote(serialized)}); SELECT changes() AS changed_rows, CASE WHEN changes()=1 AND EXISTS (SELECT 1 FROM operation_state WHERE singleton=1 AND active_production_release_id IS NULL) THEN 1 ELSE 0 END AS fence_released;`;
  await writeFile(output, `${sql}\n`, { mode: 0o600 });
}

// Bootstrap Mode has no production_releases row (its recovery columns
// presuppose a verified backup), so phase evidence lands in the idempotency
// ledger keyed by the dispatch digest, and the smoke phase releases the lease.
function bootstrapEvidenceSql(kind, id, serialized, dispatchDigest) {
  const q = sqlQuote;
  const deployingKey = `release-deploying:${dispatchDigest}`;
  const bindingKey = `release-binding:${dispatchDigest}`;
  const smokeKey = `release-smoke:${dispatchDigest}`;
  const rowExists = (key, operation) =>
    `EXISTS (SELECT 1 FROM administration_idempotency WHERE idempotency_key=${q(key)} AND operation=${q(operation)})`;
  const leaseHeld = `EXISTS (SELECT 1 FROM operation_state WHERE singleton=1 AND active_production_release_id=${q(id)})`;
  const ledgerInsert = (key, operation, previousKey, previousOperation, response) =>
    `INSERT INTO administration_idempotency (idempotency_key,operation,request_json,response_json,http_status,outcome,created_at) SELECT ${q(key)},${q(operation)},request_json,${q(response)},201,'success',${productionReleaseOutcomeTimestampSql(key)} FROM administration_idempotency WHERE idempotency_key=${q(previousKey)} AND operation=${q(previousOperation)} AND ${leaseHeld}; SELECT changes() AS changed_rows, CASE WHEN changes()=1 AND ${rowExists(key, operation)} THEN 1 ELSE 0 END AS transitioned;`;
  if (kind === "binding") {
    return ledgerInsert(
      bindingKey,
      "production_release_binding_observed",
      deployingKey,
      "production_release_deploying",
      stableJson({
        release_id: id,
        state: "smoke_testing",
        dispatch_digest: dispatchDigest,
        binding_observation: JSON.parse(serialized),
      }),
    );
  }
  return `${ledgerInsert(smokeKey, "production_release_succeeded", bindingKey, "production_release_binding_observed", stableJson({ release_id: id, state: "succeeded", dispatch_digest: dispatchDigest, smoke_evidence: JSON.parse(serialized) }))} UPDATE operation_state SET ${productionReleaseLeaseAssignmentsSql(null, null)} WHERE singleton=1 AND active_production_release_id=${q(id)} AND ${rowExists(smokeKey, "production_release_succeeded")}; SELECT changes() AS changed_rows, CASE WHEN changes()=1 AND EXISTS (SELECT 1 FROM operation_state WHERE singleton=1 AND active_production_release_id IS NULL AND active_ingestion_run_id IS NULL) THEN 1 ELSE 0 END AS fence_released;`;
}

function booleanInput(value) {
  if (value !== "true" && value !== "false") throw new Error("invalid_bootstrap_input");
  return value === "true";
}
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function sqlQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}
function required(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}
function opaque(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@|-]{0,255}$/u.test(value)) throw new Error("invalid_opaque_identity");
  return value;
}
function digest(value) {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error("invalid_digest");
  return value;
}
function head(value) {
  if (!/^[0-9a-f]{40}$/u.test(value)) throw new Error("invalid_head_sha");
  return value;
}
function bot(value) {
  if (!/^[A-Za-z0-9-]+\[bot\]$/u.test(value)) throw new Error("invalid_actor");
  return value;
}
function positiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("invalid_migration_level");
  return parsed;
}

function validReleaseEvidence(plan) {
  if (plan.bootstrap) {
    return (
      plan.expected_current_revision_id === SPINE_REVISION_ID &&
      plan.replacement_handoff === null &&
      plan.recovery_bookmark === null &&
      plan.recovery_backup_attempt_id === null &&
      plan.retained_revision_evidence === null &&
      plan.smoke_targets === null
    );
  }
  const retained = plan.retained_revision_evidence;
  const smoke = plan.smoke_targets;
  if (
    !Array.isArray(retained) ||
    retained.length !== 3 ||
    !retained.every(
      (item, depth) =>
        exactKeys(item, ["depth", "export_verified", "recovery_verified", "revision_id"]) &&
        item.depth === depth &&
        typeof item.revision_id === "string" &&
        item.export_verified === true &&
        item.recovery_verified === true,
    ) ||
    retained[0].revision_id !== plan.expected_current_revision_id ||
    new Set(retained.map((item) => item.revision_id)).size !== 3 ||
    !exactKeys(smoke, [
      "legality_card_id",
      "legality_format",
      "legality_region",
      "printing_image_id",
      "revisions",
      "stale_cursor",
      "stale_revision_id",
    ]) ||
    !Array.isArray(smoke.revisions) ||
    smoke.revisions.length !== 3 ||
    retained.some((item) => item.revision_id === smoke.stale_revision_id)
  )
    return false;
  const strings = [
    smoke.printing_image_id,
    smoke.legality_card_id,
    smoke.legality_format,
    smoke.legality_region,
    smoke.stale_cursor,
    smoke.stale_revision_id,
  ];
  if (strings.some((item) => typeof item !== "string" || item.length === 0)) return false;
  return smoke.revisions.every(
    (fixture, index) =>
      exactKeys(fixture, [
        "card_cursor",
        "card_id",
        "printing_cursor",
        "printing_id",
        "revision_id",
        "search_cursor",
        "search_query",
      ]) &&
      fixture.revision_id === retained[index].revision_id &&
      [
        fixture.card_id,
        fixture.printing_id,
        fixture.search_query,
        fixture.card_cursor,
        fixture.search_cursor,
        fixture.printing_cursor,
      ].every((item) => typeof item === "string" && item.length > 0),
  );
}

function replacementHandoffSelect(plan, dispatchDigest) {
  const q = sqlQuote;
  const recoveryJson = `json_object('id',id,'state',state,'method',method,'request_json',request_json,'idempotency_key',idempotency_key,'target_revision_id',target_revision_id,'target_bookmark',target_bookmark,'target_digest',target_digest,'source_backup_attempt_id',source_backup_attempt_id,'linked_operation_id',linked_operation_id,'expected_current_revision_id',expected_current_revision_id,'current_bookmark',current_bookmark,'restored_bookmark',restored_bookmark,'undo_bookmark',undo_bookmark,'original_database_id',original_database_id,'restored_database_id',restored_database_id,'retained_database_id',retained_database_id,'expected_schema_migration_level',expected_schema_migration_level,'expected_verification_json',expected_verification_json,'verification_json',verification_json,'verification_idempotency_key',verification_idempotency_key,'verification_request_digest',verification_request_digest,'acceptance_idempotency_key',acceptance_idempotency_key,'acceptance_request_digest',acceptance_request_digest,'started_at',started_at,'restored_at',restored_at,'verified_at',verified_at,'accepted_at',accepted_at,'failure_code',failure_code,'failure_detail',failure_detail,'failed_at',failed_at)`;
  const backupJson = `json_object('idempotency_key',backup.idempotency_key,'request_json',backup.request_json,'owner_token',backup.owner_token,'catalogue_revision_id',backup.catalogue_revision_id,'object_key',backup.object_key,'d1_bookmark',backup.d1_bookmark,'started_at',backup.started_at,'completed_at',backup.completed_at,'manifest_key',backup.manifest_key,'content_sha256',backup.content_sha256,'manifest_sha256',backup.manifest_sha256,'export_bytes',backup.export_bytes,'schema_migration_level',backup.schema_migration_level,'disposable_database_id',backup.disposable_database_id,'restore_generation',backup.restore_generation,'restore_phase',backup.restore_phase)`;
  const idemJson = `json_object('idempotency_key',idempotency_key,'operation',operation,'request_json',request_json,'response_json',response_json,'http_status',http_status,'outcome',outcome,'created_at',created_at)`;
  const productionReleaseJson = `json_object('id',release.id,'state',release.state,'request_json',release.request_json,'idempotency_key',release.idempotency_key,'expected_current_revision_id',release.expected_current_revision_id,'expected_head_sha',release.expected_head_sha,'production_target_digest',release.production_target_digest,'expected_migration_level',release.expected_migration_level,'recovery_bookmark',release.recovery_bookmark,'recovery_backup_attempt_id',release.recovery_backup_attempt_id,'replacement_recovery_id',release.replacement_recovery_id,'replacement_database_id',release.replacement_database_id,'retained_database_id',release.retained_database_id,'requested_at',release.requested_at)`;
  const claimKey = `release-dispatch:${dispatchDigest}`;
  const migrationKey = `release-migration-started:${dispatchDigest}`;
  const idempotencyWhere = `(idempotency_key=${q(plan.idempotency_key)} AND operation='prepare_production_release') OR (idempotency_key=${q(claimKey)} AND operation='claim_production_release') OR (idempotency_key=${q(migrationKey)} AND operation='production_release_migration_started')`;
  return `WITH RECURSIVE recovery_chain AS (
  SELECT 0 AS depth,recovery.* FROM catalogue_recovery_operations AS recovery WHERE recovery.id=${q(plan.replacement_handoff.recovery_id)}
  UNION ALL
  SELECT chain.depth+1,parent.* FROM recovery_chain AS chain JOIN catalogue_recovery_operations AS parent ON parent.id=chain.linked_operation_id WHERE chain.depth<31
), source_backups AS (
  SELECT source_backup_attempt_id,MIN(depth) AS depth FROM (
    SELECT source_backup_attempt_id,depth FROM recovery_chain
    UNION ALL SELECT ${q(plan.recovery_backup_attempt_id)},-1
  ) GROUP BY source_backup_attempt_id
)
SELECT json_object(
  'contract','card-keepr-replacement-production-release-handoff@2',
  'schema_migration_level',schema_state.migration_level,
  'operation_state',json_object('active_ingestion_run_id',operation.active_ingestion_run_id,'active_production_release_id',operation.active_production_release_id,'active_production_release_expires_at',operation.active_production_release_expires_at,'recovery_health',operation.recovery_health,'active_recovery_id',operation.active_recovery_id,'recovery_restore_guard',operation.recovery_restore_guard),
  'backups',json((SELECT json_group_array(json(row_json)) FROM (SELECT ${backupJson} AS row_json FROM source_backups AS source JOIN catalogue_backup_attempts AS backup ON backup.idempotency_key=source.source_backup_attempt_id WHERE backup.state='verified' ORDER BY source.depth))),
  'recoveries',json((SELECT json_group_array(json(row_json)) FROM (SELECT ${recoveryJson} AS row_json FROM recovery_chain ORDER BY depth))),
  'idempotency',json((SELECT json_group_array(json(row_json)) FROM (SELECT ${idemJson} AS row_json FROM administration_idempotency WHERE ${idempotencyWhere} ORDER BY CASE idempotency_key WHEN ${q(plan.idempotency_key)} THEN 0 WHEN ${q(claimKey)} THEN 1 ELSE 2 END))),
  'production_release',${productionReleaseJson}
) AS handoff_json
FROM operation_state AS operation
JOIN catalogue_schema_state AS schema_state ON schema_state.singleton=1
JOIN production_releases AS release ON release.id=${q(plan.release_id)}
WHERE operation.singleton=1
  AND operation.active_ingestion_run_id IS NULL
  AND operation.active_production_release_id=${q(plan.release_id)}
  AND operation.active_production_release_expires_at IS NOT NULL
  AND operation.recovery_health='blocked'
  AND operation.active_recovery_id=${q(plan.replacement_handoff.recovery_id)}
  AND operation.recovery_restore_guard='blocked'
  AND schema_state.migration_level=${plan.expected_migration_level}
  AND release.state='migrating'
  AND (SELECT COUNT(*) FROM recovery_chain) BETWEEN 1 AND 32
  AND (SELECT COUNT(*) FROM source_backups)=(SELECT COUNT(*) FROM source_backups AS source JOIN catalogue_backup_attempts AS backup ON backup.idempotency_key=source.source_backup_attempt_id WHERE backup.state='verified')
  AND (SELECT COUNT(*) FROM administration_idempotency WHERE ${idempotencyWhere})=3;
`;
}

function validReplacementHandoffEvidence(evidence, plan, environment) {
  if (
    !exactKeys(evidence, [
      "backups",
      "contract",
      "idempotency",
      "operation_state",
      "production_release",
      "recoveries",
      "schema_migration_level",
    ]) ||
    evidence.contract !== "card-keepr-replacement-production-release-handoff@2" ||
    !exactKeys(plan, [
      "bootstrap",
      "expected_actor",
      "expected_current_revision_id",
      "expected_head_sha",
      "expected_migration_level",
      "idempotency_key",
      "production_target",
      "production_target_digest",
      "recovery_backup_attempt_id",
      "recovery_bookmark",
      "release_id",
      "replacement_handoff",
      "retained_revision_evidence",
      "smoke_targets",
    ]) ||
    plan.bootstrap !== false ||
    !exactKeys(plan.replacement_handoff, [
      "recovery_id",
      "replacement_database_id",
      "retained_database_id",
      "target_digest",
      "target_revision_id",
    ]) ||
    !validReleaseEvidence(plan) ||
    !/^[0-9a-f]{40}$/u.test(plan.expected_head_sha) ||
    !/^[0-9a-f]{64}$/u.test(plan.production_target_digest) ||
    createHash("sha256").update(stableJson(plan.production_target)).digest("hex") !== plan.production_target_digest ||
    createHash("sha256").update(stableJson(plan)).digest("hex") !== environment.DISPATCH_DIGEST ||
    plan.replacement_handoff.recovery_id !== environment.REPLACEMENT_RECOVERY_ID ||
    plan.replacement_handoff.replacement_database_id !== environment.REPLACEMENT_DATABASE_ID ||
    plan.replacement_handoff.retained_database_id !== environment.RETAINED_DATABASE_ID ||
    plan.replacement_handoff.target_digest !== environment.REPLACEMENT_TARGET_DIGEST ||
    stableJson(plan) !== stableJson(JSON.parse(environment.PREPARED_PLAN_JSON)) ||
    evidence.schema_migration_level !== plan.expected_migration_level ||
    !Number.isSafeInteger(evidence.schema_migration_level)
  )
    return false;
  const operation = evidence.operation_state;
  if (
    !exactKeys(operation, [
      "active_ingestion_run_id",
      "active_recovery_id",
      "active_production_release_expires_at",
      "active_production_release_id",
      "recovery_health",
      "recovery_restore_guard",
    ]) ||
    operation.active_ingestion_run_id !== null ||
    operation.active_production_release_id !== plan.release_id ||
    operation.active_recovery_id !== plan.replacement_handoff.recovery_id ||
    operation.recovery_health !== "blocked" ||
    operation.recovery_restore_guard !== "blocked" ||
    !isoTimestamp(operation.active_production_release_expires_at)
  )
    return false;
  if (
    !Array.isArray(evidence.recoveries) ||
    evidence.recoveries.length < 1 ||
    evidence.recoveries.length > 32 ||
    !evidence.recoveries.every(validRecoveryEvidence)
  )
    return false;
  const active = evidence.recoveries[0];
  if (
    active.id !== plan.replacement_handoff.recovery_id ||
    active.state !== "awaiting_acceptance" ||
    active.method !== "replacement_database" ||
    active.target_revision_id !== plan.expected_current_revision_id ||
    active.target_digest !== plan.replacement_handoff.target_digest ||
    active.restored_database_id !== plan.replacement_handoff.replacement_database_id ||
    active.retained_database_id !== plan.replacement_handoff.retained_database_id ||
    active.expected_schema_migration_level !== plan.expected_migration_level ||
    active.acceptance_idempotency_key !== null ||
    active.accepted_at !== null
  )
    return false;
  for (let index = 0; index < evidence.recoveries.length; index += 1) {
    const recovery = evidence.recoveries[index];
    const parent = evidence.recoveries[index + 1];
    if (recovery.linked_operation_id !== (parent?.id ?? null) || (index > 0 && recovery.state !== "failed"))
      return false;
  }
  if (!Array.isArray(evidence.backups) || evidence.backups.length < 1 || !evidence.backups.every(validBackupEvidence))
    return false;
  const backupsById = new Map(evidence.backups.map((backup) => [backup.idempotency_key, backup]));
  const releaseBackup = backupsById.get(plan.recovery_backup_attempt_id);
  if (
    releaseBackup?.catalogue_revision_id !== plan.expected_current_revision_id ||
    releaseBackup.d1_bookmark !== plan.recovery_bookmark ||
    releaseBackup.schema_migration_level !== plan.expected_migration_level ||
    evidence.recoveries.some((recovery) => {
      const backup = backupsById.get(recovery.source_backup_attempt_id);
      return (
        backup?.catalogue_revision_id !== recovery.target_revision_id ||
        backup.d1_bookmark !== recovery.target_bookmark ||
        backup.manifest_sha256 !== recovery.target_digest
      );
    })
  )
    return false;
  const expectedBackups = new Set([
    plan.recovery_backup_attempt_id,
    ...evidence.recoveries.map((recovery) => recovery.source_backup_attempt_id),
  ]);
  if (
    expectedBackups.size !== evidence.backups.length ||
    evidence.backups.some((backup) => !expectedBackups.delete(backup.idempotency_key)) ||
    expectedBackups.size !== 0
  )
    return false;
  if (
    !Array.isArray(evidence.idempotency) ||
    evidence.idempotency.length !== 3 ||
    !evidence.idempotency.every(validIdempotencyEvidence)
  )
    return false;
  const dispatch = required(environment, "DISPATCH_DIGEST");
  const expectedIdempotency = [
    [plan.idempotency_key, "prepare_production_release"],
    [`release-dispatch:${dispatch}`, "claim_production_release"],
    [`release-migration-started:${dispatch}`, "production_release_migration_started"],
  ];
  const expectedResponses = [
    stableJson({
      contract: "card-keepr-production-release-request@1",
      release_id: plan.release_id,
      state: "requested",
      dispatch_digest: dispatch,
    }),
    stableJson({ release_id: plan.release_id, state: "preflight", dispatch_digest: dispatch }),
    stableJson({ release_id: plan.release_id, migration_started: true, dispatch_digest: dispatch }),
  ];
  if (
    evidence.idempotency.some(
      (item, index) =>
        item.idempotency_key !== expectedIdempotency[index][0] ||
        item.operation !== expectedIdempotency[index][1] ||
        item.request_json !== stableJson(plan) ||
        item.response_json !== expectedResponses[index] ||
        item.http_status !== 201 ||
        item.outcome !== "success",
    )
  )
    return false;
  const productionRelease = evidence.production_release;
  return (
    validProductionReleaseRow(productionRelease) &&
    productionRelease.id === plan.release_id &&
    productionRelease.state === "migrating" &&
    productionRelease.request_json === stableJson(plan) &&
    productionRelease.idempotency_key === plan.idempotency_key &&
    productionRelease.expected_current_revision_id === plan.expected_current_revision_id &&
    productionRelease.expected_head_sha === plan.expected_head_sha &&
    productionRelease.production_target_digest === plan.production_target_digest &&
    productionRelease.expected_migration_level === plan.expected_migration_level &&
    productionRelease.recovery_bookmark === plan.recovery_bookmark &&
    productionRelease.recovery_backup_attempt_id === plan.recovery_backup_attempt_id &&
    productionRelease.replacement_recovery_id === plan.replacement_handoff.recovery_id &&
    productionRelease.replacement_database_id === plan.replacement_handoff.replacement_database_id &&
    productionRelease.retained_database_id === plan.replacement_handoff.retained_database_id
  );
}

const recoveryKeys = [
  "acceptance_idempotency_key",
  "acceptance_request_digest",
  "accepted_at",
  "current_bookmark",
  "expected_current_revision_id",
  "expected_schema_migration_level",
  "expected_verification_json",
  "failed_at",
  "failure_code",
  "failure_detail",
  "id",
  "idempotency_key",
  "linked_operation_id",
  "method",
  "original_database_id",
  "request_json",
  "restored_at",
  "restored_bookmark",
  "restored_database_id",
  "retained_database_id",
  "source_backup_attempt_id",
  "started_at",
  "state",
  "target_bookmark",
  "target_digest",
  "target_revision_id",
  "undo_bookmark",
  "verification_idempotency_key",
  "verification_json",
  "verification_request_digest",
  "verified_at",
];
function validRecoveryEvidence(row) {
  if (
    !exactKeys(row, recoveryKeys) ||
    !["failed", "awaiting_acceptance"].includes(row.state) ||
    !["time_travel", "replacement_database"].includes(row.method) ||
    !Number.isSafeInteger(row.expected_schema_migration_level) ||
    row.expected_schema_migration_level < 1
  )
    return false;
  const requiredStrings = [
    "id",
    "request_json",
    "idempotency_key",
    "target_revision_id",
    "target_bookmark",
    "target_digest",
    "source_backup_attempt_id",
    "expected_current_revision_id",
    "original_database_id",
    "expected_verification_json",
    "started_at",
  ];
  if (
    requiredStrings.some((key) => typeof row[key] !== "string" || row[key].length === 0) ||
    !/^[0-9a-f]{64}$/u.test(row.target_digest) ||
    !validJson(row.request_json) ||
    !validJson(row.expected_verification_json)
  )
    return false;
  const nullableStrings = recoveryKeys.filter(
    (key) => !requiredStrings.includes(key) && !["expected_schema_migration_level", "state", "method"].includes(key),
  );
  if (
    !nullableStrings.every((key) => row[key] === null || typeof row[key] === "string") ||
    (row.verification_json !== null && !validJson(row.verification_json)) ||
    !isoTimestamp(row.started_at) ||
    ![row.restored_at, row.verified_at, row.accepted_at, row.failed_at].every(
      (value) => value === null || isoTimestamp(value),
    )
  )
    return false;
  return row.state === "awaiting_acceptance"
    ? row.verification_json !== null &&
        row.verification_idempotency_key !== null &&
        row.verification_request_digest !== null &&
        row.verified_at !== null &&
        row.acceptance_idempotency_key === null &&
        row.accepted_at === null &&
        row.failure_code === null &&
        row.failure_detail === null &&
        row.failed_at === null
    : row.failure_code !== null &&
        row.failure_detail !== null &&
        row.failed_at !== null &&
        row.acceptance_idempotency_key === null &&
        row.accepted_at === null;
}

const backupKeys = [
  "catalogue_revision_id",
  "completed_at",
  "content_sha256",
  "d1_bookmark",
  "disposable_database_id",
  "export_bytes",
  "idempotency_key",
  "manifest_key",
  "manifest_sha256",
  "object_key",
  "owner_token",
  "request_json",
  "restore_generation",
  "restore_phase",
  "schema_migration_level",
  "started_at",
];
function validBackupEvidence(row) {
  return (
    exactKeys(row, backupKeys) &&
    [
      "idempotency_key",
      "request_json",
      "owner_token",
      "catalogue_revision_id",
      "object_key",
      "d1_bookmark",
      "manifest_key",
      "disposable_database_id",
    ].every((key) => typeof row[key] === "string" && row[key].length > 0) &&
    validJson(row.request_json) &&
    [row.content_sha256, row.manifest_sha256].every(
      (value) => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value),
    ) &&
    Number.isSafeInteger(row.export_bytes) &&
    row.export_bytes >= 0 &&
    Number.isSafeInteger(row.schema_migration_level) &&
    row.schema_migration_level > 0 &&
    Number.isSafeInteger(row.restore_generation) &&
    row.restore_generation > 0 &&
    row.restore_phase === "verified" &&
    isoTimestamp(row.started_at) &&
    isoTimestamp(row.completed_at)
  );
}

function validIdempotencyEvidence(row) {
  return (
    exactKeys(row, [
      "created_at",
      "http_status",
      "idempotency_key",
      "operation",
      "outcome",
      "request_json",
      "response_json",
    ]) &&
    ["idempotency_key", "operation", "request_json", "response_json", "outcome"].every(
      (key) => typeof row[key] === "string" && row[key].length > 0,
    ) &&
    validJson(row.request_json) &&
    validJson(row.response_json) &&
    Number.isSafeInteger(row.http_status) &&
    row.http_status >= 100 &&
    row.http_status <= 599 &&
    isoTimestamp(row.created_at)
  );
}

function validProductionReleaseRow(row) {
  const keys = [
    "expected_current_revision_id",
    "expected_head_sha",
    "expected_migration_level",
    "id",
    "idempotency_key",
    "recovery_backup_attempt_id",
    "recovery_bookmark",
    "replacement_database_id",
    "replacement_recovery_id",
    "request_json",
    "requested_at",
    "retained_database_id",
    "production_target_digest",
    "state",
  ];
  return (
    exactKeys(row, keys) &&
    keys
      .filter((key) => !["expected_migration_level"].includes(key))
      .every((key) => typeof row[key] === "string" && row[key].length > 0) &&
    validJson(row.request_json) &&
    Number.isSafeInteger(row.expected_migration_level) &&
    row.expected_migration_level > 0 &&
    isoTimestamp(row.requested_at)
  );
}

function replacementTerminalAssertion(evidence, plan) {
  const q = sqlQuote;
  const exactIdempotency = evidence.idempotency
    .map(
      (item) =>
        `EXISTS (SELECT 1 FROM administration_idempotency WHERE idempotency_key=${q(item.idempotency_key)} AND operation=${q(item.operation)} AND request_json=${q(item.request_json)} AND response_json=${q(item.response_json)} AND http_status=${item.http_status} AND outcome=${q(item.outcome)} AND created_at=${q(item.created_at)})`,
    )
    .join(" AND ");
  const exactBackups = evidence.backups
    .map(
      (backup) =>
        `EXISTS (SELECT 1 FROM catalogue_backup_attempts WHERE idempotency_key=${q(backup.idempotency_key)} AND state='verified' AND request_json=${q(backup.request_json)} AND owner_token=${q(backup.owner_token)} AND catalogue_revision_id=${q(backup.catalogue_revision_id)} AND object_key=${q(backup.object_key)} AND d1_bookmark=${q(backup.d1_bookmark)} AND manifest_key=${q(backup.manifest_key)} AND manifest_sha256=${q(backup.manifest_sha256)} AND content_sha256=${q(backup.content_sha256)} AND export_bytes=${backup.export_bytes} AND schema_migration_level=${backup.schema_migration_level} AND disposable_database_id=${q(backup.disposable_database_id)} AND restore_generation=${backup.restore_generation} AND restore_phase='verified')`,
    )
    .join(" AND ");
  const exactRecoveries = evidence.recoveries
    .map(
      (recovery) =>
        `EXISTS (SELECT 1 FROM catalogue_recovery_operations WHERE id=${q(recovery.id)} AND state=${q(recovery.state)} AND method=${q(recovery.method)} AND request_json=${q(recovery.request_json)} AND idempotency_key=${q(recovery.idempotency_key)} AND target_revision_id=${q(recovery.target_revision_id)} AND target_bookmark=${q(recovery.target_bookmark)} AND target_digest=${q(recovery.target_digest)} AND source_backup_attempt_id=${q(recovery.source_backup_attempt_id)} AND linked_operation_id IS ${qNullable(recovery.linked_operation_id)} AND expected_current_revision_id=${q(recovery.expected_current_revision_id)} AND restored_database_id IS ${qNullable(recovery.restored_database_id)} AND retained_database_id IS ${qNullable(recovery.retained_database_id)} AND expected_schema_migration_level=${recovery.expected_schema_migration_level} AND verification_idempotency_key IS ${qNullable(recovery.verification_idempotency_key)} AND verification_request_digest IS ${qNullable(recovery.verification_request_digest)} AND acceptance_idempotency_key IS ${qNullable(recovery.acceptance_idempotency_key)} AND failure_code IS ${qNullable(recovery.failure_code)})`,
    )
    .join(" AND ");
  return `SELECT CASE WHEN EXISTS (SELECT 1 FROM catalogue_schema_state AS schema_state JOIN catalogue_state AS catalogue ON catalogue.singleton=1 JOIN operation_state AS operation ON operation.singleton=1 JOIN production_releases AS release ON release.id=${q(plan.release_id)} WHERE schema_state.singleton=1 AND schema_state.migration_level=${plan.expected_migration_level} AND catalogue.current_revision_id=${q(plan.expected_current_revision_id)} AND operation.active_ingestion_run_id IS NULL AND operation.active_production_release_id=${q(plan.release_id)} AND operation.active_production_release_expires_at=${q(evidence.operation_state.active_production_release_expires_at)} AND operation.recovery_health='blocked' AND operation.active_recovery_id=${q(plan.replacement_handoff.recovery_id)} AND operation.recovery_restore_guard='blocked' AND release.state='migrating' AND release.request_json=${q(stableJson(plan))} AND release.idempotency_key=${q(plan.idempotency_key)} AND release.expected_current_revision_id=${q(plan.expected_current_revision_id)} AND release.expected_head_sha=${q(plan.expected_head_sha)} AND release.production_target_digest=${q(plan.production_target_digest)} AND release.expected_migration_level=${plan.expected_migration_level} AND release.recovery_bookmark=${q(plan.recovery_bookmark)} AND release.recovery_backup_attempt_id=${q(plan.recovery_backup_attempt_id)} AND release.replacement_recovery_id=${q(plan.replacement_handoff.recovery_id)} AND release.replacement_database_id=${q(plan.replacement_handoff.replacement_database_id)} AND release.retained_database_id=${q(plan.replacement_handoff.retained_database_id)} AND ${exactIdempotency} AND ${exactBackups} AND ${exactRecoveries}) THEN 1 ELSE json_extract('invalid','$.replacement_handoff') END AS seeded;`;
}

const recoveryInsertKeys = [
  "id",
  "state",
  "method",
  "request_json",
  "idempotency_key",
  "target_revision_id",
  "target_bookmark",
  "target_digest",
  "source_backup_attempt_id",
  "linked_operation_id",
  "expected_current_revision_id",
  "current_bookmark",
  "restored_bookmark",
  "undo_bookmark",
  "original_database_id",
  "restored_database_id",
  "retained_database_id",
  "expected_schema_migration_level",
  "expected_verification_json",
  "verification_json",
  "verification_idempotency_key",
  "verification_request_digest",
  "acceptance_idempotency_key",
  "acceptance_request_digest",
  "started_at",
  "restored_at",
  "verified_at",
  "accepted_at",
  "failure_code",
  "failure_detail",
  "failed_at",
];
function recoveryValues(row) {
  return recoveryInsertKeys.map((key) => row[key]);
}
function qNullable(value) {
  return value === null ? "NULL" : typeof value === "number" ? String(value) : sqlQuote(value);
}
function validJson(value) {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}
function isoTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && value.includes("T");
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("|") === [...keys].sort().join("|")
  );
}

async function replaceDatabase(source, databaseId, output, ingestion) {
  const document = await readWorkerConfig(source);
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
} else if (process.argv[2] === "replacement-seed") {
  await writeReplacementSeedSql(
    process.env,
    required(process.env, "KEEPR_REPLACEMENT_HANDOFF_EVIDENCE"),
    process.argv[3],
  );
} else if (process.argv[2] === "evidence-sql") {
  await writeEvidenceSql(
    process.argv[3],
    process.argv[4],
    process.env.KEEPR_RELEASE_EVIDENCE,
    process.argv[5],
    process.env,
  );
}
