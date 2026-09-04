import { authenticateBearer } from "../../../src/http/authentication";
import { catalogueRoutes } from "../../../src/catalogue/read";
import { allowedPreflightResponse, hasAllowedOrigin, withCorsHeaders } from "../../../src/http/cors";
import { isLivenessRequest, livenessRequest, readinessResponse } from "../../../src/http/health";
import { problemResponse } from "../../../src/http/problem";
import { rateLimitFailure } from "../../../src/http/rate-limit";
import { apiCapabilities } from "../../../src/runtime-capabilities.mjs";
import { withOperationalRequestLog } from "../../../src/http/operational-log";
import { mountedRequest, publicBase, routePath, type PublicBase } from "../../../src/http/public-base";

import { routeTable, routeSegments } from "../../../src/http/routes";
import { apiProblemResponse } from "./problem";

const routes = [...catalogueRoutes];
const dispatch = routeTable(routes);
const logOptions = { routeSegments: routeSegments(routes, ["/health", "/healthz"]) };

async function handleApiRequest(request: Request, env: Env, requestId: string, base: PublicBase): Promise<Response> {
  try {
    const preflight = allowedPreflightResponse(request, env.CORS_ALLOWED_ORIGINS);
    if (preflight !== null) return preflight;
    if (request.method === "OPTIONS") {
      return problemResponse({
        requestId,
        status: 403,
        code: "forbidden_origin",
        title: "Forbidden preflight",
        detail: "The browser preflight does not match the allowed origin, method, or headers.",
        headers: { vary: "Origin" },
      });
    }
    if (!hasAllowedOrigin(request, env.CORS_ALLOWED_ORIGINS)) {
      return problemResponse({
        requestId,
        status: 403,
        code: "forbidden_origin",
        title: "Forbidden origin",
        detail: "The browser origin is not allowed for this environment.",
        headers: { vary: "Origin" },
      });
    }

    const url = new URL(request.url);
    if (url.pathname.startsWith("/v1/")) {
      const rateLimit = isPrintingImageContent(url.pathname) ? env.PRINTING_IMAGE_RATE_LIMIT : env.CATALOGUE_RATE_LIMIT;
      const rateLimited = await rateLimitFailure(request, rateLimit, requestId);
      if (rateLimited !== null) {
        return withCorsHeaders(request, rateLimited);
      }
    }

    const authenticationFailure = await authenticateBearer(
      request,
      [env.API_BEARER_KEY, env.API_BEARER_KEY_REPLACEMENT],
      requestId,
      {
        missing: "authentication_required",
        invalid: "invalid_api_key",
      },
    );
    if (authenticationFailure !== null) {
      return withCorsHeaders(request, authenticationFailure);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return withCorsHeaders(
        request,
        await readinessResponse("api", apiCapabilities, {
          database: env.CATALOGUE_DB,
          buckets: {
            PRINTING_IMAGES: env.PRINTING_IMAGES,
            CATALOGUE_EXPORTS: env.CATALOGUE_EXPORTS,
          },
          publicBase: base,
          request,
          version: env.CF_VERSION_METADATA,
        }),
      );
    }

    const response = await dispatch(request.method, url.pathname, { request, env, requestId, base });
    if (response !== null) return withCorsHeaders(request, response);

    return withCorsHeaders(
      request,
      problemResponse({
        requestId,
        status: 404,
        code: "not_found",
        title: "Not found",
        detail: "The requested resource does not exist.",
      }),
    );
  } catch (error) {
    return withCorsHeaders(request, apiProblemResponse(error, request, requestId, base));
  }
}

const apiWorker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    // The worker is mounted at the path of PUBLIC_BASE_URL (ADR 0007). A
    // request outside the mount is not routed at all: no rate limit, no
    // authentication, just a 404 problem. Everything under the mount is
    // handled as if the worker served the root, so routes, cursors, and
    // operational log routes stay mount-free.
    const base = publicBase(env);
    const route = routePath(new URL(request.url), base.basePath);
    if (route === null) {
      return withOperationalRequestLog(
        "api",
        request,
        env,
        async (_observedEnv, requestId) => withCorsHeaders(request, outsideMountResponse(requestId)),
        logOptions,
      );
    }
    const mounted = mountedRequest(request, route);
    // Liveness (issue #144) is unauthenticated, behind its own rate limit,
    // and kept out of the operational request log.
    if (isLivenessRequest(request.method, route)) {
      return withOperationalRequestLog(
        "api",
        mounted,
        env,
        (observedEnv, requestId) => livenessRequest(mounted, observedEnv.API_LIVENESS_RATE_LIMIT, "api", requestId),
        { logged: false },
      );
    }
    return withOperationalRequestLog(
      "api",
      mounted,
      env,
      (observedEnv, requestId) => handleApiRequest(mounted, observedEnv, requestId, base),
      logOptions,
    );
  },
} satisfies ExportedHandler<Env>;

function outsideMountResponse(requestId: string): Response {
  return problemResponse({
    requestId,
    status: 404,
    code: "not_found",
    title: "Not found",
    detail: "The requested resource does not exist.",
  });
}

export default apiWorker;

function isPrintingImageContent(pathname: string): boolean {
  return pathname.startsWith("/v1/printing-images/") && pathname.endsWith("/content");
}
