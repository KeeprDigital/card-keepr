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
  await applyD1Migrations(env.CATALOGUE_DB, env.TEST_MIGRATIONS);
  await env.CATALOGUE_DB.prepare(
    "DELETE FROM credential_rotations",
  ).run();
  await env.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET recovery_health = 'healthy', active_ingestion_run_id = NULL WHERE singleton = 1",
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

test("safe owning-boundary proofs advance only installed, verified, then revoked with idempotent replay", async () => {
  const installBody = installation("api_bearer_key", {
    rotation_id: "credrot_api_001",
    old_fingerprint: await fingerprint("old-api-secret"),
    replacement_fingerprint: await fingerprint("replacement-api-secret"),
    idempotency_key: "install-api-001",
  });
  expect(JSON.stringify(installBody)).not.toContain("old-api-secret");
  expect(JSON.stringify(installBody)).not.toContain(
    "replacement-api-secret",
  );

  const installed = await administrationRequest(
    "/v1/credential-rotations",
    "POST",
    installBody,
  );
  expect(installed.status).toBe(201);
  const installationDocument = await installed.json<{
    state: string;
    old_fingerprint: string;
    replacement_fingerprint: string;
  }>();
  expect(installationDocument).toMatchObject({
    contract: "card-keepr-credential-rotation@1",
    id: "credrot_api_001",
    state: "replacement_installed",
    verification_target: "worker-health:card-keepr-api",
    operation_code: "ok",
  });

  const replay = await administrationRequest(
    "/v1/credential-rotations",
    "POST",
    installBody,
  );
  expect(replay.status).toBe(201);
  await expect(replay.json()).resolves.toMatchObject({
    operation_code: "idempotent_replay",
  });

  const reused = await administrationRequest(
    "/v1/credential-rotations",
    "POST",
    {
      ...installBody,
      boundary_receipt: "receipt:changed-install-proof",
    },
  );
  expect(reused.status).toBe(409);
  await expect(reused.json()).resolves.toMatchObject({
    code: "idempotency_key_reused",
  });

  const premature = await administrationRequest(
    "/v1/credential-rotations/credrot_api_001/revocation",
    "POST",
    transition("api_bearer_key", {
      old_fingerprint: installationDocument.old_fingerprint,
      replacement_fingerprint:
        installationDocument.replacement_fingerprint,
      idempotency_key: "revoke-api-001",
      boundary_receipt: "receipt:api-old-revoked-proof",
    }),
  );
  expect(premature.status).toBe(409);
  await expect(premature.json()).resolves.toMatchObject({
    code: "replacement_not_verified",
  });

  const verified = await administrationRequest(
    "/v1/credential-rotations/credrot_api_001/verification",
    "POST",
    transition("api_bearer_key", {
      replacement_fingerprint:
        installationDocument.replacement_fingerprint,
      idempotency_key: "verify-api-001",
      boundary_receipt: "receipt:api-replacement-verified-proof",
    }),
  );
  expect(verified.status).toBe(200);
  await expect(verified.json()).resolves.toMatchObject({
    state: "replacement_verified",
  });

  const revoked = await administrationRequest(
    "/v1/credential-rotations/credrot_api_001/revocation",
    "POST",
    transition("api_bearer_key", {
      old_fingerprint: installationDocument.old_fingerprint,
      replacement_fingerprint:
        installationDocument.replacement_fingerprint,
      idempotency_key: "revoke-api-001",
      boundary_receipt: "receipt:api-old-revoked-proof",
    }),
  );
  expect(revoked.status).toBe(200);
  await expect(revoked.json()).resolves.toMatchObject({
    state: "old_revoked",
  });
});

test("all five credential classes resolve separate least-privilege boundaries", async () => {
  for (const credentialClass of [
    "api_bearer_key",
    "ingestion_admin_key",
    "d1_export_token",
    "d1_verification_token",
    "github_deployment_token",
  ] as const) {
    const response = await administrationRequest(
      "/v1/credential-rotations",
      "POST",
      installation(credentialClass, {
        rotation_id: `credrot_${credentialClass}`,
        old_fingerprint: await fingerprint(`old-${credentialClass}`),
        replacement_fingerprint: await fingerprint(
          `replacement-${credentialClass}`,
        ),
        idempotency_key: `install-${credentialClass}`,
      }),
    );
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject(
      identities[credentialClass],
    );
  }
});

test("stale identities, wrong classes, and blocked recovery fail with stable codes", async () => {
  const unsafeReceipt = await administrationRequest(
    "/v1/credential-rotations",
    "POST",
    {
      ...installation("api_bearer_key", {
        rotation_id: "credrot_unsafe_receipt",
        old_fingerprint: await fingerprint("old-unsafe-receipt"),
        replacement_fingerprint: await fingerprint(
          "new-unsafe-receipt",
        ),
        idempotency_key: "install-unsafe-receipt",
      }),
      boundary_receipt: "provider output with whitespace",
    },
  );
  expect(unsafeReceipt.status).toBe(422);
  await expect(unsafeReceipt.json()).resolves.toMatchObject({
    code: "invalid_boundary_receipt",
  });

  const stale = await administrationRequest(
    "/v1/credential-rotations",
    "POST",
    {
      ...installation("api_bearer_key", {
        rotation_id: "credrot_stale",
        old_fingerprint: await fingerprint("old-stale"),
        replacement_fingerprint: await fingerprint("new-stale"),
        idempotency_key: "install-stale",
      }),
      verification_target: "cloudflare:arbitrary-success-url",
    },
  );
  expect(stale.status).toBe(409);
  await expect(stale.json()).resolves.toMatchObject({
    code: "stale_credential_identity",
  });

  const installed = await administrationRequest(
    "/v1/credential-rotations",
    "POST",
    installation("api_bearer_key", {
      rotation_id: "credrot_validation",
      old_fingerprint: await fingerprint("old-validation"),
      replacement_fingerprint: await fingerprint("new-validation"),
      idempotency_key: "install-validation",
    }),
  );
  const document = await installed.json<{
    replacement_fingerprint: string;
  }>();
  const wrongClass = await administrationRequest(
    "/v1/credential-rotations/credrot_validation/verification",
    "POST",
    transition("ingestion_admin_key", {
      replacement_fingerprint: document.replacement_fingerprint,
      idempotency_key: "verify-wrong-class",
      boundary_receipt: "receipt:wrong-class-proof",
    }),
  );
  expect(wrongClass.status).toBe(409);
  await expect(wrongClass.json()).resolves.toMatchObject({
    code: "credential_class_mismatch",
  });

  await env.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET recovery_health = 'blocked' WHERE singleton = 1",
  ).run();
  const blocked = await administrationRequest(
    "/v1/credential-rotations/credrot_validation/verification",
    "POST",
    transition("api_bearer_key", {
      replacement_fingerprint: document.replacement_fingerprint,
      idempotency_key: "verify-blocked",
      boundary_receipt: "receipt:blocked-proof",
    }),
  );
  expect(blocked.status).toBe(409);
  await expect(blocked.json()).resolves.toMatchObject({
    code: "recovery_in_progress",
  });
});

test("a self-consistent wrong administration old secret cannot reach installation through the Worker boundary", async () => {
  const wrongOld = "self-consistent-but-not-active";
  const response = await administrationRequest(
    "/v1/credential-rotations",
    "POST",
    installation("ingestion_admin_key", {
      rotation_id: "credrot_wrong_old",
      old_fingerprint: await fingerprint(wrongOld),
      replacement_fingerprint: await fingerprint("replacement-admin"),
      idempotency_key: "install-wrong-old",
    }),
    wrongOld,
  );
  expect(response.status).toBe(401);
});

const identities = {
  api_bearer_key: {
    credential_class: "api_bearer_key",
    environment: "production",
    resource_identity: "worker:card-keepr-api",
    owning_boundary: "api_worker",
    verification_target: "worker-health:card-keepr-api",
  },
  ingestion_admin_key: {
    credential_class: "ingestion_admin_key",
    environment: "production",
    resource_identity: "worker:card-keepr-ingestion",
    owning_boundary: "ingestion_worker",
    verification_target: "worker-health:card-keepr-ingestion",
  },
  d1_export_token: {
    credential_class: "d1_export_token",
    environment: "production",
    resource_identity: "d1:card-keepr-catalogue",
    owning_boundary: "d1_export_operation",
    verification_target: "cloudflare:d1:card-keepr-catalogue:export",
  },
  d1_verification_token: {
    credential_class: "d1_verification_token",
    environment: "production",
    resource_identity: "d1:disposable-verification",
    owning_boundary: "disposable_verification",
    verification_target: "cloudflare:d1:disposable-verification:edit",
  },
  github_deployment_token: {
    credential_class: "github_deployment_token",
    environment: "production",
    resource_identity: "worker-release:card-keepr",
    owning_boundary: "production_release_workflow",
    verification_target:
      "github:KeeprDigital/card-keepr:environment:production",
  },
} as const;

function installation(
  credentialClass: keyof typeof identities,
  values: Record<string, string>,
): Record<string, string> {
  return {
    ...identities[credentialClass],
    ...values,
    boundary_receipt: `receipt:${credentialClass}:installed`,
  };
}

function transition(
  credentialClass: keyof typeof identities,
  values: Record<string, string>,
): Record<string, string> {
  return { ...identities[credentialClass], ...values };
}

async function administrationRequest(
  pathname: string,
  method: string,
  body?: Record<string, unknown>,
  key = "vitest-administration-key",
): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://card-keepr.invalid${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
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
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
