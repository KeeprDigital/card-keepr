import {
  hostPacingStatement,
  advanceHostPacingStatement,
  latestCaptureOperationStatement,
  latestAttemptNumberStatement,
  latestTransportAttemptStatement,
  createCaptureOperationStatement,
  refreshCaptureRequestedAtStatement,
  revalidatedCaptureStatement,
  receivedCaptureResponseStatement,
  uploadedCaptureContentStatement,
  capturedSnapshotStatement,
  capturedSourceRequestStatement,
  finalizeCaptureStatement,
  remainingLineageRequestsStatement,
  observedSourceRequestStatement,
  sourceRequestStatement,
  captureOperationStatement,
  failedCaptureTransportStatement,
  rejectedCaptureStatement,
  failedSourceRequestStatement,
  reusableSnapshotsStatement,
} from "./source-capture-repository";
import { type AttemptOutcome, attemptStatement, sourceSnapshotStatement } from "./evidence-repository";
import { createHash } from "node:crypto";
import { AdministrationProblem, canonicalJson, sha256, utf8 } from "../shared";
import { requiredSourceAdapter } from "../adapters";
import {
  completeOfficialCollectionRequestsFromDiscovery,
  defaultSourceHostPacingIntervalMilliseconds,
  headersRecord,
  parseStringRecord,
  requestFailureCode,
  responseVary,
  type SourceRequestFailureClass,
  terminalHttpFailureClass,
  transportPolicyForRole,
} from "./source-evidence-model";
import {
  discoverSnapshotRequests,
  parseSnapshot,
  retainedOfficialDiscoveryRunRecords,
} from "./source-evidence-parsing";
import {
  appendDiscoveredEvidenceRequests,
  captureAttemptsPerRetryGeneration,
  evidencePlanForRequest,
  pauseEvidenceRunForRequestCapacity,
  persistOfficialSourceCollectionPlan,
  RequestCapacityProblem,
  retryExhaustionPauseStatements,
  type EvidenceRequestRow,
  type IngestionEvidenceRow,
  type RetryExhaustionFacts,
} from "./source-evidence-repository";
import type { SnapshotRow } from "./source-evidence-repository-types";
const multipartPartBytes = 5 * 1024 * 1024;
const representedRequestHeaders = new Set(["accept", "accept-language", "user-agent"]);

type CaptureOperationRow = {
  attempt_id: string;
  ingestion_run_id: string;
  request_id: string;
  attempt_number: number;
  source_snapshot_id: string;
  content_object_key: string;
  state: "planned" | "response_received" | "uploaded" | "finalized" | "failed";
  requested_at: string;
  completed_at: string | null;
  request_headers_json: string | null;
  http_status: number | null;
  response_headers_json: string | null;
  response_vary_json: string | null;
  media_type: string | null;
  content_digest: string | null;
  content_byte_length: number | null;
  reused_source_snapshot_id: string | null;
  failure_outcome: string | null;
  diagnostic: string | null;
};

export type PreparedCaptureAttempt =
  | { kind: "done"; failure_code: string | null }
  | { kind: "captured"; source_snapshot_id: string }
  | {
      kind: "attempt";
      attempt_id: string;
      attempt_number: number;
      source_snapshot_id: string;
      content_object_key: string;
      requested_at: string;
    };

export type CaptureTransportResult =
  | {
      kind: "done";
      failure_code: string | null;
      request_made: boolean;
    }
  | { kind: "wait"; wait_ms: number; request_made: boolean }
  | { kind: "uploaded"; attempt_id: string; request_made: boolean }
  | {
      kind: "captured";
      source_snapshot_id: string;
      request_made: boolean;
    };

export async function captureOperationIdentity(
  runId: string,
  requestId: string,
  attemptNumber: number,
): Promise<{
  attemptId: string;
  snapshotId: string;
  objectKey: string;
}> {
  const digest = await sha256(
    utf8(
      canonicalJson({
        ingestion_run_id: runId,
        request_id: requestId,
        attempt_number: attemptNumber,
      }),
    ),
  );
  const attemptId = `srcfetch_${digest}`;
  const snapshotId = `srcsnap_${digest}`;
  return {
    attemptId,
    snapshotId,
    objectKey: `source-snapshots/${snapshotId}.bin`,
  };
}

export type SourceHostPacingMode = "production" | "immediate";

// Test-only pacing override. Production deployments pin the variable to
// "production" (also the default when unset); test harnesses may opt in to
// "immediate" so simulated fetches skip the per-request host pacing sleep.
// Any other value fails closed.
export function sourceHostPacingMode(value: string | undefined): SourceHostPacingMode {
  if (value === undefined || value === "production") return "production";
  if (value === "immediate") return "immediate";
  throw new Error('SOURCE_HOST_PACING_MODE must be "production" or "immediate", got ' + `${JSON.stringify(value)}.`);
}

export { defaultSourceHostPacingIntervalMilliseconds };

// Transport-layer Retry-After and 429/5xx backoff remain the safety net if a
// host rejects this cadence; the interval only sets the polite steady state.
export function sourceHostPacingIntervalMilliseconds(value: string | undefined): number {
  if (value === undefined) return defaultSourceHostPacingIntervalMilliseconds;
  if (/^(?:0|[1-9]\d*)$/u.test(value)) {
    const interval = Number.parseInt(value, 10);
    if (interval <= 60_000) return interval;
  }
  throw new Error(
    "SOURCE_HOST_PACING_INTERVAL_MS must be an integer between 0 and 60000, " + `got ${JSON.stringify(value)}.`,
  );
}

export async function hostPacingDelay(
  database: D1Database,
  hostname: string,
  mode: SourceHostPacingMode = "production",
): Promise<number> {
  if (mode === "immediate") return 0;
  const row = await hostPacingStatement(database, hostname).first<{ next_request_not_before: string }>();
  if (row === null) return 0;
  return Math.max(0, Date.parse(row.next_request_not_before) - Date.now());
}

export async function advanceHostPacing(
  database: D1Database,
  hostname: string,
  mode: SourceHostPacingMode = "production",
  intervalMilliseconds: number = defaultSourceHostPacingIntervalMilliseconds,
): Promise<void> {
  const next = new Date(
    Date.now() + (mode === "immediate" ? 0 : intervalMilliseconds + jitter(Math.floor(intervalMilliseconds / 4))),
  ).toISOString();
  await advanceHostPacingStatement(database, { hostname: hostname, nextRequestAt: next }).run();
}

// Only a collecting run admits capture or parse work. A paused run keeps its
// pending and captured Source Requests intact until the owner acts, and a
// terminated run is fenced: late durable steps that re-read the run record
// nothing further.
function admitsCollectionWork(run: Pick<IngestionEvidenceRow, "state">): boolean {
  return run.state === "collecting";
}

export async function prepareCaptureAttempt(
  database: D1Database,
  run: IngestionEvidenceRow,
  sourceRequest: EvidenceRequestRow,
): Promise<PreparedCaptureAttempt> {
  if (!admitsCollectionWork(run)) {
    return { kind: "done", failure_code: null };
  }
  const request = await currentRequest(database, run.id, sourceRequest.request_id);
  if (request.state === "observed") {
    return { kind: "done", failure_code: null };
  }
  if (request.state === "failed") {
    return { kind: "done", failure_code: request.failure_code };
  }
  if (request.state === "captured") {
    if (request.source_snapshot_id === null) {
      throw new Error("Captured evidence request has no Source Snapshot");
    }
    return {
      kind: "captured",
      source_snapshot_id: request.source_snapshot_id,
    };
  }

  const open = await latestCaptureOperationStatement(database, {
    runId: run.id,
    requestId: request.request_id,
  }).first<CaptureOperationRow>();
  if (open !== null) return publicPreparedAttempt(open);

  const latest = await latestAttemptNumberStatement(database, { runId: run.id, requestId: request.request_id }).first<{
    attempt_number: number;
  }>();
  const attemptNumber = (latest?.attempt_number ?? 0) + 1;
  if (attemptNumber > retryBudget(request)) {
    // The current retry generation is exhausted but no capture operation is
    // open: reached on replay after a crash, or when a resume did not open a
    // new generation. Recoverable exhaustion follows the role's transport
    // policy (re-pause the run, or fail a Printing Image request alone);
    // only a terminal latest outcome fails closed.
    const previous = await latestTransportAttemptStatement(database, {
      runId: run.id,
      requestId: request.request_id,
    }).first<{
      outcome: string;
      http_status: number | null;
      attempt_number: number;
    }>();
    const classification = recoverableExhaustionClassification(previous?.outcome ?? null);
    if (previous === null || classification === null) {
      const failureCode = requestFailureCode(
        request.request_role,
        previous?.outcome === "body_failure" ? "body_contract" : "retries_exhausted",
      );
      await failRequest(database, request, failureCode);
      return { kind: "done", failure_code: failureCode };
    }
    const exhaustion = recoverableExhaustion(
      database,
      run,
      request,
      previous.attempt_number,
      classification,
      previous.http_status,
    );
    await database.batch(exhaustion.statements);
    return { kind: "done", failure_code: exhaustion.failure_code };
  }
  const identity = await captureOperationIdentity(run.id, request.request_id, attemptNumber);
  const requestedAt = new Date().toISOString();
  await createCaptureOperationStatement(database, {
    attemptId: identity.attemptId,
    runId: run.id,
    requestId: request.request_id,
    attemptNumber: attemptNumber,
    snapshotId: identity.snapshotId,
    objectKey: identity.objectKey,
    requestedAt: requestedAt,
  }).run();
  const stored = await requiredCaptureOperation(database, identity.attemptId);
  return publicPreparedAttempt(stored);
}

export async function capturePreparedAttempt(
  database: D1Database,
  evidenceObjects: R2Bucket,
  officialSourceTransport: Fetcher,
  run: IngestionEvidenceRow,
  sourceRequest: EvidenceRequestRow,
  prepared: Extract<PreparedCaptureAttempt, { kind: "attempt" }>,
): Promise<CaptureTransportResult> {
  if (!admitsCollectionWork(run)) {
    return { kind: "done", failure_code: null, request_made: false };
  }
  let operation = await requiredCaptureOperation(database, prepared.attempt_id);
  if (operation.state === "uploaded") {
    return {
      kind: "uploaded",
      attempt_id: operation.attempt_id,
      request_made: false,
    };
  }
  if (operation.state === "finalized") {
    return {
      kind: "captured",
      source_snapshot_id: operation.source_snapshot_id,
      request_made: false,
    };
  }
  if (operation.state === "failed") {
    return retryOrFinish(sourceRequest, operation.attempt_number);
  }
  if (operation.state === "response_received") {
    try {
      const recovered = await recoverCompletedUpload(database, evidenceObjects, operation);
      if (recovered) {
        return {
          kind: "uploaded",
          attempt_id: operation.attempt_id,
          request_made: false,
        };
      }
      return recordFailedTransportAttempt(database, run, sourceRequest, operation, {
        outcome: "storage_failure",
        completedAt: new Date().toISOString(),
        status: operation.http_status,
        headers: operation.response_headers_json === null ? {} : parseStringRecord(operation.response_headers_json),
        diagnostic: "The staged Source Snapshot object was unavailable during recovery.",
      });
    } catch (error) {
      return recordFailedTransportAttempt(database, run, sourceRequest, operation, {
        outcome: "storage_failure",
        completedAt: new Date().toISOString(),
        status: operation.http_status,
        headers: operation.response_headers_json === null ? {} : parseStringRecord(operation.response_headers_json),
        diagnostic: errorMessage(error, "The staged Source Snapshot object could not be recovered."),
      });
    }
  }

  if (operation.state === "planned") {
    await refreshCaptureRequestedAtStatement(database, {
      requestedAt: new Date().toISOString(),
      attemptId: operation.attempt_id,
    }).run();
    operation = await requiredCaptureOperation(database, operation.attempt_id);
  }

  const request = await currentRequest(database, run.id, sourceRequest.request_id);
  const evidencePlan = evidencePlanForRequest(run, request.request_id);
  const configuredHeaders = parseStringRecord(request.request_headers_json);
  const reusable = await findReusableSnapshot(database, run, request);
  const requestHeaders = {
    ...configuredHeaders,
    ...(reusable === null ? {} : revalidationHeaders(reusable)),
  };
  let response: Response | null = null;
  let networkError: string | null = null;
  let fetchFailureOutcome: "network_failure" | "body_failure" = "network_failure";
  try {
    response = await officialSourceTransport.fetch(request.url, {
      method: "GET",
      headers: requestHeaders,
      redirect: "manual",
      signal: AbortSignal.timeout(transportPolicyForRole(request.request_role).timeout_ms),
    });
  } catch (error) {
    networkError = errorMessage(error, "Official Source network request failed.");
    if (/content-length|body|stream/i.test(networkError)) {
      fetchFailureOutcome = "body_failure";
    }
  }
  const completedAt = new Date().toISOString();
  if (response === null) {
    return recordFailedTransportAttempt(database, run, request, operation, {
      outcome: fetchFailureOutcome,
      completedAt,
      status: null,
      headers: {},
      diagnostic: networkError,
    });
  }

  const responseHeaders = headersRecord(response.headers);
  if (response.status === 304) {
    if (reusable === null || !validatorAccepted(response, reusable)) {
      if (response.body !== null) await response.body.cancel();
      return recordRejectedAttempt(database, run, request, operation, {
        outcome: "content_rejected",
        completedAt,
        status: response.status,
        headers: responseHeaders,
        diagnostic: "A 304 response did not match an immutable Source Snapshot validator and representation.",
        failureClass: "revalidation_rejected",
      });
    }
    if (response.body !== null) await response.body.cancel();
    await revalidatedCaptureStatement(database, {
      completedAt: completedAt,
      requestHeadersJson: canonicalJson(requestHeaders),
      status: response.status,
      responseHeadersJson: canonicalJson(responseHeaders),
      responseVaryJson: reusable.response_vary_json,
      mediaType: reusable.media_type,
      digest: reusable.content_digest,
      byteLength: reusable.content_byte_length,
      reusedSnapshotId: reusable.id,
      attemptId: operation.attempt_id,
    }).run();
    return {
      kind: "uploaded",
      attempt_id: operation.attempt_id,
      request_made: true,
    };
  }

  if (!response.ok) {
    const redirect = response.status >= 300 && response.status < 400;
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), Date.parse(completedAt));
    if (response.body !== null) await response.body.cancel();
    return recordRejectedAttempt(database, run, request, operation, {
      outcome: redirect ? "redirect" : "http_failure",
      completedAt,
      status: response.status,
      headers: responseHeaders,
      retryAfterMs,
      diagnostic: redirect
        ? "Redirect responses are retained only as diagnostics."
        : `Official Source returned HTTP ${response.status}.`,
      // A redirect is recorded, never followed, for every role: following
      // it would silently change the evidence origin of the retained bytes.
      failureClass: redirect ? "redirected" : terminalHttpFailureClass(response.status),
    });
  }

  await receivedCaptureResponseStatement(database, {
    completedAt: completedAt,
    requestHeadersJson: canonicalJson(requestHeaders),
    status: response.status,
    responseHeadersJson: canonicalJson(responseHeaders),
    responseVaryJson: canonicalJson(responseVary(response.headers)),
    mediaType: response.headers.get("content-type"),
    attemptId: operation.attempt_id,
  }).run();
  operation = await requiredCaptureOperation(database, operation.attempt_id);
  try {
    const content = await streamSnapshotToR2(
      evidenceObjects,
      operation.content_object_key,
      response,
      requiredSourceAdapter(evidencePlan.adapter_version).maximumSnapshotBytes,
    );
    await uploadedCaptureContentStatement(database, {
      digest: content.digest,
      byteLength: content.byteLength,
      attemptId: operation.attempt_id,
    }).run();
    return {
      kind: "uploaded",
      attempt_id: operation.attempt_id,
      request_made: true,
    };
  } catch (error) {
    let recoveryError: unknown = null;
    try {
      const recovered = await recoverCompletedUpload(database, evidenceObjects, operation);
      if (recovered) {
        return {
          kind: "uploaded",
          attempt_id: operation.attempt_id,
          request_made: true,
        };
      }
    } catch (caught) {
      recoveryError = caught;
    }
    const failure =
      error instanceof CapturePersistenceError
        ? error
        : new CapturePersistenceError(
            "storage_failure",
            errorMessage(recoveryError ?? error, "Evidence persistence failed."),
          );
    return recordFailedTransportAttempt(database, run, request, operation, {
      outcome: failure.outcome,
      completedAt,
      status: response.status,
      headers: responseHeaders,
      diagnostic: failure.message,
    });
  }
}

export async function completeUploadedCapture(
  database: D1Database,
  run: IngestionEvidenceRow,
  sourceRequest: EvidenceRequestRow,
  attemptId: string,
): Promise<CaptureTransportResult> {
  if (!admitsCollectionWork(run)) {
    return { kind: "done", failure_code: null, request_made: false };
  }
  const evidencePlan = evidencePlanForRequest(run, sourceRequest.request_id);
  const operation = await requiredCaptureOperation(database, attemptId);
  if (operation.state === "finalized") {
    return {
      kind: "captured",
      source_snapshot_id: operation.source_snapshot_id,
      request_made: false,
    };
  }
  if (
    operation.state !== "uploaded" ||
    operation.completed_at === null ||
    operation.request_headers_json === null ||
    operation.http_status === null ||
    operation.response_headers_json === null ||
    operation.response_vary_json === null ||
    operation.content_digest === null ||
    operation.content_byte_length === null
  ) {
    throw new Error("Uploaded capture operation metadata is incomplete");
  }
  const outcome: AttemptOutcome = operation.reused_source_snapshot_id === null ? "success" : "cache_revalidated";
  const reusedSnapshot =
    operation.reused_source_snapshot_id === null
      ? null
      : await sourceSnapshotStatement(database, operation.reused_source_snapshot_id).first<SnapshotRow>();
  if (operation.reused_source_snapshot_id !== null && reusedSnapshot === null) {
    throw new Error("Revalidated Source Snapshot bytes are unavailable");
  }
  const contentObjectKey = reusedSnapshot?.content_object_key ?? operation.content_object_key;
  await database.batch([
    attemptStatement(database, {
      id: operation.attempt_id,
      runId: run.id,
      requestId: sourceRequest.request_id,
      attemptNumber: operation.attempt_number,
      requestedAt: operation.requested_at,
      completedAt: operation.completed_at,
      outcome,
      status: operation.http_status,
      headers: parseStringRecord(operation.response_headers_json),
      retryAfterMs: null,
      diagnostic: null,
    }),
    capturedSnapshotStatement(database, {
      snapshotId: operation.source_snapshot_id,
      runId: run.id,
      requestId: sourceRequest.request_id,
      attemptId: operation.attempt_id,
      requestUrl: sourceRequest.url,
      requestHeadersJson: operation.request_headers_json,
      representationFingerprint: sourceRequest.representation_fingerprint,
      responseVaryJson: operation.response_vary_json,
      retrievedAt: operation.completed_at,
      status: operation.http_status,
      responseHeadersJson: operation.response_headers_json,
      mediaType: operation.media_type,
      digest: operation.content_digest,
      byteLength: operation.content_byte_length,
      objectKey: contentObjectKey,
      sourceLineage: evidencePlan.source_lineage,
      supportedGame: evidencePlan.supported_game,
      gameProfileVersion: evidencePlan.game_profile_version,
      adapterVersion: evidencePlan.adapter_version,
      reusedSnapshotId: operation.reused_source_snapshot_id,
    }),
    capturedSourceRequestStatement(database, {
      snapshotId: operation.source_snapshot_id,
      runId: run.id,
      requestId: sourceRequest.request_id,
    }),
    finalizeCaptureStatement(database, operation.attempt_id),
  ]);
  return {
    kind: "captured",
    source_snapshot_id: operation.source_snapshot_id,
    request_made: false,
  };
}

export async function parseCapturedRequest(
  database: D1Database,
  evidenceObjects: R2Bucket,
  run: IngestionEvidenceRow,
  sourceRequest: EvidenceRequestRow,
  snapshotId: string,
): Promise<CaptureTransportResult> {
  if (!admitsCollectionWork(run)) {
    return { kind: "done", failure_code: null, request_made: false };
  }
  const evidencePlan = evidencePlanForRequest(run, sourceRequest.request_id);
  try {
    const observationSet = await parseSnapshot(database, evidenceObjects, snapshotId, evidencePlan.adapter_version, {
      intent: "collection",
      idempotencyKey: `${run.id}:${sourceRequest.request_id}`,
    });
    const adapter = requiredSourceAdapter(evidencePlan.adapter_version);
    const discovered = await discoverSnapshotRequests(
      database,
      evidenceObjects,
      snapshotId,
      evidencePlan.adapter_version,
    );
    await appendDiscoveredEvidenceRequests(database, run, sourceRequest, discovered);
    if (
      run.plan_origin === "production" &&
      adapter.requestUrlForDiscovery !== undefined &&
      (sourceRequest.request_id === `${evidencePlan.source_lineage}:discovery` ||
        /:listing:[a-z0-9]+(?:-[a-z0-9]+)*:[a-f0-9]{64}$/u.test(sourceRequest.request_id))
    ) {
      const discovery = await retainedOfficialDiscoveryRunRecords(
        database,
        evidenceObjects,
        run.id,
        evidencePlan.source_lineage,
      );
      const complete = await completeOfficialCollectionRequestsFromDiscovery(
        adapter,
        discovery.records,
        evidencePlan.requests[0]?.headers ?? {},
      );
      if (complete !== null) {
        await persistOfficialSourceCollectionPlan(database, run.id, discovery.discoveryObservationSetId, complete);
      } else {
        // A catalogue-complete adapter whose finished discovery derives an
        // empty Official Source Collection Plan must fail closed here with a
        // specific code instead of reporting structural completeness and
        // dying much later at printing reconciliation.
        const outstanding = await remainingLineageRequestsStatement(database, {
          runId: run.id,
          lineagePattern: `${evidencePlan.source_lineage}:%`,
          excludedRequestId: sourceRequest.request_id,
        }).first<{ count: number }>();
        if (outstanding === null || outstanding.count === 0) {
          throw new AdministrationProblem(
            422,
            "official_collection_plan_empty",
            "Official Source discovery completed without deriving any Official Source Collection Plan requests.",
          );
        }
      }
    }
    await observedSourceRequestStatement(database, {
      runId: run.id,
      requestId: sourceRequest.request_id,
      snapshotId: snapshotId,
    }).run();
    return {
      kind: "done",
      failure_code: null,
      request_made: false,
    };
  } catch (error) {
    if (!(error instanceof AdministrationProblem)) throw error;
    if (error instanceof RequestCapacityProblem) {
      // Reaching request capacity is not evidence the parent Source Request
      // failed: the request keeps its retained Source Snapshot in 'captured',
      // pending requests stay pending, and the run pauses non-terminally so
      // the owner can extend capacity and derive the rejected overflow batch
      // again from retained discovery evidence.
      await pauseEvidenceRunForRequestCapacity(database, run.id, sourceRequest.request_id, error);
      return {
        kind: "done",
        failure_code: null,
        request_made: false,
      };
    }
    await failRequest(database, sourceRequest, error.code);
    return {
      kind: "done",
      failure_code: error.code,
      request_made: false,
    };
  }
}

function publicPreparedAttempt(operation: CaptureOperationRow): Extract<PreparedCaptureAttempt, { kind: "attempt" }> {
  return {
    kind: "attempt",
    attempt_id: operation.attempt_id,
    attempt_number: operation.attempt_number,
    source_snapshot_id: operation.source_snapshot_id,
    content_object_key: operation.content_object_key,
    requested_at: operation.requested_at,
  };
}

async function currentRequest(database: D1Database, runId: string, requestId: string): Promise<EvidenceRequestRow> {
  const request = await sourceRequestStatement(database, {
    runId: runId,
    requestId: requestId,
  }).first<EvidenceRequestRow>();
  if (request === null) throw new Error("Evidence request disappeared");
  return request;
}

async function requiredCaptureOperation(database: D1Database, attemptId: string): Promise<CaptureOperationRow> {
  const operation = await captureOperationStatement(database, attemptId).first<CaptureOperationRow>();
  if (operation === null) throw new Error("Capture operation disappeared");
  return operation;
}

async function recoverCompletedUpload(
  database: D1Database,
  bucket: R2Bucket,
  operation: CaptureOperationRow,
): Promise<boolean> {
  const object = await bucket.get(operation.content_object_key);
  if (object === null) return false;
  const hash = createHash("sha256");
  let byteLength = 0;
  const reader = object.body.getReader();
  for (;;) {
    const read = await reader.read();
    if (read.done) break;
    byteLength += read.value.byteLength;
    hash.update(read.value);
  }
  await uploadedCaptureContentStatement(database, {
    digest: hash.digest("hex"),
    byteLength: byteLength,
    attemptId: operation.attempt_id,
  }).run();
  return true;
}

async function streamSnapshotToR2(
  bucket: R2Bucket,
  objectKey: string,
  response: Response,
  maximumBytes: number,
): Promise<{ byteLength: number; digest: string }> {
  const hash = createHash("sha256");
  const metadata = {
    httpMetadata: {
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
      cacheControl: "private, max-age=31536000, immutable",
    },
  };
  const declared = response.headers.get("content-length");
  const declaredByteLength = declared === null ? null : Number.parseInt(declared, 10);
  if (
    declaredByteLength !== null &&
    (!/^\d+$/u.test(declared!) || !Number.isSafeInteger(declaredByteLength) || declaredByteLength < 0)
  ) {
    if (response.body !== null) {
      await response.body.cancel().catch(() => undefined);
    }
    throw new CapturePersistenceError("body_failure", "Official Source returned an invalid Content-Length.");
  }
  if (declaredByteLength !== null && declaredByteLength > maximumBytes) {
    if (response.body !== null) {
      await response.body.cancel().catch(() => undefined);
    }
    throw new CapturePersistenceError(
      "body_failure",
      `Official Source body exceeds the ${maximumBytes}-byte adapter limit.`,
    );
  }
  if (response.body === null) {
    if (declaredByteLength !== null && declaredByteLength !== 0) {
      throw new CapturePersistenceError(
        "body_failure",
        "Official Source body ended before its declared Content-Length.",
      );
    }
    try {
      const stored = await bucket.put(objectKey, new Uint8Array(), {
        ...metadata,
        onlyIf: { etagDoesNotMatch: "*" },
      });
      if (stored === null) throw new Error("object key already exists");
    } catch (error) {
      throw new CapturePersistenceError("storage_failure", errorMessage(error, "Evidence object write failed."));
    }
    return { byteLength: 0, digest: hash.digest("hex") };
  }
  if (declaredByteLength !== null) {
    const byteLength = declaredByteLength;
    const fixed = new FixedLengthStream(byteLength);
    let observedLength = 0;
    const hashingStream = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (observedLength + chunk.byteLength > maximumBytes) {
          throw new CapturePersistenceError(
            "body_failure",
            `Official Source body exceeds the ${maximumBytes}-byte adapter limit.`,
          );
        }
        observedLength += chunk.byteLength;
        hash.update(chunk);
        controller.enqueue(chunk);
      },
    });
    const results = await Promise.allSettled([
      bucket.put(objectKey, fixed.readable, {
        ...metadata,
        onlyIf: { etagDoesNotMatch: "*" },
      }),
      response.body.pipeThrough(hashingStream).pipeTo(fixed.writable),
    ]);
    const bodyResult = results[1]!;
    if (bodyResult.status === "rejected") {
      await bucket.delete(objectKey).catch(() => undefined);
      throw new CapturePersistenceError(
        "body_failure",
        errorMessage(bodyResult.reason, "Official Source body stream failed."),
      );
    }
    const storageResult = results[0]!;
    if (storageResult.status === "rejected" || storageResult.value === null) {
      throw new CapturePersistenceError(
        "storage_failure",
        storageResult.status === "rejected"
          ? errorMessage(storageResult.reason, "Evidence object write failed.")
          : "Immutable evidence object key already exists.",
      );
    }
    return { byteLength: observedLength, digest: hash.digest("hex") };
  }

  let multipart: R2MultipartUpload;
  try {
    multipart = await bucket.createMultipartUpload(objectKey, metadata);
  } catch (error) {
    throw new CapturePersistenceError(
      "storage_failure",
      errorMessage(error, "Evidence multipart upload could not start."),
    );
  }
  const uploadedParts: R2UploadedPart[] = [];
  const reader = response.body.getReader();
  let pending = new Uint8Array(multipartPartBytes);
  let pendingLength = 0;
  let byteLength = 0;
  try {
    for (;;) {
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read = await reader.read();
      } catch (error) {
        throw new CapturePersistenceError("body_failure", errorMessage(error, "Official Source body stream failed."));
      }
      if (read.done) break;
      if (byteLength + read.value.byteLength > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new CapturePersistenceError(
          "body_failure",
          `Official Source body exceeds the ${maximumBytes}-byte adapter limit.`,
        );
      }
      hash.update(read.value);
      byteLength += read.value.byteLength;
      let offset = 0;
      while (offset < read.value.byteLength) {
        const copying = Math.min(pending.byteLength - pendingLength, read.value.byteLength - offset);
        pending.set(read.value.subarray(offset, offset + copying), pendingLength);
        pendingLength += copying;
        offset += copying;
        if (pendingLength === pending.byteLength) {
          try {
            uploadedParts.push(await multipart.uploadPart(uploadedParts.length + 1, pending));
          } catch (error) {
            throw new CapturePersistenceError(
              "storage_failure",
              errorMessage(error, "Evidence multipart part write failed."),
            );
          }
          pending = new Uint8Array(multipartPartBytes);
          pendingLength = 0;
        }
      }
    }
    if (pendingLength > 0 || uploadedParts.length === 0) {
      try {
        uploadedParts.push(await multipart.uploadPart(uploadedParts.length + 1, pending.subarray(0, pendingLength)));
      } catch (error) {
        throw new CapturePersistenceError(
          "storage_failure",
          errorMessage(error, "Evidence multipart part write failed."),
        );
      }
    }
    try {
      await multipart.complete(uploadedParts);
    } catch (error) {
      throw new CapturePersistenceError(
        "storage_failure",
        errorMessage(error, "Evidence multipart completion failed."),
      );
    }
    return { byteLength, digest: hash.digest("hex") };
  } catch (error) {
    await multipart.abort().catch(() => undefined);
    throw error;
  }
}

async function recordFailedTransportAttempt(
  database: D1Database,
  run: IngestionEvidenceRow,
  request: EvidenceRequestRow,
  operation: CaptureOperationRow,
  failure: {
    outcome: "network_failure" | "body_failure" | "storage_failure";
    completedAt: string;
    status: number | null;
    headers: Record<string, string>;
    diagnostic: string | null;
  },
): Promise<CaptureTransportResult> {
  const exhausted = operation.attempt_number >= retryBudget(request);
  // Exhausted network and storage retries remain semantically safe to retry
  // later, so their exhaustion outcome (a Retry Pause, or a tolerated image
  // failure under the role's transport policy) commits in the same atomic
  // batch that records the final failed attempt; a body-contract violation
  // stays terminal.
  const classification = failure.outcome === "body_failure" ? null : failure.outcome;
  const bodyContractFailureCode = requestFailureCode(request.request_role, "body_contract");
  const exhaustion =
    exhausted && classification !== null
      ? recoverableExhaustion(database, run, request, operation.attempt_number, classification, failure.status)
      : null;
  await database.batch([
    attemptStatement(database, {
      id: operation.attempt_id,
      runId: request.ingestion_run_id,
      requestId: request.request_id,
      attemptNumber: operation.attempt_number,
      requestedAt: operation.requested_at,
      completedAt: failure.completedAt,
      outcome: failure.outcome,
      status: failure.status,
      headers: failure.headers,
      retryAfterMs: null,
      diagnostic: failure.diagnostic,
    }),
    failedCaptureTransportStatement(database, {
      completedAt: failure.completedAt,
      status: failure.status,
      responseHeadersJson: canonicalJson(failure.headers),
      outcome: failure.outcome,
      diagnostic: failure.diagnostic,
      attemptId: operation.attempt_id,
    }),
    ...(exhausted && classification === null ? [failRequestStatement(database, request, bodyContractFailureCode)] : []),
    ...(exhaustion?.statements ?? []),
  ]);
  if (!exhausted) {
    return {
      kind: "wait",
      wait_ms: exponentialBackoff(operation.attempt_number),
      request_made: true,
    };
  }
  return {
    kind: "done",
    failure_code: exhaustion === null ? bodyContractFailureCode : exhaustion.failure_code,
    request_made: true,
  };
}

async function recordRejectedAttempt(
  database: D1Database,
  run: IngestionEvidenceRow,
  request: EvidenceRequestRow,
  operation: CaptureOperationRow,
  rejection: {
    outcome: "redirect" | "http_failure" | "content_rejected";
    completedAt: string;
    status: number;
    headers: Record<string, string>;
    retryAfterMs?: number | null;
    diagnostic: string;
    failureClass: SourceRequestFailureClass | null;
  },
): Promise<CaptureTransportResult> {
  const exhausted = operation.attempt_number >= retryBudget(request);
  // A rejection without a terminal failure class is a retryable HTTP
  // response (429 or 5xx): exhausting its bounded retries pauses the run
  // rather than failing the request, except for a Printing Image, whose
  // transport policy fails that one request and lets collection continue.
  // Redirects, non-retryable statuses, and rejected revalidations are
  // terminal for the request under the code its role's policy assigns:
  // fatal for the run on a catalogue-fact role, a tolerated gap on an image.
  const failureCode =
    rejection.failureClass === null ? null : requestFailureCode(request.request_role, rejection.failureClass);
  const exhaustion =
    exhausted && failureCode === null
      ? recoverableExhaustion(database, run, request, operation.attempt_number, "http_failure", rejection.status)
      : null;
  await database.batch([
    attemptStatement(database, {
      id: operation.attempt_id,
      runId: request.ingestion_run_id,
      requestId: request.request_id,
      attemptNumber: operation.attempt_number,
      requestedAt: operation.requested_at,
      completedAt: rejection.completedAt,
      outcome: rejection.outcome,
      status: rejection.status,
      headers: rejection.headers,
      retryAfterMs: rejection.retryAfterMs ?? null,
      diagnostic: rejection.diagnostic,
    }),
    rejectedCaptureStatement(database, {
      completedAt: rejection.completedAt,
      status: rejection.status,
      responseHeadersJson: canonicalJson(rejection.headers),
      diagnostic: rejection.diagnostic,
      attemptId: operation.attempt_id,
    }),
    ...(failureCode === null ? [] : [failRequestStatement(database, request, failureCode)]),
    ...(exhaustion?.statements ?? []),
  ]);
  if (failureCode !== null) {
    return { kind: "done", failure_code: failureCode, request_made: true };
  }
  if (exhaustion !== null) {
    return {
      kind: "done",
      failure_code: exhaustion.failure_code,
      request_made: true,
    };
  }
  return {
    kind: "wait",
    wait_ms: rejection.retryAfterMs ?? exponentialBackoff(operation.attempt_number),
    request_made: true,
  };
}

// Replay path for a capture operation already recorded as failed: within the
// budget the caller waits and retries; at the budget the exhaustion outcome
// (pause or terminal request failure) was committed atomically with that
// failure record, so there is nothing further to record here.
function retryOrFinish(request: EvidenceRequestRow, attemptNumber: number): CaptureTransportResult {
  return attemptNumber >= retryBudget(request)
    ? { kind: "done", failure_code: null, request_made: false }
    : {
        kind: "wait",
        wait_ms: exponentialBackoff(attemptNumber),
        request_made: false,
      };
}

function retryBudget(request: EvidenceRequestRow): number {
  return request.retry_generation * captureAttemptsPerRetryGeneration;
}

function recoverableExhaustionClassification(
  outcome: string | null,
): RetryExhaustionFacts["failure_classification"] | null {
  if (outcome === "network_failure" || outcome === "http_failure" || outcome === "storage_failure") {
    return outcome;
  }
  return null;
}

// The committed outcome of one exhausted retry generation whose latest
// failure is recoverable. Storage exhaustion always pauses: R2 is ours to
// recover regardless of what was being fetched. Transport exhaustion follows
// the role's transport policy: a Retry Pause for catalogue-fact roles, or a
// tolerated failure of that one request for a Printing Image so collection
// continues. Statements are returned unexecuted so callers commit them in
// the same atomic batch as the final failed attempt.
function recoverableExhaustion(
  database: D1Database,
  run: IngestionEvidenceRow,
  request: EvidenceRequestRow,
  attemptCount: number,
  classification: RetryExhaustionFacts["failure_classification"],
  httpStatus: number | null,
): { statements: D1PreparedStatement[]; failure_code: string | null } {
  const policy = transportPolicyForRole(request.request_role);
  if (classification !== "storage_failure" && policy.on_transport_exhaustion === "fail_request") {
    const failureCode = requestFailureCode(request.request_role, "retries_exhausted");
    return {
      statements: [failRequestStatement(database, request, failureCode)],
      failure_code: failureCode,
    };
  }
  return {
    statements: retryExhaustionPauseStatements(database, request.ingestion_run_id, {
      request_id: request.request_id,
      source_lineage: evidencePlanForRequest(run, request.request_id).source_lineage,
      hostname: new URL(request.url).hostname,
      retry_generation: request.retry_generation,
      attempt_count: attemptCount,
      failure_classification: classification,
      http_status: httpStatus,
    }),
    failure_code: null,
  };
}

async function failRequest(database: D1Database, request: EvidenceRequestRow, failureCode: string): Promise<void> {
  await failRequestStatement(database, request, failureCode).run();
}

function failRequestStatement(
  database: D1Database,
  request: EvidenceRequestRow,
  failureCode: string,
): D1PreparedStatement {
  return failedSourceRequestStatement(database, {
    failureCode: failureCode,
    runId: request.ingestion_run_id,
    requestId: request.request_id,
  });
}

async function findReusableSnapshot(
  database: D1Database,
  run: IngestionEvidenceRow,
  request: EvidenceRequestRow,
): Promise<SnapshotRow | null> {
  const evidencePlan = evidencePlanForRequest(run, request.request_id);
  const priorSnapshots = await reusableSnapshotsStatement(database, {
    sourceLineage: evidencePlan.source_lineage,
    requestUrl: request.url,
    adapterVersion: evidencePlan.adapter_version,
    representationFingerprint: request.representation_fingerprint,
  }).all<SnapshotRow>();
  return (
    priorSnapshots.results.find((snapshot) => {
      const vary: unknown = JSON.parse(snapshot.response_vary_json);
      return (
        Array.isArray(vary) &&
        !vary.includes("*") &&
        vary.every((name) => typeof name === "string" && representedRequestHeaders.has(name))
      );
    }) ?? null
  );
}

function revalidationHeaders(snapshot: SnapshotRow): Record<string, string> {
  const headers = parseStringRecord(snapshot.response_headers_json);
  if (headers.etag !== undefined) return { "if-none-match": headers.etag };
  if (headers["last-modified"] !== undefined) {
    return { "if-modified-since": headers["last-modified"] };
  }
  return {};
}

function validatorAccepted(response: Response, snapshot: SnapshotRow): boolean {
  const prior = parseStringRecord(snapshot.response_headers_json);
  if (prior.etag !== undefined) {
    const returned = response.headers.get("etag");
    return returned === null || returned === prior.etag;
  }
  return prior["last-modified"] !== undefined;
}

function parseRetryAfter(value: string | null, observedAt: number): number | null {
  // An empty header carries no timing instruction; Number("") would
  // otherwise coerce it to an immediate zero-millisecond retry.
  if (value === null || value.trim() === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - observedAt);
}

function exponentialBackoff(attemptNumber: number): number {
  return Math.min(8_000, 500 * 2 ** (attemptNumber - 1)) + jitter(250);
}

function jitter(maximumInclusive: number): number {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return random[0]! % (maximumInclusive + 1);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

class CapturePersistenceError extends Error {
  constructor(
    readonly outcome: "body_failure" | "storage_failure",
    message: string,
  ) {
    super(message);
  }
}
