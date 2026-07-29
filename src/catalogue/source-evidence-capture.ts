import { createHash } from "node:crypto";
import { AdministrationProblem } from "./ingestion";
import { canonicalJson, sha256, utf8 } from "./serialization";
import {
  headersRecord,
  parseStringRecord,
  responseVary,
} from "./source-evidence-model";
import { parseSnapshot } from "./source-evidence-parsing";
import {
  type EvidenceRequestRow,
  type IngestionEvidenceRow,
  type SnapshotRow,
} from "./source-evidence-repository";

const maximumAttempts = 4;
const multipartPartBytes = 5 * 1024 * 1024;
const representedRequestHeaders = new Set([
  "accept",
  "accept-language",
  "user-agent",
]);

type AttemptOutcome =
  | "success"
  | "cache_revalidated"
  | "redirect"
  | "http_failure"
  | "network_failure"
  | "body_failure"
  | "storage_failure"
  | "content_rejected";

type CaptureOperationRow = {
  attempt_id: string;
  ingestion_run_id: string;
  request_id: string;
  attempt_number: number;
  source_snapshot_id: string;
  content_object_key: string;
  state:
    | "planned"
    | "response_received"
    | "uploaded"
    | "finalized"
    | "failed";
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

export async function hostPacingDelay(
  database: D1Database,
  hostname: string,
): Promise<number> {
  const row = await database
    .prepare(
      "SELECT next_request_not_before FROM source_host_pacing WHERE hostname = ?",
    )
    .bind(hostname)
    .first<{ next_request_not_before: string }>();
  if (row === null) return 0;
  return Math.max(0, Date.parse(row.next_request_not_before) - Date.now());
}

export async function advanceHostPacing(
  database: D1Database,
  hostname: string,
): Promise<void> {
  const next = new Date(Date.now() + 1000 + jitter(250)).toISOString();
  await database
    .prepare(
      `INSERT INTO source_host_pacing (
        hostname, next_request_not_before, locked_by, lease_expires_at
       ) VALUES (?, ?, NULL, NULL)
       ON CONFLICT(hostname) DO UPDATE SET
         next_request_not_before = excluded.next_request_not_before`,
    )
    .bind(hostname, next)
    .run();
}

export async function prepareCaptureAttempt(
  database: D1Database,
  run: IngestionEvidenceRow,
  sourceRequest: EvidenceRequestRow,
): Promise<PreparedCaptureAttempt> {
  const request = await currentRequest(
    database,
    run.id,
    sourceRequest.request_id,
  );
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

  const open = await database
    .prepare(
      `SELECT * FROM source_capture_operations
       WHERE ingestion_run_id = ? AND request_id = ?
         AND state IN ('planned', 'response_received', 'uploaded')
       ORDER BY attempt_number DESC LIMIT 1`,
    )
    .bind(run.id, request.request_id)
    .first<CaptureOperationRow>();
  if (open !== null) return publicPreparedAttempt(open);

  const latest = await database
    .prepare(
      `SELECT COALESCE(MAX(attempt_number), 0) AS attempt_number
       FROM source_fetch_attempts
       WHERE ingestion_run_id = ? AND request_id = ?`,
    )
    .bind(run.id, request.request_id)
    .first<{ attempt_number: number }>();
  const attemptNumber = (latest?.attempt_number ?? 0) + 1;
  if (attemptNumber > maximumAttempts) {
    await failRequest(database, request, "source_request_retries_exhausted");
    return {
      kind: "done",
      failure_code: "source_request_retries_exhausted",
    };
  }
  const identity = await captureOperationIdentity(
    run.id,
    request.request_id,
    attemptNumber,
  );
  const requestedAt = new Date().toISOString();
  await database
    .prepare(
      `INSERT OR IGNORE INTO source_capture_operations (
        attempt_id, ingestion_run_id, request_id, attempt_number,
        source_snapshot_id, content_object_key, state, requested_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'planned', ?)`,
    )
    .bind(
      identity.attemptId,
      run.id,
      request.request_id,
      attemptNumber,
      identity.snapshotId,
      identity.objectKey,
      requestedAt,
    )
    .run();
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
  let operation = await requiredCaptureOperation(
    database,
    prepared.attempt_id,
  );
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
    return retryOrFinish(operation.attempt_number);
  }
  if (operation.state === "response_received") {
    const recovered = await recoverCompletedUpload(
      database,
      evidenceObjects,
      operation,
    );
    if (recovered) {
      return {
        kind: "uploaded",
        attempt_id: operation.attempt_id,
        request_made: false,
      };
    }
  }

  if (operation.state === "planned") {
    await database
      .prepare(
        `UPDATE source_capture_operations SET requested_at = ?
         WHERE attempt_id = ? AND state = 'planned'`,
      )
      .bind(new Date().toISOString(), operation.attempt_id)
      .run();
    operation = await requiredCaptureOperation(database, operation.attempt_id);
  }

  const request = await currentRequest(
    database,
    run.id,
    sourceRequest.request_id,
  );
  const configuredHeaders = parseStringRecord(request.request_headers_json);
  const reusable = await findReusableSnapshot(database, run, request);
  const requestHeaders = {
    ...configuredHeaders,
    ...(reusable === null ? {} : revalidationHeaders(reusable)),
  };
  let response: Response | null = null;
  let networkError: string | null = null;
  let fetchFailureOutcome: "network_failure" | "body_failure" =
    "network_failure";
  try {
    response = await officialSourceTransport.fetch(request.url, {
      method: "GET",
      headers: requestHeaders,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    networkError = errorMessage(
      error,
      "Official Source network request failed.",
    );
    if (/content-length|body|stream/i.test(networkError)) {
      fetchFailureOutcome = "body_failure";
    }
  }
  const completedAt = new Date().toISOString();
  if (response === null) {
    return recordFailedTransportAttempt(database, request, operation, {
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
      return recordRejectedAttempt(database, request, operation, {
        outcome: "content_rejected",
        completedAt,
        status: response.status,
        headers: responseHeaders,
        diagnostic:
          "A 304 response did not match an immutable Source Snapshot validator and representation.",
        failureCode: "source_revalidation_rejected",
      });
    }
    if (response.body !== null) await response.body.cancel();
    await database
      .prepare(
        `UPDATE source_capture_operations
         SET state = 'uploaded', completed_at = ?,
             request_headers_json = ?, http_status = ?,
             response_headers_json = ?, response_vary_json = ?,
             media_type = ?, content_digest = ?,
             content_byte_length = ?, reused_source_snapshot_id = ?
         WHERE attempt_id = ?
           AND state IN ('planned', 'response_received')`,
      )
      .bind(
        completedAt,
        canonicalJson(requestHeaders),
        response.status,
        canonicalJson(responseHeaders),
        reusable.response_vary_json,
        reusable.media_type,
        reusable.content_digest,
        reusable.content_byte_length,
        reusable.id,
        operation.attempt_id,
      )
      .run();
    return {
      kind: "uploaded",
      attempt_id: operation.attempt_id,
      request_made: true,
    };
  }

  if (!response.ok) {
    const redirect = response.status >= 300 && response.status < 400;
    const retryAfterMs = parseRetryAfter(
      response.headers.get("retry-after"),
      Date.parse(completedAt),
    );
    if (response.body !== null) await response.body.cancel();
    return recordRejectedAttempt(database, request, operation, {
      outcome: redirect ? "redirect" : "http_failure",
      completedAt,
      status: response.status,
      headers: responseHeaders,
      retryAfterMs,
      diagnostic: redirect
        ? "Redirect responses are retained only as diagnostics."
        : `Official Source returned HTTP ${response.status}.`,
      failureCode: redirect
        ? "source_redirect_rejected"
        : response.status !== 429 && response.status < 500
          ? "source_request_rejected"
          : null,
    });
  }

  await database
    .prepare(
      `UPDATE source_capture_operations
       SET state = 'response_received', completed_at = ?,
           request_headers_json = ?, http_status = ?,
           response_headers_json = ?, response_vary_json = ?,
           media_type = ?
       WHERE attempt_id = ? AND state = 'planned'`,
    )
    .bind(
      completedAt,
      canonicalJson(requestHeaders),
      response.status,
      canonicalJson(responseHeaders),
      canonicalJson(responseVary(response.headers)),
      response.headers.get("content-type"),
      operation.attempt_id,
    )
    .run();
  operation = await requiredCaptureOperation(database, operation.attempt_id);
  try {
    const content = await streamSnapshotToR2(
      evidenceObjects,
      operation.content_object_key,
      response,
    );
    await database
      .prepare(
        `UPDATE source_capture_operations
         SET state = 'uploaded', content_digest = ?,
             content_byte_length = ?
         WHERE attempt_id = ? AND state = 'response_received'`,
      )
      .bind(
        content.digest,
        content.byteLength,
        operation.attempt_id,
      )
      .run();
    return {
      kind: "uploaded",
      attempt_id: operation.attempt_id,
      request_made: true,
    };
  } catch (error) {
    const recovered = await recoverCompletedUpload(
      database,
      evidenceObjects,
      operation,
    );
    if (recovered) {
      return {
        kind: "uploaded",
        attempt_id: operation.attempt_id,
        request_made: true,
      };
    }
    const failure =
      error instanceof CapturePersistenceError
        ? error
        : new CapturePersistenceError(
            "storage_failure",
            errorMessage(error, "Evidence persistence failed."),
          );
    return recordFailedTransportAttempt(database, request, operation, {
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
  const outcome: AttemptOutcome =
    operation.reused_source_snapshot_id === null
      ? "success"
      : "cache_revalidated";
  const reusedSnapshot =
    operation.reused_source_snapshot_id === null
      ? null
      : await database
          .prepare("SELECT * FROM source_snapshots WHERE id = ?")
          .bind(operation.reused_source_snapshot_id)
          .first<SnapshotRow>();
  if (
    operation.reused_source_snapshot_id !== null &&
    reusedSnapshot === null
  ) {
    throw new Error("Revalidated Source Snapshot bytes are unavailable");
  }
  const contentObjectKey =
    reusedSnapshot?.content_object_key ?? operation.content_object_key;
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
    database
      .prepare(
        `INSERT OR IGNORE INTO source_snapshots (
          id, ingestion_run_id, request_id, fetch_attempt_id,
          request_method, request_url, request_headers_json,
          representation_fingerprint, response_vary_json, retrieved_at,
          http_status, response_headers_json, media_type, content_digest,
          content_byte_length, content_object_key, source_lineage,
          supported_game, game_profile_version, adapter_version,
          reused_source_snapshot_id
        ) VALUES (?, ?, ?, ?, 'GET', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        operation.source_snapshot_id,
        run.id,
        sourceRequest.request_id,
        operation.attempt_id,
        sourceRequest.url,
        operation.request_headers_json,
        sourceRequest.representation_fingerprint,
        operation.response_vary_json,
        operation.completed_at,
        operation.http_status,
        operation.response_headers_json,
        operation.media_type,
        operation.content_digest,
        operation.content_byte_length,
        contentObjectKey,
        run.source_lineage,
        run.supported_game,
        run.game_profile_version,
        run.adapter_version,
        operation.reused_source_snapshot_id,
      ),
    database
      .prepare(
        `UPDATE source_requests
         SET state = 'captured', source_snapshot_id = ?
         WHERE ingestion_run_id = ? AND request_id = ? AND state = 'pending'`,
      )
      .bind(
        operation.source_snapshot_id,
        run.id,
        sourceRequest.request_id,
      ),
    database
      .prepare(
        `UPDATE source_capture_operations SET state = 'finalized'
         WHERE attempt_id = ? AND state = 'uploaded'`,
      )
      .bind(operation.attempt_id),
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
  try {
    await parseSnapshot(
      database,
      evidenceObjects,
      snapshotId,
      run.adapter_version,
    );
    await database
      .prepare(
        `UPDATE source_requests SET state = 'observed'
         WHERE ingestion_run_id = ? AND request_id = ?
           AND source_snapshot_id = ? AND state = 'captured'`,
      )
      .bind(run.id, sourceRequest.request_id, snapshotId)
      .run();
    return {
      kind: "done",
      failure_code: null,
      request_made: false,
    };
  } catch (error) {
    if (!(error instanceof AdministrationProblem)) throw error;
    await failRequest(database, sourceRequest, error.code);
    return {
      kind: "done",
      failure_code: error.code,
      request_made: false,
    };
  }
}

function publicPreparedAttempt(
  operation: CaptureOperationRow,
): Extract<PreparedCaptureAttempt, { kind: "attempt" }> {
  return {
    kind: "attempt",
    attempt_id: operation.attempt_id,
    attempt_number: operation.attempt_number,
    source_snapshot_id: operation.source_snapshot_id,
    content_object_key: operation.content_object_key,
    requested_at: operation.requested_at,
  };
}

async function currentRequest(
  database: D1Database,
  runId: string,
  requestId: string,
): Promise<EvidenceRequestRow> {
  const request = await database
    .prepare(
      `SELECT * FROM source_requests
       WHERE ingestion_run_id = ? AND request_id = ?`,
    )
    .bind(runId, requestId)
    .first<EvidenceRequestRow>();
  if (request === null) throw new Error("Evidence request disappeared");
  return request;
}

async function requiredCaptureOperation(
  database: D1Database,
  attemptId: string,
): Promise<CaptureOperationRow> {
  const operation = await database
    .prepare("SELECT * FROM source_capture_operations WHERE attempt_id = ?")
    .bind(attemptId)
    .first<CaptureOperationRow>();
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
  await database
    .prepare(
      `UPDATE source_capture_operations
       SET state = 'uploaded', content_digest = ?,
           content_byte_length = ?
       WHERE attempt_id = ? AND state = 'response_received'`,
    )
    .bind(hash.digest("hex"), byteLength, operation.attempt_id)
    .run();
  return true;
}

async function streamSnapshotToR2(
  bucket: R2Bucket,
  objectKey: string,
  response: Response,
): Promise<{ byteLength: number; digest: string }> {
  const hash = createHash("sha256");
  const metadata = {
    httpMetadata: {
      contentType:
        response.headers.get("content-type") ?? "application/octet-stream",
      cacheControl: "private, max-age=31536000, immutable",
    },
  };
  if (response.body === null) {
    try {
      const stored = await bucket.put(objectKey, new Uint8Array(), {
        ...metadata,
        onlyIf: { etagDoesNotMatch: "*" },
      });
      if (stored === null) throw new Error("object key already exists");
    } catch (error) {
      throw new CapturePersistenceError(
        "storage_failure",
        errorMessage(error, "Evidence object write failed."),
      );
    }
    return { byteLength: 0, digest: hash.digest("hex") };
  }
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const byteLength = Number.parseInt(declared, 10);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new CapturePersistenceError(
        "body_failure",
        "Official Source returned an invalid Content-Length.",
      );
    }
    const fixed = new FixedLengthStream(byteLength);
    let observedLength = 0;
    const hashingStream = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
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
        throw new CapturePersistenceError(
          "body_failure",
          errorMessage(error, "Official Source body stream failed."),
        );
      }
      if (read.done) break;
      hash.update(read.value);
      byteLength += read.value.byteLength;
      let offset = 0;
      while (offset < read.value.byteLength) {
        const copying = Math.min(
          pending.byteLength - pendingLength,
          read.value.byteLength - offset,
        );
        pending.set(read.value.subarray(offset, offset + copying), pendingLength);
        pendingLength += copying;
        offset += copying;
        if (pendingLength === pending.byteLength) {
          try {
            uploadedParts.push(
              await multipart.uploadPart(uploadedParts.length + 1, pending),
            );
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
        uploadedParts.push(
          await multipart.uploadPart(
            uploadedParts.length + 1,
            pending.subarray(0, pendingLength),
          ),
        );
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
  const exhausted = operation.attempt_number === maximumAttempts;
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
    database
      .prepare(
        `UPDATE source_capture_operations
         SET state = 'failed', completed_at = ?, http_status = ?,
             response_headers_json = ?, failure_outcome = ?,
             diagnostic = ?
         WHERE attempt_id = ? AND state <> 'finalized'`,
      )
      .bind(
        failure.completedAt,
        failure.status,
        canonicalJson(failure.headers),
        failure.outcome,
        failure.diagnostic,
        operation.attempt_id,
      ),
    ...(exhausted
      ? [
          failRequestStatement(
            database,
            request,
            "source_request_retries_exhausted",
          ),
        ]
      : []),
  ]);
  return exhausted
    ? {
        kind: "done",
        failure_code: "source_request_retries_exhausted",
        request_made: true,
      }
    : {
        kind: "wait",
        wait_ms: exponentialBackoff(operation.attempt_number),
        request_made: true,
      };
}

async function recordRejectedAttempt(
  database: D1Database,
  request: EvidenceRequestRow,
  operation: CaptureOperationRow,
  rejection: {
    outcome: "redirect" | "http_failure" | "content_rejected";
    completedAt: string;
    status: number;
    headers: Record<string, string>;
    retryAfterMs?: number | null;
    diagnostic: string;
    failureCode: string | null;
  },
): Promise<CaptureTransportResult> {
  const exhausted = operation.attempt_number === maximumAttempts;
  const failureCode =
    rejection.failureCode ??
    (exhausted ? "source_request_retries_exhausted" : null);
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
    database
      .prepare(
        `UPDATE source_capture_operations
         SET state = 'failed', completed_at = ?, http_status = ?,
             response_headers_json = ?, diagnostic = ?
         WHERE attempt_id = ? AND state <> 'finalized'`,
      )
      .bind(
        rejection.completedAt,
        rejection.status,
        canonicalJson(rejection.headers),
        rejection.diagnostic,
        operation.attempt_id,
      ),
    ...(failureCode === null
      ? []
      : [failRequestStatement(database, request, failureCode)]),
  ]);
  if (failureCode !== null) {
    return {
      kind: "done",
      failure_code: failureCode,
      request_made: true,
    };
  }
  return {
    kind: "wait",
    wait_ms:
      rejection.retryAfterMs ??
      exponentialBackoff(operation.attempt_number),
    request_made: true,
  };
}

function retryOrFinish(attemptNumber: number): CaptureTransportResult {
  return attemptNumber >= maximumAttempts
      ? {
          kind: "done",
          failure_code: "source_request_retries_exhausted",
          request_made: false,
        }
    : {
        kind: "wait",
        wait_ms: exponentialBackoff(attemptNumber),
        request_made: false,
      };
}

type AttemptInput = {
  id: string;
  runId: string;
  requestId: string;
  attemptNumber: number;
  requestedAt: string;
  completedAt: string;
  outcome: AttemptOutcome;
  status: number | null;
  headers: Record<string, string>;
  retryAfterMs: number | null;
  diagnostic: string | null;
};

function attemptStatement(
  database: D1Database,
  attempt: AttemptInput,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT OR IGNORE INTO source_fetch_attempts (
        id, ingestion_run_id, request_id, attempt_number, requested_at,
        completed_at, outcome, http_status, response_headers_json,
        retry_after_ms, diagnostic
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      attempt.id,
      attempt.runId,
      attempt.requestId,
      attempt.attemptNumber,
      attempt.requestedAt,
      attempt.completedAt,
      attempt.outcome,
      attempt.status,
      canonicalJson(attempt.headers),
      attempt.retryAfterMs,
      attempt.diagnostic,
    );
}

async function failRequest(
  database: D1Database,
  request: EvidenceRequestRow,
  failureCode: string,
): Promise<void> {
  await failRequestStatement(database, request, failureCode).run();
}

function failRequestStatement(
  database: D1Database,
  request: EvidenceRequestRow,
  failureCode: string,
): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE source_requests
       SET state = 'failed', failure_code = ?
       WHERE ingestion_run_id = ? AND request_id = ?
         AND state IN ('pending', 'captured')`,
    )
    .bind(failureCode, request.ingestion_run_id, request.request_id);
}

async function findReusableSnapshot(
  database: D1Database,
  run: IngestionEvidenceRow,
  request: EvidenceRequestRow,
): Promise<SnapshotRow | null> {
  const candidates = await database
    .prepare(
      `SELECT * FROM source_snapshots
       WHERE source_lineage = ? AND request_url = ?
         AND adapter_version = ? AND representation_fingerprint = ?
         AND (
           json_extract(response_headers_json, '$.etag') IS NOT NULL
           OR json_extract(response_headers_json, '$."last-modified"') IS NOT NULL
         )
       ORDER BY retrieved_at DESC, id DESC LIMIT 10`,
    )
    .bind(
      run.source_lineage,
      request.url,
      run.adapter_version,
      request.representation_fingerprint,
    )
    .all<SnapshotRow>();
  return (
    candidates.results.find((candidate) => {
      const vary: unknown = JSON.parse(candidate.response_vary_json);
      return (
        Array.isArray(vary) &&
        !vary.includes("*") &&
        vary.every(
          (name) =>
            typeof name === "string" && representedRequestHeaders.has(name),
        )
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

function validatorAccepted(
  response: Response,
  snapshot: SnapshotRow,
): boolean {
  const prior = parseStringRecord(snapshot.response_headers_json);
  if (prior.etag !== undefined) {
    const returned = response.headers.get("etag");
    return returned === null || returned === prior.etag;
  }
  return prior["last-modified"] !== undefined;
}

function parseRetryAfter(
  value: string | null,
  observedAt: number,
): number | null {
  if (value === null) return null;
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
