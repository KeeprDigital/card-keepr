import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyTokens,
  reissuePolicies,
  listTokens,
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
const accountGroups = [
  { id: "ag-d1", name: "D1 Write", scopes: ["com.cloudflare.api.account"] },
  { id: "ag-ws-read", name: "Workers Scripts Read", scopes: ["com.cloudflare.api.account"] },
];
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

function fakeFetch(stored, overrides = {}) {
  const stores = Array.isArray(stored) ? { user: stored, account: [] } : { user: [], account: [], ...stored };
  const calls = [];
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    const method = options.method ?? "GET";
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ method, path: url.pathname, body, headers: new Headers(options.headers) });
    const key = `${method} ${url.pathname}`;
    for (const [pattern, response] of Object.entries(overrides)) {
      if (new RegExp(pattern, "u").test(key))
        return response?.__status ? respond(null, response.__status, false) : respond(response);
    }
    const accountBase = `/client/v4/accounts/${account}/tokens`;
    if (key === "GET /client/v4/user/tokens/permission_groups") return respond(groups);
    if (key === `GET ${accountBase}/permission_groups`) return respond(accountGroups);
    if (key === "GET /client/v4/user/tokens") return respond(stores.user);
    if (key === `GET ${accountBase}`) return respond(stores.account);
    if (key === "POST /client/v4/user/tokens") return respond({ id: "t-new", name: body.name, value: newValue });
    if (key === `POST ${accountBase}`) return respond({ id: "a-new", name: body.name, value: newValue });
    if (method === "PUT") return respond({ ...body, id: url.pathname.split("/").at(-1) });
    if (method === "DELETE") return respond({ id: url.pathname.split("/").at(-1) });
    return respond({});
  };
  return { fetchImpl, calls };
}

function respond(result, status = 200, success = true) {
  return new Response(JSON.stringify({ success, result, errors: success ? [] : [{ code: 9109 }] }), {
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
  assert.deepEqual(
    rows.map((row) => row.owner),
    ["user", "user", "user", "user"],
  );
  const text = renderInventory(rows);
  assert.match(text, /t2 {2}user +rename/u);
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
  await assert.rejects(
    renameToken({ admin, accountId: account, id: "t2", name: "card-keepr backup", apply: true }, fetchImpl),
    {
      message: /target name/u,
    },
  );
});

test("revoke refuses a target-named token unless forced", async () => {
  const { fetchImpl, calls } = fakeFetch([
    token("t1", "card-keepr production d1-export"),
    token("t3", "card-keepr d1 backup"),
  ]);
  await assert.rejects(revokeToken({ admin, accountId: account, id: "t1", apply: true }, fetchImpl), {
    message: /--force/u,
  });
  await assert.rejects(revokeToken({ admin, accountId: account, id: "missing", apply: true }, fetchImpl), {
    message: /not found/u,
  });
  const dry = await revokeToken({ admin, accountId: account, id: "t3", apply: false }, fetchImpl);
  assert.equal(dry.applied, false);
  assert.ok(calls.every((call) => call.method !== "DELETE"));
  const result = await revokeToken({ admin, accountId: account, id: "t3", apply: true }, fetchImpl);
  assert.equal(result.applied, true);
  assert.deepEqual(
    calls.filter((call) => call.method === "DELETE").map((call) => call.path),
    ["/client/v4/user/tokens/t3"],
  );
  const forced = await revokeToken({ admin, accountId: account, id: "t1", apply: true, force: true }, fetchImpl);
  assert.equal(forced.applied, true);
});

test("the inventory merges the user and account stores and tags each token's owner", async () => {
  const { fetchImpl } = fakeFetch({
    user: [token("t-boot", "card-keepr owner bootstrap")],
    account: [token("a1", "card-keepr-staging-deploy"), token("a2", "card-keepr d1 backup")],
  });
  const listing = await listTokens({ admin, accountId: account }, fetchImpl);
  assert.deepEqual(
    listing.tokens.map((entry) => [entry.id, entry.owner]),
    [
      ["t-boot", "user"],
      ["a1", "account"],
      ["a2", "account"],
    ],
  );
  assert.deepEqual(listing.warnings, []);
  const rows = classifyTokens(listing.tokens);
  assert.deepEqual(
    rows.map((row) => [row.id, row.owner, row.classification]),
    [
      ["t-boot", "user", "no-consumer"],
      ["a1", "account", "rename"],
      ["a2", "account", "no-consumer"],
    ],
  );
  assert.match(renderInventory(rows), /a1 +account +rename/u);
});

test("a store the bootstrap token cannot read becomes a warning, not a crash", async () => {
  const { fetchImpl } = fakeFetch(
    { user: [token("t-boot", "card-keepr owner bootstrap")] },
    { [`GET /client/v4/accounts/${account}/tokens$`]: { __status: 403 } },
  );
  const listing = await listTokens({ admin, accountId: account }, fetchImpl);
  assert.deepEqual(
    listing.tokens.map((entry) => entry.id),
    ["t-boot"],
  );
  assert.equal(listing.warnings.length, 1);
  assert.match(listing.warnings[0], /account store.*Account API Tokens/u);
});

test("rename and revoke act on the store that holds the token", async () => {
  const existing = token("a1", "card-keepr-staging-deploy");
  const { fetchImpl, calls } = fakeFetch({ account: [existing, token("a2", "card-keepr d1 backup")] });
  await renameToken({ admin, accountId: account, id: "a1", name: "card-keepr staging deploy", apply: true }, fetchImpl);
  await revokeToken({ admin, accountId: account, id: "a2", apply: true }, fetchImpl);
  assert.deepEqual(
    calls.filter((call) => call.method !== "GET").map((call) => [call.method, call.path]),
    [
      ["PUT", `/client/v4/accounts/${account}/tokens/a1`],
      ["DELETE", `/client/v4/accounts/${account}/tokens/a2`],
    ],
  );
});

test("re-issue creates in the store of the token it replaces, with that store's permission groups", async () => {
  const { fetchImpl, calls } = fakeFetch({ account: [token("a-old", "card-keepr production d1-export")] });
  const installed = [];
  const result = await reissueToken(
    {
      admin,
      target: target("production"),
      purpose: "d1-export",
      apply: true,
      install: async (input) => installed.push(input),
      probe: async () => ({ ok: true, rows: [] }),
    },
    fetchImpl,
  );
  const create = calls.find((call) => call.method === "POST");
  assert.equal(create.path, `/client/v4/accounts/${account}/tokens`);
  assert.deepEqual(create.body.policies[0].permission_groups, [{ id: "ag-d1" }]);
  assert.equal(result.owner, "account");
  assert.equal(result.created, "a-new");
  assert.deepEqual(result.previous, ["a-old"]);
  assert.equal(installed.length, 1);
});

test("re-issue honours an explicit owner when nothing is being replaced", async () => {
  const { fetchImpl, calls } = fakeFetch({ account: [] });
  const result = await reissueToken(
    {
      admin,
      target: target("dev"),
      purpose: "d1-export",
      owner: "account",
      apply: false,
      install: async () => {},
      probe: async () => ({ ok: true, rows: [] }),
    },
    fetchImpl,
  );
  assert.equal(result.owner, "account");
  assert.deepEqual(result.policies[0].permission_groups, [{ id: "ag-d1" }]);
  assert.ok(calls.every((call) => call.method === "GET"));
});

test("an applied re-issue retries a probe that fails only with 401 before giving up", async () => {
  const { fetchImpl, calls } = fakeFetch([]);
  const installed = [];
  const waits = [];
  let attempts = 0;
  const result = await reissueToken(
    {
      admin,
      target: target("production"),
      purpose: "d1-export",
      apply: true,
      install: async (input) => installed.push(input),
      probe: async () => {
        attempts += 1;
        return attempts < 3
          ? { ok: false, rows: [{ check: "d1-database-read", status: 401, outcome: "fail" }] }
          : { ok: true, rows: [{ check: "d1-database-read", status: 200, outcome: "pass" }] };
      },
      wait: async (ms) => waits.push(ms),
    },
    fetchImpl,
  );
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [15_000, 15_000]);
  assert.equal(result.created, "t-new");
  assert.equal(result.probeAttempts, 3);
  assert.equal(installed.length, 1);
  assert.ok(calls.every((call) => call.method !== "DELETE"));
});

test("a probe that fails with anything but 401 is not retried", async () => {
  const { fetchImpl, calls } = fakeFetch([]);
  const waits = [];
  let attempts = 0;
  const result = await reissueToken(
    {
      admin,
      target: target("production"),
      purpose: "d1-export",
      apply: true,
      install: async () => {},
      probe: async () => {
        attempts += 1;
        return { ok: false, rows: [{ check: "d1-database-read", status: 403, outcome: "fail" }] };
      },
      wait: async (ms) => waits.push(ms),
    },
    fetchImpl,
  );
  assert.equal(attempts, 1);
  assert.deepEqual(waits, []);
  assert.equal(result.created, null);
  assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);
});
