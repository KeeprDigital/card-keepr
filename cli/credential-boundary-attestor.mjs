import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  credentialClassDefinitions,
} from "../src/credentials/credential-catalogue.mjs";

const input = await readInput();
let consumerJournal = null;
const consumerProofDocuments = [];
const planEnvelope = readDescriptorJson(3);
const plan =
  planEnvelope?.contract ===
    "card-keepr-credential-boundary-plan@1" &&
  planEnvelope.plan !== null &&
  typeof planEnvelope.plan === "object"
    ? planEnvelope.plan
    : null;

if (plan === null) {
  process.exitCode = 2;
} else {
  const provider = await runProvider(plan, input);
  const facts = provider.document?.facts;
  if (
    provider.code !== 0 ||
    provider.document?.ok !== true ||
    !exactProviderFacts(plan, facts) ||
    !safeDigestEqual(
      provider.document.plan_digest,
      plan.plan_digest,
    ) ||
    !(await verifyInstalledConsumer(plan, facts, input))
  ) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      plan_id: plan.id,
      plan_digest: plan.plan_digest,
      journal: mergeMutationJournals(
        provider.document?.journal,
        consumerJournal,
      ),
    })}\n`);
    process.exitCode = 9;
  } else {
    const boundaryAttestation =
      await requestServerAttestation(plan);
    if (boundaryAttestation === null) {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        plan_id: plan.id,
        plan_digest: plan.plan_digest,
        journal: mergeMutationJournals(
          provider.document?.journal,
          consumerJournal,
        ),
      })}\n`);
      process.exitCode = 9;
    } else {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          plan_id: plan.id,
          plan_digest: plan.plan_digest,
          boundary_attestation: boundaryAttestation,
        })}\n`,
      );
    }
  }
}

function validMutationJournal(value) {
  if (
    value?.contract !== "card-keepr-provider-mutation-journal@1" ||
    typeof value.mutation_started !== "boolean" ||
    !Array.isArray(value.steps) ||
    !value.steps.every(
      (step) => typeof step === "string" && step.length <= 256,
    )
  ) {
    return {
      contract: "card-keepr-provider-mutation-journal@1",
      mutation_started: true,
      steps: ["provider-result-unavailable"],
    };
  }
  return value;
}

function mergeMutationJournals(providerJournal, proofJournal) {
  const provider = validMutationJournal(providerJournal);
  const proof =
    proofJournal === null
      ? null
      : validMutationJournal(proofJournal);
  return {
    contract: "card-keepr-provider-mutation-journal@1",
    mutation_started:
      provider.mutation_started ||
      (proof?.mutation_started ?? false),
    steps: [
      ...provider.steps,
      ...(proof?.steps ?? []),
    ],
  };
}

async function verifyInstalledConsumer(
  plan,
  facts,
  input,
) {
  const credentialClass = plan.credential_class;
  if (credentialClass === "github_deployment_token") {
    const replacementWorkflowSlot =
      plan.replacement_consumer_slot === "a"
        ? "active"
        : "replacement";
    const expectedEvidence =
      `credential-boundary-probe-${replacementWorkflowSlot}-${plan.replacement_issuer_credential_id}-usable-${plan.replacement_fingerprint}-${plan.plan_digest}` +
      `\0${facts.consumer_proof_head_sha}\0${facts.consumer_proof_id}\0${facts.consumer_proof_actor}`;
    const replacementMatches =
      facts.consumer_proof_contract ===
        "github-actions-installed-secret-probe@2" &&
      typeof facts.consumer_proof_id === "string" &&
      /^[0-9]{1,20}$/.test(facts.consumer_proof_id) &&
      /^[0-9a-f]{40}$/.test(facts.consumer_proof_head_sha ?? "") &&
      safeBotActor(facts.consumer_proof_actor) &&
      safeFingerprintEqual(
        facts.consumer_proof_digest,
        `sha256:${createHash("sha256")
          .update(expectedEvidence)
          .digest("hex")}`,
      );
    if (!replacementMatches) return false;
    if (!["verify", "revoke"].includes(plan.action)) return true;
    const oldWorkflowSlot =
      plan.old_consumer_slot === "a" ? "active" : "replacement";
    const expectedOldEvidence =
      `credential-boundary-probe-${oldWorkflowSlot}-${plan.old_issuer_credential_id}-${plan.action === "revoke" ? "unusable" : "usable"}-${plan.old_fingerprint}-${plan.plan_digest}` +
      `\0${facts.old_consumer_proof_head_sha}\0${facts.old_consumer_proof_id}\0${facts.old_consumer_proof_actor}`;
    return (
      facts.old_consumer_proof_contract ===
        "github-actions-installed-secret-probe@2" &&
      /^[0-9]{1,20}$/.test(facts.old_consumer_proof_id ?? "") &&
      /^[0-9a-f]{40}$/.test(
        facts.old_consumer_proof_head_sha ?? "",
      ) &&
      safeBotActor(facts.old_consumer_proof_actor) &&
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
  const accountId = plan.cloudflare_account_id;
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
    credentialClassDefinitions[credentialClass]?.consumer_worker_name;
  if (typeof worker !== "string") return false;
  if (!Array.isArray(plan.consumer_proof_requests)) return false;
  for (const requested of plan.consumer_proof_requests) {
    const body = JSON.stringify({
      credential_class: credentialClass,
      expected_fingerprint: requested.expected_fingerprint,
      challenge: plan.plan_digest,
      slot: requested.slot,
      expected_status: requested.expected_status,
      request_token: requested.request_token,
    });
    try {
      response = await fetch(
        `https://${worker}.${subdomainDocument.result.subdomain}.workers.dev/v1/credential-consumer-proof`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body,
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch {
      return false;
    }
    if (!response.ok) {
      try {
        const failure = await response.json();
        consumerJournal = validMutationJournal(failure?.journal);
      } catch {
        consumerJournal = validMutationJournal(null);
      }
      return false;
    }
    const proof = await response.json();
    if (
      proof?.contract !== "card-keepr-credential-consumer-proof@1" ||
      proof.credential_class !== credentialClass ||
      !safeFingerprintEqual(
        proof.expected_fingerprint,
        requested.expected_fingerprint,
      ) ||
      !safeDigestEqual(proof.challenge, plan.plan_digest) ||
      proof.slot !== requested.slot ||
      proof.status !== requested.expected_status ||
      !/^[0-9a-f]{64}$/.test(proof.proof ?? "")
    ) {
      return false;
    }
    consumerProofDocuments.push(proof);
  }
  return true;
}

function safeBotActor(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,99})\[bot\]$/.test(value)
  );
}

async function requestServerAttestation(plan) {
  let url;
  try {
    url = new URL(plan.execution_validation_url);
    url.pathname =
      `/v1/credential-rotation-plans/${encodeURIComponent(plan.id)}` +
      "/boundary-attestation";
  } catch {
    return null;
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        plan_digest: plan.plan_digest,
        execution_attempt: plan.execution_attempt,
        execution_capability: plan.execution_capability,
        consumer_proofs: consumerProofDocuments,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const document = await response.json();
    return document?.contract ===
        "card-keepr-boundary-attestation@1" &&
      typeof document.boundary_attestation === "string"
      ? document.boundary_attestation
      : null;
  } catch {
    return null;
  }
}

async function runProvider(plan, input_) {
  const provider = fileURLToPath(
    new URL("./provider-credential-boundary.mjs", import.meta.url),
  );
  const environment = Object.fromEntries(
    Object.entries({
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CI: "1",
    }).filter(([, value]) => typeof value === "string"),
  );
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [provider], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
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
    let secrets;
    try {
      secrets = JSON.parse(input_);
    } catch {
      secrets = null;
    }
    child.stdin.end(JSON.stringify({
      contract: "card-keepr-provider-request@1",
      plan,
      secrets,
    }));
  });
}

function exactProviderFacts(plan, facts) {
  if (facts === null || typeof facts !== "object") return false;
  return (
    facts.version === 1 &&
    facts.plan_id === plan.id &&
    safeDigestEqual(facts.plan_digest, plan.plan_digest) &&
    safeDigestEqual(facts.plan_nonce, plan.plan_nonce) &&
    facts.action === plan.action &&
    facts.credential_class === plan.credential_class &&
    facts.cloudflare_account_id === plan.cloudflare_account_id &&
    facts.resource_identity === plan.resource_identity &&
    facts.verification_target === plan.verification_target &&
    facts.production_target_identity ===
      plan.production_target_identity &&
    facts.required_permission === plan.required_permission &&
    facts.cloudflare_management_required_permissions ===
      plan.cloudflare_management_required_permissions &&
    facts.consumer_installation_identity ===
      plan.consumer_installation_identity &&
    facts.consumer_installation_id ===
      plan.consumer_installation_identity &&
    facts.execution_mode === plan.execution_mode &&
    facts.execution_attempt === plan.execution_attempt &&
    safeFingerprintEqual(
      facts.old_fingerprint,
      plan.old_fingerprint,
    ) &&
    safeFingerprintEqual(
      facts.replacement_fingerprint,
      plan.replacement_fingerprint,
    ) &&
    safeFingerprintEqual(
      facts.installed_fingerprint,
      plan.replacement_fingerprint,
    ) &&
    facts.old_issuer_credential_id ===
      plan.old_issuer_credential_id &&
    facts.replacement_issuer_credential_id ===
      plan.replacement_issuer_credential_id &&
    facts.management_credential_id ===
      plan.management_credential_id &&
    facts.github_management_credential_id ===
      plan.github_management_credential_id &&
    safeFingerprintEqual(
      facts.github_management_credential_fingerprint,
      plan.github_management_credential_fingerprint,
    ) &&
    facts.github_management_required_permission ===
      plan.github_management_required_permission &&
    facts.old_consumer_slot === plan.old_consumer_slot &&
    facts.replacement_consumer_slot ===
      plan.replacement_consumer_slot &&
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

function readDescriptorJson(descriptor) {
  try {
    const value = readFileSync(descriptor, "utf8");
    return value.length <= 32_768 ? JSON.parse(value) : null;
  } catch {
    return null;
  }
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
