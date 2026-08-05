import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { validateDispatchAndWriteSql, writeEvidenceSql } from "../scripts/production-release.mjs";

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

test("a durable pre-command marker conservatively terminalizes partial migration failure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-release-migration-marker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environment = releaseEnvironment();
  await validateDispatchAndWriteSql(environment, directory);
  const database = liveGateDatabase(environment);
  database.exec(await readFile(join(directory, "claim.sql"), "utf8"));
  database.exec(await readFile(join(directory, "migration-started.sql"), "utf8"));
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM administration_idempotency WHERE operation='production_release_migration_started'").get().count, 1);
  database.exec(await readFile("migrations/0019_guarded_production_release.sql", "utf8"));
  database.exec(await readFile(join(directory, "failed.sql"), "utf8"));
  assert.deepEqual(
    { ...database.prepare("SELECT state,roll_forward_required FROM production_releases WHERE id='release-47'").get() },
    { state: "failed", roll_forward_required: 1 },
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
    expected_head_sha: "a".repeat(40), expected_migration_level: 19,
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
    INSERT INTO catalogue_schema_state VALUES (1,19);
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
