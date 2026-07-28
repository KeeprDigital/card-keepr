import { authenticateBearer } from "../../../src/http/authentication";
import {
  assertBindingsAvailable,
  healthResponse,
} from "../../../src/http/health";
import { problemResponse } from "../../../src/http/problem";
import { rateLimitFailure } from "../../../src/http/rate-limit";
import { ingestionCapabilities } from "../../../src/runtime-capabilities.mjs";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();

    try {
      const rateLimited = await rateLimitFailure(
        request,
        env.ADMINISTRATION_RATE_LIMIT,
        requestId,
      );
      if (rateLimited !== null) return rateLimited;

      const authenticationFailure = await authenticateBearer(
        request,
        env.ADMINISTRATION_KEY,
        requestId,
        {
          missing: "authentication_required",
          invalid: "invalid_administration_key",
        },
      );
      if (authenticationFailure !== null) return authenticationFailure;

      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        assertBindingsAvailable(
          "mutation",
          env.CATALOGUE_DB,
          env.EVIDENCE_OBJECTS,
          env.PRINTING_IMAGES,
          env.CATALOGUE_EXPORTS,
          env.BACKUPS,
        );
        return healthResponse({
          contract: "card-keepr-runtime-health@1",
          runtime: "ingestion",
          status: "ok",
          capabilities: ingestionCapabilities,
        });
      }

      return problemResponse({
        requestId,
        status: 404,
        code: "not_found",
        title: "Not found",
        detail: "The requested administration operation does not exist.",
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "request failed",
          request_id: requestId,
          route: new URL(request.url).pathname,
          error: error instanceof Error ? error.message : "unknown error",
        }),
      );
      return problemResponse({
        requestId,
        status: 500,
        code: "internal_error",
        title: "Internal server error",
        detail: "The administration request could not be completed.",
      });
    }
  },
} satisfies ExportedHandler<Env>;
