import assert from "node:assert/strict";
import test from "node:test";
import { probeCredentials, probePlan, renderProbeTable, resolveProbeTarget } from "../scripts/credential-probe.mjs";

const account = "3ec389380c7b82e6a172e6f351d4aad9";
const catalogue = "11111111-1111-4111-8111-111111111111";
const configuredDisposable = "22222222-2222-4222-8222-222222222222";
const liveDisposable = "33333333-3333-4333-8333-333333333333";
const zone = "94e42ddc00000000000000000000zone";
const tokens = {
  deployment: "deployment-token-value-never-printed",
  d1Export: "export-token-value-never-printed",
  d1Verification: "verification-token-value-never-printed",
};

function target(environment) {
  return {
    environment,
    accountId: account,
    catalogueDatabaseId: catalogue,
    disposableDatabaseId: configuredDisposable,
  };
}

function fakeFetch(overrides = {}) {
  const calls = [];
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    const method = options.method ?? "GET";
    calls.push({ method, url, headers: new Headers(options.headers) });
    const key = `${method} ${url.pathname}`;
    for (const [pattern, response] of Object.entries(overrides)) {
      if (new RegExp(pattern, "u").test(key)) return respond(response);
    }
    if (url.pathname === "/client/v4/user/tokens/verify") return respond({ status: "active" });
    if (url.pathname === `/client/v4/accounts/${account}/d1/database` && url.searchParams.has("name"))
      return respond([{ uuid: liveDisposable, name: url.searchParams.get("name") }]);
    if (url.pathname === "/client/v4/zones")
      return respond([{ id: zone, name: "keepr.digital", account: { id: account } }]);
    if (/\/workers\/scripts\/[^/]+\/deployments$/u.test(url.pathname))
      return respond({ deployments: [{ id: "dep", versions: [{ version_id: "ver-1", percentage: 100 }] }] });
    if (/\/workflows\/[^/]+$/u.test(url.pathname)) return respond(null, 404, false);
    return respond({});
  };
  return { fetchImpl, calls };
}

function respond(result, status = 200, success = true) {
  return new Response(JSON.stringify({ success, result, errors: [] }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("the production plan proves the Worker version reads that staging scope classification needs", () => {
  const production = probePlan(target("production"));
  const staging = probePlan(target("staging"));
  const checks = (plan, token) => plan.filter((check) => check.token === token).map((check) => check.check);
  assert.ok(checks(production, "D1_VERIFICATION_TOKEN").includes("workers-deployments-read"));
  assert.ok(checks(production, "D1_VERIFICATION_TOKEN").includes("workers-version-read"));
  assert.ok(!checks(staging, "D1_VERIFICATION_TOKEN").includes("workers-deployments-read"));
  assert.ok(checks(staging, "deployment").includes("workflows-read"));
  assert.ok(!checks(production, "deployment").includes("workflows-read"));
  for (const check of [...production, ...staging]) {
    assert.match(check.source, /^[\w./-]+\.(?:mjs|ts|yml):\d+$/u, `${check.check} cites a code line`);
  }
});

test("every read succeeds: each row passes, only GET requests are sent, values never appear", async () => {
  const { fetchImpl, calls } = fakeFetch();
  const result = await probeCredentials({ target: target("production"), tokens }, fetchImpl);
  assert.equal(result.ok, true);
  assert.ok(result.rows.length > 10);
  assert.ok(result.rows.every((row) => row.outcome === "pass" || row.outcome === "not_probed"));
  assert.ok(calls.every((call) => call.method === "GET"));
  assert.ok(calls.every((call) => call.headers.get("authorization")?.startsWith("Bearer ")));
  const table = renderProbeTable(result);
  for (const value of Object.values(tokens)) assert.ok(!table.includes(value));
  assert.ok(!table.includes("Bearer "));
  assert.match(table, /workers-deployments-read .*card-keepr-api\/deployments\s+200\s+pass/u);
  assert.match(table, /r2-bucket-managed-domain-read/u);
  assert.match(table, /zone-routes-read .*\/zones\/[^/]+\/workers\/routes\s+200\s+pass/u);
});

test("a verification token that cannot read Worker deployments fails with its status and the unknown_transition implication", async () => {
  const { fetchImpl } = fakeFetch();
  const denying = async (input, options = {}) => {
    const url = new URL(input);
    const token = new Headers(options.headers).get("authorization");
    if (/\/workers\/scripts\/[^/]+\/deployments$/u.test(url.pathname) && token === `Bearer ${tokens.d1Verification}`)
      return respond(null, 403, false);
    return fetchImpl(input, options);
  };
  const result = await probeCredentials({ target: target("production"), tokens }, denying);
  assert.equal(result.ok, false);
  const failed = result.rows.filter((row) => row.outcome === "fail");
  assert.deepEqual(
    failed.map((row) => [row.token, row.check, row.status]),
    [
      ["D1_VERIFICATION_TOKEN", "workers-deployments-read", 403],
      ["D1_VERIFICATION_TOKEN", "workers-deployments-read", 403],
    ],
  );
  assert.ok(failed.every((row) => row.implication.includes("unknown_transition")));
  const versionRows = result.rows.filter(
    (row) => row.token === "D1_VERIFICATION_TOKEN" && row.check === "workers-version-read",
  );
  assert.ok(versionRows.length > 0 && versionRows.every((row) => row.outcome === "skipped"));
  const deploymentRows = result.rows.filter(
    (row) => row.token === "deployment" && row.check === "workers-deployments-read",
  );
  assert.ok(deploymentRows.every((row) => row.outcome === "pass"));
  assert.match(renderProbeTable(result), /403\s+fail/u);
});

test("a missing token skips its rows without sending a request", async () => {
  const { fetchImpl, calls } = fakeFetch();
  const result = await probeCredentials(
    { target: target("dev"), tokens: { deployment: tokens.deployment } },
    fetchImpl,
  );
  assert.equal(result.ok, true);
  const exportRows = result.rows.filter((row) => row.token === "D1_EXPORT_TOKEN");
  assert.ok(exportRows.some((row) => row.outcome === "skipped"));
  assert.ok(exportRows.every((row) => row.outcome === "skipped" || row.outcome === "not_probed"));
  assert.ok(calls.every((call) => call.headers.get("authorization") === `Bearer ${tokens.deployment}`));
  assert.ok(calls.some((call) => /\/workflows\/card-keepr-catalogue-backup-dev$/u.test(call.url.pathname)));
});

test("an absent Workflow name (404) passes the read-only inventory check; 403 fails it", async () => {
  const { fetchImpl } = fakeFetch();
  const passing = await probeCredentials(
    { target: target("staging"), tokens: { deployment: tokens.deployment } },
    fetchImpl,
  );
  assert.ok(passing.rows.filter((row) => row.check === "workflows-read").every((row) => row.outcome === "pass"));
  const { fetchImpl: denied } = fakeFetch({ "GET .*/workflows/": { status: 403 } });
  const denying = async (input, options) =>
    /\/workflows\//u.test(new URL(input).pathname) ? respond(null, 403, false) : denied(input, options);
  const failing = await probeCredentials(
    { target: target("staging"), tokens: { deployment: tokens.deployment } },
    denying,
  );
  assert.ok(failing.rows.filter((row) => row.check === "workflows-read").every((row) => row.outcome === "fail"));
});

test("the export exercise is opt-in and only ever targets the live Disposable Restore database", async () => {
  const { fetchImpl, calls } = fakeFetch();
  const quiet = await probeCredentials({ target: target("staging"), tokens }, fetchImpl);
  assert.ok(
    quiet.rows.filter((row) => row.check === "d1-export-exercise").every((row) => row.outcome === "not_probed"),
  );
  assert.ok(calls.every((call) => call.method === "GET"));
  const { fetchImpl: exercised, calls: exerciseCalls } = fakeFetch({
    "POST .*/export$": {
      status: "complete",
      signed_url: "https://example.invalid/x",
      filename: "x.sql",
      at_bookmark: "b",
    },
  });
  const result = await probeCredentials({ target: target("staging"), tokens, exerciseExport: true }, exercised);
  const posts = exerciseCalls.filter((call) => call.method === "POST");
  assert.equal(posts.length, 2);
  for (const post of posts) {
    assert.equal(post.url.pathname, `/client/v4/accounts/${account}/d1/database/${liveDisposable}/export`);
    assert.ok(!post.url.pathname.includes(catalogue));
  }
  assert.ok(result.rows.filter((row) => row.check === "d1-export-exercise").every((row) => row.outcome === "pass"));
});

test("a network failure is reported as a failed row with no status, never as a thrown value", async () => {
  const broken = async () => {
    throw new Error("socket hang up with token deployment-token-value-never-printed");
  };
  const result = await probeCredentials({ target: target("dev"), tokens: { deployment: tokens.deployment } }, broken);
  assert.equal(result.ok, false);
  const table = renderProbeTable(result);
  assert.ok(!table.includes(tokens.deployment));
  assert.match(table, /token-verify .*\s-\s+fail/u);
});

test("the target resolves from the checked-in production configuration or from the environment's variables", async () => {
  const production = await resolveProbeTarget("production", {});
  assert.equal(production.accountId, account);
  assert.match(production.catalogueDatabaseId, /^[0-9a-f-]{36}$/u);
  assert.match(production.disposableDatabaseId, /^[0-9a-f-]{36}$/u);
  const staging = await resolveProbeTarget("staging", {
    STAGING_CLOUDFLARE_ACCOUNT_ID: account,
    STAGING_CATALOGUE_DATABASE_ID: catalogue,
    STAGING_DISPOSABLE_DATABASE_ID: configuredDisposable,
  });
  assert.deepEqual(staging, {
    environment: "staging",
    accountId: account,
    catalogueDatabaseId: catalogue,
    disposableDatabaseId: configuredDisposable,
  });
  await assert.rejects(resolveProbeTarget("dev", {}), /DEV_CLOUDFLARE_ACCOUNT_ID/u);
  await assert.rejects(resolveProbeTarget("local", {}), /environment/u);
});
