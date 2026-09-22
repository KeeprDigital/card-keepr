import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "../cli/keepr.mjs";
import { runReleaseRunCommand } from "../cli/release-run.mjs";
import { extendedScenarios } from "../src/http/dev-workflow-identity.mjs";
import { apiCapabilities, ingestionCapabilities } from "../src/runtime-capabilities.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const staged = "c".repeat(40);
const deployed = "d".repeat(40);
const newer = "e".repeat(40);
const intentDigest = "f".repeat(64);
const secrets = {
  KEEPR_PRODUCTION_ADMINISTRATION_KEY: "synthetic-production-admin-secret",
  KEEPR_PRODUCTION_API_KEY: "synthetic-production-api-secret",
  KEEPR_STAGING_ADMINISTRATION_KEY: "synthetic-staging-admin-secret",
  KEEPR_GITHUB_RELEASE_TOKEN: "synthetic-github-release-secret",
};
const target = {
  cloudflare_account_id: "0123456789abcdef0123456789abcdef",
  worker_scripts: ["card-keepr-api", "card-keepr-ingestion"],
  d1_databases: [{ name: "card-keepr-catalogue", id: "00000000-0000-0000-0000-000000000001" }],
  r2_buckets: [],
};

test("promote releases the latest successful staging commit to production after one confirmation", async (t) => {
  const world = promoteWorld(t);
  assert.equal(await world.run([], { answer: true }), 0, world.output());
  assert.deepEqual(world.prompts, ["Proceed? [y/N] "]);
  const prepare = world.ingestion.find((item) => item.body?.prepare === true);
  assert.deepEqual(
    {
      release_id: prepare.body.release_id,
      expected_head_sha: prepare.body.expected_head_sha,
      expected_current_revision_id: prepare.body.expected_current_revision_id,
      expected_migration_level: prepare.body.expected_migration_level,
      expected_actor: prepare.body.expected_actor,
    },
    {
      release_id: "release-2026-09-22-01",
      expected_head_sha: staged,
      expected_current_revision_id: "catrev_current",
      expected_migration_level: 45,
      expected_actor: "github-actions[bot]",
    },
  );
  // The server's confirmation goes back byte for byte.
  const confirm = world.ingestion.find((item) => item.body?.confirmation !== undefined);
  assert.equal(confirm.body.confirmation, world.confirmation);
  assert.deepEqual(
    world.dispatches.map((item) => [item.workflow, item.inputs.expected_head_sha]),
    [["production-release.yml", staged]],
  );
  const output = world.output();
  assert.match(output, /Skipped 1 newer staging run\(s\) that did not succeed/u);
  assert.match(output, /Promotion of staging release staging-2026-09-22-02 \(.*\/runs\/702\)/u);
  assert.match(output, /staging outcome {2}succeeded; migration level 45 -> 46; live-smoke succeeded/u);
  assert.match(output, /extended {9}succeeded \(.*\/runs\/900\)/u);
  assert.match(output, /Production Release release-2026-09-22-01/u);
  assert.match(output, /Production Release release-2026-09-22-01 succeeded/u);
  // The promotion summary precedes the single prompt.
  assert.ok(output.indexOf("Promotion of staging release") < output.indexOf("Production Release release-"));
  for (const value of Object.values(secrets)) assert.equal(output.includes(value), false);
});

test("--release-id selects a staging release and --yes confirms without a terminal", async (t) => {
  const world = promoteWorld(t, {
    stagingRuns: [stagingRun(702, "staging-2026-09-22-02", staged), stagingRun(710, "staging-2026-09-22-03", newer)],
  });
  assert.equal(
    await world.run(["--release-id", "staging-2026-09-22-02", "--yes"], { interactive: false }),
    0,
    world.output(),
  );
  assert.deepEqual(world.prompts, []);
  assert.equal(world.dispatches[0].inputs.expected_head_sha, staged);
});

for (const [name, options, code, exit, message] of [
  [
    "no successful staging release",
    { stagingRuns: [stagingRun(702, "staging-2026-09-22-02", staged, "failure")] },
    "staging_release_not_succeeded",
    6,
    /No staging release has succeeded/u,
  ],
  [
    "the commit already in production",
    { deployedSha: staged },
    "already_in_production",
    7,
    /Production already runs c{40}/u,
  ],
  ["a missing staging outcome", { outcome: null }, "staging_outcome_missing", 6, /Staging has no recorded outcome/u],
  [
    "a failed staging outcome",
    { outcome: "failed" },
    "staging_outcome_failed",
    7,
    /staging-2026-09-22-02 failed \(live_smoke_failed\)/u,
  ],
  [
    "an outcome for another commit",
    { outcomeSha: newer },
    "staging_outcome_mismatch",
    7,
    /names another intent or commit/u,
  ],
  ["an intent claimed by another run", { claimRun: "999" }, "staging_intent_mismatch", 7, /not bound to/u],
  ["pending extended scenarios", { extendedState: "pending" }, "extended_scenarios_pending", 7, /Wait for it/u],
  [
    "failed extended scenarios",
    { extendedState: "failure" },
    "extended_scenarios_failed",
    7,
    /extended_scenarios_failed/u,
  ],
  [
    "a forged extended status",
    { extendedCreator: "someone" },
    "extended_scenarios_unverified",
    7,
    /extended_scenarios_unverified/u,
  ],
  [
    "an extended run with a red scenario",
    { scenarioConclusion: "failure" },
    "extended_scenarios_unverified",
    7,
    /extended_scenarios_unverified/u,
  ],
  [
    "an extended run still in progress",
    { extendedRunStatus: "in_progress" },
    "extended_scenarios_pending",
    7,
    /extended_scenarios_pending/u,
  ],
]) {
  test(`promote refuses ${name} before preparing or dispatching`, async (t) => {
    const world = promoteWorld(t, options);
    assert.equal(await world.run(["--json"], { answer: true }), exit, world.output());
    const problem = JSON.parse(world.output().trim().split("\n").at(-1));
    assert.equal(problem.code, code);
    assert.match(problem.detail, message);
    assert.deepEqual(world.prompts, []);
    assert.equal(
      world.ingestion.some((item) => item.url.endsWith("/v1/production-releases")),
      false,
    );
    assert.deepEqual(world.dispatches, []);
  });
}

test("promote accepts only a staging release id and needs the staging key", async (t) => {
  const world = promoteWorld(t);
  assert.equal(await world.run(["--sha", staged, "--yes"], { interactive: false }), 2);
  assert.match(world.output(), /Usage: keepr release promote/u);
  const { KEEPR_STAGING_ADMINISTRATION_KEY: _omitted, ...withoutStaging } = secrets;
  assert.equal(await world.run(["--yes"], { interactive: false, environment: withoutStaging }), 2);
  assert.match(world.output(), /Set KEEPR_STAGING_ADMINISTRATION_KEY/u);
  assert.equal(world.requests.length, 0);
});

function stagingRun(id, releaseId, sha, conclusion = "success") {
  return {
    id,
    event: "workflow_dispatch",
    display_title: `staging-${releaseId}-${sha}`,
    status: "completed",
    conclusion,
  };
}

/** GitHub, production and staging fakes behind fetch; the real low-level CLI runs in-process. */
function promoteWorld(
  t,
  {
    stagingRuns = [
      stagingRun(702, "staging-2026-09-22-02", staged),
      stagingRun(710, "staging-2026-09-22-03", newer, "failure"),
    ],
    deployedSha = deployed,
    outcome = "succeeded",
    outcomeSha = staged,
    claimRun = "702",
    extendedState = "success",
    extendedCreator = "github-actions[bot]",
    extendedRunStatus = "completed",
    scenarioConclusion = "success",
  } = {},
) {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let text = "";
  let clock = Date.parse("2026-09-22T10:00:00Z");
  const productionRuns = [
    {
      id: 600,
      event: "workflow_dispatch",
      display_title: `production-release-release-2026-09-21-01-${deployedSha}`,
      status: "completed",
      conclusion: "success",
    },
  ];
  let polls = 0;
  const world = { requests: [], ingestion: [], dispatches: [], prompts: [], confirmation: null, output: () => text };
  const json = (document, status = 200) => Response.json(document, { status });
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const body = options.body ? JSON.parse(options.body) : null;
    world.requests.push({ url: url.href, body });
    if (url.hostname === "api.github.com") {
      const path = url.pathname.replace("/repos/KeeprDigital/card-keepr", "");
      if (path === "/actions/workflows/staging-deploy.yml/runs") return json({ workflow_runs: stagingRuns });
      if (path === "/actions/workflows/production-release.yml/runs") return json({ workflow_runs: productionRuns });
      if (path === "/actions/workflows/ci.yml/runs")
        return json({ workflow_runs: [{ id: 13, head_sha: staged, event: "push", conclusion: "success" }] });
      if (path === "/actions/workflows/dev-deploy.yml/runs")
        return json({
          workflow_runs: [{ id: 21, head_sha: staged, conclusion: "success", display_title: `dev-${staged}` }],
        });
      if (path === `/commits/${staged}/statuses`)
        return json([
          {
            id: 55,
            context: "extended-scenarios",
            state: extendedState,
            creator: { login: extendedCreator },
            target_url: "https://github.com/KeeprDigital/card-keepr/actions/runs/900",
          },
        ]);
      if (path === "/actions/runs/900")
        return json({
          repository: { id: 1313489088 },
          path: ".github/workflows/release-please.yml",
          event: "push",
          head_branch: "main",
          head_sha: staged,
          status: extendedRunStatus,
          conclusion: extendedRunStatus === "completed" ? "success" : null,
        });
      if (path === "/actions/runs/900/jobs")
        return json({
          jobs: extendedScenarios.map((scenario) => ({
            name: `extended / scenario (${scenario})`,
            status: "completed",
            conclusion: scenarioConclusion,
          })),
        });
      if (path === "/actions/workflows/production-release.yml/dispatches") {
        world.dispatches.push({ workflow: "production-release.yml", inputs: body.inputs });
        productionRuns.unshift({
          id: 801,
          event: "workflow_dispatch",
          display_title: `production-release-${body.inputs.release_id}-${body.inputs.expected_head_sha}`,
          status: "queued",
          conclusion: null,
        });
        return new Response(null, { status: 204 });
      }
      if (path === "/actions/runs/801") {
        polls += 1;
        return json(
          polls < 2 ? { id: 801, status: "in_progress" } : { id: 801, status: "completed", conclusion: "success" },
        );
      }
      if (path === "/actions/runs/801/jobs")
        return json({ jobs: [{ name: "guarded-release", status: "completed", conclusion: "success", steps: [] }] });
      return json({ message: "not found" }, 404);
    }
    const route = url.href.replace(/^https:\/\/card(-staging)?\.keepr\.digital\/(api|ingest)/u, "$1:$2");
    world.ingestion.push({ url: url.href, body });
    if (route === ":ingest/v1/staging-releases/staging-2026-09-22-02")
      return json({
        release_id: "staging-2026-09-22-02",
        intent_digest: intentDigest,
        intent: { release_id: "staging-2026-09-22-02", expected_head_sha: staged },
        authorization: { workflow_run_id: claimRun, intent_digest: intentDigest },
      });
    if (route === "-staging:ingest/v1/staging-deployments/staging-2026-09-22-02")
      return outcome === null
        ? json({ code: "not_found", detail: "No staging preparation." }, 404)
        : json({
            release_id: "staging-2026-09-22-02",
            outcome: {
              intent_digest: intentDigest,
              expected_head_sha: outcomeSha,
              state: outcome,
              failure_code: outcome === "failed" ? "live_smoke_failed" : null,
              deployment: { state: "succeeded" },
              migration: { state: "succeeded", starting_level: 45, ending_level: 46 },
              checks: [{ name: "live-smoke", state: outcome }],
            },
          });
    if (route === ":ingest/v1/production-releases") {
      const expected = {
        production_target: target,
        release_id: body.release_id,
        expected_current_revision_id: body.expected_current_revision_id,
        expected_head_sha: body.expected_head_sha,
        expected_migration_level: body.expected_migration_level,
        bootstrap: false,
        recovery_bookmark: "bookmark-1",
        recovery_backup_attempt_id: "backup-1",
        idempotency_key: body.idempotency_key,
      };
      // Not canonical JSON: re-serializing would drop the space, so only exact bytes confirm.
      const confirmation = JSON.stringify(expected).replace('{"', '{ "');
      world.confirmation = confirmation;
      if (body.prepare) return json({ contract: "x", release_id: body.release_id, confirmation });
      if (body.confirmation !== confirmation)
        return json({ code: "confirmation_required", detail: `Confirmation must exactly equal ${confirmation}` }, 409);
      return json(
        {
          contract: "card-keepr-production-release-request@1",
          release_id: body.release_id,
          dispatch_inputs: {
            operation: "production_release",
            release_id: body.release_id,
            expected_head_sha: body.expected_head_sha,
            bootstrap: "false",
          },
        },
        201,
      );
    }
    if (route === ":ingest/v1/status")
      return json({
        safe_state: { current_revision_id: "catrev_current", mutation_safe: true },
        release_preflight: { bootstrap: false, schema_migration_level: 45 },
      });
    if (route.endsWith("/health")) {
      const runtime = route.includes("api") ? "api" : "ingestion";
      return json({
        contract: "card-keepr-runtime-health@1",
        runtime,
        status: "ok",
        capabilities: runtime === "api" ? apiCapabilities : ingestionCapabilities,
        checks: { version: { status: "pass", id: runtime === "api" ? "0be12fec" : "48254ac6" } },
      });
    }
    return json({ code: "unexpected", detail: route }, 500);
  };
  const capture = (chunk) => {
    text += chunk;
    return true;
  };
  world.run = async (args, { interactive = true, answer = false, environment = secrets } = {}) => {
    const outer = [process.stdout.write, process.stderr.write];
    process.stdout.write = capture;
    process.stderr.write = capture;
    try {
      return await runReleaseRunCommand(["promote", ...args], environment, args.includes("--json"), {
        interactive,
        write: capture,
        now: () => new Date(clock),
        sleep: async (ms) => {
          clock += ms;
        },
        timing: { pollMs: 15_000, findRunMs: 60_000, watchMs: { staging: 600_000, production: 600_000 } },
        confirm: async (question) => {
          world.prompts.push(question);
          return answer;
        },
        liveness: async () => 200,
        git: {
          fetch: async () => {},
          mainCommits: async () => [newer, staged, deployed],
          resolveCommit: async (value) => value,
          resolveTag: async () => null,
          isInMain: async (value) => [newer, staged, deployed].includes(value),
          subject: async (value) => `subject of ${value.slice(0, 7)}`,
        },
        prepareCheckout: async () => repositoryRoot,
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
