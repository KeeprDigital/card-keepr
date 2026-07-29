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
    "DELETE FROM credential_rotations",
  ).run();
});

afterEach(async () => {
  await env.CATALOGUE_DB.prepare(
    "DELETE FROM credential_rotations",
  ).run();
});

test("API bearer keys overlap until the verified old value is revoked", async () => {
  await seedRotation(
    "replacement_installed",
    "vitest-api-key",
    "replacement-api-key",
  );

  expect(await healthStatus("vitest-api-key")).toBe(200);
  expect(await healthStatus("replacement-api-key")).toBe(200);

  await env.CATALOGUE_DB.prepare(
    `UPDATE credential_rotations
     SET state = 'replacement_verified',
         verified_at = '2026-07-29T00:01:00.000Z'
     WHERE id = 'credrot_api_overlap'`,
  ).run();
  expect(await healthStatus("vitest-api-key")).toBe(200);
  expect(await healthStatus("replacement-api-key")).toBe(200);

  await env.CATALOGUE_DB.prepare(
    `UPDATE credential_rotations
     SET state = 'old_revoked',
         old_revoked_at = '2026-07-29T00:02:00.000Z'
     WHERE id = 'credrot_api_overlap'`,
  ).run();
  expect(await healthStatus("vitest-api-key")).toBe(401);
  expect(await healthStatus("replacement-api-key")).toBe(200);

  await seedRotation(
    "replacement_installed",
    "replacement-api-key",
    "next-api-key",
    "credrot_api_overlap_2",
  );
  expect(await healthStatus("replacement-api-key")).toBe(200);
  expect(await healthStatus("next-api-key")).toBe(200);
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
  expect(await healthStatus("replacement-api-key")).toBe(401);
  expect(await healthStatus("next-api-key")).toBe(200);
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
      old_secret_hash,
      replacement_secret_hash,
      installed_at,
      verified_at,
      old_revoked_at
    ) VALUES (
      ?,
      'api_bearer_key',
      ?,
      'production',
      'worker:card-keepr-api',
      'api_worker',
      ?,
      ?,
      '2026-07-29T00:00:00.000Z',
      NULL,
      NULL
    )`,
  )
    .bind(rotationId, state, oldHash, replacementHash)
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
