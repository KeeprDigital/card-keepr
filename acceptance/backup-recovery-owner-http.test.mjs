import { phaseAsync, ownerStage, ownerComplete, childPhaseEnvironment } from "./helpers/owner-phase-diagnostics.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readWorkerConfig } from "../cli/lib/config.mjs";
import * as validators from "../test/support/http-response-validators.mjs";
import { reconciliationSourceDocument } from "../test/support/fake-publisher/reconciliation-documents.ts";
import {
  applyMigrations as originalApplyMigrations,
  persistedDatabaseDirectory,
  runCli as originalRunCli,
  startWorker as originalStartWorker,
  stopWorker as originalStopWorker,
  waitForAdministrationDocument,
  waitForHealth,
} from "./helpers/acceptance-runtime.mjs";
import { nativeRecoveryCloudflare } from "./helpers/native-recovery-cloudflare.mjs";
import { verifiedBackupApiState } from "./helpers/verified-backup-api-state.mjs";
import { isNativeCheckpointRequest } from "./helpers/native-checkpoint-hosts.mjs";
import { withNativeRequestPacing } from "./helpers/native-request-pacing.mjs";

const applyMigrations = (...args) => phaseAsync("migration-setup", "catalogue", () => originalApplyMigrations(...args));
const startWorker = (...args) => phaseAsync("bundle-and-boot", "ingestion", () => originalStartWorker(...args));
const stopWorker = (...args) => phaseAsync("worker-stop", "ingestion", () => originalStopWorker(...args));
const runCli = (args, environment, ...rest) =>
  phaseAsync("owner-cli", "command", () =>
    originalRunCli(args, { ...environment, ...childPhaseEnvironment() }, ...rest),
  );

const specification = JSON.parse(await readFile(new URL("../contracts/admin-openapi.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({ strict: false, allErrors: true, inlineRefs: false });
addFormats(ajv);
ajv.addSchema(specification, "administration");
function check(path, method, status, document, media = "application/json") {
  const validate = validators[validators.responseValidators[`admin ${method} ${path} ${status} ${media}`]];
  assert.equal(typeof validate, "function", `${method} ${path} ${status}`);
  assert.equal(validate(document), true, JSON.stringify(validate.errors));
}

// Small synthetic publisher input; real owner CLI/HTTP, D1/R2, Workflows,
// production provider requests and independent SQL export/import databases.
test("owner backs up, retries, restores, verifies and explicitly accepts with immutable and current HTTP replay", async (t) => {
  ownerStage("setup");
  const directory = await mkdtemp(join(tmpdir(), "keepr-backup-owner-"));
  const statePath = join(directory, "state");
  const config = await readWorkerConfig("apps/ingestion/wrangler.jsonc");
  delete config.$schema;
  config.main = resolve("acceptance/fixtures/backup-owner-runtime.ts");
  config.d1_databases[0].migrations_dir = resolve("migrations");
  const configPath = join(directory, "ingestion.json");
  await writeFile(configPath, JSON.stringify(config));
  const migrationModule = join(directory, "fixture-migration.mjs");
  await build({
    entryPoints: ["test/support/source-adapters/migration.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: migrationModule,
  });
  const { syntheticSourceAdapterMigration } = await import(pathToFileURL(migrationModule).href);
  await applyMigrations(statePath, configPath, [syntheticSourceAdapterMigration]);
  let cloudflare = nativeRecoveryCloudflare({
    databaseDirectory: await persistedDatabaseDirectory(statePath),
    directory,
  });
  const key = crypto.randomUUID();
  const workers = [];
  let releaseImport;
  t.after(async () => {
    releaseImport?.();
    for (const worker of workers) await stopWorker(worker);
    cloudflare.close();
    await rm(directory, { recursive: true, force: true });
  });
  const outboundService = (request) => {
    if (isNativeCheckpointRequest(request)) return cloudflare.fetch(request);
    const url = new URL(request.url);
    assert.equal(url.hostname, "official-source.invalid");
    const source = reconciliationSourceDocument("base", "", request.url);
    source.cards[0].card.name = `Owner recovery Card ${url.searchParams.get("revision") ?? "one"}`;
    return Response.json(source);
  };
  let worker = await startWorker({
    config: configPath,
    statePath,
    outboundService,
    vars: {
      ADMINISTRATION_KEY: key,
      D1_EXPORT_TOKEN: "local-export",
      D1_VERIFICATION_TOKEN: "local-verify",
      SOURCE_HOST_PACING_MODE: "immediate",
    },
  });
  workers.push(worker);
  await waitForHealth(`${worker.url}/health`, key, worker);
  let environment = {
    KEEPR_INGESTION_URL: worker.url,
    KEEPR_ADMINISTRATION_KEY: key,
    KEEPR_NATIVE_REQUEST_INTERVAL_MS: "2100",
  };
  const cli = async (args, codes = [0]) => {
    const result = await runCli([...args, "--json"], environment);
    assert.ok(codes.includes(result.code), `${args.join(" ")}: exit ${result.code}\n${result.stdout}${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const confirmations = new Map();
  const mutate = async (args, codes = [0], retainConfirmation = false) => {
    const base = [...args, "--environment", "production", "--yes"];
    const preview = await cli(base, [3]);
    assert.equal(preview.code, "confirmation_required");
    const confirmation = /--confirm '(.+)'/.exec(preview.detail)?.[1];
    assert.ok(confirmation, preview.detail);
    if (retainConfirmation) {
      const name = JSON.stringify(args);
      if (confirmations.has(name)) assert.equal(confirmation, confirmations.get(name));
      else confirmations.set(name, confirmation);
    }
    return cli([...base, "--confirm", confirmation], codes);
  };
  const call = async (path, { body, status = 200, schemaPath = path, authenticated = true } = {}) => {
    const method = body === undefined ? "get" : "post";
    const response = await withNativeRequestPacing(environment, () =>
      fetch(`${worker.url}${path}`, {
        method: method.toUpperCase(),
        headers: { "content-type": "application/json", ...(authenticated ? { authorization: `Bearer ${key}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const document = await response.json();
    assert.equal(response.status, status, JSON.stringify(document));
    const media = response.headers.get("content-type").split(";")[0];
    check(schemaPath, method, status, document, media);
    if (status < 300) {
      assert.equal(response.headers.get("cache-control"), "no-store");
      if (body !== undefined) {
        const validate = ajv.compile({
          $ref: `administration#/paths/${schemaPath.replaceAll("/", "~1")}/post/requestBody/content/application~1json/schema`,
        });
        assert.equal(validate(body), true, JSON.stringify(validate.errors));
      }
    }
    return document;
  };
  const waitBackup = (key) =>
    waitForAdministrationDocument(
      `/v1/backups/${encodeURIComponent(key)}`,
      (d) => ["verified", "failed"].includes(d.state),
      environment,
      worker,
    );
  const publish = async (label, predecessor = "catrev_spine_000") => {
    const response = await fetch(`${worker.url}/acceptance/published-backup-source`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ label, predecessor }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  ownerStage("first-publication");
  const { published } = await publish("first");
  ownerStage("initial-wire-validation");
  const revision = published.resulting_revision_id;
  const initialBackups = await call(`/v1/catalogue-revisions/${revision}/backups`, {
    schemaPath: "/v1/catalogue-revisions/{revision}/backups",
  });
  assert.ok(initialBackups.attempts.some((d) => d.state === "verified"));
  await call("/v1/backups/missing", { status: 401, schemaPath: "/v1/backups/{attempt}", authenticated: false });
  const failedKey = "owner failed backup / " + "x".repeat(220);
  const original = { expected_current_revision_id: revision, idempotency_key: failedKey };
  await call("/v1/backups", { body: { ...original, failed_attempt_id: "missing-pair" }, status: 422 });
  ownerStage("failed-backup");
  cloudflare.faults.exportFailures = 100;
  const failedArgs = ["backup", "create", "--expected-current-revision", revision, "--idempotency-key", failedKey];
  await call("/v1/backups", { body: original, status: 202 });
  const failed = await waitBackup(failedKey);
  assert.equal(failed.state, "failed");
  check("/v1/backups/{attempt}", "get", 200, failed);
  assert.deepEqual(await cli(["backup", "status", "--attempt-id", failedKey]), failed);
  ownerStage("retry-backup");
  cloudflare.faults.exportFailures = 0;
  const retry = {
    expected_current_revision_id: revision,
    idempotency_key: "owner-retry",
    failed_attempt_id: failedKey,
    failed_attempt_digest: failed.attempt_digest,
  };
  const wrong = await call("/v1/backups", { body: { ...retry, failed_attempt_digest: "0".repeat(64) }, status: 409 });
  assert.equal(wrong.code, "backup_digest_mismatch");
  let importEntered;
  const entered = new Promise((resolve) => {
    importEntered = resolve;
  });
  const released = new Promise((resolve) => {
    releaseImport = resolve;
  });
  cloudflare.hooks.afterImport = async () => {
    cloudflare.hooks.afterImport = undefined;
    importEntered();
    await released;
  };
  const started = await call("/v1/backups", { body: retry, status: 202 });
  await entered;
  try {
    assert.equal(started.output, null);
    const replay = await call("/v1/backups", { body: retry });
    assert.equal(replay.workflow_instance_id, started.workflow_instance_id);
    assert.equal(replay.output, null);
    const parent = await call("/v1/backups", { body: original });
    assert.equal(parent.status, "complete");
    assert.equal(parent.output.contract, "card-keepr-catalogue-backup-workflow-failure@1");
    await mutate(failedArgs, [8]);
  } finally {
    releaseImport();
  }
  const backup = await waitBackup(retry.idempotency_key);
  assert.equal(backup.state, "verified", JSON.stringify(backup));
  assert.equal(backup.linked_attempt_id, failedKey);
  const retryArgs = [
    "backup",
    "retry",
    "--expected-current-revision",
    revision,
    "--idempotency-key",
    retry.idempotency_key,
    "--failed-attempt-id",
    failedKey,
    "--failed-attempt-digest",
    failed.attempt_digest,
  ];
  const verifiedBackup = await mutate(retryArgs);
  check("/v1/backups", "post", 200, verifiedBackup);
  assert.equal(verifiedBackup.output.verified, true);
  assert.equal(verifiedBackup.workflow_instance_id, started.workflow_instance_id);
  const conflict = await call("/v1/backups", {
    body: { ...retry, failed_attempt_digest: "0".repeat(64) },
    status: 409,
  });
  assert.equal(conflict.code, "idempotency_key_reused");
  const begin = {
    environment: "production",
    recovery_id: "owner-recovery",
    method: "replacement_database",
    target_revision_id: revision,
    target_bookmark: backup.d1_bookmark,
    target_digest: backup.manifest_sha256,
    backup_attempt_id: backup.idempotency_key,
    expected_current_revision_id: revision,
    idempotency_key: "owner-recovery-begin",
  };
  ownerStage("recovery-begin");
  const recovery = await call("/v1/recoveries", { body: begin, status: 201 });
  assert.equal(recovery.state, "validating");
  assert.equal(recovery.verification, null);
  const acceptance = {
    expected_restored_revision_id: revision,
    target_digest: begin.target_digest,
    confirmation_recovery_id: begin.recovery_id,
    idempotency_key: "owner-recovery-accept",
  };
  const acceptancePath = `/v1/recoveries/${begin.recovery_id}/acceptance`;
  const acceptanceSchemaPath = "/v1/recoveries/{recovery}/acceptance";
  assert.equal(
    (await call(acceptancePath, { body: acceptance, status: 409, schemaPath: acceptanceSchemaPath })).code,
    "recovery_not_verified",
  );
  assert.equal(
    (
      await call("/v1/backups", {
        body: { expected_current_revision_id: revision, idempotency_key: "fenced" },
        status: 409,
      })
    ).code,
    "backup_in_progress",
  );
  const verifyArgs = [
    "recovery",
    "verify",
    "--recovery-id",
    begin.recovery_id,
    "--target-digest",
    begin.target_digest,
    "--idempotency-key",
    "owner-recovery-verify",
  ];
  ownerStage("recovery-verify");
  const verified = await mutate(verifyArgs);
  check("/v1/recoveries/{recovery}/verification", "post", 200, verified);
  assert.equal(verified.state, "awaiting_acceptance");
  assert.deepEqual(verified.verification, {
    schema: true,
    integrity: true,
    current_revision: true,
    representative_entities: true,
    search: true,
    provenance: true,
    audit: true,
    api: true,
  });
  assert.deepEqual(await call("/v1/recoveries", { body: begin, status: 201 }), verified);
  assert.equal(
    (await call(acceptancePath, { body: acceptance, status: 409, schemaPath: acceptanceSchemaPath })).code,
    "recovery_database_not_bound",
  );
  ownerStage("replacement-binding");
  const restoredConfig = {
    ...config,
    d1_databases: [{ ...config.d1_databases[0], database_id: recovery.restored_database_id }],
    vars: { ...config.vars, CATALOGUE_D1_DATABASE_ID: recovery.restored_database_id },
  };
  const restoredConfigPath = join(directory, "restored-ingestion.json");
  await writeFile(restoredConfigPath, JSON.stringify(restoredConfig));
  await stopWorker(worker);
  const databaseDirectory = await persistedDatabaseDirectory(statePath);
  const existingFiles = new Set(await readdir(databaseDirectory, { recursive: true }));
  await applyMigrations(statePath, restoredConfigPath);
  const restoredFiles = (await readdir(databaseDirectory, { recursive: true })).filter(
    (name) => name.endsWith(".sqlite") && !existingFiles.has(name),
  );
  assert.equal(restoredFiles.length, 1, "The replacement binding owns one new isolated database");
  // Boot the actual independently imported and verified SQL database. Sending
  // its whole dump through D1's statement API would impose a different size limit.
  const sourceDatabaseFile = join(databaseDirectory, restoredFiles[0]);
  await verifiedBackupApiState(statePath, directory, sourceDatabaseFile);
  cloudflare.close();
  cloudflare = nativeRecoveryCloudflare({ databaseDirectory, directory, sourceDatabaseFile });
  worker = await startWorker({
    config: restoredConfigPath,
    statePath,
    outboundService,
    vars: {
      ADMINISTRATION_KEY: key,
      D1_EXPORT_TOKEN: "local-export",
      D1_VERIFICATION_TOKEN: "local-verify",
      SOURCE_HOST_PACING_MODE: "immediate",
    },
  });
  workers.push(worker);
  environment = { ...environment, KEEPR_INGESTION_URL: worker.url };
  const acceptArgs = [
    "recovery",
    "accept",
    "--recovery-id",
    begin.recovery_id,
    "--expected-restored-revision",
    revision,
    "--target-digest",
    begin.target_digest,
    "--confirmation-recovery-id",
    begin.recovery_id,
    "--idempotency-key",
    acceptance.idempotency_key,
  ];
  ownerStage("recovery-accept");
  const accepted = await mutate(acceptArgs, [0], true);
  check(acceptanceSchemaPath, "post", 200, accepted);
  assert.equal(accepted.state, "accepted");
  assert.ok(accepted.restored_work.some((row) => row.classification === "published_retained"));
  assert.deepEqual(await cli(["recovery", "inspect", "--recovery-id", begin.recovery_id]), accepted);
  ownerStage("later-publication");
  const later = await publish("later", revision);
  assert.notEqual(later.published.resulting_revision_id, revision);
  ownerStage("acknowledged-replay");
  // The original decisions remain addressable after a later real publication.
  assert.deepEqual(await mutate(acceptArgs, [0], true), accepted);
  assert.deepEqual(await mutate(retryArgs), verifiedBackup);
  const beginArgs = [
    "recovery",
    "begin",
    "--recovery-id",
    begin.recovery_id,
    "--method",
    begin.method,
    "--target-revision",
    revision,
    "--target-bookmark",
    begin.target_bookmark,
    "--target-digest",
    begin.target_digest,
    "--backup-attempt-id",
    begin.backup_attempt_id,
    "--expected-current-revision",
    revision,
    "--idempotency-key",
    begin.idempotency_key,
  ];
  assert.deepEqual(await mutate(beginArgs), accepted);
  assert.deepEqual(await mutate(verifyArgs), accepted);
  ownerStage("final-status");
  const finalStatus = await cli(["status"]);
  assert.equal(finalStatus.safe_state.current_revision_id, later.published.resulting_revision_id);
  assert.equal(finalStatus.safe_state.recovery_health, "healthy");
  assert.equal(finalStatus.safe_state.active_recovery_id, null);
  ownerComplete();
});
