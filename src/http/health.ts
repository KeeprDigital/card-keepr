import {
  runHealthChecks,
  type HealthCheckInput,
  type HealthChecks,
} from "./health-checks";
import { rateLimitFailure } from "./rate-limit";

export type HealthRuntime = "api" | "ingestion";

export type RuntimeHealth = {
  contract: "card-keepr-runtime-health@1";
  runtime: HealthRuntime;
  status: "ok" | "degraded";
  capabilities: readonly string[];
  checks: HealthChecks;
};

const noStore = { "cache-control": "no-store" } as const;

/**
 * Liveness (issue #144): the unauthenticated `GET /healthz` answer for
 * external monitors. It says the Worker is up and which runtime answered,
 * and nothing else: no version, no bindings, no catalogue facts.
 */
export function livenessResponse(
  runtime: HealthRuntime,
  method: string,
): Response {
  if (method === "HEAD") {
    return new Response(null, {
      status: 200,
      headers: { ...noStore, "content-type": "application/json" },
    });
  }
  return Response.json({ status: "ok", runtime }, { headers: noStore });
}

export function isLivenessRequest(method: string, route: string): boolean {
  return route === "/healthz" && (method === "GET" || method === "HEAD");
}

/** The liveness route, behind its own rate limit only. */
export async function livenessRequest(
  request: Request,
  rateLimit: RateLimit,
  runtime: HealthRuntime,
  requestId: string,
): Promise<Response> {
  const rateLimited = await rateLimitFailure(request, rateLimit, requestId);
  if (rateLimited !== null) return rateLimited;
  return livenessResponse(runtime, request.method);
}

/**
 * Readiness: the authenticated `/health` document. Any failed check turns
 * the status to `degraded` and the response to 503.
 */
export async function readinessResponse(
  runtime: HealthRuntime,
  capabilities: readonly string[],
  input: HealthCheckInput,
): Promise<Response> {
  const { status, checks } = await runHealthChecks(input);
  return healthResponse({
    contract: "card-keepr-runtime-health@1",
    runtime,
    status,
    capabilities,
    checks,
  });
}

export function healthResponse(health: RuntimeHealth): Response {
  return Response.json(health, {
    status: health.status === "ok" ? 200 : 503,
    headers: noStore,
  });
}
