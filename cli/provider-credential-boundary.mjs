import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { spawn } from "node:child_process";
import {
  credentialClassDefinitions,
  isCredentialClass,
} from "../src/credentials/credential-catalogue.mjs";

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
  owningBoundary !== definition.owning_boundary ||
  requiredPermission !== definition.required_permission ||
  !resourceMatchesDefinition(
    definition,
    cloudflareAccountId,
    resourceIdentity,
    verificationTarget,
  ) ||
  !process.env.KEEPR_CREDENTIAL_BOUNDARY_ATTESTATION_KEY ||
  typeof secrets.management_credential !== "string" ||
  secrets.management_credential.length === 0
) {
  process.exitCode = 2;
} else {
  const result = await execute();
  if (!result.ok) {
    process.exitCode = 9;
  } else {
    const payload = {
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
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString(
      "base64url",
    );
    const signature = createHmac(
      "sha256",
      process.env.KEEPR_CREDENTIAL_BOUNDARY_ATTESTATION_KEY,
    )
      .update(encoded)
      .digest("hex");
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        plan_id: planId,
        plan_digest: planDigest,
        boundary_attestation: `v1.${encoded}.${signature}`,
      })}\n`,
    );
  }
}

async function execute() {
  if (action === "install") {
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
    const replacement = await tokenDetails(
      secrets.management_credential,
      replacementIssuerCredentialId,
    );
    if (
      replacement === null ||
      !exactTokenPolicy(replacement, requiredPermission)
    ) {
      return { ok: false };
    }
    scopeEvidence = {
      token_id: replacementIssuerCredentialId,
      policies: replacement.policies,
      status: replacement.status,
      resource: resourceIdentity,
    };
    if (action === "install") {
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
        oldDetails === null ||
        !exactTokenPolicy(oldDetails, requiredPermission) ||
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
  if (action === "install") {
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

  if (action === "revoke") {
    if (tokenClass) {
      if (
        !(await deleteIssuerCredential(
          secrets.management_credential,
          oldIssuerCredentialId,
        )) ||
        (await tokenDetails(
          secrets.management_credential,
          oldIssuerCredentialId,
        )) !== null
      ) {
        return { ok: false };
      }
    }
    if (
      !(await deleteConsumerSecret(
        definition,
        definition.active_secret_name,
      ))
    ) {
      return { ok: false };
    }
  }

  return {
    ok: true,
    consumerInstallationId: [
      definition.consumer_provider,
      definition.replacement_secret_name,
      marker,
    ].join(":"),
    scopeEvidenceDigest: fingerprint(
      canonicalJson(scopeEvidence),
    ),
  };
}

async function tokenDetails(managementCredential, tokenId) {
  const response = await cloudflareRequest(
    managementCredential,
    `/accounts/${cloudflareAccountId}/tokens/${encodeURIComponent(
      tokenId,
    )}`,
  );
  if (response.status === 404) return null;
  if (!response.ok) return null;
  const document = await response.json();
  return document?.success === true &&
    document.result?.id === tokenId &&
    document.result?.status === "active"
    ? document.result
    : null;
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
  if (existing === null) return true;
  const response = await cloudflareRequest(
    managementCredential,
    `/accounts/${cloudflareAccountId}/tokens/${encodeURIComponent(
      tokenId,
    )}`,
    { method: "DELETE" },
  );
  return response.ok;
}

function exactTokenPolicy(token, permission) {
  if (!Array.isArray(token.policies) || token.policies.length !== 1) {
    return false;
  }
  const policy = token.policies[0];
  const groups = policy?.permission_groups;
  return (
    policy?.effect === "allow" &&
    Array.isArray(groups) &&
    groups.length === 1 &&
    groups[0]?.name === permission &&
    exactAccountResource(policy?.resources)
  );
}

function exactAccountResource(resources) {
  if (
    resources === null ||
    typeof resources !== "object" ||
    Array.isArray(resources)
  ) {
    return false;
  }
  const entries = Object.entries(resources);
  return (
    entries.length === 1 &&
    entries[0][0] ===
      `com.cloudflare.api.account.${cloudflareAccountId}` &&
    entries[0][1] === "*"
  );
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
    return response.ok;
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
    return response.ok;
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
  if (result.code !== 0) return false;
  let listed;
  try {
    listed = JSON.parse(result.stdout);
  } catch {
    return false;
  }
  return (
    Array.isArray(listed) &&
    names.every((name) =>
      listed.some((item) => item?.name === name),
    )
  );
}

async function deleteConsumerSecret(definition_, name) {
  if (!(await consumerHasSecrets(definition_, [name]))) return true;
  if (definition_.consumer_provider === "wrangler") {
    return (
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
      )) === 0
    );
  }
  return (
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
    )) === 0
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
