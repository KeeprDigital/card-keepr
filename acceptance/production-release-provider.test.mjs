import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  observeCatalogueBindings,
  verifyProductionTarget,
} from "../scripts/production-release-provider.mjs";

// The provider derives its expected target from the checked-in wrangler
// configuration, so the acceptance fixture derives the same way instead of
// pinning identifiers that drift when production resources are provisioned.
const ingestionConfig = JSON.parse(
  await readFile("apps/ingestion/wrangler.jsonc", "utf8"),
);
const account = ingestionConfig.vars.CLOUDFLARE_ACCOUNT_ID;
const target = {
  cloudflare_account_id: account,
  worker_scripts: ["card-keepr-api", "card-keepr-ingestion"],
  d1_databases: [
    {
      name: "card-keepr-catalogue",
      id: ingestionConfig.d1_databases[0].database_id,
    },
    {
      name: "card-keepr-disposable-verification",
      id: ingestionConfig.vars.DISPOSABLE_D1_DATABASE_ID,
    },
  ],
  r2_buckets: ingestionConfig.r2_buckets.map((binding) => binding.bucket_name),
};
const secrets = {
  "card-keepr-api": ["API_BEARER_KEY", "API_BEARER_KEY_REPLACEMENT", "CREDENTIAL_CONSUMER_PROOF_KEY"],
  "card-keepr-ingestion": ["ADMINISTRATION_KEY", "ADMINISTRATION_KEY_REPLACEMENT", "CREDENTIAL_BOUNDARY_ATTESTATION_KEY", "CREDENTIAL_CONSUMER_PROOF_KEY", "CLOUDFLARE_OBSERVATION_TOKEN", "GITHUB_APP_PRIVATE_KEY", "GITHUB_OBSERVATION_ACTOR", "D1_EXPORT_TOKEN", "D1_EXPORT_TOKEN_REPLACEMENT", "D1_VERIFICATION_TOKEN", "D1_VERIFICATION_TOKEN_REPLACEMENT"],
};

test("provider proves exact least-privilege Worker inventories and private R2 buckets", async () => {
  const fetchImpl = await providerFetch();
  const result = await verifyProductionTarget(environment(), fetchImpl);
  assert.deepEqual(result.worker_scripts, target.worker_scripts);
  assert.deepEqual(result.r2_buckets, target.r2_buckets);
});

test("replacement observation proves the complete post-bind inventory", async () => {
  const replacement = "00000000-0000-0000-0000-000000000099";
  const result = await observeCatalogueBindings({
    ...environment(), REPLACEMENT_DATABASE_ID: replacement,
    RETAINED_DATABASE_ID: target.d1_databases[0].id,
  }, await providerFetch((url, document) => {
    if (url.pathname.endsWith("/workers/scripts/card-keepr-api/settings")) replaceDatabase(document, replacement, false);
    if (url.pathname.endsWith("/workers/scripts/card-keepr-ingestion/settings")) replaceDatabase(document, replacement, true);
  }));
  assert.deepEqual(result.worker_database_ids, {
    "card-keepr-api": replacement,
    "card-keepr-ingestion": replacement,
  });
});

const failures = [
  ["D1 identity", /d1_identity_mismatch/u, (url, document) => {
    if (url.pathname.endsWith(target.d1_databases[0].id)) document.result.name = "wrong-database";
  }],
  ["R2 identity", /r2_identity_mismatch/u, (url, document) => {
    if (url.pathname.endsWith("/r2/buckets/card-keepr-evidence")) document.result.name = "wrong-bucket";
  }],
  ["managed r2.dev privacy", /r2_managed_domain_not_private/u, (url, document) => {
    if (url.pathname.endsWith("/domains/managed")) document.result.enabled = true;
  }],
  ["custom-domain privacy", /r2_custom_domain_not_private/u, (url, document) => {
    if (url.pathname.endsWith("/domains/custom")) document.result.domains = [{ domain: "public.example", enabled: true, status: { ownership: "active", ssl: "active" } }];
  }],
  ["D1 binding", /worker_binding_inventory_mismatch/u, workerBinding("d1", (binding) => binding.database_id = "wrong")],
  ["R2 binding", /worker_binding_inventory_mismatch/u, workerBinding("r2_bucket", (binding) => binding.bucket_name = "wrong")],
  ["service binding", /worker_binding_inventory_mismatch/u, workerBinding("service", (binding) => binding.entrypoint = "WrongEntrypoint")],
  ["Workflow binding", /worker_binding_inventory_mismatch/u, workerBinding("workflow", (binding) => binding.class_name = "WrongWorkflow")],
  ["rate-limit settings", /worker_binding_inventory_mismatch/u, workerBinding("ratelimit", (binding) => binding.simple.limit += 1)],
  ["secret name", /worker_binding_inventory_mismatch/u, (url, document) => {
    if (url.pathname.includes("/workers/scripts/")) document.result.bindings = document.result.bindings.filter((binding) => binding.type !== "secret_text");
  }],
  ["unexpected privileged binding", /unexpected_worker_binding_type/u, (url, document) => {
    if (url.pathname.endsWith("/workers/scripts/card-keepr-api/settings")) document.result.bindings.push({ name: "UNEXPECTED_KV", type: "kv_namespace", namespace_id: "privileged" });
  }],
  ["malformed settings", /malformed_worker_settings/u, (url, document) => {
    if (url.pathname.endsWith("/workers/scripts/card-keepr-api/settings")) document.result = {};
  }],
  ["malformed custom domain", /r2_custom_domain_not_private/u, (url, document) => {
    if (url.pathname.endsWith("/domains/custom")) document.result.domains = [{ domain: "unknown.example", enabled: false, status: { ownership: "new-state", ssl: "active" } }];
  }],
];

for (const [name, pattern, mutate] of failures) {
  test(`provider fails closed on ${name}`, async () => {
    await assert.rejects(
      verifyProductionTarget(environment(), await providerFetch(mutate)),
      pattern,
    );
  });
}

function environment() {
  return {
    CLOUDFLARE_API_TOKEN: "provider-token",
    CLOUDFLARE_ACCOUNT_ID: account,
    PRODUCTION_TARGET_JSON: JSON.stringify(target),
    REPLACEMENT_DATABASE_ID: "none",
    RETAINED_DATABASE_ID: "none",
  };
}

async function providerFetch(mutate = () => {}) {
  const configs = Object.fromEntries(await Promise.all([
    ["card-keepr-api", "apps/api/wrangler.jsonc"],
    ["card-keepr-ingestion", "apps/ingestion/wrangler.jsonc"],
  ].map(async ([name, path]) => [name, JSON.parse(await readFile(path, "utf8"))])));
  return async (input, init) => {
    assert.equal(init.headers.authorization, "Bearer provider-token");
    const url = new URL(input);
    let result;
    const worker = /\/workers\/scripts\/([^/]+)\/settings$/u.exec(url.pathname)?.[1];
    const databaseId = /\/d1\/database\/([^/]+)$/u.exec(url.pathname)?.[1];
    const bucket = /\/r2\/buckets\/([^/]+)$/u.exec(url.pathname)?.[1];
    if (worker) result = { bindings: bindings(configs[worker], worker) };
    else if (databaseId) {
      const expected = target.d1_databases.find((item) => item.id === databaseId);
      result = { uuid: databaseId, name: expected?.name };
    } else if (url.pathname.endsWith("/domains/managed")) {
      result = { bucketId: "bucket-id", domain: "private.r2.dev", enabled: false };
    } else if (url.pathname.endsWith("/domains/custom")) result = { domains: [] };
    else if (bucket) result = { name: bucket };
    else return new Response(null, { status: 404 });
    const document = { success: true, result };
    mutate(url, document);
    return Response.json(document);
  };
}

function bindings(config, worker) {
  return [
    ...Object.entries(config.vars ?? {}).map(([name, text]) => ({ name, type: "plain_text", text: String(text) })),
    ...config.d1_databases.map((item) => ({ name: item.binding, type: "d1", database_id: item.database_id })),
    ...config.r2_buckets.map((item) => ({ name: item.binding, type: "r2_bucket", bucket_name: item.bucket_name })),
    ...(config.services ?? []).map((item) => ({ name: item.binding, type: "service", service: item.service, entrypoint: item.entrypoint })),
    ...(config.workflows ?? []).map((item) => ({ name: item.binding, type: "workflow", workflow_name: item.name, class_name: item.class_name, script_name: worker })),
    ...config.ratelimits.map((item) => ({ name: item.name, type: "ratelimit", namespace_id: item.namespace_id, simple: item.simple })),
    ...secrets[worker].map((name) => ({ name, type: "secret_text" })),
  ];
}

function workerBinding(type, change) {
  return (url, document) => {
    if (!url.pathname.includes("/workers/scripts/")) return;
    const binding = document.result.bindings.find((item) => item.type === type);
    if (binding) change(binding);
  };
}

function replaceDatabase(document, replacement, ingestion) {
  const d1 = document.result.bindings.find((binding) => binding.type === "d1");
  d1.database_id = replacement;
  if (ingestion) {
    const variable = document.result.bindings.find((binding) => binding.name === "CATALOGUE_D1_DATABASE_ID");
    variable.text = replacement;
  }
}
