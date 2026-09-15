import { createRoute, z } from "@hono/zod-openapi";
import { httpRoute, streamingHttpRoute, problemResponses, secured } from "../../../src/http/openapi";
import { livenessRequest, readinessResponse } from "../../../src/http/health";
import { readinessSchema } from "../../../src/http/health-contract";
import type { RouteContext } from "../../../src/http/routes";
import { ingestionCapabilities } from "../../../src/runtime-capabilities.mjs";
import { inspectWorkflowInstance } from "../../../src/catalogue/shared";

type Context = RouteContext<Env>;
const cacheHeaders = { "Cache-Control": { required: true, schema: { type: "string" as const, const: "no-store" } } };
const healthSchema = readinessSchema(
  "ingestion",
  ingestionCapabilities,
  ["EVIDENCE_OBJECTS", "PRINTING_IMAGES", "CATALOGUE_EXPORTS", "BACKUPS"],
  ["EVIDENCE_INGESTION_WORKFLOW", "EVIDENCE_HOST_WORKFLOW", "RECONCILIATION_WORKFLOW", "CATALOGUE_BACKUP_WORKFLOW"],
);

export const administrationReadinessRoutes = [
  httpRoute<Context>()(
    createRoute({
      method: "get",
      path: "/health",
      operationId: "getAdministrationReadiness",
      security: secured,
      responses: {
        ...problemResponses,
        200: {
          description: "Authenticated administration binding readiness; available during recovery.",
          headers: cacheHeaders,
          content: { "application/json": { schema: healthSchema } },
        },
        503: {
          description: "Degraded readiness or unavailable authentication configuration.",
          headers: cacheHeaders,
          content: {
            "application/json": { schema: healthSchema },
            "application/problem+json": problemResponses[503]!.content["application/problem+json"],
          },
        },
      },
    }),
    async (c) => {
      const { env, base, request } = c.env;
      const response = await readinessResponse("ingestion", ingestionCapabilities, {
        database: env.CATALOGUE_DB,
        configuredDatabaseId: env.CATALOGUE_D1_DATABASE_ID,
        buckets: {
          EVIDENCE_OBJECTS: env.EVIDENCE_OBJECTS,
          PRINTING_IMAGES: env.PRINTING_IMAGES,
          CATALOGUE_EXPORTS: env.CATALOGUE_EXPORTS,
          BACKUPS: env.BACKUPS,
        },
        inspectWorkflow: inspectWorkflowInstance,
        workflows: {
          EVIDENCE_INGESTION_WORKFLOW: env.EVIDENCE_INGESTION_WORKFLOW,
          EVIDENCE_HOST_WORKFLOW: env.EVIDENCE_HOST_WORKFLOW,
          RECONCILIATION_WORKFLOW: env.RECONCILIATION_WORKFLOW,
          CATALOGUE_BACKUP_WORKFLOW: env.CATALOGUE_BACKUP_WORKFLOW,
        },
        publicBase: base,
        request,
        version: env.CF_VERSION_METADATA,
      });
      const document = healthSchema.parse(await response.json());
      return c.json(document, document.status === "ok" ? 200 : 503, Object.fromEntries(response.headers));
    },
  ),
];

export const administrationLivenessRoutes = (["get", "head"] as const).map((method) =>
  streamingHttpRoute<Context>()(
    createRoute({
      method,
      path: "/healthz",
      operationId: method === "get" ? "getAdministrationLiveness" : "headAdministrationLiveness",
      security: [],
      responses: {
        ...(method === "get"
          ? problemResponses
          : Object.fromEntries(
              Object.entries(problemResponses).map(([code, { content: _content, ...branch }]) => [code, branch]),
            )),
        200: {
          description: "Independent unauthenticated liveness, behind its own rate limit.",
          headers: cacheHeaders,
          ...(method === "get"
            ? {
                content: {
                  "application/json": {
                    schema: z.strictObject({ status: z.literal("ok"), runtime: z.literal("ingestion") }),
                  },
                },
              }
            : {}),
        },
      },
    }),
    async (c) => livenessRequest(c.env.request, c.env.env.INGESTION_LIVENESS_RATE_LIMIT, "ingestion", c.env.requestId),
  ),
);

export const administrationUtilityFamilies = {
  readiness: administrationReadinessRoutes,
  liveness: administrationLivenessRoutes,
};
