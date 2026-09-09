import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createServer } from "vite";
import { devAudience, requiredCiChecks } from "../src/http/dev-workflow-identity.mjs";
import { d1Adapter } from "./helpers/query-helpers/sqlite-d1-adapter.mjs";

// Synthetic GitHub attestations are cryptographically signed with a test-only
// key. No retained real-source data or live CI success is claimed here.
async function fixture(t, sha = "a".repeat(40)) {
  const vite = await createServer({ logLevel: "silent", server: { middlewareMode: true } });
  t.after(() => vite.close());
  const { handleDevDeployment } = await vite.ssrLoadModule("/src/catalogue/ingestion/dev-deployment.ts");
  const { catalogueStore } = await vite.ssrLoadModule("/src/catalogue/shared/index.ts");
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  for (const name of (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort())
    database.exec(await readFile(`migrations/${name}`, "utf8"));
  const key = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = { ...(await crypto.subtle.exportKey("jwk", key.publicKey)), kid: "synthetic", alg: "RS256", use: "sig" };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "https://token.actions.githubusercontent.com",
    aud: devAudience,
    sub: "repo:KeeprDigital/card-keepr:environment:dev",
    repository: "KeeprDigital/card-keepr",
    repository_id: "1313489088",
    repository_owner_id: "114643329",
    environment: "dev",
    ref: "refs/heads/main",
    event_name: "workflow_run",
    workflow_ref: "KeeprDigital/card-keepr/.github/workflows/dev-deploy.yml@refs/heads/main",
    workflow_sha: sha,
    sha,
    run_id: "456",
    run_attempt: "1",
    jti: "synthetic-jti",
    iat: now,
    nbf: now,
    exp: now + 300,
  };
  const checks = requiredCiChecks.map((name) => ({
    name,
    head_sha: sha,
    app: { slug: "github-actions" },
    status: "completed",
    conclusion: "success",
  }));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    let result;
    if (path.endsWith("/.well-known/jwks")) result = { keys: [jwk] };
    else if (path.endsWith("/actions/runs/456"))
      result = {
        repository: { id: 1313489088 },
        path: ".github/workflows/dev-deploy.yml",
        event: "workflow_run",
        head_sha: sha,
        head_branch: "main",
        run_attempt: 1,
        status: "in_progress",
      };
    else if (path.endsWith("/actions/runs/123"))
      result = {
        repository: { id: 1313489088 },
        path: ".github/workflows/ci.yml",
        event: "push",
        head_sha: sha,
        head_branch: "main",
        status: "completed",
        conclusion: "success",
      };
    else if (path.includes("/compare/")) result = { status: "identical" };
    else if (path.endsWith("/check-runs")) result = { check_runs: checks, total_count: checks.length };
    else throw new Error(`Unexpected synthetic provider request: ${path}`);
    return Response.json(result);
  };
  const env = {
    KEEPR_ENVIRONMENT: "dev",
    CATALOGUE_DB: catalogueStore(d1Adapter(database)),
    CATALOGUE_EXPORTS: { head: async () => null, list: async () => ({ objects: [], truncated: false }) },
    CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    CATALOGUE_D1_DATABASE_ID: "00000000-0000-0000-0000-000000000001",
    DISPOSABLE_D1_DATABASE_ID: "00000000-0000-0000-0000-000000000002",
  };
  const call = async (overrides = {}, environment = env, intent = { head_sha: sha, ci_run_id: "123" }) => {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const message = `${encode({ alg: "RS256", typ: "JWT", kid: "synthetic" })}.${encode({ ...claims, ...overrides })}`;
    const signature = Buffer.from(
      await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(message)),
    ).toString("base64url");
    return handleDevDeployment(
      new Request(devAudience, {
        method: "POST",
        headers: { authorization: `Bearer ${message}.${signature}`, "x-github-token": "synthetic-github-token" },
        body: JSON.stringify(intent),
      }),
      environment,
    );
  };
  return { call, env, checks, database };
}

test("verified dev workflow prepares only its exact commit and rejects replay", async (t) => {
  const { call } = await fixture(t);
  const response = await call();
  assert.equal(response.status, 201);
  const document = await response.json();
  const plan = JSON.parse(document.prepared_plan_json);
  assert.equal(plan.expected_head_sha, "a".repeat(40));
  assert.deepEqual(plan.production_target.worker_scripts, ["card-keepr-api-dev", "card-keepr-ingestion-dev"]);
  assert.equal(plan.bootstrap, true);
  await assert.rejects(call(), (error) => error.code === "dev_intent_replayed");
});

test("dev preparation rejects signed identity substitution, stale tokens and failed exact-SHA shards", async (t) => {
  const { call, env, checks } = await fixture(t);
  for (const overrides of [
    { aud: "production" },
    { repository_id: "1" },
    { ref: "refs/heads/other" },
    { environment: "staging" },
    { workflow_ref: "KeeprDigital/card-keepr/.github/workflows/ci.yml@refs/heads/main" },
    { exp: 1 },
    { run_attempt: "2" },
  ])
    await assert.rejects(call(overrides), (error) => error.code === "invalid_dev_workflow_attestation");
  for (const target of ["production", "staging"])
    await assert.rejects(call({}, { ...env, KEEPR_ENVIRONMENT: target }), (error) => error.status === 404);
  checks[0].conclusion = "failure";
  await assert.rejects(call(), (error) => error.code === "invalid_dev_workflow_attestation");
  checks[0].conclusion = "success";
  checks.pop();
  await assert.rejects(call(), (error) => error.code === "invalid_dev_workflow_attestation");
});

test("owner first install uses the canonical preparation transaction on an unused dev baseline", async (t) => {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const { database, env, checks } = await fixture(t, head);
  const githubFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (new URL(url).hostname !== "api.cloudflare.com") return githubFetch(url, options);
    if (options.method !== "POST") {
      const id = String(url).split("/").at(-1);
      return Response.json({
        success: true,
        result: {
          uuid: id,
          name:
            id === env.CATALOGUE_D1_DATABASE_ID ? "card-keepr-catalogue-dev" : "card-keepr-disposable-verification-dev",
        },
      });
    }
    const { batch } = JSON.parse(options.body);
    database.exec("BEGIN");
    try {
      const result = batch.map(({ sql, params }) => {
        const statement = database.prepare(sql);
        const results = sqliteResults(statement, params);
        return { success: true, results, meta: {} };
      });
      database.exec("COMMIT");
      return Response.json({ success: true, result });
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };
  const { prepareFirstDevInstall } = await import("../scripts/dev-first-install.mjs");
  const input = {
    DEV_CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
    DEV_CATALOGUE_DATABASE_ID: env.CATALOGUE_D1_DATABASE_ID,
    DEV_DISPOSABLE_DATABASE_ID: env.DISPOSABLE_D1_DATABASE_ID,
    EXPECTED_HEAD_SHA: head,
    CI_RUN_ID: "123",
    GH_TOKEN: "synthetic-github-token",
    CLOUDFLARE_API_TOKEN: "synthetic-dev-provider-token",
  };
  checks[0].status = "in_progress";
  await assert.rejects(prepareFirstDevInstall(input), /invalid_dev_workflow_attestation/u);
  checks[0].status = "completed";
  const prepared = await prepareFirstDevInstall(input);
  assert.equal(JSON.parse(prepared.prepared_plan_json).expected_head_sha, head);
  assert.equal(prepared.environment, "dev");
  await assert.rejects(prepareFirstDevInstall(input), /first_install_requires_unused_dev_baseline/u);
});

test("a signed dev run cannot substitute another independently passing main commit", async (t) => {
  const { call, env, checks } = await fixture(t);
  const older = "b".repeat(40);
  for (const check of checks) check.head_sha = older;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const response = await original(url, options);
    if (String(url).endsWith("/actions/runs/123"))
      return Response.json({ ...(await response.json()), head_sha: older });
    return response;
  };
  await assert.rejects(
    call({}, env, { head_sha: older, ci_run_id: "123" }),
    (error) => error.code === "invalid_dev_workflow_attestation",
  );
});

// The operating-system command and provider HTTP boundaries are simulated;
// preparation, generated release SQL, SQLite state and all observers are real.
for (const [scenario, expectedError] of [
  ["approved", null],
  ["older version", /release_active_version_mismatch/u],
  ["split traffic", /release_active_version_mismatch/u],
  ["foreign route", /release_route_mismatch/u],
])
  test(`dev executor ${scenario} preserves exact activation before releasing its fence`, async (t) => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const { call, env, database } = await fixture(t, head);
    const prepared = await (await call()).json();
    const { devConfigurations } = await import("../scripts/dev-environment.mjs");
    const configs = await devConfigurations({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      catalogueId: env.CATALOGUE_D1_DATABASE_ID,
      disposableId: env.DISPOSABLE_D1_DATABASE_ID,
    });
    for (const [app, config] of Object.entries(configs)) {
      const path = `apps/${app}/wrangler.dev.json`;
      const previous = await readFile(path).catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      t.after(() => (previous === null ? rm(path, { force: true }) : writeFile(path, previous)));
      await writeFile(path, JSON.stringify(config));
    }
    const target = JSON.parse(prepared.prepared_plan_json).production_target;
    const byName = Object.fromEntries(Object.values(configs).map((config) => [config.name, config]));
    const githubFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(input);
      requests.push(url.pathname);
      if (url.hostname === "api.github.com") return githubFetch(input, init);
      if (url.hostname === "dev.card.keepr.digital") {
        const runtime = url.pathname.includes("/ingest/") ? "ingestion" : "api";
        if (
          url.pathname.endsWith("/health") &&
          (runtime === "ingestion" || init.headers.authorization !== "Bearer synthetic-traffic")
        )
          return Response.json({ code: "authentication_required" }, { status: 401 });
        return Response.json(
          url.pathname.endsWith("/v1/catalogue")
            ? { meta: { catalogue_revision_id: "catrev_spine_000" } }
            : { status: "ok", runtime, checks: {} },
          { headers: { "x-catalogue-revision": "catrev_spine_000" } },
        );
      }
      assert.equal(url.hostname, "api.cloudflare.com");
      if (url.pathname.includes("/workflows/")) return new Response(null, { status: 404 });
      let result;
      if (url.pathname.endsWith("/query")) {
        const { sql } = JSON.parse(init.body);
        result = sql
          .split(/;\s*/u)
          .filter((text) => text.trim())
          .map((text) => {
            const statement = database.prepare(text);
            const results = sqliteResults(statement);
            return { success: true, results };
          });
      } else if (url.pathname.endsWith("/zones"))
        result = [{ id: "synthetic-zone", name: "keepr.digital", account: { id: env.CLOUDFLARE_ACCOUNT_ID } }];
      else if (url.pathname.endsWith("/workers/routes"))
        result = Object.values(configs).flatMap((config) =>
          config.routes.map((route) => ({
            pattern: route.pattern,
            script: scenario === "foreign route" ? "foreign" : config.name,
          })),
        );
      else if (url.pathname.endsWith("/domains/managed"))
        result = { enabled: false, bucketId: "synthetic-bucket", domain: "private.r2.dev" };
      else if (url.pathname.endsWith("/domains/custom")) result = { domains: [] };
      else if (url.pathname.includes("/r2/buckets/")) result = { name: url.pathname.split("/").at(-1) };
      else if (url.pathname.includes("/d1/database/")) {
        const id = url.pathname.split("/").at(-1);
        result = { uuid: id, name: target.d1_databases.find((item) => item.id === id)?.name };
      } else {
        const worker = /\/workers\/scripts\/([^/]+)/u.exec(url.pathname)?.[1];
        const config = byName[worker];
        assert.ok(config, `Unexpected simulated provider request ${url.pathname}`);
        if (url.pathname.endsWith("/deployments"))
          result = {
            deployments: [
              {
                id: `deployment-${worker}`,
                versions:
                  scenario === "split traffic"
                    ? [
                        { version_id: `version-${worker}`, percentage: 50 },
                        { version_id: "older", percentage: 50 },
                      ]
                    : [{ version_id: scenario === "older version" ? "older" : `version-${worker}`, percentage: 100 }],
              },
            ],
          };
        else if (url.pathname.endsWith("/versions"))
          result = {
            items: [
              {
                id: `version-${worker}`,
                annotations: {
                  "workers/tag": `release-${prepared.release_id}-${worker === configs.api.name ? "api" : "ingestion"}`,
                },
              },
            ],
          };
        else if (url.pathname.includes("/versions/")) result = { resources: { bindings: devBindings(config) } };
        else if (url.pathname.endsWith("/settings")) result = { bindings: devBindings(config) };
        else assert.fail(`Unexpected simulated provider request ${url.pathname}`);
      }
      return Response.json({ success: true, result });
    };
    const commands = [];
    const executeCommand = async (command, args) => {
      if (command === "git") return { stdout: head };
      commands.push({ command, args });
      assert.ok(command.endsWith("/wrangler") || command === "bash");
      return { stdout: "" };
    };
    const { deployDev } = await import("../scripts/deploy-dev.mjs");
    const input = {
      ...Object.fromEntries(Object.entries(prepared.dispatch_inputs).map(([key, value]) => [key.toUpperCase(), value])),
      RELEASE_ENVIRONMENT: "dev",
      EXPECTED_HEAD_SHA: head,
      CI_RUN_ID: "123",
      GH_TOKEN: "synthetic-github-token",
      CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
      DEV_CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
      DEV_CATALOGUE_DATABASE_ID: env.CATALOGUE_D1_DATABASE_ID,
      DEV_DISPOSABLE_DATABASE_ID: env.DISPOSABLE_D1_DATABASE_ID,
      CLOUDFLARE_API_TOKEN: "synthetic-provider",
      API_TRAFFIC_TOKEN: "synthetic-traffic",
    };
    if (expectedError) {
      await assert.rejects(deployDev(input, executeCommand), expectedError);
      assert.equal(
        database.prepare("SELECT active_production_release_id FROM operation_state WHERE singleton=1").get()
          .active_production_release_id,
        prepared.release_id,
      );
      assert.equal(
        database
          .prepare(
            "SELECT count(*) AS count FROM administration_idempotency WHERE operation IN ('production_release_binding_observed','production_release_succeeded')",
          )
          .get().count,
        0,
      );
      assert.equal(
        requests.some((path) => path === "/api/health"),
        false,
      );
      assert.ok(commands.some(({ command }) => command === "bash"));
    } else {
      const result = await deployDev(input, executeCommand);
      assert.equal(result.head_sha, head);
      assert.equal(
        database.prepare("SELECT active_production_release_id FROM operation_state WHERE singleton=1").get()
          .active_production_release_id,
        null,
      );
      assert.equal(
        database
          .prepare(
            "SELECT count(*) AS count FROM administration_idempotency WHERE operation='production_release_succeeded'",
          )
          .get().count,
        1,
      );
      assert.equal(requests.filter((path) => path.endsWith("/deployments")).length, 2);
    }
  });

function devBindings(config) {
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
      script_name: config.name,
    })),
    ...config.ratelimits.map((item) => ({
      name: item.name,
      type: "ratelimit",
      namespace_id: item.namespace_id,
      simple: item.simple,
    })),
    ...(config.version_metadata ? [{ name: config.version_metadata.binding, type: "version_metadata" }] : []),
    ...(config.name === "card-keepr-api-dev"
      ? ["API_BEARER_KEY", "API_BEARER_KEY_REPLACEMENT"]
      : ["ADMINISTRATION_KEY", "ADMINISTRATION_KEY_REPLACEMENT", "D1_EXPORT_TOKEN", "D1_VERIFICATION_TOKEN"]
    ).map((name) => ({ name, type: "secret_text" })),
  ];
}

function sqliteResults(statement, params = []) {
  if (statement.columns().length) return statement.all(...params);
  statement.run(...params);
  return [];
}
