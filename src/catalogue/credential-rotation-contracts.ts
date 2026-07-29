import type {
  CredentialClass,
} from "../credentials/credential-catalogue.mjs";

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
  production_target_identity: string;
  old_issuer_credential_id: string;
  replacement_issuer_credential_id: string;
  management_credential_id: string;
  github_management_credential_id: string;
  github_management_credential_fingerprint: string;
  expected_catalogue_revision_id: string;
  expected_state_generation: number;
  old_fingerprint: string;
  replacement_fingerprint: string;
  idempotency_key: string;
};

export type CredentialRotationPlanDocument =
  CredentialRotationPlanInput & {
    contract: "card-keepr-credential-rotation-plan@1";
    id: string;
    required_permission: string;
    cloudflare_management_required_permissions: string;
    consumer_installation_identity: string;
    github_management_required_permission: string;
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

export type CredentialRotationPlanRow = Omit<
  CredentialRotationPlanDocument,
  "contract" | "expected_state_generation"
> & {
  expected_state_generation: number;
  request_digest: string;
  execution_owner_hash: string | null;
  finalized_at: string | null;
  attestation_digest: string | null;
};

export type RotationRow = {
  id: string;
  credential_class: CredentialClass;
  state: CredentialRotationState;
  environment: "production";
  resource_identity: string;
  owning_boundary: string;
  verification_target: string;
  production_target_identity: string;
  required_permission: string;
  cloudflare_management_required_permissions: string;
  consumer_installation_identity: string;
  old_issuer_credential_id: string;
  replacement_issuer_credential_id: string;
  management_credential_id: string;
  github_management_credential_id: string;
  github_management_credential_fingerprint: string;
  github_management_required_permission: string;
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

export type AuthenticationRow = Pick<
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
  production_target_identity: string;
  old_fingerprint: string;
  replacement_fingerprint: string;
  installed_at: string;
  verified_at: string | null;
  old_revoked_at: string | null;
  operation_code: "ok" | "idempotent_replay";
};
