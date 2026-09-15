import { Hono } from "hono";
import { administrationRoutes, platformRoutes } from "../../../src/catalogue/ingestion";
import { enforceRecoveryRestoreGuard } from "../../../src/catalogue/backup-recovery";
import { enforceFreshBaselineMutationGuard, type PublicationBackupWaiter } from "../../../src/catalogue/ingestion";
import { type CatalogueStore, catalogueEnvironment, catalogueStore } from "../../../src/catalogue/shared";
import { authenticateBearer } from "../../../src/http/authentication";
import { isLivenessRequest } from "../../../src/http/health";
import { withOperationalRequestLog } from "../../../src/http/operational-log";
import { problemResponse } from "../../../src/http/problem";
import { mountedRequest, type PublicBase, publicBase, routePath } from "../../../src/http/public-base";
import { rateLimitFailure } from "../../../src/http/rate-limit";
import { httpDispatch } from "../../../src/http/openapi";
import { type RouteContext, routeSegments } from "../../../src/http/routes";
import { ingestionProblemResponse } from "./problem";
import { administrationObservedAt, publicationBackupWaiter } from "./request-clock";
import { administrationDocumentationRoutes } from "./documentation-routes";

import { administrationReadinessRoutes, administrationLivenessRoutes } from "./utility-routes";

const dispatchReadiness = httpDispatch(administrationReadinessRoutes);
const dispatchLiveness = httpDispatch(administrationLivenessRoutes);
const dispatchPlatform = httpDispatch(platformRoutes);
const routes = administrationRoutes;
const dispatch = httpDispatch<
  RouteContext<Omit<Env, "CATALOGUE_DB"> & { CATALOGUE_DB: CatalogueStore }> & {
    observedAt: string;
    publicationBackupWaiter: PublicationBackupWaiter;
  }
>(routes);
const dispatchDocumentation = httpDispatch(administrationDocumentationRoutes);
const logOptions = {
  routeSegments: routeSegments([...routes, ...administrationDocumentationRoutes], ["/health", "/healthz"]),
};

export { CatalogueBackupWorkflow } from "./backup-workflow";
export { EvidenceHostWorkflow, EvidenceIngestionWorkflow } from "./evidence-workflows";
export { OfficialSourceTransport } from "./official-source-transport";
export { ReconciliationWorkflow } from "./reconciliation-workflow";

type AdministrationBindings = { env: Env; context: ExecutionContext | undefined; requestId: string; base: PublicBase };
const administrationHttp = new Hono<{ Bindings: AdministrationBindings; Variables: { observedAt: string } }>();
administrationHttp.onError((error, c) => ingestionProblemResponse(error, c.env.requestId));
administrationHttp.use("*", async (c, next) => {
  const { env, requestId, base } = c.env;
  const request = c.req.raw;
  const rateLimited = await rateLimitFailure(request, env.ADMINISTRATION_RATE_LIMIT, requestId);
  if (rateLimited !== null) return rateLimited;

  const platformPath = new URL(request.url).pathname;
  if (
    platformPath === "/v1/dev-deployments" ||
    platformPath === "/v1/staging-release-authorizations" ||
    (request.method === "POST" &&
      (platformPath === "/v1/staging-deployments" || /^\/v1\/staging-deployments\/[^/]+\/outcome$/u.test(platformPath)))
  )
    return dispatchPlatform(request.method, platformPath, { request, requestId, base, env: catalogueEnvironment(env) });

  const authenticationFailure = await authenticateBearer(
    request,
    [env.ADMINISTRATION_KEY, env.ADMINISTRATION_KEY_REPLACEMENT],
    requestId,
    {
      missing: "authentication_required",
      invalid: "invalid_administration_key",
    },
  );
  if (authenticationFailure !== null) return authenticationFailure;

  if (request.method === "GET" && administrationDocumentationRoutes.some((route) => route.pathname === c.req.path))
    return dispatchDocumentation(request.method, c.req.path, { request, requestId, base });

  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health")
    return dispatchReadiness(request.method, url.pathname, { env, request, base, requestId });
  const observedAt = administrationObservedAt(request, env);
  c.set("observedAt", observedAt);
  await enforceRecoveryRestoreGuard(catalogueStore(env.CATALOGUE_DB));

  await enforceFreshBaselineMutationGuard(catalogueStore(env.CATALOGUE_DB), request.method, url.pathname);
  await next();
});
administrationHttp.all("*", async (c) => {
  const { env, context, requestId, base } = c.env;
  const request = c.req.raw;
  const url = new URL(request.url);
  const observedAt = c.get("observedAt");
  const response = await dispatch(request.method, url.pathname, {
    request,
    env: catalogueEnvironment(env),
    context,
    requestId,
    base,
    observedAt,
    publicationBackupWaiter: publicationBackupWaiter(env),
  });
  if (response !== null) return response;

  return problemResponse({
    requestId,
    status: 404,
    code: "not_found",
    title: "Not found",
    detail: "The requested administration operation does not exist.",
  });
});
async function handleIngestionRequest(
  request: Request,
  env: Env,
  context: ExecutionContext | undefined,
  requestId: string,
  base: PublicBase,
): Promise<Response> {
  try {
    return await administrationHttp.fetch(request, { env, context, requestId, base });
  } catch (error) {
    return ingestionProblemResponse(error, requestId);
  }
}

const ingestionWorker = {
  async fetch(request: Request, env: Env, context?: ExecutionContext): Promise<Response> {
    // The worker is mounted at the path of PUBLIC_BASE_URL (ADR 0007). A
    // request outside the mount is not routed at all: no rate limit, no
    // authentication, just a 404 problem. Everything under the mount is
    // handled as if the worker served the root.
    const base = publicBase(env);
    const route = routePath(new URL(request.url), base.basePath);
    if (route === null) {
      return withOperationalRequestLog(
        "ingestion",
        request,
        env,
        async (_observedEnv, requestId) =>
          problemResponse({
            requestId,
            status: 404,
            code: "not_found",
            title: "Not found",
            detail: "The requested resource does not exist.",
          }),
        logOptions,
      );
    }
    const mounted = mountedRequest(request, route);
    // Liveness (issue #144) is unauthenticated, behind its own rate limit,
    // and kept out of the operational request log.
    if (isLivenessRequest(request.method, route)) {
      return withOperationalRequestLog(
        "ingestion",
        mounted,
        env,
        async (observedEnv, requestId) =>
          dispatchLiveness(mounted.method, route, { env: observedEnv, request: mounted, base, requestId }),
        { logged: false },
      );
    }
    return withOperationalRequestLog(
      "ingestion",
      mounted,
      env,
      (observedEnv, requestId) => handleIngestionRequest(mounted, observedEnv, context, requestId, base),
      logOptions,
    );
  },
} satisfies ExportedHandler<Env>;

export default ingestionWorker;
