import { Hono } from "hono";
import { catalogueRoutes } from "../../../src/catalogue/read";
import { catalogueEnvironment } from "../../../src/catalogue/shared";
import { authenticateBearer } from "../../../src/http/authentication";
import { hasAllowedOrigin, withCorsHeaders } from "../../../src/http/cors";
import { isLivenessRequest } from "../../../src/http/health";
import { withOperationalRequestLog } from "../../../src/http/operational-log";
import { problemResponse } from "../../../src/http/problem";
import { mountedRequest, type PublicBase, publicBase, routePath } from "../../../src/http/public-base";
import { rateLimitFailure } from "../../../src/http/rate-limit";
import { httpDispatch } from "../../../src/http/openapi";
import { routeSegments } from "../../../src/http/routes";
import { apiLivenessRoutes, apiReadinessRoutes, apiPreflightRoutes } from "./utility-routes";
import { apiProblemResponse } from "./problem";
import { apiDocumentationRoutes } from "./documentation-routes";

const routes = [...catalogueRoutes];
const dispatch = httpDispatch(routes);
const dispatchLiveness = httpDispatch(apiLivenessRoutes);
const dispatchReadiness = httpDispatch(apiReadinessRoutes);
const dispatchPreflight = httpDispatch(apiPreflightRoutes);
const dispatchDocumentation = httpDispatch(apiDocumentationRoutes);
const logOptions = { routeSegments: routeSegments([...routes, ...apiDocumentationRoutes], ["/health", "/healthz"]) };

const apiHttp = new Hono<{ Bindings: { env: Env; requestId: string; base: PublicBase } }>();
apiHttp.onError((error, c) => apiProblemResponse(error, c.env.requestId));
apiHttp.use("*", async (c, next) => {
  const { env, requestId } = c.env;
  const request = c.req.raw;
  if (request.method === "GET" && apiDocumentationRoutes.some((route) => route.pathname === c.req.path))
    return dispatchDocumentation(request.method, c.req.path, { ...c.env, request });
  if (request.method === "OPTIONS")
    return dispatchPreflight(request.method, new URL(request.url).pathname, { ...c.env, request });
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
  await next();
});
apiHttp.use("*", async (c, next) => {
  await next();
  c.res = withCorsHeaders(c.req.raw, c.res);
});
apiHttp.use("*", async (c, next) => {
  const { env, requestId } = c.env;
  const request = c.req.raw;
  const url = new URL(request.url);
  if (url.pathname.startsWith("/v1/")) {
    const rateLimit = isPrintingImageContent(url.pathname) ? env.PRINTING_IMAGE_RATE_LIMIT : env.CATALOGUE_RATE_LIMIT;
    const rateLimited = await rateLimitFailure(request, rateLimit, requestId);
    if (rateLimited !== null) {
      return rateLimited;
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
    return authenticationFailure;
  }

  await next();
});
apiHttp.all("*", async (c) => {
  const { env, requestId, base } = c.env;
  const request = c.req.raw;
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health")
    return dispatchReadiness(request.method, url.pathname, { env, request, base, requestId });
  return dispatch(request.method, url.pathname, {
    request,
    env: catalogueEnvironment(env),
    requestId,
    base,
  });
});
async function handleApiRequest(request: Request, env: Env, requestId: string, base: PublicBase): Promise<Response> {
  try {
    return await apiHttp.fetch(request, { env, requestId, base });
  } catch (error) {
    // Hono onError handles Error instances; preserve the protected boundary for
    // foreign thrown values as well (including undefined).
    const response = await apiProblemResponse(error, requestId);
    return request.method !== "OPTIONS" && hasAllowedOrigin(request, env.CORS_ALLOWED_ORIGINS)
      ? withCorsHeaders(request, response)
      : response;
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
        async (observedEnv, requestId) =>
          dispatchLiveness(mounted.method, route, { env: observedEnv, request: mounted, base, requestId }),
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
