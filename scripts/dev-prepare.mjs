#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import { devAudience } from "../src/http/dev-workflow-identity.mjs";
import { validatedEnvironmentTarget } from "../src/http/production-target.mjs";

// This exchanges GitHub workflow identity for a dev-only prepared artifact.
// Neither administration credentials nor Cloudflare credentials are needed.
const oidcUrl = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
if (oidcUrl.protocol !== "https:") throw new Error("invalid_oidc_endpoint");
oidcUrl.searchParams.set("audience", devAudience);
const oidcResponse = await fetch(oidcUrl, {
  redirect: "error",
  headers: { authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  signal: AbortSignal.timeout(10_000),
});
if (!oidcResponse.ok) throw new Error("oidc_request_failed");
const { value } = await oidcResponse.json();
const response = await fetch(devAudience, {
  method: "POST",
  redirect: "error",
  signal: AbortSignal.timeout(60_000),
  headers: {
    authorization: `Bearer ${value}`,
    "x-github-token": process.env.GH_TOKEN,
    "content-type": "application/json",
  },
  body: JSON.stringify({ head_sha: process.env.EXPECTED_HEAD_SHA, ci_run_id: process.env.CI_RUN_ID }),
});
if (!response.ok) throw new Error(`dev_preparation_failed:${response.status}`);
const document = await response.json();
if (document.environment !== "dev" || document.dispatch_inputs?.expected_head_sha !== process.env.EXPECTED_HEAD_SHA)
  throw new Error("dev_preparation_mismatch");
const target = validatedEnvironmentTarget(JSON.parse(document.dispatch_inputs.production_target_json), "dev");
if (
  target === null ||
  target.cloudflare_account_id !== process.env.DEV_CLOUDFLARE_ACCOUNT_ID ||
  target.d1_databases[0].id !== process.env.DEV_CATALOGUE_DATABASE_ID ||
  target.d1_databases[1].id === target.d1_databases[0].id
)
  throw new Error("dev_preparation_target_mismatch");
const names = [
  "release_id",
  "expected_head_sha",
  "expected_actor",
  "expected_current_revision",
  "bootstrap",
  "expected_migration_level",
  "production_target_json",
  "production_target_digest",
  "recovery_bookmark",
  "recovery_backup_attempt_id",
  "smoke_targets_json",
  "retained_revision_evidence_json",
  "replacement_recovery_id",
  "replacement_database_id",
  "retained_database_id",
  "replacement_target_digest",
  "idempotency_key",
  "dispatch_digest",
  "prepared_plan_json",
];
const output = names
  .map((name) => {
    const value = document.dispatch_inputs[name];
    if (typeof value !== "string" || /[\r\n]/u.test(value)) throw new Error("invalid_dev_dispatch_input");
    return `${name.toUpperCase()}=${value}\n`;
  })
  .join("");
await appendFile(process.env.GITHUB_ENV, `${output}DEV_DISPOSABLE_DATABASE_ID=${target.d1_databases[1].id}\n`);
