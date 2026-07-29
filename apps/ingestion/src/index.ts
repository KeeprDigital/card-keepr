import { authenticateBearer } from "../../../src/http/authentication";
import {
  AdministrationProblem,
  approveRun,
  inspectCandidate,
  showRun,
  startFixtureRun,
} from "../../../src/catalogue/ingestion";
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

      if (
        request.method === "POST" &&
        url.pathname === "/v1/ingestion-runs"
      ) {
        const body = await readAdministrationBody(request);
        return Response.json(
          await startFixtureRun(env.CATALOGUE_DB, {
            fixture: requiredString(body, "fixture"),
            selected_games: requiredStringArray(body, "selected_games"),
            idempotency_key: requiredString(body, "idempotency_key"),
          }),
          { status: 201 },
        );
      }

      const candidateMatch =
        /^\/v1\/ingestion-runs\/([^/]+)\/candidate$/.exec(url.pathname);
      if (request.method === "GET" && candidateMatch !== null) {
        return Response.json(
          await inspectCandidate(
            env.CATALOGUE_DB,
            decodeURIComponent(candidateMatch[1]!),
          ),
        );
      }

      const approvalMatch =
        /^\/v1\/ingestion-runs\/([^/]+)\/approval$/.exec(url.pathname);
      if (request.method === "POST" && approvalMatch !== null) {
        const body = await readAdministrationBody(request);
        return Response.json(
          await approveRun(
            env.CATALOGUE_DB,
            env.CATALOGUE_EXPORTS,
            decodeURIComponent(approvalMatch[1]!),
            {
              candidate_digest: requiredString(
                body,
                "candidate_digest",
              ),
              expected_current_revision_id: requiredString(
                body,
                "expected_current_revision_id",
              ),
              idempotency_key: requiredString(body, "idempotency_key"),
            },
          ),
        );
      }

      const runMatch = /^\/v1\/ingestion-runs\/([^/]+)$/.exec(
        url.pathname,
      );
      if (request.method === "GET" && runMatch !== null) {
        return Response.json(
          await showRun(
            env.CATALOGUE_DB,
            decodeURIComponent(runMatch[1]!),
          ),
        );
      }

      return problemResponse({
        requestId,
        status: 404,
        code: "not_found",
        title: "Not found",
        detail: "The requested administration operation does not exist.",
      });
    } catch (error) {
      if (error instanceof AdministrationProblem) {
        return problemResponse({
          requestId,
          status: error.status,
          code: error.code,
          title: administrationProblemTitle(error.status),
          detail: error.message,
        });
      }
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

async function readAdministrationBody(
  request: Request,
): Promise<Record<string, unknown>> {
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    Number.parseInt(declaredLength, 10) > 16_384
  ) {
    throw new AdministrationProblem(
      413,
      "request_too_large",
      "The administration request body exceeds 16 KiB.",
    );
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 16_384) {
    throw new AdministrationProblem(
      413,
      "request_too_large",
      "The administration request body exceeds 16 KiB.",
    );
  }
  try {
    const value: unknown = JSON.parse(text);
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      throw new Error("not an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new AdministrationProblem(
      400,
      "invalid_json",
      "The administration request body must be a JSON object.",
    );
  }
}

function requiredString(
  body: Record<string, unknown>,
  field: string,
): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new AdministrationProblem(
      422,
      "invalid_parameter",
      `${field} must be a non-empty string.`,
    );
  }
  return value;
}

function requiredStringArray(
  body: Record<string, unknown>,
  field: string,
): readonly string[] {
  const value = body[field];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string")
  ) {
    throw new AdministrationProblem(
      422,
      "invalid_parameter",
      `${field} must be a non-empty array of strings.`,
    );
  }
  return value;
}

function administrationProblemTitle(status: number): string {
  if (status === 404) return "Not found";
  if (status === 409) return "Conflict";
  if (status === 413) return "Request too large";
  if (status === 422) return "Invalid request";
  return "Administration operation failed";
}
