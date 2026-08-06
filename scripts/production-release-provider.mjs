#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const api = "https://api.cloudflare.com/client/v4";
const workerConfigs = {
  "card-keepr-api": "apps/api/wrangler.jsonc",
  "card-keepr-ingestion": "apps/ingestion/wrangler.jsonc",
};
const expectedSecrets = {
  "card-keepr-api": [
    "API_BEARER_KEY", "API_BEARER_KEY_REPLACEMENT",
    "CREDENTIAL_CONSUMER_PROOF_KEY",
  ],
  "card-keepr-ingestion": [
    "ADMINISTRATION_KEY", "ADMINISTRATION_KEY_REPLACEMENT",
    "CREDENTIAL_BOUNDARY_ATTESTATION_KEY", "CREDENTIAL_CONSUMER_PROOF_KEY",
    "CLOUDFLARE_OBSERVATION_TOKEN", "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_OBSERVATION_ACTOR", "D1_EXPORT_TOKEN",
    "D1_EXPORT_TOKEN_REPLACEMENT", "D1_VERIFICATION_TOKEN",
    "D1_VERIFICATION_TOKEN_REPLACEMENT",
  ],
};

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
  if (!record(document.result) || document.result.id !== environment.EXPECTED_TOKEN_ID || document.result.status !== "active") throw new Error("credential_identity_mismatch");
  return { status: "usable", token_id: document.result.id };
}

export async function verifyProductionTarget(environment, fetchImpl = fetch) {
  const token = required(environment, "CLOUDFLARE_API_TOKEN");
  const target = parseTarget(environment);
  const configs = await configuredWorkers();
  assertExactTarget(environment, target, configs);
  await Promise.all([
    verifyDatabases(fetchImpl, token, environment, target),
    verifyBuckets(fetchImpl, token, environment, target.r2_buckets),
    verifyWorkers(fetchImpl, token, environment, configs),
  ]);
  return {
    account_id: target.cloudflare_account_id,
    worker_scripts: target.worker_scripts,
    d1_databases: target.d1_databases,
    r2_buckets: target.r2_buckets,
  };
}

export async function observeCatalogueBindings(environment, fetchImpl = fetch) {
  const token = required(environment, "CLOUDFLARE_API_TOKEN");
  const target = parseTarget(environment);
  const configs = await configuredWorkers();
  assertExactTarget(environment, target, configs);
  const expectedDatabase = environment.REPLACEMENT_DATABASE_ID === "none"
    ? target.d1_databases[0].id
    : required(environment, "REPLACEMENT_DATABASE_ID");
  for (const config of Object.values(configs)) {
    config.d1_databases[0].database_id = expectedDatabase;
    if (config.name === "card-keepr-ingestion") {
      config.vars.CATALOGUE_D1_DATABASE_ID = expectedDatabase;
    }
  }
  await verifyWorkers(fetchImpl, token, environment, configs);
  return {
    worker_database_ids: Object.fromEntries(
      target.worker_scripts.map((worker) => [worker, expectedDatabase]),
    ),
    retained_database_id: environment.RETAINED_DATABASE_ID,
  };
}

async function configuredWorkers() {
  const entries = await Promise.all(Object.entries(workerConfigs).map(
    async ([worker, path]) => {
      const config = JSON.parse(await readFile(path, "utf8"));
      if (config.name !== worker) throw new Error("worker_config_name_mismatch");
      return [worker, config];
    },
  ));
  return Object.fromEntries(entries);
}

function assertExactTarget(environment, target, configs) {
  const configuredD1 = configs["card-keepr-ingestion"].d1_databases[0];
  const expected = {
    cloudflare_account_id: account(environment),
    worker_scripts: Object.keys(workerConfigs),
    d1_databases: [
      { name: configuredD1.database_name, id: configuredD1.database_id },
      {
        name: "card-keepr-disposable-verification",
        id: configs["card-keepr-ingestion"].vars.DISPOSABLE_D1_DATABASE_ID,
      },
    ],
    r2_buckets: configs["card-keepr-ingestion"].r2_buckets.map(
      (binding) => binding.bucket_name,
    ),
  };
  if (stableJson(target) !== stableJson(expected)) throw new Error("production_target_mismatch");
}

async function verifyDatabases(fetchImpl, token, environment, databases) {
  const observed = await Promise.all(databases.d1_databases.map(async (expected) => {
    const document = await cloudflare(fetchImpl, token, `/accounts/${account(environment)}/d1/database/${encodeURIComponent(expected.id)}`);
    if (!record(document.result)) throw new Error("malformed_d1_response");
    const id = unambiguousIdentity(document.result, "uuid", "id");
    if (id !== expected.id || document.result.name !== expected.name) throw new Error("d1_identity_mismatch");
    return id;
  }));
  if (new Set(observed).size !== databases.d1_databases.length) throw new Error("ambiguous_d1_response");
}

async function verifyBuckets(fetchImpl, token, environment, buckets) {
  await Promise.all(buckets.map(async (bucket) => {
    const encoded = encodeURIComponent(bucket);
    const root = `/accounts/${account(environment)}/r2/buckets/${encoded}`;
    const [details, managed, custom] = await Promise.all([
      cloudflare(fetchImpl, token, root),
      cloudflare(fetchImpl, token, `${root}/domains/managed`),
      cloudflare(fetchImpl, token, `${root}/domains/custom`),
    ]);
    if (!record(details.result) || details.result.name !== bucket) throw new Error(`r2_identity_mismatch:${bucket}`);
    if (!record(managed.result) || typeof managed.result.bucketId !== "string" || managed.result.bucketId.length === 0 ||
        typeof managed.result.domain !== "string" || managed.result.domain.length === 0 || managed.result.enabled !== false) {
      throw new Error(`r2_managed_domain_not_private:${bucket}`);
    }
    if (!record(custom.result) || !Array.isArray(custom.result.domains) ||
        !custom.result.domains.every(validPrivateCustomDomain)) {
      throw new Error(`r2_custom_domain_not_private:${bucket}`);
    }
  }));
}

function validPrivateCustomDomain(domain) {
  const states = new Set(["pending", "active", "deactivated", "blocked", "error", "unknown"]);
  const sslStates = new Set(["initializing", "pending", "active", "deactivated", "error", "unknown"]);
  return record(domain) && typeof domain.domain === "string" && domain.domain.length > 0 &&
    domain.enabled === false && record(domain.status) &&
    states.has(domain.status.ownership) && sslStates.has(domain.status.ssl);
}

async function verifyWorkers(fetchImpl, token, environment, configs) {
  await Promise.all(Object.entries(configs).map(async ([worker, config]) => {
    const document = await cloudflare(fetchImpl, token, `/accounts/${account(environment)}/workers/scripts/${encodeURIComponent(worker)}/settings`);
    if (!record(document.result) || !Array.isArray(document.result.bindings)) throw new Error(`malformed_worker_settings:${worker}`);
    const actual = normalizedBindings(document.result.bindings, worker);
    const expected = expectedBindings(config, expectedSecrets[worker], worker);
    if (stableJson(actual) !== stableJson(expected)) throw new Error(`worker_binding_inventory_mismatch:${worker}`);
  }));
}

function expectedBindings(config, secrets, worker) {
  return [
    ...Object.entries(config.vars ?? {}).map(([name, text]) => ({ name, type: "plain_text", text: String(text) })),
    ...(config.d1_databases ?? []).map((binding) => ({ name: binding.binding, type: "d1", database_id: binding.database_id })),
    ...(config.r2_buckets ?? []).map((binding) => ({ name: binding.binding, type: "r2_bucket", bucket_name: binding.bucket_name })),
    ...(config.services ?? []).map((binding) => ({ name: binding.binding, type: "service", service: binding.service, environment: binding.environment ?? null, entrypoint: binding.entrypoint ?? null })),
    ...(config.workflows ?? []).map((binding) => ({ name: binding.binding, type: "workflow", workflow_name: binding.name, class_name: binding.class_name ?? null, script_name: binding.script_name ?? worker })),
    ...(config.ratelimits ?? []).map((binding) => ({ name: binding.name, type: "ratelimit", namespace_id: binding.namespace_id, simple: { limit: binding.simple.limit, period: binding.simple.period } })),
    ...secrets.map((name) => ({ name, type: "secret_text" })),
  ].sort(bindingOrder);
}

function normalizedBindings(bindings, worker) {
  const names = new Set();
  const normalized = bindings.map((binding) => {
    if (!record(binding) || typeof binding.name !== "string" || names.has(binding.name)) throw new Error(`ambiguous_worker_binding:${worker}`);
    names.add(binding.name);
    switch (binding.type) {
      case "plain_text": return requireFields(binding, ["text"], { name: binding.name, type: binding.type, text: binding.text });
      case "secret_text": return { name: binding.name, type: binding.type };
      case "d1": return { name: binding.name, type: binding.type, database_id: unambiguousIdentity(binding, "database_id", "id") };
      case "r2_bucket": return requireFields(binding, ["bucket_name"], { name: binding.name, type: binding.type, bucket_name: binding.bucket_name });
      case "service": return requireFields(binding, ["service"], { name: binding.name, type: binding.type, service: binding.service, environment: binding.environment ?? null, entrypoint: binding.entrypoint ?? null });
      case "workflow": return requireFields(binding, ["workflow_name"], { name: binding.name, type: binding.type, workflow_name: binding.workflow_name, class_name: binding.class_name ?? null, script_name: binding.script_name ?? worker });
      case "ratelimit":
        if (!record(binding.simple) || !Number.isFinite(binding.simple.limit) || !Number.isFinite(binding.simple.period)) throw new Error(`malformed_worker_binding:${binding.name}`);
        return requireFields(binding, ["namespace_id"], { name: binding.name, type: binding.type, namespace_id: binding.namespace_id, simple: { limit: binding.simple.limit, period: binding.simple.period } });
      default: throw new Error(`unexpected_worker_binding_type:${String(binding.type)}`);
    }
  });
  return normalized.sort(bindingOrder);
}

function requireFields(source, fields, value) {
  if (fields.some((field) => typeof source[field] !== "string" || source[field].length === 0)) throw new Error(`malformed_worker_binding:${source.name}`);
  return value;
}

function unambiguousIdentity(value, current, legacy) {
  const currentValue = value[current];
  const legacyValue = value[legacy];
  if (currentValue !== undefined && legacyValue !== undefined && currentValue !== legacyValue) throw new Error("ambiguous_resource_identity");
  const identity = currentValue ?? legacyValue;
  if (typeof identity !== "string" || identity.length === 0) throw new Error("missing_resource_identity");
  return identity;
}

async function cloudflare(fetchImpl, token, pathname) {
  const response = await fetchImpl(`${api}${pathname}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  let document;
  try { document = await response.json(); } catch { throw new Error(`cloudflare_malformed_response:${pathname}`); }
  if (!response.ok || !record(document) || document.success !== true || !("result" in document)) throw new Error(`cloudflare_request_failed:${pathname}`);
  return document;
}
function parseTarget(environment) { try { return JSON.parse(required(environment, "PRODUCTION_TARGET_JSON")); } catch { throw new Error("invalid_production_target_json"); } }
function bindingOrder(left, right) { return left.name.localeCompare(right.name); }
function stableJson(value) { if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`; if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function account(environment) { return required(environment, "CLOUDFLARE_ACCOUNT_ID"); }
function required(environment, name) { const value = environment[name]; if (typeof value !== "string" || value.length === 0) throw new Error(`missing_${name.toLowerCase()}`); return value; }

if (process.argv[2] === "credential-proof") process.stdout.write(`${JSON.stringify(await verifyCredential(process.env))}\n`);
else if (process.argv[2] === "verify-target") process.stdout.write(`${JSON.stringify(await verifyProductionTarget(process.env))}\n`);
else if (process.argv[2] === "observe-bindings") process.stdout.write(`${JSON.stringify(await observeCatalogueBindings(process.env))}\n`);
