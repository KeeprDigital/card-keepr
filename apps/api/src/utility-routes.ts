import { createRoute, z } from "@hono/zod-openapi";
import { httpRoute, streamingHttpRoute, problemResponses, secured } from "../../../src/http/openapi";
import { livenessRequest, readinessResponse } from "../../../src/http/health";
import { allowedPreflightResponse } from "../../../src/http/cors";
import { problemResponse } from "../../../src/http/problem";
import type { PublicBase } from "../../../src/http/public-base";
import { readinessSchema } from "../../../src/http/health-contract";
import { apiCapabilities } from "../../../src/runtime-capabilities.mjs";

type Context = { env: Env; request: Request; requestId: string; base: PublicBase };
const cacheHeaders = { "Cache-Control": { required: true, schema: { type: "string" as const } } };
const healthSchema = readinessSchema("api", apiCapabilities, ["PRINTING_IMAGES", "CATALOGUE_EXPORTS"]);
const readiness = createRoute({
  method: "get",
  path: "/health",
  operationId: "getReadiness",
  security: secured,
  responses: {
    ...problemResponses,
    200: {
      description: "Authenticated API binding readiness.",
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
});
const livenessSchema = z.strictObject({ status: z.literal("ok"), runtime: z.literal("api") }).openapi("ApiLiveness");
export const apiReadinessRoutes = [
  httpRoute<Context>()(readiness, async (c) => {
    const { env, request, base } = c.env;
    const response = await readinessResponse("api", apiCapabilities, {
      database: env.CATALOGUE_DB,
      buckets: { PRINTING_IMAGES: env.PRINTING_IMAGES, CATALOGUE_EXPORTS: env.CATALOGUE_EXPORTS },
      publicBase: base,
      request,
      version: env.CF_VERSION_METADATA,
    });
    const document = healthSchema.parse(await response.json());
    return c.json(document, document.status === "ok" ? 200 : 503, Object.fromEntries(response.headers));
  }),
];
export const apiLivenessRoutes = (["get", "head"] as const).map((method) =>
  streamingHttpRoute<Context>()(
    createRoute({
      method,
      path: "/healthz",
      operationId: method === "get" ? "getLiveness" : "headLiveness",
      security: [],
      responses: {
        ...(method === "get"
          ? problemResponses
          : Object.fromEntries(
              Object.entries(problemResponses).map(([code, { content: _content, ...branch }]) => [code, branch]),
            )),
        200: {
          description: "Unauthenticated liveness, behind its independent rate limit.",
          headers: cacheHeaders,
          ...(method === "get" ? { content: { "application/json": { schema: livenessSchema } } } : {}),
        },
      },
    }),
    async (c) => livenessRequest(c.env.request, c.env.env.API_LIVENESS_RATE_LIMIT, "api", c.env.requestId),
  ),
);

const vary = { Vary: { required: true, schema: { type: "string" as const } } };
export const apiPreflightRoutes = [
  streamingHttpRoute<Context>()(
    createRoute({
      method: "options",
      path: "/*",
      operationId: "consumerPreflight",
      security: [],
      description: "Browser preflight for any path inside the API mount. It is evaluated before bearer authentication.",
      request: {
        headers: z.object({
          origin: z.string().optional(),
          "access-control-request-method": z.string().optional(),
          "access-control-request-headers": z.string().optional(),
        }),
      },
      responses: {
        204: {
          description: "Allowed consumer preflight; no body.",
          headers: {
            ...vary,
            "Access-Control-Allow-Origin": { required: true, schema: { type: "string" } },
            "Access-Control-Allow-Methods": { required: true, schema: { type: "string" } },
            "Access-Control-Allow-Headers": { required: true, schema: { type: "string" } },
          },
        },
        403: { ...problemResponses[403]!, headers: vary },
      },
    }),
    async (c) => {
      c.req.valid("header");
      return (
        allowedPreflightResponse(c.env.request, c.env.env.CORS_ALLOWED_ORIGINS) ??
        problemResponse({
          requestId: c.env.requestId,
          status: 403,
          code: "forbidden_origin",
          title: "Forbidden preflight",
          detail: "The browser preflight does not match the allowed origin, method, or headers.",
          headers: { vary: "Origin" },
        })
      );
    },
  ),
];

export const apiUtilityFamilies = {
  readiness: apiReadinessRoutes,
  liveness: apiLivenessRoutes,
  preflight: apiPreflightRoutes,
};
