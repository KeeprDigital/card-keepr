import assert from "node:assert/strict";
import { readWorkerConfig } from "../cli/lib/config.mjs";
import test from "node:test";
import {
  observeReleaseActivation,
  observeCatalogueBindings,
  verifyProductionTarget,
  verifyUploadedVersion,
} from "../scripts/production-release-provider.mjs";

// The provider derives its expected target from the checked-in wrangler
// configuration, so the acceptance fixture derives the same way instead of
// pinning identifiers that drift when production resources are provisioned.
const ingestionConfig = await readWorkerConfig("apps/ingestion/wrangler.jsonc");
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
  "card-keepr-api": ["API_BEARER_KEY", "API_BEARER_KEY_REPLACEMENT"],
  "card-keepr-ingestion": [
    "ADMINISTRATION_KEY",
    "ADMINISTRATION_KEY_REPLACEMENT",
    "D1_EXPORT_TOKEN",
    "D1_VERIFICATION_TOKEN",
  ],
};

test("provider proves exact least-privilege Worker inventories and private R2 buckets", async () => {
  const fetchImpl = await providerFetch();
  const result = await verifyProductionTarget(environment(), fetchImpl);
  assert.deepEqual(result.worker_scripts, target.worker_scripts);
  assert.deepEqual(result.r2_buckets, target.r2_buckets);
});

test("replacement observation proves the complete post-bind inventory", async () => {
  const replacement = "00000000-0000-0000-0000-000000000099";
  const result = await observeCatalogueBindings(
    {
      ...environment(),
      REPLACEMENT_DATABASE_ID: replacement,
      RETAINED_DATABASE_ID: target.d1_databases[0].id,
    },
    await providerFetch((url, document) => {
      if (url.pathname.endsWith("/workers/scripts/card-keepr-api/settings"))
        replaceDatabase(document, replacement, false);
      if (url.pathname.endsWith("/workers/scripts/card-keepr-ingestion/settings"))
        replaceDatabase(document, replacement, true);
    }),
  );
  assert.deepEqual(result.worker_database_ids, {
    "card-keepr-api": replacement,
    "card-keepr-ingestion": replacement,
  });
});

// Before mutation, the provider verifies resource identities, R2 privacy,
// and the live workers' secret inventory. Vars and bindings are verified on
// the uploaded version instead (issue #122), because a deploy is what
// changes them; checking the deployed script would fail every release that
// carries a config change.
const preflightFailures = [
  [
    "D1 identity",
    /d1_identity_mismatch/u,
    (url, document) => {
      if (url.pathname.endsWith(target.d1_databases[0].id)) document.result.name = "wrong-database";
    },
  ],
  [
    "R2 identity",
    /r2_identity_mismatch/u,
    (url, document) => {
      if (url.pathname.endsWith("/r2/buckets/card-keepr-evidence")) document.result.name = "wrong-bucket";
    },
  ],
  [
    "managed r2.dev privacy",
    /r2_managed_domain_not_private/u,
    (url, document) => {
      if (url.pathname.endsWith("/domains/managed")) document.result.enabled = true;
    },
  ],
  [
    "custom-domain privacy",
    /r2_custom_domain_not_private/u,
    (url, document) => {
      if (url.pathname.endsWith("/domains/custom"))
        document.result.domains = [
          { domain: "public.example", enabled: true, status: { ownership: "active", ssl: "active" } },
        ];
    },
  ],
  [
    "missing secret",
    /worker_secret_inventory_mismatch/u,
    (url, document) => {
      if (url.pathname.includes("/workers/scripts/"))
        document.result.bindings = document.result.bindings.filter((binding) => binding.type !== "secret_text");
    },
  ],
  [
    "unexpected live secret",
    /worker_secret_inventory_mismatch/u,
    (url, document) => {
      if (url.pathname.endsWith("/workers/scripts/card-keepr-api/settings"))
        document.result.bindings.push({ name: "CREDENTIAL_CONSUMER_PROOF_KEY", type: "secret_text" });
    },
  ],
  [
    "unexpected privileged binding",
    /unexpected_worker_binding_type/u,
    (url, document) => {
      if (url.pathname.endsWith("/workers/scripts/card-keepr-api/settings"))
        document.result.bindings.push({ name: "UNEXPECTED_KV", type: "kv_namespace", namespace_id: "privileged" });
    },
  ],
  [
    "malformed settings",
    /malformed_worker_settings/u,
    (url, document) => {
      if (url.pathname.endsWith("/workers/scripts/card-keepr-api/settings")) document.result = {};
    },
  ],
  [
    "malformed custom domain",
    /r2_custom_domain_not_private/u,
    (url, document) => {
      if (url.pathname.endsWith("/domains/custom"))
        document.result.domains = [
          { domain: "unknown.example", enabled: false, status: { ownership: "new-state", ssl: "active" } },
        ];
    },
  ],
];

for (const [name, pattern, mutate] of preflightFailures) {
  test(`preflight fails closed on ${name}`, async () => {
    await assert.rejects(verifyProductionTarget(environment(), await providerFetch(mutate)), pattern);
  });
}

test("preflight passes when only the deployed script's vars and bindings differ from the config", async () => {
  const fetchImpl = await providerFetch((url, document) => {
    if (!url.pathname.endsWith("/settings")) return;
    const variable = document.result.bindings.find((binding) => binding.type === "plain_text");
    variable.text = "stale-value-that-the-release-will-replace";
    document.result.bindings = document.result.bindings.filter((binding) => binding.type !== "ratelimit");
  });
  const result = await verifyProductionTarget(environment(), fetchImpl);
  assert.deepEqual(result.worker_scripts, target.worker_scripts);
});

const versionEnvironment = (
  worker,
  tag = `release-2026-09-03-01-${worker === "card-keepr-api" ? "api" : "ingestion"}`,
) => ({
  ...environment(),
  RELEASE_WORKER: worker,
  RELEASE_VERSION_TAG: tag,
  RELEASE_WORKER_CONFIG: worker === "card-keepr-api" ? "apps/api/wrangler.jsonc" : "apps/ingestion/wrangler.jsonc",
});

test("the uploaded version is verified against the release configuration before activation", async () => {
  for (const worker of target.worker_scripts) {
    const result = await verifyUploadedVersion(versionEnvironment(worker), await providerFetch());
    assert.deepEqual(result, {
      worker,
      version_tag: versionEnvironment(worker).RELEASE_VERSION_TAG,
      version_id: `version-${worker}`,
    });
  }
});

const versionFailures = [
  [
    "a var value",
    /uploaded_version_binding_mismatch/u,
    versionBinding("plain_text", (binding) => (binding.text = "wrong")),
  ],
  [
    "D1 binding",
    /uploaded_version_binding_mismatch/u,
    versionBinding("d1", (binding) => (binding.database_id = "wrong")),
  ],
  [
    "R2 binding",
    /uploaded_version_binding_mismatch/u,
    versionBinding("r2_bucket", (binding) => (binding.bucket_name = "wrong")),
  ],
  [
    "service binding",
    /uploaded_version_binding_mismatch/u,
    versionBinding("service", (binding) => (binding.entrypoint = "WrongEntrypoint")),
  ],
  [
    "Workflow binding",
    /uploaded_version_binding_mismatch/u,
    versionBinding("workflow", (binding) => (binding.class_name = "WrongWorkflow")),
  ],
  [
    "rate-limit settings",
    /uploaded_version_binding_mismatch/u,
    versionBinding("ratelimit", (binding) => (binding.simple.limit += 1)),
  ],
  [
    "a secret the version lost",
    /uploaded_version_binding_mismatch/u,
    (url, document) => {
      if (/\/versions\/version-/u.test(url.pathname))
        document.result.resources.bindings = document.result.resources.bindings.filter(
          (binding) => binding.type !== "secret_text",
        );
    },
  ],
  [
    "an unexpected privileged binding",
    /unexpected_worker_binding_type/u,
    (url, document) => {
      if (/\/versions\/version-/u.test(url.pathname))
        document.result.resources.bindings.push({
          name: "UNEXPECTED_KV",
          type: "kv_namespace",
          namespace_id: "privileged",
        });
    },
  ],
  [
    "a missing tag",
    /release_version_not_found/u,
    (url, document) => {
      if (url.pathname.endsWith("/versions")) document.result.items = [];
    },
  ],
  [
    "an ambiguous tag",
    /release_version_ambiguous/u,
    (url, document) => {
      if (url.pathname.endsWith("/versions"))
        document.result.items.push({ ...document.result.items[0], id: "version-duplicate" });
    },
  ],
  [
    "malformed version resources",
    /malformed_worker_version/u,
    (url, document) => {
      if (/\/versions\/version-/u.test(url.pathname)) document.result.resources = {};
    },
  ],
];

for (const [name, pattern, mutate] of versionFailures) {
  test(`uploaded-version verification fails closed on ${name}`, async () => {
    await assert.rejects(
      verifyUploadedVersion(versionEnvironment("card-keepr-ingestion"), await providerFetch(mutate)),
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
  const configs = Object.fromEntries(
    await Promise.all(
      [
        ["card-keepr-api", "apps/api/wrangler.jsonc"],
        ["card-keepr-ingestion", "apps/ingestion/wrangler.jsonc"],
      ].map(async ([name, path]) => [name, await readWorkerConfig(path)]),
    ),
  );
  return async (input, init) => {
    assert.equal(init.headers.authorization, "Bearer provider-token");
    const url = new URL(input);
    assert.equal(url.href.includes("provider-token"), false, "credentials stay out of request URLs");
    let result;
    const deploymentWorker = /\/workers\/scripts\/([^/]+)\/deployments$/u.exec(url.pathname)?.[1];
    const worker = /\/workers\/scripts\/([^/]+)\/settings$/u.exec(url.pathname)?.[1];
    const versionsOf = /\/workers\/scripts\/([^/]+)\/versions$/u.exec(url.pathname)?.[1];
    const versionOf = /\/workers\/scripts\/([^/]+)\/versions\/version-(.+)$/u.exec(url.pathname);
    const databaseId = /\/d1\/database\/([^/]+)$/u.exec(url.pathname)?.[1];
    const bucket = /\/r2\/buckets\/([^/]+)$/u.exec(url.pathname)?.[1];
    if (url.pathname.endsWith("/zones")) result = [{ id: "zone-239", name: "keepr.digital", account: { id: account } }];
    else if (url.pathname.endsWith("/zones/zone-239/workers/routes"))
      result = Object.values(configs).flatMap((config) =>
        config.routes.map((route) => ({ id: route.pattern, pattern: route.pattern, script: config.name })),
      );
    else if (deploymentWorker)
      result = {
        deployments: [
          {
            id: `deployment-${deploymentWorker}`,
            versions: [{ version_id: `version-${deploymentWorker}`, percentage: 100 }],
          },
        ],
      };
    else if (worker) result = { bindings: bindings(configs[worker], worker) };
    else if (versionsOf) {
      // The list endpoint returns newest first with tag annotations only.
      const tag = `release-2026-09-03-01-${versionsOf === "card-keepr-api" ? "api" : "ingestion"}`;
      result = {
        items: [
          {
            id: `version-${versionsOf}`,
            metadata: { created_on: "2026-09-03T03:00:00Z" },
            annotations: { "workers/tag": tag, "workers/message": "release" },
          },
          {
            id: "version-older",
            metadata: { created_on: "2026-09-01T00:00:00Z" },
            annotations: { "workers/tag": "release-2026-09-01-01-old" },
          },
        ],
      };
    } else if (versionOf) {
      result = {
        id: `version-${versionOf[2]}`,
        resources: {
          bindings: bindings(configs[versionOf[1]], versionOf[1]),
          script_runtime: { compatibility_date: "2026-07-29" },
        },
      };
    } else if (databaseId) {
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
    ...(config.services ?? []).map((item) => ({
      name: item.binding,
      type: "service",
      service: item.service,
      entrypoint: item.entrypoint,
    })),
    ...(config.workflows ?? []).map((item) => ({
      name: item.binding,
      type: "workflow",
      workflow_name: item.name,
      class_name: item.class_name,
      script_name: worker,
    })),
    ...config.ratelimits.map((item) => ({
      name: item.name,
      type: "ratelimit",
      namespace_id: item.namespace_id,
      simple: item.simple,
    })),
    ...(config.version_metadata ? [{ name: config.version_metadata.binding, type: "version_metadata" }] : []),
    ...secrets[worker].map((name) => ({ name, type: "secret_text" })),
  ];
}

function versionBinding(type, change) {
  return (url, document) => {
    if (!/\/versions\/version-/u.test(url.pathname)) return;
    const binding = document.result.resources.bindings.find((item) => item.type === type);
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

const activationVersions = target.worker_scripts.map((worker) => ({ worker, version_id: `version-${worker}` }));
const activationConfigs = ["apps/api/wrangler.jsonc", "apps/ingestion/wrangler.jsonc"];
test("fresh handoff observation records exact active versions and zone routes", async () => {
  const observed = await observeReleaseActivation(
    environment(),
    activationVersions,
    activationConfigs,
    await providerFetch(),
  );
  assert.equal(observed.workers.length, 2);
  for (const worker of observed.workers) {
    assert.equal(worker.versions[0].percentage, 100);
    assert.equal(worker.routes.length, 2);
  }
});
for (const [label, mutate, error] of [
  [
    "wrong active version",
    (url, doc) => {
      if (url.pathname.endsWith("/deployments")) doc.result.deployments[0].versions[0].version_id = "other-version";
    },
    /release_active_version_mismatch/,
  ],
  [
    "partial traffic",
    (url, doc) => {
      if (url.pathname.endsWith("/deployments")) doc.result.deployments[0].versions[0].percentage = 50;
    },
    /release_active_version_mismatch/,
  ],
  [
    "wrong active binding",
    versionBinding("d1", (binding) => {
      binding.database_id = "other-database";
    }),
    /release_active_version_binding_mismatch/,
  ],
  [
    "missing route",
    (url, doc) => {
      if (url.pathname.endsWith("/workers/routes")) doc.result = [];
    },
    /release_route_mismatch/,
  ],
  [
    "foreign route",
    (url, doc) => {
      if (url.pathname.endsWith("/workers/routes")) doc.result[0].script = "foreign";
    },
    /release_route_mismatch/,
  ],
  [
    "ambiguous zone",
    (url, doc) => {
      if (url.pathname.endsWith("/zones")) doc.result.push(doc.result[0]);
    },
    /release_route_zone_ambiguous/,
  ],
])
  test(`fresh handoff rejects ${label}`, async () => {
    await assert.rejects(
      () => observeReleaseActivation(environment(), activationVersions, activationConfigs, awaitedFetch),
      error,
    );
    async function awaitedFetch(input, init) {
      return (await providerFetch(mutate))(input, init);
    }
  });
