import {
  canonicalJson,
  sha256,
  utf8,
} from "./serialization";
import { AdministrationProblem } from "./ingestion";

const maximumResponseBytes = 32 * 1024 * 1024;
const allowedRequestHeaders = new Set([
  "accept",
  "accept-language",
  "user-agent",
]);

type CollectionPlanRequest = {
  id: string;
  url: string;
  method: "GET";
  headers: Record<string, string>;
};

type CollectionPlan = {
  supported_game: string;
  source_lineage: string;
  adapter_version: string;
  requests: CollectionPlanRequest[];
};

type CollectionRunRow = {
  id: string;
  state: "collecting" | "succeeded" | "failed";
  supported_game: string;
  source_lineage: string;
  adapter_version: string;
  idempotency_key: string;
  request_plan_json: string;
  linked_run_id: string | null;
  created_at: string;
  completed_at: string | null;
  failure_code: string | null;
};

type CollectionRequestRow = {
  ingestion_run_id: string;
  request_id: string;
  sequence_number: number;
  method: "GET";
  url: string;
  request_headers_json: string;
  state: "pending" | "captured" | "observed" | "failed";
  source_snapshot_id: string | null;
};

type SnapshotRow = {
  id: string;
  ingestion_run_id: string;
  request_id: string;
  fetch_attempt_id: string;
  request_method: string;
  request_url: string;
  request_headers_json: string;
  retrieved_at: string;
  http_status: number;
  response_headers_json: string;
  media_type: string | null;
  content_digest: string;
  content_byte_length: number;
  content_object_key: string;
  source_lineage: string;
  adapter_version: string;
  reused_source_snapshot_id: string | null;
};

type ObservationSetRow = {
  id: string;
  source_snapshot_id: string;
  adapter_version: string;
  parsed_at: string;
  content_digest: string;
  content_byte_length: number;
  content_object_key: string;
  observation_count: number;
};

type AttemptRow = {
  id: string;
  ingestion_run_id: string;
  request_id: string;
  attempt_number: number;
  requested_at: string;
  completed_at: string;
  outcome: string;
  http_status: number | null;
  response_headers_json: string;
  retry_after_ms: number | null;
  diagnostic: string | null;
};

export type StartSourceCollectionRequest = {
  supported_game: string;
  source_lineage: string;
  adapter_version: string;
  idempotency_key: string;
  requests: readonly {
    id: string;
    url: string;
    method?: string;
    headers?: Record<string, string>;
  }[];
};

export async function startSourceCollection(
  database: D1Database,
  request: StartSourceCollectionRequest,
): Promise<Record<string, unknown>> {
  const plan = validateCollectionPlan(request);
  const planJson = canonicalJson(plan);
  const replay = await database
    .prepare(
      "SELECT * FROM source_collection_runs WHERE idempotency_key = ?",
    )
    .bind(request.idempotency_key)
    .first<CollectionRunRow>();
  if (replay !== null) {
    if (replay.request_plan_json !== planJson) {
      throw new AdministrationProblem(
        409,
        "idempotency_key_reused",
        "The idempotency key was already used for a different source collection.",
      );
    }
    return showSourceCollection(database, replay.id);
  }

  const runId = `run_${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `INSERT INTO source_collection_runs (
          id, state, supported_game, source_lineage, adapter_version,
          idempotency_key, request_plan_json, linked_run_id, created_at
        ) VALUES (?, 'collecting', ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .bind(
        runId,
        plan.supported_game,
        plan.source_lineage,
        plan.adapter_version,
        request.idempotency_key,
        planJson,
        createdAt,
      ),
    ...plan.requests.map((sourceRequest, sequenceNumber) =>
      database
        .prepare(
          `INSERT INTO source_collection_requests (
            ingestion_run_id, request_id, sequence_number, method, url,
            request_headers_json, state, source_snapshot_id
          ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL)`,
        )
        .bind(
          runId,
          sourceRequest.id,
          sequenceNumber,
          sourceRequest.method,
          sourceRequest.url,
          canonicalJson(sourceRequest.headers),
        ),
    ),
  ];
  await database.batch(statements);
  return showSourceCollection(database, runId);
}

export async function resumeSourceCollection(
  database: D1Database,
  evidenceObjects: R2Bucket,
  runId: string,
): Promise<Record<string, unknown>> {
  const run = await requiredCollectionRun(database, runId);
  if (run.state !== "collecting") {
    throw new AdministrationProblem(
      409,
      "source_collection_not_active",
      "Only an active Source Collection can be resumed.",
    );
  }
  const requests = await database
    .prepare(
      `SELECT * FROM source_collection_requests
       WHERE ingestion_run_id = ? AND state IN ('pending', 'captured')
       ORDER BY sequence_number`,
    )
    .bind(runId)
    .all<CollectionRequestRow>();

  const byHostname = new Map<string, CollectionRequestRow[]>();
  for (const sourceRequest of requests.results) {
    const hostname = new URL(sourceRequest.url).hostname;
    const hostRequests = byHostname.get(hostname) ?? [];
    hostRequests.push(sourceRequest);
    byHostname.set(hostname, hostRequests);
  }
  const failures = (
    await Promise.all(
      [...byHostname.values()].map(async (hostRequests) => {
        for (const sourceRequest of hostRequests) {
          const failureCode = await collectRequest(
            database,
            evidenceObjects,
            run,
            sourceRequest,
          );
          if (failureCode !== null) return failureCode;
        }
        return null;
      }),
    )
  ).filter((failure): failure is string => failure !== null);

  const completedAt = new Date().toISOString();
  await database
    .prepare(
      `UPDATE source_collection_runs
       SET state = ?, completed_at = ?, failure_code = ?
       WHERE id = ? AND state = 'collecting'`,
    )
    .bind(
      failures.length === 0 ? "succeeded" : "failed",
      completedAt,
      failures[0] ?? null,
      runId,
    )
    .run();
  return showSourceCollection(database, runId);
}

export async function retrySourceCollection(
  database: D1Database,
  sourceRunId: string,
  idempotencyKey: string,
): Promise<Record<string, unknown>> {
  assertIdentifier(idempotencyKey, "idempotency_key");
  const source = await requiredCollectionRun(database, sourceRunId);
  if (source.state === "collecting") {
    throw new AdministrationProblem(
      409,
      "source_collection_not_terminal",
      "An active Source Collection must be resumed, not retried.",
    );
  }
  const replay = await database
    .prepare(
      "SELECT * FROM source_collection_runs WHERE idempotency_key = ?",
    )
    .bind(idempotencyKey)
    .first<CollectionRunRow>();
  if (replay !== null) {
    if (replay.linked_run_id !== source.id) {
      throw new AdministrationProblem(
        409,
        "idempotency_key_reused",
        "The idempotency key was already used for a different source retry.",
      );
    }
    return showSourceCollection(database, replay.id);
  }

  const plan = parseCollectionPlan(source.request_plan_json);
  const runId = `run_${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  await database.batch([
    database
      .prepare(
        `INSERT INTO source_collection_runs (
          id, state, supported_game, source_lineage, adapter_version,
          idempotency_key, request_plan_json, linked_run_id, created_at
        ) VALUES (?, 'collecting', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        runId,
        source.supported_game,
        source.source_lineage,
        source.adapter_version,
        idempotencyKey,
        source.request_plan_json,
        source.id,
        createdAt,
      ),
    ...plan.requests.map((sourceRequest, sequenceNumber) =>
      database
        .prepare(
          `INSERT INTO source_collection_requests (
            ingestion_run_id, request_id, sequence_number, method, url,
            request_headers_json, state, source_snapshot_id
          ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL)`,
        )
        .bind(
          runId,
          sourceRequest.id,
          sequenceNumber,
          sourceRequest.method,
          sourceRequest.url,
          canonicalJson(sourceRequest.headers),
        ),
    ),
  ]);
  return showSourceCollection(database, runId);
}

export async function reparseSourceSnapshot(
  database: D1Database,
  evidenceObjects: R2Bucket,
  snapshotId: string,
  adapterVersion: string,
): Promise<Record<string, unknown>> {
  assertIdentifier(snapshotId, "source_snapshot_id");
  assertIdentifier(adapterVersion, "adapter_version");
  return publicObservationSet(
    await parseSnapshot(
      database,
      evidenceObjects,
      snapshotId,
      adapterVersion,
    ),
  );
}

export async function sourceSnapshotContent(
  database: D1Database,
  evidenceObjects: R2Bucket,
  snapshotId: string,
): Promise<Response> {
  assertIdentifier(snapshotId, "source_snapshot_id");
  const snapshot = await database
    .prepare("SELECT * FROM source_snapshots WHERE id = ?")
    .bind(snapshotId)
    .first<SnapshotRow>();
  if (snapshot === null) {
    throw new AdministrationProblem(
      404,
      "source_snapshot_not_found",
      "The requested Source Snapshot does not exist.",
    );
  }
  return evidenceObjectResponse(evidenceObjects, {
    key: snapshot.content_object_key,
    digest: snapshot.content_digest,
    byteLength: snapshot.content_byte_length,
    contentType: snapshot.media_type ?? "application/octet-stream",
  });
}

export async function sourceObservationSetContent(
  database: D1Database,
  evidenceObjects: R2Bucket,
  observationSetId: string,
): Promise<Response> {
  assertIdentifier(observationSetId, "source_observation_set_id");
  const observationSet = await database
    .prepare("SELECT * FROM source_observation_sets WHERE id = ?")
    .bind(observationSetId)
    .first<ObservationSetRow>();
  if (observationSet === null) {
    throw new AdministrationProblem(
      404,
      "source_observation_set_not_found",
      "The requested Source Observation set does not exist.",
    );
  }
  return evidenceObjectResponse(evidenceObjects, {
    key: observationSet.content_object_key,
    digest: observationSet.content_digest,
    byteLength: observationSet.content_byte_length,
    contentType: "application/json",
  });
}

export async function showSourceCollection(
  database: D1Database,
  runId: string,
): Promise<Record<string, unknown>> {
  const run = await requiredCollectionRun(database, runId);
  const [snapshots, observationSets, attempts] = await Promise.all([
    database
      .prepare(
        `SELECT * FROM source_snapshots
         WHERE ingestion_run_id = ? ORDER BY retrieved_at, id`,
      )
      .bind(runId)
      .all<SnapshotRow>(),
    database
      .prepare(
        `SELECT observation_sets.*
         FROM source_observation_sets AS observation_sets
         JOIN source_snapshots AS snapshots
           ON snapshots.id = observation_sets.source_snapshot_id
         WHERE snapshots.ingestion_run_id = ?
         ORDER BY observation_sets.parsed_at, observation_sets.id`,
      )
      .bind(runId)
      .all<ObservationSetRow>(),
    database
      .prepare(
        `SELECT * FROM source_fetch_attempts
         WHERE ingestion_run_id = ?
         ORDER BY request_id, attempt_number`,
      )
      .bind(runId)
      .all<AttemptRow>(),
  ]);

  return {
    id: run.id,
    state: run.state,
    supported_game: run.supported_game,
    source_lineage: run.source_lineage,
    adapter_version: run.adapter_version,
    idempotency_key: run.idempotency_key,
    linked_run_id: run.linked_run_id,
    created_at: run.created_at,
    completed_at: run.completed_at,
    failure_code: run.failure_code,
    snapshots: snapshots.results.map(publicSnapshot),
    observation_sets: observationSets.results.map(publicObservationSet),
    diagnostics: attempts.results.map(publicAttempt),
  };
}

async function evidenceObjectResponse(
  bucket: R2Bucket,
  expected: {
    key: string;
    digest: string;
    byteLength: number;
    contentType: string;
  },
): Promise<Response> {
  const object = await bucket.get(expected.key);
  if (
    object === null ||
    object.size !== expected.byteLength ||
    object.customMetadata?.sha256 !== expected.digest
  ) {
    throw new AdministrationProblem(
      500,
      "evidence_object_unavailable",
      "The immutable evidence object is unavailable or failed verification.",
    );
  }
  return new Response(object.body, {
    headers: {
      "cache-control": "private, max-age=31536000, immutable",
      "content-length": String(expected.byteLength),
      "content-type": expected.contentType,
      etag: `"sha256-${expected.digest}"`,
    },
  });
}

async function collectRequest(
  database: D1Database,
  evidenceObjects: R2Bucket,
  run: CollectionRunRow,
  sourceRequest: CollectionRequestRow,
): Promise<string | null> {
  if (sourceRequest.state === "captured") {
    if (sourceRequest.source_snapshot_id === null) {
      throw new Error("Captured source request is missing its Source Snapshot");
    }
    try {
      await parseSnapshot(
        database,
        evidenceObjects,
        sourceRequest.source_snapshot_id,
        run.adapter_version,
      );
      await markRequestObserved(
        database,
        run.id,
        sourceRequest.request_id,
        sourceRequest.source_snapshot_id,
      );
      return null;
    } catch (error) {
      if (error instanceof AdministrationProblem) return error.code;
      throw error;
    }
  }

  const configuredHeaders = parseStringRecord(
    sourceRequest.request_headers_json,
  );
  const reusableSnapshot = await findReusableSnapshot(
    database,
    run,
    sourceRequest.url,
  );
  const requestHeaders = {
    ...configuredHeaders,
    ...(reusableSnapshot === null
      ? {}
      : revalidationHeaders(reusableSnapshot)),
  };

  for (let attemptNumber = 1; attemptNumber <= 4; attemptNumber += 1) {
    const attemptId = `srcfetch_${crypto.randomUUID()}`;
    const fetched = await pacedFetch(
      database,
      run.id,
      sourceRequest,
      requestHeaders,
    );
    const responseHeaders =
      fetched.response === null
        ? {}
        : headersRecord(fetched.response.headers);

    if (fetched.response === null) {
      await insertAttempt(database, {
        id: attemptId,
        runId: run.id,
        requestId: sourceRequest.request_id,
        attemptNumber,
        requestedAt: fetched.requestedAt,
        completedAt: fetched.completedAt,
        outcome: "network_failure",
        httpStatus: null,
        responseHeaders,
        retryAfterMs: null,
        diagnostic: fetched.error,
      });
      if (attemptNumber === 4) {
        await failCollectionRequest(database, run.id, sourceRequest.request_id);
        return "source_request_retries_exhausted";
      }
      await scheduler.wait(exponentialBackoff(attemptNumber));
      continue;
    }

    const response = fetched.response;
    const successfulFetch = { ...fetched, response };
    if (response.status === 304) {
      if (
        reusableSnapshot === null ||
        !validatorAccepted(response, reusableSnapshot)
      ) {
        await insertAttempt(database, {
          id: attemptId,
          runId: run.id,
          requestId: sourceRequest.request_id,
          attemptNumber,
          requestedAt: fetched.requestedAt,
          completedAt: fetched.completedAt,
          outcome: "content_rejected",
          httpStatus: response.status,
          responseHeaders,
          retryAfterMs: null,
          diagnostic:
            "A 304 response did not match an immutable snapshot validator for this adapter version.",
        });
        await failCollectionRequest(database, run.id, sourceRequest.request_id);
        return "source_revalidation_rejected";
      }
      await persistRevalidatedSnapshot(
        database,
        evidenceObjects,
        run,
        sourceRequest,
        requestHeaders,
        attemptId,
        attemptNumber,
        successfulFetch,
        responseHeaders,
        reusableSnapshot,
      );
      return null;
    }

    if (response.status >= 200 && response.status < 300) {
      try {
        const parseFailure = await persistSuccessfulSnapshot(
          database,
          evidenceObjects,
          run,
          sourceRequest,
          requestHeaders,
          attemptId,
          attemptNumber,
          successfulFetch,
          responseHeaders,
        );
        return parseFailure;
      } catch (error) {
        if (!(error instanceof AdministrationProblem)) throw error;
        await insertAttempt(database, {
          id: attemptId,
          runId: run.id,
          requestId: sourceRequest.request_id,
          attemptNumber,
          requestedAt: fetched.requestedAt,
          completedAt: fetched.completedAt,
          outcome: "content_rejected",
          httpStatus: response.status,
          responseHeaders,
          retryAfterMs: null,
          diagnostic: error.message,
        });
        await failCollectionRequest(database, run.id, sourceRequest.request_id);
        return error.code;
      }
    }

    const isRedirect = response.status >= 300 && response.status < 400;
    const retryAfterMs = parseRetryAfter(
      response.headers.get("retry-after"),
      Date.parse(fetched.completedAt),
    );
    await insertAttempt(database, {
      id: attemptId,
      runId: run.id,
      requestId: sourceRequest.request_id,
      attemptNumber,
      requestedAt: fetched.requestedAt,
      completedAt: fetched.completedAt,
      outcome: isRedirect ? "redirect" : "http_failure",
      httpStatus: response.status,
      responseHeaders,
      retryAfterMs,
      diagnostic: isRedirect
        ? "Redirect responses are retained only as diagnostics."
        : `Official Source returned HTTP ${response.status}.`,
    });
    if (response.body !== null) await response.body.cancel();
    if (isRedirect) {
      await failCollectionRequest(database, run.id, sourceRequest.request_id);
      return "source_redirect_rejected";
    }
    if (
      attemptNumber === 4 ||
      (response.status !== 429 && response.status < 500)
    ) {
      await failCollectionRequest(database, run.id, sourceRequest.request_id);
      return attemptNumber === 4
        ? "source_request_retries_exhausted"
        : "source_request_rejected";
    }
    await scheduler.wait(
      retryAfterMs ?? exponentialBackoff(attemptNumber),
    );
  }
  throw new Error("Unreachable source request retry state");
}

type FetchResult = {
  response: Response | null;
  requestedAt: string;
  completedAt: string;
  error: string | null;
};

async function pacedFetch(
  database: D1Database,
  runId: string,
  sourceRequest: CollectionRequestRow,
  headers: Record<string, string>,
): Promise<FetchResult> {
  const hostname = new URL(sourceRequest.url).hostname;
  const leaseId = `${runId}:${sourceRequest.request_id}:${crypto.randomUUID()}`;
  await acquireHostLease(database, hostname, leaseId);
  const requestedAt = new Date().toISOString();
  let response: Response | null = null;
  let error: string | null = null;
  try {
    response = await fetch(sourceRequest.url, {
      method: sourceRequest.method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (caught) {
    error =
      caught instanceof Error
        ? caught.message
        : "Official Source network request failed.";
  }
  const completedAt = new Date().toISOString();
  await releaseHostLease(database, hostname, leaseId, completedAt);
  return { response, requestedAt, completedAt, error };
}

async function acquireHostLease(
  database: D1Database,
  hostname: string,
  leaseId: string,
): Promise<void> {
  await database
    .prepare(
      `INSERT OR IGNORE INTO source_host_pacing (
        hostname, next_request_not_before, locked_by, lease_expires_at
      ) VALUES (?, ?, NULL, NULL)`,
    )
    .bind(hostname, new Date(0).toISOString())
    .run();

  while (true) {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + 35_000).toISOString();
    const acquired = await database
      .prepare(
        `UPDATE source_host_pacing
         SET locked_by = ?, lease_expires_at = ?
         WHERE hostname = ?
           AND next_request_not_before <= ?
           AND (
             locked_by IS NULL
             OR lease_expires_at IS NULL
             OR lease_expires_at <= ?
           )
         RETURNING hostname`,
      )
      .bind(
        leaseId,
        leaseExpiresAt,
        hostname,
        now.toISOString(),
        now.toISOString(),
      )
      .first<{ hostname: string }>();
    if (acquired !== null) return;

    const pacing = await database
      .prepare(
        `SELECT next_request_not_before, lease_expires_at
         FROM source_host_pacing WHERE hostname = ?`,
      )
      .bind(hostname)
      .first<{
        next_request_not_before: string;
        lease_expires_at: string | null;
      }>();
    const wakeAt = Math.max(
      Date.parse(pacing?.next_request_not_before ?? now.toISOString()),
      Date.parse(pacing?.lease_expires_at ?? now.toISOString()),
    );
    await scheduler.wait(Math.max(10, Math.min(wakeAt - now.getTime(), 35_000)));
  }
}

async function releaseHostLease(
  database: D1Database,
  hostname: string,
  leaseId: string,
  completedAt: string,
): Promise<void> {
  const nextRequestAt = new Date(
    Date.parse(completedAt) + 1_000 + randomJitter(250),
  ).toISOString();
  await database
    .prepare(
      `UPDATE source_host_pacing
       SET next_request_not_before = ?, locked_by = NULL, lease_expires_at = NULL
       WHERE hostname = ? AND locked_by = ?`,
    )
    .bind(nextRequestAt, hostname, leaseId)
    .run();
}

async function persistSuccessfulSnapshot(
  database: D1Database,
  evidenceObjects: R2Bucket,
  run: CollectionRunRow,
  sourceRequest: CollectionRequestRow,
  requestHeaders: Record<string, string>,
  attemptId: string,
  attemptNumber: number,
  fetched: FetchResult & { response: Response },
  responseHeaders: Record<string, string>,
): Promise<string | null> {
  const bytes = await readBoundedBody(fetched.response);
  const contentDigest = await sha256(bytes);
  const objectKey = `source-snapshots/sha256/${contentDigest}`;
  await putImmutableObject(
    evidenceObjects,
    objectKey,
    bytes,
    contentDigest,
    fetched.response.headers.get("content-type") ??
      "application/octet-stream",
  );
  const snapshotId = `srcsnap_${crypto.randomUUID()}`;
  await persistSnapshotMetadata(database, {
    run,
    sourceRequest,
    requestHeaders,
    attemptId,
    attemptNumber,
    fetched,
    responseHeaders,
    outcome: "success",
    snapshotId,
    contentDigest,
    contentByteLength: bytes.byteLength,
    contentObjectKey: objectKey,
    mediaType: fetched.response.headers.get("content-type"),
    reusedSnapshotId: null,
  });
  try {
    await parseSnapshot(
      database,
      evidenceObjects,
      snapshotId,
      run.adapter_version,
    );
    await markRequestObserved(
      database,
      run.id,
      sourceRequest.request_id,
      snapshotId,
    );
    return null;
  } catch (error) {
    if (error instanceof AdministrationProblem) return error.code;
    throw error;
  }
}

async function persistRevalidatedSnapshot(
  database: D1Database,
  evidenceObjects: R2Bucket,
  run: CollectionRunRow,
  sourceRequest: CollectionRequestRow,
  requestHeaders: Record<string, string>,
  attemptId: string,
  attemptNumber: number,
  fetched: FetchResult & { response: Response },
  responseHeaders: Record<string, string>,
  reusableSnapshot: SnapshotRow,
): Promise<void> {
  const snapshotId = `srcsnap_${crypto.randomUUID()}`;
  await persistSnapshotMetadata(database, {
    run,
    sourceRequest,
    requestHeaders,
    attemptId,
    attemptNumber,
    fetched,
    responseHeaders,
    outcome: "cache_revalidated",
    snapshotId,
    contentDigest: reusableSnapshot.content_digest,
    contentByteLength: reusableSnapshot.content_byte_length,
    contentObjectKey: reusableSnapshot.content_object_key,
    mediaType: reusableSnapshot.media_type,
    reusedSnapshotId: reusableSnapshot.id,
  });
  await parseSnapshot(
    database,
    evidenceObjects,
    snapshotId,
    run.adapter_version,
  );
  await markRequestObserved(
    database,
    run.id,
    sourceRequest.request_id,
    snapshotId,
  );
}

type PersistSnapshotInput = {
  run: CollectionRunRow;
  sourceRequest: CollectionRequestRow;
  requestHeaders: Record<string, string>;
  attemptId: string;
  attemptNumber: number;
  fetched: FetchResult & { response: Response };
  responseHeaders: Record<string, string>;
  outcome: "success" | "cache_revalidated";
  snapshotId: string;
  contentDigest: string;
  contentByteLength: number;
  contentObjectKey: string;
  mediaType: string | null;
  reusedSnapshotId: string | null;
};

async function persistSnapshotMetadata(
  database: D1Database,
  input: PersistSnapshotInput,
): Promise<void> {
  await database.batch([
    database
      .prepare(
        `INSERT INTO source_fetch_attempts (
          id, ingestion_run_id, request_id, attempt_number, requested_at,
          completed_at, outcome, http_status, response_headers_json,
          retry_after_ms, diagnostic
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .bind(
        input.attemptId,
        input.run.id,
        input.sourceRequest.request_id,
        input.attemptNumber,
        input.fetched.requestedAt,
        input.fetched.completedAt,
        input.outcome,
        input.fetched.response.status,
        canonicalJson(input.responseHeaders),
      ),
    database
      .prepare(
        `INSERT INTO source_snapshots (
          id, ingestion_run_id, request_id, fetch_attempt_id,
          request_method, request_url, request_headers_json, retrieved_at,
          http_status, response_headers_json, media_type, content_digest,
          content_byte_length, content_object_key, source_lineage,
          adapter_version, reused_source_snapshot_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.snapshotId,
        input.run.id,
        input.sourceRequest.request_id,
        input.attemptId,
        input.sourceRequest.method,
        input.sourceRequest.url,
        canonicalJson(input.requestHeaders),
        input.fetched.completedAt,
        input.fetched.response.status,
        canonicalJson(input.responseHeaders),
        input.mediaType,
        input.contentDigest,
        input.contentByteLength,
        input.contentObjectKey,
        input.run.source_lineage,
        input.run.adapter_version,
        input.reusedSnapshotId,
      ),
    database
      .prepare(
        `UPDATE source_collection_requests
         SET state = 'captured', source_snapshot_id = ?
         WHERE ingestion_run_id = ? AND request_id = ? AND state = 'pending'`,
      )
      .bind(
        input.snapshotId,
        input.run.id,
        input.sourceRequest.request_id,
      ),
  ]);
}

async function markRequestObserved(
  database: D1Database,
  runId: string,
  requestId: string,
  snapshotId: string,
): Promise<void> {
  await database
    .prepare(
      `UPDATE source_collection_requests
       SET state = 'observed'
       WHERE ingestion_run_id = ?
         AND request_id = ?
         AND source_snapshot_id = ?
         AND state = 'captured'`,
    )
    .bind(runId, requestId, snapshotId)
    .run();
}

async function parseSnapshot(
  database: D1Database,
  evidenceObjects: R2Bucket,
  snapshotId: string,
  adapterVersion: string,
): Promise<ObservationSetRow> {
  if (
    adapterVersion !== "json-document@1" &&
    adapterVersion !== "json-document@2"
  ) {
    throw new AdministrationProblem(
      422,
      "adapter_not_supported",
      "The requested Official Source adapter version is not installed.",
    );
  }
  const snapshot = await database
    .prepare("SELECT * FROM source_snapshots WHERE id = ?")
    .bind(snapshotId)
    .first<SnapshotRow>();
  if (snapshot === null) {
    throw new Error("Source Snapshot disappeared before parsing");
  }
  const object = await evidenceObjects.get(snapshot.content_object_key);
  if (object === null) {
    throw new Error("Source Snapshot bytes are unavailable");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (
    bytes.byteLength !== snapshot.content_byte_length ||
    (await sha256(bytes)) !== snapshot.content_digest
  ) {
    throw new Error("Source Snapshot bytes failed digest verification");
  }

  let document: unknown;
  try {
    document = JSON.parse(
      new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: false,
      }).decode(bytes),
    );
  } catch {
    throw new AdministrationProblem(
      422,
      "source_parse_failed",
      "The Source Snapshot is not valid UTF-8 JSON.",
    );
  }
  const observations =
    isRecord(document) && Array.isArray(document.cards)
      ? document.cards
      : [document];
  const parsedAt = new Date().toISOString();
  const observationSetId = `srcobsset_${crypto.randomUUID()}`;
  const observationDocument = {
    contract: "card-keepr-source-observations@1",
    id: observationSetId,
    source_snapshot_id: snapshot.id,
    adapter_version: adapterVersion,
    parsed_at: parsedAt,
    observations: observations.map((value, index) => ({
      id: `srcobs_${observationSetId.slice("srcobsset_".length)}_${index + 1}`,
      ordinal: index + 1,
      value,
    })),
  };
  const observationBytes = utf8(canonicalJson(observationDocument));
  const contentDigest = await sha256(observationBytes);
  const objectKey = `source-observations/${observationSetId}.json`;
  await putImmutableObject(
    evidenceObjects,
    objectKey,
    observationBytes,
    contentDigest,
    "application/json",
  );
  await database
    .prepare(
      `INSERT INTO source_observation_sets (
        id, source_snapshot_id, adapter_version, parsed_at, content_digest,
        content_byte_length, content_object_key, observation_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      observationSetId,
      snapshot.id,
      adapterVersion,
      parsedAt,
      contentDigest,
      observationBytes.byteLength,
      objectKey,
      observations.length,
    )
    .run();
  const stored = await database
    .prepare("SELECT * FROM source_observation_sets WHERE id = ?")
    .bind(observationSetId)
    .first<ObservationSetRow>();
  if (stored === null) {
    throw new Error("Source Observation set disappeared after persistence");
  }
  return stored;
}

type AttemptInput = {
  id: string;
  runId: string;
  requestId: string;
  attemptNumber: number;
  requestedAt: string;
  completedAt: string;
  outcome:
    | "network_failure"
    | "redirect"
    | "http_failure"
    | "content_rejected";
  httpStatus: number | null;
  responseHeaders: Record<string, string>;
  retryAfterMs: number | null;
  diagnostic: string | null;
};

async function insertAttempt(
  database: D1Database,
  attempt: AttemptInput,
): Promise<void> {
  await database
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
      attempt.httpStatus,
      canonicalJson(attempt.responseHeaders),
      attempt.retryAfterMs,
      attempt.diagnostic,
    )
    .run();
}

async function failCollectionRequest(
  database: D1Database,
  runId: string,
  requestId: string,
): Promise<void> {
  await database
    .prepare(
      `UPDATE source_collection_requests
       SET state = 'failed'
       WHERE ingestion_run_id = ? AND request_id = ? AND state = 'pending'`,
    )
    .bind(runId, requestId)
    .run();
}

function findReusableSnapshot(
  database: D1Database,
  run: CollectionRunRow,
  requestUrl: string,
): Promise<SnapshotRow | null> {
  return database
    .prepare(
      `SELECT * FROM source_snapshots
       WHERE source_lineage = ?
         AND request_url = ?
         AND adapter_version = ?
         AND (
           json_extract(response_headers_json, '$.etag') IS NOT NULL
           OR json_extract(response_headers_json, '$."last-modified"') IS NOT NULL
         )
       ORDER BY retrieved_at DESC, id DESC
       LIMIT 1`,
    )
    .bind(run.source_lineage, requestUrl, run.adapter_version)
    .first<SnapshotRow>();
}

function revalidationHeaders(
  snapshot: SnapshotRow,
): Record<string, string> {
  const responseHeaders = parseStringRecord(
    snapshot.response_headers_json,
  );
  if (responseHeaders.etag !== undefined) {
    return { "if-none-match": responseHeaders.etag };
  }
  if (responseHeaders["last-modified"] !== undefined) {
    return {
      "if-modified-since": responseHeaders["last-modified"],
    };
  }
  return {};
}

function validatorAccepted(
  response: Response,
  reusableSnapshot: SnapshotRow,
): boolean {
  const priorHeaders = parseStringRecord(
    reusableSnapshot.response_headers_json,
  );
  const priorEtag = priorHeaders.etag;
  if (priorEtag !== undefined) {
    const returnedEtag = response.headers.get("etag");
    return returnedEtag === null || returnedEtag === priorEtag;
  }
  return priorHeaders["last-modified"] !== undefined;
}

function parseRetryAfter(
  value: string | null,
  observedAt: number,
): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(60_000, Math.ceil(seconds * 1_000));
  }
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.min(60_000, Math.max(0, date - observedAt));
}

function exponentialBackoff(attemptNumber: number): number {
  return (
    Math.min(8_000, 500 * 2 ** (attemptNumber - 1)) +
    randomJitter(250)
  );
}

function randomJitter(maximumInclusive: number): number {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return random[0]! % (maximumInclusive + 1);
}

async function putImmutableObject(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
  digest: string,
  contentType: string,
): Promise<void> {
  const existing = await bucket.head(key);
  if (existing !== null) {
    if (
      existing.size !== bytes.byteLength ||
      existing.customMetadata?.sha256 !== digest
    ) {
      throw new Error("Immutable evidence object key collision");
    }
    return;
  }
  const stored = await bucket.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: {
      contentType,
      cacheControl: "private, max-age=31536000, immutable",
    },
    customMetadata: { sha256: digest },
  });
  if (stored === null) {
    const raced = await bucket.head(key);
    if (
      raced === null ||
      raced.size !== bytes.byteLength ||
      raced.customMetadata?.sha256 !== digest
    ) {
      throw new Error("Immutable evidence object write conflict");
    }
  }
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    Number.parseInt(declaredLength, 10) > maximumResponseBytes
  ) {
    throw new AdministrationProblem(
      422,
      "source_response_too_large",
      "The Official Source response exceeds the 32 MiB capture limit.",
    );
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > maximumResponseBytes) {
      await reader.cancel();
      throw new AdministrationProblem(
        422,
        "source_response_too_large",
        "The Official Source response exceeds the 32 MiB capture limit.",
      );
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function validateCollectionPlan(
  request: StartSourceCollectionRequest,
): CollectionPlan {
  assertIdentifier(request.supported_game, "supported_game");
  assertIdentifier(request.source_lineage, "source_lineage");
  assertIdentifier(request.adapter_version, "adapter_version");
  assertSupportedAdapter(request.adapter_version);
  assertIdentifier(request.idempotency_key, "idempotency_key");
  if (request.requests.length === 0 || request.requests.length > 100) {
    throw new AdministrationProblem(
      422,
      "invalid_parameter",
      "requests must contain between 1 and 100 Official Source requests.",
    );
  }
  const requestIds = new Set<string>();
  const requests = request.requests.map((sourceRequest) => {
    assertIdentifier(sourceRequest.id, "requests[].id");
    if (requestIds.has(sourceRequest.id)) {
      throw new AdministrationProblem(
        422,
        "invalid_parameter",
        "Each Official Source request identity must be unique.",
      );
    }
    requestIds.add(sourceRequest.id);
    const url = validOfficialSourceUrl(sourceRequest.url);
    if (sourceRequest.method !== undefined && sourceRequest.method !== "GET") {
      throw new AdministrationProblem(
        422,
        "invalid_parameter",
        "Official Source collection currently permits only GET.",
      );
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(sourceRequest.headers ?? {})) {
      const normalizedName = name.toLowerCase();
      if (!allowedRequestHeaders.has(normalizedName)) {
        throw new AdministrationProblem(
          422,
          "unsafe_source_request_header",
          `Official Source request header ${name} is not permitted.`,
        );
      }
      headers[normalizedName] = value;
    }
    return {
      id: sourceRequest.id,
      url: url.href,
      method: "GET" as const,
      headers,
    };
  });
  return {
    supported_game: request.supported_game,
    source_lineage: request.source_lineage,
    adapter_version: request.adapter_version,
    requests,
  };
}

function assertSupportedAdapter(adapterVersion: string): void {
  if (
    adapterVersion !== "json-document@1" &&
    adapterVersion !== "json-document@2"
  ) {
    throw new AdministrationProblem(
      422,
      "adapter_not_supported",
      "The requested Official Source adapter version is not installed.",
    );
  }
}

function parseCollectionPlan(json: string): CollectionPlan {
  const value: unknown = JSON.parse(json);
  if (
    !isRecord(value) ||
    typeof value.supported_game !== "string" ||
    typeof value.source_lineage !== "string" ||
    typeof value.adapter_version !== "string" ||
    !Array.isArray(value.requests)
  ) {
    throw new Error("Stored Source Collection plan is invalid");
  }
  const requests: CollectionPlanRequest[] = value.requests.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.url !== "string" ||
      item.method !== "GET" ||
      !isRecord(item.headers) ||
      Object.values(item.headers).some(
        (header) => typeof header !== "string",
      )
    ) {
      throw new Error("Stored Source Collection plan is invalid");
    }
    return {
      id: item.id,
      url: item.url,
      method: "GET",
      headers: item.headers as Record<string, string>,
    };
  });
  return {
    supported_game: value.supported_game,
    source_lineage: value.source_lineage,
    adapter_version: value.adapter_version,
    requests,
  };
}

function validOfficialSourceUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AdministrationProblem(
      422,
      "invalid_parameter",
      "Official Source request URL is invalid.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new AdministrationProblem(
      422,
      "invalid_parameter",
      "Official Source request URLs must be credential-free HTTPS URLs.",
    );
  }
  return url;
}

function assertIdentifier(value: string, field: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value)
  ) {
    throw new AdministrationProblem(
      422,
      "invalid_parameter",
      `${field} is not a valid opaque identity.`,
    );
  }
}

async function requiredCollectionRun(
  database: D1Database,
  runId: string,
): Promise<CollectionRunRow> {
  assertIdentifier(runId, "run_id");
  const row = await database
    .prepare("SELECT * FROM source_collection_runs WHERE id = ?")
    .bind(runId)
    .first<CollectionRunRow>();
  if (row === null) {
    throw new AdministrationProblem(
      404,
      "source_collection_not_found",
      "The requested Source Collection does not exist.",
    );
  }
  return row;
}

function publicSnapshot(row: SnapshotRow): Record<string, unknown> {
  return {
    id: row.id,
    request: {
      method: row.request_method,
      url: row.request_url,
      headers: parseStringRecord(row.request_headers_json),
    },
    retrieval: {
      retrieved_at: row.retrieved_at,
      fetch_attempt_id: row.fetch_attempt_id,
    },
    http: {
      status: row.http_status,
      headers: parseStringRecord(row.response_headers_json),
    },
    content: {
      digest: row.content_digest,
      byte_length: row.content_byte_length,
      object_key: row.content_object_key,
      media_type: row.media_type,
    },
    source_lineage: row.source_lineage,
    adapter_version: row.adapter_version,
    ingestion_run_id: row.ingestion_run_id,
    reused_source_snapshot_id: row.reused_source_snapshot_id,
  };
}

function publicObservationSet(
  row: ObservationSetRow,
): Record<string, unknown> {
  return {
    id: row.id,
    source_snapshot_id: row.source_snapshot_id,
    adapter_version: row.adapter_version,
    parsed_at: row.parsed_at,
    content_digest: row.content_digest,
    content_byte_length: row.content_byte_length,
    object_key: row.content_object_key,
    observation_count: row.observation_count,
  };
}

function publicAttempt(row: AttemptRow): Record<string, unknown> {
  return {
    id: row.id,
    request_id: row.request_id,
    attempt_number: row.attempt_number,
    requested_at: row.requested_at,
    completed_at: row.completed_at,
    outcome: row.outcome,
    http_status: row.http_status,
    response_headers: parseStringRecord(row.response_headers_json),
    retry_after_ms: row.retry_after_ms,
    diagnostic: row.diagnostic,
  };
}

function headersRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(
    [...headers.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function parseStringRecord(json: string): Record<string, string> {
  const value: unknown = JSON.parse(json);
  if (!isRecord(value)) throw new Error("Stored header metadata is invalid");
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string")) {
    throw new Error("Stored header metadata is invalid");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}
