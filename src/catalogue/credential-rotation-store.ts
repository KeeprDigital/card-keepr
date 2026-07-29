import type {
  CredentialRotationDocument,
  CredentialRotationPlanDocument,
  CredentialRotationPlanRow,
  RotationRow,
} from "./credential-rotation-contracts";
import {
  CredentialRotationProblem,
  credentialConflict,
} from "./credential-rotation-problem";

export async function optionalRotation(
  database: D1Database,
  id: string,
): Promise<RotationRow | null> {
  return database
    .prepare(`SELECT * FROM credential_rotations WHERE id = ?`)
    .bind(id)
    .first<RotationRow>();
}

export async function requiredRotation(
  database: D1Database,
  id: string,
): Promise<RotationRow> {
  const row = await optionalRotation(database, id);
  if (row === null) {
    throw new CredentialRotationProblem(
      404,
      "rotation_not_found",
      "The credential rotation does not exist.",
    );
  }
  return row;
}

export function rotationDocument(
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
    production_target_identity: row.production_target_identity,
    old_fingerprint: `sha256:${row.old_secret_hash}`,
    replacement_fingerprint: `sha256:${row.replacement_secret_hash}`,
    installed_at: row.installed_at,
    verified_at: row.verified_at,
    old_revoked_at: row.old_revoked_at,
    operation_code: operationCode,
  };
}

export async function currentCredentialMutationState(
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
    throw credentialConflict(
      "credential_mutation_conflict",
      "The credential mutation state is unavailable.",
    );
  }
  return state;
}

export async function requiredPlan(
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

export function planDocument(
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
    production_target_identity: row.production_target_identity,
    required_permission: row.required_permission,
    cloudflare_management_required_permissions:
      row.cloudflare_management_required_permissions,
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
    github_management_credential_id:
      row.github_management_credential_id,
    github_management_credential_fingerprint:
      row.github_management_credential_fingerprint,
    github_management_required_permission:
      row.github_management_required_permission,
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
