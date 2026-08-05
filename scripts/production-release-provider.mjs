#!/usr/bin/env node
import { createHash } from "node:crypto";

const api = "https://api.cloudflare.com/client/v4";

export async function verifyCredential(environment, fetchImpl = fetch) {
  const expectedStatus = environment.EXPECTED_STATUS;
  const token = environment.CLOUDFLARE_API_TOKEN ?? "";
  if (expectedStatus === "unusable") {
    if (token !== "") throw new Error("unusable_slot_not_empty");
    return { status: "unusable" };
  }
  if (expectedStatus !== "usable" || token.length === 0) throw new Error("invalid_expected_status");
  const fingerprint = `sha256:${createHash("sha256").update(token).digest("hex")}`;
  if (fingerprint !== environment.EXPECTED_FINGERPRINT) throw new Error("credential_fingerprint_mismatch");
  const document = await cloudflare(fetchImpl, token, `/accounts/${account(environment)}/tokens/verify`);
  if (document.result?.id !== environment.EXPECTED_TOKEN_ID || document.result?.status !== "active") throw new Error("credential_identity_mismatch");
  return { status: "usable", token_id: document.result.id };
}

export async function verifyProductionTarget(environment, fetchImpl = fetch) {
  const token = required(environment, "CLOUDFLARE_API_TOKEN");
  const target = JSON.parse(required(environment, "PRODUCTION_TARGET_JSON"));
  if (target.cloudflare_account_id !== account(environment)) throw new Error("account_identity_mismatch");
  const [databases, buckets, ...settings] = await Promise.all([
    cloudflare(fetchImpl, token, `/accounts/${account(environment)}/d1/database`),
    cloudflare(fetchImpl, token, `/accounts/${account(environment)}/r2/buckets`),
    ...target.worker_scripts.map((worker) => cloudflare(fetchImpl, token, `/accounts/${account(environment)}/workers/scripts/${encodeURIComponent(worker)}/settings`)),
  ]);
  const actualDatabases = new Map((databases.result ?? []).map((item) => [item.name, item.uuid ?? item.id]));
  for (const database of target.d1_databases) if (actualDatabases.get(database.name) !== database.id) throw new Error("d1_identity_mismatch");
  const actualBuckets = new Set((buckets.result?.buckets ?? buckets.result ?? []).map((item) => item.name));
  for (const bucket of target.r2_buckets) if (!actualBuckets.has(bucket)) throw new Error("r2_identity_mismatch");
  const expectedDatabase = target.d1_databases[0].id;
  for (const [index, worker] of target.worker_scripts.entries()) {
    const binding = settings[index].result?.bindings?.find((item) => item.name === "CATALOGUE_DB");
    if (binding?.id !== expectedDatabase) throw new Error(`worker_binding_mismatch:${worker}`);
  }
  return { account_id: target.cloudflare_account_id, worker_scripts: target.worker_scripts, d1_databases: target.d1_databases, r2_buckets: target.r2_buckets };
}

export async function observeCatalogueBindings(environment, fetchImpl = fetch) {
  const token = required(environment, "CLOUDFLARE_API_TOKEN");
  const target = JSON.parse(required(environment, "PRODUCTION_TARGET_JSON"));
  const expected = environment.REPLACEMENT_DATABASE_ID === "none" ? target.d1_databases[0].id : environment.REPLACEMENT_DATABASE_ID;
  const observed = {};
  for (const worker of target.worker_scripts) {
    const settings = await cloudflare(fetchImpl, token, `/accounts/${account(environment)}/workers/scripts/${encodeURIComponent(worker)}/settings`);
    const binding = settings.result?.bindings?.find((item) => item.name === "CATALOGUE_DB");
    if (binding?.id !== expected) throw new Error(`worker_binding_mismatch:${worker}`);
    observed[worker] = binding.id;
  }
  return { worker_database_ids: observed, retained_database_id: environment.RETAINED_DATABASE_ID };
}

async function cloudflare(fetchImpl, token, pathname) {
  const response = await fetchImpl(`${api}${pathname}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  const document = await response.json();
  if (!response.ok || document.success !== true) throw new Error(`cloudflare_request_failed:${pathname}`);
  return document;
}
function account(environment) { return required(environment, "CLOUDFLARE_ACCOUNT_ID"); }
function required(environment, name) { const value = environment[name]; if (typeof value !== "string" || value.length === 0) throw new Error(`missing_${name.toLowerCase()}`); return value; }

if (process.argv[2] === "credential-proof") process.stdout.write(`${JSON.stringify(await verifyCredential(process.env))}\n`);
else if (process.argv[2] === "verify-target") process.stdout.write(`${JSON.stringify(await verifyProductionTarget(process.env))}\n`);
else if (process.argv[2] === "observe-bindings") process.stdout.write(`${JSON.stringify(await observeCatalogueBindings(process.env))}\n`);
