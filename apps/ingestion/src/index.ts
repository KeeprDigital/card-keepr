import { authenticateBearer } from "../../../src/http/authentication";
import { healthResponse } from "../../../src/http/health";
import { problemResponse } from "../../../src/http/problem";
import { rateLimitFailure } from "../../../src/http/rate-limit";

const capabilities = [
  "catalogue:write",
  "evidence:write",
  "printing-image:write",
  "export:write",
  "backup:write",
];

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
        requireBindings(
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
          capabilities,
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

function requireBindings(
  catalogueDatabase: D1Database,
  evidenceObjects: R2Bucket,
  printingImages: R2Bucket,
  catalogueExports: R2Bucket,
  backups: R2Bucket,
): void {
  if (
    !catalogueDatabase ||
    !evidenceObjects ||
    !printingImages ||
    !catalogueExports ||
    !backups
  ) {
    throw new Error("Required mutation bindings are unavailable");
  }
}
