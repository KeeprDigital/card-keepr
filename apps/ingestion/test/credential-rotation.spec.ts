import { env, exports } from "cloudflare:workers";
import {
  applyD1Migrations,
  type D1Migration,
} from "cloudflare:test";
import { afterEach, beforeEach, expect, test } from "vitest";

declare global {
  interface __BaseEnv_Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}

const accountId = "0123456789abcdef0123456789abcdef";
const catalogueDatabaseId =
  "00000000-0000-0000-0000-000000000001";
let requestAddress = 1;

beforeEach(async () => {
  await applyD1Migrations(env.CATALOGUE_DB, env.TEST_MIGRATIONS);
  await env.CATALOGUE_DB.prepare(
    "DELETE FROM credential_rotation_plans",
  ).run();
  await env.CATALOGUE_DB.prepare(
    "DELETE FROM credential_rotations",
  ).run();
  await env.CATALOGUE_DB.prepare(
    `UPDATE operation_state
     SET recovery_health = 'healthy', active_ingestion_run_id = NULL,
         credential_rotation_generation = 0
     WHERE singleton = 1`,
  ).run();
});

afterEach(async () => {
  await env.CATALOGUE_DB.prepare(
    "DELETE FROM credential_rotation_plans",
  ).run();
  await env.CATALOGUE_DB.prepare(
    "DELETE FROM credential_rotations",
  ).run();
  await env.CATALOGUE_DB.prepare(
    `UPDATE operation_state
     SET recovery_health = 'healthy', active_ingestion_run_id = NULL,
         credential_rotation_generation = 0
     WHERE singleton = 1`,
  ).run();
});

test("recovery rejects reservation and only a signed exact attestation atomically finalizes the immutable plan", async () => {
  const reservedAt = "2026-07-29T00:00:00.000Z";
  const executionStartedAt = "2026-07-29T00:04:00.000Z";
  const finalizedAt = "2026-07-29T00:10:00.000Z";
  const request = await planInput("install", "api_bearer_key", 0);
  await env.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET recovery_health = 'blocked' WHERE singleton = 1",
  ).run();
  const rejected = await administrationRequest(
    "/v1/credential-rotation-plans",
    "POST",
    request,
    undefined,
    reservedAt,
  );
  expect(rejected.status).toBe(409);
  await expect(rejected.json()).resolves.toMatchObject({
    code: "recovery_in_progress",
  });

  await env.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET recovery_health = 'healthy' WHERE singleton = 1",
  ).run();
  const plan = await reserve(request, reservedAt);
  expect(plan).toMatchObject({
    contract: "card-keepr-credential-rotation-plan@1",
    action: "install",
    status: "reserved",
    expected_catalogue_revision_id: "catrev_spine_000",
    expected_state_generation: 0,
  });
  await execute(plan, executionStartedAt);
  const released = await administrationRequest(
    `/v1/credential-rotation-plans/${plan.id}/execution-failure`,
    "POST",
    { plan_digest: plan.plan_digest },
    undefined,
    "2026-07-29T00:04:30.000Z",
  );
  expect(released.status).toBe(200);
  Object.assign(plan, await released.json<PlanDocument>());
  expect(plan).toMatchObject({
    status: "reserved",
    execution_attempt: 0,
    execution_mode: null,
  });
  await execute(plan, "2026-07-29T00:04:45.000Z");
  await execute(plan, "2026-07-29T00:05:00.000Z");
  expect(plan).toMatchObject({
    execution_attempt: 2,
    execution_mode: "reconciliation",
  });

  const fabricated = await finalize(plan, `v1.${base64Url("{}")}.${"0".repeat(64)}`);
  expect(fabricated.status).toBe(409);
  await expect(fabricated.json()).resolves.toMatchObject({
    code: "invalid_boundary_attestation",
  });

  const attestation = await signedAttestation(
    plan,
    "usable",
    finalizedAt,
  );
  const finalized = await finalize(
    plan,
    attestation,
    finalizedAt,
  );
  expect(finalized.status).toBe(200);
  await expect(finalized.json()).resolves.toMatchObject({
    id: request.rotation_id,
    state: "replacement_installed",
    operation_code: "ok",
  });
  const replay = await finalize(plan, attestation);
  expect(replay.status).toBe(200);
  await expect(replay.json()).resolves.toMatchObject({
    operation_code: "idempotent_replay",
  });
  const planRetry = await administrationRequest(
    "/v1/credential-rotation-plans",
    "POST",
    request,
  );
  expect(planRetry.status).toBe(201);
  await expect(planRetry.json()).resolves.toMatchObject({
    id: plan.id,
    plan_digest: plan.plan_digest,
    status: "finalized",
  });

  const tampered = await finalize(
    plan,
    `${attestation.slice(0, -1)}${attestation.endsWith("0") ? "1" : "0"}`,
  );
  expect(tampered.status).toBe(409);
  await expect(tampered.json()).resolves.toMatchObject({
    code: "credential_attestation_replayed",
  });
});

test("the durable public sequence is installed then verified then issuer-old revoked", async () => {
  const install = await planInput(
    "install",
    "d1_export_token",
    0,
    "credrot_export_lifecycle",
  );
  const installedPlan = await reserve(install);
  await execute(installedPlan);
  const installed = await finalize(
    installedPlan,
    await signedAttestation(installedPlan, "usable"),
  );
  await expect(installed.json()).resolves.toMatchObject({
    state: "replacement_installed",
  });

  const verify = await planInput(
    "verify",
    "d1_export_token",
    1,
    install.rotation_id,
    install.old_fingerprint,
    install.replacement_fingerprint,
  );
  const verifiedPlan = await reserve(verify);
  await execute(verifiedPlan);
  const verified = await finalize(
    verifiedPlan,
    await signedAttestation(verifiedPlan, "usable"),
  );
  await expect(verified.json()).resolves.toMatchObject({
    state: "replacement_verified",
  });

  const revoke = await planInput(
    "revoke",
    "d1_export_token",
    2,
    install.rotation_id,
    install.old_fingerprint,
    install.replacement_fingerprint,
  );
  const revokedPlan = await reserve(revoke);
  await execute(revokedPlan);
  const revoked = await finalize(
    revokedPlan,
    await signedAttestation(revokedPlan, "unusable"),
  );
  await expect(revoked.json()).resolves.toMatchObject({
    state: "old_revoked",
  });
});

test("all five classes resolve distinct exact account, resource, boundary, target, and permission plans", async () => {
  for (const credentialClass of [
    "api_bearer_key",
    "ingestion_admin_key",
    "d1_export_token",
    "d1_verification_token",
    "github_deployment_token",
  ] as const) {
    const request = await planInput(
      "install",
      credentialClass,
      0,
      `credrot_${credentialClass}`,
    );
    const plan = await reserve(request);
    expect(plan).toMatchObject({
      credential_class: credentialClass,
      cloudflare_account_id: accountId,
      ...identities[credentialClass],
    });
  }
});

test("the signed ingestion consumer challenge proves the exact installed administration value and rejects wrong class", async () => {
  const replacement = "vitest-administration-key-replacement-slot";
  await env.CATALOGUE_DB.prepare(
    `INSERT INTO credential_rotations (
      id, credential_class, state, environment, resource_identity,
      owning_boundary, verification_target, old_secret_hash,
      replacement_secret_hash, installed_at, install_idempotency_key,
      install_request_digest, install_receipt
    ) VALUES (
      'credrot_admin_consumer_proof', 'ingestion_admin_key',
      'replacement_installed', 'production',
      'cloudflare-account:0123456789abcdef0123456789abcdef:worker:card-keepr-ingestion',
      'ingestion_worker',
      'cloudflare-account:0123456789abcdef0123456789abcdef:worker:card-keepr-ingestion:health',
      ?, ?, '2026-07-29T00:00:00.000Z',
      'admin-consumer-proof-install', ?, 'signed-boundary-receipt'
    )`,
  )
    .bind(
      (await fingerprint("old-administration-value")).slice(7),
      (await fingerprint(replacement)).slice(7),
      "c".repeat(64),
    )
    .run();
  const challenge = "d".repeat(64);
  const accepted = await consumerProofRequest(
    "ingestion_admin_key",
    await fingerprint(replacement),
    challenge,
  );
  expect(accepted.status).toBe(200);
  const wrongClass = await consumerProofRequest(
    "github_deployment_token",
    await fingerprint(replacement),
    challenge,
  );
  expect(wrongClass.status).toBe(409);
  await expect(wrongClass.json()).resolves.toMatchObject({
    code: "identity_conflict",
  });
});

test("stale identity, wrong class, aliased management, and stale claim snapshot fail before execution", async () => {
  const request = await planInput("install", "api_bearer_key", 0);
  const stale = await administrationRequest(
    "/v1/credential-rotation-plans",
    "POST",
    {
      ...request,
      verification_target: "cloudflare-account:wrong:worker:wrong",
    },
  );
  expect(stale.status).toBe(409);
  await expect(stale.json()).resolves.toMatchObject({
    code: "identity_conflict",
  });

  const wrongClass = await administrationRequest(
    "/v1/credential-rotation-plans",
    "POST",
    {
      ...request,
      credential_class: "ingestion_admin_key",
    },
  );
  expect(wrongClass.status).toBe(409);
  await expect(wrongClass.json()).resolves.toMatchObject({
    code: "identity_conflict",
  });

  const aliasedManagement = await administrationRequest(
    "/v1/credential-rotation-plans",
    "POST",
    {
      ...request,
      management_credential_id:
        request.old_issuer_credential_id,
    },
  );
  expect(aliasedManagement.status).toBe(422);
  await expect(aliasedManagement.json()).resolves.toMatchObject({
    code: "invalid_provider_credential_identity",
  });

  const claimPlan = await reserve({
    ...request,
    rotation_id: "credrot_claim_snapshot",
    idempotency_key: "claim-snapshot-001",
  });
  await env.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET recovery_health = 'blocked' WHERE singleton = 1",
  ).run();
  const blockedClaim = await executionResponse(claimPlan);
  expect(blockedClaim.status).toBe(409);
  await expect(blockedClaim.json()).resolves.toMatchObject({
    code: "recovery_in_progress",
  });
  await env.CATALOGUE_DB.prepare(
    `UPDATE operation_state
     SET recovery_health = 'healthy',
         credential_rotation_generation = 1
     WHERE singleton = 1`,
  ).run();
  const staleClaim = await executionResponse(claimPlan);
  expect(staleClaim.status).toBe(409);
  await expect(staleClaim.json()).resolves.toMatchObject({
    code: "credential_state_generation_mismatch",
  });
  await env.CATALOGUE_DB.prepare(
    `UPDATE operation_state
     SET credential_rotation_generation = 0
     WHERE singleton = 1`,
  ).run();

});

const identities = {
  api_bearer_key: {
    resource_identity:
      `cloudflare-account:${accountId}:worker:card-keepr-api`,
    owning_boundary: "api_worker",
    verification_target:
      `cloudflare-account:${accountId}:worker:card-keepr-api:health`,
    required_permission: "workers-secret:api-traffic",
  },
  ingestion_admin_key: {
    resource_identity:
      `cloudflare-account:${accountId}:worker:card-keepr-ingestion`,
    owning_boundary: "ingestion_worker",
    verification_target:
      `cloudflare-account:${accountId}:worker:card-keepr-ingestion:health`,
    required_permission: "workers-secret:administration",
  },
  d1_export_token: {
    resource_identity:
      `cloudflare-account:${accountId}:d1:${catalogueDatabaseId}`,
    owning_boundary: "d1_export_operation",
    verification_target:
      `cloudflare-account:${accountId}:d1:${catalogueDatabaseId}:export-schema`,
    required_permission: "D1 Read",
  },
  d1_verification_token: {
    resource_identity:
      `cloudflare-account:${accountId}:d1:00000000-0000-0000-0000-000000000002`,
    owning_boundary: "disposable_verification",
    verification_target:
      `cloudflare-account:${accountId}:d1:00000000-0000-0000-0000-000000000002:write-rollback-probe`,
    required_permission: "D1 Edit",
  },
  github_deployment_token: {
    resource_identity:
      "github-repository:repository-KeeprDigital-card-keepr:environment:production:workflow:card-keepr-production-release",
    owning_boundary: "production_release_workflow",
    verification_target:
      "github-repository:repository-KeeprDigital-card-keepr:environment:production:workflow:card-keepr-production-release:deployment-scope-introspection",
    required_permission: "Workers Scripts Write",
  },
} as const;

type CredentialClass = keyof typeof identities;
type PlanDocument = Record<string, unknown> & {
  id: string;
  action: "install" | "verify" | "revoke";
  plan_digest: string;
  plan_nonce: string;
  credential_class: CredentialClass;
  cloudflare_account_id: string;
  resource_identity: string;
  verification_target: string;
  required_permission: string;
  consumer_installation_identity: string;
  execution_attempt: number;
  execution_mode: "mutation" | "reconciliation" | null;
  old_fingerprint: string;
  replacement_fingerprint: string;
};

async function planInput(
  action: "install" | "verify" | "revoke",
  credentialClass: CredentialClass,
  generation: number,
  rotationId = `credrot_${credentialClass}_plan`,
  oldFingerprint?: string,
  replacementFingerprint?: string,
): Promise<Record<string, unknown> & {
  rotation_id: string;
  old_fingerprint: string;
  replacement_fingerprint: string;
}> {
  return {
    action,
    rotation_id: rotationId,
    credential_class: credentialClass,
    environment: "production",
    cloudflare_account_id: accountId,
    resource_identity: identities[credentialClass].resource_identity,
    owning_boundary: identities[credentialClass].owning_boundary,
    verification_target:
      identities[credentialClass].verification_target,
    expected_catalogue_revision_id: "catrev_spine_000",
    expected_state_generation: generation,
    old_fingerprint:
      oldFingerprint ??
      (await fingerprint(`old-${credentialClass}`)),
    replacement_fingerprint:
      replacementFingerprint ??
      (await fingerprint(`replacement-${credentialClass}`)),
    old_issuer_credential_id: "provider-token:old-credential-id",
    replacement_issuer_credential_id:
      "provider-token:replacement-credential-id",
    management_credential_id: "provider-token:management-id",
    idempotency_key: `${action}-${credentialClass}-${generation}`,
  };
}

async function reserve(
  request: Record<string, unknown>,
  observedAt?: string,
): Promise<PlanDocument> {
  const response = await administrationRequest(
    "/v1/credential-rotation-plans",
    "POST",
    request,
    undefined,
    observedAt,
  );
  expect(response.status).toBe(201);
  return response.json<PlanDocument>();
}

function finalize(
  plan: PlanDocument,
  attestation: string,
  observedAt?: string,
): Promise<Response> {
  return administrationRequest(
    `/v1/credential-rotation-plans/${plan.id}/finalization`,
    "POST",
    {
      plan_digest: plan.plan_digest,
      boundary_attestation: attestation,
    },
    undefined,
    observedAt,
  );
}

async function execute(
  plan: PlanDocument,
  observedAt?: string,
): Promise<void> {
  const response = await executionResponse(plan, observedAt);
  expect(response.status).toBe(200);
  const document = await response.json<PlanDocument>();
  expect(document).toMatchObject({
    status: "executing",
  });
  Object.assign(plan, document);
}

function executionResponse(
  plan: PlanDocument,
  observedAt?: string,
): Promise<Response> {
  return administrationRequest(
    `/v1/credential-rotation-plans/${plan.id}/execution`,
    "POST",
    { plan_digest: plan.plan_digest },
    undefined,
    observedAt,
  );
}

async function signedAttestation(
  plan: PlanDocument,
  oldStatus: "usable" | "unusable",
  observedAt = new Date().toISOString(),
): Promise<string> {
  const payload = {
    version: 1,
    plan_id: plan.id,
    plan_digest: plan.plan_digest,
    plan_nonce: plan.plan_nonce,
    action: plan.action,
    credential_class: plan.credential_class,
    cloudflare_account_id: plan.cloudflare_account_id,
    resource_identity: plan.resource_identity,
    verification_target: plan.verification_target,
    required_permission: plan.required_permission,
    consumer_installation_identity:
      plan.consumer_installation_identity,
    old_fingerprint: plan.old_fingerprint,
    replacement_fingerprint: plan.replacement_fingerprint,
    installed_fingerprint: plan.replacement_fingerprint,
    old_issuer_credential_id: "provider-token:old-credential-id",
    replacement_issuer_credential_id:
      "provider-token:replacement-credential-id",
    management_credential_id: "provider-token:management-id",
    consumer_installation_id:
      plan.consumer_installation_identity,
    scope_evidence_digest: `sha256:${"a".repeat(64)}`,
    old_credential_status: oldStatus,
    replacement_credential_status: "usable",
    observed_at: observedAt,
    execution_attempt: plan.execution_attempt,
    execution_mode: plan.execution_mode,
  };
  const encoded = base64Url(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("vitest-boundary-attestation-key"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(encoded),
  );
  const hex = Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `v1.${encoded}.${hex}`;
}

function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function administrationRequest(
  pathname: string,
  method: string,
  body?: Record<string, unknown>,
  key = "vitest-administration-key",
  observedAt?: string,
): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://card-keepr.invalid${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        "cf-connecting-ip": `192.0.2.${requestAddress++}`,
        ...(observedAt === undefined
          ? {}
          : { "x-keepr-test-now": observedAt }),
        ...(body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function consumerProofRequest(
  credentialClass: string,
  expectedFingerprint: string,
  challenge: string,
): Promise<Response> {
  const body = JSON.stringify({
    credential_class: credentialClass,
    expected_fingerprint: expectedFingerprint,
    challenge,
  });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("vitest-boundary-attestation-key"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  return exports.default.fetch(
    new Request(
      "https://card-keepr.invalid/v1/credential-consumer-proof",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-keepr-boundary-signature": Array.from(
            new Uint8Array(signature),
          )
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join(""),
        },
        body,
      },
    ),
  );
}

async function fingerprint(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
