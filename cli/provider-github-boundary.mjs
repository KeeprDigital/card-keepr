import { createHash } from "node:crypto";
import sodium from "libsodium-wrappers";

const repository = "KeeprDigital/card-keepr";
const environmentName = "production";
const probeWorkflow = "credential-boundary-probe.yml";
const githubApi = "https://api.github.com";
const exactInstallationPermissions = Object.freeze({
  actions: "write",
  contents: "read",
  environments: "write",
  metadata: "read",
});

export async function verifyGithubManagementAuthority({
  credential,
  installationId,
  repositoryId,
  environmentId,
  workflowId,
  requiredPolicy,
}) {
  const installation = await githubRequest(
    credential,
    `/app/installations/${installationId}`,
  );
  if (
    !installation.ok ||
    installation.document?.id !== Number(installationId) ||
    installation.document?.repository_selection !== "selected" ||
    !exactObject(
      installation.document?.permissions,
      exactInstallationPermissions,
    )
  ) {
    return null;
  }
  const minted = await githubRequest(
    credential,
    `/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      body: JSON.stringify({
        repository_ids: [Number(repositoryId)],
        permissions: exactInstallationPermissions,
      }),
    },
  );
  if (
    !minted.ok ||
    typeof minted.document?.token !== "string" ||
    minted.document.token.length < 20 ||
    !exactObject(
      minted.document.permissions,
      exactInstallationPermissions,
    ) ||
    !Array.isArray(minted.document.repositories) ||
    minted.document.repositories.length !== 1 ||
    minted.document.repositories[0]?.id !== Number(repositoryId)
  ) {
    return null;
  }
  const installationToken = minted.document.token;
  const [
    repositories,
    repositoryDocument,
    environment,
    workflow,
    viewer,
  ] =
    await Promise.all([
      githubRequest(installationToken, "/installation/repositories"),
      githubRequest(installationToken, `/repositories/${repositoryId}`),
      githubRequest(
        installationToken,
        `/repos/${repository}/environments/${environmentName}`,
      ),
      githubRequest(
        installationToken,
        `/repos/${repository}/actions/workflows/${workflowId}`,
      ),
      githubRequest(installationToken, "/graphql", {
        method: "POST",
        body: JSON.stringify({
          query: "query { viewer { login } }",
        }),
      }),
    ]);
  if (
    !repositories.ok ||
    !repositoryDocument.ok ||
    !environment.ok ||
    !workflow.ok ||
    !viewer.ok
  ) {
    return null;
  }
  const expectedPolicy =
    `github-app-installation:${installationId}` +
    `:repository:${repositoryId}` +
    `:environment:${environmentId}` +
    `:workflow:${workflowId}` +
    ":actions=write,contents=read,environments=write,metadata=read";
  const authority = {
    installation: installation.document,
    repositories: repositories.document,
    repository: repositoryDocument.document,
    environment: environment.document,
    workflow: workflow.document,
    viewer: viewer.document,
    expected: {
      installationId,
      repositoryId,
      environmentId,
      workflowId,
      requiredPolicy: expectedPolicy,
      suppliedPolicy: requiredPolicy,
    },
  };
  if (!githubAuthorityMatches(authority)) return null;
  return {
    installation_id: installationId,
    repository_id: String(repositoryDocument.document.id),
    environment_id: String(environment.document.id),
    workflow_id: String(workflow.document.id),
    repository_selection: "selected",
    repositories_count: 1,
    permission_policy: requiredPolicy,
    expected_actor: viewer.document.data.viewer.login,
    installation_token: installationToken,
  };
}

export function githubAuthorityMatches({
  repositories,
  installation,
  repository: repositoryDocument,
  environment,
  workflow,
  viewer,
  expected,
}) {
  return (
    installation?.id === Number(expected.installationId) &&
    installation?.repository_selection === "selected" &&
    exactObject(
      installation.permissions,
      expected.permissions ?? exactInstallationPermissions,
    ) &&
    repositories?.repository_selection === "selected" &&
    repositories?.total_count === 1 &&
    Array.isArray(repositories.repositories) &&
    repositories.repositories.length === 1 &&
    repositories.repositories[0]?.id ===
      Number(expected.repositoryId) &&
    safeBotActor(viewer?.data?.viewer?.login) &&
    exactGithubTargets(
      repositoryDocument,
      environment,
      workflow,
      expected,
    )
  );
}

function exactGithubTargets(
  repositoryDocument,
  environment,
  workflow,
  expected,
) {
  return (
    repositoryDocument?.id === Number(expected.repositoryId) &&
    environment?.id === Number(expected.environmentId) &&
    environment?.name === environmentName &&
    workflow?.id === Number(expected.workflowId) &&
    workflow?.path ===
      ".github/workflows/credential-boundary-probe.yml" &&
    workflow?.state === "active" &&
    expected.suppliedPolicy === expected.requiredPolicy
  );
}

export async function setGithubConsumerSecret(
  name,
  value,
  credential,
) {
  const key = await githubRequest(
    credential,
    `/repos/${repository}/environments/${environmentName}/secrets/public-key`,
  );
  if (
    !key.ok ||
    typeof key.document?.key !== "string" ||
    typeof key.document?.key_id !== "string"
  ) {
    return false;
  }
  await sodium.ready;
  const encrypted = sodium.to_base64(
    sodium.crypto_box_seal(
      sodium.from_string(value),
      sodium.from_base64(
        key.document.key,
        sodium.base64_variants.ORIGINAL,
      ),
    ),
    sodium.base64_variants.ORIGINAL,
  );
  const response = await githubRequest(
    credential,
    `/repos/${repository}/environments/${environmentName}/secrets/${encodeURIComponent(name)}`,
    {
      method: "PUT",
      body: JSON.stringify({
        encrypted_value: encrypted,
        key_id: key.document.key_id,
      }),
    },
  );
  return response.ok;
}

export async function listGithubConsumerSecrets(credential) {
  const response = await githubRequest(
    credential,
    `/repos/${repository}/environments/${environmentName}/secrets?per_page=100`,
  );
  if (!response.ok || !Array.isArray(response.document?.secrets)) {
    return { kind: "failure" };
  }
  const names = response.document.secrets.map((item) => item?.name);
  return names.every((name) => typeof name === "string")
    ? { kind: "present", names }
    : { kind: "failure" };
}

export async function deleteGithubConsumerSecret(
  name,
  credential,
) {
  const response = await githubRequest(
    credential,
    `/repos/${repository}/environments/${environmentName}/secrets/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
  return response.ok;
}

export async function probeGithubInstalledSecret({
  cloudflareAccountId,
  replacementIssuerCredentialId,
  planDigest,
  planNonce,
  secretSlot,
  expectedActor,
  credential,
  workflowId,
}) {
  const workflowSlot =
    secretSlot === "a"
      ? "active"
      : secretSlot === "b"
        ? "replacement"
        : null;
  if (workflowSlot === null || !safeBotActor(expectedActor)) {
    return null;
  }
  const head = await githubRequest(
    credential,
    `/repos/${repository}/git/ref/heads/main`,
  );
  const expectedHeadSha = head.document?.object?.sha;
  if (!head.ok || !/^[0-9a-f]{40}$/.test(expectedHeadSha ?? "")) {
    return null;
  }
  const runTitle =
    `credential-boundary-probe-${workflowSlot}-${replacementIssuerCredentialId}-${planNonce}-${planDigest}`;
  const dispatchedAfter = new Date().toISOString();
  const dispatched = await githubRequest(
    credential,
    `/repos/${repository}/actions/workflows/${workflowId ?? probeWorkflow}/dispatches`,
    {
      method: "POST",
      body: JSON.stringify({
        ref: "main",
        inputs: {
          expected_account_id: cloudflareAccountId,
          expected_token_id: replacementIssuerCredentialId,
          plan_digest: planDigest,
          plan_nonce: planNonce,
          expected_head_sha: expectedHeadSha,
          expected_actor: expectedActor,
          secret_slot: workflowSlot,
        },
      }),
    },
  );
  if (!dispatched.ok) return null;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const listed = await githubRequest(
      credential,
      `/repos/${repository}/actions/workflows/${workflowId ?? probeWorkflow}/runs?event=workflow_dispatch&per_page=10`,
    );
    if (!listed.ok || !Array.isArray(listed.document?.workflow_runs)) {
      return null;
    }
    const selected = listed.document.workflow_runs.find(
      (candidate) =>
        candidate?.display_title === runTitle &&
        candidate?.head_sha === expectedHeadSha &&
        typeof candidate?.created_at === "string" &&
        candidate.created_at >= dispatchedAfter,
    );
    if (
      Number.isSafeInteger(selected?.id) &&
      selected.status === "completed"
    ) {
      if (
        selected.conclusion !== "success" ||
        selected.actor?.login !== expectedActor
      ) {
        return null;
      }
      const evidence =
        `${runTitle}\0${expectedHeadSha}\0${String(selected.id)}\0${expectedActor}`;
      return {
        consumer_proof_contract:
          "github-actions-installed-secret-probe@2",
        consumer_proof_id: String(selected.id),
        consumer_proof_head_sha: expectedHeadSha,
        consumer_proof_actor: expectedActor,
        consumer_proof_digest: fingerprint(evidence),
      };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
  }
  return null;
}

function safeBotActor(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,99})\[bot\]$/.test(value)
  );
}

async function githubRequest(credential, pathname, init = {}) {
  let response;
  try {
    response = await fetch(`${githubApi}${pathname}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, status: 0, document: null };
  }
  let document = null;
  if (response.status !== 204) {
    try {
      document = await response.json();
    } catch {
      return { ok: false, status: response.status, document: null };
    }
  }
  return { ok: response.ok, status: response.status, document };
}

function exactObject(actual, expected) {
  if (
    actual === null ||
    typeof actual !== "object" ||
    Array.isArray(actual)
  ) {
    return false;
  }
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every(
      (key, index) =>
        key === expectedKeys[index] &&
        actual[key] === expected[key],
    )
  );
}

function fingerprint(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
