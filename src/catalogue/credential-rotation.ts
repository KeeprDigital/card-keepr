export const credentialClasses = [
  "api_bearer_key",
  "ingestion_admin_key",
  "d1_export_token",
  "d1_verification_token",
  "github_deployment_token",
] as const;

export type CredentialClass = (typeof credentialClasses)[number];
export type CredentialRotationState =
  | "replacement_installed"
  | "replacement_verified"
  | "old_revoked";

type CredentialBoundary = {
  environment: "production";
  resource_identity: string;
  owning_boundary: string;
  verification_target: string;
};

const boundaries: Record<CredentialClass, CredentialBoundary> = {
  api_bearer_key: {
    environment: "production",
    resource_identity: "worker:card-keepr-api",
    owning_boundary: "api_worker",
    verification_target: "worker-health:card-keepr-api",
  },
  ingestion_admin_key: {
    environment: "production",
    resource_identity: "worker:card-keepr-ingestion",
    owning_boundary: "ingestion_worker",
    verification_target: "worker-health:card-keepr-ingestion",
  },
  d1_export_token: {
    environment: "production",
    resource_identity: "d1:card-keepr-catalogue",
    owning_boundary: "d1_export_operation",
    verification_target: "cloudflare:d1:card-keepr-catalogue:export",
  },
  d1_verification_token: {
    environment: "production",
    resource_identity: "d1:disposable-verification",
    owning_boundary: "disposable_verification",
    verification_target: "cloudflare:d1:disposable-verification:edit",
  },
  github_deployment_token: {
    environment: "production",
    resource_identity: "worker-release:card-keepr",
    owning_boundary: "production_release_workflow",
    verification_target:
      "github:KeeprDigital/card-keepr:environment:production",
  },
};

type RotationIdentity = CredentialBoundary & {
  credential_class: CredentialClass;
};

type TransitionProof = RotationIdentity & {
  idempotency_key: string;
  boundary_receipt: string;
};

type InstallInput = TransitionProof & {
  rotation_id: string;
  old_fingerprint: string;
  replacement_fingerprint: string;
};

type VerifyInput = TransitionProof & {
  replacement_fingerprint: string;
};

type RevokeInput = TransitionProof & {
  old_fingerprint: string;
  replacement_fingerprint: string;
};

type RotationRow = {
  id: string;
  credential_class: CredentialClass;
  state: CredentialRotationState;
  environment: "production";
  resource_identity: string;
  owning_boundary: string;
  verification_target: string;
  old_secret_hash: string;
  replacement_secret_hash: string;
  installed_at: string;
  verified_at: string | null;
  old_revoked_at: string | null;
  install_idempotency_key: string;
  install_request_digest: string;
  verification_idempotency_key: string | null;
  verification_request_digest: string | null;
  revocation_idempotency_key: string | null;
  revocation_request_digest: string | null;
  install_receipt: string;
  verification_receipt: string | null;
  revocation_receipt: string | null;
};

type AuthenticationRow = Pick<
  RotationRow,
  "state" | "old_secret_hash" | "replacement_secret_hash"
>;

export type CredentialRotationDocument = {
  contract: "card-keepr-credential-rotation@1";
  id: string;
  credential_class: CredentialClass;
  state: CredentialRotationState;
  environment: "production";
  resource_identity: string;
  owning_boundary: string;
  verification_target: string;
  old_fingerprint: string;
  replacement_fingerprint: string;
  installed_at: string;
  verified_at: string | null;
  old_revoked_at: string | null;
  operation_code: "ok" | "idempotent_replay";
};

export class CredentialRotationProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function isCredentialClass(value: string): value is CredentialClass {
  return credentialClasses.some((item) => item === value);
}

export function credentialBoundary(
  credentialClass: CredentialClass,
): CredentialBoundary {
  return boundaries[credentialClass];
}

export async function installCredentialRotation(
  database: D1Database,
  input: InstallInput,
  observedAt: string,
): Promise<CredentialRotationDocument> {
  assertIdentity(input);
  await assertMutationAvailable(database);
  const oldHash = hashFromFingerprint(input.old_fingerprint);
  const replacementHash = hashFromFingerprint(
    input.replacement_fingerprint,
  );
  if (await fixedHashEqual(oldHash, replacementHash)) {
    throw problem(
      "replacement_matches_old_credential",
      "The replacement credential must differ from the active old credential.",
    );
  }
  const digest = await requestDigest({
    action: "install",
    ...safeProof(input),
    old_fingerprint: input.old_fingerprint,
    replacement_fingerprint: input.replacement_fingerprint,
  });
  const existing = await optionalRow(database, input.rotation_id);
  if (existing !== null) {
    return replayOrReject(
      existing,
      input.idempotency_key,
      digest,
      "install",
    );
  }

  try {
    const result = await database
      .prepare(
        `INSERT INTO credential_rotations (
          id, credential_class, state, environment, resource_identity,
          owning_boundary, verification_target, old_secret_hash,
          replacement_secret_hash, installed_at, install_idempotency_key,
          install_request_digest, install_receipt
        )
        SELECT ?, ?, 'replacement_installed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM operation_state
        WHERE singleton = 1 AND recovery_health = 'healthy'`,
      )
      .bind(
        input.rotation_id,
        input.credential_class,
        input.environment,
        input.resource_identity,
        input.owning_boundary,
        input.verification_target,
        oldHash,
        replacementHash,
        observedAt,
        input.idempotency_key,
        digest,
        input.boundary_receipt,
      )
      .run();
    if (result.meta.changes !== 1) {
      await assertMutationAvailable(database);
      throw problem(
        "credential_mutation_conflict",
        "The credential rotation could not reserve its mutation state.",
      );
    }
  } catch (error) {
    if (error instanceof CredentialRotationProblem) throw error;
    if (errorMessage(error).includes("UNIQUE constraint")) {
      const replay = await rowByIdempotency(
        database,
        input.idempotency_key,
        "install",
      );
      if (replay !== null) {
        return replayOrReject(
          replay,
          input.idempotency_key,
          digest,
          "install",
        );
      }
      throw problem(
        "credential_mutation_conflict",
        "A conflicting credential rotation already exists.",
      );
    }
    throw error;
  }
  return document(await requiredRow(database, input.rotation_id), "ok");
}

export async function verifyCredentialRotation(
  database: D1Database,
  rotationId: string,
  input: VerifyInput,
  observedAt: string,
): Promise<CredentialRotationDocument> {
  assertIdentity(input);
  await assertMutationAvailable(database);
  const row = await requiredRow(database, rotationId);
  assertRowIdentity(row, input);
  assertFingerprint(
    row.replacement_secret_hash,
    input.replacement_fingerprint,
    "stale_credential_identity",
  );
  const digest = await requestDigest({
    action: "verify",
    rotation_id: rotationId,
    ...safeProof(input),
    replacement_fingerprint: input.replacement_fingerprint,
  });
  if (row.verification_idempotency_key !== null) {
    return replayOrReject(
      row,
      input.idempotency_key,
      digest,
      "verification",
    );
  }
  if (row.state !== "replacement_installed") {
    throw problem(
      "credential_mutation_conflict",
      "The rotation is not awaiting replacement verification.",
    );
  }
  const result = await database
    .prepare(
      `UPDATE credential_rotations
       SET state = 'replacement_verified', verified_at = ?,
           verification_idempotency_key = ?,
           verification_request_digest = ?, verification_receipt = ?
       WHERE id = ? AND state = 'replacement_installed'
         AND verification_idempotency_key IS NULL
         AND EXISTS (
           SELECT 1 FROM operation_state
           WHERE singleton = 1 AND recovery_health = 'healthy'
         )`,
    )
    .bind(
      observedAt,
      input.idempotency_key,
      digest,
      input.boundary_receipt,
      rotationId,
    )
    .run();
  if (result.meta.changes !== 1) {
    await assertMutationAvailable(database);
    const concurrent = await requiredRow(database, rotationId);
    return replayOrReject(
      concurrent,
      input.idempotency_key,
      digest,
      "verification",
    );
  }
  return document(await requiredRow(database, rotationId), "ok");
}

export async function revokeOldCredential(
  database: D1Database,
  rotationId: string,
  input: RevokeInput,
  observedAt: string,
): Promise<CredentialRotationDocument> {
  assertIdentity(input);
  await assertMutationAvailable(database);
  const row = await requiredRow(database, rotationId);
  assertRowIdentity(row, input);
  assertFingerprint(
    row.old_secret_hash,
    input.old_fingerprint,
    "stale_credential_identity",
  );
  assertFingerprint(
    row.replacement_secret_hash,
    input.replacement_fingerprint,
    "stale_credential_identity",
  );
  const digest = await requestDigest({
    action: "revoke",
    rotation_id: rotationId,
    ...safeProof(input),
    old_fingerprint: input.old_fingerprint,
    replacement_fingerprint: input.replacement_fingerprint,
  });
  if (row.revocation_idempotency_key !== null) {
    return replayOrReject(
      row,
      input.idempotency_key,
      digest,
      "revocation",
    );
  }
  if (row.state === "replacement_installed") {
    throw problem(
      "replacement_not_verified",
      "The old credential cannot be revoked before verification.",
    );
  }
  if (row.state !== "replacement_verified") {
    throw problem(
      "credential_mutation_conflict",
      "The rotation is not awaiting old credential revocation.",
    );
  }
  const result = await database
    .prepare(
      `UPDATE credential_rotations
       SET state = 'old_revoked', old_revoked_at = ?,
           revocation_idempotency_key = ?,
           revocation_request_digest = ?, revocation_receipt = ?
       WHERE id = ? AND state = 'replacement_verified'
         AND revocation_idempotency_key IS NULL
         AND EXISTS (
           SELECT 1 FROM operation_state
           WHERE singleton = 1 AND recovery_health = 'healthy'
         )`,
    )
    .bind(
      observedAt,
      input.idempotency_key,
      digest,
      input.boundary_receipt,
      rotationId,
    )
    .run();
  if (result.meta.changes !== 1) {
    await assertMutationAvailable(database);
    return replayOrReject(
      await requiredRow(database, rotationId),
      input.idempotency_key,
      digest,
      "revocation",
    );
  }
  return document(await requiredRow(database, rotationId), "ok");
}

export async function showCredentialRotation(
  database: D1Database,
  rotationId: string,
): Promise<CredentialRotationDocument> {
  return document(await requiredRow(database, rotationId), "ok");
}

export async function credentialSecretMatches(
  database: D1Database,
  credentialClass: CredentialClass,
  providedSecret: string,
  bootstrapSecrets: readonly (string | undefined)[],
): Promise<boolean> {
  const providedHash = await secretHash(providedSecret);
  const { results } = await database
    .prepare(
      `SELECT state, old_secret_hash, replacement_secret_hash
       FROM credential_rotations
       WHERE credential_class = ?
       ORDER BY installed_at, id`,
    )
    .bind(credentialClass)
    .all<AuthenticationRow>();
  let active = false;
  let revoked = false;
  for (const row of results) {
    const [oldMatch, replacementMatch] = await Promise.all([
      fixedHashEqual(providedHash, row.old_secret_hash),
      fixedHashEqual(providedHash, row.replacement_secret_hash),
    ]);
    if (oldMatch && row.state === "old_revoked") revoked = true;
    if (oldMatch && row.state !== "old_revoked") active = true;
    if (replacementMatch) active = true;
  }
  for (const bootstrap of bootstrapSecrets) {
    if (
      bootstrap !== undefined &&
      (await fixedHashEqual(providedHash, await secretHash(bootstrap)))
    ) {
      active = true;
    }
  }
  return active && !revoked;
}

function replayOrReject(
  row: RotationRow,
  key: string,
  digest: string,
  phase: "install" | "verification" | "revocation",
): CredentialRotationDocument {
  const storedKey =
    phase === "install"
      ? row.install_idempotency_key
      : phase === "verification"
        ? row.verification_idempotency_key
        : row.revocation_idempotency_key;
  const storedDigest =
    phase === "install"
      ? row.install_request_digest
      : phase === "verification"
        ? row.verification_request_digest
        : row.revocation_request_digest;
  if (storedKey === key && storedDigest === digest) {
    return document(row, "idempotent_replay");
  }
  if (storedKey === key || storedKey !== null) {
    throw problem(
      "idempotency_key_reused",
      "The idempotency key or transition identity was already used.",
    );
  }
  throw problem(
    "credential_mutation_conflict",
    "The credential rotation changed concurrently.",
  );
}

async function optionalRow(
  database: D1Database,
  id: string,
): Promise<RotationRow | null> {
  return database
    .prepare(`SELECT * FROM credential_rotations WHERE id = ?`)
    .bind(id)
    .first<RotationRow>();
}

async function requiredRow(
  database: D1Database,
  id: string,
): Promise<RotationRow> {
  const row = await optionalRow(database, id);
  if (row === null) {
    throw new CredentialRotationProblem(
      404,
      "credential_rotation_not_found",
      "The credential rotation does not exist.",
    );
  }
  return row;
}

async function rowByIdempotency(
  database: D1Database,
  key: string,
  phase: "install" | "verification" | "revocation",
): Promise<RotationRow | null> {
  const column = `${phase}_idempotency_key`;
  return database
    .prepare(`SELECT * FROM credential_rotations WHERE ${column} = ?`)
    .bind(key)
    .first<RotationRow>();
}

function document(
  row: RotationRow,
  operationCode: "ok" | "idempotent_replay",
): CredentialRotationDocument {
  return {
    contract: "card-keepr-credential-rotation@1",
    id: row.id,
    credential_class: row.credential_class,
    state: row.state,
    environment: row.environment,
    resource_identity: row.resource_identity,
    owning_boundary: row.owning_boundary,
    verification_target: row.verification_target,
    old_fingerprint: `sha256:${row.old_secret_hash}`,
    replacement_fingerprint: `sha256:${row.replacement_secret_hash}`,
    installed_at: row.installed_at,
    verified_at: row.verified_at,
    old_revoked_at: row.old_revoked_at,
    operation_code: operationCode,
  };
}

function assertIdentity(input: RotationIdentity): void {
  const expected = credentialBoundary(input.credential_class);
  if (
    input.environment !== expected.environment ||
    input.resource_identity !== expected.resource_identity ||
    input.owning_boundary !== expected.owning_boundary ||
    input.verification_target !== expected.verification_target
  ) {
    throw problem(
      "stale_credential_identity",
      "The resolved credential boundary identity is stale.",
    );
  }
}

function assertRowIdentity(row: RotationRow, input: RotationIdentity): void {
  if (row.credential_class !== input.credential_class) {
    throw problem(
      "credential_class_mismatch",
      "The credential class does not match the rotation.",
    );
  }
  if (
    row.environment !== input.environment ||
    row.resource_identity !== input.resource_identity ||
    row.owning_boundary !== input.owning_boundary ||
    row.verification_target !== input.verification_target
  ) {
    throw problem(
      "stale_credential_identity",
      "The resolved credential boundary identity is stale.",
    );
  }
}

function assertFingerprint(
  expectedHash: string,
  fingerprint: string,
  code: string,
): void {
  if (hashFromFingerprint(fingerprint) !== expectedHash) {
    throw problem(code, "The expected credential fingerprint is stale.");
  }
}

function hashFromFingerprint(fingerprint: string): string {
  const match = /^sha256:([0-9a-f]{64})$/.exec(fingerprint);
  if (match === null) {
    throw new CredentialRotationProblem(
      422,
      "invalid_credential_fingerprint",
      "Credential fingerprints must be full SHA-256 fingerprints.",
    );
  }
  return match[1]!;
}

function safeProof(input: TransitionProof): Record<string, string> {
  return {
    credential_class: input.credential_class,
    environment: input.environment,
    resource_identity: input.resource_identity,
    owning_boundary: input.owning_boundary,
    verification_target: input.verification_target,
    idempotency_key: input.idempotency_key,
    boundary_receipt: input.boundary_receipt,
  };
}

async function requestDigest(value: unknown): Promise<string> {
  return secretHash(JSON.stringify(value));
}

async function assertMutationAvailable(database: D1Database): Promise<void> {
  const operation = await database
    .prepare(
      "SELECT recovery_health FROM operation_state WHERE singleton = 1",
    )
    .first<{ recovery_health: string }>();
  if (operation?.recovery_health === "blocked") {
    throw problem(
      "recovery_in_progress",
      "Credential mutation is blocked during recovery.",
    );
  }
  if (operation?.recovery_health !== "healthy") {
    throw problem(
      "recovery_not_verified",
      "Credential mutation requires healthy verified recovery.",
    );
  }
}

async function secretHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function fixedHashEqual(left: string, right: string): Promise<boolean> {
  return crypto.subtle.timingSafeEqual(hashBytes(left), hashBytes(right));
}

function hashBytes(hash: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hash)) return new Uint8Array(32);
  return Uint8Array.from(
    hash.match(/../g)!.map((byte) => Number.parseInt(byte, 16)),
  );
}

function problem(code: string, detail: string): CredentialRotationProblem {
  return new CredentialRotationProblem(409, code, detail);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
