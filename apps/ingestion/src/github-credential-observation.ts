import type {
  CredentialRotationPlanRow,
} from "../../../src/catalogue/credential-rotation-contracts";
import type {
  CredentialConsumerProofRequestClaims,
} from "../../../src/credentials/consumer-proof";
import {
  parseGithubManagementPermissionPolicy,
} from "../../../src/credentials/credential-catalogue.mjs";
import {
  createGithubAppJwt,
  githubAppKeyFingerprint,
} from "../../../src/credentials/github-app-auth.mjs";

const repository = "KeeprDigital/card-keepr";

export async function observeGithubCredentialRuns(
  plan: CredentialRotationPlanRow,
  expected: Array<
    CredentialConsumerProofRequestClaims & { request_token: string }
  >,
  appPrivateKey: string,
  appId: string,
  workflowId: string,
  expectedActor: string,
  observedAt: string,
  request: (
    token: string,
    pathname: string,
    init?: RequestInit,
  ) => Promise<unknown | null> = githubJson,
  mintJwt: (
    privateKey: string,
    appId: string,
    observedAt: string,
  ) => string | null = createGithubAppJwt,
): Promise<unknown[] | null> {
  const authority =
    parseGithubManagementPermissionPolicy(
      plan.github_management_required_permission,
    );
  if (
    appPrivateKey.length < 20 ||
    authority?.github_app_id !== appId ||
    !/^[1-9][0-9]*$/.test(workflowId) ||
    !safeBotActor(expectedActor) ||
    plan.execution_started_at === null ||
    authority === null ||
    plan.github_management_credential_id !==
      `github-app:${appId}` +
        `:installation:${authority.github_installation_id}` ||
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
  if (
    plan.github_management_credential_fingerprint !==
      githubAppKeyFingerprint(appPrivateKey)
  ) {
    return null;
  }
  const observationToken = mintJwt(
    appPrivateKey,
    appId,
    observedAt,
  );
  if (observationToken === null) return null;
  const installation = await request(
    observationToken,
    `/app/installations/${authority.github_installation_id}`,
  );
  const installationDocument = jsonObject(installation);
  if (
    installationDocument?.id !==
      Number(authority.github_installation_id) ||
    installationDocument?.repository_selection !== "selected" ||
    !exactPermissions(installationDocument?.permissions, permissions)
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
  const mintedDocument = jsonObject(minted);
  if (
    typeof mintedDocument?.token !== "string" ||
    mintedDocument.token.length < 20 ||
    !exactPermissions(mintedDocument.permissions, permissions) ||
    !exactRepositories(
      mintedDocument.repositories,
      authority.github_repository_id,
    )
  ) {
    return null;
  }
  const installationToken = mintedDocument.token;
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
      `/repos/${repository}/environments/production`,
    ),
    request(
      installationToken,
      `/repos/${repository}/actions/workflows/${workflowId}`,
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
  const repositoriesDocument = jsonObject(repositories);
  const viewerDocument = jsonObject(viewer);
  const viewerData = jsonObject(viewerDocument?.data);
  const viewerIdentity = jsonObject(viewerData?.viewer);
  const repositoryDocument = jsonObject(repositoryInfo);
  const environmentDocument = jsonObject(environment);
  const workflowDocument = jsonObject(workflow);
  const headDocument = jsonObject(head);
  const headObject = jsonObject(headDocument?.object);
  const listedDocument = jsonObject(listed);
  const headSha = headObject?.sha;
  const runs = listedDocument?.workflow_runs;
  if (
    repositoriesDocument?.repository_selection !== "selected" ||
    repositoriesDocument?.total_count !== 1 ||
    !exactRepositories(
      repositoriesDocument?.repositories,
      authority.github_repository_id,
    ) ||
    viewerIdentity?.login !== expectedActor ||
    repositoryDocument?.id !== Number(authority.github_repository_id) ||
    environmentDocument?.id !== Number(authority.github_environment_id) ||
    workflowDocument?.id !== Number(workflowId) ||
    workflowDocument?.path !==
      ".github/workflows/production-release.yml" ||
    workflowDocument?.state !== "active" ||
    typeof headSha !== "string" ||
    !/^[0-9a-f]{40}$/.test(headSha) ||
    !Array.isArray(runs)
  ) {
    return null;
  }
  const evidence = [];
  for (const request of expected) {
    const title = runTitle(plan, request);
    const matches = runs
      .map(jsonObject)
      .filter((run): run is Record<string, unknown> =>
        run !== null &&
        run.display_title === title &&
        run.workflow_id === Number(workflowId) &&
        run.event === "workflow_dispatch" &&
        run.head_sha === headSha &&
        run.status === "completed" &&
        run.conclusion === "success" &&
        jsonObject(run.actor)?.login === expectedActor &&
        typeof run.created_at === "string" &&
        run.created_at >= plan.execution_started_at!
      );
    if (matches.length === 0) return null;
    const run = matches.sort(
      (left, right) =>
        String(right.created_at).localeCompare(String(left.created_at)),
    )[0]!;
    const runActor = jsonObject(run.actor);
    if (typeof runActor?.login !== "string") return null;
    evidence.push({
      contract: "github-actions-server-observation@1",
      run_id: String(run.id),
      workflow_id: workflowId,
      head_sha: headSha,
      actor: runActor.login,
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
    `production-release-credential-boundary-${slot}` +
    `-${request.replacement_issuer_credential_id}` +
    `-${request.expected_status}` +
    `-${request.expected_fingerprint}-${plan.plan_digest}`
  );
}

async function githubJson(
  token: string,
  pathname: string,
  init: RequestInit = {},
): Promise<unknown | null> {
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

function jsonObject(
  value: unknown,
): Record<string, unknown> | null {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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
    jsonObject(repositories[0])?.id === Number(repositoryId)
  );
}

function safeBotActor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,99})\[bot\]$/.test(value)
  );
}
