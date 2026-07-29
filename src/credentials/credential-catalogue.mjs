export const credentialClasses = Object.freeze([
  "api_bearer_key",
  "ingestion_admin_key",
  "d1_export_token",
  "d1_verification_token",
  "github_deployment_token",
]);

export const credentialClassDefinitions = Object.freeze({
  api_bearer_key: Object.freeze({
    owning_boundary: "api_worker",
    resource_kind: "worker",
    resource_name: "card-keepr-api",
    verification_operation: "health",
    required_permission: "workers-secret:api-traffic",
    consumer_provider: "wrangler",
    consumer_config: "apps/api/wrangler.jsonc",
    active_secret_name: "API_BEARER_KEY",
    replacement_secret_name: "API_BEARER_KEY_REPLACEMENT",
  }),
  ingestion_admin_key: Object.freeze({
    owning_boundary: "ingestion_worker",
    resource_kind: "worker",
    resource_name: "card-keepr-ingestion",
    verification_operation: "health",
    required_permission: "workers-secret:administration",
    consumer_provider: "wrangler",
    consumer_config: "apps/ingestion/wrangler.jsonc",
    active_secret_name: "ADMINISTRATION_KEY",
    replacement_secret_name: "ADMINISTRATION_KEY_REPLACEMENT",
  }),
  d1_export_token: Object.freeze({
    owning_boundary: "d1_export_operation",
    resource_kind: "d1",
    resource_name: "card-keepr-catalogue",
    database_context_key: "catalogue_d1_database_id",
    verification_operation: "export-schema",
    required_permission: "D1 Read",
    management_permission: "Account API Tokens Write",
    consumer_provider: "wrangler",
    consumer_config: "apps/ingestion/wrangler.jsonc",
    active_secret_name: "D1_EXPORT_TOKEN",
    replacement_secret_name: "D1_EXPORT_TOKEN_REPLACEMENT",
  }),
  d1_verification_token: Object.freeze({
    owning_boundary: "disposable_verification",
    resource_kind: "d1",
    resource_name: "disposable-verification",
    database_context_key: "disposable_d1_database_id",
    verification_operation: "write-rollback-probe",
    required_permission: "D1 Edit",
    management_permission: "Account API Tokens Write",
    consumer_provider: "wrangler",
    consumer_config: "apps/ingestion/wrangler.jsonc",
    active_secret_name: "D1_VERIFICATION_TOKEN",
    replacement_secret_name: "D1_VERIFICATION_TOKEN_REPLACEMENT",
  }),
  github_deployment_token: Object.freeze({
    owning_boundary: "production_release_workflow",
    resource_kind: "github-workflow",
    resource_name: "card-keepr-production-release",
    verification_operation: "deployment-scope-introspection",
    required_permission: "Workers Scripts Write",
    management_permission: "Account API Tokens Write",
    consumer_provider: "github",
    active_secret_name: "CLOUDFLARE_DEPLOYMENT_TOKEN",
    replacement_secret_name:
      "CLOUDFLARE_DEPLOYMENT_TOKEN_REPLACEMENT",
  }),
});

export function isCredentialClass(value) {
  return credentialClasses.includes(value);
}

export function resolveCredentialIdentity(credentialClass, context) {
  const definition = credentialClassDefinitions[credentialClass];
  if (definition === undefined) return undefined;
  if (definition.resource_kind === "worker") {
    const prefix = `cloudflare-account:${context.cloudflare_account_id}`;
    return {
      environment: "production",
      cloudflare_account_id: context.cloudflare_account_id,
      resource_identity: `${prefix}:worker:${definition.resource_name}`,
      owning_boundary: definition.owning_boundary,
      verification_target: `${prefix}:worker:${definition.resource_name}:${definition.verification_operation}`,
      required_permission: definition.required_permission,
    };
  }
  if (definition.resource_kind === "d1") {
    const databaseId = context[definition.database_context_key];
    const prefix = `cloudflare-account:${context.cloudflare_account_id}:d1:${databaseId}`;
    return {
      environment: "production",
      cloudflare_account_id: context.cloudflare_account_id,
      resource_identity: prefix,
      owning_boundary: definition.owning_boundary,
      verification_target: `${prefix}:${definition.verification_operation}`,
      required_permission: definition.required_permission,
    };
  }
  const prefix = `github-repository:${context.github_repository_id}:environment:production`;
  return {
    environment: "production",
    cloudflare_account_id: context.cloudflare_account_id,
    resource_identity: `${prefix}:workflow:${definition.resource_name}`,
    owning_boundary: definition.owning_boundary,
    verification_target: `${prefix}:workflow:${definition.resource_name}:${definition.verification_operation}`,
    required_permission: definition.required_permission,
  };
}
