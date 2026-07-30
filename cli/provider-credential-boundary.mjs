import {
  createHash,
  timingSafeEqual,
} from "node:crypto";
import {
  credentialClassDefinitions,
  isCredentialClass,
} from "../src/credentials/credential-catalogue.mjs";
import {
  exactManagementTokenPolicy,
  exactTokenPolicy,
} from "./provider-authority.mjs";
import {
  cloudflareJson,
} from "../src/credentials/cloudflare-authority.mjs";
import {
  createCloudflareProvider,
} from "./provider-cloudflare-boundary.mjs";
import {
  deleteGithubConsumerSecret,
  listGithubConsumerSecrets,
  probeGithubInstalledSecret,
  setGithubConsumerSecret,
  verifyGithubManagementAuthority,
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
  cloudflareManagementRequiredPermissions,
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
  oldConsumerSlot,
  replacementConsumerSlot,
  executionCapability,
  executionValidationUrl,
] = process.argv.slice(2);
const secrets = await readInput();
const definition = isCredentialClass(credentialClass)
  ? credentialClassDefinitions[credentialClass]
  : undefined;
const tokenClass =
  definition?.issuer_provider === "cloudflare-api-token";
const cloudflare = createCloudflareProvider({
  accountId: cloudflareAccountId,
  resourceIdentity,
});

if (
  definition === undefined ||
  !["install", "verify", "revoke"].includes(action) ||
  !["mutation", "reconciliation"].includes(executionMode) ||
  !/^[1-9][0-9]*$/.test(executionAttempt) ||
  !["a", "b"].includes(oldConsumerSlot) ||
  !["a", "b"].includes(replacementConsumerSlot) ||
  oldConsumerSlot === replacementConsumerSlot ||
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
  cloudflareManagementRequiredPermissions !==
    JSON.stringify(definition.management_permissions) ||
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
      githubManagementRequiredPermission !== "not-applicable")) ||
  !(await consumeExecutionCapability())
) {
  process.exitCode = 2;
} else {
  const journal = {
    contract: "card-keepr-provider-mutation-journal@1",
    mutation_started: false,
    steps: [],
  };
  const result = await execute(journal);
  if (!result.ok) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      plan_id: planId,
      plan_digest: planDigest,
      journal,
    })}\n`);
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
      cloudflare_management_required_permissions:
        cloudflareManagementRequiredPermissions,
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
      old_consumer_slot: oldConsumerSlot,
      replacement_consumer_slot: replacementConsumerSlot,
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
        journal,
      })}\n`,
    );
  }
}

async function consumeExecutionCapability() {
  if (
    !/^[0-9a-f]{64}$/.test(executionCapability ?? "") ||
    typeof executionValidationUrl !== "string"
  ) {
    return false;
  }
  let url;
  try {
    url = new URL(executionValidationUrl);
  } catch {
    return false;
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !==
      `/v1/credential-rotation-plans/${encodeURIComponent(planId)}/execution-capability` ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return false;
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        plan_digest: planDigest,
        execution_attempt: Number.parseInt(executionAttempt, 10),
        execution_capability: executionCapability,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return false;
    const document = await response.json();
    return (
      document?.contract ===
        "card-keepr-credential-execution-capability@1" &&
      document.consumed === true
    );
  } catch {
    return false;
  }
}

async function execute(journal) {
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

  const [management, managementRecord] = await Promise.all([
    cloudflare.verifyToken(secrets.management_credential),
    cloudflare.tokenDetails(
      secrets.management_credential,
      managementCredentialId,
    ),
  ]);
  if (
    management?.id !== managementCredentialId ||
    management.status !== "active" ||
    managementRecord.kind !== "present" ||
    !exactManagementTokenPolicy(
      managementRecord.token,
      definition.management_permissions,
      cloudflareAccountId,
    )
  ) {
    return { ok: false };
  }
  const productionTarget = JSON.parse(productionTargetIdentity);
  const githubAuthority =
    credentialClass === "github_deployment_token"
      ? await verifyGithubManagementAuthority({
          credential: secrets.github_management_credential,
          installationId:
            productionTarget.github_installation_id,
          repositoryId: productionTarget.github_repository_id,
          environmentId:
            productionTarget.github_environment_id,
          workflowId: productionTarget.github_workflow_id,
          requiredPolicy:
            githubManagementRequiredPermission,
        })
      : null;
  if (
    credentialClass === "github_deployment_token" &&
    githubAuthority === null
  ) {
    return { ok: false };
  }

  let scopeEvidence = {
    permission: requiredPermission,
    resource: resourceIdentity,
    provider: definition.consumer_provider,
    ...(githubAuthority === null
      ? {}
      : { github_management_authority: githubAuthority }),
  };
  if (tokenClass) {
    const replacementRecord = await cloudflare.tokenDetails(
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
      ...(githubAuthority === null
        ? {}
        : { github_management_authority: githubAuthority }),
    };
    if (action === "verify") {
      const oldRecord = await cloudflare.tokenDetails(
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
        cloudflare.verifyToken(secrets.replacement_secret),
        cloudflare.verifyToken(secrets.old_secret),
        cloudflare.tokenDetails(
          secrets.management_credential,
          oldIssuerCredentialId,
        ),
      ]);
      const capability = await cloudflare.probeExactCapability(
        credentialClass,
        secrets.replacement_secret,
        planDigest,
        planNonce,
      );
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
        !capability.ok
      ) {
        if (capability.mutation_started) {
          recordMutation(
            journal,
            `disposable-probe-cleanup:${capability.cleanup}`,
          );
        }
        return { ok: false };
      }
    }
  }

  const marker = markerName(replacementFingerprint);
  const oldSecretName =
    oldConsumerSlot === "a"
      ? definition.slot_a_secret_name
      : definition.slot_b_secret_name;
  const replacementSecretName =
    replacementConsumerSlot === "a"
      ? definition.slot_a_secret_name
      : definition.slot_b_secret_name;
  if (action === "install" && executionMode === "mutation") {
    if (!(await putConsumerSecret(
      definition,
      replacementSecretName,
      secrets.replacement_secret,
    ))) {
      return { ok: false };
    }
    recordMutation(journal, `consumer-secret-put:${replacementSecretName}`);
    if (!(await putConsumerSecret(definition, marker, planId))) {
      return { ok: false };
    }
    recordMutation(journal, `consumer-marker-put:${marker}`);
  } else if (
    action === "install" &&
    executionMode === "reconciliation"
  ) {
    const listed = await listConsumerSecrets(definition);
    if (listed.kind !== "present") return { ok: false };
    if (!listed.names.includes(replacementSecretName)) return { ok: false };
    if (
      !listed.names.includes(marker) &&
      !(await putConsumerSecret(definition, marker, planId))
    ) {
      return { ok: false };
    }
    if (!listed.names.includes(marker)) {
      recordMutation(journal, `consumer-marker-put:${marker}`);
    }
  }
  if (!(await consumerHasSecrets(definition, [
    replacementSecretName,
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
          secretSlot: replacementConsumerSlot,
          expectedActor: githubAuthority.expected_actor,
          credential: secrets.github_management_credential,
          workflowId: productionTarget.github_workflow_id,
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
      secretSlot: oldConsumerSlot,
      expectedActor: githubAuthority.expected_actor,
      credential: secrets.github_management_credential,
      workflowId: productionTarget.github_workflow_id,
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
          ? (await cloudflare.deleteIssuerCredential(
              secrets.management_credential,
              oldIssuerCredentialId,
              requiredPermission,
            )) &&
            (await cloudflare.tokenDetails(
              secrets.management_credential,
              oldIssuerCredentialId,
            )).kind === "absent"
          : (await cloudflare.tokenDetails(
              secrets.management_credential,
              oldIssuerCredentialId,
            )).kind === "absent";
      if (!absent) {
        return { ok: false };
      }
      if (executionMode === "mutation") {
        recordMutation(
          journal,
          `issuer-delete:${oldIssuerCredentialId}`,
        );
      }
    }
    const consumerAbsent =
      executionMode === "mutation" ||
      executionMode === "reconciliation"
        ? await deleteConsumerSecret(
            definition,
            oldSecretName,
          )
        : await consumerSecretAuthoritativelyAbsent(
            definition,
            oldSecretName,
          );
    if (!consumerAbsent) {
      return { ok: false };
    }
    recordMutation(journal, `consumer-secret-delete:${oldSecretName}`);
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

function recordMutation(journal, step) {
  journal.mutation_started = true;
  journal.steps.push(step);
}

async function putConsumerSecret(definition_, name, value) {
  if (definition_.consumer_provider === "wrangler") {
    const response = await cloudflare.request(
      secrets.management_credential,
      workerSecretPath(definition_),
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          text: value,
          type: "secret_text",
        }),
      },
    );
    return response.ok &&
      (await cloudflareJson(response))?.success === true;
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
  if (definition_.consumer_provider !== "wrangler") {
    return listGithubConsumerSecrets(
      secrets.github_management_credential,
    );
  }
  let response;
  try {
    response = await cloudflare.request(
      secrets.management_credential,
      workerSecretPath(definition_),
    );
  } catch {
    return { kind: "failure" };
  }
  const document = await cloudflareJson(response);
  if (
    !response.ok ||
    document?.success !== true ||
    !Array.isArray(document.result)
  ) {
    return { kind: "failure" };
  }
  const names = document.result.map((item) => item?.name);
  return names.every((name) => typeof name === "string")
    ? { kind: "present", names }
    : { kind: "failure" };
}

async function deleteConsumerSecret(definition_, name) {
  const before = await listConsumerSecrets(definition_);
  if (before.kind !== "present") return false;
  if (!before.names.includes(name)) return true;
  let deleted;
  if (definition_.consumer_provider === "wrangler") {
    const response = await cloudflare.request(
      secrets.management_credential,
      `${workerSecretPath(definition_)}/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    );
    deleted = response.ok &&
      (await cloudflareJson(response))?.success === true;
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

function workerSecretPath(definition_) {
  return `/accounts/${cloudflareAccountId}/workers/scripts/${encodeURIComponent(
    definition_.consumer_worker_name,
  )}/secrets`;
}

function resourceMatchesDefinition(
  definition_,
  accountId,
  resource,
  target,
) {
  if (definition_.resource_kind === "github-workflow") {
    return (
      /^github-repository:[1-9][0-9]*:installation:[1-9][0-9]*:environment:[1-9][0-9]*:workflow:[1-9][0-9]*$/.test(
        resource,
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
    ["github_repository_id", "github_installation_id",
      "github_environment_id", "github_workflow_id"].every(
      (field) => /^[1-9][0-9]*$/.test(target[field] ?? ""),
    ) &&
    (definition.resource_kind !== "github-workflow" ||
      resource ===
        `github-repository:${target.github_repository_id}:installation:${target.github_installation_id}:environment:${target.github_environment_id}:workflow:${target.github_workflow_id}`)
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

async function readInput() {
  let value = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    value += chunk;
    if (value.length > 32_768) process.exit(2);
  }
  return JSON.parse(value);
}
