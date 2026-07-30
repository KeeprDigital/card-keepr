export const credentialClassDefinitions = Object.freeze({
  api_bearer_key: Object.freeze({
    owning_boundary: "api_worker",
    issuer_provider: "consumer-secret",
    resource_kind: "worker",
    resource_name: "card-keepr-api",
    verification_operation: "health",
    required_permission: "workers-secret:api-traffic",
    management_permissions: [
      "Account API Tokens Read",
      "Account API Tokens Write",
      "Workers Scripts Write",
    ],
    consumer_provider: "wrangler",
    consumer_config: "apps/api/wrangler.jsonc",
    consumer_worker_name: "card-keepr-api",
    active_secret_name: "API_BEARER_KEY",
    replacement_secret_name: "API_BEARER_KEY_REPLACEMENT",
    slot_a_secret_name: "API_BEARER_KEY",
    slot_b_secret_name: "API_BEARER_KEY_REPLACEMENT",
    active_environment_key: "API_BEARER_KEY",
    replacement_environment_key: "API_BEARER_KEY_REPLACEMENT",
    fixed_old_issuer_credential_id:
      "wrangler:apps/api/wrangler.jsonc:API_BEARER_KEY",
    fixed_replacement_issuer_credential_id:
      "wrangler:apps/api/wrangler.jsonc:API_BEARER_KEY_REPLACEMENT",
    slot_a_issuer_credential_id:
      "wrangler:apps/api/wrangler.jsonc:API_BEARER_KEY",
    slot_b_issuer_credential_id:
      "wrangler:apps/api/wrangler.jsonc:API_BEARER_KEY_REPLACEMENT",
  }),
  ingestion_admin_key: Object.freeze({
    owning_boundary: "ingestion_worker",
    issuer_provider: "consumer-secret",
    resource_kind: "worker",
    resource_name: "card-keepr-ingestion",
    verification_operation: "health",
    required_permission: "workers-secret:administration",
    management_permissions: [
      "Account API Tokens Read",
      "Account API Tokens Write",
      "Workers Scripts Write",
    ],
    consumer_provider: "wrangler",
    consumer_config: "apps/ingestion/wrangler.jsonc",
    consumer_worker_name: "card-keepr-ingestion",
    active_secret_name: "ADMINISTRATION_KEY",
    replacement_secret_name: "ADMINISTRATION_KEY_REPLACEMENT",
    slot_a_secret_name: "ADMINISTRATION_KEY",
    slot_b_secret_name: "ADMINISTRATION_KEY_REPLACEMENT",
    active_environment_key: "ADMINISTRATION_KEY",
    replacement_environment_key:
      "ADMINISTRATION_KEY_REPLACEMENT",
    fixed_old_issuer_credential_id:
      "wrangler:apps/ingestion/wrangler.jsonc:ADMINISTRATION_KEY",
    fixed_replacement_issuer_credential_id:
      "wrangler:apps/ingestion/wrangler.jsonc:ADMINISTRATION_KEY_REPLACEMENT",
    slot_a_issuer_credential_id:
      "wrangler:apps/ingestion/wrangler.jsonc:ADMINISTRATION_KEY",
    slot_b_issuer_credential_id:
      "wrangler:apps/ingestion/wrangler.jsonc:ADMINISTRATION_KEY_REPLACEMENT",
  }),
  d1_export_token: Object.freeze({
    owning_boundary: "d1_export_operation",
    issuer_provider: "cloudflare-api-token",
    resource_kind: "d1",
    resource_name: "card-keepr-catalogue",
    database_context_key: "catalogue_d1_database_id",
    verification_operation: "export-schema",
    required_permission: "D1 Read",
    management_permissions: [
      "Account API Tokens Read",
      "Account API Tokens Write",
      "Workers Scripts Write",
    ],
    consumer_provider: "wrangler",
    consumer_config: "apps/ingestion/wrangler.jsonc",
    consumer_worker_name: "card-keepr-ingestion",
    active_secret_name: "D1_EXPORT_TOKEN",
    replacement_secret_name: "D1_EXPORT_TOKEN_REPLACEMENT",
    slot_a_secret_name: "D1_EXPORT_TOKEN",
    slot_b_secret_name: "D1_EXPORT_TOKEN_REPLACEMENT",
    active_environment_key: "D1_EXPORT_TOKEN",
    replacement_environment_key: "D1_EXPORT_TOKEN_REPLACEMENT",
    database_environment_key: "CATALOGUE_D1_DATABASE_ID",
  }),
  d1_verification_token: Object.freeze({
    owning_boundary: "disposable_verification",
    issuer_provider: "cloudflare-api-token",
    resource_kind: "d1",
    resource_name: "disposable-verification",
    database_context_key: "disposable_d1_database_id",
    verification_operation: "write-rollback-probe",
    required_permission: "D1 Edit",
    management_permissions: [
      "Account API Tokens Read",
      "Account API Tokens Write",
      "Workers Scripts Write",
    ],
    consumer_provider: "wrangler",
    consumer_config: "apps/ingestion/wrangler.jsonc",
    consumer_worker_name: "card-keepr-ingestion",
    active_secret_name: "D1_VERIFICATION_TOKEN",
    replacement_secret_name: "D1_VERIFICATION_TOKEN_REPLACEMENT",
    slot_a_secret_name: "D1_VERIFICATION_TOKEN",
    slot_b_secret_name: "D1_VERIFICATION_TOKEN_REPLACEMENT",
    active_environment_key: "D1_VERIFICATION_TOKEN",
    replacement_environment_key:
      "D1_VERIFICATION_TOKEN_REPLACEMENT",
    database_environment_key: "DISPOSABLE_D1_DATABASE_ID",
  }),
  github_deployment_token: Object.freeze({
    owning_boundary: "production_release_workflow",
    issuer_provider: "cloudflare-api-token",
    resource_kind: "github-workflow",
    resource_name: "credential-boundary-probe.yml",
    verification_operation: "deployment-scope-introspection",
    required_permission: "Workers Scripts Write",
    management_permissions: [
      "Account API Tokens Read",
      "Account API Tokens Write",
      "Workers Scripts Write",
    ],
    consumer_provider: "github",
    active_secret_name: "CLOUDFLARE_DEPLOYMENT_TOKEN",
    replacement_secret_name:
      "CLOUDFLARE_DEPLOYMENT_TOKEN_REPLACEMENT",
    slot_a_secret_name: "CLOUDFLARE_DEPLOYMENT_TOKEN",
    slot_b_secret_name:
      "CLOUDFLARE_DEPLOYMENT_TOKEN_REPLACEMENT",
    active_environment_key: "CLOUDFLARE_DEPLOYMENT_TOKEN",
    replacement_environment_key:
      "CLOUDFLARE_DEPLOYMENT_TOKEN_REPLACEMENT",
  }),
});

export const credentialClasses = Object.freeze(
  Object.keys(credentialClassDefinitions),
);

export function isCredentialClass(value) {
  return credentialClasses.includes(value);
}

export function githubManagementPermissionPolicy(context) {
  return (
    `github-app-installation:${context.github_installation_id}` +
    `:repository:${context.github_repository_id}` +
    `:environment:${context.github_environment_id}` +
    `:workflow:${context.github_workflow_id}` +
    ":actions=write,contents=read,environments=write,metadata=read"
  );
}

export function parseGithubManagementPermissionPolicy(value) {
  const match =
    /^github-app-installation:([1-9][0-9]*):repository:([1-9][0-9]*):environment:([1-9][0-9]*):workflow:([1-9][0-9]*):actions=write,contents=read,environments=write,metadata=read$/.exec(
      value ?? "",
    );
  return match === null
    ? null
    : {
        github_installation_id: match[1],
        github_repository_id: match[2],
        github_environment_id: match[3],
        github_workflow_id: match[4],
      };
}

export function resolveCredentialIdentity(credentialClass, context) {
  const definition = credentialClassDefinitions[credentialClass];
  if (
    definition === undefined ||
    !/^[0-9a-f]{32}$/.test(context.cloudflare_account_id ?? "") ||
    !validUuid(context.catalogue_d1_database_id) ||
    !validUuid(context.disposable_d1_database_id) ||
    ![
      context.github_repository_id,
      context.github_installation_id,
      context.github_environment_id,
      context.github_workflow_id,
    ].every((value) => /^[1-9][0-9]*$/.test(value ?? ""))
  ) {
    return undefined;
  }
  if (definition.resource_kind === "worker") {
    const prefix = `cloudflare-account:${context.cloudflare_account_id}`;
    return {
      environment: "production",
      cloudflare_account_id: context.cloudflare_account_id,
      resource_identity: `${prefix}:worker:${definition.resource_name}`,
      owning_boundary: definition.owning_boundary,
      verification_target: `${prefix}:worker:${definition.resource_name}:${definition.verification_operation}`,
      required_permission: definition.required_permission,
      consumer_installation_identity:
        `${definition.consumer_provider}:${definition.consumer_config}:${definition.replacement_secret_name}`,
      production_target_identity:
        productionTargetIdentity(context),
      github_management_required_permission: "not-applicable",
      cloudflare_management_required_permissions:
        definition.management_permissions,
      fixed_old_issuer_credential_id:
        definition.fixed_old_issuer_credential_id,
      fixed_replacement_issuer_credential_id:
        definition.fixed_replacement_issuer_credential_id,
      fixed_github_management_credential_id: null,
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
      consumer_installation_identity:
        `${definition.consumer_provider}:${definition.consumer_config}:${definition.replacement_secret_name}`,
      production_target_identity:
        productionTargetIdentity(context),
      github_management_required_permission: "not-applicable",
      cloudflare_management_required_permissions:
        definition.management_permissions,
      fixed_old_issuer_credential_id: null,
      fixed_replacement_issuer_credential_id: null,
      fixed_github_management_credential_id: null,
    };
  }
  const prefix =
    `github-repository:${context.github_repository_id}` +
    `:installation:${context.github_installation_id}` +
    `:environment:${context.github_environment_id}` +
    `:workflow:${context.github_workflow_id}`;
  return {
    environment: "production",
    cloudflare_account_id: context.cloudflare_account_id,
    resource_identity: prefix,
    owning_boundary: definition.owning_boundary,
    verification_target:
      `${prefix}:${definition.verification_operation}`,
    required_permission: definition.required_permission,
    consumer_installation_identity:
      `github-repository:${context.github_repository_id}:environment:${context.github_environment_id}:secret:${definition.replacement_secret_name}`,
    production_target_identity:
      productionTargetIdentity(context),
    github_management_required_permission:
      githubManagementPermissionPolicy(context),
    cloudflare_management_required_permissions:
      definition.management_permissions,
    fixed_old_issuer_credential_id: null,
    fixed_replacement_issuer_credential_id: null,
    fixed_github_management_credential_id:
      `github-app-installation:${context.github_installation_id}`,
  };
}

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    value ?? "",
  );
}

function productionTargetIdentity(context) {
  return JSON.stringify({
    cloudflare_account_id: context.cloudflare_account_id,
    worker_scripts: [
      "card-keepr-api",
      "card-keepr-ingestion",
    ],
    d1_databases: [
      context.catalogue_d1_database_id,
      context.disposable_d1_database_id,
    ],
    r2_buckets: [
      "card-keepr-evidence",
      "card-keepr-printing-images",
      "card-keepr-catalogue-exports",
      "card-keepr-backups",
    ],
    workflows: [
      "card-keepr-evidence-ingestion",
      "card-keepr-evidence-host",
    ],
    github_repository_id: context.github_repository_id,
    github_installation_id: context.github_installation_id,
    github_environment_id: context.github_environment_id,
    github_workflow_id: context.github_workflow_id,
  });
}
