import { request as httpRequest } from "./lib/http-client.mjs";
import { isReleaseDigest, isReleaseHead, isReleaseIdentity } from "../src/catalogue/shared/release-input-shapes.mjs";

const repository = "KeeprDigital/card-keepr";
const releaseWorkflow = "production-release.yml";
const githubApi = "https://api.github.com";

export async function dispatchProductionRelease({
  credential,
  inputs,
  workflowId = releaseWorkflow,
  apiUrl = githubApi,
}) {
  if (
    typeof credential !== "string" ||
    credential.length < 20 ||
    !["production_release", "cancel_fresh_baseline_handoff", "correct_fresh_baseline_handoff"].includes(
      inputs?.operation,
    )
  )
    return false;
  return dispatchWorkflow(credential, inputs, workflowId, apiUrl);
}

export async function dispatchStagingRelease({ credential, inputs, apiUrl = githubApi }) {
  if (
    typeof credential !== "string" ||
    credential.length < 20 ||
    !inputs ||
    Object.keys(inputs).sort().join("|") !== "expected_head_sha|intent_digest|release_id" ||
    !isReleaseIdentity(inputs.release_id) ||
    !isReleaseDigest(inputs.intent_digest) ||
    !isReleaseHead(inputs.expected_head_sha)
  )
    return false;
  return dispatchWorkflow(credential, inputs, "staging-deploy.yml", apiUrl);
}

async function dispatchWorkflow(credential, inputs, workflowId, apiUrl) {
  let response;
  try {
    response = await httpRequest(
      `${apiUrl}/repos/${repository}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({ ref: "main", inputs }),
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    return false;
  }
  return response.status === 204;
}

/**
 * Read-only calls for `release run` and `release approve`. The dispatch token's
 * Actions: write grant includes Actions: read; `release approve` also reads commit
 * statuses. Nothing here reads contents or checks.
 * @returns {Promise<any>} the parsed JSON document; throws a message without the credential on failure
 */
export async function readGithub({ credential, path, apiUrl = githubApi }) {
  let response;
  try {
    response = await httpRequest(`${apiUrl}${path.replace("{repository}", repository)}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${credential}`,
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(`GitHub is unavailable for ${path.split("?")[0]}`);
  }
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status} for ${path.split("?")[0]}`);
  return response.json();
}

/**
 * Approve a run's waiting environment deployment as the token's user, who must be
 * one of the environment's required reviewers (`release approve`, #238). Needs the
 * fine-grained **Deployments: write** grant.
 * @returns {Promise<boolean>} true when GitHub recorded the approval
 */
export async function approvePendingDeployment({ credential, runId, environmentId, comment, apiUrl = githubApi }) {
  if (
    typeof credential !== "string" ||
    credential.length < 20 ||
    !/^\d+$/u.test(String(runId)) ||
    !Number.isSafeInteger(environmentId)
  )
    return false;
  let response;
  try {
    response = await httpRequest(
      `${apiUrl}/repos/${repository}/actions/runs/${encodeURIComponent(runId)}/pending_deployments`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({ environment_ids: [environmentId], state: "approved", comment }),
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch {
    return false;
  }
  return response.status === 200;
}

export const githubPaths = {
  workflowRuns: (workflow, query) =>
    `/repos/{repository}/actions/workflows/${encodeURIComponent(workflow)}/runs?${new URLSearchParams(query)}`,
  run: (id) => `/repos/{repository}/actions/runs/${encodeURIComponent(id)}`,
  jobs: (id) => `/repos/{repository}/actions/runs/${encodeURIComponent(id)}/jobs?per_page=100`,
  pendingDeployments: (id) => `/repos/{repository}/actions/runs/${encodeURIComponent(id)}/pending_deployments`,
  statuses: (sha) => `/repos/{repository}/commits/${encodeURIComponent(sha)}/statuses?per_page=100`,
  user: () => "/user",
};

export const githubRunUrl = (id) => `https://github.com/${repository}/actions/runs/${id}`;
