import {
  credentialClasses,
  credentialClassDefinitions,
  isCredentialClass as isSharedCredentialClass,
  resolveCredentialIdentity,
  type CredentialClass,
  type CredentialDeploymentContext,
} from "../credentials/credential-catalogue.mjs";
import {
  credentialBoundaryAttestationFailure,
  signCredentialBoundaryFacts,
} from "../credentials/credential-attestation";
import type {
  AuthenticationRow,
  CredentialRotationDocument,
  CredentialRotationPlanDocument,
  CredentialRotationPlanInput,
  CredentialRotationPlanRow,
  CredentialRotationState,
  RotationRow,
} from "./credential-rotation-contracts";
import {
  CredentialRotationProblem,
  credentialConflict,
} from "./credential-rotation-problem";
import {
  assertFingerprint,
  fixedHashEqual,
  fixedIdentityEqual,
  hashFromFingerprint,
  randomHex,
  requestDigest,
  secretHash,
} from "./credential-rotation-crypto";
import {
  currentCredentialMutationState,
  optionalRotation as optionalRow,
  planDocument,
  requiredPlan,
  requiredRotation as requiredRow,
  rotationDocument as document,
} from "./credential-rotation-store";

export { credentialClasses };
export type { CredentialClass };
export { CredentialRotationProblem };
export type {
  CredentialRotationDocument,
  CredentialRotationPlanAction,
  CredentialRotationPlanDocument,
  CredentialRotationPlanInput,
  CredentialRotationState,
} from "./credential-rotation-contracts";

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
  if (expectedIdentity === undefined) {
    throw problem(
      "identity_conflict",
      "The production credential deployment context is not provisioned.",
    );
  }
  const cloudflareManagementPermissions = JSON.stringify(
    expectedIdentity.cloudflare_management_required_permissions,
  );
  const consumerSlots = await consumerSlotsForPlan(database, input);
  const definition = credentialClassDefinitions[input.credential_class];
  const replacementSecretName =
    consumerSlots.replacement === "a"
      ? definition.slot_a_secret_name
      : definition.slot_b_secret_name;
  const consumerInstallationIdentity =
    definition.consumer_provider === "github"
      ? expectedIdentity.consumer_installation_identity.replace(
          /:secret:[^:]+$/u,
          `:secret:${replacementSecretName}`,
        )
      : `${definition.consumer_provider}:${definition.consumer_config}:${replacementSecretName}`;
  if (
    input.environment !== expectedIdentity.environment ||
    input.cloudflare_account_id !==
      expectedIdentity.cloudflare_account_id ||
    input.resource_identity !== expectedIdentity.resource_identity ||
    input.owning_boundary !== expectedIdentity.owning_boundary ||
    input.verification_target !== expectedIdentity.verification_target ||
    input.production_target_identity !==
      expectedIdentity.production_target_identity
  ) {
    throw problem(
      "identity_conflict",
      "The resolved credential boundary identity is stale.",
    );
  }
  const expectedOldIssuer =
    consumerSlots.old === "a"
      ? definition.slot_a_issuer_credential_id
      : definition.slot_b_issuer_credential_id;
  const expectedReplacementIssuer =
    consumerSlots.replacement === "a"
      ? definition.slot_a_issuer_credential_id
      : definition.slot_b_issuer_credential_id;
  if (
    (expectedOldIssuer !== undefined &&
      input.old_issuer_credential_id !== expectedOldIssuer) ||
    (expectedReplacementIssuer !== undefined &&
      input.replacement_issuer_credential_id !==
        expectedReplacementIssuer)
  ) {
    throw problem(
      "identity_conflict",
      "The issuer identity must be the exact catalogue-managed secret slot.",
    );
  }
  const githubManagementApplies =
    input.credential_class === "github_deployment_token";
  if (
    githubManagementApplies
      ? !safeProviderIdentity(
          input.github_management_credential_id,
        ) ||
        input.github_management_credential_id ===
          "not-applicable" ||
        input.github_management_credential_id ===
          input.management_credential_id ||
        input.github_management_credential_id !==
          expectedIdentity.fixed_github_management_credential_id ||
        !/^sha256:[0-9a-f]{64}$/.test(
          input.github_management_credential_fingerprint,
        )
      : input.github_management_credential_id !==
          "not-applicable" ||
        input.github_management_credential_fingerprint !==
          `sha256:${"0".repeat(64)}`
  ) {
    throw new CredentialRotationProblem(
      422,
      "invalid_github_management_identity",
      "The GitHub management credential identity is invalid.",
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
    {
      ...expectedIdentity,
      consumer_installation_identity: consumerInstallationIdentity,
    },
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
    cloudflare_management_required_permissions:
      cloudflareManagementPermissions,
    consumer_installation_identity:
      consumerInstallationIdentity,
    old_consumer_slot: consumerSlots.old,
    replacement_consumer_slot: consumerSlots.replacement,
    github_management_required_permission:
      expectedIdentity.github_management_required_permission,
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
          verification_target, production_target_identity,
          required_permission,
          cloudflare_management_required_permissions,
          consumer_installation_identity, old_consumer_slot,
          replacement_consumer_slot,
          expected_catalogue_revision_id, expected_state_generation,
          expected_rotation_state, old_fingerprint,
          replacement_fingerprint, old_issuer_credential_id,
          replacement_issuer_credential_id, management_credential_id,
          github_management_credential_id,
          github_management_credential_fingerprint,
          github_management_required_permission,
          idempotency_key, request_digest,
          plan_nonce, plan_digest, status, created_at, expires_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
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
        input.production_target_identity,
        expectedIdentity.required_permission,
        cloudflareManagementPermissions,
        consumerInstallationIdentity,
        consumerSlots.old,
        consumerSlots.replacement,
        input.expected_catalogue_revision_id,
        input.expected_state_generation,
        expectedRotationState,
        input.old_fingerprint,
        input.replacement_fingerprint,
        input.old_issuer_credential_id,
        input.replacement_issuer_credential_id,
        input.management_credential_id,
        input.github_management_credential_id,
        input.github_management_credential_fingerprint,
        expectedIdentity.github_management_required_permission,
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
  if (
    plan.execution_capability_consumed_at === null ||
    plan.boundary_attestation_issued_at === null ||
    plan.execution_expires_at === null ||
    plan.execution_expires_at <= observedAt
  ) {
    throw problem(
      "credential_provider_execution_required",
      "Finalization requires a live provider execution and a server-issued attestation.",
    );
  }
  const attestationFailure =
    await credentialBoundaryAttestationFailure(
      plan,
      attestation,
      attestationKey,
      observedAt,
    );
  if (attestationFailure !== null) {
    throw problem(
      attestationFailure,
      attestationFailure === "invalid_boundary_attestation"
        ? "The owning-boundary attestation is invalid."
        : "The owning-boundary attestation does not match the reserved transition.",
    );
  }
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
              production_target_identity,
              required_permission,
              cloudflare_management_required_permissions,
              consumer_installation_identity,
              old_consumer_slot, replacement_consumer_slot,
              current_consumer_slot,
              old_issuer_credential_id,
              replacement_issuer_credential_id,
              management_credential_id,
              github_management_credential_id,
              github_management_credential_fingerprint,
              github_management_required_permission,
              old_secret_hash, replacement_secret_hash, installed_at,
              install_idempotency_key, install_request_digest,
              install_receipt
            ) VALUES (
              ?, ?, 'replacement_installed', ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            )`,
          )
          .bind(
            plan.rotation_id,
            plan.credential_class,
            plan.environment,
            plan.resource_identity,
            plan.owning_boundary,
            plan.verification_target,
            plan.production_target_identity,
            plan.required_permission,
            plan.cloudflare_management_required_permissions,
            plan.consumer_installation_identity,
            plan.old_consumer_slot,
            plan.replacement_consumer_slot,
            plan.old_consumer_slot,
            plan.old_issuer_credential_id,
            plan.replacement_issuer_credential_id,
            plan.management_credential_id,
            plan.github_management_credential_id,
            plan.github_management_credential_fingerprint,
            plan.github_management_required_permission,
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
                   current_consumer_slot = replacement_consumer_slot,
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
  executionOwnerToken: string,
  expectedExecutionAttempt: number,
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
  const ownerHash = await secretHash(executionOwnerToken);
  if (
    plan.status === "executing" &&
    plan.execution_expires_at !== null &&
    plan.execution_expires_at > observedAt
  ) {
    if (
      plan.execution_owner_hash === null ||
      expectedExecutionAttempt !== plan.execution_attempt ||
      !(await fixedHashEqual(
        plan.execution_owner_hash,
        ownerHash,
      ))
    ) {
      throw problem(
        "credential_mutation_conflict",
        "The live execution claim belongs to another owner.",
      );
    }
    throw problem(
      "credential_execution_capability_consumed",
      "A live execution must use its original one-time capability.",
    );
  }
  const executionExpiresAt = new Date(
    Date.parse(observedAt) + 10 * 60 * 1000,
  ).toISOString();
  let result: D1Result<unknown>;
  const executionCapability = randomHex(32);
  const executionCapabilityHash = await secretHash(
    executionCapability,
  );
  try {
    result = await database
      .prepare(
      `UPDATE credential_rotation_plans
       SET status = 'executing', execution_started_at = ?,
           execution_expires_at = ?, execution_attempt =
           execution_attempt + 1, execution_owner_hash = ?,
           execution_capability_hash = ?,
           execution_capability_consumed_at = NULL,
           boundary_attestation_issued_at = NULL
       WHERE id = ?
         AND execution_attempt = ?
         AND (
           (status = 'reserved' AND expires_at > ?)
           OR
           (
             status = 'executing'
             AND execution_expires_at <= ?
           )
         )
         AND plan_digest = ?
         AND EXISTS (
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
                   AND rotation.production_target_identity =
                     credential_rotation_plans.production_target_identity
                   AND rotation.required_permission =
                     credential_rotation_plans.required_permission
                   AND rotation.cloudflare_management_required_permissions =
                     credential_rotation_plans.cloudflare_management_required_permissions
                   AND rotation.consumer_installation_identity =
                     credential_rotation_plans.consumer_installation_identity
                   AND rotation.old_consumer_slot =
                     credential_rotation_plans.old_consumer_slot
                   AND rotation.replacement_consumer_slot =
                     credential_rotation_plans.replacement_consumer_slot
                   AND rotation.old_issuer_credential_id =
                     credential_rotation_plans.old_issuer_credential_id
                   AND rotation.replacement_issuer_credential_id =
                     credential_rotation_plans.replacement_issuer_credential_id
                   AND rotation.management_credential_id =
                     credential_rotation_plans.management_credential_id
                   AND rotation.github_management_credential_id =
                     credential_rotation_plans.github_management_credential_id
                   AND rotation.github_management_credential_fingerprint =
                     credential_rotation_plans.github_management_credential_fingerprint
                   AND rotation.github_management_required_permission =
                     credential_rotation_plans.github_management_required_permission
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
         )`,
    )
      .bind(
        observedAt,
      executionExpiresAt,
      ownerHash,
      executionCapabilityHash,
      plan.id,
      expectedExecutionAttempt,
      observedAt,
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
  return {
    ...planDocument(await requiredPlan(database, plan.id)),
    execution_capability: executionCapability,
  };
}

export async function consumeCredentialRotationExecutionCapability(
  database: D1Database,
  planId: string,
  planDigest: string,
  executionAttempt: number,
  capability: string,
  observedAt: string,
): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(capability)) {
    throw problem(
      "invalid_execution_capability",
      "The execution capability is invalid.",
    );
  }
  const capabilityHash = await secretHash(capability);
  const result = await database
    .prepare(
      `UPDATE credential_rotation_plans
       SET execution_capability_consumed_at = ?
       WHERE id = ? AND status = 'executing'
         AND plan_digest = ? AND execution_attempt = ?
         AND execution_expires_at > ?
         AND execution_capability_consumed_at IS NULL
         AND execution_capability_hash = ?`,
    )
    .bind(
      observedAt,
      planId,
      planDigest,
      executionAttempt,
      observedAt,
      capabilityHash,
    )
    .run();
  if (result.meta.changes !== 1) {
    throw problem(
      "invalid_execution_capability",
      "The execution capability is invalid, expired, or consumed.",
    );
  }
}

export async function issueCredentialBoundaryAttestation(
  database: D1Database,
  planId: string,
  planDigest: string,
  executionAttempt: number,
  capability: string,
  facts: unknown,
  attestationKey: string,
  observedAt: string,
): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(capability)) {
    throw problem(
      "invalid_execution_capability",
      "The execution capability is invalid.",
    );
  }
  const plan = await requiredPlan(database, planId);
  const capabilityHash = await secretHash(capability);
  if (
    plan.status !== "executing" ||
    plan.execution_attempt !== executionAttempt ||
    plan.execution_capability_hash === null ||
    plan.execution_capability_consumed_at === null ||
    plan.boundary_attestation_issued_at !== null ||
    plan.execution_expires_at === null ||
    plan.execution_expires_at <= observedAt ||
    !(await fixedHashEqual(plan.plan_digest, planDigest)) ||
    !(await fixedHashEqual(
      plan.execution_capability_hash,
      capabilityHash,
    ))
  ) {
    throw problem(
      "invalid_execution_capability",
      "The execution capability is invalid, expired, or not consumed.",
    );
  }
  const attestation = await signCredentialBoundaryFacts(
    plan,
    facts,
    attestationKey,
    observedAt,
  );
  if (attestation === null) {
    throw problem(
      "credential_boundary_mismatch",
      "The owning-boundary facts do not match the reserved transition.",
    );
  }
  const result = await database
    .prepare(
      `UPDATE credential_rotation_plans
       SET boundary_attestation_issued_at = ?
       WHERE id = ? AND status = 'executing'
         AND plan_digest = ? AND execution_attempt = ?
         AND execution_expires_at > ?
         AND execution_capability_consumed_at IS NOT NULL
         AND boundary_attestation_issued_at IS NULL
         AND execution_capability_hash = ?`,
    )
    .bind(
      observedAt,
      planId,
      planDigest,
      executionAttempt,
      observedAt,
      capabilityHash,
    )
    .run();
  if (result.meta.changes !== 1) {
    throw problem(
      "credential_mutation_conflict",
      "The boundary attestation changed concurrently.",
    );
  }
  return attestation;
}

export async function releaseCredentialRotationPlanExecution(
  database: D1Database,
  planId: string,
  planDigest: string,
  executionOwnerToken: string,
  executionAttempt: number,
  mutationStarted: false,
  observedAt: string,
): Promise<CredentialRotationPlanDocument> {
  if (mutationStarted !== false) {
    throw problem(
      "credential_reconciliation_required",
      "A provider mutation may have started and must remain locked for reconciliation.",
    );
  }
  const plan = await requiredPlan(database, planId);
  if (!(await fixedHashEqual(plan.plan_digest, planDigest))) {
    throw problem(
      "credential_plan_digest_mismatch",
      "The credential transition plan digest is stale.",
    );
  }
  if (
    plan.status !== "executing" ||
    plan.execution_attempt !== 1 ||
    executionAttempt !== plan.execution_attempt ||
    plan.execution_owner_hash === null ||
    !(await fixedHashEqual(
      plan.execution_owner_hash,
      await secretHash(executionOwnerToken),
    ))
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
           execution_owner_hash = NULL,
           execution_capability_hash = NULL,
           execution_capability_consumed_at = NULL,
           boundary_attestation_issued_at = NULL, expires_at = ?
       WHERE id = ? AND status = 'executing'
         AND execution_attempt = ? AND execution_owner_hash = ?
         AND plan_digest = ?`,
    )
    .bind(
      retryExpiresAt,
      plan.id,
      executionAttempt,
      plan.execution_owner_hash,
      plan.plan_digest,
    )
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
       ORDER BY installed_at DESC, id DESC
       LIMIT 1`,
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

function safeProviderIdentity(value: string): boolean {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9._:/-]{8,256}$/.test(value)
  );
}

async function consumerSlotsForPlan(
  database: D1Database,
  input: CredentialRotationPlanInput,
): Promise<{ old: "a" | "b"; replacement: "a" | "b" }> {
  if (input.action !== "install") {
    const rotation = await optionalRow(database, input.rotation_id);
    if (rotation === null) {
      throw new CredentialRotationProblem(
        404,
        "rotation_not_found",
        "The credential rotation does not exist.",
      );
    }
    return {
      old: rotation.old_consumer_slot,
      replacement: rotation.replacement_consumer_slot,
    };
  }
  const latest = await database
    .prepare(
      `SELECT current_consumer_slot
       FROM credential_rotations
       WHERE credential_class = ? AND state = 'old_revoked'
       ORDER BY installed_at DESC, id DESC
       LIMIT 1`,
    )
    .bind(input.credential_class)
    .first<{ current_consumer_slot: "a" | "b" }>();
  const old = latest?.current_consumer_slot ?? "a";
  return { old, replacement: old === "a" ? "b" : "a" };
}

async function expectedStateForAction(
  database: D1Database,
  input: CredentialRotationPlanInput,
  expectedIdentity: {
    required_permission: string;
    cloudflare_management_required_permissions: readonly string[];
    consumer_installation_identity: string;
    github_management_required_permission: string;
  },
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
    rotation.verification_target !== input.verification_target ||
    rotation.production_target_identity !==
      input.production_target_identity
    || rotation.old_consumer_slot === rotation.replacement_consumer_slot
  ) {
    throw problem(
      "identity_conflict",
      "The resolved credential boundary identity is stale.",
    );
  }
  const providerIdentityMatches = await Promise.all([
    fixedIdentityEqual(
      rotation.old_issuer_credential_id,
      input.old_issuer_credential_id,
    ),
    fixedIdentityEqual(
      rotation.replacement_issuer_credential_id,
      input.replacement_issuer_credential_id,
    ),
    fixedIdentityEqual(
      rotation.management_credential_id,
      input.management_credential_id,
    ),
    fixedIdentityEqual(
      rotation.github_management_credential_id,
      input.github_management_credential_id,
    ),
    fixedIdentityEqual(
      rotation.github_management_credential_fingerprint,
      input.github_management_credential_fingerprint,
    ),
  ]);
  if (
    providerIdentityMatches.some((matches) => !matches) ||
    rotation.required_permission !==
      expectedIdentity.required_permission ||
    rotation.cloudflare_management_required_permissions !==
      JSON.stringify(
        expectedIdentity.cloudflare_management_required_permissions,
      ) ||
    rotation.consumer_installation_identity !==
      expectedIdentity.consumer_installation_identity ||
    rotation.github_management_required_permission !==
      expectedIdentity.github_management_required_permission
  ) {
    throw problem(
      "identity_conflict",
      "The persisted issuer or consumer identity does not match.",
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
    rotation.verification_target !== plan.verification_target ||
    rotation.production_target_identity !==
      plan.production_target_identity ||
    rotation.required_permission !== plan.required_permission ||
    rotation.cloudflare_management_required_permissions !==
      plan.cloudflare_management_required_permissions ||
    rotation.consumer_installation_identity !==
      plan.consumer_installation_identity ||
    rotation.old_consumer_slot !== plan.old_consumer_slot ||
    rotation.replacement_consumer_slot !==
      plan.replacement_consumer_slot ||
    rotation.old_issuer_credential_id !==
      plan.old_issuer_credential_id ||
    rotation.replacement_issuer_credential_id !==
      plan.replacement_issuer_credential_id ||
    rotation.management_credential_id !==
      plan.management_credential_id ||
    rotation.github_management_credential_id !==
      plan.github_management_credential_id ||
    rotation.github_management_credential_fingerprint !==
      plan.github_management_credential_fingerprint ||
    rotation.github_management_required_permission !==
      plan.github_management_required_permission
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

function problem(code: string, detail: string): CredentialRotationProblem {
  return credentialConflict(code, detail);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
