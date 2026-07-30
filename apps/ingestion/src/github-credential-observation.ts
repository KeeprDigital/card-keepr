import type {
  CredentialRotationPlanRow,
} from "../../../src/catalogue/credential-rotation-contracts";
import type {
  CredentialConsumerProofRequestClaims,
} from "../../../src/credentials/consumer-proof";
import {
  parseGithubManagementPermissionPolicy,
} from "../../../src/credentials/credential-catalogue.mjs";

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
    init?: RequestInit,
  ) => Promise<any | null> = githubJson,
): Promise<unknown[] | null> {
  const authority =
    parseGithubManagementPermissionPolicy(
      plan.github_management_required_permission,
    );
  if (
    observationToken.length < 20 ||
    !/^[1-9][0-9]*$/.test(workflowId) ||
    !safeBotActor(expectedActor) ||
    plan.execution_started_at === null ||
    authority === null ||
    plan.github_management_credential_id !==
      `github-app-installation:${authority.github_installation_id}` ||
    authority.github_workflow_id !== workflowId
  ) {
    return null;
  }
  const permissions = {
    actions: "write",
    contents: "read",
    environments: "write",
    metadata: "read",
  };
  const installation = await request(
    observationToken,
    `/app/installations/${authority.github_installation_id}`,
  );
  if (
    installation?.id !==
      Number(authority.github_installation_id) ||
    installation?.repository_selection !== "selected" ||
    !exactPermissions(installation?.permissions, permissions)
  ) {
    return null;
  }
  const minted = await request(
    observationToken,
    `/app/installations/${authority.github_installation_id}/access_tokens`,
    {
      method: "POST",
      body: JSON.stringify({
        repository_ids: [Number(authority.github_repository_id)],
        permissions,
      }),
    },
  );
  if (
    typeof minted?.token !== "string" ||
    minted.token.length < 20 ||
    !exactPermissions(minted.permissions, permissions) ||
    !exactRepositories(
      minted.repositories,
      authority.github_repository_id,
    )
  ) {
    return null;
  }
  const installationToken = minted.token;
  const [repositories, viewer, repositoryInfo, environment, workflow,
    head, listed] = await Promise.all([
    request(installationToken, "/installation/repositories"),
    request(installationToken, "/graphql", {
      method: "POST",
      body: JSON.stringify({ query: "{ viewer { login } }" }),
    }),
    request(
      installationToken,
      `/repositories/${authority.github_repository_id}`,
    ),
    request(
      installationToken,
      `/repositories/${authority.github_repository_id}` +
        "/environments/production",
    ),
    request(
      installationToken,
      `/repositories/${authority.github_repository_id}` +
        `/actions/workflows/${workflowId}`,
    ),
    request(
      installationToken,
      `/repos/${repository}/git/ref/heads/main`,
    ),
    request(
      installationToken,
      `/repos/${repository}/actions/workflows/${workflowId}` +
        "/runs?event=workflow_dispatch&per_page=50",
      {
        headers: {
          "x-keepr-observation-run-titles": JSON.stringify(
            expected.map((item) => runTitle(plan, item)),
          ),
          "x-keepr-observation-started-at":
            plan.execution_started_at,
        },
      },
    ),
  ]);
  const headSha = head?.object?.sha;
  const runs = listed?.workflow_runs;
  if (
    repositories?.repository_selection !== "selected" ||
    repositories?.total_count !== 1 ||
    !exactRepositories(
      repositories?.repositories,
      authority.github_repository_id,
    ) ||
    viewer?.data?.viewer?.login !== expectedActor ||
    repositoryInfo?.id !== Number(authority.github_repository_id) ||
    environment?.id !== Number(authority.github_environment_id) ||
    workflow?.id !== Number(workflowId) ||
    workflow?.path !==
      ".github/workflows/credential-boundary-probe.yml" ||
    workflow?.state !== "active" ||
    !/^[0-9a-f]{40}$/.test(headSha ?? "") ||
    !Array.isArray(runs)
  ) {
    return null;
  }
  const evidence = [];
  for (const request of expected) {
    const title = runTitle(plan, request);
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

function runTitle(
  plan: CredentialRotationPlanRow,
  request: CredentialConsumerProofRequestClaims,
): string {
  const slot = request.slot === "a" ? "active" : "replacement";
  return (
    `credential-boundary-probe-${slot}` +
    `-${request.replacement_issuer_credential_id}` +
    `-${request.expected_status}` +
    `-${request.expected_fingerprint}-${plan.plan_digest}`
  );
}

async function githubJson(
  token: string,
  pathname: string,
  init: RequestInit = {},
): Promise<any | null> {
  try {
    const response = await fetch(`https://api.github.com${pathname}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

function exactPermissions(
  actual: unknown,
  expected: Record<string, string>,
): boolean {
  return (
    actual !== null &&
    typeof actual === "object" &&
    !Array.isArray(actual) &&
    JSON.stringify(
      Object.fromEntries(Object.entries(actual).sort()),
    ) === JSON.stringify(
      Object.fromEntries(Object.entries(expected).sort()),
    )
  );
}

function exactRepositories(
  repositories: unknown,
  repositoryId: string,
): boolean {
  return (
    Array.isArray(repositories) &&
    repositories.length === 1 &&
    repositories[0]?.id === Number(repositoryId)
  );
}

function safeBotActor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,99})\[bot\]$/.test(value)
  );
}
