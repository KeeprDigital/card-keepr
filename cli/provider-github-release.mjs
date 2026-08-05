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
    typeof credential !== "string" || credential.length < 20 ||
    inputs?.operation !== "production_release" ||
    !/^[0-9a-f]{40}$/.test(inputs.expected_head_sha ?? "") ||
    !safeBotActor(inputs.expected_actor)
  ) return false;
  let response;
  try {
    response = await fetch(
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

function safeBotActor(value) {
  return typeof value === "string" &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\[bot\]$/.test(value);
}
