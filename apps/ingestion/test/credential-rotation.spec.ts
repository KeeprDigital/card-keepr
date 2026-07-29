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

beforeEach(async () => {
  await applyD1Migrations(
    env.CATALOGUE_DB,
    env.TEST_MIGRATIONS,
  );
  await env.CATALOGUE_DB.prepare(
    `UPDATE operation_state
     SET active_ingestion_run_id = NULL, recovery_health = 'healthy'
     WHERE singleton = 1`,
  ).run();
  await env.CATALOGUE_DB.prepare(
    "DELETE FROM credential_rotations",
  ).run();
});

afterEach(async () => {
  await env.CATALOGUE_DB.prepare(
    "DELETE FROM credential_rotations",
  ).run();
  await env.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET recovery_health = 'healthy' WHERE singleton = 1",
  ).run();
});

test("a credential replacement is verified before the old value can be revoked", async () => {
  const installed = await administrationRequest(
    "/v1/credential-rotations",
    "POST",
    {
      rotation_id: "credrot_api_001",
      credential_class: "api_bearer_key",
      environment: "production",
      resource_identity: "worker:card-keepr-api",
      owning_boundary: "api_worker",
      expected_old_fingerprint: await fingerprint("old-api-secret"),
      old_secret: "old-api-secret",
      replacement_secret: "replacement-api-secret",
    },
  );

  expect(installed.status).toBe(201);
  const installation = await installed.json<{
    state: string;
    old_fingerprint: string;
    replacement_fingerprint: string;
  }>();
  expect(installation).toMatchObject({
    contract: "card-keepr-credential-rotation@1",
    id: "credrot_api_001",
    credential_class: "api_bearer_key",
    state: "replacement_installed",
    environment: "production",
    resource_identity: "worker:card-keepr-api",
    owning_boundary: "api_worker",
  });
  expect(JSON.stringify(installation)).not.toContain("old-api-secret");
  expect(JSON.stringify(installation)).not.toContain(
    "replacement-api-secret",
  );

  const prematureRevocation = await administrationRequest(
    "/v1/credential-rotations/credrot_api_001/revocation",
    "POST",
    {
      credential_class: "api_bearer_key",
      environment: "production",
      resource_identity: "worker:card-keepr-api",
      owning_boundary: "api_worker",
      expected_old_fingerprint: installation.old_fingerprint,
    },
  );
  expect(prematureRevocation.status).toBe(409);
  await expect(prematureRevocation.json()).resolves.toMatchObject({
    code: "replacement_not_verified",
  });

  const verified = await administrationRequest(
    "/v1/credential-rotations/credrot_api_001/verification",
    "POST",
    {
      credential_class: "api_bearer_key",
      environment: "production",
      resource_identity: "worker:card-keepr-api",
      owning_boundary: "api_worker",
      replacement_secret: "replacement-api-secret",
    },
  );
  expect(verified.status).toBe(200);
  await expect(verified.json()).resolves.toMatchObject({
    id: "credrot_api_001",
    state: "replacement_verified",
  });

  const revoked = await administrationRequest(
    "/v1/credential-rotations/credrot_api_001/revocation",
    "POST",
    {
      credential_class: "api_bearer_key",
      environment: "production",
      resource_identity: "worker:card-keepr-api",
      owning_boundary: "api_worker",
      expected_old_fingerprint: installation.old_fingerprint,
    },
  );
  expect(revoked.status).toBe(200);
  await expect(revoked.json()).resolves.toMatchObject({
    id: "credrot_api_001",
    state: "old_revoked",
  });
});

test("credential classes retain distinct owning resources and mutation conflicts fail closed", async () => {
  const identities = [
    [
      "api_bearer_key",
      "worker:card-keepr-api",
      "api_worker",
    ],
    [
      "ingestion_admin_key",
      "worker:card-keepr-ingestion",
      "ingestion_worker",
    ],
    [
      "d1_export_token",
      "d1:card-keepr-catalogue",
      "d1_export_operation",
    ],
    [
      "d1_verification_token",
      "d1:disposable-verification",
      "disposable_verification",
    ],
    [
      "github_deployment_token",
      "worker-release:card-keepr",
      "production_release_workflow",
    ],
  ] as const;

  for (const [credentialClass, resourceIdentity, owningBoundary] of identities) {
    const oldSecret = `old-${credentialClass}`;
    const response = await administrationRequest(
      "/v1/credential-rotations",
      "POST",
      {
        rotation_id: `credrot_${credentialClass}`,
        credential_class: credentialClass,
        environment: "production",
        resource_identity: resourceIdentity,
        owning_boundary: owningBoundary,
        expected_old_fingerprint: await fingerprint(oldSecret),
        old_secret: oldSecret,
        replacement_secret: `replacement-${credentialClass}`,
      },
    );
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      credential_class: credentialClass,
      resource_identity: resourceIdentity,
      owning_boundary: owningBoundary,
    });
  }

  const conflict = await administrationRequest(
    "/v1/credential-rotations",
    "POST",
    {
      rotation_id: "credrot_api_conflict",
      credential_class: "api_bearer_key",
      environment: "production",
      resource_identity: "worker:card-keepr-api",
      owning_boundary: "api_worker",
      expected_old_fingerprint: await fingerprint("another-old"),
      old_secret: "another-old",
      replacement_secret: "another-replacement",
    },
  );
  expect(conflict.status).toBe(409);
  await expect(conflict.json()).resolves.toMatchObject({
    code: "credential_mutation_conflict",
  });
});

test("stale identities, wrong classes, failed verification, and blocked recovery return stable codes", async () => {
  const stale = await administrationRequest(
    "/v1/credential-rotations",
    "POST",
    {
      rotation_id: "credrot_stale",
      credential_class: "api_bearer_key",
      environment: "production",
      resource_identity: "worker:stale-api",
      owning_boundary: "api_worker",
      expected_old_fingerprint: await fingerprint("old-stale"),
      old_secret: "old-stale",
      replacement_secret: "replacement-stale",
    },
  );
  expect(stale.status).toBe(409);
  await expect(stale.json()).resolves.toMatchObject({
    code: "stale_credential_identity",
  });

  const installed = await administrationRequest(
    "/v1/credential-rotations",
    "POST",
    {
      rotation_id: "credrot_validation",
      credential_class: "api_bearer_key",
      environment: "production",
      resource_identity: "worker:card-keepr-api",
      owning_boundary: "api_worker",
      expected_old_fingerprint: await fingerprint("old-validation"),
      old_secret: "old-validation",
      replacement_secret: "replacement-validation",
    },
  );
  expect(installed.status).toBe(201);
  await installed.body?.cancel();

  const wrongClass = await administrationRequest(
    "/v1/credential-rotations/credrot_validation/verification",
    "POST",
    {
      credential_class: "ingestion_admin_key",
      environment: "production",
      resource_identity: "worker:card-keepr-ingestion",
      owning_boundary: "ingestion_worker",
      replacement_secret: "replacement-validation",
    },
  );
  expect(wrongClass.status).toBe(409);
  await expect(wrongClass.json()).resolves.toMatchObject({
    code: "credential_class_mismatch",
  });

  const wrongReplacement = await administrationRequest(
    "/v1/credential-rotations/credrot_validation/verification",
    "POST",
    {
      credential_class: "api_bearer_key",
      environment: "production",
      resource_identity: "worker:card-keepr-api",
      owning_boundary: "api_worker",
      replacement_secret: "wrong-replacement",
    },
  );
  expect(wrongReplacement.status).toBe(409);
  await expect(wrongReplacement.json()).resolves.toMatchObject({
    code: "replacement_verification_failed",
  });

  await env.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET recovery_health = 'blocked' WHERE singleton = 1",
  ).run();
  const blocked = await administrationRequest(
    "/v1/credential-rotations/credrot_validation/verification",
    "POST",
    {
      credential_class: "api_bearer_key",
      environment: "production",
      resource_identity: "worker:card-keepr-api",
      owning_boundary: "api_worker",
      replacement_secret: "replacement-validation",
    },
  );
  expect(blocked.status).toBe(409);
  await expect(blocked.json()).resolves.toMatchObject({
    code: "recovery_in_progress",
  });
});

test("administration keys overlap at the authenticated Worker boundary until revocation", async () => {
  const replacement = "replacement-administration-key";
  const installed = await administrationRequest(
    "/v1/credential-rotations",
    "POST",
    {
      rotation_id: "credrot_admin_overlap",
      credential_class: "ingestion_admin_key",
      environment: "production",
      resource_identity: "worker:card-keepr-ingestion",
      owning_boundary: "ingestion_worker",
      expected_old_fingerprint: await fingerprint(
        "vitest-administration-key",
      ),
      old_secret: "vitest-administration-key",
      replacement_secret: replacement,
    },
  );
  expect(installed.status).toBe(201);
  const installation = await installed.json<{
    old_fingerprint: string;
  }>();

  expect((await administrationRequest("/health", "GET")).status).toBe(
    200,
  );
  expect(
    (
      await administrationRequest(
        "/health",
        "GET",
        undefined,
        replacement,
      )
    ).status,
  ).toBe(200);

  const verified = await administrationRequest(
    "/v1/credential-rotations/credrot_admin_overlap/verification",
    "POST",
    {
      credential_class: "ingestion_admin_key",
      environment: "production",
      resource_identity: "worker:card-keepr-ingestion",
      owning_boundary: "ingestion_worker",
      replacement_secret: replacement,
    },
    replacement,
  );
  expect(verified.status).toBe(200);
  await verified.body?.cancel();

  const revoked = await administrationRequest(
    "/v1/credential-rotations/credrot_admin_overlap/revocation",
    "POST",
    {
      credential_class: "ingestion_admin_key",
      environment: "production",
      resource_identity: "worker:card-keepr-ingestion",
      owning_boundary: "ingestion_worker",
      expected_old_fingerprint: installation.old_fingerprint,
    },
    replacement,
  );
  expect(revoked.status).toBe(200);
  await revoked.body?.cancel();

  expect((await administrationRequest("/health", "GET")).status).toBe(
    401,
  );
  expect(
    (
      await administrationRequest(
        "/health",
        "GET",
        undefined,
        replacement,
      )
    ).status,
  ).toBe(200);
});

async function administrationRequest(
  pathname: string,
  method: string,
  body?: Record<string, unknown>,
  administrationKey = "vitest-administration-key",
): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://card-keepr.invalid${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${administrationKey}`,
        ...(body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function fingerprint(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return `sha256:${Array.from(new Uint8Array(digest))
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
