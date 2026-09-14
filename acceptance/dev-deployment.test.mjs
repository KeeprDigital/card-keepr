import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createServer } from "vite";
import { devAudience, requiredCiChecks } from "../src/http/dev-workflow-identity.mjs";
import {
  activeReleaseIdentity,
  countAdministrationOutcomes,
  countMigrationStartedEvidence,
  countReleaseCompletionEvidence,
  countSuccessfulReleaseEvidence,
} from "./helpers/query-helpers/production-release.mjs";
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
    aud: "https://card-dev.keepr.digital/ingest/v1/dev-deployments",
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
  const scratch = {
    databases: [{ name: "card-keepr-disposable-verification-dev", uuid: "00000000-0000-0000-0000-000000000002" }],
    nextId: "00000000-0000-0000-0000-000000000003",
  };
  const { cloudflareD1BackupProvider } = await vite.ssrLoadModule("/src/catalogue/backup-recovery/index.ts");
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (new URL(url).hostname === "api.cloudflare.com") {
      if (options.method === "DELETE")
        scratch.databases = scratch.databases.filter((entry) => entry.uuid !== path.split("/").at(-1));
      if (options.method === "POST") {
        const entry = { name: JSON.parse(options.body).name, uuid: scratch.nextId };
        scratch.databases.push(entry);
        return Response.json({ success: true, result: entry });
      }
      return Response.json({ success: true, result: scratch.databases });
    }
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
    D1_VERIFICATION_TOKEN: "synthetic-verification-token",
  };
  const workflowToken = async (overrides = {}) => {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const message = `${encode({ alg: "RS256", typ: "JWT", kid: "synthetic" })}.${encode({ ...claims, ...overrides })}`;
    const signature = Buffer.from(
      await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(message)),
    ).toString("base64url");
    return `${message}.${signature}`;
  };
  const call = async (overrides = {}, environment = env, intent = { head_sha: sha, ci_run_id: "123" }) => {
    return handleDevDeployment(
      new Request(devAudience, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await workflowToken(overrides)}`,
          "x-github-token": "synthetic-github-token",
        },
        body: JSON.stringify(intent),
      }),
      environment,
    );
  };
  const rotateDisposable = () =>
    cloudflareD1BackupProvider.prepareRestoreTarget({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      configuredDatabaseId: env.DISPOSABLE_D1_DATABASE_ID,
      disposableDatabaseName: "card-keepr-disposable-verification-dev",
      token: env.D1_VERIFICATION_TOKEN,
      attemptId: "synthetic-backup",
      previousDatabaseId: null,
      generation: 1,
    });
  return {
    call,
    env,
    checks,
    database,
    scratch,
    rotateDisposable,
    workflowToken,
    receive: (request) => handleDevDeployment(request, env),
  };
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

test("dev preparation discovers the current scratch identity after a real provider rotation", async (t) => {
  const { call, env, scratch, rotateDisposable } = await fixture(t);
  const foreign = { name: "card-keepr-disposable-verification", uuid: "00000000-0000-0000-0000-000000000004" };
  scratch.databases.push(foreign);
  const rotated = await rotateDisposable();
  assert.equal(rotated.databaseId, "00000000-0000-0000-0000-000000000003");
  assert.ok(scratch.databases.includes(foreign));
  const prepared = await (await call()).json();
  assert.equal(JSON.parse(prepared.prepared_plan_json).production_target.d1_databases[1].id, rotated.databaseId);
  assert.equal(env.DISPOSABLE_D1_DATABASE_ID, "00000000-0000-0000-0000-000000000002");
});

test("dev preparation requires uniquely owned available scratch inventory before retaining intent", async (t) => {
  const { call, scratch } = await fixture(t);
  const current = scratch.databases[0];
  for (const inventory of [
    [],
    [{ ...current, name: "card-keepr-disposable-verification" }],
    [current, { ...current, uuid: scratch.nextId }],
  ]) {
    scratch.databases = inventory;
    await assert.rejects(call(), /Disposable D1 identity is missing or ambiguous/u);
  }
  scratch.databases = [current];
  const providerFetch = globalThis.fetch;
  globalThis.fetch = (url, options) =>
    new URL(url).hostname === "api.cloudflare.com"
      ? Promise.resolve(Response.json({ success: false }, { status: 403 }))
      : providerFetch(url, options);
  await assert.rejects(call(), /Cloudflare D1 management operation failed/u);
  globalThis.fetch = providerFetch;
  assert.equal((await call()).status, 201);
});

test("dev preparation rejects signed identity substitution, stale tokens and failed exact-SHA shards", async (t) => {
  const { call, env, checks } = await fixture(t);
  for (const overrides of [
    { aud: "production" },
    { aud: "https://dev.card.keepr.digital/ingest/v1/dev-deployments" },
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
  const denySource = "export default { fetch() { return new Response('Dev installation pending', {status:503}); } };";
  let shellSource = denySource;
  let shellHasDataBinding = false;
  let shellHasRoute = false;
  globalThis.fetch = async (url, options) => {
    if (new URL(url).hostname !== "api.cloudflare.com") return githubFetch(url, options);
    const path = new URL(url).pathname;
    if (path.endsWith("/zones"))
      return Response.json({
        success: true,
        result: [{ id: "synthetic-zone", account: { id: env.CLOUDFLARE_ACCOUNT_ID } }],
      });
    if (path.endsWith("/workers/routes"))
      return Response.json({ success: true, result: shellHasRoute ? [{ script: "card-keepr-api-dev" }] : [] });
    if (path.includes("/workflows/")) return new Response(null, { status: 404 });
    if (path.includes("/workers/scripts/")) {
      if (path.endsWith("/subdomain"))
        return Response.json({ success: true, result: { enabled: false, previews_enabled: false } });
      if (path.endsWith("/settings"))
        return Response.json({
          success: true,
          result: {
            bindings: shellHasDataBinding
              ? [{ name: "CATALOGUE_DB", type: "d1" }]
              : (path.includes("-api-dev/")
                  ? ["API_BEARER_KEY", "API_BEARER_KEY_REPLACEMENT"]
                  : ["ADMINISTRATION_KEY", "ADMINISTRATION_KEY_REPLACEMENT", "D1_EXPORT_TOKEN", "D1_VERIFICATION_TOKEN"]
                ).map((name) => ({ name, type: "secret_text" })),
          },
        });
      const form = new FormData();
      form.set("deny.mjs", shellSource);
      return new Response(form);
    }
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
    database.exec("SAVEPOINT dev_d1_batch");
    try {
      const result = batch.map(({ sql, params }) => {
        const statement = database.prepare(sql);
        const results = sqliteResults(statement, params);
        return { success: true, results, meta: {} };
      });
      database.exec("RELEASE dev_d1_batch");
      return Response.json({ success: true, result });
    } catch (error) {
      database.exec("ROLLBACK TO dev_d1_batch; RELEASE dev_d1_batch");
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

  const directory = await mkdtemp(join(tmpdir(), "keepr-dev-first-retry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dispatch = Object.fromEntries(
    Object.entries(prepared.dispatch_inputs).map(([key, value]) => [key.toUpperCase(), value]),
  );
  const { validateDispatchAndWriteSql } = await import("../scripts/production-release.mjs");
  await validateDispatchAndWriteSql(dispatch, directory);
  const apply = async (...names) => {
    for (const name of names) database.exec(await readFile(join(directory, `${name}.sql`), "utf8"));
  };
  const retry = {
    ...input,
    DEV_FIRST_INSTALL_RETRY_OF: prepared.release_id,
    DEV_API_SECRETS_FILE: join(directory, "api.json"),
    DEV_INGESTION_SECRETS_FILE: join(directory, "ingestion.json"),
  };
  for (const [app, names] of [
    ["api", ["API_BEARER_KEY", "API_BEARER_KEY_REPLACEMENT"]],
    ["ingestion", ["ADMINISTRATION_KEY", "ADMINISTRATION_KEY_REPLACEMENT", "D1_EXPORT_TOKEN", "D1_VERIFICATION_TOKEN"]],
  ])
    await writeFile(
      join(directory, `${app}.json`),
      JSON.stringify(Object.fromEntries(names.map((name) => [name, `synthetic-${name}-credential`]))),
    );
  database.exec("SAVEPOINT activated_attempt");
  await apply("claim", "migration-started", "deploying", "failure-evidence", "cleanup");
  await assert.rejects(prepareFirstDevInstall(retry), /first_install_(retry_not_safe|requires_unused_dev_baseline)/u);
  database.exec("ROLLBACK TO activated_attempt; RELEASE activated_attempt");
  await apply("claim", "migration-started", "failure-evidence", "cleanup");
  await assert.rejects(
    prepareFirstDevInstall({ ...retry, DEV_FIRST_INSTALL_RETRY_OF: "unrelated-release" }),
    /first_install_(retry_not_safe|requires_unused_dev_baseline)/u,
  );
  const commands = [];
  t.mock.method(childProcess, "execFileSync", (command, args) => {
    if (command === "git") return head;
    commands.push(args);
    return "";
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  shellSource = "export default { fetch() { return new Response('Application'); } };";
  await assert.rejects(prepareFirstDevInstall(retry), /first_install_retry_not_safe/u);
  shellSource = denySource;
  shellHasDataBinding = true;
  await assert.rejects(prepareFirstDevInstall(retry), /first_install_retry_not_safe/u);
  shellHasDataBinding = false;
  shellHasRoute = true;
  await assert.rejects(prepareFirstDevInstall(retry), /first_install_retry_not_safe/u);
  shellHasRoute = false;
  assert.equal(commands.length, 0, "unsafe targets cause no shell writes");
  const ingestionSecrets = JSON.parse(await readFile(retry.DEV_INGESTION_SECRETS_FILE, "utf8"));
  await writeFile(
    retry.DEV_INGESTION_SECRETS_FILE,
    JSON.stringify({ ...ingestionSecrets, D1_EXPORT_TOKEN: ingestionSecrets.D1_VERIFICATION_TOKEN }),
  );
  await assert.rejects(prepareFirstDevInstall(retry), /dev_secrets_must_be_distinct/u);
  await writeFile(retry.DEV_INGESTION_SECRETS_FILE, JSON.stringify({ ADMINISTRATION_KEY: "incomplete-inventory" }));
  await assert.rejects(prepareFirstDevInstall(retry), /invalid_dev_secret_inventory/u);
  assert.equal(commands.length, 0, "both credential files must be valid before either shell is refreshed");
  await writeFile(retry.DEV_INGESTION_SECRETS_FILE, JSON.stringify(ingestionSecrets));
  const retried = await prepareFirstDevInstall(retry);
  assert.notEqual(retried.release_id, prepared.release_id);
  assert.equal(commands.length, 0, "preparation cannot refresh Workers before claiming the deployment lease");
  assert.equal(
    countAdministrationOutcomes(database).get().count,
    5,
    "prior failure history is retained alongside a fresh canonical preparation",
  );
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
  ["rotated scratch", null],
  ["competing bootstrap retry", null],
  ["older version", /release_active_version_mismatch/u],
  ["split traffic", /release_active_version_mismatch/u],
  ["foreign route", /release_route_mismatch/u],
])
  test(`dev executor ${scenario} preserves exact activation before releasing its fence`, async (t) => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const { call, env, database, scratch, rotateDisposable, workflowToken, receive } = await fixture(t, head);
    let prepared;
    let disposableId = env.DISPOSABLE_D1_DATABASE_ID;
    let dispatchEnvironment;
    if (scenario === "rotated scratch") {
      await rotateDisposable();
      const directory = await mkdtemp(join(tmpdir(), "keepr-dev-preparation-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const workflowEnvironment = {
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://synthetic.actions.example/oidc",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-oidc-request",
        GH_TOKEN: "synthetic-github-token",
        EXPECTED_HEAD_SHA: head,
        CI_RUN_ID: "123",
        DEV_CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
        DEV_CATALOGUE_DATABASE_ID: env.CATALOGUE_D1_DATABASE_ID,
        DEV_DISPOSABLE_DATABASE_ID: env.DISPOSABLE_D1_DATABASE_ID,
        GITHUB_ENV: join(directory, "environment"),
      };
      const previousEnvironment = { ...process.env };
      Object.assign(process.env, workflowEnvironment);
      t.after(() => {
        for (const name of Object.keys(workflowEnvironment)) {
          if (previousEnvironment[name] === undefined) delete process.env[name];
          else process.env[name] = previousEnvironment[name];
        }
      });
      const providerFetch = globalThis.fetch;
      globalThis.fetch = async (url, options) => {
        if (new URL(url).hostname === "synthetic.actions.example")
          return Response.json({ value: await workflowToken() });
        if (String(url) === devAudience) {
          const response = await receive(new Request(url, options));
          prepared = await response.clone().json();
          return response;
        }
        return providerFetch(url, options);
      };
      await import("../scripts/dev-prepare.mjs");
      dispatchEnvironment = parseEnv(await readFile(workflowEnvironment.GITHUB_ENV, "utf8"));
      disposableId = dispatchEnvironment.DEV_DISPOSABLE_DATABASE_ID;
      assert.equal(disposableId, "00000000-0000-0000-0000-000000000003");
      assert.equal(process.env.DEV_DISPOSABLE_DATABASE_ID, "00000000-0000-0000-0000-000000000002");
    } else {
      prepared = await (await call()).json();
      dispatchEnvironment = Object.fromEntries(
        Object.entries(prepared.dispatch_inputs).map(([key, value]) => [key.toUpperCase(), value]),
      );
    }
    const { devConfigurations } = await import("../scripts/dev-environment.mjs");
    const configs = await devConfigurations({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      catalogueId: env.CATALOGUE_D1_DATABASE_ID,
      disposableId,
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
    const retrying = scenario === "competing bootstrap retry";
    let applicationActive = !retrying;
    let competingObservation;
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(input);
      requests.push(url.pathname);
      if (url.hostname === "api.github.com") return githubFetch(input, init);
      if (url.hostname === "card-dev.keepr.digital") {
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
        result = !applicationActive
          ? []
          : Object.values(configs).flatMap((config) =>
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
        const name =
          id === env.CATALOGUE_D1_DATABASE_ID
            ? target.d1_databases[0].name
            : scratch.databases.find((entry) => entry.uuid === id)?.name;
        if (!name) return Response.json({ success: false }, { status: 404 });
        result = { uuid: id, name };
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
        else if (url.pathname.endsWith("/settings"))
          result = {
            bindings: devBindings(config).filter((binding) => applicationActive || binding.type === "secret_text"),
          };
        else if (retrying && url.pathname.endsWith("/subdomain")) result = { enabled: false, previews_enabled: false };
        else if (retrying && url.pathname.endsWith(`/scripts/${worker}`)) {
          const form = new FormData();
          form.set(
            "deny.mjs",
            "export default { fetch() { return new Response('Dev installation pending', {status:503}); } };",
          );
          return new Response(form);
        } else assert.fail(`Unexpected simulated provider request ${url.pathname}`);
      }
      return Response.json({ success: true, result });
    };
    const commands = [];
    const executeCommand = async (command, args) => {
      if (command === "git") return { stdout: head };
      if (retrying && args[0] === "d1") {
        const before = commands.length;
        let refusal;
        try {
          await deployDev(input, executeCommand);
        } catch (error) {
          refusal = error.message;
        }
        competingObservation = {
          refusal,
          additionalCommands: commands.length - before,
          lease: activeReleaseIdentity(database).get().active_production_release_id,
        };
      }
      if (args[0] === "versions" && args[1] === "deploy") applicationActive = true;
      commands.push({ command, args });
      assert.ok(command.endsWith("/wrangler") || command === "bash");
      return { stdout: "" };
    };
    const { deployDev } = await import("../scripts/deploy-dev.mjs");
    const input = {
      ...dispatchEnvironment,
      RELEASE_ENVIRONMENT: "dev",
      EXPECTED_HEAD_SHA: head,
      CI_RUN_ID: "123",
      GH_TOKEN: "synthetic-github-token",
      CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
      DEV_CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
      DEV_CATALOGUE_DATABASE_ID: env.CATALOGUE_D1_DATABASE_ID,
      DEV_DISPOSABLE_DATABASE_ID: disposableId,
      CLOUDFLARE_API_TOKEN: "synthetic-provider",
      API_TRAFFIC_TOKEN: "synthetic-traffic",
    };
    if (retrying) {
      const directory = await mkdtemp(join(tmpdir(), "keepr-executor-retry-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      input.DEV_FIRST_INSTALL_RETRY_OF = "inspected-failed-bootstrap";
      for (const [app, variable] of [
        ["api", "DEV_API_SECRETS_FILE"],
        ["ingestion", "DEV_INGESTION_SECRETS_FILE"],
      ]) {
        input[variable] = join(directory, `${app}.json`);
        await writeFile(
          input[variable],
          JSON.stringify(
            Object.fromEntries(
              devBindings(configs[app])
                .filter((binding) => binding.type === "secret_text")
                .map((binding) => [binding.name, `synthetic-${binding.name}-credential`]),
            ),
          ),
        );
      }
      t.mock.method(childProcess, "execFileSync", (command, args) => {
        assert.ok(command.endsWith("/wrangler"));
        assert.equal(args[0], "deploy");
        assert.equal(
          activeReleaseIdentity(database).get().active_production_release_id,
          prepared.release_id,
          "shell refresh requires the active release lease",
        );
        assert.equal(countMigrationStartedEvidence(database).get().count, 1);
        commands.push({ command, args });
        return "";
      });
      syncBuiltinESMExports();
      t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      });
    }
    if (expectedError) {
      await assert.rejects(deployDev(input, executeCommand), expectedError);
      assert.equal(activeReleaseIdentity(database).get().active_production_release_id, prepared.release_id);
      assert.equal(countReleaseCompletionEvidence(database).get().count, 0);
      assert.equal(
        requests.some((path) => path === "/api/health"),
        false,
      );
      assert.ok(commands.some(({ command }) => command === "bash"));
    } else {
      const result = await deployDev(input, executeCommand);
      assert.equal(result.head_sha, head);
      assert.equal(activeReleaseIdentity(database).get().active_production_release_id, null);
      assert.equal(countSuccessfulReleaseEvidence(database).get().count, 1);
      assert.equal(requests.filter((path) => path.endsWith("/deployments")).length, 2);
      if (retrying) {
        assert.equal(commands.filter(({ args }) => args[0] === "deploy").length, 2);
        assert.match(competingObservation.refusal, /dev_gate_failed:ready/u);
        assert.equal(
          competingObservation.additionalCommands,
          0,
          "a competing retry neither refreshes shells nor runs another claimant's failure handler",
        );
        assert.equal(competingObservation.lease, prepared.release_id);
      }
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
