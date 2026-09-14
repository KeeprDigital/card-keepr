export function isolatedBindings(config) {
  return [
    ...Object.entries(config.vars ?? {}).map(([name, text]) => ({ name, type: "plain_text", text: String(text) })),
    ...config.d1_databases.map((item) => ({ name: item.binding, type: "d1", database_id: item.database_id })),
    ...config.r2_buckets.map((item) => ({ name: item.binding, type: "r2_bucket", bucket_name: item.bucket_name })),
    ...(config.services ?? []).map((item) => ({
      name: item.binding,
      type: "service",
      service: item.service,
      environment: "production",
      entrypoint: item.entrypoint,
    })),
    ...(config.workflows ?? []).map((item) => ({
      name: item.binding,
      type: "workflow",
      workflow_name: item.name,
      class_name: item.class_name,
      script_name: config.name,
    })),
    ...config.ratelimits.map((item) => ({
      name: item.name,
      type: "ratelimit",
      namespace_id: item.namespace_id,
      simple: item.simple,
    })),
    ...(config.version_metadata ? [{ name: config.version_metadata.binding, type: "version_metadata" }] : []),
    ...(config.name.startsWith("card-keepr-api-")
      ? ["API_BEARER_KEY", "API_BEARER_KEY_REPLACEMENT"]
      : ["ADMINISTRATION_KEY", "ADMINISTRATION_KEY_REPLACEMENT", "D1_EXPORT_TOKEN", "D1_VERIFICATION_TOKEN"]
    ).map((name) => ({ name, type: "secret_text" })),
  ];
}
