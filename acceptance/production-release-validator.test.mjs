import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  validateDispatchAndWriteSql,
  writeEvidenceSql,
  writeReplacementSeedSql,
} from "../scripts/production-release.mjs";

test("workflow validator accepts only the exact durably prepared plan", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-release-validator-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environment = releaseEnvironment();
  await validateDispatchAndWriteSql(environment, directory);
  const preflight = await readFile(join(directory, "live-preflight.sql"), "utf8");
  const claim = await readFile(join(directory, "claim.sql"), "utf8");
  const materialize = await readFile(join(directory, "materialize.sql"), "utf8");
  const migrationStarted = await readFile(join(directory, "migration-started.sql"), "utf8");
  assert.match(preflight, /prepare_production_release/u);
  assert.match(preflight, /catalogue_schema_state/u);
  assert.match(preflight, /catalogue_backup_attempts/u);
  assert.match(claim, /production_release_bootstrap/u);
  assert.match(materialize, /'requested'[\s\S]*state='preflight'[\s\S]*state='migrating'/u);
  assert.match(materialize, /transition_rows/u);
  assert.match(migrationStarted, /production_release_migration_started/u);

  const database = liveGateDatabase(environment);
  assert.equal(database.prepare(preflight).get().ready, 1);
  database.exec("UPDATE catalogue_state SET current_revision_id='catrev-stale'");
  assert.equal(database.prepare(preflight).get().ready, 0);
  database.exec(claim);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM administration_idempotency WHERE operation='claim_production_release'").get().count, 0);
  assert.equal(database.prepare("SELECT active_ingestion_run_id FROM operation_state").get().active_ingestion_run_id, null);

  await assert.rejects(
    validateDispatchAndWriteSql({ ...environment, EXPECTED_HEAD_SHA: "b".repeat(40) }, join(directory, "altered")),
    /prepared_plan_mismatch/u,
  );
  await assert.rejects(
    validateDispatchAndWriteSql({ ...environment, DISPATCH_DIGEST: "f".repeat(64) }, join(directory, "direct-ui")),
    /dispatch_digest_mismatch/u,
  );
});

test("replacement handoff exports and seeds the durable release boundary", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-release-handoff-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environment = releaseEnvironment();
  const replacement = {
    recovery_id: "recovery-replacement",
    target_revision_id: environment.EXPECTED_CURRENT_REVISION,
    target_digest: "d".repeat(64),
    replacement_database_id: "replacement-db",
    retained_database_id: "original-db",
  };
  const plan = JSON.parse(environment.PREPARED_PLAN_JSON);
  plan.replacement_handoff = replacement;
  Object.assign(environment, {
    REPLACEMENT_RECOVERY_ID: replacement.recovery_id,
    REPLACEMENT_DATABASE_ID: replacement.replacement_database_id,
    RETAINED_DATABASE_ID: replacement.retained_database_id,
    REPLACEMENT_TARGET_DIGEST: replacement.target_digest,
    PREPARED_PLAN_JSON: stableJson(plan),
    DISPATCH_DIGEST: hash(stableJson(plan)),
  });

  await validateDispatchAndWriteSql(environment, directory);
  const exportSql = await readFile(join(directory, "replacement-handoff.sql"), "utf8");
  assert.match(exportSql, /catalogue_recovery_operations/u);
  assert.match(exportSql, /catalogue_backup_attempts/u);
  assert.match(exportSql, /production_release_migration_started/u);

  await assert.rejects(
    writeReplacementSeedSql(environment, "{}", join(directory, "replacement-seed.sql")),
    /invalid_replacement_handoff_evidence/u,
  );
});

test("replacement release state is rehydrated into a distinct blocked database before activation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-release-d1-handoff-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environment = replacementEnvironment();
  await validateDispatchAndWriteSql(environment, directory);
  const original = await realDatabase();
  const replacement = await realDatabase();
  const failedReplacement = await realDatabase();
  const competingReplacement = await realDatabase();
  t.after(() => [original, replacement, failedReplacement, competingReplacement].forEach((database) => database.close()));
  for (const database of [original, replacement, failedReplacement, competingReplacement]) {
    database.prepare("UPDATE catalogue_state SET current_revision_id=? WHERE singleton=1").run(environment.EXPECTED_CURRENT_REVISION);
  }
  seedOriginalReplacementRelease(original, environment);
  const exportSql = await readFile(join(directory, "replacement-handoff.sql"), "utf8");
  const handoff = original.prepare(exportSql).get().handoff_json;
  const exactHandoff = JSON.parse(handoff);
  assert.equal(
    exactHandoff.contract,
    "card-keepr-replacement-production-release-handoff@2",
  );
  assert.equal(exactHandoff.production_release.id, "release-47");
  assert.equal(Object.hasOwn(exactHandoff, "release"), false);
  const alteredHandoff = JSON.parse(handoff);
  alteredHandoff.production_release.unprepared_key = "must-fail-closed";
  await assert.rejects(
    writeReplacementSeedSql(environment, JSON.stringify(alteredHandoff), join(directory, "altered-seed.sql")),
    /invalid_replacement_handoff_evidence/u,
  );
  const shortenedHandoff = JSON.parse(handoff);
  shortenedHandoff.release = shortenedHandoff.production_release;
  delete shortenedHandoff.production_release;
  await assert.rejects(
    writeReplacementSeedSql(environment, JSON.stringify(shortenedHandoff), join(directory, "shortened-seed.sql")),
    /invalid_replacement_handoff_evidence/u,
  );
  await writeReplacementSeedSql(environment, handoff, join(directory, "replacement-seed.sql"));
  const seedSql = await readFile(join(directory, "replacement-seed.sql"), "utf8");

  replacement.exec(seedSql);
  assert.deepEqual(
    { ...replacement.prepare("SELECT active_ingestion_run_id,active_release_id AS active_production_release_id,recovery_health,active_recovery_id,recovery_restore_guard FROM operation_state WHERE singleton=1").get() },
    { active_ingestion_run_id: null, active_production_release_id: "release-47", recovery_health: "blocked", active_recovery_id: "recovery-replacement", recovery_restore_guard: "blocked" },
  );
  assert.deepEqual(
    replacement.prepare("SELECT id,state FROM catalogue_recovery_operations ORDER BY started_at").all().map((row) => ({ ...row })),
    [{ id: "recovery-failed", state: "failed" }, { id: "recovery-replacement", state: "awaiting_acceptance" }],
  );
  assert.equal(replacement.prepare("SELECT COUNT(*) AS count FROM catalogue_backup_attempts WHERE state='verified'").get().count, 2);
  assert.equal(replacement.prepare("SELECT state FROM production_releases WHERE id='release-47'").get().state, "migrating");
  assert.equal(replacement.prepare("SELECT COUNT(*) AS count FROM production_release_transitions WHERE release_id='release-47'").get().count, 3);
  assert.throws(
    () => replacement.prepare("INSERT INTO ingestion_runs (id,state,selected_games_json,started_at,expected_current_revision_id,idempotency_key,candidate_json) VALUES ('blocked-ingestion','planning','[]','2026-08-05T00:03:00.000Z','catrev_spine_000','blocked-ingestion','{}')").run(),
    /recovery_in_progress/u,
  );
  assert.equal(original.prepare("SELECT state FROM production_releases WHERE id='release-47'").get().state, "migrating");
  assert.equal(original.prepare("SELECT recovery_health FROM operation_state WHERE singleton=1").get().recovery_health, "blocked");

  replacement.exec(await readFile(join(directory, "deploying.sql"), "utf8"));
  await writeEvidenceSql("binding", "release-47", JSON.stringify({ database_id: "replacement-db" }), join(directory, "binding.sql"));
  await writeEvidenceSql("smoke", "release-47", JSON.stringify({ ok: true }), join(directory, "smoke.sql"));
  replacement.exec(await readFile(join(directory, "binding.sql"), "utf8"));
  replacement.exec(await readFile(join(directory, "smoke.sql"), "utf8"));
  assert.deepEqual(
    { ...replacement.prepare("SELECT active_release_id AS active_production_release_id,recovery_health,active_recovery_id,recovery_restore_guard FROM operation_state WHERE singleton=1").get() },
    { active_production_release_id: null, recovery_health: "blocked", active_recovery_id: "recovery-replacement", recovery_restore_guard: "blocked" },
  );
  assert.equal(replacement.prepare("SELECT state FROM catalogue_recovery_operations WHERE id='recovery-replacement'").get().state, "awaiting_acceptance");
  assert.deepEqual(
    { ...original.prepare("SELECT state,binding_observation_json,smoke_evidence_json FROM production_releases WHERE id='release-47'").get() },
    { state: "migrating", binding_observation_json: null, smoke_evidence_json: null },
  );

  failedReplacement.exec(seedSql);
  failedReplacement.exec(await readFile(join(directory, "failure-evidence.sql"), "utf8"));
  failedReplacement.exec(await readFile(join(directory, "failed.sql"), "utf8"));
  failedReplacement.exec(await readFile(join(directory, "cleanup.sql"), "utf8"));
  assert.deepEqual(
    { ...failedReplacement.prepare("SELECT active_release_id AS active_production_release_id,recovery_health,active_recovery_id,recovery_restore_guard FROM operation_state WHERE singleton=1").get() },
    { active_production_release_id: null, recovery_health: "blocked", active_recovery_id: "recovery-replacement", recovery_restore_guard: "blocked" },
  );
  assert.equal(failedReplacement.prepare("SELECT state FROM production_releases WHERE id='release-47'").get().state, "failed");

  competingReplacement.exec("UPDATE operation_state SET active_ingestion_run_id='competing-ingestion' WHERE singleton=1");
  assert.throws(() => competingReplacement.exec(seedSql), /malformed JSON/u);
  assert.deepEqual(
    { ...competingReplacement.prepare("SELECT active_ingestion_run_id,active_release_id AS active_production_release_id,recovery_health,active_recovery_id,recovery_restore_guard FROM operation_state WHERE singleton=1").get() },
    { active_ingestion_run_id: "competing-ingestion", active_production_release_id: null, recovery_health: "healthy", active_recovery_id: null, recovery_restore_guard: "clear" },
  );
});

test("a durable pre-command marker conservatively terminalizes partial migration failure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-release-schema-boundary-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environment = releaseEnvironment();
  await validateDispatchAndWriteSql(environment, directory);
  const database = await realDatabase();
  t.after(() => database.close());
  seedRealReleaseBoundary(database, environment, await readFile(join(directory, "migration-started.sql"), "utf8"));
  database.exec(await readFile(join(directory, "migration-started.sql"), "utf8"));
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM administration_idempotency WHERE operation='production_release_migration_started'").get().count, 1);
  database.exec(await readFile(join(directory, "failure-evidence.sql"), "utf8"));
  const failure = JSON.parse(database.prepare(
    "SELECT response_json FROM administration_idempotency WHERE operation='production_release_migration_failed'",
  ).get().response_json);
  assert.equal(failure.release_id, environment.RELEASE_ID);
  assert.equal(failure.roll_forward_required, true);
  database.exec(await readFile(join(directory, "failed.sql"), "utf8"));
  assert.deepEqual(
    { ...database.prepare("SELECT state,roll_forward_required FROM production_releases WHERE id='release-47'").get() },
    { state: "failed", roll_forward_required: 1 },
  );
  database.exec(await readFile(join(directory, "cleanup.sql"), "utf8"));
  assert.deepEqual(
    { ...database.prepare("SELECT active_ingestion_run_id,active_release_id AS active_production_release_id FROM operation_state WHERE singleton=1").get() },
    { active_ingestion_run_id: null, active_production_release_id: null },
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM ingestion_runs WHERE id LIKE 'release-bootstrap|%'").get().count, 0);
});

test("both Production Release lease vocabularies stay in step", async (t) => {
  const database = await realDatabase();
  t.after(() => database.close());
  const legacyExpiry = "2026-08-05T01:00:00.000Z";
  database.prepare(
    `UPDATE operation_state
     SET active_release_id = ?, active_release_expires_at = ?
     WHERE singleton = 1`,
  ).run("release-legacy", legacyExpiry);
  assert.deepEqual(
    { ...database.prepare(
      `SELECT active_release_id, active_release_expires_at,
              active_production_release_id,
              active_production_release_expires_at
       FROM operation_state WHERE singleton = 1`,
    ).get() },
    {
      active_release_id: "release-legacy",
      active_release_expires_at: legacyExpiry,
      active_production_release_id: "release-legacy",
      active_production_release_expires_at: legacyExpiry,
    },
  );
  const productionExpiry = "2026-08-05T02:00:00.000Z";
  database.prepare(
    `UPDATE operation_state
     SET active_production_release_id = ?,
         active_production_release_expires_at = ?
     WHERE singleton = 1`,
  ).run("release-production", productionExpiry);
  assert.deepEqual(
    { ...database.prepare(
      `SELECT active_release_id, active_release_expires_at
       FROM operation_state WHERE singleton = 1`,
    ).get() },
    {
      active_release_id: "release-production",
      active_release_expires_at: productionExpiry,
    },
  );

  const oldWorkerExpiry = "2026-08-05T03:00:00.000Z";
  database.prepare(
    `UPDATE operation_state
     SET active_release_id = ?, active_release_expires_at = ?
     WHERE singleton = 1`,
  ).run("release-old-worker", oldWorkerExpiry);
  assert.deepEqual(
    { ...database.prepare(
      `SELECT active_production_release_id,
              active_production_release_expires_at
       FROM operation_state WHERE singleton = 1`,
    ).get() },
    {
      active_production_release_id: "release-old-worker",
      active_production_release_expires_at: oldWorkerExpiry,
    },
  );
  assert.throws(
    () => database.exec(
      `UPDATE operation_state
       SET active_production_release_id = NULL
       WHERE singleton = 1`,
    ),
    /production_release_lease_invalid/u,
  );
});

test("zero-row phase transitions are observable and cannot release the fence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-release-zero-row-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await validateDispatchAndWriteSql(releaseEnvironment(), directory);
  await writeEvidenceSql("smoke", "release-47", JSON.stringify({ ok: true }), join(directory, "smoke.sql"));
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE production_releases (id TEXT PRIMARY KEY,state TEXT,api_version_id TEXT,ingestion_version_id TEXT,binding_observation_json TEXT,smoke_evidence_json TEXT,terminal_at TEXT);
    CREATE TABLE operation_state (singleton INTEGER PRIMARY KEY,active_release_id TEXT,active_release_expires_at TEXT);
    INSERT INTO operation_state VALUES (1,'release-47','2099-01-01T00:00:00.000Z');
  `);
  const deploying = statements(await readFile(join(directory, "deploying.sql"), "utf8"));
  database.exec(deploying[0]);
  const deployingResult = database.prepare(deploying[1]).get();
  assert.equal(deployingResult.changed_rows, 0);
  assert.equal(deployingResult.transitioned, 0);
  const smoke = statements(await readFile(join(directory, "smoke.sql"), "utf8"));
  database.exec(smoke[0]);
  const smokeResult = database.prepare(smoke[1]).get();
  assert.equal(smokeResult.changed_rows, 0);
  assert.equal(smokeResult.transitioned, 0);
  database.exec(smoke[2]);
  const fenceResult = database.prepare(smoke[3]).get();
  assert.equal(fenceResult.changed_rows, 0);
  assert.equal(fenceResult.fence_released, 0);
  assert.equal(database.prepare("SELECT active_release_id FROM operation_state").get().active_release_id, "release-47");
});

function releaseEnvironment() {
  const target = {
    cloudflare_account_id: "0123456789abcdef0123456789abcdef",
    worker_scripts: ["card-keepr-api", "card-keepr-ingestion"],
    d1_databases: [
      { name: "card-keepr-catalogue", id: "00000000-0000-0000-0000-000000000001" },
      { name: "card-keepr-disposable-verification", id: "00000000-0000-0000-0000-000000000002" },
    ],
    r2_buckets: ["card-keepr-evidence", "card-keepr-printing-images", "card-keepr-catalogue-exports", "card-keepr-backups"],
  };
  const retained = ["catrev-current", "catrev-previous", "catrev-old"].map((revision_id, depth) => ({ revision_id, depth, export_verified: true, recovery_verified: true }));
  const smoke = smokeTargets();
  const plan = {
    expected_actor: "keepr-release[bot]", expected_current_revision_id: "catrev-current",
    expected_head_sha: "a".repeat(40), expected_migration_level: 1,
    idempotency_key: "release-47-key", production_target: target,
    production_target_digest: hash(stableJson(target)), recovery_backup_attempt_id: "backup-current",
    recovery_bookmark: "bookmark-current", release_id: "release-47", replacement_handoff: null,
    retained_revision_evidence: retained, smoke_targets: smoke,
  };
  return {
    EXPECTED_ACTOR: plan.expected_actor, EXPECTED_CURRENT_REVISION: plan.expected_current_revision_id,
    EXPECTED_HEAD_SHA: plan.expected_head_sha, EXPECTED_MIGRATION_LEVEL: String(plan.expected_migration_level),
    IDEMPOTENCY_KEY: plan.idempotency_key, PRODUCTION_TARGET_JSON: JSON.stringify(target),
    PRODUCTION_TARGET_DIGEST: plan.production_target_digest,
    RECOVERY_BACKUP_ATTEMPT_ID: plan.recovery_backup_attempt_id, RECOVERY_BOOKMARK: plan.recovery_bookmark,
    RELEASE_ID: plan.release_id, REPLACEMENT_RECOVERY_ID: "none", REPLACEMENT_DATABASE_ID: "none",
    RETAINED_DATABASE_ID: "none", REPLACEMENT_TARGET_DIGEST: "none",
    RETAINED_REVISION_EVIDENCE_JSON: JSON.stringify(retained), SMOKE_TARGETS_JSON: JSON.stringify(smoke),
    PREPARED_PLAN_JSON: stableJson(plan), DISPATCH_DIGEST: hash(stableJson(plan)),
  };
}

function replacementEnvironment() {
  const environment = releaseEnvironment();
  const plan = JSON.parse(environment.PREPARED_PLAN_JSON);
  plan.replacement_handoff = {
    recovery_id: "recovery-replacement",
    target_revision_id: plan.expected_current_revision_id,
    target_digest: "d".repeat(64),
    replacement_database_id: "replacement-db",
    retained_database_id: "original-db",
  };
  return {
    ...environment,
    REPLACEMENT_RECOVERY_ID: plan.replacement_handoff.recovery_id,
    REPLACEMENT_DATABASE_ID: plan.replacement_handoff.replacement_database_id,
    RETAINED_DATABASE_ID: plan.replacement_handoff.retained_database_id,
    REPLACEMENT_TARGET_DIGEST: plan.replacement_handoff.target_digest,
    PREPARED_PLAN_JSON: stableJson(plan),
    DISPATCH_DIGEST: hash(stableJson(plan)),
  };
}

function seedOriginalReplacementRelease(database, environment) {
  const plan = JSON.parse(environment.PREPARED_PLAN_JSON);
  const now = "2026-08-05T00:00:00.000Z";
  const backups = [
    { id: plan.recovery_backup_attempt_id, digest: "a".repeat(64), bookmark: plan.recovery_bookmark, owner: "release-backup-owner" },
    { id: "backup-recovery", digest: plan.replacement_handoff.target_digest, bookmark: "bookmark-recovery", owner: "recovery-backup-owner" },
  ];
  for (const [index, backup] of backups.entries()) {
    database.prepare(
      `INSERT INTO catalogue_backup_attempts
       (idempotency_key,request_json,owner_token,catalogue_revision_id,state,object_key,d1_bookmark,
        failure_code,failure_detail,started_at,completed_at,manifest_key,content_sha256,manifest_sha256,
        export_bytes,schema_migration_level,linked_attempt_id,publication_ingestion_run_id,
        disposable_database_id,restore_generation,restore_phase)
       VALUES (?,'{}',?,?,'verified',?, ?,NULL,NULL,?,?,?, ?,?,100,1,NULL,NULL,?,1,'verified')`,
    ).run(
      backup.id,
      backup.owner,
      plan.expected_current_revision_id,
      `backups/${backup.id}.sql`,
      backup.bookmark,
      now,
      now,
      `backups/${backup.id}.manifest.json`,
      String(index + 1).repeat(64),
      backup.digest,
      `disposable-${index}`,
    );
  }
  const recoverySql = `INSERT INTO catalogue_recovery_operations
    (id,state,method,request_json,idempotency_key,target_revision_id,target_bookmark,target_digest,
     source_backup_attempt_id,linked_operation_id,expected_current_revision_id,current_bookmark,
     restored_bookmark,undo_bookmark,original_database_id,restored_database_id,retained_database_id,
     expected_schema_migration_level,expected_verification_json,verification_json,
     verification_idempotency_key,verification_request_digest,acceptance_idempotency_key,
     acceptance_request_digest,started_at,restored_at,verified_at,accepted_at,failure_code,failure_detail,failed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  database.prepare(recoverySql).run(
    "recovery-failed", "failed", "time_travel", "{}", "recovery-failed-key",
    plan.expected_current_revision_id, "bookmark-recovery", plan.replacement_handoff.target_digest,
    "backup-recovery", null, plan.expected_current_revision_id, "bookmark-current", null, null,
    "original-db", null, null, 1, "{}", null, null, null, null, null,
    now, null, null, null, "restore_failed", "retry with replacement", "2026-08-05T00:01:00.000Z",
  );
  database.prepare(recoverySql).run(
    plan.replacement_handoff.recovery_id, "awaiting_acceptance", "replacement_database", "{}", "recovery-replacement-key",
    plan.expected_current_revision_id, "bookmark-recovery", plan.replacement_handoff.target_digest,
    "backup-recovery", "recovery-failed", plan.expected_current_revision_id, "bookmark-current", "bookmark-restored", null,
    "original-db", plan.replacement_handoff.replacement_database_id, plan.replacement_handoff.retained_database_id,
    1, "{}", "{}", "recovery-verify-key", "e".repeat(64), null, null,
    "2026-08-05T00:01:01.000Z", "2026-08-05T00:01:02.000Z", "2026-08-05T00:01:03.000Z", null, null, null, null,
  );
  const dispatch = environment.DISPATCH_DIGEST;
  const idempotency = [
    [plan.idempotency_key, "prepare_production_release", stableJson({ contract: "card-keepr-production-release-request@1", release_id: plan.release_id, state: "requested", dispatch_digest: dispatch })],
    [`release-dispatch:${dispatch}`, "claim_production_release", stableJson({ release_id: plan.release_id, state: "preflight", dispatch_digest: dispatch })],
    [`release-migration-started:${dispatch}`, "production_release_migration_started", stableJson({ release_id: plan.release_id, migration_started: true, dispatch_digest: dispatch })],
  ];
  for (const [index, [key, operation, response]] of idempotency.entries()) {
    database.prepare("INSERT INTO administration_idempotency (idempotency_key,operation,request_json,response_json,http_status,outcome,created_at) VALUES (?,?,?,?,201,'success',?)").run(
      key, operation, environment.PREPARED_PLAN_JSON, response, `2026-08-05T00:02:0${index}.000Z`,
    );
  }
  database.prepare(
    `INSERT INTO production_releases
     (id,state,request_json,idempotency_key,expected_current_revision_id,expected_head_sha,
      production_target_digest,expected_migration_level,recovery_bookmark,recovery_backup_attempt_id,
      replacement_recovery_id,replacement_database_id,retained_database_id,requested_at)
     VALUES (?,'requested',?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    plan.release_id, environment.PREPARED_PLAN_JSON, plan.idempotency_key, plan.expected_current_revision_id,
    plan.expected_head_sha, plan.production_target_digest, plan.expected_migration_level, plan.recovery_bookmark,
    plan.recovery_backup_attempt_id, plan.replacement_handoff.recovery_id,
    plan.replacement_handoff.replacement_database_id, plan.replacement_handoff.retained_database_id, now,
  );
  database.prepare("UPDATE production_releases SET state='preflight' WHERE id=?").run(plan.release_id);
  database.prepare("UPDATE production_releases SET state='migrating' WHERE id=?").run(plan.release_id);
  database.prepare(
    "UPDATE operation_state SET active_ingestion_run_id=NULL,active_release_id=?,active_release_expires_at='2026-08-05T01:00:00.000Z',recovery_health='blocked',active_recovery_id=?,recovery_restore_guard='blocked' WHERE singleton=1",
  ).run(plan.release_id, plan.replacement_handoff.recovery_id);
}

function liveGateDatabase(environment) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE administration_idempotency (idempotency_key TEXT PRIMARY KEY,operation TEXT,request_json TEXT,response_json TEXT,http_status INTEGER,outcome TEXT,created_at TEXT);
    CREATE TABLE catalogue_state (singleton INTEGER PRIMARY KEY,current_revision_id TEXT);
    CREATE TABLE operation_state (singleton INTEGER PRIMARY KEY,active_ingestion_run_id TEXT,active_release_id TEXT,active_release_expires_at TEXT,recovery_health TEXT,active_recovery_id TEXT);
    CREATE TABLE catalogue_schema_state (singleton INTEGER PRIMARY KEY,migration_level INTEGER);
    CREATE TABLE catalogue_backup_attempts (idempotency_key TEXT PRIMARY KEY,catalogue_revision_id TEXT,state TEXT,d1_bookmark TEXT,manifest_sha256 TEXT);
    CREATE TABLE catalogue_revisions (id TEXT PRIMARY KEY,expected_previous_revision_id TEXT);
    CREATE TABLE catalogue_exports (catalogue_revision_id TEXT PRIMARY KEY,verified INTEGER,maintenance_state TEXT);
    CREATE TABLE catalogue_recovery_operations (id TEXT PRIMARY KEY,state TEXT,method TEXT,target_revision_id TEXT,target_digest TEXT,restored_database_id TEXT,retained_database_id TEXT,verification_json TEXT);
    CREATE TABLE catalogue_query_revisions (catalogue_revision_id TEXT PRIMARY KEY,state TEXT);
    CREATE TABLE ingestion_runs (id TEXT PRIMARY KEY,state TEXT,selected_games_json TEXT,started_at TEXT,expected_current_revision_id TEXT,idempotency_key TEXT,candidate_json TEXT);
    CREATE TABLE ingestion_run_transitions (ingestion_run_id TEXT);
    INSERT INTO catalogue_state VALUES (1,'catrev-current');
    INSERT INTO operation_state VALUES (1,NULL,NULL,NULL,'healthy',NULL);
    INSERT INTO catalogue_schema_state VALUES (1,1);
    INSERT INTO catalogue_revisions VALUES ('catrev-current','catrev-previous'),('catrev-previous','catrev-old'),('catrev-old',NULL);
    INSERT INTO catalogue_exports VALUES ('catrev-current',1,'available'),('catrev-previous',1,'available'),('catrev-old',1,'available');
    INSERT INTO catalogue_backup_attempts VALUES ('backup-current','catrev-current','verified','bookmark-current','${"a".repeat(64)}'),('backup-previous','catrev-previous','verified','bookmark-previous','${"b".repeat(64)}'),('backup-old','catrev-old','verified','bookmark-old','${"c".repeat(64)}');
    INSERT INTO catalogue_query_revisions VALUES ('catrev-archived','archived');
  `);
  const plan = environment.PREPARED_PLAN_JSON;
  db.prepare("INSERT INTO administration_idempotency VALUES (?,?,?,?,201,'success','2026-08-05T00:00:00.000Z')").run(
    environment.IDEMPOTENCY_KEY, "prepare_production_release", plan,
    stableJson({ contract: "card-keepr-production-release-request@1", release_id: environment.RELEASE_ID, state: "requested", dispatch_digest: environment.DISPATCH_DIGEST }),
  );
  return db;
}

async function realDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const migration of (await readdir("migrations")).sort()) {
    database.exec(await readFile(join("migrations", migration), "utf8"));
  }
  return database;
}

function seedRealReleaseBoundary(database, environment, migrationStartedSql) {
  const bootstrap = /active_ingestion_run_id='([^']+)'/u.exec(migrationStartedSql)?.[1];
  assert.ok(bootstrap);
  database.prepare(
    "INSERT INTO administration_idempotency (idempotency_key,operation,request_json,response_json,http_status,outcome,created_at) VALUES (?,?,?,?,201,'success','2026-08-05T00:00:00.000Z')",
  ).run(
    environment.IDEMPOTENCY_KEY,
    "prepare_production_release",
    environment.PREPARED_PLAN_JSON,
    stableJson({ contract: "card-keepr-production-release-request@1", release_id: environment.RELEASE_ID, state: "requested", dispatch_digest: environment.DISPATCH_DIGEST }),
  );
  database.prepare(
    "INSERT INTO administration_idempotency (idempotency_key,operation,request_json,response_json,http_status,outcome,created_at) VALUES (?,?,?,?,201,'success','2026-08-05T00:00:01.000Z')",
  ).run(
    `release-dispatch:${environment.DISPATCH_DIGEST}`,
    "claim_production_release",
    environment.PREPARED_PLAN_JSON,
    stableJson({ release_id: environment.RELEASE_ID, state: "preflight", dispatch_digest: environment.DISPATCH_DIGEST }),
  );
  database.prepare(
    `INSERT INTO ingestion_runs (id,state,selected_games_json,started_at,
     expected_current_revision_id,idempotency_key,candidate_json)
     VALUES (?,'planning','[]','2026-08-05T00:00:01.000Z',?,?,
     '{"production_release_bootstrap":true}')`,
  ).run(bootstrap, environment.EXPECTED_CURRENT_REVISION, bootstrap);
  database.prepare(
    "UPDATE operation_state SET active_ingestion_run_id=? WHERE singleton=1",
  ).run(bootstrap);
  database.prepare(
    `INSERT INTO catalogue_backup_attempts
     (idempotency_key,request_json,owner_token,catalogue_revision_id,state,
      object_key,d1_bookmark,failure_code,failure_detail,started_at,completed_at)
     VALUES (?,'{}','release-backup-owner',?,'pending',?,NULL,NULL,NULL,
     '2026-08-05T00:00:00.000Z',NULL)`,
  ).run(
    environment.RECOVERY_BACKUP_ATTEMPT_ID,
    environment.EXPECTED_CURRENT_REVISION,
    "backups/release.sql",
  );
}

function smokeTargets() {
  return {
    revisions: ["catrev-current", "catrev-previous", "catrev-old"].map((revision_id, index) => ({
      revision_id, card_id: `card-${index}`, printing_id: `printing-${index}`,
      search_query: `card-${index}`, card_cursor: `card-cursor-${index}`,
      search_cursor: `search-cursor-${index}`, printing_cursor: `printing-cursor-${index}`,
    })),
    printing_image_id: "image-1", legality_card_id: "card-0", legality_format: "standard",
    legality_region: "EN-OCEANIA", stale_cursor: Buffer.from(JSON.stringify({ revision_id: "catrev-archived" })).toString("base64"),
    stale_revision_id: "catrev-archived",
  };
}

function statements(sql) { return sql.split(/;\s*/u).filter((item) => item.trim().length > 0); }

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function stableJson(value) { if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`; if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`; return JSON.stringify(value); }
