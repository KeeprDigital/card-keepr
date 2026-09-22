import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { promotionAudience, promotionEnvironment } from "../src/http/dev-workflow-identity.mjs";
import { promotionDispatchInputNames } from "../src/catalogue/shared/release-input-shapes.mjs";
import { dispatchInputsFrom, requestPromotion, verifyHumanApproval } from "../scripts/production-promotion.mjs";

// Structural reads of the release workflows (#238): the job graph, environments,
// permissions and reusable-call inputs. Only the subset of YAML these files use.
const read = (name) => readFile(`.github/workflows/${name}`, "utf8");

function jobs(workflow) {
  const body = workflow.slice(workflow.indexOf("\njobs:\n") + "\njobs:\n".length);
  const blocks = body.split(/\n(?= {2}[a-z][a-z-]*:\n)/u).filter((block) => /^ {2}[a-z]/u.test(block));
  return Object.fromEntries(
    blocks.map((block) => {
      const lines = block.split("\n");
      const scalar = (key) => lines.find((line) => line.startsWith(`    ${key}: `))?.slice(`    ${key}: `.length);
      const map = (key) => {
        const start = lines.indexOf(`    ${key}:`);
        if (start === -1) return undefined;
        const entries = [];
        for (const line of lines.slice(start + 1)) {
          const entry = /^ {6}([\w-]+): (.+)$/u.exec(line);
          if (entry === null) break;
          entries.push([entry[1], entry[2]]);
        }
        return Object.fromEntries(entries);
      };
      return [
        lines[0].trim().slice(0, -1),
        {
          text: block,
          needs: scalar("needs"),
          if: scalar("if"),
          environment: scalar("environment"),
          uses: scalar("uses"),
          permissions: map("permissions"),
          with: map("with"),
          outputs: map("outputs"),
          concurrency: map("concurrency"),
        },
      ];
    }),
  );
}

/** `on.<trigger>.inputs` as { name: { required, default, type } }. */
function inputs(workflow, trigger) {
  const section = workflow.split(`\n  ${trigger}:\n    inputs:\n`)[1]?.split(/\n(?! {6}| {8}| *#)/u)[0];
  assert.ok(section, `${trigger} inputs`);
  const result = {};
  let current;
  for (const line of section.split("\n")) {
    const name = /^ {6}([\w-]+):$/u.exec(line);
    const field = /^ {8}([\w-]+): (.+)$/u.exec(line);
    if (name) result[(current = name[1])] = {};
    else if (field && current) result[current][field[1]] = field[2];
  }
  return result;
}

test("a successful staging release waits for one human approval, then runs the guarded executor in the same run", async () => {
  const workflow = await read("staging-deploy.yml");
  const { staging, promote, production, ...others } = jobs(workflow);
  assert.deepEqual(Object.keys(others), []);
  assert.match(workflow, /^on:\n {2}workflow_dispatch:\n/mu);
  assert.match(workflow, /^permissions:\n {2}contents: read\n/mu);
  assert.doesNotMatch(workflow.split("\njobs:\n")[0], /concurrency:/u);

  // Staging keeps its identity, credentials and serialization.
  assert.equal(staging.environment, "staging");
  assert.equal(staging.concurrency?.group, "staging-deployment");
  assert.deepEqual(staging.permissions, {
    contents: "read",
    checks: "read",
    actions: "read",
    "id-token": "write",
  });

  // The approval gate: a dedicated environment whose required reviewer holds the job
  // before it can mint an OIDC identity. It reads evidence and writes nothing.
  assert.equal(promote.needs, "staging");
  assert.equal(promote.if, "github.ref == 'refs/heads/main'");
  assert.equal(promote.environment, promotionEnvironment);
  assert.deepEqual(promote.permissions, {
    contents: "read",
    actions: "read",
    checks: "read",
    statuses: "read",
    "id-token": "write",
  });
  assert.equal(promote.concurrency, undefined);
  assert.deepEqual(promote.outputs, { dispatch_inputs: "${{ steps.promotion.outputs.dispatch_inputs }}" });
  assert.match(promote.text, /ref: \$\{\{ github\.workflow_sha \}\}/u);
  // Trusted workflow code only: the selected commit is never checked out here.
  assert.doesNotMatch(promote.text, /ref: \$\{\{ inputs\./u);
  assert.match(promote.text, /id: promotion\n {8}run: node scripts\/production-promotion\.mjs/u);
  assert.doesNotMatch(promote.text, /secrets\./u);

  // The executor is the unchanged production-release.yml, reached only through the gate.
  assert.equal(production.needs, "promote");
  assert.equal(production.uses, "./.github/workflows/production-release.yml");
  assert.equal(production.environment, undefined);
  assert.deepEqual(production.permissions, { contents: "read", actions: "read", checks: "read" });
  assert.doesNotMatch(production.text, /secrets|id-token/u);
});

test("the reusable call passes exactly the promotion's dispatch inputs, which production-release.yml accepts on both triggers", async () => {
  const release = await read("production-release.yml");
  const dispatch = inputs(release, "workflow_dispatch");
  const call = inputs(release, "workflow_call");
  assert.deepEqual(Object.keys(call).sort(), Object.keys(dispatch).sort());
  for (const [name, { options: _choices, ...spec }] of Object.entries(dispatch)) {
    // workflow_call has no choice type; everything else is identical.
    assert.deepEqual(call[name], { ...spec, type: "string" }, name);
  }
  assert.equal(call.operation.default, "production_release");

  const { production } = jobs(await read("staging-deploy.yml"));
  assert.deepEqual(Object.keys(production.with).sort(), [...promotionDispatchInputNames].sort());
  for (const [name, value] of Object.entries(production.with)) {
    assert.ok(name in call, `${name} is a production-release.yml input`);
    assert.equal(value, `\${{ fromJSON(needs.promote.outputs.dispatch_inputs).${name} }}`);
  }
  const required = Object.entries(call).filter(([, spec]) => spec.required === "true");
  for (const [name] of required) assert.ok(name in production.with, `required input ${name} is passed`);

  // The executor still selects its job by operation and holds the production lease group.
  const { "guarded-release": guarded, ...others } = jobs(release);
  assert.deepEqual(Object.keys(others), []);
  assert.equal(guarded.environment, "production");
  assert.match(release, /^concurrency:\n {2}group: production-release\n/mu);
});

test("a created release records the tag commit's extended scenarios before promotion", async () => {
  const workflow = await read("release-please.yml");
  const { "release-please": releasePlease, extended, ...others } = jobs(workflow);
  assert.deepEqual(Object.keys(others), []);
  assert.match(workflow, /^permissions: \{\}$/mu);
  assert.equal(releasePlease.outputs.sha, "${{ steps.release.outputs.sha }}");
  assert.equal(releasePlease.concurrency?.group, "release-please");
  assert.equal(extended.needs, "release-please");
  assert.equal(extended.if, "needs.release-please.outputs.release_created == 'true'");
  assert.equal(extended.uses, "./.github/workflows/extended-scenarios.yml");
  assert.deepEqual(extended.with, { sha: "${{ needs.release-please.outputs.sha }}" });
  assert.deepEqual(extended.permissions, { contents: "read", statuses: "write" });
  const called = await read("extended-scenarios.yml");
  assert.deepEqual(Object.keys(inputs(called, "workflow_call")), ["sha"]);
});

test("no workflow can read an administration key", async () => {
  for (const name of await readdir(".github/workflows"))
    assert.doesNotMatch(await read(name), /ADMINISTRATION_KEY|ADMINISTRATION_TOKEN/u, name);
});

const environment = {
  RELEASE_ID: "staging-2026-09-22-04",
  INTENT_DIGEST: "e".repeat(64),
  EXPECTED_HEAD_SHA: "a".repeat(40),
  GITHUB_RUN_ID: "501",
  GITHUB_REPOSITORY: "KeeprDigital/card-keepr",
  GH_TOKEN: "synthetic-job-token",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://synthetic.actions.example/oidc",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-oidc",
};
const dispatchInputs = () =>
  Object.fromEntries(
    promotionDispatchInputNames.map((name) => [
      name,
      {
        operation: "production_release",
        release_id: `promotion-${environment.RELEASE_ID}`,
        expected_head_sha: environment.EXPECTED_HEAD_SHA,
        expected_actor: "github-actions[bot]",
      }[name] ?? `value-${name}`,
    ]),
  );
const receipt = (changes = {}) => ({
  contract: "card-keepr-production-promotion@1",
  staging_release_id: environment.RELEASE_ID,
  intent_digest: environment.INTENT_DIGEST,
  expected_head_sha: environment.EXPECTED_HEAD_SHA,
  workflow_run_id: environment.GITHUB_RUN_ID,
  production_release: { dispatch_inputs: dispatchInputs() },
  ...changes,
});

function fakeFetch(t, respond) {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push({ url, options });
    if (url.hostname === "synthetic.actions.example") {
      assert.equal(url.searchParams.get("audience"), promotionAudience);
      return Response.json({ value: `identity-${calls.length}` });
    }
    return respond(url, options);
  };
  return calls;
}

test("the promote job fails closed unless a person approved its production-promotion deployment", async (t) => {
  let approvals = [];
  const calls = fakeFetch(t, (url) => {
    assert.equal(url.href, "https://api.github.com/repos/KeeprDigital/card-keepr/actions/runs/501/approvals");
    return Response.json(approvals);
  });
  const approval = (changes) => ({
    state: "approved",
    user: { login: "then3rdman", type: "User" },
    environments: [{ id: 7, name: promotionEnvironment }],
    ...changes,
  });
  await assert.rejects(verifyHumanApproval(environment), /promotion_not_approved/u);
  approvals = [approval({ environments: [{ id: 8, name: "production" }] })];
  await assert.rejects(verifyHumanApproval(environment), /promotion_not_approved/u);
  approvals = [approval({ state: "rejected" }), approval({ user: { login: "some-app[bot]", type: "Bot" } })];
  await assert.rejects(verifyHumanApproval(environment), /promotion_not_approved/u);
  approvals = [approval()];
  assert.equal(await verifyHumanApproval(environment), "then3rdman");
  assert.equal(calls.at(-1).options.headers.authorization, "Bearer synthetic-job-token");
});

test("promotion retries pending evidence with a fresh identity and returns the exact dispatch inputs", async (t) => {
  const answers = [
    [409, { code: "extended_scenarios_pending", detail: "pending" }],
    [502, { code: "staging_outcome_unavailable", detail: "later" }],
    [201, receipt()],
  ];
  const posts = [];
  fakeFetch(t, (url, options) => {
    assert.equal(url.href, promotionAudience);
    posts.push(options);
    const [status, document] = answers.shift();
    return Response.json(document, { status });
  });
  const slept = [];
  const said = [];
  let clock = 0;
  const result = await requestPromotion(environment, {
    pollMs: 60_000,
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    say: (line) => said.push(line),
  });
  assert.deepEqual(result, dispatchInputs());
  assert.deepEqual(slept, [60_000, 60_000]);
  assert.deepEqual(
    posts.map((options) => options.headers.authorization),
    ["Bearer identity-1", "Bearer identity-3", "Bearer identity-5"],
  );
  for (const options of posts) {
    assert.equal(options.headers["x-github-token"], "synthetic-job-token");
    assert.deepEqual(JSON.parse(options.body), {
      release_id: environment.RELEASE_ID,
      intent_digest: environment.INTENT_DIGEST,
      expected_head_sha: environment.EXPECTED_HEAD_SHA,
    });
  }
  assert.match(said[0], /extended_scenarios_pending/u);
});

test("any other stop, a pending deadline or a receipt for another run ends the job", async (t) => {
  let answer = [409, { code: "promotion_schema_changed", detail: "The production schema level changed." }];
  let posts = 0;
  fakeFetch(t, () => {
    posts += 1;
    return Response.json(answer[1], { status: answer[0] });
  });
  const options = { sleep: async () => {}, say: () => {} };
  await assert.rejects(requestPromotion(environment, options), /promotion_stopped:409:promotion_schema_changed/u);
  assert.equal(posts, 1);

  answer = [409, { code: "extended_scenarios_pending" }];
  let clock = 0;
  await assert.rejects(
    requestPromotion(environment, {
      ...options,
      pendingLimitMs: 120_000,
      pollMs: 60_000,
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
    }),
    /promotion_stopped:409:extended_scenarios_pending/u,
  );

  answer = [200, receipt({ workflow_run_id: "999" })];
  await assert.rejects(requestPromotion(environment, options), /promotion_receipt_mismatch/u);
  const extra = { ...dispatchInputs(), correction_json: "{}" };
  assert.throws(
    () => dispatchInputsFrom(receipt({ production_release: { dispatch_inputs: extra } }), environment),
    /promotion_receipt_mismatch/u,
  );
  assert.throws(
    () => dispatchInputsFrom(receipt({ staging_release_id: "staging-other" }), environment),
    /promotion_receipt_mismatch/u,
  );
  await assert.rejects(
    requestPromotion({ ...environment, EXPECTED_HEAD_SHA: "not-a-sha" }, options),
    /invalid_promotion_environment/u,
  );
});
