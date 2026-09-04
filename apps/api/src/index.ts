import { authenticateBearer } from "../../../src/http/authentication";
import {
  CardReadProblem,
  CatalogueExportReadProblem,
  catalogueExportComponentResponse,
  catalogueExportResponse,
  catalogueExportsResponse,
  currentCardResponse,
  currentCatalogueStatus,
  currentPrintingResponse,
  printingImageContentResponse,
  PrintingReadProblem,
} from "../../../src/catalogue/read";
import {
  currentProductResponse,
  currentProductsResponse,
  ProductReadProblem,
} from "../../../src/catalogue/product-release-read";
import {
  currentPrintingsResponse,
  PrintingCollectionReadProblem,
} from "../../../src/catalogue/printing-collection-read";
import {
  catalogueResponse,
} from "../../../src/http/catalogue";
import {
  allowedPreflightResponse,
  hasAllowedOrigin,
  withCorsHeaders,
} from "../../../src/http/cors";
import {
  isLivenessRequest,
  livenessRequest,
  readinessResponse,
} from "../../../src/http/health";
import { problemResponse } from "../../../src/http/problem";
import { rateLimitFailure } from "../../../src/http/rate-limit";
import { apiCapabilities } from "../../../src/runtime-capabilities.mjs";
import {
  cardCollectionResponse,
} from "../../../src/catalogue/card-collection-read";
import {
  contextualLegalityStatusResponse,
  LegalityStatusProblem,
} from "../../../src/catalogue/legality-status";
import { withOperationalRequestLog } from "../../../src/http/operational-log";
import {
  mountedRequest,
  publicBase,
  publicUrl,
  routePath,
  type PublicBase,
} from "../../../src/http/public-base";

async function handleApiRequest(
  request: Request,
  env: Env,
  requestId: string,
  base: PublicBase,
): Promise<Response> {
    try {
      const preflight = allowedPreflightResponse(
        request,
        env.CORS_ALLOWED_ORIGINS,
      );
      if (preflight !== null) return preflight;
      if (request.method === "OPTIONS") {
        return problemResponse({
          requestId,
          status: 403,
          code: "forbidden_origin",
          title: "Forbidden preflight",
          detail:
            "The browser preflight does not match the allowed origin, method, or headers.",
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
        const rateLimit = isPrintingImageContent(url.pathname)
          ? env.PRINTING_IMAGE_RATE_LIMIT
          : env.CATALOGUE_RATE_LIMIT;
        const rateLimited = await rateLimitFailure(
          request,
          rateLimit,
          requestId,
        );
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

      if (request.method === "GET" && url.pathname === "/v1/catalogue") {
        return withCorsHeaders(
          request,
          catalogueResponse(
            await currentCatalogueStatus(env.CATALOGUE_DB),
            base,
            request,
          ),
        );
      }

      if (request.method === "GET" && url.pathname === "/v1/cards") {
        return withCorsHeaders(
          request,
          await cardCollectionResponse(
            env.CATALOGUE_DB,
            request,
            requestId,
            base,
          ),
        );
      }

      if (
        request.method === "GET" &&
        url.pathname === "/v1/legality-status"
      ) {
        try {
          return withCorsHeaders(
            request,
            await contextualLegalityStatusResponse(
              request,
              env.CATALOGUE_DB,
              base,
            ),
          );
        } catch (error) {
          if (error instanceof LegalityStatusProblem) {
            return withCorsHeaders(
              request,
              problemResponse({
                requestId,
                status: error.status,
                code: error.code,
                title:
                  error.status === 404
                    ? "Not found"
                    : error.status === 422
                      ? "Invalid Legality region"
                      : error.status === 500
                        ? "Catalogue integrity failure"
                        : "Invalid request",
                detail: error.message,
                extensions: error.invalidParameter === null
                  ? undefined
                  : { invalid_params: [error.invalidParameter] },
              }),
            );
          }
          throw error;
        }
      }

      const cardMatch = /^\/v1\/cards\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && cardMatch !== null) {
        const response = await currentCardResponse(
          env.CATALOGUE_DB,
          decodeURIComponent(cardMatch[1]!),
          request,
          base,
        );
        if (response !== null) return withCorsHeaders(request, response);
      }

      const printingMatch = /^\/v1\/printings\/([^/]+)$/.exec(
        url.pathname,
      );
      if (request.method === "GET" && printingMatch !== null) {
        const response = await currentPrintingResponse(
          env.CATALOGUE_DB,
          decodeURIComponent(printingMatch[1]!),
          request,
          base,
        );
        if (response !== null) return withCorsHeaders(request, response);
      }

      if (request.method === "GET" && url.pathname === "/v1/printings") {
        return withCorsHeaders(
          request,
          await currentPrintingsResponse(env.CATALOGUE_DB, request, base),
        );
      }

      const printingImageContentMatch =
        /^\/v1\/printing-images\/([^/]+)\/content$/.exec(url.pathname);
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        printingImageContentMatch !== null
      ) {
        const response = await printingImageContentResponse(
          request,
          env.CATALOGUE_DB,
          env.PRINTING_IMAGES,
          decodeURIComponent(printingImageContentMatch[1]!),
          requestId,
        );
        if (response !== null) return withCorsHeaders(request, response);
      }

      if (request.method === "GET" && url.pathname === "/v1/products") {
        return withCorsHeaders(
          request,
          await currentProductsResponse(env.CATALOGUE_DB, request, base),
        );
      }

      const productMatch = /^\/v1\/products\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && productMatch !== null) {
        const response = await currentProductResponse(
          env.CATALOGUE_DB,
          decodeURIComponent(productMatch[1]!),
          request,
          base,
        );
        if (response !== null) return withCorsHeaders(request, response);
      }

      const exportComponentMatch =
        /^\/v1\/catalogue-exports\/([^/]+)\/components\/([^/]+)$/.exec(
          url.pathname,
        );
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        exportComponentMatch !== null
      ) {
        const response = await catalogueExportComponentResponse(
          request,
          env.CATALOGUE_DB,
          env.CATALOGUE_EXPORTS,
          decodeURIComponent(exportComponentMatch[1]!),
          decodeURIComponent(exportComponentMatch[2]!),
          requestId,
        );
        if (response !== null) return withCorsHeaders(request, response);
      }

      if (
        request.method === "GET" &&
        url.pathname === "/v1/catalogue-exports"
      ) {
        return withCorsHeaders(
          request,
          await catalogueExportsResponse(
            request,
            env.CATALOGUE_DB,
            env.CATALOGUE_EXPORTS,
            base,
          ),
        );
      }

      const exportMatch = /^\/v1\/catalogue-exports\/([^/]+)$/.exec(
        url.pathname,
      );
      if (request.method === "GET" && exportMatch !== null) {
        const response = await catalogueExportResponse(
          request,
          env.CATALOGUE_DB,
          env.CATALOGUE_EXPORTS,
          decodeURIComponent(exportMatch[1]!),
          base,
        );
        if (response !== null) return withCorsHeaders(request, response);
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
      if (error instanceof ProductReadProblem) {
        return withCorsHeaders(
          request,
          problemResponse({
            requestId,
            status: error.status,
            code: error.code,
            title:
              error.status === 409
                ? "Cursor revision unavailable"
                : "Invalid Product request",
            detail: error.message,
            ...(error.code === "cursor_revision_unavailable"
              ? {
                  extensions: {
                    links: { collection: publicUrl(base, "/v1/products") },
                  },
                }
              : error.invalidParameter === null
              ? {}
              : {
                  extensions: {
                    invalid_params: [error.invalidParameter],
                  },
                }),
          }),
        );
      }
      if (error instanceof PrintingCollectionReadProblem) {
        return withCorsHeaders(
          request,
          problemResponse({
            requestId,
            status: error.status,
            code: error.code,
            title:
              error.status === 409
                ? "Cursor revision unavailable"
                : "Invalid Printing request",
            detail: error.message,
            ...(error.code === "cursor_revision_unavailable"
              ? {
                  extensions: {
                    links: { collection: publicUrl(base, "/v1/printings") },
                  },
                }
              : error.invalidParameter === null
              ? {}
              : {
                  extensions: {
                    invalid_params: [error.invalidParameter],
                  },
                }),
          }),
        );
      }
      if (error instanceof CardReadProblem) {
        return withCorsHeaders(
          request,
          problemResponse({
            requestId,
            status: error.status,
            code: error.code,
            title: "Invalid Card request",
            detail: error.message,
          }),
        );
      }
      if (error instanceof PrintingReadProblem) {
        return withCorsHeaders(
          request,
          problemResponse({
            requestId,
            status: error.status,
            code: error.code,
            title: "Invalid Printing request",
            detail: error.message,
          }),
        );
      }
      if (error instanceof CatalogueExportReadProblem) {
        return withCorsHeaders(
          request,
          problemResponse({
            requestId,
            status: error.status,
            code: error.code,
            title: error.status === 409
              ? "Cursor revision unavailable"
              : error.status === 410
                ? "Catalogue Export deleted"
              : error.code === "invalid_cursor"
                ? "Invalid Catalogue Export cursor"
                : "Invalid Catalogue Export request",
            detail: error.message,
            ...(error.status === 409
              ? {
                  extensions: {
                    links: {
                      collection: publicUrl(base, "/v1/catalogue-exports"),
                    },
                  },
                }
              : {}),
          }),
        );
      }
      return withCorsHeaders(
        request,
        problemResponse({
          requestId,
          status: 500,
          code: "internal_error",
          title: "Internal server error",
          detail: "The request could not be completed.",
        }),
      );
    }
}

const apiWorker = {
  async fetch(
    request: Request,
    env: Env,
  ): Promise<Response> {
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
        async (_observedEnv, requestId) =>
          withCorsHeaders(request, outsideMountResponse(requestId)),
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
        (observedEnv, requestId) =>
          livenessRequest(
            mounted,
            observedEnv.API_LIVENESS_RATE_LIMIT,
            "api",
            requestId,
          ),
        { logged: false },
      );
    }
    return withOperationalRequestLog(
      "api",
      mounted,
      env,
      (observedEnv, requestId) =>
        handleApiRequest(mounted, observedEnv, requestId, base),
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
  return (
    pathname.startsWith("/v1/printing-images/") &&
    pathname.endsWith("/content")
  );
}
