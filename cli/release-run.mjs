import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseOptions, writeCliFailure } from "./command-support.mjs";
import { request as httpRequest } from "./lib/http-client.mjs";
import { githubPaths, githubRunUrl, readGithub } from "./provider-github-release.mjs";
import {
  ciRunFor,
  confirmationFromProblem,
  describeEnvelope,
  devDeliveredFor,
  incrementReleaseId,
  matchDispatchedRun,
  nextReleaseId,
  releaseIdsFromRuns,
  releaseKinds,
  selectReleaseCommit,
} from "./release-run-support.mjs";
import { isReleaseIdentity } from "../src/catalogue/shared/release-input-shapes.mjs";
import { environmentNames } from "../src/http/environment-target.mjs";

const run = promisify(execFile);
export const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const productionActor = "github-actions[bot]";
const requiredSecrets = {
  staging: ["KEEPR_PRODUCTION_ADMINISTRATION_KEY", "KEEPR_STAGING_ADMINISTRATION_KEY", "KEEPR_GITHUB_RELEASE_TOKEN"],
  production: ["KEEPR_PRODUCTION_ADMINISTRATION_KEY", "KEEPR_PRODUCTION_API_KEY", "KEEPR_GITHUB_RELEASE_TOKEN"],
};
const defaultTiming = {
  pollMs: 15_000,
  findRunMs: 3 * 60_000,
  watchMs: { staging: 45 * 60_000, production: 75 * 60_000 },
};

class ReleaseStop extends Error {
  constructor(code, detail, exitCode = 1) {
    super(detail);
    this.code = code;
    this.exitCode = exitCode;
  }
}
const stop = (code, detail, exitCode) => {
  throw new ReleaseStop(code, detail, exitCode);
};

/**
 * `keepr release run staging|production`: select the commit, prepare through the
 * target commit's own CLI, show the exact server envelope, confirm it unedited,
 * then find and watch the dispatched workflow run and summarize its outcome.
 */
export async function runReleaseRunCommand(args, environment, json, deps = defaultDeps()) {
  try {
    return await releaseRun(args, environment, deps);
  } catch (error) {
    if (error instanceof ReleaseStop)
      return writeCliFailure(json, { code: error.code, detail: error.message }, error.exitCode);
    return writeCliFailure(json, { code: "release_run_failed", detail: error.message }, 1);
  }
}

async function releaseRun(args, environment, deps) {
  const [kind, ...rest] = args;
  const options = parseOptions(rest, ["--sha", "--tag", "--release-id"], ["--json", "--yes"]);
  if (!(kind in releaseKinds) || options.error !== null || (options.values["--sha"] && options.values["--tag"]))
    stop(
      "invalid_arguments",
      "Usage: keepr release run staging|production [--sha <sha> | --tag vX.Y.Z] [--release-id <id>] [--yes]",
      2,
    );
  const yes = options.flags.has("--yes");
  if (!yes && !deps.interactive)
    stop("confirmation_required", "No terminal to confirm on: re-run with --yes to confirm non-interactively.", 2);
  const requestedId = options.values["--release-id"];
  if (requestedId !== undefined && !isReleaseIdentity(requestedId))
    stop("invalid_arguments", "--release-id is not a valid release identity.", 2);
  const say = (line = "") => deps.write(`${line}\n`);

  // The keepr entrypoint has already added the owner env file (cli/owner-env.mjs).
  const env = environment;
  const missing = requiredSecrets[kind].filter((name) => !env[name]);
  if (missing.length > 0)
    stop(
      "configuration_error",
      `Set ${missing.join(", ")} in the repository's .env (names: .env.example) or the environment.`,
      2,
    );
  const github = (path) =>
    readGithub({ credential: env.KEEPR_GITHUB_RELEASE_TOKEN, path, apiUrl: env.KEEPR_GITHUB_API_URL });

  const commit = await selectCommit(options.values, deps.git, github, say);
  say(`Commit ${commit.sha} ${commit.subject}`);
  say(`  push CI run ${commit.ciRunId}; dev delivery ${commit.devDelivered ? "succeeded" : "not observed"}`);

  const checkout = await deps.prepareCheckout(commit.sha, say, env.KEEPR_RELEASE_WORKTREE_ROOT);
  const actor = kind === "staging" ? await stagingActor(env, github) : productionActor;
  const childEnv = { ...env, KEEPR_GITHUB_RELEASE_ACTOR: actor };
  const keepr = async (keeprArgs) => {
    const result = await deps.runKeepr(checkout, keeprArgs, childEnv);
    return { code: result.code, document: lastJsonLine(result.stdout), stderr: result.stderr };
  };

  const workflow = releaseKinds[kind].workflow;
  const dispatchRuns = async () =>
    (await github(githubPaths.workflowRuns(workflow, { event: "workflow_dispatch", per_page: "100" }))).workflow_runs ??
    [];
  const releaseId = requestedId ?? (await generateReleaseId(kind, deps.now(), await dispatchRuns(), keepr));

  const prepareArgs = await releaseArguments(kind, { releaseId, commit, keepr, say });
  const prepared = await keepr(prepareArgs);
  const confirmation = prepared.code === 3 ? confirmationFromProblem(prepared.document) : null;
  if (confirmation === null)
    stop(
      prepared.document?.code ?? "release_prepare_failed",
      `Preparation refused (exit ${prepared.code}): ${prepared.document?.detail ?? prepared.stderr.trim()}`,
      prepared.code === 0 ? 1 : prepared.code,
    );
  let envelope;
  try {
    envelope = JSON.parse(confirmation);
  } catch {
    stop("invalid_administration_contract", "The server confirmation is not JSON; nothing was dispatched.", 8);
  }
  let lines;
  try {
    lines = describeEnvelope(kind, envelope, { releaseId, sha: commit.sha, subject: commit.subject });
  } catch (error) {
    stop("invalid_administration_contract", `${error.message} Nothing was dispatched.`, 8);
  }
  say();
  for (const line of lines) say(line);
  say();
  if (!yes && !(await deps.confirm("Proceed? [y/N] ")))
    stop("release_not_confirmed", "Release not confirmed; nothing was dispatched.", 3);

  const title = releaseKinds[kind].title(releaseId, commit.sha);
  const earlier = new Set(
    (await dispatchRuns()).filter((item) => item.display_title === title).map((item) => String(item.id)),
  );
  const dispatched = await keepr([...prepareArgs, "--confirm", confirmation]);
  if (dispatched.code !== 10)
    stop(
      dispatched.document?.code ?? "release_dispatch_failed",
      `Confirmation or dispatch failed (exit ${dispatched.code}): ${dispatched.document?.detail ?? dispatched.stderr.trim()}`,
      dispatched.code === 0 ? 1 : dispatched.code,
    );
  say(`Dispatched ${workflow} for ${releaseId}; waiting for its run.`);

  const timing = deps.timing;
  const found = await poll(deps, timing.findRunMs, async () =>
    matchDispatchedRun(await dispatchRuns(), title, earlier),
  );
  if (found === null)
    stop(
      "workflow_run_not_found",
      `GitHub accepted the dispatch but no ${workflow} run named ${title} appeared. Inspect GitHub Actions.`,
    );
  say(`Watching ${githubRunUrl(found.id)}`);
  let lastStatus = "";
  // A staging run continues into production promotion, which waits for the
  // owner's approval (#238), so staging is finished when its `staging` job is.
  const finished = await poll(deps, timing.watchMs[kind], async () => {
    const current = await github(githubPaths.run(found.id));
    if (current.status !== lastStatus) say(`  run ${current.status}`);
    lastStatus = current.status;
    if (kind !== "staging") return current.status === "completed" ? current : null;
    const job = ((await github(githubPaths.jobs(found.id))).jobs ?? []).find((item) => item.name === "staging");
    if (job?.status === "completed") return { ...current, conclusion: job.conclusion };
    return current.status === "completed" ? current : null;
  });
  if (finished === null)
    stop("workflow_run_timeout", `Run ${githubRunUrl(found.id)} did not finish in time; it may still be running.`);

  say();
  say(`${kind === "staging" ? "Staging job" : "Run"} conclusion: ${finished.conclusion}`);
  const { jobs = [] } = await github(githubPaths.jobs(found.id));
  // A promotion job still waiting for approval has no conclusion yet.
  for (const job of jobs.filter((item) => item.status === undefined || item.status === "completed")) {
    const failed = (job.steps ?? []).filter((step) => !["success", "skipped"].includes(step.conclusion));
    if (job.conclusion !== "success" || failed.length > 0) say(`  job ${job.name}: ${job.conclusion}`);
    for (const step of failed) say(`    ${String(step.conclusion).toUpperCase()} ${step.name}`);
  }
  const healthy =
    kind === "staging" ? await stagingOutcome(releaseId, keepr, say) : await productionOutcome(keepr, deps, say);
  if (finished.conclusion !== "success" || !healthy)
    stop("release_failed", `${kind === "staging" ? "Staging release" : "Production Release"} ${releaseId} failed.`);
  say(`${kind === "staging" ? "Staging release" : "Production Release"} ${releaseId} succeeded.`);
  if (kind === "staging")
    say(
      `Production promotion of ${commit.sha.slice(0, 12)} waits for your approval: run \`pnpm release:approve\` (or approve ${githubRunUrl(found.id)}).`,
    );
  return 0;
}

/** The low-level CLI prints one JSON document per `--json` invocation. */
function lastJsonLine(stdout) {
  try {
    return JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    return null;
  }
}

async function selectCommit(values, git, github, say) {
  await git.fetch();
  const ciRuns = async (sha) =>
    (
      await github(
        githubPaths.workflowRuns("ci.yml", {
          branch: "main",
          event: "push",
          status: "success",
          per_page: "100",
          ...(sha ? { head_sha: sha } : {}),
        }),
      )
    ).workflow_runs ?? [];
  const devRuns = async (sha) =>
    (
      await github(
        githubPaths.workflowRuns("dev-deploy.yml", {
          status: "success",
          per_page: "100",
          ...(sha ? { head_sha: sha } : {}),
        }),
      )
    ).workflow_runs ?? [];
  const tag = values["--tag"];
  if (tag !== undefined || values["--sha"] !== undefined) {
    if (tag !== undefined && !/^v\d+\.\d+\.\d+$/u.test(tag)) stop("invalid_arguments", "--tag must be vX.Y.Z.", 2);
    const sha = tag === undefined ? await git.resolveCommit(values["--sha"]) : await git.resolveTag(tag);
    if (sha === null) stop("commit_not_found", `${tag ?? values["--sha"]} does not name a commit.`, 2);
    if (!(await git.isInMain(sha))) stop("commit_not_in_main", `${sha} is not contained in origin/main.`, 2);
    const ciRunId = ciRunFor(sha, await ciRuns(sha));
    if (ciRunId === null) stop("ci_not_green", `${sha} has no successful push ci.yml run on main.`, 2);
    return { sha, ciRunId, subject: await git.subject(sha), devDelivered: devDeliveredFor(sha, await devRuns(sha)) };
  }
  const commits = await git.mainCommits(50);
  const selected = selectReleaseCommit({ commits, ciRuns: await ciRuns(), devRuns: await devRuns() });
  if (selected === null)
    stop("no_release_commit", "No recent main commit has both a successful push CI run and dev delivery.", 2);
  const skipped = commits.indexOf(selected.sha);
  if (skipped > 0) say(`Skipped ${skipped} newer main commit(s) without green push CI and dev delivery.`);
  return { ...selected, subject: await git.subject(selected.sha), devDelivered: true };
}

/** Staging records the dispatching owner's login; it is the token's own account. */
async function stagingActor(env, github) {
  const user = await github(githubPaths.user());
  if (typeof user?.login !== "string" || user.login.length === 0)
    stop("configuration_error", "KEEPR_GITHUB_RELEASE_TOKEN does not identify a GitHub user.", 2);
  return user.login;
}

/**
 * GitHub run names are the authoritative list of dispatched IDs. Staging also
 * asks production, which records an intent on confirmation even if its dispatch
 * failed. Production preparation is read-only, so an undispatched ID is free.
 */
async function generateReleaseId(kind, now, runs, keepr) {
  let id = nextReleaseId(kind, now, releaseIdsFromRuns(kind, runs));
  if (kind === "production") return id;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const existing = await keepr(["release", "staging-status", "--target", "production", "--release-id", id, "--json"]);
    if (existing.code === 6) return id;
    if (existing.code !== 0)
      stop(
        existing.document?.code ?? "release_id_unavailable",
        `Could not check release ID ${id}: ${existing.document?.detail ?? "unknown"}`,
      );
    id = incrementReleaseId(id);
  }
  return stop("release_id_unavailable", "No free staging release ID today; pass --release-id.", 2);
}

async function releaseArguments(kind, { releaseId, commit, keepr, say }) {
  const common = ["--release-id", releaseId, "--idempotency-key", releaseId, "--expected-head-sha", commit.sha];
  if (kind === "staging")
    return [
      "release",
      "staging",
      "--target",
      "production",
      ...common,
      "--ci-run-id",
      commit.ciRunId,
      "--yes",
      "--json",
    ];
  const status = await keepr(["status", "--target", "production", "--json"]);
  if (status.code !== 0)
    stop(status.document?.code ?? "status_failed", `Production status failed: ${status.document?.detail ?? "unknown"}`);
  const revision = status.document?.safe_state?.current_revision_id;
  const level = status.document?.release_preflight?.schema_migration_level;
  const bootstrap = status.document?.release_preflight?.bootstrap;
  if (
    typeof revision !== "string" ||
    revision.length === 0 ||
    !Number.isSafeInteger(level) ||
    typeof bootstrap !== "boolean"
  )
    stop(
      "invalid_administration_contract",
      "Production status did not report a revision, schema level and Bootstrap Mode.",
      8,
    );
  say(`Production: revision ${revision}, schema level ${level}, Bootstrap Mode ${bootstrap ? "on" : "off"}`);
  return [
    "release",
    "production",
    "--target",
    "production",
    "--environment",
    "production",
    ...common,
    "--expected-current-revision",
    revision,
    "--expected-migration-level",
    String(level),
    ...(bootstrap ? ["--bootstrap"] : []),
    "--yes",
    "--json",
  ];
}

async function stagingOutcome(releaseId, keepr, say) {
  const result = await keepr(["release", "staging-status", "--target", "staging", "--release-id", releaseId, "--json"]);
  const outcome = result.document?.outcome;
  if (result.code !== 0 || outcome === null || typeof outcome !== "object") {
    say(`Staging outcome: unavailable (${result.document?.detail ?? `exit ${result.code}`})`);
    return false;
  }
  say(`Staging outcome: ${outcome.state}${outcome.failure_code ? ` (${outcome.failure_code})` : ""}`);
  say(`  deployment ${outcome.deployment?.state}`);
  say(
    `  migration ${outcome.migration?.state}: level ${outcome.migration?.starting_level} -> ${outcome.migration?.ending_level}`,
  );
  for (const check of outcome.checks ?? []) say(`  check ${check.name}: ${check.state}`);
  return outcome.state === "succeeded";
}

async function productionOutcome(keepr, deps, say) {
  let healthy = true;
  const status = await keepr(["status", "--target", "production", "--json"]);
  if (status.code === 0)
    say(
      `Production: revision ${status.document?.safe_state?.current_revision_id}, schema level ${status.document?.release_preflight?.schema_migration_level}, Bootstrap Mode ${status.document?.release_preflight?.bootstrap ? "on" : "off"}`,
    );
  else {
    say(`Production status: unavailable (${status.document?.detail ?? `exit ${status.code}`})`);
    healthy = false;
  }
  const health = await keepr(["health", "--target", "production", "--json"]);
  for (const runtime of health.document?.runtimes ?? [])
    say(`  ${runtime.name}: ${runtime.status}, version ${runtime.checks?.version?.id ?? "unknown"}`);
  if (health.code !== 0) {
    say(`Production health: ${health.document?.status ?? health.document?.detail ?? `exit ${health.code}`}`);
    healthy = false;
  }
  for (const [name, base] of Object.entries(environmentNames("production").publicBases)) {
    const code = await deps.liveness(`${base}/healthz`);
    say(`  ${name} /healthz: ${code}`);
    if (code !== 200) healthy = false;
  }
  return healthy;
}

async function poll(deps, limitMs, attempt) {
  const deadline = deps.now().getTime() + limitMs;
  for (;;) {
    const value = await attempt();
    if (value !== null) return value;
    if (deps.now().getTime() >= deadline) return null;
    await deps.sleep(deps.timing.pollMs);
  }
}

export function defaultDeps() {
  const git = (...args) =>
    run("git", ["-C", repositoryRoot, ...args], { encoding: "utf8" }).then((out) => out.stdout.trim());
  const commit = (ref) => git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`).catch(() => null);
  return {
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    write: (text) => process.stdout.write(text),
    now: () => new Date(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    timing: defaultTiming,
    confirm: async (question) => {
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^y(es)?$/iu.test((await prompt.question(question)).trim());
      } finally {
        prompt.close();
      }
    },
    liveness: async (url) => {
      try {
        return (await httpRequest(url, { signal: AbortSignal.timeout(10_000) })).status;
      } catch {
        return 0;
      }
    },
    git: {
      fetch: () => git("fetch", "--quiet", "--tags", "origin", "main"),
      mainCommits: async (count) => (await git("rev-list", "--first-parent", `-${count}`, "origin/main")).split("\n"),
      resolveCommit: (sha) => commit(sha),
      resolveTag: (tag) => commit(`refs/tags/${tag}`),
      isInMain: (sha) =>
        git("merge-base", "--is-ancestor", sha, "origin/main").then(
          () => true,
          () => false,
        ),
      subject: (sha) => git("log", "-1", "--format=%s", sha),
    },
    prepareCheckout: (sha, say, worktreeRoot) => prepareReleaseCheckout(sha, say, worktreeRoot),
    runKeepr: (checkout, args, env) =>
      new Promise((done, failed) => {
        const child = spawn(process.execPath, [join(checkout, "cli", "keepr.mjs"), ...args], {
          cwd: checkout,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", failed);
        child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
      }),
  };
}

/**
 * A clean detached worktree of the exact release commit, so every server-bound
 * request is built by the CLI that commit's green CI tested, never by the
 * owner's current (possibly dirty, older or unmerged) checkout.
 */
async function prepareReleaseCheckout(sha, say, worktreeRoot) {
  const inRepo = (args, cwd = repositoryRoot) =>
    run("git", ["-C", cwd, ...args], { encoding: "utf8" }).then((out) => out.stdout.trim());
  const common = await inRepo(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const root = worktreeRoot || join(dirname(dirname(common)), "card-keepr-worktrees");
  const path = join(root, `release-${sha.slice(0, 12)}`);
  if (existsSync(path)) {
    const head = await inRepo(["rev-parse", "HEAD"], path).catch(() => "");
    const dirty = await inRepo(["status", "--porcelain"], path).catch(() => "unreadable");
    if (head !== sha || dirty !== "")
      stop(
        "release_checkout_unusable",
        `${path} exists but is not a clean checkout of ${sha}; remove it and retry.`,
        2,
      );
  } else {
    await mkdir(root, { recursive: true });
    await inRepo(["worktree", "add", "--quiet", "--detach", path, sha]);
  }
  say(`Release checkout ${path}`);
  try {
    await run("pnpm", ["install", "--frozen-lockfile", "--silent"], { cwd: path, encoding: "utf8" });
  } catch (error) {
    stop("release_checkout_install_failed", `pnpm install failed in ${path}: ${String(error.stderr ?? "").trim()}`, 2);
  }
  return path;
}
