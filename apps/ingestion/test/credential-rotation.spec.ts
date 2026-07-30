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
  const finalizedAt = "2026-07-29T00:16:00.000Z";
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
  const blockedIngestion = await administrationRequest(
    "/v1/ingestion-runs",
    "POST",
    {
      fixture: "first-catalogue",
      selected_games: ["one-piece"],
      idempotency_key: "blocked-by-credential-execution",
    },
  );
  expect(blockedIngestion.status).toBe(409);
  await expect(blockedIngestion.json()).resolves.toMatchObject({
    code: "credential_execution_in_progress",
  });
  const wrongOwnerRelease = await administrationRequest(
    `/v1/credential-rotation-plans/${plan.id}/execution-failure`,
    "POST",
    {
      plan_digest: plan.plan_digest,
      execution_owner_token: "b".repeat(64),
      execution_attempt: plan.execution_attempt,
      mutation_started: false,
    },
    undefined,
    "2026-07-29T00:04:15.000Z",
  );
  expect(wrongOwnerRelease.status).toBe(409);
  await expect(wrongOwnerRelease.json()).resolves.toMatchObject({
    code: "illegal_rotation_transition",
  });
  const released = await administrationRequest(
    `/v1/credential-rotation-plans/${plan.id}/execution-failure`,
    "POST",
    {
      plan_digest: plan.plan_digest,
      execution_owner_token: "a".repeat(64),
      execution_attempt: plan.execution_attempt,
      mutation_started: false,
    },
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
  const conflictingOwner = await executionResponse(
    plan,
    "2026-07-29T00:05:00.000Z",
    "b".repeat(64),
  );
  expect(conflictingOwner.status).toBe(409);
  await execute(
    plan,
    "2026-07-29T00:15:00.000Z",
    "b".repeat(64),
  );
  expect(plan).toMatchObject({
    execution_attempt: 2,
    execution_mode: "reconciliation",
  });

  const fabricated = await finalize(plan, `v1.${base64Url("{}")}.${"0".repeat(64)}`);
  expect(fabricated.status).toBe(409);
  await expect(fabricated.json()).resolves.toMatchObject({
    code: "credential_provider_execution_required",
  });

  const synthetic = await locallySignedAttestation(
    plan,
    "usable",
    finalizedAt,
  );
  await consumeExecutionCapability(plan, finalizedAt);
  const skippedProvider = await finalize(
    plan,
    synthetic,
    finalizedAt,
  );
  expect(skippedProvider.status).toBe(409);
  await expect(skippedProvider.json()).resolves.toMatchObject({
    code: "credential_provider_execution_required",
  });
  const attestation = await signedAttestation(
    plan,
    "usable",
    finalizedAt,
    true,
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
  const health = await exports.default.fetch(
    new Request("https://card-keepr.invalid/health", {
      headers: { authorization: `Bearer ${replacement}` },
    }),
  );
  expect(health.status).toBe(200);
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

  const arbitraryApiSlot = await administrationRequest(
    "/v1/credential-rotation-plans",
    "POST",
    {
      ...request,
      old_issuer_credential_id: "worker-secret:arbitrary-old-slot",
      replacement_issuer_credential_id:
        "worker-secret:arbitrary-replacement-slot",
    },
  );
  expect(arbitraryApiSlot.status).toBe(409);
  await expect(arbitraryApiSlot.json()).resolves.toMatchObject({
    code: "identity_conflict",
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

  const targetDrift = await administrationRequest(
    "/v1/credential-rotation-plans",
    "POST",
    {
      ...request,
      rotation_id: "credrot_target_drift",
      idempotency_key: "target-drift-001",
      production_target_identity: "{}",
    },
  );
  expect(targetDrift.status).toBe(409);
  await expect(targetDrift.json()).resolves.toMatchObject({
    code: "identity_conflict",
  });

  const githubRequest = await planInput(
    "install",
    "github_deployment_token",
    0,
    "credrot_github_management_identity",
  );
  const missingGithubIdentity = await administrationRequest(
    "/v1/credential-rotation-plans",
    "POST",
    {
      ...githubRequest,
      github_management_credential_id: "not-applicable",
    },
  );
  expect(missingGithubIdentity.status).toBe(422);
  await expect(missingGithubIdentity.json()).resolves.toMatchObject({
    code: "invalid_github_management_identity",
  });
});

test("execution capabilities are plan-bound and consumed exactly once before provider work", async () => {
  const plan = await reserve(
    await planInput(
      "install",
      "d1_export_token",
      0,
      "credrot_execution_capability",
    ),
  );
  await execute(plan);
  expect(plan.execution_capability).toMatch(/^[0-9a-f]{64}$/);
  const path =
    `/v1/credential-rotation-plans/${plan.id}/execution-capability`;
  const wrong = await administrationRequest(
    path,
    "POST",
    {
      plan_digest: plan.plan_digest,
      execution_attempt: plan.execution_attempt,
      execution_capability: "0".repeat(64),
    },
  );
  expect(wrong.status).toBe(409);
  const accepted = await administrationRequest(
    path,
    "POST",
    {
      plan_digest: plan.plan_digest,
      execution_attempt: plan.execution_attempt,
      execution_capability: plan.execution_capability,
    },
  );
  expect(accepted.status).toBe(200);
  await expect(accepted.json()).resolves.toEqual({
    contract: "card-keepr-credential-execution-capability@1",
    consumed: true,
  });
  const replay = await administrationRequest(
    path,
    "POST",
    {
      plan_digest: plan.plan_digest,
      execution_attempt: plan.execution_attempt,
      execution_capability: plan.execution_capability,
    },
  );
  expect(replay.status).toBe(409);
});

test("an expired execution capability cannot be consumed or finalized", async () => {
  const plan = await reserve(
    await planInput(
      "install",
      "d1_export_token",
      0,
      "credrot_expired_execution_capability",
    ),
    "2026-07-29T00:00:00.000Z",
  );
  await execute(plan, "2026-07-29T00:01:00.000Z");
  const expired = await administrationRequest(
    `/v1/credential-rotation-plans/${plan.id}/execution-capability`,
    "POST",
    {
      plan_digest: plan.plan_digest,
      execution_attempt: plan.execution_attempt,
      execution_capability: plan.execution_capability,
    },
    undefined,
    "2026-07-29T00:12:00.000Z",
  );
  expect(expired.status).toBe(409);
  await expect(expired.json()).resolves.toMatchObject({
    code: "invalid_execution_capability",
  });
});

test("a failed D1 consumer proof reports unresolved cleanup mutation", async () => {
  const response = await consumerProofRequest(
    "d1_verification_token",
    await fingerprint(
      "vitest-d1-verification-token-replacement",
    ),
    "a".repeat(64),
  );
  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toMatchObject({
    code: "credential_capability_mismatch",
    journal: {
      contract: "card-keepr-provider-mutation-journal@1",
      mutation_started: true,
      steps: ["consumer-proof-cleanup:failed"],
    },
  });
});

test("API, administration, and provider credentials complete two A/B generations without reusing a live slot", async () => {
  for (const [classIndex, credentialClass] of ([
    "api_bearer_key",
    "ingestion_admin_key",
    "d1_export_token",
  ] as const).entries()) {
    const firstGeneration = classIndex * 6;
    const firstOld = await fingerprint(`generation-0-${credentialClass}`);
    const firstReplacement = await fingerprint(
      `generation-1-${credentialClass}`,
    );
    const firstIds = issuerSlots(credentialClass);
    const first = await completeRotationLifecycle({
      credentialClass,
      generation: firstGeneration,
      rotationId: `credrot_${credentialClass}_generation_1`,
      oldFingerprint: firstOld,
      replacementFingerprint: firstReplacement,
      oldIssuer: firstIds.a,
      replacementIssuer: firstIds.b,
    });
    expect(first).toMatchObject({
      state: "old_revoked",
      current_consumer_slot: "b",
    });

    const secondReplacement = await fingerprint(
      `generation-2-${credentialClass}`,
    );
    const second = await completeRotationLifecycle({
      credentialClass,
      generation: firstGeneration + 3,
      rotationId: `credrot_${credentialClass}_generation_2`,
      oldFingerprint: firstReplacement,
      replacementFingerprint: secondReplacement,
      oldIssuer: firstIds.b,
      replacementIssuer:
        credentialClass === "d1_export_token"
          ? "provider-token:generation-2-id"
          : firstIds.a,
    });
    expect(second).toMatchObject({
      state: "old_revoked",
      current_consumer_slot: "a",
    });
  }
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
      "github-repository:1313489088:installation:22222222:environment:33333333:workflow:44444444",
    owning_boundary: "production_release_workflow",
    verification_target:
      "github-repository:1313489088:installation:22222222:environment:33333333:workflow:44444444:deployment-scope-introspection",
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
  production_target_identity: string;
  required_permission: string;
  cloudflare_management_required_permissions: string;
  consumer_installation_identity: string;
  old_consumer_slot: "a" | "b";
  replacement_consumer_slot: "a" | "b";
  execution_attempt: number;
  execution_mode: "mutation" | "reconciliation" | null;
  execution_capability?: string;
  old_fingerprint: string;
  replacement_fingerprint: string;
  old_issuer_credential_id: string;
  replacement_issuer_credential_id: string;
  management_credential_id: string;
  github_management_credential_id: string;
  github_management_credential_fingerprint: string;
  github_management_required_permission: string;
};

function productionTargetIdentity(): string {
  return JSON.stringify({
    cloudflare_account_id: accountId,
    worker_scripts: ["card-keepr-api", "card-keepr-ingestion"],
    d1_databases: [
      catalogueDatabaseId,
      "00000000-0000-0000-0000-000000000002",
    ],
    r2_buckets: [
      "card-keepr-evidence",
      "card-keepr-printing-images",
      "card-keepr-catalogue-exports",
      "card-keepr-backups",
    ],
    workflows: [
      "card-keepr-evidence-ingestion",
      "card-keepr-evidence-host",
    ],
    github_repository_id: "1313489088",
    github_installation_id: "22222222",
    github_environment_id: "33333333",
    github_workflow_id: "44444444",
  });
}

function issuerSlots(credentialClass: CredentialClass): {
  a: string;
  b: string;
} {
  if (credentialClass === "api_bearer_key") {
    return {
      a: "wrangler:apps/api/wrangler.jsonc:API_BEARER_KEY",
      b: "wrangler:apps/api/wrangler.jsonc:API_BEARER_KEY_REPLACEMENT",
    };
  }
  if (credentialClass === "ingestion_admin_key") {
    return {
      a: "wrangler:apps/ingestion/wrangler.jsonc:ADMINISTRATION_KEY",
      b: "wrangler:apps/ingestion/wrangler.jsonc:ADMINISTRATION_KEY_REPLACEMENT",
    };
  }
  return {
    a: "provider-token:old-credential-id",
    b: "provider-token:replacement-credential-id",
  };
}

async function completeRotationLifecycle(input: {
  credentialClass: CredentialClass;
  generation: number;
  rotationId: string;
  oldFingerprint: string;
  replacementFingerprint: string;
  oldIssuer: string;
  replacementIssuer: string;
}): Promise<Record<string, unknown>> {
  let last: Record<string, unknown> = {};
  for (const [offset, action] of [
    [0, "install"],
    [1, "verify"],
    [2, "revoke"],
  ] as const) {
    const request = await planInput(
      action,
      input.credentialClass,
      input.generation + offset,
      input.rotationId,
      input.oldFingerprint,
      input.replacementFingerprint,
    );
    request.old_issuer_credential_id = input.oldIssuer;
    request.replacement_issuer_credential_id =
      input.replacementIssuer;
    request.idempotency_key =
      `${action}-${input.rotationId}-${input.generation + offset}`;
    const plan = await reserve(request);
    expect(plan).toMatchObject({
      old_consumer_slot:
        input.rotationId.endsWith("_generation_1") ? "a" : "b",
      replacement_consumer_slot:
        input.rotationId.endsWith("_generation_1") ? "b" : "a",
    });
    await execute(plan);
    const response = await finalize(
      plan,
      await signedAttestation(
        plan,
        action === "revoke" ? "unusable" : "usable",
      ),
    );
    expect(response.status).toBe(200);
    last = await response.json<Record<string, unknown>>();
  }
  return last;
}

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
    production_target_identity: productionTargetIdentity(),
    expected_catalogue_revision_id: "catrev_spine_000",
    expected_state_generation: generation,
    old_fingerprint:
      oldFingerprint ??
      (await fingerprint(`old-${credentialClass}`)),
    replacement_fingerprint:
      replacementFingerprint ??
      (await fingerprint(`replacement-${credentialClass}`)),
    old_issuer_credential_id:
      credentialClass === "api_bearer_key"
        ? "wrangler:apps/api/wrangler.jsonc:API_BEARER_KEY"
        : credentialClass === "ingestion_admin_key"
          ? "wrangler:apps/ingestion/wrangler.jsonc:ADMINISTRATION_KEY"
          : "provider-token:old-credential-id",
    replacement_issuer_credential_id:
      credentialClass === "api_bearer_key"
        ? "wrangler:apps/api/wrangler.jsonc:API_BEARER_KEY_REPLACEMENT"
        : credentialClass === "ingestion_admin_key"
          ? "wrangler:apps/ingestion/wrangler.jsonc:ADMINISTRATION_KEY_REPLACEMENT"
          : "provider-token:replacement-credential-id",
    management_credential_id: "provider-token:management-id",
    github_management_credential_id:
      credentialClass === "github_deployment_token"
        ? "github-app-installation:22222222"
        : "not-applicable",
    github_management_credential_fingerprint:
      credentialClass === "github_deployment_token"
        ? await fingerprint("github-management-token")
        : `sha256:${"0".repeat(64)}`,
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
  const failure =
    response.status === 201
      ? ""
      : JSON.stringify(await response.clone().json());
  expect(response.status, failure).toBe(201);
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
  ownerToken = "a".repeat(64),
): Promise<void> {
  const response = await executionResponse(
    plan,
    observedAt,
    ownerToken,
  );
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
  ownerToken = "a".repeat(64),
): Promise<Response> {
  return administrationRequest(
    `/v1/credential-rotation-plans/${plan.id}/execution`,
    "POST",
    {
      plan_digest: plan.plan_digest,
      execution_owner_token: ownerToken,
      expected_execution_attempt: plan.execution_attempt,
    },
    undefined,
    observedAt,
  );
}

async function signedAttestation(
  plan: PlanDocument,
  oldStatus: "usable" | "unusable",
  observedAt = new Date().toISOString(),
  capabilityAlreadyConsumed = false,
): Promise<string> {
  const facts = boundaryFacts(plan, oldStatus, observedAt);
  if (!capabilityAlreadyConsumed) {
    await consumeExecutionCapability(plan, observedAt);
  }
  const response = await administrationRequest(
    `/v1/credential-rotation-plans/${plan.id}/boundary-attestation`,
    "POST",
    {
      plan_digest: plan.plan_digest,
      execution_attempt: plan.execution_attempt,
      execution_capability: plan.execution_capability,
      facts,
    },
    undefined,
    observedAt,
  );
  expect(response.status).toBe(200);
  const document = await response.json<{
    boundary_attestation: string;
  }>();
  return document.boundary_attestation;
}

function boundaryFacts(
  plan: PlanDocument,
  oldStatus: "usable" | "unusable",
  observedAt: string,
): Record<string, unknown> {
  return {
    version: 1,
    plan_id: plan.id,
    plan_digest: plan.plan_digest,
    plan_nonce: plan.plan_nonce,
    action: plan.action,
    credential_class: plan.credential_class,
    cloudflare_account_id: plan.cloudflare_account_id,
    resource_identity: plan.resource_identity,
    verification_target: plan.verification_target,
    production_target_identity:
      plan.production_target_identity,
    required_permission: plan.required_permission,
    cloudflare_management_required_permissions:
      plan.cloudflare_management_required_permissions,
    consumer_installation_identity:
      plan.consumer_installation_identity,
    old_consumer_slot: plan.old_consumer_slot,
    replacement_consumer_slot: plan.replacement_consumer_slot,
    old_fingerprint: plan.old_fingerprint,
    replacement_fingerprint: plan.replacement_fingerprint,
    installed_fingerprint: plan.replacement_fingerprint,
    old_issuer_credential_id: plan.old_issuer_credential_id,
    replacement_issuer_credential_id:
      plan.replacement_issuer_credential_id,
    management_credential_id: plan.management_credential_id,
    github_management_credential_id:
      plan.github_management_credential_id,
    github_management_credential_fingerprint:
      plan.github_management_credential_fingerprint,
    github_management_required_permission:
      plan.github_management_required_permission,
    consumer_installation_id:
      plan.consumer_installation_identity,
    scope_evidence_digest: `sha256:${"a".repeat(64)}`,
    old_credential_status: oldStatus,
    replacement_credential_status: "usable",
    observed_at: observedAt,
    execution_attempt: plan.execution_attempt,
    execution_mode: plan.execution_mode,
  };
}

async function locallySignedAttestation(
  plan: PlanDocument,
  oldStatus: "usable" | "unusable",
  observedAt: string,
): Promise<string> {
  const payload = boundaryFacts(plan, oldStatus, observedAt);
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

async function consumeExecutionCapability(
  plan: PlanDocument,
  observedAt?: string,
): Promise<void> {
  const response = await administrationRequest(
    `/v1/credential-rotation-plans/${plan.id}/execution-capability`,
    "POST",
    {
      plan_digest: plan.plan_digest,
      execution_attempt: plan.execution_attempt,
      execution_capability: plan.execution_capability,
    },
    undefined,
    observedAt,
  );
  expect(response.status).toBe(200);
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
    slot: "b",
    expected_status: "usable",
  });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("vitest-consumer-proof-key"),
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
