import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createServer } from "vite";
import { d1Adapter } from "./helpers/query-helpers/sqlite-d1-adapter.mjs";
import { devAudience, requiredCiChecks } from "../src/http/dev-workflow-identity.mjs";

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
  const call = async (overrides = {}, environment = env) => {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const message = `${encode({ alg: "RS256", typ: "JWT", kid: "synthetic" })}.${encode({ ...claims, ...overrides })}`;
    const signature = Buffer.from(
      await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(message)),
    ).toString("base64url");
    return handleDevDeployment(
      new Request(devAudience, {
        method: "POST",
        headers: { authorization: `Bearer ${message}.${signature}`, "x-github-token": "synthetic-github-token" },
        body: JSON.stringify({ head_sha: sha, ci_run_id: "123" }),
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
        const results = statement.columns().length > 0 ? statement.all(...params) : (statement.run(...params), []);
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
