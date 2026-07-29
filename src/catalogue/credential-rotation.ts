import {
  credentialClasses,
  isCredentialClass as isSharedCredentialClass,
  resolveCredentialIdentity,
  type CredentialClass,
  type CredentialDeploymentContext,
} from "../credentials/credential-catalogue.mjs";

export { credentialClasses };
export type { CredentialClass };
export type CredentialRotationState =
  | "replacement_installed"
  | "replacement_verified"
  | "old_revoked";

export type CredentialRotationPlanAction =
  | "install"
  | "verify"
  | "revoke";

export type CredentialRotationPlanInput = {
  action: CredentialRotationPlanAction;
  rotation_id: string;
  credential_class: CredentialClass;
  environment: "production";
  cloudflare_account_id: string;
  resource_identity: string;
  owning_boundary: string;
  verification_target: string;
  expected_catalogue_revision_id: string;
  expected_state_generation: number;
  old_fingerprint: string;
  replacement_fingerprint: string;
  old_issuer_credential_id: string;
  replacement_issuer_credential_id: string;
  management_credential_id: string;
  idempotency_key: string;
};

export type CredentialRotationPlanDocument =
  CredentialRotationPlanInput & {
    contract: "card-keepr-credential-rotation-plan@1";
    id: string;
    required_permission: string;
    consumer_installation_identity: string;
    expected_rotation_state: CredentialRotationState | null;
    plan_nonce: string;
    plan_digest: string;
    status: "reserved" | "executing" | "finalized" | "expired";
    created_at: string;
    expires_at: string;
    execution_started_at: string | null;
    execution_expires_at: string | null;
    execution_attempt: number;
    execution_mode: "mutation" | "reconciliation" | null;
  };

type CredentialRotationPlanRow = Omit<
  CredentialRotationPlanDocument,
  "contract" | "expected_state_generation"
> & {
  expected_state_generation: number;
  request_digest: string;
  finalized_at: string | null;
  attestation_digest: string | null;
};

type CredentialBoundaryAttestation = {
  version: 1;
  plan_id: string;
  plan_digest: string;
  plan_nonce: string;
  action: CredentialRotationPlanAction;
  credential_class: CredentialClass;
  cloudflare_account_id: string;
  resource_identity: string;
  verification_target: string;
  required_permission: string;
  consumer_installation_identity: string;
  old_fingerprint: string;
  replacement_fingerprint: string;
  installed_fingerprint: string;
  old_issuer_credential_id: string;
  replacement_issuer_credential_id: string;
  management_credential_id: string;
  consumer_installation_id: string;
  scope_evidence_digest: string;
  old_credential_status: "usable" | "unusable";
  replacement_credential_status: "usable";
  observed_at: string;
  execution_attempt: number;
  execution_mode: "mutation" | "reconciliation";
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
  return isSharedCredentialClass(value);
}

export async function reserveCredentialRotationPlan(
  database: D1Database,
  input: CredentialRotationPlanInput,
  context: CredentialDeploymentContext,
  observedAt: string,
): Promise<CredentialRotationPlanDocument> {
  const expectedIdentity = resolveCredentialIdentity(
    input.credential_class,
    context,
  );
  if (
    input.environment !== expectedIdentity.environment ||
    input.cloudflare_account_id !==
      expectedIdentity.cloudflare_account_id ||
    input.resource_identity !== expectedIdentity.resource_identity ||
    input.owning_boundary !== expectedIdentity.owning_boundary ||
    input.verification_target !== expectedIdentity.verification_target
  ) {
    throw problem(
      "identity_conflict",
      "The resolved credential boundary identity is stale.",
    );
  }
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
  if (
    !safeProviderIdentity(input.old_issuer_credential_id) ||
    !safeProviderIdentity(input.replacement_issuer_credential_id) ||
    !safeProviderIdentity(input.management_credential_id) ||
    input.old_issuer_credential_id ===
      input.replacement_issuer_credential_id ||
    input.management_credential_id ===
      input.old_issuer_credential_id ||
    input.management_credential_id ===
      input.replacement_issuer_credential_id
  ) {
    throw new CredentialRotationProblem(
      422,
      "invalid_provider_credential_identity",
      "Provider credential identities must be exact, safe, and distinct.",
    );
  }
  const requestHash = await requestDigest(input);
  const existing = await database
    .prepare(
      `SELECT * FROM credential_rotation_plans
       WHERE idempotency_key = ?`,
    )
    .bind(input.idempotency_key)
    .first<CredentialRotationPlanRow>();
  if (existing !== null) {
    if (
      !(await fixedHashEqual(existing.request_digest, requestHash))
    ) {
      throw problem(
        "idempotency_key_reused",
        "The idempotency key was already used for another plan.",
      );
    }
    return planDocument(existing);
  }
  const state = await currentCredentialMutationState(database);
  if (state.recovery_health === "blocked") {
    throw problem(
      "recovery_in_progress",
      "Credential mutation is blocked during recovery.",
    );
  }
  if (state.recovery_health !== "healthy") {
    throw problem(
      "recovery_not_verified",
      "Credential mutation requires healthy verified recovery.",
    );
  }
  if (state.active_ingestion_run_id !== null) {
    throw problem(
      "active_ingestion_run",
      "Credential mutation requires idle ingestion.",
    );
  }
  if (
    state.current_revision_id !==
      input.expected_catalogue_revision_id
  ) {
    throw problem(
      "current_revision_mismatch",
      "The expected current Catalogue Revision is stale.",
    );
  }
  if (
    state.credential_rotation_generation !==
    input.expected_state_generation
  ) {
    throw problem(
      "credential_state_generation_mismatch",
      "The expected credential state generation is stale.",
    );
  }

  const expectedRotationState = await expectedStateForAction(
    database,
    input,
  );

  await database
    .prepare(
      `UPDATE credential_rotation_plans
       SET status = 'expired'
       WHERE status = 'reserved' AND expires_at <= ?`,
    )
    .bind(observedAt)
    .run();
  const planNonce = randomHex(32);
  const planId = `credplan_${crypto.randomUUID()}`;
  const planDigest = await requestDigest({
    id: planId,
    request_digest: requestHash,
    plan_nonce: planNonce,
    required_permission: expectedIdentity.required_permission,
    consumer_installation_identity:
      expectedIdentity.consumer_installation_identity,
    expected_rotation_state: expectedRotationState,
  });
  const expiresAt = new Date(
    Date.parse(observedAt) + 5 * 60 * 1000,
  ).toISOString();
  try {
    await database
      .prepare(
        `INSERT INTO credential_rotation_plans (
          id, action, rotation_id, credential_class, environment,
          cloudflare_account_id, resource_identity, owning_boundary,
          verification_target, required_permission,
          consumer_installation_identity,
          expected_catalogue_revision_id, expected_state_generation,
          expected_rotation_state, old_fingerprint,
          replacement_fingerprint, old_issuer_credential_id,
          replacement_issuer_credential_id, management_credential_id,
          idempotency_key, request_digest,
          plan_nonce, plan_digest, status, created_at, expires_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?,
          'reserved', ?, ?
        )`,
      )
      .bind(
        planId,
        input.action,
        input.rotation_id,
        input.credential_class,
        input.environment,
        input.cloudflare_account_id,
        input.resource_identity,
        input.owning_boundary,
        input.verification_target,
        expectedIdentity.required_permission,
        expectedIdentity.consumer_installation_identity,
        input.expected_catalogue_revision_id,
        input.expected_state_generation,
        expectedRotationState,
        input.old_fingerprint,
        input.replacement_fingerprint,
        input.old_issuer_credential_id,
        input.replacement_issuer_credential_id,
        input.management_credential_id,
        input.idempotency_key,
        requestHash,
        planNonce,
        planDigest,
        observedAt,
        expiresAt,
      )
      .run();
  } catch (error) {
    if (errorMessage(error).includes("UNIQUE constraint")) {
      throw problem(
        "credential_mutation_conflict",
        "Another credential transition is already reserved.",
      );
    }
    throw error;
  }
  return planDocument(
    (await database
      .prepare(
        "SELECT * FROM credential_rotation_plans WHERE id = ?",
      )
      .bind(planId)
      .first<CredentialRotationPlanRow>())!,
  );
}

export async function finalizeCredentialRotationPlan(
  database: D1Database,
  planId: string,
  planDigest: string,
  attestation: string,
  attestationKey: string,
  observedAt: string,
): Promise<CredentialRotationDocument> {
  const plan = await requiredPlan(database, planId);
  if (!(await fixedHashEqual(plan.plan_digest, planDigest))) {
    throw problem(
      "credential_plan_digest_mismatch",
      "The credential transition plan digest is stale.",
    );
  }
  const attestationDigest = await secretHash(attestation);
  if (plan.status === "finalized") {
    if (
      plan.attestation_digest === null ||
      !(await fixedHashEqual(
        plan.attestation_digest,
        attestationDigest,
      ))
    ) {
      throw problem(
        "credential_attestation_replayed",
        "The finalized plan cannot accept another attestation.",
      );
    }
    return document(
      await requiredRow(database, plan.rotation_id),
      "idempotent_replay",
    );
  }
  if (plan.status !== "executing") {
    throw problem(
      "credential_plan_expired",
      "The credential transition plan is no longer executable.",
    );
  }
  await verifyBoundaryAttestation(
    plan,
    attestation,
    attestationKey,
    observedAt,
  );
  const oldHash = hashFromFingerprint(plan.old_fingerprint);
  const replacementHash = hashFromFingerprint(
    plan.replacement_fingerprint,
  );
  const rotationStatement =
    plan.action === "install"
      ? database
          .prepare(
            `INSERT INTO credential_rotations (
              id, credential_class, state, environment,
              resource_identity, owning_boundary, verification_target,
              old_secret_hash, replacement_secret_hash, installed_at,
              install_idempotency_key, install_request_digest,
              install_receipt
            ) VALUES (
              ?, ?, 'replacement_installed', ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?
            )`,
          )
          .bind(
            plan.rotation_id,
            plan.credential_class,
            plan.environment,
            plan.resource_identity,
            plan.owning_boundary,
            plan.verification_target,
            oldHash,
            replacementHash,
            observedAt,
            plan.idempotency_key,
            plan.request_digest,
            attestation,
          )
      : plan.action === "verify"
        ? database
            .prepare(
              `UPDATE credential_rotations
               SET state = 'replacement_verified', verified_at = ?,
                   verification_idempotency_key = ?,
                   verification_request_digest = ?,
                   verification_receipt = ?
               WHERE id = ? AND state = 'replacement_installed'
                 AND replacement_secret_hash = ?`,
            )
            .bind(
              observedAt,
              plan.idempotency_key,
              plan.request_digest,
              attestation,
              plan.rotation_id,
              replacementHash,
            )
        : database
            .prepare(
              `UPDATE credential_rotations
               SET state = 'old_revoked', old_revoked_at = ?,
                   revocation_idempotency_key = ?,
                   revocation_request_digest = ?,
                   revocation_receipt = ?
               WHERE id = ? AND state = 'replacement_verified'
                 AND old_secret_hash = ?
                 AND replacement_secret_hash = ?`,
            )
            .bind(
              observedAt,
              plan.idempotency_key,
              plan.request_digest,
              attestation,
              plan.rotation_id,
              oldHash,
              replacementHash,
            );
  try {
    const results = await database.batch([
      rotationStatement,
      database
        .prepare(
          `UPDATE operation_state
           SET credential_rotation_generation =
             credential_rotation_generation + 1
           WHERE singleton = 1
             AND credential_rotation_generation = ?`,
        )
        .bind(plan.expected_state_generation),
      database
        .prepare(
          `UPDATE credential_rotation_plans
           SET status = 'finalized', finalized_at = ?,
               attestation_digest = ?
           WHERE id = ? AND status = 'executing'
             AND plan_digest = ?`,
        )
        .bind(
          observedAt,
          attestationDigest,
          plan.id,
          plan.plan_digest,
        ),
    ]);
    if (results.some((result) => result.meta.changes !== 1)) {
      throw problem(
        "credential_mutation_conflict",
        "The reserved credential transition changed concurrently.",
      );
    }
  } catch (error) {
    if (error instanceof CredentialRotationProblem) throw error;
    throw problem(
      "credential_mutation_conflict",
      "The reserved credential transition could not finalize atomically.",
    );
  }
  return document(await requiredRow(database, plan.rotation_id), "ok");
}

export async function beginCredentialRotationPlanExecution(
  database: D1Database,
  planId: string,
  planDigest: string,
  observedAt: string,
): Promise<CredentialRotationPlanDocument> {
  const plan = await requiredPlan(database, planId);
  if (!(await fixedHashEqual(plan.plan_digest, planDigest))) {
    throw problem(
      "credential_plan_digest_mismatch",
      "The credential transition plan digest is stale.",
    );
  }
  if (
    !["reserved", "executing"].includes(plan.status) ||
    (plan.status === "reserved" && plan.expires_at <= observedAt)
  ) {
    throw problem(
      "credential_plan_expired",
      "The credential transition plan is no longer executable.",
    );
  }
  const executionExpiresAt = new Date(
    Date.parse(observedAt) + 10 * 60 * 1000,
  ).toISOString();
  let result: D1Result<unknown>;
  try {
    result = await database
      .prepare(
      `UPDATE credential_rotation_plans
       SET status = 'executing', execution_started_at = ?,
           execution_expires_at = ?, execution_attempt =
             execution_attempt + 1
       WHERE id = ?
         AND status IN ('reserved', 'executing')
         AND (status = 'executing' OR expires_at > ?)
         AND plan_digest = ?
         AND (
           status = 'executing'
           OR EXISTS (
           SELECT 1
           FROM operation_state AS operation
           JOIN catalogue_state AS catalogue ON catalogue.singleton = 1
           WHERE operation.singleton = 1
             AND operation.recovery_health = 'healthy'
             AND operation.active_ingestion_run_id IS NULL
             AND operation.credential_rotation_generation =
               credential_rotation_plans.expected_state_generation
             AND catalogue.current_revision_id =
               credential_rotation_plans.expected_catalogue_revision_id
             AND (
               (
                 credential_rotation_plans.action = 'install'
                 AND NOT EXISTS (
                   SELECT 1 FROM credential_rotations AS rotation
                   WHERE rotation.id =
                     credential_rotation_plans.rotation_id
                 )
               )
               OR EXISTS (
                 SELECT 1 FROM credential_rotations AS rotation
                 WHERE rotation.id =
                   credential_rotation_plans.rotation_id
                   AND rotation.credential_class =
                     credential_rotation_plans.credential_class
                   AND rotation.environment =
                     credential_rotation_plans.environment
                   AND rotation.resource_identity =
                     credential_rotation_plans.resource_identity
                   AND rotation.owning_boundary =
                     credential_rotation_plans.owning_boundary
                   AND rotation.verification_target =
                     credential_rotation_plans.verification_target
                   AND rotation.old_secret_hash =
                     substr(credential_rotation_plans.old_fingerprint, 8)
                   AND rotation.replacement_secret_hash =
                     substr(
                       credential_rotation_plans.replacement_fingerprint,
                       8
                     )
                   AND rotation.state =
                     credential_rotation_plans.expected_rotation_state
               )
             )
           )
         )`,
    )
      .bind(
        observedAt,
        executionExpiresAt,
        plan.id,
        observedAt,
        plan.plan_digest,
      )
      .run();
  } catch (error) {
    if (errorMessage(error).includes("UNIQUE constraint")) {
      throw problem(
        "credential_mutation_conflict",
        "Another credential execution claim is active.",
      );
    }
    throw error;
  }
  if (result.meta.changes !== 1) {
    await assertExecutionSnapshot(database, plan, observedAt);
    throw problem(
      "credential_mutation_conflict",
      "Another credential execution claim is active.",
    );
  }
  return planDocument(await requiredPlan(database, plan.id));
}

export async function releaseCredentialRotationPlanExecution(
  database: D1Database,
  planId: string,
  planDigest: string,
  observedAt: string,
): Promise<CredentialRotationPlanDocument> {
  const plan = await requiredPlan(database, planId);
  if (!(await fixedHashEqual(plan.plan_digest, planDigest))) {
    throw problem(
      "credential_plan_digest_mismatch",
      "The credential transition plan digest is stale.",
    );
  }
  if (
    plan.status !== "executing" ||
    plan.execution_attempt !== 1
  ) {
    throw problem(
      "illegal_rotation_transition",
      "Only the initial failed execution may be safely released.",
    );
  }
  const retryExpiresAt = new Date(
    Date.parse(observedAt) + 5 * 60 * 1000,
  ).toISOString();
  const result = await database
    .prepare(
      `UPDATE credential_rotation_plans
       SET status = 'reserved', execution_started_at = NULL,
           execution_expires_at = NULL, execution_attempt = 0,
           expires_at = ?
       WHERE id = ? AND status = 'executing'
         AND execution_attempt = 1 AND plan_digest = ?`,
    )
    .bind(retryExpiresAt, plan.id, plan.plan_digest)
    .run();
  if (result.meta.changes !== 1) {
    throw problem(
      "credential_mutation_conflict",
      "The execution release changed concurrently.",
    );
  }
  return planDocument(await requiredPlan(database, plan.id));
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
      "rotation_not_found",
      "The credential rotation does not exist.",
    );
  }
  return row;
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

async function assertFingerprint(
  expectedHash: string,
  fingerprint: string,
  code: string,
): Promise<void> {
  if (
    !(await fixedHashEqual(
      hashFromFingerprint(fingerprint),
      expectedHash,
    ))
  ) {
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

async function requestDigest(value: unknown): Promise<string> {
  return secretHash(JSON.stringify(value));
}

async function currentCredentialMutationState(
  database: D1Database,
): Promise<{
  active_ingestion_run_id: string | null;
  recovery_health: string;
  credential_rotation_generation: number;
  current_revision_id: string;
}> {
  const state = await database
    .prepare(
      `SELECT operation.active_ingestion_run_id,
              operation.recovery_health,
              operation.credential_rotation_generation,
              catalogue.current_revision_id
       FROM operation_state AS operation
       JOIN catalogue_state AS catalogue ON catalogue.singleton = 1
       WHERE operation.singleton = 1`,
    )
    .first<{
      active_ingestion_run_id: string | null;
      recovery_health: string;
      credential_rotation_generation: number;
      current_revision_id: string;
    }>();
  if (state === null) {
    throw problem(
      "credential_mutation_conflict",
      "The credential mutation state is unavailable.",
    );
  }
  return state;
}

async function requiredPlan(
  database: D1Database,
  planId: string,
): Promise<CredentialRotationPlanRow> {
  const plan = await database
    .prepare(
      "SELECT * FROM credential_rotation_plans WHERE id = ?",
    )
    .bind(planId)
    .first<CredentialRotationPlanRow>();
  if (plan === null) {
    throw new CredentialRotationProblem(
      404,
      "credential_rotation_plan_not_found",
      "The credential transition plan does not exist.",
    );
  }
  return plan;
}

async function verifyBoundaryAttestation(
  plan: CredentialRotationPlanRow,
  encoded: string,
  key: string,
  observedAt: string,
): Promise<void> {
  const match = /^v1\.([A-Za-z0-9_-]{32,8192})\.([0-9a-f]{64})$/.exec(
    encoded,
  );
  if (match === null) {
    throw problem(
      "invalid_boundary_attestation",
      "The owning-boundary attestation is malformed.",
    );
  }
  const expectedSignature = await hmacHex(key, match[1]!);
  if (!(await fixedHashEqual(match[2]!, expectedSignature))) {
    throw problem(
      "invalid_boundary_attestation",
      "The owning-boundary attestation signature is invalid.",
    );
  }
  let attestation: CredentialBoundaryAttestation;
  try {
    attestation = JSON.parse(
      new TextDecoder().decode(base64UrlBytes(match[1]!)),
    ) as CredentialBoundaryAttestation;
  } catch {
    throw problem(
      "invalid_boundary_attestation",
      "The owning-boundary attestation payload is invalid.",
    );
  }
  const expectedOldStatus =
    plan.action === "revoke" ? "unusable" : "usable";
  const exactFields =
    attestation.version === 1 &&
    attestation.plan_id === plan.id &&
    attestation.action === plan.action &&
    attestation.credential_class === plan.credential_class &&
    attestation.cloudflare_account_id ===
      plan.cloudflare_account_id &&
    attestation.resource_identity === plan.resource_identity &&
    attestation.verification_target === plan.verification_target &&
    attestation.required_permission === plan.required_permission &&
    attestation.consumer_installation_identity ===
      plan.consumer_installation_identity &&
    attestation.consumer_installation_id ===
      plan.consumer_installation_identity &&
    attestation.old_issuer_credential_id ===
      plan.old_issuer_credential_id &&
    attestation.replacement_issuer_credential_id ===
      plan.replacement_issuer_credential_id &&
    attestation.management_credential_id ===
      plan.management_credential_id &&
    attestation.old_credential_status === expectedOldStatus &&
    attestation.replacement_credential_status === "usable" &&
    attestation.execution_attempt === plan.execution_attempt &&
    attestation.execution_mode ===
      (plan.execution_attempt === 1
        ? "mutation"
        : "reconciliation") &&
    plan.execution_started_at !== null &&
    plan.execution_expires_at !== null &&
    canonicalTimestamp(attestation.observed_at) &&
    attestation.observed_at >= plan.execution_started_at &&
    attestation.observed_at <= plan.execution_expires_at &&
    attestation.observed_at <= observedAt &&
    safeProviderIdentity(attestation.old_issuer_credential_id) &&
    safeProviderIdentity(
      attestation.replacement_issuer_credential_id,
    ) &&
    safeProviderIdentity(attestation.management_credential_id) &&
    safeProviderIdentity(attestation.consumer_installation_id) &&
    /^sha256:[0-9a-f]{64}$/.test(
      attestation.scope_evidence_digest,
    );
  const fixedFields = await Promise.all([
    fixedHashEqual(attestation.plan_digest, plan.plan_digest),
    fixedHashEqual(attestation.plan_nonce, plan.plan_nonce),
    fixedHashEqual(
      hashFromFingerprint(attestation.old_fingerprint),
      hashFromFingerprint(plan.old_fingerprint),
    ),
    fixedHashEqual(
      hashFromFingerprint(attestation.replacement_fingerprint),
      hashFromFingerprint(plan.replacement_fingerprint),
    ),
    fixedHashEqual(
      hashFromFingerprint(attestation.installed_fingerprint),
      hashFromFingerprint(plan.replacement_fingerprint),
    ),
  ]);
  if (!exactFields || fixedFields.some((matches) => !matches)) {
    throw problem(
      "credential_boundary_mismatch",
      "The owning-boundary attestation does not match the reserved transition.",
    );
  }
  if (
    plan.action === "revoke" &&
    attestation.old_issuer_credential_id ===
      attestation.replacement_issuer_credential_id
  ) {
    throw problem(
      "credential_boundary_mismatch",
      "The revoked and replacement issuer identities must differ.",
    );
  }
}

async function hmacHex(key: string, value: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function base64UrlBytes(value: string): Uint8Array {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) =>
    character.charCodeAt(0),
  );
}

function safeProviderIdentity(value: string): boolean {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9._:/-]{8,256}$/.test(value)
  );
}

function canonicalTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return (
    Number.isFinite(parsed.valueOf()) &&
    parsed.toISOString() === value
  );
}

async function expectedStateForAction(
  database: D1Database,
  input: CredentialRotationPlanInput,
): Promise<CredentialRotationState | null> {
  const rotation = await optionalRow(database, input.rotation_id);
  if (input.action === "install") {
    if (rotation !== null) {
      throw problem(
        "identity_conflict",
        "The credential rotation already exists.",
      );
    }
    return null;
  }
  if (rotation === null) {
    throw new CredentialRotationProblem(
      404,
      "rotation_not_found",
      "The credential rotation does not exist.",
    );
  }
  if (rotation.credential_class !== input.credential_class) {
    throw problem(
      "identity_conflict",
      "The credential class does not match the rotation.",
    );
  }
  if (
    rotation.environment !== input.environment ||
    rotation.resource_identity !== input.resource_identity ||
    rotation.owning_boundary !== input.owning_boundary ||
    rotation.verification_target !== input.verification_target
  ) {
    throw problem(
      "identity_conflict",
      "The resolved credential boundary identity is stale.",
    );
  }
  await assertFingerprint(
    rotation.old_secret_hash,
    input.old_fingerprint,
    "credential_fingerprint_mismatch",
  );
  await assertFingerprint(
    rotation.replacement_secret_hash,
    input.replacement_fingerprint,
    "credential_fingerprint_mismatch",
  );
  const expected =
    input.action === "verify"
      ? "replacement_installed"
      : "replacement_verified";
  if (rotation.state !== expected) {
    throw problem(
      "illegal_rotation_transition",
      `The rotation is not awaiting ${input.action}.`,
    );
  }
  return rotation.state;
}

async function assertExecutionSnapshot(
  database: D1Database,
  plan: CredentialRotationPlanRow,
  observedAt: string,
): Promise<void> {
  if (plan.status === "reserved" && plan.expires_at <= observedAt) {
    throw problem(
      "credential_plan_expired",
      "The credential transition plan is no longer executable.",
    );
  }
  const state = await currentCredentialMutationState(database);
  if (state.recovery_health !== "healthy") {
    throw problem(
      state.recovery_health === "blocked"
        ? "recovery_in_progress"
        : "recovery_not_verified",
      "Credential execution requires healthy verified recovery.",
    );
  }
  if (state.active_ingestion_run_id !== null) {
    throw problem(
      "ingestion_not_idle",
      "Credential execution requires idle ingestion.",
    );
  }
  if (
    state.current_revision_id !==
    plan.expected_catalogue_revision_id
  ) {
    throw problem(
      "current_revision_mismatch",
      "The expected current Catalogue Revision is stale.",
    );
  }
  if (
    state.credential_rotation_generation !==
    plan.expected_state_generation
  ) {
    throw problem(
      "credential_state_generation_mismatch",
      "The expected credential state generation is stale.",
    );
  }
  const rotation = await optionalRow(database, plan.rotation_id);
  if (plan.action === "install") {
    if (rotation !== null) {
      throw problem(
        "identity_conflict",
        "The credential rotation identity already exists.",
      );
    }
    return;
  }
  if (rotation === null) {
    throw new CredentialRotationProblem(
      404,
      "rotation_not_found",
      "The credential rotation does not exist.",
    );
  }
  if (
    rotation.credential_class !== plan.credential_class ||
    rotation.environment !== plan.environment ||
    rotation.resource_identity !== plan.resource_identity ||
    rotation.owning_boundary !== plan.owning_boundary ||
    rotation.verification_target !== plan.verification_target
  ) {
    throw problem(
      "identity_conflict",
      "The credential rotation identity changed after reservation.",
    );
  }
  if (
    !(await fixedHashEqual(
      rotation.old_secret_hash,
      hashFromFingerprint(plan.old_fingerprint),
    )) ||
    !(await fixedHashEqual(
      rotation.replacement_secret_hash,
      hashFromFingerprint(plan.replacement_fingerprint),
    ))
  ) {
    throw problem(
      "credential_fingerprint_mismatch",
      "The credential fingerprints changed after reservation.",
    );
  }
  if (rotation.state !== plan.expected_rotation_state) {
    throw problem(
      "illegal_rotation_transition",
      "The credential rotation state changed after reservation.",
    );
  }
}

function planDocument(
  row: CredentialRotationPlanRow,
): CredentialRotationPlanDocument {
  return {
    contract: "card-keepr-credential-rotation-plan@1",
    id: row.id,
    action: row.action,
    rotation_id: row.rotation_id,
    credential_class: row.credential_class,
    environment: row.environment,
    cloudflare_account_id: row.cloudflare_account_id,
    resource_identity: row.resource_identity,
    owning_boundary: row.owning_boundary,
    verification_target: row.verification_target,
    required_permission: row.required_permission,
    consumer_installation_identity:
      row.consumer_installation_identity,
    expected_catalogue_revision_id:
      row.expected_catalogue_revision_id,
    expected_state_generation: row.expected_state_generation,
    expected_rotation_state: row.expected_rotation_state,
    old_fingerprint: row.old_fingerprint,
    replacement_fingerprint: row.replacement_fingerprint,
    old_issuer_credential_id: row.old_issuer_credential_id,
    replacement_issuer_credential_id:
      row.replacement_issuer_credential_id,
    management_credential_id: row.management_credential_id,
    idempotency_key: row.idempotency_key,
    plan_nonce: row.plan_nonce,
    plan_digest: row.plan_digest,
    status: row.status,
    created_at: row.created_at,
    expires_at: row.expires_at,
    execution_started_at: row.execution_started_at,
    execution_expires_at: row.execution_expires_at,
    execution_attempt: row.execution_attempt,
    execution_mode:
      row.status === "executing"
        ? row.execution_attempt === 1
          ? "mutation"
          : "reconciliation"
        : null,
  };
}

function randomHex(bytes: number): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return Array.from(value)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
