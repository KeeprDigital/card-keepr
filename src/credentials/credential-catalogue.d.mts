export type CredentialClass =
  keyof typeof credentialClassDefinitions;

export const credentialClasses: readonly CredentialClass[];

export type CredentialDeploymentContext = {
  cloudflare_account_id: string;
  catalogue_d1_database_id: string;
  disposable_d1_database_id: string;
  github_repository_id: string;
  github_app_id: string;
  github_installation_id: string;
  github_environment_id: string;
  github_workflow_id: string;
};

export type ResolvedCredentialIdentity = {
  environment: "production";
  cloudflare_account_id: string;
  resource_identity: string;
  owning_boundary: string;
  verification_target: string;
  required_permission: string;
  consumer_installation_identity: string;
  production_target_identity: string;
  github_management_required_permission: string;
  cloudflare_management_required_permissions: readonly string[];
  fixed_old_issuer_credential_id: string | null;
  fixed_replacement_issuer_credential_id: string | null;
  fixed_github_management_credential_id: string | null;
};

export const credentialClassDefinitions: Readonly<
  Record<CredentialClass, {
    owning_boundary: string;
    issuer_provider: "consumer-secret" | "cloudflare-api-token";
    resource_kind: "worker" | "d1" | "github-workflow";
    resource_name: string;
    database_context_key?:
      | "catalogue_d1_database_id"
      | "disposable_d1_database_id";
    verification_operation: string;
    required_permission: string;
    management_permissions: readonly string[];
    consumer_provider: "wrangler" | "github";
    consumer_config?: string;
    consumer_worker_name?: string;
    active_secret_name: string;
    replacement_secret_name: string;
    slot_a_secret_name: string;
    slot_b_secret_name: string;
    active_environment_key: string;
    replacement_environment_key: string;
    database_environment_key?: string;
    fixed_old_issuer_credential_id?: string;
    fixed_replacement_issuer_credential_id?: string;
    slot_a_issuer_credential_id?: string;
    slot_b_issuer_credential_id?: string;
  }>
>;

export function isCredentialClass(
  value: string,
): value is CredentialClass;

export function githubManagementPermissionPolicy(
  context: Pick<
    CredentialDeploymentContext,
    | "github_repository_id"
    | "github_app_id"
    | "github_installation_id"
    | "github_environment_id"
    | "github_workflow_id"
  >,
): string;

export function parseGithubManagementPermissionPolicy(
  value: string,
): Pick<
  CredentialDeploymentContext,
  | "github_repository_id"
  | "github_app_id"
  | "github_installation_id"
  | "github_environment_id"
  | "github_workflow_id"
> | null;

export function resolveCredentialIdentity(
  credentialClass: CredentialClass,
  context: CredentialDeploymentContext,
): ResolvedCredentialIdentity | undefined;
