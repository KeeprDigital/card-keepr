import { authenticateBearer } from "../../../src/http/authentication";
import {
  AdministrationProblem,
  administrationStatus,
  approveRun,
  inspectCandidate,
  rejectRun,
  retryPublicationCleanup,
  retryRun,
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
import {
  reparseSourceSnapshot,
  retryEvidenceRun,
  showEvidenceRun,
  sourceObservationSetContent,
  sourceSnapshotContent,
  startEvidenceRun,
} from "../../../src/catalogue/source-evidence";
import {
  reconcileRetainedCardPrintingEvidence,
  showReconciledPrinting,
} from "../../../src/catalogue/card-printing-reconciliation";
import { resumeEvidenceRun } from "./evidence-administration";
export {
  EvidenceHostWorkflow,
  EvidenceIngestionWorkflow,
} from "./evidence-workflows";
export { OfficialSourceTransport } from "./official-source-transport";

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
      const observedAt = administrationObservedAt(request, env);

      if (
        request.method === "POST" &&
        url.pathname === "/v1/ingestion-runs"
      ) {
        const body = await readAdministrationBody(request);
        assertOnlyFields(body, [
          "fixture",
          "selected_games",
          "idempotency_key",
        ]);
        const result = await startFixtureRun(
          env.CATALOGUE_DB,
          env.CATALOGUE_EXPORTS,
          {
            fixture: requiredString(body, "fixture"),
            selected_games: requiredStringArray(
              body,
              "selected_games",
            ),
            idempotency_key: requiredString(
              body,
              "idempotency_key",
            ),
          },
          observedAt,
        );
        return Response.json(result, {
          status: administrationResultStatus(result, 201),
        });
      }

      if (
        request.method === "POST" &&
        url.pathname === "/v1/ingestion-runs/evidence"
      ) {
        const body = await readAdministrationBody(request);
        assertOnlyFields(body, [
          "supported_game",
          "source_lineage",
          "adapter_version",
          "idempotency_key",
          "requests",
        ]);
        return Response.json(
          await startEvidenceRun(env.CATALOGUE_DB, {
            supported_game: requiredString(body, "supported_game"),
            source_lineage: requiredString(body, "source_lineage"),
            adapter_version: requiredString(body, "adapter_version"),
            idempotency_key: requiredString(body, "idempotency_key"),
            requests: requiredSourceRequests(body, "requests"),
          }),
          { status: 201 },
        );
      }

      if (
        request.method === "POST" &&
        url.pathname ===
          "/v1/internal/fixture-ingestion-runs/evidence"
      ) {
        const fixtureKey = (
          env as Env & { TEST_FIXTURE_SOURCE_PLAN_KEY?: string }
        ).TEST_FIXTURE_SOURCE_PLAN_KEY;
        if (
          fixtureKey === undefined ||
          !(await fixedHashSecretMatches(
            request.headers.get(
              "x-card-keepr-fixture-source-plan-key",
            ),
            fixtureKey,
          ))
        ) {
          throw new AdministrationProblem(
            404,
            "route_not_found",
            "The requested administration route does not exist.",
          );
        }
        const body = await readAdministrationBody(request);
        assertOnlyFields(body, [
          "supported_game",
          "source_lineage",
          "adapter_version",
          "idempotency_key",
          "requests",
        ]);
        return Response.json(
          await startEvidenceRun(
            env.CATALOGUE_DB,
            {
              supported_game: requiredString(body, "supported_game"),
              source_lineage: requiredString(body, "source_lineage"),
              adapter_version: requiredString(body, "adapter_version"),
              idempotency_key: requiredString(
                body,
                "idempotency_key",
              ),
              requests: requiredSourceRequests(body, "requests"),
            },
            "synthetic_fixture",
          ),
          { status: 201 },
        );
      }

      const reconciliationMatch =
        /^\/v1\/ingestion-runs\/([^/]+)\/reconciliation$/.exec(
          url.pathname,
        );
      if (request.method === "POST" && reconciliationMatch !== null) {
        const body = await readAdministrationBody(request);
        assertOnlyFields(body, []);
        const result = await reconcileRetainedCardPrintingEvidence(
          env.CATALOGUE_DB,
          env.EVIDENCE_OBJECTS,
          decodeURIComponent(reconciliationMatch[1]!),
          observedAt,
        );
        return Response.json(result, {
          status: result.publishable === true ? 200 : 409,
        });
      }

      const reconciledPrintingMatch =
        /^\/v1\/reconciliation\/printings\/([^/]+)$/.exec(
          url.pathname,
        );
      if (
        request.method === "GET" &&
        reconciledPrintingMatch !== null
      ) {
        return Response.json(
          await showReconciledPrinting(
            env.CATALOGUE_DB,
            decodeURIComponent(reconciledPrintingMatch[1]!),
          ),
        );
      }

      const evidenceResumeMatch =
        /^\/v1\/ingestion-runs\/([^/]+)\/collection\/resume$/.exec(
          url.pathname,
        );
      if (
        request.method === "POST" &&
        evidenceResumeMatch !== null
      ) {
        return Response.json(
          await resumeEvidenceRun(
            env.CATALOGUE_DB,
            env.EVIDENCE_INGESTION_WORKFLOW,
            decodeURIComponent(evidenceResumeMatch[1]!),
          ),
          { status: 202 },
        );
      }

      const evidenceRetryMatch =
        /^\/v1\/ingestion-runs\/([^/]+)\/collection\/retry$/.exec(
          url.pathname,
        );
      if (
        request.method === "POST" &&
        evidenceRetryMatch !== null
      ) {
        const body = await readAdministrationBody(request);
        assertOnlyFields(body, ["idempotency_key"]);
        return Response.json(
          await retryEvidenceRun(
            env.CATALOGUE_DB,
            decodeURIComponent(evidenceRetryMatch[1]!),
            requiredString(body, "idempotency_key"),
          ),
          { status: 201 },
        );
      }

      const sourceSnapshotObservationsMatch =
        /^\/v1\/source-snapshots\/([^/]+)\/observations$/.exec(
          url.pathname,
        );
      if (
        request.method === "POST" &&
        sourceSnapshotObservationsMatch !== null
      ) {
        const body = await readAdministrationBody(request);
        assertOnlyFields(body, ["adapter_version", "idempotency_key"]);
        return Response.json(
          await reparseSourceSnapshot(
            env.CATALOGUE_DB,
            env.EVIDENCE_OBJECTS,
            decodeURIComponent(sourceSnapshotObservationsMatch[1]!),
            requiredString(body, "adapter_version"),
            requiredString(body, "idempotency_key"),
          ),
          { status: 201 },
        );
      }

      const sourceSnapshotContentMatch =
        /^\/v1\/source-snapshots\/([^/]+)\/content$/.exec(url.pathname);
      if (
        request.method === "GET" &&
        sourceSnapshotContentMatch !== null
      ) {
        return sourceSnapshotContent(
          env.CATALOGUE_DB,
          env.EVIDENCE_OBJECTS,
          decodeURIComponent(sourceSnapshotContentMatch[1]!),
        );
      }

      const sourceObservationSetContentMatch =
        /^\/v1\/source-observation-sets\/([^/]+)\/content$/.exec(
          url.pathname,
        );
      if (
        request.method === "GET" &&
        sourceObservationSetContentMatch !== null
      ) {
        return sourceObservationSetContent(
          env.CATALOGUE_DB,
          env.EVIDENCE_OBJECTS,
          decodeURIComponent(sourceObservationSetContentMatch[1]!),
        );
      }

      const evidenceMatch =
        /^\/v1\/ingestion-runs\/([^/]+)\/evidence$/.exec(url.pathname);
      if (
        request.method === "GET" &&
        evidenceMatch !== null
      ) {
        return Response.json(
          await showEvidenceRun(
            env.CATALOGUE_DB,
            decodeURIComponent(evidenceMatch[1]!),
          ),
        );
      }

      if (request.method === "GET" && url.pathname === "/v1/status") {
        return Response.json(
          await administrationStatus(
            env.CATALOGUE_DB,
            env.CATALOGUE_EXPORTS,
            observedAt,
          ),
        );
      }

      const candidateMatch =
        /^\/v1\/ingestion-runs\/([^/]+)\/candidate$/.exec(url.pathname);
      if (request.method === "GET" && candidateMatch !== null) {
        return Response.json(
          await inspectCandidate(
            env.CATALOGUE_DB,
            env.CATALOGUE_EXPORTS,
            decodeURIComponent(candidateMatch[1]!),
            observedAt,
          ),
        );
      }

      const approvalMatch =
        /^\/v1\/ingestion-runs\/([^/]+)\/approval$/.exec(url.pathname);
      if (request.method === "POST" && approvalMatch !== null) {
        const body = await readAdministrationBody(request);
        assertOnlyFields(body, [
          "candidate_digest",
          "expected_current_revision_id",
          "idempotency_key",
        ]);
        const result = await approveRun(
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
            observedAt,
          );
        return Response.json(result, {
          status: administrationResultStatus(result, 200),
        });
      }

      const rejectionMatch =
        /^\/v1\/ingestion-runs\/([^/]+)\/rejection$/.exec(
          url.pathname,
        );
      if (request.method === "POST" && rejectionMatch !== null) {
        const body = await readAdministrationBody(request);
        assertOnlyFields(body, [
          "candidate_digest",
          "idempotency_key",
        ]);
        const result = await rejectRun(
          env.CATALOGUE_DB,
          env.CATALOGUE_EXPORTS,
          decodeURIComponent(rejectionMatch[1]!),
          {
            candidate_digest: requiredString(
              body,
              "candidate_digest",
            ),
            idempotency_key: requiredString(
              body,
              "idempotency_key",
            ),
          },
          observedAt,
        );
        return Response.json(result, {
          status: administrationResultStatus(result, 200),
        });
      }

      const retryMatch =
        /^\/v1\/ingestion-runs\/([^/]+)\/retry$/.exec(url.pathname);
      if (request.method === "POST" && retryMatch !== null) {
        const body = await readAdministrationBody(request);
        assertOnlyFields(body, ["idempotency_key"]);
        const result = await retryRun(
          env.CATALOGUE_DB,
          env.CATALOGUE_EXPORTS,
          decodeURIComponent(retryMatch[1]!),
          {
            idempotency_key: requiredString(
              body,
              "idempotency_key",
            ),
          },
          observedAt,
        );
        return Response.json(result, {
          status: administrationResultStatus(result, 201),
        });
      }

      const cleanupMatch =
        /^\/v1\/ingestion-runs\/([^/]+)\/publication-cleanup$/.exec(
          url.pathname,
        );
      if (request.method === "POST" && cleanupMatch !== null) {
        const body = await readAdministrationBody(request);
        assertOnlyFields(body, ["idempotency_key"]);
        const result = await retryPublicationCleanup(
          env.CATALOGUE_DB,
          env.CATALOGUE_EXPORTS,
          decodeURIComponent(cleanupMatch[1]!),
          {
            idempotency_key: requiredString(
              body,
              "idempotency_key",
            ),
          },
          observedAt,
        );
        return Response.json(result, {
          status: administrationResultStatus(result, 200),
        });
      }

      const runMatch = /^\/v1\/ingestion-runs\/([^/]+)$/.exec(
        url.pathname,
      );
      if (request.method === "GET" && runMatch !== null) {
        const runId = decodeURIComponent(runMatch[1]!);
        if (await hasEvidencePlan(env.CATALOGUE_DB, runId)) {
          return Response.json(
            await showEvidenceRun(env.CATALOGUE_DB, runId),
          );
        }
        return Response.json(
          await showRun(
            env.CATALOGUE_DB,
            env.CATALOGUE_EXPORTS,
            runId,
            observedAt,
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
  const maximumBytes = 16_384;
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    Number.parseInt(declaredLength, 10) > maximumBytes
  ) {
    throw new AdministrationProblem(
      413,
      "request_too_large",
      "The administration request body exceeds 16 KiB.",
    );
  }
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  if (reader !== undefined) {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > maximumBytes) {
        await reader.cancel();
        throw new AdministrationProblem(
          413,
          "request_too_large",
          "The administration request body exceeds 16 KiB.",
        );
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
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

async function fixedHashSecretMatches(
  provided: string | null,
  expected: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest(
      "SHA-256",
      encoder.encode(provided ?? ""),
    ),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const providedBytes = new Uint8Array(providedHash);
  const expectedBytes = new Uint8Array(expectedHash);
  return (
    provided !== null &&
    crypto.subtle.timingSafeEqual(providedBytes, expectedBytes)
  );
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

function requiredSourceRequests(
  body: Record<string, unknown>,
  field: string,
): {
  id: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
}[] {
  const value = body[field];
  if (!Array.isArray(value)) {
    throw new AdministrationProblem(
      422,
      "invalid_parameter",
      `${field} must be an array.`,
    );
  }
  return value.map((item, index) => {
    if (
      item === null ||
      typeof item !== "object" ||
      Array.isArray(item)
    ) {
      throw new AdministrationProblem(
        422,
        "invalid_parameter",
        `${field}[${index}] must be an object.`,
      );
    }
    const sourceRequest = item as Record<string, unknown>;
    assertOnlyFields(sourceRequest, ["id", "url", "method", "headers"]);
    const headersValue = sourceRequest.headers;
    let headers: Record<string, string> | undefined;
    if (headersValue !== undefined) {
      if (
        headersValue === null ||
        typeof headersValue !== "object" ||
        Array.isArray(headersValue) ||
        Object.values(headersValue).some(
          (header) => typeof header !== "string",
        )
      ) {
        throw new AdministrationProblem(
          422,
          "invalid_parameter",
          `${field}[${index}].headers must contain only string values.`,
        );
      }
      headers = headersValue as Record<string, string>;
    }
    return {
      id: requiredString(sourceRequest, "id"),
      url: requiredString(sourceRequest, "url"),
      ...(sourceRequest.method === undefined
        ? {}
        : { method: requiredString(sourceRequest, "method") }),
      ...(headers === undefined ? {} : { headers }),
    };
  });
}

function assertOnlyFields(
  body: Record<string, unknown>,
  allowedFields: readonly string[],
): void {
  const unexpected = Object.keys(body).find(
    (field) => !allowedFields.includes(field),
  );
  if (unexpected !== undefined) {
    throw new AdministrationProblem(
      422,
      "invalid_parameter",
      `${unexpected} is not accepted for this administration operation.`,
    );
  }
}

function administrationObservedAt(
  request: Request,
  env: Env,
): string {
  const requested = request.headers.get("x-keepr-test-now");
  const clockMode: string = env.ADMINISTRATION_CLOCK_MODE;
  if (
    clockMode !== "request" ||
    requested === null
  ) {
    return new Date().toISOString();
  }
  const parsed = new Date(requested);
  if (
    !Number.isFinite(parsed.valueOf()) ||
    parsed.toISOString() !== requested
  ) {
    throw new AdministrationProblem(
      422,
      "invalid_parameter",
      "x-keepr-test-now must be a canonical UTC timestamp.",
    );
  }
  return requested;
}

function administrationProblemTitle(status: number): string {
  if (status === 404) return "Not found";
  if (status === 409) return "Conflict";
  if (status === 413) return "Request too large";
  if (status === 422) return "Invalid request";
  return "Administration operation failed";
}

function administrationResultStatus(
  result: Record<string, unknown>,
  completedStatus: number,
): number {
  return result.contract ===
    "card-keepr-administration-operation@1" &&
    result.status === "in_progress"
    ? 202
    : completedStatus;
}

async function hasEvidencePlan(
  database: D1Database,
  runId: string,
): Promise<boolean> {
  const row = await database
    .prepare(
      "SELECT 1 AS present FROM ingestion_evidence_plans WHERE ingestion_run_id = ?",
    )
    .bind(runId)
    .first<{ present: number }>();
  return row?.present === 1;
}
