import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { classifySecretList } from "./provider-authority.mjs";

const repository = "KeeprDigital/card-keepr";
const environmentName = "production";
const probeWorkflow = "credential-boundary-probe.yml";

export async function verifyGithubManagementAuthority({
  credential,
  installationId,
  repositoryId,
  environmentId,
  workflowId,
  requiredPolicy,
}) {
  const [installationResult, repositoryResult, environmentResult, workflowResult] =
    await Promise.all([
      capture(["api", "installation"], credential),
      capture(["api", `repositories/${repositoryId}`], credential),
      capture(
        [
          "api",
          `repos/${repository}/environments/production`,
        ],
        credential,
      ),
      capture(
        [
          "api",
          `repos/${repository}/actions/workflows/${workflowId}`,
        ],
        credential,
      ),
    ]);
  const installation = parsedDocument(installationResult);
  const repositoryDocument = parsedDocument(repositoryResult);
  const environment = parsedDocument(environmentResult);
  const workflow = parsedDocument(workflowResult);
  const expectedPermissions = {
    actions: "write",
    contents: "read",
    environments: "write",
    metadata: "read",
  };
  const expectedPolicy =
    `github-app-installation:${installationId}` +
    `:repository:${repositoryId}` +
    `:environment:${environmentId}` +
    `:workflow:${workflowId}` +
    ":actions=write,contents=read,environments=write,metadata=read";
  if (!githubAuthorityMatches({
    installation,
    repository: repositoryDocument,
    environment,
    workflow,
    expected: {
      installationId,
      repositoryId,
      environmentId,
      workflowId,
      requiredPolicy: expectedPolicy,
      suppliedPolicy: requiredPolicy,
      permissions: expectedPermissions,
    },
  })) {
    return null;
  }
  return {
    installation_id: String(installation.id),
    app_id: String(installation.app_id),
    app_slug: installation.app_slug,
    target_id: String(installation.target_id),
    repository_id: String(repositoryDocument.id),
    environment_id: String(environment.id),
    workflow_id: String(workflow.id),
    permissions: expectedPermissions,
  };
}

export function githubAuthorityMatches({
  installation,
  repository: repositoryDocument,
  environment,
  workflow,
  expected,
}) {
  return (
    installation?.id === Number(expected.installationId) &&
    exactObject(
      installation.permissions,
      expected.permissions,
    ) &&
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
  return (
    (await run(
      [
        "secret",
        "set",
        name,
        "--repo",
        repository,
        "--env",
        environmentName,
      ],
      value,
      credential,
    )) === 0
  );
}

export async function listGithubConsumerSecrets(credential) {
  return classifySecretList(
    await capture(
      [
        "secret",
        "list",
        "--repo",
        repository,
        "--env",
        environmentName,
        "--json",
        "name",
      ],
      credential,
    ),
  );
}

export async function deleteGithubConsumerSecret(
  name,
  credential,
) {
  return (
    (await run(
      [
        "secret",
        "delete",
        name,
        "--repo",
        repository,
        "--env",
        environmentName,
      ],
      "",
      credential,
    )) === 0
  );
}

export async function probeGithubInstalledSecret({
  cloudflareAccountId,
  replacementIssuerCredentialId,
  planDigest,
  planNonce,
  secretSlot,
  credential,
}) {
  if (!["active", "replacement"].includes(secretSlot)) return null;
  const head = await capture(
    [
      "api",
      `repos/${repository}/git/ref/heads/main`,
      "--jq",
      ".object.sha",
    ],
    credential,
  );
  const expectedHeadSha = head.stdout.trim();
  if (
    head.code !== 0 ||
    !/^[0-9a-f]{40}$/.test(expectedHeadSha)
  ) {
    return null;
  }
  const viewer = await capture(
    ["api", "user", "--jq", ".login"],
    credential,
  );
  const expectedActor = viewer.stdout.trim();
  if (
    viewer.code !== 0 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(expectedActor)
  ) {
    return null;
  }
  const dispatchedAfter = new Date().toISOString();
  const runTitle =
    `credential-boundary-probe-${secretSlot}-${replacementIssuerCredentialId}-${planNonce}-${planDigest}`;
  const dispatched = await run(
    [
      "workflow",
      "run",
      probeWorkflow,
      "--repo",
      repository,
      "--ref",
      "main",
      "-f",
      `expected_account_id=${cloudflareAccountId}`,
      "-f",
      `expected_token_id=${replacementIssuerCredentialId}`,
      "-f",
      `plan_digest=${planDigest}`,
      "-f",
      `plan_nonce=${planNonce}`,
      "-f",
      `expected_head_sha=${expectedHeadSha}`,
      "-f",
      `expected_actor=${expectedActor}`,
      "-f",
      `secret_slot=${secretSlot}`,
    ],
    "",
    credential,
  );
  if (dispatched !== 0) return null;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const listed = await capture(
      [
        "run",
        "list",
        "--repo",
        repository,
        "--workflow",
        probeWorkflow,
        "--event",
        "workflow_dispatch",
        "--limit",
        "10",
        "--json",
        "databaseId,status,conclusion,displayTitle,createdAt,headSha",
      ],
      credential,
    );
    if (listed.code !== 0) return null;
    let runs;
    try {
      runs = JSON.parse(listed.stdout);
    } catch {
      return null;
    }
    const selected = Array.isArray(runs)
      ? runs.find(
          (candidate) =>
            candidate?.displayTitle === runTitle &&
            candidate?.headSha === expectedHeadSha &&
            typeof candidate?.createdAt === "string" &&
            candidate.createdAt >= dispatchedAfter,
        )
      : undefined;
    if (
      Number.isSafeInteger(selected?.databaseId) &&
      selected.status === "completed"
    ) {
      if (selected.conclusion !== "success") return null;
      const log = await capture(
        [
          "run",
          "view",
          String(selected.databaseId),
          "--repo",
          repository,
          "--log",
        ],
        credential,
      );
      const evidence =
        `KEEPR_CREDENTIAL_PROOF plan_digest=${planDigest} plan_nonce=${planNonce} ` +
        `head_sha=${expectedHeadSha} token_id=${replacementIssuerCredentialId} ` +
        `actor=${expectedActor} slot=${secretSlot}`;
      return log.code === 0 && log.stdout.includes(evidence)
        ? {
            consumer_proof_contract:
              "github-actions-installed-secret-probe@1",
            consumer_proof_id: String(selected.databaseId),
            consumer_proof_head_sha: expectedHeadSha,
            consumer_proof_actor: expectedActor,
            consumer_proof_digest: fingerprint(evidence),
          }
        : null;
    }
    await new Promise((resolveDelay) => {
      setTimeout(resolveDelay, 5_000);
    });
  }
  return null;
}

function githubEnvironment(credential) {
  return {
    PATH: process.env.PATH,
    GH_TOKEN: credential,
    GH_PROMPT_DISABLED: "1",
  };
}

function parsedDocument(result) {
  if (result.code !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
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

function run(arguments_, input, credential) {
  return new Promise((resolveRun) => {
    const child = spawn("gh", arguments_, {
      cwd: process.cwd(),
      env: githubEnvironment(credential),
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.once("error", () => resolveRun(9));
    child.once("exit", (code) => resolveRun(code ?? 9));
    child.stdin.end(input);
  });
}

function capture(arguments_, credential) {
  return new Promise((resolveRun) => {
    const child = spawn("gh", arguments_, {
      cwd: process.cwd(),
      env: githubEnvironment(credential),
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 64_000) child.kill();
    });
    child.once("error", () =>
      resolveRun({ code: 9, stdout: "" }),
    );
    child.once("exit", (code) => {
      resolveRun({ code: code ?? 9, stdout });
    });
  });
}

function fingerprint(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
