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
};

const credentialBoundaries: Record<CredentialClass, CredentialBoundary> = {
  api_bearer_key: {
    environment: "production",
    resource_identity: "worker:card-keepr-api",
    owning_boundary: "api_worker",
  },
  ingestion_admin_key: {
    environment: "production",
    resource_identity: "worker:card-keepr-ingestion",
    owning_boundary: "ingestion_worker",
  },
  d1_export_token: {
    environment: "production",
    resource_identity: "d1:card-keepr-catalogue",
    owning_boundary: "d1_export_operation",
  },
  d1_verification_token: {
    environment: "production",
    resource_identity: "d1:disposable-verification",
    owning_boundary: "disposable_verification",
  },
  github_deployment_token: {
    environment: "production",
    resource_identity: "worker-release:card-keepr",
    owning_boundary: "production_release_workflow",
  },
};

type RotationIdentity = CredentialBoundary & {
  credential_class: CredentialClass;
};

type InstallCredentialRotation = RotationIdentity & {
  rotation_id: string;
  expected_old_fingerprint: string;
  old_secret: string;
  replacement_secret: string;
};

type VerifyCredentialRotation = RotationIdentity & {
  replacement_secret: string;
};

type RevokeCredentialRotation = RotationIdentity & {
  expected_old_fingerprint: string;
};

type CredentialRotationRow = {
  id: string;
  credential_class: CredentialClass;
  state: CredentialRotationState;
  environment: "production";
  resource_identity: string;
  owning_boundary: string;
  old_secret_hash: string;
  replacement_secret_hash: string;
  installed_at: string;
  verified_at: string | null;
  old_revoked_at: string | null;
};

type AuthenticationRotationRow = Pick<
  CredentialRotationRow,
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
  old_fingerprint: string;
  replacement_fingerprint: string;
  installed_at: string;
  verified_at: string | null;
  old_revoked_at: string | null;
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

export function isCredentialClass(
  value: string,
): value is CredentialClass {
  return credentialClasses.some(
    (credentialClass) => credentialClass === value,
  );
}

export function credentialBoundary(
  credentialClass: CredentialClass,
): CredentialBoundary {
  return credentialBoundaries[credentialClass];
}

export async function installCredentialRotation(
  database: D1Database,
  input: InstallCredentialRotation,
  observedAt: string,
): Promise<CredentialRotationDocument> {
  assertResolvedIdentity(input);
  await assertMutationAvailable(database);

  const [oldHash, replacementHash] = await Promise.all([
    secretHash(input.old_secret),
    secretHash(input.replacement_secret),
  ]);
  if (await fixedHashEqual(oldHash, replacementHash)) {
    throw new CredentialRotationProblem(
      409,
      "replacement_matches_old_credential",
      "The replacement credential must differ from the old credential.",
    );
  }
  if (
    input.expected_old_fingerprint !==
    fingerprintFromHash(oldHash)
  ) {
    throw new CredentialRotationProblem(
      409,
      "stale_credential_identity",
      "The expected old credential fingerprint is stale.",
    );
  }

  try {
    const result = await database
      .prepare(
        `INSERT INTO credential_rotations (
          id,
          credential_class,
          state,
          environment,
          resource_identity,
          owning_boundary,
          old_secret_hash,
          replacement_secret_hash,
          installed_at
        )
        SELECT ?, ?, 'replacement_installed', ?, ?, ?, ?, ?, ?
        FROM operation_state
        WHERE singleton = 1 AND recovery_health = 'healthy'`,
      )
      .bind(
        input.rotation_id,
        input.credential_class,
        input.environment,
        input.resource_identity,
        input.owning_boundary,
        oldHash,
        replacementHash,
        observedAt,
      )
      .run();
    if (result.meta.changes !== 1) {
      await assertMutationAvailable(database);
      throw new CredentialRotationProblem(
        409,
        "credential_mutation_conflict",
        "The credential rotation could not reserve its mutation state.",
      );
    }
  } catch (error) {
    const message = errorMessage(error);
    if (
      message.includes("credential_rotations.id") ||
      message.includes("credential_rotations.credential_class")
    ) {
      throw new CredentialRotationProblem(
        409,
        "credential_mutation_conflict",
        "A conflicting credential rotation already exists.",
      );
    }
    throw error;
  }

  return requiredRotation(database, input.rotation_id);
}

export async function verifyCredentialRotation(
  database: D1Database,
  rotationId: string,
  input: VerifyCredentialRotation,
  observedAt: string,
): Promise<CredentialRotationDocument> {
  assertResolvedIdentity(input);
  await assertMutationAvailable(database);
  const rotation = await requiredRotationRow(database, rotationId);
  assertRotationIdentity(rotation, input);
  if (rotation.state !== "replacement_installed") {
    throw new CredentialRotationProblem(
      409,
      "credential_mutation_conflict",
      "The credential rotation is not awaiting replacement verification.",
    );
  }
  const replacementHash = await secretHash(input.replacement_secret);
  if (
    !(await fixedHashEqual(
      replacementHash,
      rotation.replacement_secret_hash,
    ))
  ) {
    throw new CredentialRotationProblem(
      409,
      "replacement_verification_failed",
      "The replacement credential failed its owning-boundary verification.",
    );
  }

  const result = await database
    .prepare(
      `UPDATE credential_rotations
       SET state = 'replacement_verified', verified_at = ?
       WHERE id = ? AND state = 'replacement_installed'
         AND EXISTS (
           SELECT 1 FROM operation_state
           WHERE singleton = 1 AND recovery_health = 'healthy'
         )`,
    )
    .bind(observedAt, rotationId)
    .run();
  if (result.meta.changes !== 1) {
    await assertMutationAvailable(database);
    throw new CredentialRotationProblem(
      409,
      "credential_mutation_conflict",
      "The credential rotation changed during verification.",
    );
  }
  return requiredRotation(database, rotationId);
}

export async function revokeOldCredential(
  database: D1Database,
  rotationId: string,
  input: RevokeCredentialRotation,
  observedAt: string,
): Promise<CredentialRotationDocument> {
  assertResolvedIdentity(input);
  await assertMutationAvailable(database);
  const rotation = await requiredRotationRow(database, rotationId);
  assertRotationIdentity(rotation, input);
  if (
    input.expected_old_fingerprint !==
    fingerprintFromHash(rotation.old_secret_hash)
  ) {
    throw new CredentialRotationProblem(
      409,
      "stale_credential_identity",
      "The expected old credential fingerprint is stale.",
    );
  }
  if (rotation.state === "replacement_installed") {
    throw new CredentialRotationProblem(
      409,
      "replacement_not_verified",
      "The old credential cannot be revoked before replacement verification.",
    );
  }
  if (rotation.state !== "replacement_verified") {
    throw new CredentialRotationProblem(
      409,
      "credential_mutation_conflict",
      "The credential rotation is not awaiting old credential revocation.",
    );
  }

  const result = await database
    .prepare(
      `UPDATE credential_rotations
       SET state = 'old_revoked', old_revoked_at = ?
       WHERE id = ? AND state = 'replacement_verified'
         AND EXISTS (
           SELECT 1 FROM operation_state
           WHERE singleton = 1 AND recovery_health = 'healthy'
         )`,
    )
    .bind(observedAt, rotationId)
    .run();
  if (result.meta.changes !== 1) {
    await assertMutationAvailable(database);
    throw new CredentialRotationProblem(
      409,
      "credential_mutation_conflict",
      "The credential rotation changed during revocation.",
    );
  }
  return requiredRotation(database, rotationId);
}

export async function showCredentialRotation(
  database: D1Database,
  rotationId: string,
): Promise<CredentialRotationDocument> {
  return requiredRotation(database, rotationId);
}

export async function credentialSecretMatches(
  database: D1Database,
  credentialClass: CredentialClass,
  providedSecret: string,
  bootstrapSecret: string,
): Promise<boolean> {
  const providedHash = await secretHash(providedSecret);
  const bootstrapHash = await secretHash(bootstrapSecret);
  const { results } = await database
    .prepare(
      `SELECT state, old_secret_hash, replacement_secret_hash
       FROM credential_rotations
       WHERE credential_class = ?
       ORDER BY installed_at, id`,
    )
    .bind(credentialClass)
    .all<AuthenticationRotationRow>();

  let activeMatch = false;
  let providedRevoked = false;
  for (const rotation of results) {
    const [matchesOld, matchesReplacement] = await Promise.all([
      fixedHashEqual(providedHash, rotation.old_secret_hash),
      fixedHashEqual(providedHash, rotation.replacement_secret_hash),
    ]);
    if (matchesOld && rotation.state !== "old_revoked") {
      activeMatch = true;
    }
    if (matchesOld && rotation.state === "old_revoked") {
      providedRevoked = true;
    }
    if (matchesReplacement) activeMatch = true;
  }

  const matchesBootstrap = await fixedHashEqual(
    providedHash,
    bootstrapHash,
  );
  return !providedRevoked && (activeMatch || matchesBootstrap);
}

async function requiredRotation(
  database: D1Database,
  rotationId: string,
): Promise<CredentialRotationDocument> {
  return rotationDocument(
    await requiredRotationRow(database, rotationId),
  );
}

async function requiredRotationRow(
  database: D1Database,
  rotationId: string,
): Promise<CredentialRotationRow> {
  const rotation = await database
    .prepare(
      `SELECT
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
       FROM credential_rotations
       WHERE id = ?`,
    )
    .bind(rotationId)
    .first<CredentialRotationRow>();
  if (rotation === null) {
    throw new CredentialRotationProblem(
      404,
      "credential_rotation_not_found",
      "The credential rotation does not exist.",
    );
  }
  return rotation;
}

function rotationDocument(
  rotation: CredentialRotationRow,
): CredentialRotationDocument {
  return {
    contract: "card-keepr-credential-rotation@1",
    id: rotation.id,
    credential_class: rotation.credential_class,
    state: rotation.state,
    environment: rotation.environment,
    resource_identity: rotation.resource_identity,
    owning_boundary: rotation.owning_boundary,
    old_fingerprint: fingerprintFromHash(rotation.old_secret_hash),
    replacement_fingerprint: fingerprintFromHash(
      rotation.replacement_secret_hash,
    ),
    installed_at: rotation.installed_at,
    verified_at: rotation.verified_at,
    old_revoked_at: rotation.old_revoked_at,
  };
}

function assertResolvedIdentity(input: RotationIdentity): void {
  const expected = credentialBoundary(input.credential_class);
  if (
    input.environment !== expected.environment ||
    input.resource_identity !== expected.resource_identity ||
    input.owning_boundary !== expected.owning_boundary
  ) {
    throw new CredentialRotationProblem(
      409,
      "stale_credential_identity",
      "The resolved environment or resource identity is stale.",
    );
  }
}

function assertRotationIdentity(
  rotation: CredentialRotationRow,
  input: RotationIdentity,
): void {
  if (rotation.credential_class !== input.credential_class) {
    throw new CredentialRotationProblem(
      409,
      "credential_class_mismatch",
      "The credential class does not match the rotation.",
    );
  }
  if (
    rotation.environment !== input.environment ||
    rotation.resource_identity !== input.resource_identity ||
    rotation.owning_boundary !== input.owning_boundary
  ) {
    throw new CredentialRotationProblem(
      409,
      "stale_credential_identity",
      "The resolved environment or resource identity is stale.",
    );
  }
}

async function assertMutationAvailable(
  database: D1Database,
): Promise<void> {
  const operation = await database
    .prepare(
      `SELECT recovery_health
       FROM operation_state
       WHERE singleton = 1`,
    )
    .first<{ recovery_health: string }>();
  if (operation?.recovery_health === "blocked") {
    throw new CredentialRotationProblem(
      409,
      "recovery_in_progress",
      "Credential mutation is blocked during recovery.",
    );
  }
  if (operation?.recovery_health !== "healthy") {
    throw new CredentialRotationProblem(
      409,
      "recovery_not_verified",
      "Credential mutation requires healthy verified recovery.",
    );
  }
}

async function secretHash(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function fixedHashEqual(
  left: string,
  right: string,
): Promise<boolean> {
  const leftBytes = hashBytes(left);
  const rightBytes = hashBytes(right);
  return crypto.subtle.timingSafeEqual(leftBytes, rightBytes);
}

function hashBytes(hash: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    return new Uint8Array(32);
  }
  return Uint8Array.from(
    hash.match(/../g)!.map((byte) => Number.parseInt(byte, 16)),
  );
}

function fingerprintFromHash(hash: string): string {
  return `sha256:${hash.slice(0, 24)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
