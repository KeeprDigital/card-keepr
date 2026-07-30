import type {
  CredentialRotationPlanRow,
} from "../../../src/catalogue/credential-rotation-contracts";
import type {
  CredentialConsumerProofRequestClaims,
} from "../../../src/credentials/consumer-proof";

const repository = "KeeprDigital/card-keepr";

export async function observeGithubCredentialRuns(
  plan: CredentialRotationPlanRow,
  expected: Array<
    CredentialConsumerProofRequestClaims & { request_token: string }
  >,
  observationToken: string,
  workflowId: string,
  expectedActor: string,
  request: (
    token: string,
    pathname: string,
  ) => Promise<any | null> = githubJson,
): Promise<unknown[] | null> {
  if (
    observationToken.length < 20 ||
    !/^[1-9][0-9]*$/.test(workflowId) ||
    !safeBotActor(expectedActor) ||
    plan.execution_started_at === null
  ) {
    return null;
  }
  const [head, listed] = await Promise.all([
    request(
      observationToken,
      `/repos/${repository}/git/ref/heads/main`,
    ),
    request(
      observationToken,
      `/repos/${repository}/actions/workflows/${workflowId}` +
        "/runs?event=workflow_dispatch&per_page=50",
    ),
  ]);
  const headSha = head?.object?.sha;
  const runs = listed?.workflow_runs;
  if (
    !/^[0-9a-f]{40}$/.test(headSha ?? "") ||
    !Array.isArray(runs)
  ) {
    return null;
  }
  const evidence = [];
  for (const request of expected) {
    const slot =
      request.slot === "a" ? "active" : "replacement";
    const title =
      `credential-boundary-probe-${slot}` +
      `-${request.replacement_issuer_credential_id}` +
      `-${request.expected_status}` +
      `-${request.expected_fingerprint}-${plan.plan_digest}`;
    const matches = runs.filter((run) =>
      run?.display_title === title &&
      run?.workflow_id === Number(workflowId) &&
      run?.event === "workflow_dispatch" &&
      run?.head_sha === headSha &&
      run?.status === "completed" &&
      run?.conclusion === "success" &&
      run?.actor?.login === expectedActor &&
      typeof run?.created_at === "string" &&
      run.created_at >= plan.execution_started_at!
    );
    if (matches.length === 0) return null;
    const run = matches.sort(
      (left, right) =>
        String(right.created_at).localeCompare(String(left.created_at)),
    )[0]!;
    evidence.push({
      contract: "github-actions-server-observation@1",
      run_id: String(run.id),
      workflow_id: workflowId,
      head_sha: headSha,
      actor: run.actor.login,
      display_title: title,
      expected_fingerprint: request.expected_fingerprint,
      slot: request.slot,
      status: request.expected_status,
    });
  }
  return evidence;
}

async function githubJson(
  token: string,
  pathname: string,
): Promise<any | null> {
  try {
    const response = await fetch(`https://api.github.com${pathname}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(15_000),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

function safeBotActor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,99})\[bot\]$/.test(value)
  );
}
