import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyTokens,
  reissuePolicies,
  reissueToken,
  renameToken,
  renderInventory,
  revokeToken,
  suggestTargetName,
  targetTokenNames,
} from "../scripts/credential-tokens.mjs";

const account = "3ec389380c7b82e6a172e6f351d4aad9";
const admin = "admin-token-value-never-printed";
const newValue = "new-token-value-never-printed";
const groups = [
  { id: "g-d1", name: "D1 Write", scopes: ["com.cloudflare.api.account"] },
  { id: "g-ws-read", name: "Workers Scripts Read", scopes: ["com.cloudflare.api.account"] },
  { id: "g-ws-write", name: "Workers Scripts Write", scopes: ["com.cloudflare.api.account"] },
];

function target(environment) {
  return {
    environment,
    accountId: account,
    catalogueDatabaseId: "11111111-1111-4111-8111-111111111111",
    disposableDatabaseId: "22222222-2222-4222-8222-222222222222",
  };
}

function token(id, name, extra = {}) {
  return {
    id,
    name,
    status: "active",
    issued_on: "2026-09-03T00:00:00Z",
    last_used_on: null,
    policies: [
      {
        id: `${id}-policy`,
        effect: "allow",
        resources: { [`com.cloudflare.api.account.${account}`]: "*" },
        permission_groups: [{ id: "g-d1", name: "D1 Write" }],
      },
    ],
    ...extra,
  };
}

function fakeFetch(tokens, overrides = {}) {
  const calls = [];
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    const method = options.method ?? "GET";
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ method, path: url.pathname, body, headers: new Headers(options.headers) });
    const key = `${method} ${url.pathname}`;
    for (const [pattern, response] of Object.entries(overrides)) {
      if (new RegExp(pattern, "u").test(key)) return respond(response);
    }
    if (key === "GET /client/v4/user/tokens/permission_groups") return respond(groups);
    if (key === "GET /client/v4/user/tokens") return respond(tokens);
    if (key === "POST /client/v4/user/tokens") return respond({ id: "t-new", name: body.name, value: newValue });
    if (method === "PUT") return respond({ ...body, id: url.pathname.split("/").at(-1) });
    if (method === "DELETE") return respond({ id: url.pathname.split("/").at(-1) });
    return respond({});
  };
  return { fetchImpl, calls };
}

function respond(result, status = 200) {
  return new Response(JSON.stringify({ success: true, result, errors: [] }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("the nine target names come from the runbook table", () => {
  assert.deepEqual(targetTokenNames(), [
    "card-keepr production deploy",
    "card-keepr production d1-export",
    "card-keepr production d1-verification",
    "card-keepr staging deploy",
    "card-keepr staging d1-export",
    "card-keepr staging d1-verification",
    "card-keepr dev deploy",
    "card-keepr dev d1-export",
    "card-keepr dev d1-verification",
  ]);
});

test("dashboard names normalise to their target names or to nothing", () => {
  assert.equal(suggestTargetName("card-keepr-staging-d1-verification"), "card-keepr staging d1-verification");
  assert.equal(suggestTargetName("card-keepr dev D1 export"), "card-keepr dev d1-export");
  assert.equal(suggestTargetName("card-keepr-staging-deploy"), "card-keepr staging deploy");
  assert.equal(suggestTargetName("card-keepr production d1-export"), "card-keepr production d1-export");
  assert.equal(suggestTargetName("card-keepr d1 backup"), null);
  assert.equal(suggestTargetName("unrelated"), null);
});

test("the inventory classifies target, rename and no-consumer tokens without printing values", () => {
  const rows = classifyTokens([
    token("t1", "card-keepr production d1-export"),
    token("t2", "card-keepr-staging-d1-verification"),
    token("t3", "card-keepr d1 backup"),
    token("t4", "card-keepr production d1-export", { status: "disabled" }),
  ]);
  assert.deepEqual(
    rows.map((row) => [row.id, row.classification, row.targetName]),
    [
      ["t1", "target", "card-keepr production d1-export"],
      ["t2", "rename", "card-keepr staging d1-verification"],
      ["t3", "no-consumer", null],
      ["t4", "duplicate", "card-keepr production d1-export"],
    ],
  );
  assert.deepEqual(rows[0].grants, ["D1 Write @ account"]);
  const text = renderInventory(rows);
  assert.match(text, /t2 {2}rename/u);
  assert.match(text, /card-keepr staging d1-verification/u);
});

test("re-issue policies follow the runbook grant per environment and purpose", () => {
  const production = reissuePolicies(
    { environment: "production", purpose: "d1-verification", accountId: account },
    groups,
  );
  assert.deepEqual(production, [
    {
      effect: "allow",
      resources: { [`com.cloudflare.api.account.${account}`]: "*" },
      permission_groups: [{ id: "g-d1" }, { id: "g-ws-read" }],
    },
  ]);
  const staging = reissuePolicies({ environment: "staging", purpose: "d1-verification", accountId: account }, groups);
  assert.deepEqual(staging[0].permission_groups, [{ id: "g-d1" }]);
  const exportPolicy = reissuePolicies({ environment: "production", purpose: "d1-export", accountId: account }, groups);
  assert.deepEqual(exportPolicy[0].permission_groups, [{ id: "g-d1" }]);
  assert.throws(() => reissuePolicies({ environment: "production", purpose: "deploy", accountId: account }, groups), {
    message: /purpose/u,
  });
  assert.throws(() => reissuePolicies({ environment: "production", purpose: "d1-export", accountId: account }, []), {
    message: /D1 Write/u,
  });
});

test("a dry-run re-issue plans the token and touches nothing", async () => {
  const { fetchImpl, calls } = fakeFetch([token("t-old", "card-keepr production d1-export")]);
  const installed = [];
  const result = await reissueToken(
    {
      admin,
      target: target("production"),
      purpose: "d1-export",
      apply: false,
      install: async (input) => installed.push(input),
      probe: async () => ({ ok: true, rows: [] }),
    },
    fetchImpl,
  );
  assert.equal(result.applied, false);
  assert.equal(result.name, "card-keepr production d1-export");
  assert.equal(result.secretName, "D1_EXPORT_TOKEN");
  assert.equal(result.worker, "card-keepr-ingestion");
  assert.deepEqual(result.previous, ["t-old"]);
  assert.deepEqual(installed, []);
  assert.ok(calls.every((call) => call.method === "GET"));
});

test("an applied re-issue creates, installs, probes and names the old token for revocation", async () => {
  const { fetchImpl, calls } = fakeFetch([token("t-old", "card-keepr-staging-d1-verification")]);
  const installed = [];
  const probed = [];
  const result = await reissueToken(
    {
      admin,
      target: target("staging"),
      purpose: "d1-verification",
      apply: true,
      install: async (input) => installed.push(input),
      probe: async (tokens) => {
        probed.push(tokens);
        return { ok: true, rows: [{ check: "d1-list-by-name", outcome: "pass" }] };
      },
    },
    fetchImpl,
  );
  const create = calls.find((call) => call.method === "POST");
  assert.equal(create.body.name, "card-keepr staging d1-verification");
  assert.deepEqual(create.body.policies[0].permission_groups, [{ id: "g-d1" }]);
  assert.equal(create.headers.get("authorization"), `Bearer ${admin}`);
  assert.deepEqual(installed, [
    {
      secretName: "D1_VERIFICATION_TOKEN",
      worker: "card-keepr-ingestion-staging",
      accountId: account,
      value: newValue,
    },
  ]);
  assert.deepEqual(probed, [{ d1Verification: newValue }]);
  assert.equal(result.applied, true);
  assert.equal(result.created, "t-new");
  assert.equal(result.probe.ok, true);
  assert.deepEqual(result.previous, ["t-old"]);
  assert.ok(!JSON.stringify(result).includes(newValue), "the new value never appears in the result");
  assert.ok(
    calls.every((call) => call.method !== "DELETE"),
    "the old token is left for an explicit revoke",
  );
});

test("a failed probe after an applied re-issue deletes the new token and leaves the old secret alone", async () => {
  const { fetchImpl, calls } = fakeFetch([token("t-old", "card-keepr production d1-verification")]);
  const installed = [];
  const result = await reissueToken(
    {
      admin,
      target: target("production"),
      purpose: "d1-verification",
      apply: true,
      install: async (input) => installed.push(input),
      probe: async () => ({ ok: false, rows: [{ check: "workers-deployments-read", outcome: "fail" }] }),
    },
    fetchImpl,
  );
  assert.equal(result.applied, true);
  assert.equal(result.probe.ok, false);
  assert.equal(result.created, null);
  assert.deepEqual(installed, []);
  assert.deepEqual(
    calls.filter((call) => call.method === "DELETE").map((call) => call.path),
    ["/client/v4/user/tokens/t-new"],
  );
});

test("rename keeps the policies and only changes the label", async () => {
  const existing = token("t2", "card-keepr-staging-d1-verification");
  const { fetchImpl, calls } = fakeFetch([existing]);
  const dry = await renameToken(
    { admin, id: "t2", name: "card-keepr staging d1-verification", apply: false },
    fetchImpl,
  );
  assert.equal(dry.applied, false);
  assert.ok(calls.every((call) => call.method === "GET"));
  const result = await renameToken(
    { admin, id: "t2", name: "card-keepr staging d1-verification", apply: true },
    fetchImpl,
  );
  const update = calls.find((call) => call.method === "PUT");
  assert.equal(update.path, "/client/v4/user/tokens/t2");
  assert.equal(update.body.name, "card-keepr staging d1-verification");
  assert.deepEqual(update.body.policies, existing.policies);
  assert.equal(update.body.status, "active");
  assert.equal(result.applied, true);
  await assert.rejects(renameToken({ admin, id: "t2", name: "card-keepr backup", apply: true }, fetchImpl), {
    message: /target name/u,
  });
});

test("revoke refuses a target-named token unless forced", async () => {
  const { fetchImpl, calls } = fakeFetch([
    token("t1", "card-keepr production d1-export"),
    token("t3", "card-keepr d1 backup"),
  ]);
  await assert.rejects(revokeToken({ admin, id: "t1", apply: true }, fetchImpl), { message: /--force/u });
  await assert.rejects(revokeToken({ admin, id: "missing", apply: true }, fetchImpl), { message: /not found/u });
  const dry = await revokeToken({ admin, id: "t3", apply: false }, fetchImpl);
  assert.equal(dry.applied, false);
  assert.ok(calls.every((call) => call.method !== "DELETE"));
  const result = await revokeToken({ admin, id: "t3", apply: true }, fetchImpl);
  assert.equal(result.applied, true);
  assert.deepEqual(
    calls.filter((call) => call.method === "DELETE").map((call) => call.path),
    ["/client/v4/user/tokens/t3"],
  );
  const forced = await revokeToken({ admin, id: "t1", apply: true, force: true }, fetchImpl);
  assert.equal(forced.applied, true);
});
