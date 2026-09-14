#!/usr/bin/env node
import { execFile, spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile, open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify, isDeepStrictEqual } from "node:util";
import { stagingAudience, verifyReleaseCommit } from "../src/http/dev-workflow-identity.mjs";
import { validatedEnvironmentTarget } from "../src/http/production-target.mjs";
import { isReleaseDigest, isReleaseHead, isReleaseIdentity } from "../src/catalogue/shared/release-input-shapes.mjs";
import {
  stagingValidationRequirements,
  stagingValidationScenarios,
  validateStagingOutcome,
} from "../src/catalogue/shared/staging-validation.mjs";
import { environmentConfigurations } from "./dev-environment.mjs";
import { deployEnvironment } from "./deploy-dev.mjs";
import { rehearseStagingMigrations } from "./staging-migrations.mjs";

const stageEndpoint = "https://card-staging.keepr.digital/ingest/v1/staging-deployments";

/** The owner intent, deploy acknowledgement and required validation outcome remain separate evidence. */
export async function runStagingRelease(
  environment,
  executeCommand = promisify(execFile),
  runValidation = runExtendedValidation,
) {
  if (
    environment.RELEASE_ENVIRONMENT !== "staging" ||
    !isReleaseIdentity(environment.RELEASE_ID) ||
    !isReleaseDigest(environment.INTENT_DIGEST) ||
    !isReleaseHead(environment.EXPECTED_HEAD_SHA)
  )
    throw new Error("invalid_staging_dispatch");
  if (execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== environment.EXPECTED_HEAD_SHA)
    throw new Error("staging_checkout_mismatch");
  const directory = resolve(".artifacts/staging-release");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const save = async (name, document) => {
    const text = `${JSON.stringify(document)}\n`;
    await writeFile(`${directory}/${name}.json`, text, { mode: 0o600 });
    return createHash("sha256").update(text).digest("hex");
  };
  const identity = { release_id: environment.RELEASE_ID, intent_digest: environment.INTENT_DIGEST };
  const authorization = await workflowRequest(environment, stagingAudience, identity);
  const intent = authorization.intent;
  if (
    authorization.contract !== "card-keepr-staging-authorization@1" ||
    authorization.intent_digest !== identity.intent_digest ||
    intent?.expected_head_sha !== environment.EXPECTED_HEAD_SHA ||
    intent.release_id !== identity.release_id ||
    Date.parse(authorization.expires_at) <= Date.now()
  )
    throw new Error("staging_authorization_mismatch");
  const checks = stagingValidationRequirements(intent.validation_scope);
  const scenarios = stagingValidationScenarios(intent.validation_scope);
  if (
    JSON.stringify(checks) !== JSON.stringify(intent.required_checks) ||
    JSON.stringify(scenarios) !== JSON.stringify(intent.extended_scenarios)
  )
    throw new Error("staging_validation_policy_mismatch");
  await save("authorization", authorization);
  const outcome = {
    contract: "card-keepr-staging-outcome@1",
    intent_digest: identity.intent_digest,
    expected_head_sha: intent.expected_head_sha,
    state: "failed",
    deployment: { state: "not_run", release_id: intent.release_id, dispatch_digest: null },
    migration: {
      state: "not_run",
      starting_level: intent.production_start.migration_level,
      ending_level: intent.production_start.migration_level,
      migration_digest: null,
    },
    checks: checks.map((name) => ({ name, state: "not_run", evidence_sha256: null })),
    failure_code: null,
  };
  let activeCheck = "exact-commit-ci";
  const passed = async (name, evidence) =>
    Object.assign(
      outcome.checks.find((check) => check.name === name),
      { state: "succeeded", evidence_sha256: await save(name, evidence) },
    );
  try {
    await verifyReleaseCommit(environment.GH_TOKEN, {
      head_sha: intent.expected_head_sha,
      ci_run_id: intent.ci_run_id,
    });
    await passed(activeCheck, { head_sha: intent.expected_head_sha, ci_run_id: intent.ci_run_id, state: "succeeded" });
    activeCheck = "migration-rehearsal";
    const migration = await rehearseStagingMigrations({
      expectedHeadSha: intent.expected_head_sha,
      productionStartingLevel: intent.production_start.migration_level,
    });
    outcome.migration = {
      state: "succeeded",
      starting_level: migration.starting_level,
      ending_level: migration.ending_level,
      migration_digest: await save(activeCheck, migration),
    };
    await passed(activeCheck, migration);
    activeCheck = "live-smoke";
    const prepared = await workflowRequest(environment, stageEndpoint, identity);
    if (
      prepared.environment !== "staging" ||
      prepared.dispatch_inputs?.expected_head_sha !== intent.expected_head_sha ||
      !Number.isSafeInteger(Number(prepared.dispatch_inputs.expected_migration_level)) ||
      Number(prepared.dispatch_inputs.expected_migration_level) > migration.ending_level ||
      !isDeepStrictEqual(prepared.authorization, authorization)
    )
      throw new Error("staging_preparation_mismatch");
    const target = validatedEnvironmentTarget(JSON.parse(prepared.dispatch_inputs.production_target_json), "staging");
    if (
      !target ||
      target.cloudflare_account_id !== environment.STAGING_CLOUDFLARE_ACCOUNT_ID ||
      target.d1_databases[0].id !== environment.STAGING_CATALOGUE_DATABASE_ID
    )
      throw new Error("staging_preparation_target_mismatch");
    const configs = await environmentConfigurations("staging", {
      accountId: target.cloudflare_account_id,
      catalogueId: target.d1_databases[0].id,
      disposableId: target.d1_databases[1].id,
    });
    for (const [app, config] of Object.entries(configs))
      await writeFile(`apps/${app}/wrangler.staging.json`, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await save("preparation", prepared);
    outcome.deployment = { state: "failed", release_id: intent.release_id, dispatch_digest: prepared.dispatch_digest };
    if (Date.parse(authorization.preparation_expires_at) <= Date.now()) throw new Error("staging_preparation_expired");
    const deployment = await deployEnvironment(
      {
        ...environment,
        ...Object.fromEntries(
          Object.entries(prepared.dispatch_inputs).map(([key, value]) => [key.toUpperCase(), value]),
        ),
        CI_RUN_ID: intent.ci_run_id,
        STAGING_DISPOSABLE_DATABASE_ID: target.d1_databases[1].id,
        API_RELEASE_CONFIG: "apps/api/wrangler.staging.json",
        INGESTION_RELEASE_CONFIG: "apps/ingestion/wrangler.staging.json",
      },
      executeCommand,
    );
    outcome.deployment.state = "succeeded";
    await passed(activeCheck, deployment);
    if (scenarios.length) {
      activeCheck = "retained-source-rehearsal";
      const result = await runValidation(scenarios, directory);
      await passed(activeCheck, { state: "succeeded", head_sha: intent.expected_head_sha, scenarios, ...result });
    }
    outcome.state = "succeeded";
  } catch {
    outcome.failure_code = `${activeCheck.replaceAll("-", "_")}_failed`;
    const failure = {
      state: "failed",
      failure_code: outcome.failure_code,
      expected_head_sha: intent.expected_head_sha,
    };
    const digest = await save(activeCheck, failure);
    Object.assign(
      outcome.checks.find((check) => check.name === activeCheck),
      { state: "failed", evidence_sha256: digest },
    );
    if (activeCheck === "migration-rehearsal")
      outcome.migration = { ...outcome.migration, state: "failed", migration_digest: digest };
  }
  validateStagingOutcome(outcome, intent, identity.intent_digest);
  await save("outcome", outcome);
  // Reacquire only a short-lived identity token; production returns the original claim/deadline.
  await workflowRequest(environment, `${stageEndpoint}/${encodeURIComponent(intent.release_id)}/outcome`, {
    intent_digest: identity.intent_digest,
    outcome,
  });
  if (outcome.state !== "succeeded") throw new Error(`staging_release_failed:${directory}`);
  return {
    release_id: intent.release_id,
    expected_head_sha: intent.expected_head_sha,
    state: "succeeded",
    evidence_directory: directory,
  };
}

async function workflowRequest(environment, url, body) {
  const oidc = new URL(environment.ACTIONS_ID_TOKEN_REQUEST_URL);
  if (oidc.protocol !== "https:") throw new Error("invalid_oidc_endpoint");
  oidc.searchParams.set("audience", stagingAudience);
  const identityResponse = await fetch(oidc, {
    redirect: "error",
    headers: { authorization: `Bearer ${environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!identityResponse.ok) throw new Error("staging_identity_unavailable");
  const identity = await identityResponse.json();
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
    headers: {
      authorization: `Bearer ${identity.value}`,
      "x-github-token": environment.GH_TOKEN,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`staging_request_failed:${response.status}`);
  return response.json();
}

async function runExtendedValidation(scenarios, directory) {
  const log = await open(`${directory}/retained-source-rehearsal.log`, "w", 0o600);
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn("pnpm", ["run", "test:acceptance:extended", ...scenarios], {
        stdio: ["ignore", log.fd, log.fd],
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          CI: "true",
          WRANGLER_SEND_METRICS: "false",
        },
      });
      child.once("error", reject);
      child.once("exit", (status) => resolve(status));
    });
    if (code !== 0) throw new Error("retained_source_rehearsal_failed");
    return { exit_code: code };
  } finally {
    await log.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.stdout.write(`${JSON.stringify(await runStagingRelease(process.env))}\n`);
