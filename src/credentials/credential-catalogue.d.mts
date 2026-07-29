export const credentialClasses: readonly [
  "api_bearer_key",
  "ingestion_admin_key",
  "d1_export_token",
  "d1_verification_token",
  "github_deployment_token",
];

export type CredentialClass = (typeof credentialClasses)[number];

export type CredentialDeploymentContext = {
  cloudflare_account_id: string;
  catalogue_d1_database_id: string;
  disposable_d1_database_id: string;
  github_repository_id: string;
};

export type ResolvedCredentialIdentity = {
  environment: "production";
  cloudflare_account_id: string;
  resource_identity: string;
  owning_boundary: string;
  verification_target: string;
  required_permission: string;
};

export const credentialClassDefinitions: Readonly<
  Record<CredentialClass, {
    owning_boundary: string;
    resource_kind: "worker" | "d1" | "github-workflow";
    resource_name: string;
    database_context_key?:
      | "catalogue_d1_database_id"
      | "disposable_d1_database_id";
    verification_operation: string;
    required_permission: string;
    management_permission?: string;
    consumer_provider: "wrangler" | "github";
    consumer_config?: string;
    active_secret_name: string;
    replacement_secret_name: string;
  }>
>;

export function isCredentialClass(
  value: string,
): value is CredentialClass;

export function resolveCredentialIdentity(
  credentialClass: CredentialClass,
  context: CredentialDeploymentContext,
): ResolvedCredentialIdentity;
