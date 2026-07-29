import {
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { spawn } from "node:child_process";
import {
  credentialClassDefinitions,
  isCredentialClass,
} from "../src/credentials/credential-catalogue.mjs";
import {
  classifySecretList,
  classifyTokenLookup,
  cloudflareOperationSucceeded,
  exactTokenPolicy,
} from "./provider-authority.mjs";
import {
  deleteGithubConsumerSecret,
  listGithubConsumerSecrets,
  probeGithubInstalledSecret,
  setGithubConsumerSecret,
} from "./provider-github-boundary.mjs";

const [
  action,
  planId,
  planDigest,
  planNonce,
  credentialClass,
  cloudflareAccountId,
  resourceIdentity,
  owningBoundary,
  verificationTarget,
  productionTargetIdentity,
  requiredPermission,
  consumerInstallationIdentity,
  executionMode,
  executionAttempt,
  oldFingerprint,
  replacementFingerprint,
  oldIssuerCredentialId,
  replacementIssuerCredentialId,
  managementCredentialId,
  githubManagementCredentialId,
  githubManagementCredentialFingerprint,
  githubManagementRequiredPermission,
] = process.argv.slice(2);
const secrets = await readInput();
const definition = isCredentialClass(credentialClass)
  ? credentialClassDefinitions[credentialClass]
  : undefined;
const tokenClass = [
  "d1_export_token",
  "d1_verification_token",
  "github_deployment_token",
].includes(credentialClass);

if (
  definition === undefined ||
  !["install", "verify", "revoke"].includes(action) ||
  !["mutation", "reconciliation"].includes(executionMode) ||
  !/^[1-9][0-9]*$/.test(executionAttempt) ||
  owningBoundary !== definition.owning_boundary ||
  requiredPermission !== definition.required_permission ||
  !resourceMatchesDefinition(
    definition,
    cloudflareAccountId,
    resourceIdentity,
    verificationTarget,
  ) ||
  !productionTargetMatches(
    productionTargetIdentity,
    cloudflareAccountId,
    resourceIdentity,
  ) ||
  typeof secrets.management_credential !== "string" ||
  secrets.management_credential.length === 0 ||
  (credentialClass === "github_deployment_token" &&
    (typeof secrets.github_management_credential !== "string" ||
      secrets.github_management_credential.length === 0 ||
      !equalFingerprint(
        fingerprint(secrets.github_management_credential),
        githubManagementCredentialFingerprint,
      ) ||
      !safeIdentity(githubManagementCredentialId) ||
      githubManagementRequiredPermission !==
        "github-actions-secrets:write:KeeprDigital/card-keepr:environment:production")) ||
  (credentialClass !== "github_deployment_token" &&
    (githubManagementCredentialId !== "not-applicable" ||
      githubManagementCredentialFingerprint !==
        `sha256:${"0".repeat(64)}` ||
      githubManagementRequiredPermission !== "not-applicable"))
) {
  process.exitCode = 2;
} else {
  const result = await execute();
  if (!result.ok) {
    process.exitCode = 9;
  } else {
    const facts = {
      version: 1,
      plan_id: planId,
      plan_digest: planDigest,
      plan_nonce: planNonce,
      action,
      credential_class: credentialClass,
      cloudflare_account_id: cloudflareAccountId,
      resource_identity: resourceIdentity,
      verification_target: verificationTarget,
      production_target_identity: productionTargetIdentity,
      required_permission: requiredPermission,
      consumer_installation_identity:
        consumerInstallationIdentity,
      execution_mode: executionMode,
      execution_attempt: Number.parseInt(executionAttempt, 10),
      old_fingerprint: oldFingerprint,
      replacement_fingerprint: replacementFingerprint,
      installed_fingerprint: replacementFingerprint,
      old_issuer_credential_id: oldIssuerCredentialId,
      replacement_issuer_credential_id:
        replacementIssuerCredentialId,
      management_credential_id: managementCredentialId,
      github_management_credential_id:
        githubManagementCredentialId,
      github_management_credential_fingerprint:
        githubManagementCredentialFingerprint,
      github_management_required_permission:
        githubManagementRequiredPermission,
      consumer_installation_id: result.consumerInstallationId,
      scope_evidence_digest: result.scopeEvidenceDigest,
      old_credential_status:
        action === "revoke" ? "unusable" : "usable",
      replacement_credential_status: "usable",
      observed_at: new Date().toISOString(),
      ...(result.consumerProof ?? {}),
    };
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        plan_id: planId,
        plan_digest: planDigest,
        facts,
      })}\n`,
    );
  }
}

async function execute() {
  if (action === "install" && executionMode === "mutation") {
    if (
      typeof secrets.old_secret !== "string" ||
      typeof secrets.replacement_secret !== "string" ||
      !equalFingerprint(
        fingerprint(secrets.old_secret),
        oldFingerprint,
      ) ||
      !equalFingerprint(
        fingerprint(secrets.replacement_secret),
        replacementFingerprint,
      )
    ) {
      return { ok: false };
    }
  }

  const management = await verifyToken(
    secrets.management_credential,
  );
  if (
    management?.id !== managementCredentialId ||
    management.status !== "active"
  ) {
    return { ok: false };
  }

  let scopeEvidence = {
    permission: requiredPermission,
    resource: resourceIdentity,
    provider: definition.consumer_provider,
  };
  if (tokenClass) {
    const replacementRecord = await tokenDetails(
      secrets.management_credential,
      replacementIssuerCredentialId,
    );
    if (
      replacementRecord.kind !== "present" ||
      !exactTokenPolicy(
        replacementRecord.token,
        requiredPermission,
        cloudflareAccountId,
      )
    ) {
      return { ok: false };
    }
    const replacement = replacementRecord.token;
    scopeEvidence = {
      token_id: replacementIssuerCredentialId,
      policies: replacement.policies,
      status: replacement.status,
      resource: resourceIdentity,
    };
    if (action === "verify") {
      const oldRecord = await tokenDetails(
        secrets.management_credential,
        oldIssuerCredentialId,
      );
      if (
        oldRecord.kind !== "present" ||
        !exactTokenPolicy(
          oldRecord.token,
          requiredPermission,
          cloudflareAccountId,
        )
      ) {
        return { ok: false };
      }
    }
    if (action === "install" && executionMode === "mutation") {
      const [verified, oldVerified, oldDetails] = await Promise.all([
        verifyToken(secrets.replacement_secret),
        verifyToken(secrets.old_secret),
        tokenDetails(
          secrets.management_credential,
          oldIssuerCredentialId,
        ),
      ]);
      if (
        verified?.id !== replacementIssuerCredentialId ||
        verified.status !== "active" ||
        oldVerified?.id !== oldIssuerCredentialId ||
        oldVerified.status !== "active" ||
        oldDetails.kind !== "present" ||
        !exactTokenPolicy(
          oldDetails.token,
          requiredPermission,
          cloudflareAccountId,
        ) ||
        !(await probeExactCapability(
          credentialClass,
          secrets.replacement_secret,
        ))
      ) {
        return { ok: false };
      }
    }
  }

  const marker = markerName(replacementFingerprint);
  if (action === "install" && executionMode === "mutation") {
    const installed =
      (await putConsumerSecret(
        definition,
        definition.replacement_secret_name,
        secrets.replacement_secret,
      )) &&
      (await putConsumerSecret(definition, marker, planId));
    if (!installed) return { ok: false };
  }
  if (!(await consumerHasSecrets(definition, [
    definition.replacement_secret_name,
    marker,
  ]))) {
    return { ok: false };
  }
  const consumerProof =
    credentialClass === "github_deployment_token"
      ? await probeGithubInstalledSecret({
          cloudflareAccountId,
          replacementIssuerCredentialId,
          planDigest,
          planNonce,
          secretSlot: "replacement",
          credential: secrets.github_management_credential,
        })
      : {};
  if (consumerProof === null) return { ok: false };
  if (
    credentialClass === "github_deployment_token" &&
    action === "verify"
  ) {
    const oldConsumerProof = await probeGithubInstalledSecret({
      cloudflareAccountId,
      replacementIssuerCredentialId: oldIssuerCredentialId,
      planDigest,
      planNonce,
      secretSlot: "active",
      credential: secrets.github_management_credential,
    });
    if (oldConsumerProof === null) return { ok: false };
    Object.assign(consumerProof, {
      old_consumer_proof_contract:
        oldConsumerProof.consumer_proof_contract,
      old_consumer_proof_id:
        oldConsumerProof.consumer_proof_id,
      old_consumer_proof_head_sha:
        oldConsumerProof.consumer_proof_head_sha,
      old_consumer_proof_actor:
        oldConsumerProof.consumer_proof_actor,
      old_consumer_proof_digest:
        oldConsumerProof.consumer_proof_digest,
    });
  }

  if (action === "revoke") {
    if (tokenClass) {
      const absent =
        executionMode === "mutation"
          ? (await deleteIssuerCredential(
              secrets.management_credential,
              oldIssuerCredentialId,
              requiredPermission,
            )) &&
            (await tokenDetails(
              secrets.management_credential,
              oldIssuerCredentialId,
            )).kind === "absent"
          : (await tokenDetails(
              secrets.management_credential,
              oldIssuerCredentialId,
            )).kind === "absent";
      if (!absent) {
        return { ok: false };
      }
    }
    const consumerAbsent =
      executionMode === "mutation"
        ? await deleteConsumerSecret(
            definition,
            definition.active_secret_name,
          )
        : await consumerSecretAuthoritativelyAbsent(
            definition,
            definition.active_secret_name,
          );
    if (!consumerAbsent) {
      return { ok: false };
    }
  }

  return {
    ok: true,
    consumerInstallationId: consumerInstallationIdentity,
    scopeEvidenceDigest: fingerprint(
      canonicalJson(scopeEvidence),
    ),
    consumerProof,
  };
}

async function tokenDetails(managementCredential, tokenId) {
  let response;
  try {
    response = await cloudflareRequest(
      managementCredential,
      `/accounts/${cloudflareAccountId}/tokens/${encodeURIComponent(
        tokenId,
      )}`,
    );
  } catch {
    return { kind: "failure" };
  }
  return classifyTokenLookup(response, tokenId);
}

async function verifyToken(token) {
  const response = await cloudflareRequest(
    token,
    `/accounts/${cloudflareAccountId}/tokens/verify`,
  );
  if (!response.ok) return null;
  const document = await response.json();
  return document?.success === true ? document.result : null;
}

async function deleteIssuerCredential(
  managementCredential,
  tokenId,
  permission,
) {
  const existing = await tokenDetails(managementCredential, tokenId);
  if (existing.kind === "absent") return true;
  if (
    existing.kind !== "present" ||
    !exactTokenPolicy(
      existing.token,
      permission,
      cloudflareAccountId,
    )
  ) {
    return false;
  }
  let response;
  try {
    response = await cloudflareRequest(
      managementCredential,
      `/accounts/${cloudflareAccountId}/tokens/${encodeURIComponent(
        tokenId,
      )}`,
      { method: "DELETE" },
    );
  } catch {
    return false;
  }
  if (!response.ok) return false;
  const document = await safeJson(response);
  return document?.success === true;
}

async function probeExactCapability(credentialClass_, token) {
  if (credentialClass_ === "d1_export_token") {
    const databaseId = d1DatabaseId(resourceIdentity);
    const response = await cloudflareRequest(
      token,
      `/accounts/${cloudflareAccountId}/d1/database/${databaseId}/export`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          output_format: "polling",
          dump_options: { no_data: true },
        }),
      },
    );
    return cloudflareOperationSucceeded(response);
  }
  if (credentialClass_ === "d1_verification_token") {
    const databaseId = d1DatabaseId(resourceIdentity);
    const response = await cloudflareRequest(
      token,
      `/accounts/${cloudflareAccountId}/d1/database/${databaseId}/query`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sql: [
            "CREATE TABLE IF NOT EXISTS __keepr_credential_probe (id INTEGER PRIMARY KEY)",
            "DROP TABLE __keepr_credential_probe",
          ].join(";"),
        }),
      },
    );
    return cloudflareOperationSucceeded(response);
  }
  // Exact issuer policy/resource introspection proves deploy capability
  // without mutating a production Worker.
  return credentialClass_ === "github_deployment_token";
}

function cloudflareRequest(token, pathname, init = {}) {
  return fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
}

async function putConsumerSecret(definition_, name, value) {
  if (definition_.consumer_provider === "wrangler") {
    return (
      (await run(
        "wrangler",
        [
          "secret",
          "put",
          name,
          "--config",
          definition_.consumer_config,
        ],
        value,
        providerEnvironment(),
      )) === 0
    );
  }
  return setGithubConsumerSecret(
    name,
    value,
    secrets.github_management_credential,
  );
}

async function consumerHasSecrets(definition_, names) {
  const listed = await listConsumerSecrets(definition_);
  return (
    listed.kind === "present" &&
    names.every((name) => listed.names.includes(name))
  );
}

async function listConsumerSecrets(definition_) {
  const result =
    definition_.consumer_provider === "wrangler"
      ? await capture(
          "wrangler",
          [
            "secret",
            "list",
            "--format",
            "json",
            "--config",
            definition_.consumer_config,
          ],
          providerEnvironment(),
        )
      : null;
  return definition_.consumer_provider === "wrangler"
    ? classifySecretList(result)
    : listGithubConsumerSecrets(
        secrets.github_management_credential,
      );
}

async function deleteConsumerSecret(definition_, name) {
  const before = await listConsumerSecrets(definition_);
  if (before.kind !== "present") return false;
  if (!before.names.includes(name)) return true;
  let deleted;
  if (definition_.consumer_provider === "wrangler") {
    deleted =
      (await run(
        "wrangler",
        [
          "secret",
          "delete",
          name,
          "--config",
          definition_.consumer_config,
        ],
        "",
        providerEnvironment(),
      )) === 0;
  } else {
    deleted = await deleteGithubConsumerSecret(
      name,
      secrets.github_management_credential,
    );
  }
  if (!deleted) return false;
  const after = await listConsumerSecrets(definition_);
  return (
    after.kind === "present" &&
    !after.names.includes(name)
  );
}

async function consumerSecretAuthoritativelyAbsent(
  definition_,
  name,
) {
  const listed = await listConsumerSecrets(definition_);
  return (
    listed.kind === "present" &&
    !listed.names.includes(name)
  );
}

function providerEnvironment() {
  return {
    ...process.env,
    CLOUDFLARE_API_TOKEN: secrets.management_credential,
  };
}

function resourceMatchesDefinition(
  definition_,
  accountId,
  resource,
  target,
) {
  if (definition_.resource_kind === "github-workflow") {
    return (
      resource.includes(
        `:workflow:${definition_.resource_name}`,
      ) &&
      target ===
        `${resource}:${definition_.verification_operation}`
    );
  }
  const prefix = `cloudflare-account:${accountId}:${definition_.resource_kind}:`;
  return (
    resource.startsWith(prefix) &&
    (definition_.resource_kind !== "worker" ||
      resource.endsWith(`:${definition_.resource_name}`)) &&
    target === `${resource}:${definition_.verification_operation}`
  );
}

function productionTargetMatches(value, accountId, resource) {
  let target;
  try {
    target = JSON.parse(value);
  } catch {
    return false;
  }
  const exactArray = (actual, expected) =>
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((item, index) => item === expected[index]);
  const d1Databases = target?.d1_databases;
  return (
    target?.cloudflare_account_id === accountId &&
    exactArray(target.worker_scripts, [
      "card-keepr-api",
      "card-keepr-ingestion",
    ]) &&
    Array.isArray(d1Databases) &&
    d1Databases.length === 2 &&
    d1Databases.every((id) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        id,
      ),
    ) &&
    (definition.resource_kind !== "d1" ||
      d1Databases.includes(d1DatabaseId(resource))) &&
    exactArray(target.r2_buckets, [
      "card-keepr-evidence",
      "card-keepr-printing-images",
      "card-keepr-catalogue-exports",
      "card-keepr-backups",
    ]) &&
    exactArray(target.workflows, [
      "card-keepr-evidence-ingestion",
      "card-keepr-evidence-host",
    ]) &&
    target.github_repository_id ===
      "repository-KeeprDigital-card-keepr" &&
    target.github_environment === "production" &&
    target.github_workflow ===
      ".github/workflows/credential-boundary-probe.yml"
  );
}

function d1DatabaseId(resource) {
  return resource.slice(resource.lastIndexOf(":") + 1);
}

function markerName(value) {
  return `KEEPR_ROTATION_${value.slice("sha256:".length).toUpperCase()}`;
}

function safeIdentity(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/.test(value)
  );
}

function fingerprint(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function equalFingerprint(left, right) {
  return timingSafeEqual(fingerprintBytes(left), fingerprintBytes(right));
}

function fingerprintBytes(value) {
  const match = /^sha256:([0-9a-f]{64})$/.exec(value ?? "");
  return match === null
    ? Buffer.alloc(32)
    : Buffer.from(match[1], "hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function run(command, arguments_, input, environment) {
  return new Promise((resolveRun) => {
    const child = spawn(command, arguments_, {
      cwd: process.cwd(),
      env: environment,
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.once("error", () => resolveRun(9));
    child.once("exit", (code) => resolveRun(code ?? 9));
    child.stdin.end(input);
  });
}

function capture(command, arguments_, environment) {
  return new Promise((resolveRun) => {
    const child = spawn(command, arguments_, {
      cwd: process.cwd(),
      env: environment,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 64_000) child.kill();
    });
    child.once("error", () => resolveRun({ code: 9, stdout: "" }));
    child.once("exit", (code) => {
      resolveRun({ code: code ?? 9, stdout });
    });
  });
}

async function readInput() {
  let value = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    value += chunk;
    if (value.length > 32_768) process.exit(2);
  }
  return JSON.parse(value);
}
