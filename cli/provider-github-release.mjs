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
