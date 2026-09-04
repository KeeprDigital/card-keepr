import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  validateDispatchAndWriteSql,
  writeEvidenceSql,
  writeReplacementSeedSql,
} from "../scripts/production-release.mjs";
import * as productionReleaseQueries from "./helpers/query-helpers/production-release.mjs";

// realDatabase() applies every file in migrations/, so the plans below bind
// the level the newest migration records rather than pinning one.
const currentSchemaMigrationLevel = Number.parseInt(
  (await readdir("migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .at(-1) ?? "",
  10,
);
assert.ok(Number.isSafeInteger(currentSchemaMigrationLevel));

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
  assert.match(claim, /active_production_release_id/u);
  assert.doesNotMatch(claim, /(?:INTO|UPDATE|FROM) ingestion_runs/u);
  assert.match(materialize, /'requested'[\s\S]*state='preflight'[\s\S]*state='migrating'/u);
  assert.match(materialize, /request_json=.*idempotency_key=.*prepare_production_release/u);
  assert.match(migrationStarted, /production_release_migration_started/u);

  const database = liveGateDatabase(environment);
  assert.equal(database.prepare(preflight).get().ready, 1);
  database.exec("UPDATE catalogue_state SET current_revision_id='catrev-stale'");
  assert.equal(database.prepare(preflight).get().ready, 0);
  database.exec(claim);
  assert.equal(productionReleaseQueries.countDispatchClaims(database).get().count, 0);
  assert.equal(productionReleaseQueries.activeIngestionIdentity(database).get().active_ingestion_run_id, null);

  await assert.rejects(
    validateDispatchAndWriteSql({ ...environment, EXPECTED_HEAD_SHA: "b".repeat(40) }, join(directory, "altered")),
    /prepared_plan_mismatch/u,
  );
  // The workflow binds the server-issued bytes and digest to immutable D1
  // preparation evidence before acquiring its lease; it does not hash locally.
  for (const [name, changed] of [
    ["direct-ui", { DISPATCH_DIGEST: "f".repeat(64) }],
    ["changed-bytes", { PREPARED_PLAN_JSON: JSON.stringify(JSON.parse(environment.PREPARED_PLAN_JSON), null, 2) }],
  ]) {
    const altered = join(directory, name);
    await validateDispatchAndWriteSql({ ...environment, ...changed }, altered);
    const authority = liveGateDatabase(environment);
    t.after(() => authority.close());
    assert.equal(authority.prepare(await readFile(join(altered, "live-preflight.sql"), "utf8")).get().ready, 0);
    authority.exec(await readFile(join(altered, "claim.sql"), "utf8"));
    assert.equal(productionReleaseQueries.countDispatchClaims(authority).get().count, 0);
  }
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
  t.after(() =>
    [original, replacement, failedReplacement, competingReplacement].forEach((database) => {
      database.close();
    }),
  );
  for (const database of [original, replacement, failedReplacement, competingReplacement]) {
    productionReleaseQueries.setCurrentCatalogueRevision(database).run(environment.EXPECTED_CURRENT_REVISION);
  }
  seedOriginalReplacementRelease(original, environment);
  const leaseExpiry = /active_production_release_expires_at='([^']+)'/u.exec(
    await readFile(join(directory, "migration-started.sql"), "utf8"),
  )?.[1];
  assert.ok(leaseExpiry);
  productionReleaseQueries.setReleaseLease(original).run(environment.RELEASE_ID, leaseExpiry);
  const exportSql = await readFile(join(directory, "replacement-handoff.sql"), "utf8");
  const handoff = original.prepare(exportSql).get().handoff_json;
  const exactHandoff = JSON.parse(handoff);
  assert.equal(exactHandoff.contract, "card-keepr-replacement-production-release-handoff@2");
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

  const claimedHandoffKey = exactHandoff.idempotency[0].idempotency_key;
  productionReleaseQueries.insertReleaseOutcomeClaim(competingReplacement).run(claimedHandoffKey);
  assert.throws(() => competingReplacement.exec(seedSql), /administration_idempotency_owner_changed/);
  assert.equal(productionReleaseQueries.countReleaseOutcome(competingReplacement).get(claimedHandoffKey).count, 0);
  productionReleaseQueries.deleteReleaseOutcomeClaim(competingReplacement).run(claimedHandoffKey);

  replacement.exec(seedSql);
  assert.deepEqual(
    { ...productionReleaseQueries.replacementOperationState(replacement).get() },
    {
      active_ingestion_run_id: null,
      active_production_release_id: "release-47",
      recovery_health: "blocked",
      active_recovery_id: "recovery-replacement",
      recovery_restore_guard: "blocked",
    },
  );
  assert.deepEqual(
    productionReleaseQueries
      .recoveryStatesByStart(replacement)
      .all()
      .map((row) => ({ ...row })),
    [
      { id: "recovery-failed", state: "failed" },
      { id: "recovery-replacement", state: "awaiting_acceptance" },
    ],
  );
  assert.equal(productionReleaseQueries.countVerifiedBackups(replacement).get().count, 2);
  assert.equal(productionReleaseQueries.release47State(replacement).get().state, "migrating");

  // The run-start repository owns recovery admission; its trigger-disabled
  // runtime tests prove the blocked health/restore states reject new runs.
  assert.equal(productionReleaseQueries.release47State(original).get().state, "migrating");
  assert.equal(productionReleaseQueries.recoveryHealth(original).get().recovery_health, "blocked");

  replacement.exec(await readFile(join(directory, "deploying.sql"), "utf8"));
  await writeEvidenceSql(
    "binding",
    "release-47",
    JSON.stringify({ database_id: "replacement-db" }),
    join(directory, "binding.sql"),
  );
  await writeEvidenceSql("smoke", "release-47", JSON.stringify({ ok: true }), join(directory, "smoke.sql"));
  replacement.exec(await readFile(join(directory, "binding.sql"), "utf8"));
  replacement.exec(await readFile(join(directory, "smoke.sql"), "utf8"));
  assert.deepEqual(
    { ...productionReleaseQueries.replacementLeaseAndRecoveryState(replacement).get() },
    {
      active_production_release_id: null,
      recovery_health: "blocked",
      active_recovery_id: "recovery-replacement",
      recovery_restore_guard: "blocked",
    },
  );
  assert.equal(productionReleaseQueries.replacementRecoveryState(replacement).get().state, "awaiting_acceptance");
  assert.deepEqual(
    { ...productionReleaseQueries.release47ExecutionEvidence(original).get() },
    { state: "migrating", binding_observation_json: null, smoke_evidence_json: null },
  );

  failedReplacement.exec(seedSql);
  failedReplacement.exec(await readFile(join(directory, "failure-evidence.sql"), "utf8"));
  failedReplacement.exec(await readFile(join(directory, "failed.sql"), "utf8"));
  failedReplacement.exec(await readFile(join(directory, "cleanup.sql"), "utf8"));
  assert.deepEqual(
    { ...productionReleaseQueries.replacementLeaseAndRecoveryState(failedReplacement).get() },
    {
      active_production_release_id: null,
      recovery_health: "blocked",
      active_recovery_id: "recovery-replacement",
      recovery_restore_guard: "blocked",
    },
  );
  assert.equal(productionReleaseQueries.release47State(failedReplacement).get().state, "failed");

  competingReplacement.exec(
    "UPDATE operation_state SET active_ingestion_run_id='competing-ingestion' WHERE singleton=1",
  );
  assert.throws(() => competingReplacement.exec(seedSql), /malformed JSON/u);
  assert.deepEqual(
    { ...productionReleaseQueries.replacementOperationState(competingReplacement).get() },
    {
      active_ingestion_run_id: "competing-ingestion",
      active_production_release_id: null,
      recovery_health: "healthy",
      active_recovery_id: null,
      recovery_restore_guard: "clear",
    },
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
  assert.equal(productionReleaseQueries.countMigrationStartedEvidence(database).get().count, 1);
  assert.equal(lastRow(database, await readFile(join(directory, "cleanup.sql"), "utf8")).fence_released, 0);
  assert.equal(
    productionReleaseQueries.activeReleaseIdentity(database).get().active_production_release_id,
    environment.RELEASE_ID,
  );
  database.exec(await readFile(join(directory, "failure-evidence.sql"), "utf8"));
  const failure = JSON.parse(productionReleaseQueries.migrationFailureResponse(database).get().response_json);
  assert.equal(failure.release_id, environment.RELEASE_ID);
  assert.equal(failure.roll_forward_required, true);
  database.exec(await readFile(join(directory, "failed.sql"), "utf8"));
  assert.deepEqual(
    { ...productionReleaseQueries.release47FailureState(database).get() },
    { state: "failed", roll_forward_required: 1 },
  );
  database.exec(await readFile(join(directory, "cleanup.sql"), "utf8"));
  assert.deepEqual(
    { ...productionReleaseQueries.activeOperationIdentities(database).get() },
    { active_ingestion_run_id: null, active_production_release_id: null },
  );
  assert.equal(productionReleaseQueries.countBootstrapFenceRuns(database).get().count, 0);
});

test("zero-row phase transitions are observable and cannot release the fence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-release-zero-row-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await validateDispatchAndWriteSql(releaseEnvironment(), directory);
  await writeEvidenceSql("smoke", "release-47", JSON.stringify({ ok: true }), join(directory, "smoke.sql"));
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE production_releases (id TEXT PRIMARY KEY,state TEXT,api_version_id TEXT,ingestion_version_id TEXT,binding_observation_json TEXT,smoke_evidence_json TEXT,terminal_at TEXT);
    CREATE TABLE operation_state (singleton INTEGER PRIMARY KEY,active_production_release_id TEXT,active_production_release_expires_at TEXT);
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
  assert.equal(
    productionReleaseQueries.activeReleaseIdentity(database).get().active_production_release_id,
    "release-47",
  );
});

test("a Bootstrap Mode dispatch relaxes only the data-dependent gates and keeps every durable write in the idempotency ledger", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-release-bootstrap-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environment = bootstrapEnvironment();
  const plan = await validateDispatchAndWriteSql(environment, directory);
  assert.equal(plan.bootstrap, true);
  const files = (await readdir(directory)).sort();
  // No production_releases row can exist without a verified backup, so the
  // bootstrap branch writes no failed.sql: a failure releases the fence and
  // is retained in the idempotency ledger, with nothing to roll back to.
  assert.deepEqual(files, [
    "claim.sql",
    "cleanup.sql",
    "deploying.sql",
    "failure-evidence.sql",
    "live-preflight.sql",
    "materialize.sql",
    "migration-started.sql",
    "migration-status.sql",
    "post-schema-status.sql",
  ]);
  const preflight = await readFile(join(directory, "live-preflight.sql"), "utf8");
  assert.match(preflight, /NOT EXISTS \(SELECT 1 FROM catalogue_revisions\)/u);
  assert.match(preflight, /current_revision_id='catrev_spine_000'/u);
  assert.match(preflight, /catalogue_schema_state/u);
  assert.doesNotMatch(preflight, /catalogue_backup_attempts|catalogue_exports|catalogue_query_revisions/u);
  for (const file of files) {
    assert.doesNotMatch(await readFile(join(directory, file), "utf8"), /(?:INTO|UPDATE) production_releases\b/u, file);
  }

  const database = await realDatabase();
  t.after(() => database.close());
  seedPreparedRequest(database, environment);
  assert.equal(database.prepare(preflight).get().ready, 1);
  assert.equal(lastRow(database, await readFile(join(directory, "claim.sql"), "utf8")).claimed, 1);
  assert.equal(productionReleaseQueries.countIngestionRuns(database).get().count, 0);
  assert.deepEqual(
    { ...productionReleaseQueries.activeOperationIdentities(database).get() },
    {
      active_ingestion_run_id: null,
      active_production_release_id: environment.RELEASE_ID,
    },
  );
  // Holding a lease alone does not prove that migration work was authorized.
  assert.equal(lastRow(database, await readFile(join(directory, "materialize.sql"), "utf8")).transferred, 0);
  assert.equal(
    lastRow(database, await readFile(join(directory, "migration-started.sql"), "utf8")).migration_started,
    1,
  );
  assert.equal(lastRow(database, await readFile(join(directory, "materialize.sql"), "utf8")).transferred, 1);
  assert.deepEqual(
    { ...productionReleaseQueries.activeOperationIdentities(database).get() },
    { active_ingestion_run_id: null, active_production_release_id: "release-0" },
  );
  assert.equal(productionReleaseQueries.countIngestionRuns(database).get().count, 0);
  const deploying = lastRow(database, await readFile(join(directory, "deploying.sql"), "utf8"));
  assert.deepEqual({ ...deploying }, { changed_rows: 1, transitioned: 1 });
  await writeEvidenceSql(
    "binding",
    "release-0",
    JSON.stringify({ worker_database_ids: {} }),
    join(directory, "binding.sql"),
    environment,
  );
  const binding = lastRow(database, await readFile(join(directory, "binding.sql"), "utf8"));
  assert.deepEqual({ ...binding }, { changed_rows: 1, transitioned: 1 });
  await writeEvidenceSql(
    "smoke",
    "release-0",
    JSON.stringify({ contract: "card-keepr-production-bootstrap-smoke@1" }),
    join(directory, "smoke.sql"),
    environment,
  );
  const smokeRows = allResultRows(database, await readFile(join(directory, "smoke.sql"), "utf8"));
  assert.deepEqual(smokeRows.at(-2), { changed_rows: 1, transitioned: 1 });
  assert.deepEqual(smokeRows.at(-1), { changed_rows: 1, fence_released: 1 });
  assert.deepEqual(
    { ...productionReleaseQueries.operationLease(database).get() },
    { active_ingestion_run_id: null, active_production_release_id: null, active_production_release_expires_at: null },
  );
  assert.equal(productionReleaseQueries.countProductionReleases(database).get().count, 0);
  assert.deepEqual(
    productionReleaseQueries
      .administrationOperationsInOrder(database)
      .all()
      .map((row) => row.operation),
    [
      "prepare_production_release",
      "claim_production_release",
      "production_release_migration_started",
      "production_release_deploying",
      "production_release_binding_observed",
      "production_release_succeeded",
    ],
  );
  // A second Bootstrap Mode Production Release is allowed while the catalogue stays empty.
  assert.equal(database.prepare(preflight).get().ready, 1);

  // Once a Catalogue Revision exists the same dispatch is refused live.
  const populated = await realDatabase();
  t.after(() => populated.close());
  seedPreparedRequest(populated, environment);
  publishRevision(populated, "catrev_first");
  assert.equal(populated.prepare(preflight).get().ready, 0);
  assert.equal(lastRow(populated, await readFile(join(directory, "claim.sql"), "utf8")).claimed, 0);
  assert.equal(
    productionReleaseQueries.activeSingletonIngestionIdentity(populated).get().active_ingestion_run_id,
    null,
  );

  // The workflow input and the prepared plan must agree on Bootstrap Mode.
  await assert.rejects(
    validateDispatchAndWriteSql({ ...environment, BOOTSTRAP: "false" }, join(directory, "mismatch")),
    /bootstrap_mismatch/u,
  );
  const populatedEnvironment = releaseEnvironment();
  await assert.rejects(
    validateDispatchAndWriteSql({ ...populatedEnvironment, BOOTSTRAP: "true" }, join(directory, "mismatch-populated")),
    /bootstrap_mismatch/u,
  );
});

test("a healthy release cannot claim while its restore guard remains blocked", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-release-restore-guard-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environment = bootstrapEnvironment();
  await validateDispatchAndWriteSql(environment, directory);
  const database = await realDatabase();
  t.after(() => database.close());
  seedPreparedRequest(database, environment);
  productionReleaseQueries.blockReleaseRestoreGuard(database).run();
  const preflight = await readFile(join(directory, "live-preflight.sql"), "utf8");
  assert.equal(database.prepare(preflight).get().ready, 0);
  assert.equal(lastRow(database, await readFile(join(directory, "claim.sql"), "utf8")).claimed, 0);
  assert.equal(productionReleaseQueries.countDispatchClaims(database).get().count, 0);
  assert.equal(productionReleaseQueries.countBootstrapFenceRuns(database).get().count, 0);
});

test("every generated ledger phase rejects a competing owner and preserves zero-row phases", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-release-outcome-owner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environment = bootstrapEnvironment();
  await validateDispatchAndWriteSql(environment, directory);
  for (const kind of ["binding", "smoke"]) {
    await writeEvidenceSql(kind, environment.RELEASE_ID, "{}", join(directory, `${kind}.sql`), environment);
  }
  const database = await realDatabase();
  t.after(() => database.close());
  seedPreparedRequest(database, environment);
  for (const [file, prefix] of [
    ["claim", "release-dispatch"],
    ["migration-started", "release-migration-started"],
    ["failure-evidence", "release-migration-failed"],
    ["deploying", "release-deploying"],
    ["binding", "release-binding"],
    ["smoke", "release-smoke"],
  ]) {
    const key = `${prefix}:${environment.DISPATCH_DIGEST}`;
    const sql = await readFile(join(directory, `${file}.sql`), "utf8");
    productionReleaseQueries.insertReleaseOutcomeClaim(database).run(key);
    // A phase with no predecessor must stay a no-op even if its target key is claimed.
    if (file === "claim") {
      const unavailable = await readFile(join(directory, "binding.sql"), "utf8");
      const unavailableKey = `release-binding:${environment.DISPATCH_DIGEST}`;
      productionReleaseQueries.insertReleaseOutcomeClaim(database).run(unavailableKey);
      assert.equal(lastRow(database, unavailable).changed_rows, 0);
      productionReleaseQueries.deleteReleaseOutcomeClaim(database).run(unavailableKey);
    }
    const previousLease = { ...productionReleaseQueries.operationLease(database).get() };
    assert.throws(() => database.exec(sql), /administration_idempotency_owner_changed/, file);
    assert.equal(productionReleaseQueries.countReleaseOutcome(database).get(key).count, 0, file);
    assert.deepEqual({ ...productionReleaseQueries.operationLease(database).get() }, previousLease);
    productionReleaseQueries.deleteReleaseOutcomeClaim(database).run(key);
    database.exec(sql);
    assert.equal(productionReleaseQueries.countReleaseOutcome(database).get(key).count, 1, file);
    if (file === "migration-started") database.exec(await readFile(join(directory, "materialize.sql"), "utf8"));
  }
});

function bootstrapEnvironment() {
  const environment = releaseEnvironment();
  const plan = JSON.parse(environment.PREPARED_PLAN_JSON);
  Object.assign(plan, {
    bootstrap: true,
    expected_current_revision_id: "catrev_spine_000",
    release_id: "release-0",
    idempotency_key: "release-0-key",
    recovery_bookmark: null,
    recovery_backup_attempt_id: null,
    smoke_targets: null,
    retained_revision_evidence: null,
    replacement_handoff: null,
  });
  return {
    ...environment,
    BOOTSTRAP: "true",
    RELEASE_ID: plan.release_id,
    IDEMPOTENCY_KEY: plan.idempotency_key,
    EXPECTED_CURRENT_REVISION: plan.expected_current_revision_id,
    RECOVERY_BACKUP_ATTEMPT_ID: "none",
    RECOVERY_BOOKMARK: "none",
    SMOKE_TARGETS_JSON: "null",
    RETAINED_REVISION_EVIDENCE_JSON: "null",
    PREPARED_PLAN_JSON: stableJson(plan),
    DISPATCH_DIGEST: hash(stableJson(plan)),
  };
}

function seedPreparedRequest(database, environment) {
  productionReleaseQueries.insertBootstrapAdministrationEvidence(database).run(
    environment.IDEMPOTENCY_KEY,
    "prepare_production_release",
    environment.PREPARED_PLAN_JSON,
    stableJson({
      prepared_plan_json: environment.PREPARED_PLAN_JSON,
      dispatch_inputs: {
        prepared_plan_json: environment.PREPARED_PLAN_JSON,
        dispatch_digest: environment.DISPATCH_DIGEST,
      },
      contract: "card-keepr-production-release-request@1",
      release_id: environment.RELEASE_ID,
      state: "requested",
      dispatch_digest: environment.DISPATCH_DIGEST,
    }),
  );
}

function publishRevision(database, revision) {
  database.exec("DROP TRIGGER IF EXISTS guard_catalogue_publication");
  productionReleaseQueries.insertFirstIngestionRun(database).run();
  productionReleaseQueries.insertFirstCatalogueRevision(database).run(revision, "b".repeat(64), "a".repeat(64));
  productionReleaseQueries.publishFirstCatalogueRevision(database).run(revision);
}

function lastRow(database, sql) {
  return allResultRows(database, sql).at(-1);
}

function allResultRows(database, sql) {
  const rows = [];
  for (const statement of statements(sql)) {
    const prepared = database.prepare(statement);
    if (/^\s*SELECT/iu.test(statement)) rows.push({ ...prepared.get() });
    else prepared.run();
  }
  return rows;
}

function releaseEnvironment() {
  const target = {
    cloudflare_account_id: "0123456789abcdef0123456789abcdef",
    worker_scripts: ["card-keepr-api", "card-keepr-ingestion"],
    d1_databases: [
      { name: "card-keepr-catalogue", id: "00000000-0000-0000-0000-000000000001" },
      { name: "card-keepr-disposable-verification", id: "00000000-0000-0000-0000-000000000002" },
    ],
    r2_buckets: [
      "card-keepr-evidence",
      "card-keepr-printing-images",
      "card-keepr-catalogue-exports",
      "card-keepr-backups",
    ],
  };
  const retained = ["catrev-current", "catrev-previous", "catrev-old"].map((revision_id, depth) => ({
    revision_id,
    depth,
    export_verified: true,
    recovery_verified: true,
  }));
  const smoke = smokeTargets();
  const plan = {
    expected_actor: "keepr-release[bot]",
    expected_current_revision_id: "catrev-current",
    expected_head_sha: "a".repeat(40),
    expected_migration_level: currentSchemaMigrationLevel,
    bootstrap: false,
    idempotency_key: "release-47-key",
    production_target: target,
    production_target_digest: hash(stableJson(target)),
    recovery_backup_attempt_id: "backup-current",
    recovery_bookmark: "bookmark-current",
    release_id: "release-47",
    replacement_handoff: null,
    retained_revision_evidence: retained,
    smoke_targets: smoke,
  };
  return {
    EXPECTED_ACTOR: plan.expected_actor,
    EXPECTED_CURRENT_REVISION: plan.expected_current_revision_id,
    EXPECTED_HEAD_SHA: plan.expected_head_sha,
    EXPECTED_MIGRATION_LEVEL: String(plan.expected_migration_level),
    IDEMPOTENCY_KEY: plan.idempotency_key,
    PRODUCTION_TARGET_JSON: JSON.stringify(target),
    PRODUCTION_TARGET_DIGEST: plan.production_target_digest,
    BOOTSTRAP: "false",
    RECOVERY_BACKUP_ATTEMPT_ID: plan.recovery_backup_attempt_id,
    RECOVERY_BOOKMARK: plan.recovery_bookmark,
    RELEASE_ID: plan.release_id,
    REPLACEMENT_RECOVERY_ID: "none",
    REPLACEMENT_DATABASE_ID: "none",
    RETAINED_DATABASE_ID: "none",
    REPLACEMENT_TARGET_DIGEST: "none",
    RETAINED_REVISION_EVIDENCE_JSON: JSON.stringify(retained),
    SMOKE_TARGETS_JSON: JSON.stringify(smoke),
    PREPARED_PLAN_JSON: stableJson(plan),
    DISPATCH_DIGEST: hash(stableJson(plan)),
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
    {
      id: plan.recovery_backup_attempt_id,
      digest: "a".repeat(64),
      bookmark: plan.recovery_bookmark,
      owner: "release-backup-owner",
    },
    {
      id: "backup-recovery",
      digest: plan.replacement_handoff.target_digest,
      bookmark: "bookmark-recovery",
      owner: "recovery-backup-owner",
    },
  ];
  for (const [index, backup] of backups.entries()) {
    productionReleaseQueries
      .insertVerifiedHandoffBackup(database)
      .run(
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
        plan.expected_migration_level,
        `disposable-${index}`,
      );
  }

  productionReleaseQueries
    .insertHandoffRecovery(database)
    .run(
      "recovery-failed",
      "failed",
      "time_travel",
      "{}",
      "recovery-failed-key",
      plan.expected_current_revision_id,
      "bookmark-recovery",
      plan.replacement_handoff.target_digest,
      "backup-recovery",
      null,
      plan.expected_current_revision_id,
      "bookmark-current",
      null,
      null,
      "original-db",
      null,
      null,
      plan.expected_migration_level,
      "{}",
      null,
      null,
      null,
      null,
      null,
      now,
      null,
      null,
      null,
      "restore_failed",
      "retry with replacement",
      "2026-08-05T00:01:00.000Z",
    );
  productionReleaseQueries
    .insertHandoffRecovery(database)
    .run(
      plan.replacement_handoff.recovery_id,
      "awaiting_acceptance",
      "replacement_database",
      "{}",
      "recovery-replacement-key",
      plan.expected_current_revision_id,
      "bookmark-recovery",
      plan.replacement_handoff.target_digest,
      "backup-recovery",
      "recovery-failed",
      plan.expected_current_revision_id,
      "bookmark-current",
      "bookmark-restored",
      null,
      "original-db",
      plan.replacement_handoff.replacement_database_id,
      plan.replacement_handoff.retained_database_id,
      plan.expected_migration_level,
      "{}",
      "{}",
      "recovery-verify-key",
      "e".repeat(64),
      null,
      null,
      "2026-08-05T00:01:01.000Z",
      "2026-08-05T00:01:02.000Z",
      "2026-08-05T00:01:03.000Z",
      null,
      null,
      null,
      null,
    );
  const dispatch = environment.DISPATCH_DIGEST;
  const idempotency = [
    [
      plan.idempotency_key,
      "prepare_production_release",
      stableJson({
        prepared_plan_json: environment.PREPARED_PLAN_JSON,
        dispatch_inputs: {
          prepared_plan_json: environment.PREPARED_PLAN_JSON,
          dispatch_digest: environment.DISPATCH_DIGEST,
        },
        contract: "card-keepr-production-release-request@1",
        release_id: plan.release_id,
        state: "requested",
        dispatch_digest: dispatch,
      }),
    ],
    [
      `release-dispatch:${dispatch}`,
      "claim_production_release",
      stableJson({ release_id: plan.release_id, state: "preflight", dispatch_digest: dispatch }),
    ],
    [
      `release-migration-started:${dispatch}`,
      "production_release_migration_started",
      stableJson({ release_id: plan.release_id, migration_started: true, dispatch_digest: dispatch }),
    ],
  ];
  for (const [index, [key, operation, response]] of idempotency.entries()) {
    productionReleaseQueries
      .insertTimedAdministrationEvidence(database)
      .run(key, operation, environment.PREPARED_PLAN_JSON, response, `2026-08-05T00:02:0${index}.000Z`);
  }
  productionReleaseQueries
    .insertHandoffProductionRelease(database)
    .run(
      plan.release_id,
      environment.PREPARED_PLAN_JSON,
      plan.idempotency_key,
      plan.expected_current_revision_id,
      plan.expected_head_sha,
      plan.production_target_digest,
      plan.expected_migration_level,
      plan.recovery_bookmark,
      plan.recovery_backup_attempt_id,
      plan.replacement_handoff.recovery_id,
      plan.replacement_handoff.replacement_database_id,
      plan.replacement_handoff.retained_database_id,
      now,
    );
  productionReleaseQueries.advanceReleaseToPreflight(database).run(plan.release_id);
  productionReleaseQueries.advanceReleaseToMigrating(database).run(plan.release_id);
  productionReleaseQueries
    .reserveReplacementRecoveryLease(database)
    .run(plan.release_id, plan.replacement_handoff.recovery_id);
}

function liveGateDatabase(environment) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE administration_idempotency (idempotency_key TEXT PRIMARY KEY,operation TEXT,request_json TEXT,response_json TEXT,http_status INTEGER,outcome TEXT,created_at TEXT);
    CREATE TABLE administration_idempotency_claims (idempotency_key TEXT PRIMARY KEY);
    CREATE TABLE catalogue_state (singleton INTEGER PRIMARY KEY,current_revision_id TEXT);
    CREATE TABLE operation_state (singleton INTEGER PRIMARY KEY,active_ingestion_run_id TEXT,active_production_release_id TEXT,active_production_release_expires_at TEXT,recovery_health TEXT,active_recovery_id TEXT,recovery_restore_guard TEXT);
    CREATE TABLE catalogue_schema_state (singleton INTEGER PRIMARY KEY,migration_level INTEGER);
    CREATE TABLE catalogue_backup_attempts (idempotency_key TEXT PRIMARY KEY,catalogue_revision_id TEXT,state TEXT,d1_bookmark TEXT,manifest_sha256 TEXT);
    CREATE TABLE catalogue_revisions (id TEXT PRIMARY KEY,expected_previous_revision_id TEXT);
    CREATE TABLE catalogue_exports (catalogue_revision_id TEXT PRIMARY KEY,verified INTEGER,maintenance_state TEXT);
    CREATE TABLE catalogue_recovery_operations (id TEXT PRIMARY KEY,state TEXT,method TEXT,target_revision_id TEXT,target_digest TEXT,restored_database_id TEXT,retained_database_id TEXT,verification_json TEXT);
    CREATE TABLE catalogue_query_revisions (catalogue_revision_id TEXT PRIMARY KEY,state TEXT);
    CREATE TABLE ingestion_runs (id TEXT PRIMARY KEY,state TEXT,selected_games_json TEXT,started_at TEXT,expected_current_revision_id TEXT,idempotency_key TEXT,candidate_json TEXT);
    INSERT INTO catalogue_state VALUES (1,'catrev-current');
    INSERT INTO operation_state VALUES (1,NULL,NULL,NULL,'healthy',NULL,'clear');
    INSERT INTO catalogue_schema_state VALUES (1,${currentSchemaMigrationLevel});
    INSERT INTO catalogue_revisions VALUES ('catrev-current','catrev-previous'),('catrev-previous','catrev-old'),('catrev-old',NULL);
    INSERT INTO catalogue_exports VALUES ('catrev-current',1,'available'),('catrev-previous',1,'available'),('catrev-old',1,'available');
    INSERT INTO catalogue_backup_attempts VALUES ('backup-current','catrev-current','verified','bookmark-current','${"a".repeat(64)}'),('backup-previous','catrev-previous','verified','bookmark-previous','${"b".repeat(64)}'),('backup-old','catrev-old','verified','bookmark-old','${"c".repeat(64)}');
    INSERT INTO catalogue_query_revisions VALUES ('catrev-archived','archived');
  `);
  const plan = environment.PREPARED_PLAN_JSON;
  productionReleaseQueries.insertLegacyAdministrationEvidence(db).run(
    environment.IDEMPOTENCY_KEY,
    "prepare_production_release",
    plan,
    stableJson({
      prepared_plan_json: environment.PREPARED_PLAN_JSON,
      dispatch_inputs: {
        prepared_plan_json: environment.PREPARED_PLAN_JSON,
        dispatch_digest: environment.DISPATCH_DIGEST,
      },
      contract: "card-keepr-production-release-request@1",
      release_id: environment.RELEASE_ID,
      state: "requested",
      dispatch_digest: environment.DISPATCH_DIGEST,
    }),
  );
  return db;
}

async function realDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const migration of (await readdir("migrations")).sort()) {
    database.exec(await readFile(join("migrations", migration), "utf8"));
  }
  productionReleaseQueries.removeReleaseAuditAndLegacyLease(database);
  return database;
}

function seedRealReleaseBoundary(database, environment, migrationStartedSql) {
  const expiry = /active_production_release_expires_at='([^']+)'/u.exec(migrationStartedSql)?.[1];
  assert.ok(expiry);
  productionReleaseQueries.insertPreparedAdministrationEvidence(database).run(
    environment.IDEMPOTENCY_KEY,
    "prepare_production_release",
    environment.PREPARED_PLAN_JSON,
    stableJson({
      prepared_plan_json: environment.PREPARED_PLAN_JSON,
      dispatch_inputs: {
        prepared_plan_json: environment.PREPARED_PLAN_JSON,
        dispatch_digest: environment.DISPATCH_DIGEST,
      },
      contract: "card-keepr-production-release-request@1",
      release_id: environment.RELEASE_ID,
      state: "requested",
      dispatch_digest: environment.DISPATCH_DIGEST,
    }),
  );
  productionReleaseQueries.insertClaimedAdministrationEvidence(database).run(
    `release-dispatch:${environment.DISPATCH_DIGEST}`,
    "claim_production_release",
    environment.PREPARED_PLAN_JSON,
    stableJson({
      release_id: environment.RELEASE_ID,
      state: "preflight",
      dispatch_digest: environment.DISPATCH_DIGEST,
    }),
  );
  productionReleaseQueries.setReleaseLease(database).run(environment.RELEASE_ID, expiry);
  productionReleaseQueries
    .insertReleaseRecoveryBackup(database)
    .run(environment.RECOVERY_BACKUP_ATTEMPT_ID, environment.EXPECTED_CURRENT_REVISION, "backups/release.sql");
}

function smokeTargets() {
  return {
    revisions: ["catrev-current", "catrev-previous", "catrev-old"].map((revision_id, index) => ({
      revision_id,
      card_id: `card-${index}`,
      printing_id: `printing-${index}`,
      search_query: `card-${index}`,
      card_cursor: `card-cursor-${index}`,
      search_cursor: `search-cursor-${index}`,
      printing_cursor: `printing-cursor-${index}`,
    })),
    printing_image_id: "image-1",
    legality_card_id: "card-0",
    legality_format: "standard",
    legality_region: "EN-OCEANIA",
    stale_cursor: Buffer.from(JSON.stringify({ revision_id: "catrev-archived" })).toString("base64"),
    stale_revision_id: "catrev-archived",
  };
}

function statements(sql) {
  return sql.split(/;\s*/u).filter((item) => item.trim().length > 0);
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
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

test("a compiled release lease fences claim replay and cleanup across expiry takeover", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-release-lease-ownership-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environment = bootstrapEnvironment();
  await validateDispatchAndWriteSql(environment, directory);
  const database = await realDatabase();
  t.after(() => database.close());
  seedPreparedRequest(database, environment);
  const claim = await readFile(join(directory, "claim.sql"), "utf8");
  const cleanup = await readFile(join(directory, "cleanup.sql"), "utf8");
  const migration = await readFile(join(directory, "migration-started.sql"), "utf8");
  assert.deepEqual({ ...lastRow(database, claim) }, { changed_rows: 1, claimed: 1 });
  const lease = { ...productionReleaseQueries.operationLease(database).get() };
  assert.equal(lease.active_production_release_id, environment.RELEASE_ID);
  assert.equal(lease.active_ingestion_run_id, null);
  assert.equal(productionReleaseQueries.countIngestionRuns(database).get().count, 0);
  assert.deepEqual({ ...lastRow(database, claim) }, { changed_rows: 0, claimed: 1 });
  assert.equal(productionReleaseQueries.countDispatchClaims(database).get().count, 1);
  productionReleaseQueries.setReleaseLease(database).run(environment.RELEASE_ID, "2099-09-04T00:00:00.000Z");
  assert.equal(lastRow(database, migration).migration_started, 0);
  assert.equal(lastRow(database, cleanup).fence_released, 0);
  assert.equal(
    productionReleaseQueries.operationLease(database).get().active_production_release_expires_at,
    "2099-09-04T00:00:00.000Z",
  );
  productionReleaseQueries
    .setReleaseLease(database)
    .run(environment.RELEASE_ID, lease.active_production_release_expires_at);
  assert.equal(lastRow(database, cleanup).fence_released, 1);
  assert.equal(productionReleaseQueries.countIngestionRuns(database).get().count, 0);
});
