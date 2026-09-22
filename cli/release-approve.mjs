import { parseOptions, writeCliFailure } from "./command-support.mjs";
import { approvePendingDeployment, githubPaths, githubRunUrl, readGithub } from "./provider-github-release.mjs";
import { defaultDeps, repositoryRoot } from "./release-run.mjs";
import { releaseKinds } from "./release-run-support.mjs";
// The staging-deploy.yml promote job's environment; its required reviewer is the owner's one approval.
import { promotionEnvironment } from "../src/http/dev-workflow-identity.mjs";

const requiredSecrets = ["KEEPR_GITHUB_RELEASE_TOKEN", "KEEPR_STAGING_ADMINISTRATION_KEY"];

class ApproveStop extends Error {
  constructor(code, detail, exitCode) {
    super(detail);
    this.code = code;
    this.exitCode = exitCode;
  }
}
const stop = (code, detail, exitCode = 1) => {
  throw new ApproveStop(code, detail, exitCode);
};

/**
 * `keepr release approve` (`pnpm release:approve`): the owner's one approval of an
 * automatic production promotion (#238). Finds the newest staging release's run,
 * shows what it would promote, asks y/N on a terminal, and approves its waiting
 * `production-promotion` deployment. There is deliberately no `--yes`.
 */
export async function runReleaseApproveCommand(args, environment, json, deps = defaultDeps()) {
  try {
    return await approve(args, environment, deps);
  } catch (error) {
    if (error instanceof ApproveStop)
      return writeCliFailure(json, { code: error.code, detail: error.message }, error.exitCode);
    return writeCliFailure(json, { code: "release_approve_failed", detail: error.message }, 1);
  }
}

async function approve(args, env, deps) {
  if (parseOptions(args, [], ["--json"]).error !== null) stop("invalid_arguments", "Usage: keepr release approve", 2);
  if (!deps.interactive)
    stop("confirmation_required", "Approving a production promotion needs a person at a terminal.", 2);
  const missing = requiredSecrets.filter((name) => !env[name]);
  if (missing.length > 0)
    stop(
      "configuration_error",
      `Set ${missing.join(", ")} in the repository's .env (names: .env.example) or the environment.`,
      2,
    );
  const say = (line = "") => deps.write(`${line}\n`);
  const github = (path) =>
    readGithub({ credential: env.KEEPR_GITHUB_RELEASE_TOKEN, path, apiUrl: env.KEEPR_GITHUB_API_URL });

  const staging = releaseKinds.staging;
  const runs = (
    (await github(githubPaths.workflowRuns(staging.workflow, { event: "workflow_dispatch", per_page: "100" })))
      .workflow_runs ?? []
  )
    .map((run) => ({ run, match: staging.titlePattern.exec(String(run.display_title ?? run.name ?? "")) }))
    .filter((item) => item.match !== null)
    .sort((a, b) => b.run.id - a.run.id);
  if (runs.length === 0)
    stop(
      "no_promotion_waiting",
      "Nothing to approve: no staging release has run yet. Start one with `pnpm release:staging`.",
      6,
    );
  const [{ run, match }] = runs;
  const [, releaseId, sha] = match;
  const url = githubRunUrl(run.id);
  if (run.status !== "waiting")
    stop(
      "no_promotion_waiting",
      `Nothing to approve: the newest staging release ${releaseId} (${url}) is ${run.status}${run.conclusion ? ` (${run.conclusion})` : ""}, not waiting for approval.`,
      6,
    );
  const pending = await github(githubPaths.pendingDeployments(run.id));
  const deployment = (Array.isArray(pending) ? pending : []).find(
    (item) => item?.environment?.name === promotionEnvironment,
  );
  if (deployment === undefined || !Number.isSafeInteger(deployment.environment.id))
    stop(
      "no_promotion_waiting",
      `Nothing to approve: ${url} is not waiting on the ${promotionEnvironment} environment.`,
      6,
    );
  if (deployment.current_user_can_approve !== true)
    stop(
      "promotion_approval_forbidden",
      `KEEPR_GITHUB_RELEASE_TOKEN's user is not a required reviewer of ${promotionEnvironment}.`,
      5,
    );
  const { jobs = [] } = await github(githubPaths.jobs(run.id));
  const stagingJob = jobs.find((job) => job.name === "staging");
  if (stagingJob?.conclusion !== "success")
    stop("staging_release_failed", `The staging job of ${url} did not succeed; nothing to promote.`, 7);

  const outcome = await stagingOutcome(deps, env, releaseId);
  const extended = await extendedStatus(github, sha);
  say(`Production promotion waiting in ${url}`);
  say(`  staging release  ${releaseId}`);
  say(`  commit           ${sha}`);
  say(`  staging outcome  ${outcome}`);
  say(`  extended         ${extended}`);
  say(`  promotes as      promotion-${releaseId}, after production rechecks every guard`);
  say();
  if (!(await deps.confirm("Approve this production promotion? [y/N] ")))
    stop("promotion_not_approved", "Not approved; the promotion keeps waiting (reject it on the run page).", 3);
  const approved = await approvePendingDeployment({
    credential: env.KEEPR_GITHUB_RELEASE_TOKEN,
    runId: run.id,
    environmentId: deployment.environment.id,
    comment: `pnpm release:approve: ${releaseId} ${sha}`,
    apiUrl: env.KEEPR_GITHUB_API_URL,
  });
  if (!approved)
    stop(
      "promotion_approval_failed",
      "GitHub did not record the approval; the token needs Deployments: write. Approve on the run page instead.",
      9,
    );
  say(`Approved. Production promotion of ${sha.slice(0, 12)} continues in ${url}`);
  return 0;
}

async function stagingOutcome(deps, env, releaseId) {
  const result = await deps.runKeepr(
    repositoryRoot,
    ["release", "staging-status", "--target", "staging", "--release-id", releaseId, "--json"],
    env,
  );
  let document = null;
  try {
    document = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    // Reported as unavailable below.
  }
  const outcome = document?.outcome;
  if (result.code !== 0 || outcome === null || typeof outcome !== "object")
    return `unavailable (${document?.detail ?? `exit ${result.code}`})`;
  return `${outcome.state}${outcome.failure_code ? ` (${outcome.failure_code})` : ""}; migration level ${outcome.migration?.starting_level} -> ${outcome.migration?.ending_level}`;
}

/** Display only: production verifies the run this status names before promoting. */
async function extendedStatus(github, sha) {
  let statuses;
  try {
    statuses = await github(githubPaths.statuses(sha));
  } catch (error) {
    return `unavailable (${error.message}; the token needs Commit statuses: read)`;
  }
  const latest = (Array.isArray(statuses) ? statuses : []).find((status) => status?.context === "extended-scenarios");
  if (latest === undefined) return "missing: production will stop the promotion (extended_scenarios_missing)";
  const note =
    latest.state === "success"
      ? ""
      : latest.state === "pending"
        ? "; the promotion waits up to an hour for it"
        : "; production will stop the promotion";
  return `${latest.state}${latest.description ? `: ${latest.description}` : ""}${note}`;
}
