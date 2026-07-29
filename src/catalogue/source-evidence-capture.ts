import { createHash } from "node:crypto";
import { AdministrationProblem } from "./ingestion";
import { canonicalJson } from "./serialization";
import {
  headersRecord,
  parseStringRecord,
  responseVary,
} from "./source-evidence-model";
import {
  type EvidenceRequestRow,
  type IngestionEvidenceRow,
  type SnapshotRow,
} from "./source-evidence-repository";
import { parseSnapshot } from "./source-evidence-parsing";

const maximumResponseBytes = 32 * 1024 * 1024;
const maximumAttempts = 4;
const representedRequestHeaders = new Set([
  "accept",
  "accept-language",
  "user-agent",
]);

export type CaptureAttemptResult =
  | { kind: "done"; failure_code: string | null }
  | { kind: "wait"; wait_ms: number };

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

export async function captureAttempt(
  database: D1Database,
  evidenceObjects: R2Bucket,
  run: IngestionEvidenceRow,
  sourceRequest: EvidenceRequestRow,
): Promise<CaptureAttemptResult> {
  const current = await database
    .prepare(
      `SELECT * FROM source_requests
       WHERE ingestion_run_id = ? AND request_id = ?`,
    )
    .bind(run.id, sourceRequest.request_id)
    .first<EvidenceRequestRow>();
  if (current === null) throw new Error("Evidence request disappeared");
  if (current.state === "observed") {
    return { kind: "done", failure_code: null };
  }
  if (current.state === "failed") {
    return { kind: "done", failure_code: current.failure_code };
  }
  if (current.state === "captured") {
    if (current.source_snapshot_id === null) {
      throw new Error("Captured evidence request has no Source Snapshot");
    }
    try {
      await parseSnapshot(
        database,
        evidenceObjects,
        current.source_snapshot_id,
        run.adapter_version,
      );
      await database
        .prepare(
          `UPDATE source_requests SET state = 'observed'
           WHERE ingestion_run_id = ? AND request_id = ?
             AND state = 'captured'`,
        )
        .bind(run.id, current.request_id)
        .run();
      return { kind: "done", failure_code: null };
    } catch (error) {
      if (!(error instanceof AdministrationProblem)) throw error;
      await failRequest(database, current, error.code);
      return { kind: "done", failure_code: error.code };
    }
  }

  const count = await database
    .prepare(
      `SELECT COUNT(*) AS attempts FROM source_fetch_attempts
       WHERE ingestion_run_id = ? AND request_id = ?`,
    )
    .bind(run.id, current.request_id)
    .first<{ attempts: number }>();
  const attemptNumber = (count?.attempts ?? 0) + 1;
  if (attemptNumber > maximumAttempts) {
    await failRequest(database, current, "source_request_retries_exhausted");
    return {
      kind: "done",
      failure_code: "source_request_retries_exhausted",
    };
  }

  const configuredHeaders = parseStringRecord(current.request_headers_json);
  const reusable = await findReusableSnapshot(database, run, current);
  const requestHeaders = {
    ...configuredHeaders,
    ...(reusable === null ? {} : revalidationHeaders(reusable)),
  };
  const attemptId = `srcfetch_${crypto.randomUUID()}`;
  const requestedAt = new Date().toISOString();
  let response: Response | null = null;
  let networkError: string | null = null;
  try {
    response = await fetch(current.url, {
      method: "GET",
      headers: requestHeaders,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    networkError =
      error instanceof Error
        ? error.message
        : "Official Source network request failed.";
  }
  const completedAt = new Date().toISOString();
  await recordNextHostRequest(database, new URL(current.url).hostname);

  if (response === null) {
    await insertAttempt(database, {
      id: attemptId,
      runId: run.id,
      requestId: current.request_id,
      attemptNumber,
      requestedAt,
      completedAt,
      outcome: "network_failure",
      status: null,
      headers: {},
      retryAfterMs: null,
      diagnostic: networkError,
    });
    if (attemptNumber === maximumAttempts) {
      await failRequest(database, current, "source_request_retries_exhausted");
      return {
        kind: "done",
        failure_code: "source_request_retries_exhausted",
      };
    }
    return { kind: "wait", wait_ms: exponentialBackoff(attemptNumber) };
  }

  const responseHeaders = headersRecord(response.headers);
  if (response.status === 304) {
    if (reusable === null || !validatorAccepted(response, reusable)) {
      await insertAttempt(database, {
        id: attemptId,
        runId: run.id,
        requestId: current.request_id,
        attemptNumber,
        requestedAt,
        completedAt,
        outcome: "content_rejected",
        status: response.status,
        headers: responseHeaders,
        retryAfterMs: null,
        diagnostic:
          "A 304 response did not match an immutable Source Snapshot validator and representation.",
      });
      if (response.body !== null) await response.body.cancel();
      await failRequest(database, current, "source_revalidation_rejected");
      return {
        kind: "done",
        failure_code: "source_revalidation_rejected",
      };
    }
    if (response.body !== null) await response.body.cancel();
    await persistRevalidatedSnapshot(database, run, current, {
      attemptId,
      attemptNumber,
      requestedAt,
      completedAt,
      response,
      responseHeaders,
      reusable,
      requestHeaders,
    });
    return parseCapturedRequest(database, evidenceObjects, run, current);
  }

  if (response.ok) {
    try {
      await persistStreamedSnapshot(database, evidenceObjects, run, current, {
        attemptId,
        attemptNumber,
        requestedAt,
        completedAt,
        response,
        requestHeaders,
        responseHeaders,
      });
      return parseCapturedRequest(database, evidenceObjects, run, current);
    } catch (error) {
      if (!(error instanceof AdministrationProblem)) throw error;
      await insertAttempt(database, {
        id: attemptId,
        runId: run.id,
        requestId: current.request_id,
        attemptNumber,
        requestedAt,
        completedAt,
        outcome: "content_rejected",
        status: response.status,
        headers: responseHeaders,
        retryAfterMs: null,
        diagnostic: error.message,
      });
      await failRequest(database, current, error.code);
      return { kind: "done", failure_code: error.code };
    }
  }

  const redirect = response.status >= 300 && response.status < 400;
  const retryAfterMs = parseRetryAfter(
    response.headers.get("retry-after"),
    Date.parse(completedAt),
  );
  await insertAttempt(database, {
    id: attemptId,
    runId: run.id,
    requestId: current.request_id,
    attemptNumber,
    requestedAt,
    completedAt,
    outcome: redirect ? "redirect" : "http_failure",
    status: response.status,
    headers: responseHeaders,
    retryAfterMs,
    diagnostic: redirect
      ? "Redirect responses are retained only as diagnostics."
      : `Official Source returned HTTP ${response.status}.`,
  });
  if (response.body !== null) await response.body.cancel();
  if (redirect) {
    await failRequest(database, current, "source_redirect_rejected");
    return { kind: "done", failure_code: "source_redirect_rejected" };
  }
  const retryable = response.status === 429 || response.status >= 500;
  if (!retryable || attemptNumber === maximumAttempts) {
    const failureCode =
      attemptNumber === maximumAttempts
        ? "source_request_retries_exhausted"
        : "source_request_rejected";
    await failRequest(database, current, failureCode);
    return { kind: "done", failure_code: failureCode };
  }
  return {
    kind: "wait",
    wait_ms: retryAfterMs ?? exponentialBackoff(attemptNumber),
  };
}

async function parseCapturedRequest(
  database: D1Database,
  evidenceObjects: R2Bucket,
  run: IngestionEvidenceRow,
  request: EvidenceRequestRow,
): Promise<CaptureAttemptResult> {
  const captured = await database
    .prepare(
      `SELECT source_snapshot_id FROM source_requests
       WHERE ingestion_run_id = ? AND request_id = ?`,
    )
    .bind(run.id, request.request_id)
    .first<{ source_snapshot_id: string | null }>();
  if (captured?.source_snapshot_id === null || captured === null) {
    throw new Error("Source Snapshot metadata was not persisted");
  }
  try {
    await parseSnapshot(
      database,
      evidenceObjects,
      captured.source_snapshot_id,
      run.adapter_version,
    );
    await database
      .prepare(
        `UPDATE source_requests SET state = 'observed'
         WHERE ingestion_run_id = ? AND request_id = ? AND state = 'captured'`,
      )
      .bind(run.id, request.request_id)
      .run();
    return { kind: "done", failure_code: null };
  } catch (error) {
    if (!(error instanceof AdministrationProblem)) throw error;
    await failRequest(database, request, error.code);
    return { kind: "done", failure_code: error.code };
  }
}

async function persistStreamedSnapshot(
  database: D1Database,
  bucket: R2Bucket,
  run: IngestionEvidenceRow,
  request: EvidenceRequestRow,
  input: {
    attemptId: string;
    attemptNumber: number;
    requestedAt: string;
    completedAt: string;
    response: Response;
    requestHeaders: Record<string, string>;
    responseHeaders: Record<string, string>;
  },
): Promise<void> {
  const declaredLength = input.response.headers.get("content-length");
  if (
    declaredLength !== null &&
    Number.parseInt(declaredLength, 10) > maximumResponseBytes
  ) {
    if (input.response.body !== null) await input.response.body.cancel();
    throw responseTooLarge();
  }
  const snapshotId = `srcsnap_${crypto.randomUUID()}`;
  const objectKey = `source-snapshots/${snapshotId}.bin`;
  const { byteLength, digest } = await streamSnapshotToR2(
    bucket,
    objectKey,
    input.response,
  );
  await database.batch([
    attemptStatement(database, {
      id: input.attemptId,
      runId: run.id,
      requestId: request.request_id,
      attemptNumber: input.attemptNumber,
      requestedAt: input.requestedAt,
      completedAt: input.completedAt,
      outcome: "success",
      status: input.response.status,
      headers: input.responseHeaders,
      retryAfterMs: null,
      diagnostic: null,
    }),
    database
      .prepare(
        `INSERT INTO source_snapshots (
          id, ingestion_run_id, request_id, fetch_attempt_id,
          request_method, request_url, request_headers_json,
          representation_fingerprint, response_vary_json, retrieved_at,
          http_status, response_headers_json, media_type, content_digest,
          content_byte_length, content_object_key, source_lineage,
          supported_game, game_profile_version, adapter_version,
          reused_source_snapshot_id
        ) VALUES (?, ?, ?, ?, 'GET', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(
        snapshotId,
        run.id,
        request.request_id,
        input.attemptId,
        request.url,
        canonicalJson(input.requestHeaders),
        request.representation_fingerprint,
        canonicalJson(responseVary(input.response.headers)),
        input.completedAt,
        input.response.status,
        canonicalJson(input.responseHeaders),
        input.response.headers.get("content-type"),
        digest,
        byteLength,
        objectKey,
        run.source_lineage,
        run.supported_game,
        run.game_profile_version,
        run.adapter_version,
      ),
    database
      .prepare(
        `UPDATE source_requests
         SET state = 'captured', source_snapshot_id = ?
         WHERE ingestion_run_id = ? AND request_id = ? AND state = 'pending'`,
      )
      .bind(snapshotId, run.id, request.request_id),
  ]);
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
    await bucket.put(objectKey, new Uint8Array(), {
      ...metadata,
      onlyIf: { etagDoesNotMatch: "*" },
    });
    return { byteLength: 0, digest: hash.digest("hex") };
  }
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const byteLength = Number.parseInt(declared, 10);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new AdministrationProblem(
        422,
        "source_content_length_invalid",
        "The Official Source returned an invalid Content-Length.",
      );
    }
    const fixed = new FixedLengthStream(byteLength);
    let observedLength = 0;
    const hashingStream = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        observedLength += chunk.byteLength;
        if (observedLength > maximumResponseBytes) {
          controller.error(responseTooLarge());
          return;
        }
        hash.update(chunk);
        controller.enqueue(chunk);
      },
    });
    const put = bucket.put(objectKey, fixed.readable, {
      ...metadata,
      onlyIf: { etagDoesNotMatch: "*" },
    });
    const pipe = response.body.pipeThrough(hashingStream).pipeTo(fixed.writable);
    const [stored] = await Promise.all([put, pipe]);
    if (stored === null) {
      throw new Error("Immutable Source Snapshot object key collision");
    }
    return { byteLength: observedLength, digest: hash.digest("hex") };
  }

  const multipart = await bucket.createMultipartUpload(objectKey, metadata);
  const uploadedParts: R2UploadedPart[] = [];
  const reader = response.body.getReader();
  const partBytes = 5 * 1024 * 1024;
  let pending = new Uint8Array(partBytes);
  let pendingLength = 0;
  let byteLength = 0;
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      hash.update(read.value);
      byteLength += read.value.byteLength;
      if (byteLength > maximumResponseBytes) throw responseTooLarge();
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
          uploadedParts.push(
            await multipart.uploadPart(uploadedParts.length + 1, pending),
          );
          pending = new Uint8Array(partBytes);
          pendingLength = 0;
        }
      }
    }
    if (pendingLength > 0 || uploadedParts.length === 0) {
      uploadedParts.push(
        await multipart.uploadPart(
          uploadedParts.length + 1,
          pending.subarray(0, pendingLength),
        ),
      );
    }
    await multipart.complete(uploadedParts);
    return { byteLength, digest: hash.digest("hex") };
  } catch (error) {
    await multipart.abort();
    throw error;
  }
}

async function persistRevalidatedSnapshot(
  database: D1Database,
  run: IngestionEvidenceRow,
  request: EvidenceRequestRow,
  input: {
    attemptId: string;
    attemptNumber: number;
    requestedAt: string;
    completedAt: string;
    response: Response;
    responseHeaders: Record<string, string>;
    reusable: SnapshotRow;
    requestHeaders: Record<string, string>;
  },
): Promise<void> {
  const snapshotId = `srcsnap_${crypto.randomUUID()}`;
  await database.batch([
    attemptStatement(database, {
      id: input.attemptId,
      runId: run.id,
      requestId: request.request_id,
      attemptNumber: input.attemptNumber,
      requestedAt: input.requestedAt,
      completedAt: input.completedAt,
      outcome: "cache_revalidated",
      status: input.response.status,
      headers: input.responseHeaders,
      retryAfterMs: null,
      diagnostic: null,
    }),
    database
      .prepare(
        `INSERT INTO source_snapshots (
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
        snapshotId,
        run.id,
        request.request_id,
        input.attemptId,
        request.url,
        canonicalJson(input.requestHeaders),
        request.representation_fingerprint,
        input.reusable.response_vary_json,
        input.completedAt,
        input.response.status,
        canonicalJson(input.responseHeaders),
        input.reusable.media_type,
        input.reusable.content_digest,
        input.reusable.content_byte_length,
        input.reusable.content_object_key,
        run.source_lineage,
        run.supported_game,
        run.game_profile_version,
        run.adapter_version,
        input.reusable.id,
      ),
    database
      .prepare(
        `UPDATE source_requests
         SET state = 'captured', source_snapshot_id = ?
         WHERE ingestion_run_id = ? AND request_id = ? AND state = 'pending'`,
      )
      .bind(snapshotId, run.id, request.request_id),
  ]);
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

type AttemptInput = {
  id: string;
  runId: string;
  requestId: string;
  attemptNumber: number;
  requestedAt: string;
  completedAt: string;
  outcome:
    | "success"
    | "cache_revalidated"
    | "redirect"
    | "http_failure"
    | "network_failure"
    | "content_rejected";
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
      `INSERT INTO source_fetch_attempts (
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

async function insertAttempt(
  database: D1Database,
  attempt: AttemptInput,
): Promise<void> {
  await attemptStatement(database, attempt).run();
}

async function failRequest(
  database: D1Database,
  request: EvidenceRequestRow,
  failureCode: string,
): Promise<void> {
  await database
    .prepare(
      `UPDATE source_requests
       SET state = 'failed', failure_code = ?
       WHERE ingestion_run_id = ? AND request_id = ?
         AND state IN ('pending', 'captured')`,
    )
    .bind(failureCode, request.ingestion_run_id, request.request_id)
    .run();
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

async function recordNextHostRequest(
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

function responseTooLarge(): AdministrationProblem {
  return new AdministrationProblem(
    422,
    "source_response_too_large",
    "The Official Source response exceeds the 32 MiB capture limit.",
  );
}
