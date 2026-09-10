import { administrationPresentation } from "../../../src/http/administration-presentation.mjs";
import { backupRecoveryRoutes, enforceRecoveryRestoreGuard } from "../../../src/catalogue/backup-recovery";
import { curatedRoutes } from "../../../src/catalogue/curated";
import { exportRoutes } from "../../../src/catalogue/export";
import {
  enforceFreshBaselineMutationGuard,
  ingestionRoutes,
  type PublicationBackupWaiter,
} from "../../../src/catalogue/ingestion";
import { reconciliationRoutes } from "../../../src/catalogue/reconciliation";
import {
  type CatalogueStore,
  catalogueEnvironment,
  catalogueStore,
  inspectWorkflowInstance,
} from "../../../src/catalogue/shared";
import { sourceEvidenceRoutes } from "../../../src/catalogue/source-evidence";
import { authenticateBearer } from "../../../src/http/authentication";
import { isLivenessRequest, livenessRequest, readinessResponse } from "../../../src/http/health";
import { withOperationalRequestLog } from "../../../src/http/operational-log";
import { problemResponse } from "../../../src/http/problem";
import { mountedRequest, type PublicBase, publicBase, routePath } from "../../../src/http/public-base";
import { rateLimitFailure } from "../../../src/http/rate-limit";
import { type RouteContext, routeSegments, routeTable } from "../../../src/http/routes";
import { ingestionCapabilities } from "../../../src/runtime-capabilities.mjs";
import { ingestionProblemResponse } from "./problem";
import { administrationObservedAt, publicationBackupWaiter } from "./request-clock";

const routes = [
  ...ingestionRoutes,
  ...sourceEvidenceRoutes,
  ...reconciliationRoutes,
  ...curatedRoutes,
  ...exportRoutes,
  ...backupRecoveryRoutes,
];
const dispatch = routeTable<
  RouteContext<Omit<Env, "CATALOGUE_DB"> & { CATALOGUE_DB: CatalogueStore }> & {
    observedAt: string;
    publicationBackupWaiter: PublicationBackupWaiter;
  }
>(routes);
const logOptions = { routeSegments: routeSegments(routes, ["/health", "/healthz"]) };

export { CatalogueBackupWorkflow } from "./backup-workflow";
export {
  EvidenceHostWorkflow,
  EvidenceIngestionWorkflow,
} from "./evidence-workflows";
export { OfficialSourceTransport } from "./official-source-transport";
export { ReconciliationWorkflow } from "./reconciliation-workflow";

async function handleIngestionRequest(
  request: Request,
  env: Env,
  context: ExecutionContext | undefined,
  requestId: string,
  base: PublicBase,
): Promise<Response> {
  try {
    const rateLimited = await rateLimitFailure(request, env.ADMINISTRATION_RATE_LIMIT, requestId);
    if (rateLimited !== null) return rateLimited;

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

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return await readinessResponse("ingestion", ingestionCapabilities, {
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
    }
    const observedAt = administrationObservedAt(request, env);
    await enforceRecoveryRestoreGuard(catalogueStore(env.CATALOGUE_DB));

    await enforceFreshBaselineMutationGuard(catalogueStore(env.CATALOGUE_DB), request.method, url.pathname);
    const response = await dispatch(request.method, url.pathname, {
      request,
      env: catalogueEnvironment(env),
      context,
      requestId,
      base,
      observedAt,
      publicationBackupWaiter: publicationBackupWaiter(env),
    });
    if (response !== null) {
      const vary = response.headers.get("vary");
      if (vary !== "*" && !vary?.split(",").some((value) => value.trim().toLowerCase() === "accept"))
        response.headers.set("vary", vary ? `${vary}, Accept` : "Accept");
      if (
        request.headers.get("accept") === "application/vnd.card-keepr.cli+json" &&
        response.ok &&
        response.headers.get("content-type")?.includes("application/json")
      ) {
        const document = await response.json<Record<string, unknown>>();
        const headers = new Headers(response.headers);
        headers.delete("etag");
        headers.delete("content-length");
        return Response.json(administrationPresentation(document, response.status), {
          status: response.status,
          headers,
        });
      }
      return response;
    }

    return problemResponse({
      requestId,
      status: 404,
      code: "not_found",
      title: "Not found",
      detail: "The requested administration operation does not exist.",
    });
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
        (observedEnv, requestId) =>
          livenessRequest(mounted, observedEnv.INGESTION_LIVENESS_RATE_LIMIT, "ingestion", requestId),
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
