import { authenticateBearer } from "../../../src/http/authentication";
import {
  catalogueResponse,
  parseCatalogueRevisionId,
  parsePublicationInstant,
} from "../../../src/http/catalogue";
import {
  allowedPreflightResponse,
  hasAllowedOrigin,
  withCorsHeaders,
} from "../../../src/http/cors";
import {
  assertBindingsAvailable,
  healthResponse,
} from "../../../src/http/health";
import { problemResponse } from "../../../src/http/problem";
import { rateLimitFailure } from "../../../src/http/rate-limit";
import { apiCapabilities } from "../../../src/runtime-capabilities.mjs";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();

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
        env.API_BEARER_KEY,
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
          catalogueResponse({
            revisionId: parseCatalogueRevisionId(env.CATALOGUE_REVISION_ID),
            publishedAt: parsePublicationInstant(
              env.CATALOGUE_PUBLISHED_AT,
            ),
          }),
        );
      }

      if (request.method === "GET" && url.pathname === "/health") {
        assertBindingsAvailable(
          "read",
          env.CATALOGUE_DB,
          env.PRINTING_IMAGES,
        );
        return withCorsHeaders(
          request,
          healthResponse({
            contract: "card-keepr-runtime-health@1",
            runtime: "api",
            status: "ok",
            capabilities: apiCapabilities,
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
      console.error(
        JSON.stringify({
          message: "request failed",
          request_id: requestId,
          route: new URL(request.url).pathname,
          error: error instanceof Error ? error.message : "unknown error",
        }),
      );
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
  },
} satisfies ExportedHandler<Env>;

function isPrintingImageContent(pathname: string): boolean {
  return (
    pathname.startsWith("/v1/printing-images/") &&
    pathname.endsWith("/content")
  );
}
