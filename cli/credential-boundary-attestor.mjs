import { spawn } from "node:child_process";
import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { resolve } from "node:path";

const arguments_ = process.argv.slice(2);
const input = await readInput();
const key = process.env.KEEPR_CREDENTIAL_BOUNDARY_ATTESTATION_KEY;

if (typeof key !== "string" || key.length < 32) {
  process.exitCode = 2;
} else {
  const provider = await runProvider(arguments_, input);
  const facts = provider.document?.facts;
  if (
    provider.code !== 0 ||
    provider.document?.ok !== true ||
    !exactProviderFacts(arguments_, facts) ||
    !safeDigestEqual(provider.document.plan_digest, arguments_[2]) ||
    !(await verifyInstalledConsumer(arguments_, facts, input, key))
  ) {
    process.exitCode = 9;
  } else {
    const encoded = Buffer.from(JSON.stringify(facts)).toString(
      "base64url",
    );
    const signature = createHmac("sha256", key)
      .update(encoded)
      .digest("hex");
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        plan_id: arguments_[1],
        plan_digest: arguments_[2],
        boundary_attestation: `v1.${encoded}.${signature}`,
      })}\n`,
    );
  }
}

async function verifyInstalledConsumer(
  arguments_,
  facts,
  input,
  key,
) {
  const credentialClass = arguments_[4];
  if (credentialClass === "github_deployment_token") {
    const expectedEvidence =
      `KEEPR_CREDENTIAL_PROOF plan_digest=${arguments_[2]} plan_nonce=${arguments_[3]} ` +
      `head_sha=${facts.consumer_proof_head_sha} token_id=${arguments_[17]} ` +
      `actor=${facts.consumer_proof_actor} slot=replacement`;
    const replacementMatches =
      facts.consumer_proof_contract ===
        "github-actions-installed-secret-probe@1" &&
      typeof facts.consumer_proof_id === "string" &&
      /^[0-9]{1,20}$/.test(facts.consumer_proof_id) &&
      /^[0-9a-f]{40}$/.test(facts.consumer_proof_head_sha ?? "") &&
      /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(
        facts.consumer_proof_actor ?? "",
      ) &&
      safeFingerprintEqual(
        facts.consumer_proof_digest,
        `sha256:${createHash("sha256")
          .update(expectedEvidence)
          .digest("hex")}`,
      );
    if (!replacementMatches) return false;
    if (arguments_[0] !== "verify") return true;
    const expectedOldEvidence =
      `KEEPR_CREDENTIAL_PROOF plan_digest=${arguments_[2]} plan_nonce=${arguments_[3]} ` +
      `head_sha=${facts.old_consumer_proof_head_sha} token_id=${arguments_[16]} ` +
      `actor=${facts.old_consumer_proof_actor} slot=active`;
    return (
      facts.old_consumer_proof_contract ===
        "github-actions-installed-secret-probe@1" &&
      /^[0-9]{1,20}$/.test(facts.old_consumer_proof_id ?? "") &&
      /^[0-9a-f]{40}$/.test(
        facts.old_consumer_proof_head_sha ?? "",
      ) &&
      /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(
        facts.old_consumer_proof_actor ?? "",
      ) &&
      safeFingerprintEqual(
        facts.old_consumer_proof_digest,
        `sha256:${createHash("sha256")
          .update(expectedOldEvidence)
          .digest("hex")}`,
      )
    );
  }
  let secrets;
  try {
    secrets = JSON.parse(input);
  } catch {
    return false;
  }
  const accountId = arguments_[5];
  let response;
  try {
    response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
      {
        headers: {
          authorization: `Bearer ${secrets.management_credential}`,
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch {
    return false;
  }
  if (!response.ok) return false;
  const subdomainDocument = await response.json();
  if (
    subdomainDocument?.success !== true ||
    typeof subdomainDocument.result?.subdomain !== "string" ||
    !/^[a-z0-9-]{1,63}$/.test(subdomainDocument.result.subdomain)
  ) {
    return false;
  }
  const worker =
    credentialClass === "api_bearer_key"
      ? "card-keepr-api"
      : "card-keepr-ingestion";
  const probes = [
    {
      slot: "replacement",
      status: "usable",
      fingerprint: arguments_[15],
    },
    ...(arguments_[0] === "verify"
      ? [
          {
            slot: "active",
            status: "usable",
            fingerprint: arguments_[14],
          },
        ]
      : []),
    ...(arguments_[0] === "revoke"
      ? [
          {
            slot: "active",
            status: "unusable",
            fingerprint: arguments_[14],
          },
        ]
      : []),
  ];
  for (const requested of probes) {
    const body = JSON.stringify({
      credential_class: credentialClass,
      expected_fingerprint: requested.fingerprint,
      challenge: arguments_[2],
      slot: requested.slot,
      expected_status: requested.status,
    });
    const signature = createHmac("sha256", key)
      .update(body)
      .digest("hex");
    try {
      response = await fetch(
        `https://${worker}.${subdomainDocument.result.subdomain}.workers.dev/v1/credential-consumer-proof`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-keepr-boundary-signature": signature,
          },
          body,
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch {
      return false;
    }
    if (!response.ok) return false;
    const proof = await response.json();
    const expectedProof = createHmac("sha256", key)
      .update(
        `${credentialClass}\0${requested.fingerprint}\0${arguments_[2]}\0${requested.slot}\0${requested.status}`,
      )
      .digest("hex");
    if (
      proof?.contract !== "card-keepr-credential-consumer-proof@1" ||
      proof.credential_class !== credentialClass ||
      !safeFingerprintEqual(
        proof.expected_fingerprint,
        requested.fingerprint,
      ) ||
      !safeDigestEqual(proof.challenge, arguments_[2]) ||
      proof.slot !== requested.slot ||
      proof.status !== requested.status ||
      !safeDigestEqual(proof.proof, expectedProof)
    ) {
      return false;
    }
  }
  return true;
}

async function runProvider(arguments_, input_) {
  const provider = resolve("cli/provider-credential-boundary.mjs");
  const environment = { ...process.env };
  delete environment.KEEPR_CREDENTIAL_BOUNDARY_ATTESTATION_KEY;
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [provider, ...arguments_], {
      cwd: process.cwd(),
      env: environment,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 32_768) child.kill();
    });
    child.once("error", () => {
      resolveRun({ code: 9, document: null });
    });
    child.once("exit", (code) => {
      let document = null;
      try {
        document = JSON.parse(stdout);
      } catch {
        // A provider failure is intentionally reduced to one stable result.
      }
      resolveRun({ code: code ?? 9, document });
    });
    child.stdin.end(input_);
  });
}

function exactProviderFacts(arguments_, facts) {
  if (facts === null || typeof facts !== "object") return false;
  const [
    action,
    planId,
    planDigest,
    planNonce,
    credentialClass,
    cloudflareAccountId,
    resourceIdentity,
    ,
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
  ] = arguments_;
  return (
    facts.version === 1 &&
    facts.plan_id === planId &&
    safeDigestEqual(facts.plan_digest, planDigest) &&
    safeDigestEqual(facts.plan_nonce, planNonce) &&
    facts.action === action &&
    facts.credential_class === credentialClass &&
    facts.cloudflare_account_id === cloudflareAccountId &&
    facts.resource_identity === resourceIdentity &&
    facts.verification_target === verificationTarget &&
    facts.production_target_identity === productionTargetIdentity &&
    facts.required_permission === requiredPermission &&
    facts.consumer_installation_identity ===
      consumerInstallationIdentity &&
    facts.consumer_installation_id ===
      consumerInstallationIdentity &&
    facts.execution_mode === executionMode &&
    facts.execution_attempt ===
      Number.parseInt(executionAttempt, 10) &&
    safeFingerprintEqual(facts.old_fingerprint, oldFingerprint) &&
    safeFingerprintEqual(
      facts.replacement_fingerprint,
      replacementFingerprint,
    ) &&
    safeFingerprintEqual(
      facts.installed_fingerprint,
      replacementFingerprint,
    ) &&
    facts.old_issuer_credential_id === oldIssuerCredentialId &&
    facts.replacement_issuer_credential_id ===
      replacementIssuerCredentialId &&
    facts.management_credential_id === managementCredentialId &&
    facts.github_management_credential_id ===
      githubManagementCredentialId &&
    safeFingerprintEqual(
      facts.github_management_credential_fingerprint,
      githubManagementCredentialFingerprint,
    ) &&
    facts.github_management_required_permission ===
      githubManagementRequiredPermission &&
    /^sha256:[0-9a-f]{64}$/.test(
      facts.scope_evidence_digest ?? "",
    ) &&
    typeof facts.observed_at === "string"
  );
}

function safeDigestEqual(left, right) {
  return safeHexEqual(left, right, "");
}

function safeFingerprintEqual(left, right) {
  return safeHexEqual(left, right, "sha256:");
}

function safeHexEqual(left, right, prefix) {
  const pattern =
    prefix === "" ? /^[0-9a-f]{64}$/ : /^sha256:[0-9a-f]{64}$/;
  const leftValid = pattern.test(left ?? "");
  const rightValid = pattern.test(right ?? "");
  const leftBytes = leftValid
    ? Buffer.from(left.slice(prefix.length), "hex")
    : Buffer.alloc(32);
  const rightBytes = rightValid
    ? Buffer.from(right.slice(prefix.length), "hex")
    : Buffer.alloc(32);
  return (
    leftValid &&
    rightValid &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

async function readInput() {
  let value = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    value += chunk;
    if (value.length > 32_768) process.exit(2);
  }
  return value;
}
