import { z } from "@hono/zod-openapi";

const status = z.enum(["pass", "fail"]);
const probe = z.strictObject({ status, reason: z.enum(["binding_missing", "probe_failed", "timed_out"]).optional() });

/** Readiness describes each Worker's actual binding inventory. */
export function readinessSchema(
  runtime: "api" | "ingestion",
  capabilities: readonly string[],
  buckets: readonly string[],
  workflows: readonly string[] = [],
) {
  return z
    .strictObject({
      contract: z.literal("card-keepr-runtime-health@1"),
      runtime: z.literal(runtime),
      status: z.enum(["ok", "degraded"]),
      capabilities: z.array(z.enum(capabilities)),
      checks: z.strictObject({
        database: z.strictObject({
          status,
          migration_level: z.number().int().nullable(),
          current_revision_id: z.string().nullable(),
          ...(runtime === "ingestion" ? { configured_database_id: z.string() } : {}),
          reason: z
            .enum([
              "binding_missing",
              "query_failed",
              "schema_state_missing",
              "catalogue_state_missing",
              "database_id_not_configured",
              "timed_out",
            ])
            .optional(),
        }),
        objects: z.strictObject({
          status,
          buckets: z.strictObject(Object.fromEntries(buckets.map((name) => [name, probe]))),
        }),
        ...(workflows.length
          ? {
              workflows: z.strictObject({
                status,
                bindings: z.strictObject(
                  Object.fromEntries(
                    workflows.map((name) => [
                      name,
                      z.strictObject({
                        status,
                        reason: z
                          .enum(["binding_missing", "probe_failed", "timed_out", "unexpected_instance"])
                          .optional(),
                      }),
                    ]),
                  ),
                ),
              }),
            }
          : {}),
        public_base: z.strictObject({ status, configured: z.string(), arrived_through_public_base: z.boolean() }),
        version: z.strictObject({
          status,
          id: z.string().nullable(),
          tag: z.string().nullable(),
          timestamp: z.string().nullable(),
        }),
      }),
    })
    .openapi(runtime === "api" ? "ApiReadiness" : "AdministrationReadiness");
}
