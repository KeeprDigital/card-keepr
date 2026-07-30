import { authenticateCredentialBearer } from "../../../src/http/authentication";
import {
  AdministrationProblem,
  administrationStatus,
  approveRun,
  inspectCandidate,
  rejectRun,
  retryPublicationCleanup,
  retryRun,
  showRun,
} from "../../../src/catalogue/ingestion";
import {
  assertBindingsAvailable,
  healthResponse,
} from "../../../src/http/health";
import { problemResponse } from "../../../src/http/problem";
import { rateLimitFailure } from "../../../src/http/rate-limit";
import { readBoundedJsonObject } from "../../../src/http/bounded-json";
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
import {
  CredentialRotationProblem,
} from "../../../src/catalogue/credential-rotation";
import {
  handleCredentialAdministration,
  handleCredentialExecutionCapability,
} from "./credential-administration";
import {
  credentialConsumerProofRequestHeader,
  handleCredentialConsumerProof,
} from "../../../src/credentials/consumer-proof";
export {
  EvidenceHostWorkflow,
  EvidenceIngestionWorkflow,
} from "./evidence-workflows";
export { OfficialSourceTransport } from "./official-source-transport";

const ingestionWorker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();

    try {
      const consumerProof = await handleCredentialConsumerProof(
        request,
        env,
        [
          "api_bearer_key",
          "ingestion_admin_key",
          "d1_export_token",
          "d1_verification_token",
        ],
        async (secret) => {
          const response = await ingestionWorker.fetch(
            new Request(new URL("/health", request.url), {
              headers: {
                authorization: `Bearer ${secret}`,
              },
            }),
            env,
          );
          await response.body?.cancel();
          return response.status === 200;
        },
        async (requestToken) => {
          const response = await env.API_CREDENTIAL_CONSUMER.fetch(
            new Request("https://card-keepr-api.invalid/health", {
              headers: {
                [credentialConsumerProofRequestHeader]: requestToken,
              },
            }),
          );
          return response.json();
        },
      );
      if (consumerProof !== null) return consumerProof;
      const executionCapability =
        await handleCredentialExecutionCapability(
          request,
          env.CATALOGUE_DB,
          administrationObservedAt(request, env),
          env.CREDENTIAL_BOUNDARY_ATTESTATION_KEY,
          env.CREDENTIAL_CONSUMER_PROOF_KEY,
          env.CLOUDFLARE_OBSERVATION_TOKEN,
          env.GITHUB_APP_PRIVATE_KEY,
          env.GITHUB_APP_ID,
          env.GITHUB_WORKFLOW_ID,
          env.GITHUB_OBSERVATION_ACTOR,
        );
      if (executionCapability !== null) return executionCapability;
      const rateLimited = await rateLimitFailure(
        request,
        env.ADMINISTRATION_RATE_LIMIT,
        requestId,
      );
      if (rateLimited !== null) return rateLimited;

      const authenticationFailure = await authenticateCredentialBearer(
        request,
        env.CATALOGUE_DB,
        "ingestion_admin_key",
        [
          env.ADMINISTRATION_KEY,
          env.ADMINISTRATION_KEY_REPLACEMENT,
        ],
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

      const credentialResponse = await handleCredentialAdministration(
        request,
        env.CATALOGUE_DB,
        observedAt,
        {
          cloudflare_account_id: env.CLOUDFLARE_ACCOUNT_ID,
          catalogue_d1_database_id: env.CATALOGUE_D1_DATABASE_ID,
          disposable_d1_database_id:
            env.DISPOSABLE_D1_DATABASE_ID,
          github_repository_id: env.GITHUB_REPOSITORY_ID,
          github_app_id: env.GITHUB_APP_ID,
          github_installation_id: env.GITHUB_INSTALLATION_ID,
          github_environment_id: env.GITHUB_ENVIRONMENT_ID,
          github_workflow_id: env.GITHUB_WORKFLOW_ID,
        },
        env.CREDENTIAL_BOUNDARY_ATTESTATION_KEY,
        env.CREDENTIAL_CONSUMER_PROOF_KEY,
      );
      if (credentialResponse !== null) return credentialResponse;

      if (
        request.method === "POST" &&
        url.pathname === "/v1/ingestion-runs/evidence"
      ) {
        const body = await readAdministrationBody(request);
        if (body.plans !== undefined) {
          assertOnlyFields(body, ["plans", "idempotency_key"]);
          return Response.json(
            await startEvidenceRun(env.CATALOGUE_DB, {
              plans: requiredEvidencePlans(body, "plans"),
              idempotency_key: requiredString(body, "idempotency_key"),
            }),
            { status: 201 },
          );
        }
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
            env.PRINTING_IMAGES,
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
      if (
        error instanceof AdministrationProblem ||
        error instanceof CredentialRotationProblem
      ) {
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

export default ingestionWorker;

async function readAdministrationBody(
  request: Request,
): Promise<Record<string, unknown>> {
  return readBoundedJsonObject(
    request,
    16_384,
    (status, code, detail) =>
      new AdministrationProblem(status, code, detail),
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

function requiredEvidencePlans(
  body: Record<string, unknown>,
  field: string,
): {
  supported_game: string;
  source_lineage: string;
  adapter_version: string;
  requests: ReturnType<typeof requiredSourceRequests>;
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
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new AdministrationProblem(
        422,
        "invalid_parameter",
        `${field}[${index}] must be an object.`,
      );
    }
    const plan = item as Record<string, unknown>;
    assertOnlyFields(plan, [
      "supported_game",
      "source_lineage",
      "adapter_version",
      "requests",
    ]);
    return {
      supported_game: requiredString(plan, "supported_game"),
      source_lineage: requiredString(plan, "source_lineage"),
      adapter_version: requiredString(plan, "adapter_version"),
      requests: requiredSourceRequests(plan, "requests"),
    };
  });
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
