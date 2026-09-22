import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "../cli/keepr.mjs";
import { runReleaseRunCommand } from "../cli/release-run.mjs";
import { parseOwnerEnv } from "../cli/owner-env.mjs";
import {
  confirmationFromProblem,
  matchDispatchedRun,
  nextReleaseId,
  selectReleaseCommit,
} from "../cli/release-run-support.mjs";
import { apiCapabilities, ingestionCapabilities } from "../src/runtime-capabilities.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const sha = (letter) => letter.repeat(40);
const [newest, noDev, green, older] = ["a", "b", "c", "d"].map(sha);
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

test("commit selection skips main commits without green push CI or dev delivery", () => {
  const ciRuns = [
    { id: 11, head_sha: noDev, event: "push", conclusion: "success" },
    { id: 12, head_sha: green, event: "push", conclusion: "success" },
    { id: 13, head_sha: green, event: "push", conclusion: "success" },
    { id: 14, head_sha: newest, event: "pull_request", conclusion: "success" },
    { id: 15, head_sha: older, event: "push", conclusion: "success" },
  ];
  const devRuns = [
    { head_sha: green, conclusion: "success", display_title: `dev-${green}` },
    { head_sha: older, conclusion: "success", display_title: `dev-${older}` },
    { head_sha: noDev, conclusion: "success", display_title: "unrelated" },
  ];
  assert.deepEqual(selectReleaseCommit({ commits: [newest, noDev, green, older], ciRuns, devRuns }), {
    sha: green,
    ciRunId: "13",
  });
  assert.equal(selectReleaseCommit({ commits: [newest, noDev], ciRuns, devRuns }), null);
});

test("release IDs take the next free number of the UTC day", () => {
  const now = new Date("2026-09-22T23:30:00Z");
  assert.equal(nextReleaseId("staging", now, []), "staging-2026-09-22-01");
  assert.equal(
    nextReleaseId("staging", now, ["staging-2026-09-22-01", "staging-2026-09-22-09", "staging-2026-09-21-12", "x"]),
    "staging-2026-09-22-10",
  );
  assert.equal(nextReleaseId("production", now, ["release-2026-09-22-02"]), "release-2026-09-22-03");
});

test("the dispatched run is matched by exact run name and not by recency", () => {
  const title = `staging-staging-1-${green}`;
  const runs = [
    { id: 9, event: "workflow_dispatch", display_title: `staging-staging-2-${green}` },
    { id: 8, event: "workflow_dispatch", display_title: title },
    { id: 7, event: "workflow_dispatch", display_title: title },
  ];
  assert.equal(matchDispatchedRun(runs, title, new Set(["7"])).id, 8);
  assert.equal(matchDispatchedRun(runs, title, new Set(["7", "8"])), null);
  assert.throws(() => matchDispatchedRun(runs, title, new Set()), /More than one/u);
});

test("owner env and confirmation parsing are literal", () => {
  assert.deepEqual(parseOwnerEnv("# c\nexport A='x y'\nB=\"$(no)\"\n  C=plain\nnot a line\n"), {
    A: "x y",
    B: "$(no)",
    C: "plain",
  });
  const exact = '{"b":1, "a":"é"}';
  assert.equal(
    confirmationFromProblem({ code: "confirmation_required", detail: `Confirmation must exactly equal ${exact}` }),
    exact,
  );
  assert.equal(confirmationFromProblem({ code: "conflict", detail: "Confirmation must exactly equal {}" }), null);
});

test("staging release confirms the exact server envelope, watches its own run and reports the outcome", async (t) => {
  const world = await releaseWorld(t, "staging");
  const code = await world.run(["staging"], { answer: true });
  assert.equal(code, 0, world.output());
  const [probe03, probe04, prepare, confirm] = world.ingestion;
  assert.equal(probe03.url, "https://card.keepr.digital/ingest/v1/staging-releases/staging-2026-09-22-03");
  assert.equal(probe04.url, "https://card.keepr.digital/ingest/v1/staging-releases/staging-2026-09-22-04");
  assert.deepEqual(prepare.body, {
    release_id: "staging-2026-09-22-04",
    expected_head_sha: green,
    expected_actor: "owner",
    ci_run_id: "13",
    idempotency_key: "staging-2026-09-22-04",
    prepare: true,
  });
  assert.equal(confirm.body.confirmation, world.confirmation);
  assert.deepEqual(world.dispatches, [
    {
      workflow: "staging-deploy.yml",
      inputs: { release_id: "staging-2026-09-22-04", intent_digest: "e".repeat(64), expected_head_sha: green },
    },
  ]);
  assert.deepEqual(world.prompts, ["Proceed? [y/N] "]);
  const output = world.output();
  assert.match(output, /Skipped 2 newer main commit/u);
  assert.match(output, /Staging release staging-2026-09-22-04/u);
  assert.match(output, /actions\/runs\/501/u);
  assert.doesNotMatch(output, /actions\/runs\/502/u);
  assert.match(output, /migration succeeded: level 45 -> 46/u);
  assert.match(output, /check live-smoke: succeeded/u);
  // The run keeps waiting for the promotion approval; staging is reported without it.
  assert.match(output, /run waiting/u);
  assert.doesNotMatch(output, /job promote/u);
  assert.match(output, /waits for your approval: run `pnpm release:approve`/u);
  for (const value of Object.values(secrets)) assert.equal(output.includes(value), false);
});

test("a Bootstrap Mode production release derives its guards from status and dispatches with --yes", async (t) => {
  const world = await releaseWorld(t, "production", { bootstrap: true });
  const code = await world.run(["production", "--yes"], { interactive: false });
  assert.equal(code, 0, world.output());
  const prepare = world.ingestion.find((item) => item.body?.prepare === true);
  assert.deepEqual(
    {
      release_id: prepare.body.release_id,
      expected_current_revision_id: prepare.body.expected_current_revision_id,
      expected_migration_level: prepare.body.expected_migration_level,
      expected_actor: prepare.body.expected_actor,
      bootstrap: prepare.body.bootstrap,
    },
    {
      release_id: "release-2026-09-22-03",
      expected_current_revision_id: "catrev_spine_000",
      expected_migration_level: 45,
      expected_actor: "github-actions[bot]",
      bootstrap: true,
    },
  );
  const confirm = world.ingestion.find((item) => item.body?.confirmation !== undefined);
  assert.equal(confirm.body.confirmation, world.confirmation);
  assert.equal(world.dispatches.length, 1);
  assert.equal(world.dispatches[0].workflow, "production-release.yml");
  assert.deepEqual(world.prompts, []);
  assert.match(world.output(), /Bootstrap Mode \(empty catalogue\)/u);
  assert.match(world.output(), /api: ok, version 0be12fec/u);
  assert.match(world.output(), /ingestion \/healthz: 200/u);
});

test("without a terminal or --yes nothing is read, prepared or dispatched", async (t) => {
  const world = await releaseWorld(t, "staging");
  assert.equal(await world.run(["staging"], { interactive: false }), 2);
  assert.equal(world.requests.length, 0);
  assert.match(world.output(), /re-run with --yes/u);
});

test("declining the prompt dispatches nothing", async (t) => {
  const world = await releaseWorld(t, "staging");
  assert.equal(await world.run(["staging"], { answer: false }), 3);
  assert.equal(
    world.ingestion.some((item) => item.body?.confirmation !== undefined),
    false,
  );
  assert.deepEqual(world.dispatches, []);
});

test("a failed workflow run and staging outcome exit non-zero with the failing step", async (t) => {
  const world = await releaseWorld(t, "staging", { fail: true });
  assert.equal(await world.run(["staging", "--release-id", "staging-manual-01"], { answer: true }), 1);
  const output = world.output();
  assert.match(output, /Staging job conclusion: failure/u);
  assert.match(output, /FAILURE Prepare, rehearse and validate/u);
  assert.match(output, /Staging outcome: failed \(migration_rehearsal_failed\)/u);
  assert.match(output, /Staging release staging-manual-01 failed/u);
});

test("a refused preparation stops before confirmation", async (t) => {
  const world = await releaseWorld(t, "staging", { refusePrepare: true });
  assert.equal(await world.run(["staging", "--yes"], { interactive: false }), 7);
  assert.match(world.output(), /Production must have a known, idle starting state/u);
  assert.deepEqual(world.prompts, []);
  assert.deepEqual(world.dispatches, []);
});

test("tag overrides must resolve to a main commit with green push CI", async (t) => {
  const outside = await releaseWorld(t, "staging", { tags: { "v1.0.0": sha("f") } });
  assert.equal(await outside.run(["staging", "--tag", "v1.0.0", "--yes"], { interactive: false }), 2);
  assert.match(outside.output(), /not contained in origin\/main/u);
  const red = await releaseWorld(t, "staging", { tags: { "v1.0.0": newest } });
  assert.equal(await red.run(["staging", "--tag", "v1.0.0", "--yes"], { interactive: false }), 2);
  assert.match(red.output(), /no successful push ci\.yml run/u);
  assert.deepEqual([...outside.dispatches, ...red.dispatches], []);
});

test("missing owner secrets are named and stop before any request", async (t) => {
  const world = await releaseWorld(t, "staging");
  const environment = { KEEPR_GITHUB_RELEASE_TOKEN: secrets.KEEPR_GITHUB_RELEASE_TOKEN };
  assert.equal(await world.run(["staging", "--yes"], { interactive: false, environment }), 2);
  assert.match(
    world.output(),
    /KEEPR_PRODUCTION_ADMINISTRATION_KEY, KEEPR_STAGING_ADMINISTRATION_KEY in the repository's \.env/u,
  );
  assert.doesNotMatch(world.output(), /synthetic-github-release-secret/u);
  assert.equal(world.requests.length, 0);
});

/** GitHub, production and staging fakes behind one fetch; the real low-level CLI runs in-process. */
async function releaseWorld(t, kind, { bootstrap = false, fail = false, refusePrepare = false, tags = {} } = {}) {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let text = "";
  let clock = Date.parse("2026-09-22T10:00:00Z");
  const workflow = kind === "staging" ? "staging-deploy.yml" : "production-release.yml";
  const title = (id, head) => (kind === "staging" ? `staging-${id}-${head}` : `production-release-${id}-${head}`);
  const idPrefix = kind === "staging" ? "staging" : "release";
  const dispatchRuns = [1, 2].map((n) => ({
    id: 400 + n,
    event: "workflow_dispatch",
    display_title: title(`${idPrefix}-2026-09-22-0${n}`, older),
  }));
  const runPolls = new Map();
  const envelope =
    kind === "staging"
      ? (body) => ({
          release_id: body.release_id,
          idempotency_key: body.idempotency_key,
          expected_head_sha: body.expected_head_sha,
          expected_actor: body.expected_actor,
          ci_run_id: body.ci_run_id,
          production_start: { target, target_digest: "f".repeat(64), migration_level: 45 },
          required_checks: ["exact-commit-ci", "migration-rehearsal", "live-smoke"],
        })
      : (body) => ({
          production_target: target,
          release_id: body.release_id,
          expected_current_revision_id: body.expected_current_revision_id,
          expected_head_sha: body.expected_head_sha,
          expected_migration_level: body.expected_migration_level,
          bootstrap: true,
          idempotency_key: body.idempotency_key,
        });
  const world = {
    requests: [],
    ingestion: [],
    dispatches: [],
    prompts: [],
    confirmation: null,
    output: () => text,
  };
  const json = (document, status = 200) => Response.json(document, { status });
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const body = options.body ? JSON.parse(options.body) : null;
    world.requests.push({ url: url.href, body });
    if (url.hostname === "api.github.com") {
      const path = url.pathname.replace("/repos/KeeprDigital/card-keepr", "");
      const headSha = url.searchParams.get("head_sha");
      const only = (runs) => ({ workflow_runs: runs.filter((run) => !headSha || run.head_sha === headSha) });
      if (path === "/user") return json({ login: "owner" });
      if (path === "/actions/workflows/ci.yml/runs")
        return json(
          only([
            { id: 11, head_sha: noDev, event: "push", conclusion: "success" },
            { id: 13, head_sha: green, event: "push", conclusion: "success" },
            { id: 15, head_sha: older, event: "push", conclusion: "success" },
          ]),
        );
      if (path === "/actions/workflows/dev-deploy.yml/runs")
        return json(
          only([
            { id: 21, head_sha: green, conclusion: "success", display_title: `dev-${green}` },
            { id: 22, head_sha: older, conclusion: "success", display_title: `dev-${older}` },
          ]),
        );
      if (path === `/actions/workflows/${workflow}/runs`) return json({ workflow_runs: [...dispatchRuns].reverse() });
      if (path === `/actions/workflows/${workflow}/dispatches`) {
        world.dispatches.push({ workflow, inputs: body.inputs });
        // The matching run and a newer unrelated dispatch both appear.
        dispatchRuns.push(
          {
            id: 501,
            event: "workflow_dispatch",
            display_title: title(body.inputs.release_id, body.inputs.expected_head_sha),
          },
          { id: 502, event: "workflow_dispatch", display_title: title(`${idPrefix}-other`, older) },
        );
        return new Response(null, { status: 204 });
      }
      const runMatch = /^\/actions\/runs\/(\d+)(\/jobs)?$/u.exec(path);
      // A staging run keeps waiting for the promotion approval after its staging job.
      const done = (runPolls.get("501") ?? 0) >= 3;
      if (runMatch?.[1] === "501" && runMatch[2])
        return json({
          jobs: [
            ...(kind === "staging" && !fail
              ? [{ name: "promote", status: done ? "waiting" : "pending", conclusion: null, steps: [] }]
              : []),
            {
              name: kind === "staging" ? "staging" : "guarded-release",
              status: done ? "completed" : "in_progress",
              conclusion: done ? (fail ? "failure" : "success") : null,
              steps: [
                { name: "Check out", conclusion: "success" },
                {
                  name: "Prepare, rehearse and validate the guarded staging release",
                  conclusion: fail ? "failure" : "success",
                },
              ],
            },
          ],
        });
      if (runMatch?.[1] === "501") {
        const count = (runPolls.get("501") ?? 0) + 1;
        runPolls.set("501", count);
        if (count < 3) return json({ id: 501, status: count === 1 ? "queued" : "in_progress", conclusion: null });
        return json(
          kind === "staging" && !fail
            ? { id: 501, status: "waiting", conclusion: null }
            : { id: 501, status: "completed", conclusion: fail ? "failure" : "success" },
        );
      }
      return json({ message: "not found" }, 404);
    }
    const route = url.href.replace(/^https:\/\/card(-staging)?\.keepr\.digital\/(api|ingest)/u, "$1:$2");
    world.ingestion.push({ url: url.href, body });
    if (route === ":ingest/v1/staging-releases/staging-2026-09-22-03")
      return json({ release_id: "staging-2026-09-22-03" });
    if (route.startsWith(":ingest/v1/staging-releases/")) return json({ code: "not_found", detail: "No intent." }, 404);
    if (route === ":ingest/v1/staging-releases" || route === ":ingest/v1/production-releases") {
      if (refusePrepare)
        return json(
          { code: "staging_start_not_safe", detail: "Production must have a known, idle starting state." },
          409,
        );
      const expected = envelope(body);
      // Not canonical JSON: re-serializing would drop the space, so only exact bytes confirm.
      const confirmation = JSON.stringify(expected).replace('{"', '{ "');
      world.confirmation = confirmation;
      if (body.prepare)
        return json(
          kind === "staging" ? { confirmation } : { contract: "x", release_id: body.release_id, confirmation },
        );
      if (body.confirmation !== confirmation)
        return json({ code: "confirmation_required", detail: `Confirmation must exactly equal ${confirmation}` }, 409);
      return kind === "staging"
        ? json(
            {
              contract: "card-keepr-staging-release-request@1",
              release_id: body.release_id,
              dispatch_inputs: {
                release_id: body.release_id,
                intent_digest: "e".repeat(64),
                expected_head_sha: body.expected_head_sha,
              },
            },
            201,
          )
        : json(
            {
              contract: "card-keepr-production-release-request@1",
              release_id: body.release_id,
              dispatch_inputs: {
                operation: "production_release",
                release_id: body.release_id,
                expected_head_sha: body.expected_head_sha,
                bootstrap: "true",
              },
            },
            201,
          );
    }
    if (route === ":ingest/v1/status")
      return json({
        safe_state: { current_revision_id: "catrev_spine_000", mutation_safe: true },
        release_preflight: { bootstrap, schema_migration_level: 45 },
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
    if (route.startsWith("-staging:ingest/v1/staging-deployments/"))
      return json({
        release_id: route.split("/").at(-1),
        outcome: {
          state: fail ? "failed" : "succeeded",
          failure_code: fail ? "migration_rehearsal_failed" : null,
          deployment: { state: "succeeded" },
          migration: { state: fail ? "failed" : "succeeded", starting_level: 45, ending_level: 46 },
          checks: [{ name: "live-smoke", state: fail ? "not_run" : "succeeded" }],
        },
      });
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
      return await runCommand(args, interactive, answer, environment);
    } finally {
      [process.stdout.write, process.stderr.write] = outer;
    }
  };
  const runCommand = (args, interactive, answer, environment) =>
    runReleaseRunCommand(args, environment, false, {
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
        mainCommits: async () => [newest, noDev, green, older],
        resolveCommit: async (value) => value,
        resolveTag: async (tag) => tags[tag] ?? null,
        isInMain: async (value) => [newest, noDev, green, older].includes(value),
        subject: async (value) => `subject of ${value.slice(0, 7)}`,
      },
      prepareCheckout: async () => repositoryRoot,
      runKeepr: async (_checkout, args, env) => {
        let stdout = "";
        let stderr = "";
        const outer = [process.stdout.write, process.stderr.write];
        process.stdout.write = (chunk) => ((stdout += chunk), true);
        process.stderr.write = (chunk) => ((stderr += chunk), true);
        try {
          return { code: await main(args, env), stdout, stderr };
        } finally {
          [process.stdout.write, process.stderr.write] = outer;
        }
      },
    });
  return world;
}
