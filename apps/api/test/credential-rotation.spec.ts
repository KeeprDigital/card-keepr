import { env, exports } from "cloudflare:workers";
import {
  applyD1Migrations,
  type D1Migration,
} from "cloudflare:test";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  credentialConsumerProofRequests,
} from "../../../src/credentials/consumer-proof";
import apiWorker from "../src/index";

declare global {
  interface __BaseEnv_Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}

beforeEach(async () => {
  await applyD1Migrations(
    env.CATALOGUE_DB,
    env.TEST_MIGRATIONS,
  );
  await env.CATALOGUE_DB.prepare(
    "DELETE FROM credential_rotations",
  ).run();
  await env.CATALOGUE_DB.prepare(
    "DELETE FROM credential_consumer_proof_uses",
  ).run();
});

afterEach(async () => {
  await env.CATALOGUE_DB.prepare(
    "DELETE FROM credential_rotations",
  ).run();
  await env.CATALOGUE_DB.prepare(
    "DELETE FROM credential_consumer_proof_uses",
  ).run();
});

test("API bearer keys overlap until the verified old value is revoked", async () => {
  await seedRotation(
    "replacement_installed",
    "vitest-api-key",
    "vitest-api-key-replacement-slot",
  );

  expect(await healthStatus("vitest-api-key")).toBe(200);
  expect(
    await healthStatus("vitest-api-key-replacement-slot"),
  ).toBe(200);

  await env.CATALOGUE_DB.prepare(
    `UPDATE credential_rotations
     SET state = 'replacement_verified',
         verified_at = '2026-07-29T00:01:00.000Z'
     WHERE id = 'credrot_api_overlap'`,
  ).run();
  expect(await healthStatus("vitest-api-key")).toBe(200);
  expect(
    await healthStatus("vitest-api-key-replacement-slot"),
  ).toBe(200);

  await env.CATALOGUE_DB.prepare(
    `UPDATE credential_rotations
     SET state = 'old_revoked',
         old_revoked_at = '2026-07-29T00:02:00.000Z'
     WHERE id = 'credrot_api_overlap'`,
  ).run();
  expect(await healthStatus("vitest-api-key")).toBe(401);
  expect(
    await healthStatus("vitest-api-key-replacement-slot"),
  ).toBe(200);

  await seedRotation(
    "replacement_installed",
    "vitest-api-key-replacement-slot",
    "next-api-key",
    "credrot_api_overlap_2",
  );
  const secondGenerationBindings = {
    ...env,
    API_BEARER_KEY: "vitest-api-key-replacement-slot",
    API_BEARER_KEY_REPLACEMENT: "next-api-key",
  } as unknown as Env;
  expect(await directApiHealthStatus(
    "vitest-api-key-replacement-slot",
    secondGenerationBindings,
  )).toBe(200);
  expect(await directApiHealthStatus(
    "next-api-key",
    secondGenerationBindings,
  )).toBe(200);
  await env.CATALOGUE_DB.prepare(
    `UPDATE credential_rotations
     SET state = 'replacement_verified',
         verified_at = '2026-07-29T00:03:00.000Z'
     WHERE id = 'credrot_api_overlap_2'`,
  ).run();
  await env.CATALOGUE_DB.prepare(
    `UPDATE credential_rotations
     SET state = 'old_revoked',
         old_revoked_at = '2026-07-29T00:04:00.000Z'
     WHERE id = 'credrot_api_overlap_2'`,
  ).run();
  expect(await directApiHealthStatus(
    "vitest-api-key-replacement-slot",
    secondGenerationBindings,
  )).toBe(401);
  expect(await directApiHealthStatus(
    "next-api-key",
    secondGenerationBindings,
  )).toBe(200);
});

test("the live Worker secret binding immediately governs revocation before catalogue finalization", async () => {
  await seedRotation(
    "replacement_verified",
    "vitest-api-key",
    "vitest-api-key-replacement-slot",
    "credrot_api_binding_authority",
  );
  const deletedOldBinding = {
    ...env,
    API_BEARER_KEY: undefined,
  } as unknown as Env;
  await expect(
    env.CATALOGUE_DB.prepare(
      `SELECT state FROM credential_rotations
       WHERE id = 'credrot_api_binding_authority'`,
    ).first<{ state: string }>(),
  ).resolves.toEqual({ state: "replacement_verified" });
  expect(
    await directApiHealthStatus(
      "vitest-api-key",
      deletedOldBinding,
    ),
  ).toBe(401);
  expect(
    await directApiHealthStatus(
      "vitest-api-key-replacement-slot",
      deletedOldBinding,
    ),
  ).toBe(200);
  await env.CATALOGUE_DB.prepare(
    `UPDATE credential_rotations
     SET state = 'old_revoked',
         old_revoked_at = '2026-07-29T00:03:00.000Z'
     WHERE id = 'credrot_api_binding_authority'`,
  ).run();
  await expect(
    env.CATALOGUE_DB.prepare(
      `SELECT state FROM credential_rotations
       WHERE id = 'credrot_api_binding_authority'`,
    ).first<{ state: string }>(),
  ).resolves.toEqual({ state: "old_revoked" });
  expect(
    await directApiHealthStatus(
      "vitest-api-key",
      deletedOldBinding,
    ),
  ).toBe(401);
  expect(
    await directApiHealthStatus(
      "vitest-api-key-replacement-slot",
      deletedOldBinding,
    ),
  ).toBe(200);
});

test("an out-of-band removed old API binding fails closed during overlap", async () => {
  await seedRotation(
    "replacement_installed",
    "vitest-api-key",
    "vitest-api-key-replacement-slot",
    "credrot_api_out_of_band_removal",
  );
  const removedOldBinding = {
    ...env,
    API_BEARER_KEY: undefined,
  } as unknown as Env;
  expect(await directApiHealthStatus(
    "vitest-api-key",
    removedOldBinding,
  )).toBe(401);
  expect(await directApiHealthStatus(
    "vitest-api-key-replacement-slot",
    removedOldBinding,
  )).toBe(200);
});

test("the signed health observation proves the exact installed API value without mutating D1", async () => {
  const replacement = "vitest-api-key-replacement-slot";
  expect(await healthStatus(replacement)).toBe(200);
  const challenge = "b".repeat(64);
  const expectedFingerprint = `sha256:${await hash(replacement)}`;
  const accepted = await consumerObservation(
    expectedFingerprint,
    challenge,
  );
  expect(accepted.status).toBe(200);
  await expect(accepted.json()).resolves.toMatchObject({
    contract: "card-keepr-credential-consumer-proof@1",
    credential_class: "api_bearer_key",
    expected_fingerprint: expectedFingerprint,
    challenge,
    slot: "b",
    status: "usable",
  });
  const repeated = await consumerObservation(
    expectedFingerprint,
    challenge,
  );
  expect(repeated.status).toBe(200);

  const wrongValue = await consumerObservation(
    `sha256:${"0".repeat(64)}`,
    challenge,
  );
  expect(wrongValue.status).toBe(409);
  await expect(wrongValue.json()).resolves.toMatchObject({
    code: "credential_fingerprint_mismatch",
  });
  const replayRows = await env.CATALOGUE_DB.prepare(
    "SELECT COUNT(*) AS count FROM credential_consumer_proof_uses",
  ).first<{ count: number }>();
  expect(replayRows?.count).toBe(0);
});

test("expired health observation tokens fail before probing the consumer", async () => {
  const replacement = "vitest-api-key-replacement-slot";
  const response = await consumerObservation(
    `sha256:${await hash(replacement)}`,
    "d".repeat(64),
    "2000-01-01T00:00:00.000Z",
  );
  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toMatchObject({
    code: "invalid_boundary_challenge",
  });
});

test("the API no longer accepts the mutating consumer-proof route", async () => {
  const response = await exports.default.fetch(
    new Request(
      "https://card-keepr.invalid/v1/credential-consumer-proof",
      {
        method: "POST",
        headers: {
          authorization: "Bearer vitest-api-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          credential_class: "api_bearer_key",
        }),
      },
    ),
  );
  expect(response.status).toBe(404);
  const replayRows = await env.CATALOGUE_DB.prepare(
    "SELECT COUNT(*) AS count FROM credential_consumer_proof_uses",
  ).first<{ count: number }>();
  expect(replayRows?.count).toBe(0);
});

test("distinct required observations receive distinct single-use request nonces", async () => {
  const requests = await credentialConsumerProofRequests(
    {
      id: "credplan_api_distinct_proofs",
      plan_digest: "e".repeat(64),
      plan_nonce: "f".repeat(64),
      execution_attempt: 1,
      execution_expires_at: "9999-12-31T23:59:59.999Z",
      action: "verify",
      credential_class: "api_bearer_key",
      old_fingerprint: `sha256:${await hash("vitest-api-key")}`,
      replacement_fingerprint:
        `sha256:${await hash("vitest-api-key-replacement-slot")}`,
      old_consumer_slot: "a",
      replacement_consumer_slot: "b",
      old_issuer_credential_id: "worker-secret:old",
      replacement_issuer_credential_id: "worker-secret:replacement",
      github_management_credential_fingerprint:
        `sha256:${"0".repeat(64)}`,
      github_management_required_permission: "not-applicable",
    },
    "vitest-consumer-proof-key",
  );
  expect(requests).toHaveLength(2);
  expect(requests[0]!.request_nonce).not.toBe(
    requests[1]!.request_nonce,
  );
});

async function healthStatus(secret: string): Promise<number> {
  const response = await exports.default.fetch(
    new Request("https://card-keepr.invalid/health", {
      headers: { authorization: `Bearer ${secret}` },
    }),
  );
  await response.body?.cancel();
  return response.status;
}

async function directApiHealthStatus(
  secret: string,
  environment: Env,
): Promise<number> {
  const response = await apiWorker.fetch(
    new Request("https://card-keepr.invalid/health", {
      headers: { authorization: `Bearer ${secret}` },
    }),
    environment,
  );
  await response.body?.cancel();
  return response.status;
}

async function consumerObservation(
  expectedFingerprint: string,
  challenge: string,
  executionExpiresAt = "9999-12-31T23:59:59.999Z",
): Promise<Response> {
  const requestToken = (
    await credentialConsumerProofRequests(
      {
        id: "credplan_api_consumer_proof",
        plan_digest: challenge,
        plan_nonce: "c".repeat(64),
        execution_attempt: 1,
        execution_expires_at: executionExpiresAt,
        action: "install",
        credential_class: "api_bearer_key",
        old_fingerprint: `sha256:${"1".repeat(64)}`,
        replacement_fingerprint: expectedFingerprint,
        old_consumer_slot: "a",
        replacement_consumer_slot: "b",
        old_issuer_credential_id: "worker-secret:old",
        replacement_issuer_credential_id: "worker-secret:replacement",
        github_management_credential_fingerprint:
          `sha256:${"0".repeat(64)}`,
        github_management_required_permission: "not-applicable",
      },
      "vitest-consumer-proof-key",
    )
  )[0]!.request_token;
  return exports.ApiCredentialConsumer.fetch(
    new Request(
      "https://card-keepr.invalid/health",
      {
        headers: {
          "x-keepr-credential-consumer-request": requestToken,
        },
      },
    ),
  );
}

async function seedRotation(
  state: string,
  oldSecret: string,
  replacementSecret: string,
  rotationId = "credrot_api_overlap",
): Promise<void> {
  const [oldHash, replacementHash] = await Promise.all([
    hash(oldSecret),
    hash(replacementSecret),
  ]);
  await env.CATALOGUE_DB.prepare(
    `INSERT INTO credential_rotations (
      id,
      credential_class,
      state,
      environment,
      resource_identity,
      owning_boundary,
      verification_target,
      production_target_identity,
      required_permission,
      cloudflare_management_required_permissions,
      consumer_installation_identity,
      old_consumer_slot,
      replacement_consumer_slot,
      current_consumer_slot,
      old_issuer_credential_id,
      replacement_issuer_credential_id,
      management_credential_id,
      github_management_credential_id,
      github_management_credential_fingerprint,
      github_management_required_permission,
      old_secret_hash,
      replacement_secret_hash,
      installed_at,
      install_idempotency_key,
      install_request_digest,
      install_receipt,
      verified_at,
      old_revoked_at
    ) VALUES (
      ?,
      'api_bearer_key',
      ?,
      'production',
      'worker:card-keepr-api',
      'api_worker',
      'worker-health:card-keepr-api',
      '{"cloudflare_account_id":"0123456789abcdef0123456789abcdef","worker_scripts":["card-keepr-api","card-keepr-ingestion"],"d1_databases":["00000000-0000-0000-0000-000000000001","00000000-0000-0000-0000-000000000002"],"r2_buckets":["card-keepr-evidence","card-keepr-printing-images","card-keepr-catalogue-exports","card-keepr-backups"],"workflows":["card-keepr-evidence-ingestion","card-keepr-evidence-host"],"github_repository_id":"1313489088","github_installation_id":"22222222","github_environment_id":"33333333","github_workflow_id":"44444444"}',
      'workers-secret:api-traffic',
      '["Account API Tokens Read","Account API Tokens Write","Workers Scripts Write"]',
      'worker-secret:card-keepr-api:API_BEARER_KEY_REPLACEMENT',
      'a',
      'b',
      'b',
      'issuer-old-api-test',
      'issuer-replacement-api-test',
      'management-api-test',
      'not-applicable',
      'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      'not-applicable',
      ?,
      ?,
      '2026-07-29T00:00:00.000Z',
      ?,
      ?,
      'receipt:api-test-install',
      CASE WHEN ? = 'replacement_installed'
        THEN NULL
        ELSE '2026-07-29T00:01:00.000Z'
      END,
      NULL
    )`,
  )
    .bind(
      rotationId,
      state,
      oldHash,
      replacementHash,
      `install-${rotationId}`,
      "a".repeat(64),
      state,
    )
    .run();
}

async function hash(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
