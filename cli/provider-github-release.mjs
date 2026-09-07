import { request as httpRequest } from "./lib/http-client.mjs";

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
    !["production_release", "cancel_fresh_baseline_handoff"].includes(inputs?.operation)
  )
    return false;
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
