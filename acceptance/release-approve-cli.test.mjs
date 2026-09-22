import assert from "node:assert/strict";
import test from "node:test";
import { main } from "../cli/keepr.mjs";
import { runReleaseApproveCommand } from "../cli/release-approve.mjs";

const head = "c".repeat(40);
const secrets = {
  KEEPR_STAGING_ADMINISTRATION_KEY: "synthetic-staging-admin-secret",
  KEEPR_GITHUB_RELEASE_TOKEN: "synthetic-github-release-secret",
};

test("approve shows the waiting promotion, asks once and approves its production-promotion deployment", async (t) => {
  const world = approveWorld(t);
  assert.equal(await world.run({ answer: true }), 0, world.output());
  assert.deepEqual(world.prompts, ["Approve this production promotion? [y/N] "]);
  assert.deepEqual(world.approvals, [
    {
      environment_ids: [42],
      state: "approved",
      comment: `pnpm release:approve: staging-2026-09-22-05 ${head}`,
    },
  ]);
  const output = world.output();
  assert.match(
    output,
    /Production promotion waiting in https:\/\/github\.com\/KeeprDigital\/card-keepr\/actions\/runs\/611/u,
  );
  assert.match(output, /staging release {2}staging-2026-09-22-05/u);
  assert.match(output, new RegExp(`commit {11}${head}`, "u"));
  assert.match(output, /staging outcome {2}succeeded; migration level 45 -> 46/u);
  assert.match(output, /extended {9}success: composed-recovery, one-piece-two-source, riftbound-catalogue: success/u);
  assert.match(output, /promotes as {6}promotion-staging-2026-09-22-05/u);
  assert.match(output, /Approved\. Production promotion of cccccccccccc continues/u);
  for (const value of Object.values(secrets)) assert.equal(output.includes(value), false);
});

test("declining keeps the promotion waiting and approves nothing", async (t) => {
  const world = approveWorld(t, { extended: "pending" });
  assert.equal(await world.run({ answer: false }), 3);
  assert.deepEqual(world.approvals, []);
  assert.match(world.output(), /extended {9}pending.*waits up to an hour/u);
  assert.match(world.output(), /Not approved; the promotion keeps waiting/u);
});

test("nothing waiting is refused politely without a prompt or approval", async (t) => {
  const done = approveWorld(t, { newest: { status: "completed", conclusion: "success" } });
  assert.equal(await done.run({ answer: true }), 6);
  assert.match(
    done.output(),
    /Nothing to approve: the newest staging release staging-2026-09-22-05 \(.*\/runs\/611\) is completed \(success\), not waiting/u,
  );
  const none = approveWorld(t, { runs: [] });
  assert.equal(await none.run({ answer: true }), 6);
  assert.match(none.output(), /no staging release has run yet/u);
  const otherGate = approveWorld(t, { environment: "staging" });
  assert.equal(await otherGate.run({ answer: true }), 6);
  assert.match(otherGate.output(), /not waiting on the production-promotion environment/u);
  for (const world of [done, none, otherGate]) {
    assert.deepEqual(world.prompts, []);
    assert.deepEqual(world.approvals, []);
  }
});

test("only a required reviewer on a terminal can approve", async (t) => {
  const notReviewer = approveWorld(t, { canApprove: false });
  assert.equal(await notReviewer.run({ answer: true }), 5);
  assert.match(notReviewer.output(), /not a required reviewer of production-promotion/u);
  const unattended = approveWorld(t);
  assert.equal(await unattended.run({ interactive: false }), 2);
  assert.equal(unattended.requests.length, 0);
  assert.equal(await unattended.run({ args: ["--yes"] }), 2);
  assert.deepEqual([...notReviewer.approvals, ...unattended.approvals], []);
});

/** GitHub and staging fakes behind fetch; the real low-level CLI reads the staging outcome in-process. */
function approveWorld(
  t,
  {
    newest = { status: "waiting", conclusion: null },
    runs,
    environment = "production-promotion",
    canApprove = true,
    extended = "success",
  } = {},
) {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let text = "";
  const world = { requests: [], approvals: [], prompts: [], output: () => text };
  const stagingRuns = runs ?? [
    {
      id: 600,
      event: "workflow_dispatch",
      display_title: `staging-staging-2026-09-22-04-${"d".repeat(40)}`,
      status: "waiting",
    },
    { id: 611, event: "workflow_dispatch", display_title: `staging-staging-2026-09-22-05-${head}`, ...newest },
  ];
  const json = (document, status = 200) => Response.json(document, { status });
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const body = options.body ? JSON.parse(options.body) : null;
    world.requests.push({ url: url.href, body });
    if (url.hostname === "api.github.com") {
      const path = url.pathname.replace("/repos/KeeprDigital/card-keepr", "");
      if (path === "/actions/workflows/staging-deploy.yml/runs") return json({ workflow_runs: stagingRuns });
      if (path === "/actions/runs/611/pending_deployments" && options.method === "POST") {
        world.approvals.push(body);
        return json([{ id: 9 }]);
      }
      if (path === "/actions/runs/611/pending_deployments")
        return json([{ environment: { id: 42, name: environment }, current_user_can_approve: canApprove }]);
      if (path === "/actions/runs/611/jobs")
        return json({
          jobs: [
            { name: "staging", status: "completed", conclusion: "success" },
            { name: "promote", status: "waiting", conclusion: null },
          ],
        });
      if (path === `/commits/${head}/statuses`)
        return json([
          {
            context: "extended-scenarios",
            state: extended,
            description: `composed-recovery, one-piece-two-source, riftbound-catalogue: ${extended}`,
          },
          { context: "extended-scenarios", state: "pending", description: "older" },
        ]);
      return json({ message: "not found" }, 404);
    }
    if (url.href === "https://card-staging.keepr.digital/ingest/v1/staging-deployments/staging-2026-09-22-05")
      return json({
        release_id: "staging-2026-09-22-05",
        outcome: {
          state: "succeeded",
          failure_code: null,
          deployment: { state: "succeeded" },
          migration: { state: "succeeded", starting_level: 45, ending_level: 46 },
          checks: [{ name: "live-smoke", state: "succeeded" }],
        },
      });
    return json({ code: "unexpected", detail: url.href }, 500);
  };
  const capture = (chunk) => {
    text += chunk;
    return true;
  };
  world.run = async ({ interactive = true, answer = false, args = [] } = {}) => {
    const outer = [process.stdout.write, process.stderr.write];
    process.stdout.write = capture;
    process.stderr.write = capture;
    try {
      return await runReleaseApproveCommand(args, secrets, false, {
        interactive,
        write: capture,
        confirm: async (question) => {
          world.prompts.push(question);
          return answer;
        },
        runKeepr: async (_checkout, keeprArgs, env) => {
          let stdout = "";
          let stderr = "";
          const inner = [process.stdout.write, process.stderr.write];
          process.stdout.write = (chunk) => ((stdout += chunk), true);
          process.stderr.write = (chunk) => ((stderr += chunk), true);
          try {
            return { code: await main(keeprArgs, env), stdout, stderr };
          } finally {
            [process.stdout.write, process.stderr.write] = inner;
          }
        },
      });
    } finally {
      [process.stdout.write, process.stderr.write] = outer;
    }
  };
  return world;
}
