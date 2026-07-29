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
  requiredPermission,
  consumerInstallationIdentity,
  executionMode,
  executionAttempt,
  oldFingerprint,
  replacementFingerprint,
  oldIssuerCredentialId,
  replacementIssuerCredentialId,
  managementCredentialId,
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
  typeof secrets.management_credential !== "string" ||
  secrets.management_credential.length === 0
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
      ? await githubInstalledSecretProbe()
      : {};
  if (consumerProof === null) return { ok: false };

  if (action === "revoke") {
    if (tokenClass) {
      const absent =
        executionMode === "mutation"
          ? (await deleteIssuerCredential(
              secrets.management_credential,
              oldIssuerCredentialId,
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

async function githubInstalledSecretProbe() {
  const dispatched = await run(
    "gh",
    [
      "workflow",
      "run",
      "credential-boundary-probe.yml",
      "--repo",
      "KeeprDigital/card-keepr",
      "--ref",
      "main",
      "-f",
      `expected_account_id=${cloudflareAccountId}`,
      "-f",
      `expected_token_id=${replacementIssuerCredentialId}`,
    ],
    "",
    process.env,
  );
  if (dispatched !== 0) return null;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const result = await capture(
      "gh",
      [
        "run",
        "list",
        "--repo",
        "KeeprDigital/card-keepr",
        "--workflow",
        "credential-boundary-probe.yml",
        "--event",
        "workflow_dispatch",
        "--limit",
        "10",
        "--json",
        "databaseId,status,conclusion,displayTitle",
      ],
      process.env,
    );
    if (result.code !== 0) return null;
    let runs;
    try {
      runs = JSON.parse(result.stdout);
    } catch {
      return null;
    }
    const run = Array.isArray(runs)
      ? runs.find(
          (candidate) =>
            candidate?.displayTitle ===
            `credential-boundary-probe-${replacementIssuerCredentialId}`,
        )
      : undefined;
    if (
      Number.isSafeInteger(run?.databaseId) &&
      run.status === "completed"
    ) {
      return run.conclusion === "success"
        ? {
            consumer_proof_contract:
              "github-actions-installed-secret-probe@1",
            consumer_proof_id: String(run.databaseId),
          }
        : null;
    }
    await delay(5_000);
  }
  return null;
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

async function deleteIssuerCredential(managementCredential, tokenId) {
  const existing = await tokenDetails(managementCredential, tokenId);
  if (existing.kind === "absent") return true;
  if (existing.kind !== "present") return false;
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
  return (
    (await run(
      "gh",
      [
        "secret",
        "set",
        name,
        "--repo",
        "KeeprDigital/card-keepr",
        "--env",
        "production",
      ],
      value,
      process.env,
    )) === 0
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
      : await capture(
          "gh",
          [
            "secret",
            "list",
            "--repo",
            "KeeprDigital/card-keepr",
            "--env",
            "production",
            "--json",
            "name",
          ],
          process.env,
        );
  return classifySecretList(result);
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
    deleted =
      (await run(
        "gh",
        [
          "secret",
          "delete",
          name,
          "--repo",
          "KeeprDigital/card-keepr",
          "--env",
          "production",
        ],
        "",
        process.env,
      )) === 0;
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

function d1DatabaseId(resource) {
  return resource.slice(resource.lastIndexOf(":") + 1);
}

function markerName(value) {
  return `KEEPR_ROTATION_${value.slice("sha256:".length).toUpperCase()}`;
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

function delay(milliseconds) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
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
