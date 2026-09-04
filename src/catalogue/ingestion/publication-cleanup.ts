import { ingestionRunTransitionSql, AdministrationProblem, canonicalJson } from "../shared";

import {
  administrationClaimDeleteStatement,
  currentAdministrationClaimOwner,
  idempotencyCompletionStatements,
  replayAdministration,
} from "./administration-idempotency";
import {
  listCatalogueExportPrefix,
  PublicationPrefixOwnershipError,
  reservedPublicationOwnsUnpublishedPrefix,
} from "./publication-storage";
import { parseCleanupKeys, publicRun } from "./run-document-codec";
import {
  publicationCleanupNotBefore,
  releaseRunLockStatement,
  requiredPublicationCleanup,
  requiredRun,
} from "./run-storage";
import {
  type ApproveRunRequest,
  type IdempotencyClaimOwner,
  type PublicationCleanupRow,
  publicationLeaseMilliseconds,
  type RunRow,
} from "./run-types";
import { isIsoInstant, isSha256Digest, requiredPublicationValue } from "./run-values";

export async function attemptPublicationCleanup(
  database: D1Database,
  bucket: R2Bucket,
  runId: string,
  observedAt: string,
  idempotency?: {
    key: string;
    requestJson: string;
    claimOwner: IdempotencyClaimOwner;
  },
): Promise<Record<string, unknown> | null> {
  let cleanup = await database
    .prepare(
      `SELECT *
      FROM ingestion_publication_cleanup
      WHERE ingestion_run_id = ?`,
    )
    .bind(runId)
    .first<PublicationCleanupRow>();
  if (cleanup === null) {
    throw new AdministrationProblem(
      409,
      "publication_cleanup_not_required",
      "The Ingestion Run has no pending publication cleanup.",
    );
  }
  const run = await requiredRun(database, runId);
  if (!isIsoInstant(cleanup.not_before)) {
    throw new Error("The persisted publication cleanup fence is invalid.");
  }
  if (Date.parse(observedAt) < Date.parse(cleanup.not_before)) {
    throw new AdministrationProblem(
      409,
      "publication_cleanup_fenced",
      "Publication cleanup is fenced until the publication writer lease and quiescence window expire.",
      false,
    );
  }
  if (run.state !== "failed") {
    throw new AdministrationProblem(
      409,
      "publication_cleanup_not_terminal",
      "Publication cleanup is only available for a failed Ingestion Run.",
    );
  }
  if (cleanup.state === "completed") {
    if (
      idempotency !== undefined &&
      cleanup.idempotency_key === idempotency.key &&
      cleanup.request_json === idempotency.requestJson
    ) {
      const result = publicRun(run, cleanup);
      await database.batch(
        idempotencyCompletionStatements(database, {
          key: idempotency.key,
          operation: "retry_publication_cleanup",
          requestJson: idempotency.requestJson,
          response: result,
          status: 200,
          createdAt: cleanup.completed_at ?? observedAt,
          claimOwner: idempotency.claimOwner,
        }),
      );
      return result;
    }
    throw new AdministrationProblem(
      409,
      "publication_cleanup_not_required",
      "The abandoned Catalogue Export objects have already been removed.",
    );
  }
  if (cleanup.state === "cleaning") {
    const operation = activeCleanupOperation(cleanup, run, idempotency, observedAt);
    if (operation !== null) return operation;
  }
  const recordedKeys = parseCleanupKeys(cleanup.object_keys_json, run);
  const revisionId = requiredPublicationValue(run.publication_revision_id, "revision ID");
  if (!(await reservedPublicationOwnsUnpublishedPrefix(database, run))) {
    throw new AdministrationProblem(
      500,
      "publication_cleanup_failed",
      "The abandoned Catalogue Export prefix is no longer exclusively owned by the failed Ingestion Run.",
    );
  }
  const observedKeys = await listCatalogueExportPrefix(bucket, revisionId);
  const keys = [...new Set([...recordedKeys, ...observedKeys])].sort();
  const claimToken = `cleanup-claim:${crypto.randomUUID()}`;
  const claimExpiresAt = new Date(Date.parse(observedAt) + publicationLeaseMilliseconds).toISOString();
  const claimed = await database
    .prepare(
      `UPDATE ingestion_publication_cleanup
      SET state = 'cleaning',
          attempts = attempts + 1,
          failure_code = NULL,
          last_attempt_at = ?,
          object_keys_json = ?,
          idempotency_key = ?,
          request_json = ?,
          claim_token = ?,
          claim_version = claim_version + 1,
          claim_expires_at = ?
      WHERE ingestion_run_id = ?
        AND claim_version = ?
        AND (
          state IN ('pending', 'failed')
          OR (
            state = 'cleaning'
            AND claim_expires_at IS NOT NULL
            AND claim_expires_at <= ?
          )
        )
      RETURNING *`,
    )
    .bind(
      observedAt,
      canonicalJson(keys),
      idempotency?.key ?? null,
      idempotency?.requestJson ?? null,
      claimToken,
      claimExpiresAt,
      runId,
      cleanup.claim_version,
      observedAt,
    )
    .first<PublicationCleanupRow>();
  if (claimed === null) {
    if (idempotency !== undefined) {
      const completed = await replayAdministration(
        database,
        idempotency.key,
        "retry_publication_cleanup",
        idempotency.requestJson,
      );
      if (completed !== null) return completed;
    }
    cleanup = await requiredPublicationCleanup(database, runId);
    const operation = activeCleanupOperation(cleanup, run, idempotency, observedAt);
    if (operation !== null) return operation;
    throw new AdministrationProblem(
      409,
      "publication_cleanup_claim_changed",
      "Publication cleanup ownership changed; retry the request.",
      false,
    );
  }
  try {
    const claimedRun = await requiredRun(database, runId);
    if (!(await reservedPublicationOwnsUnpublishedPrefix(database, claimedRun))) {
      throw new PublicationPrefixOwnershipError("The publication prefix ownership changed before cleanup.");
    }
    await deleteR2KeysInBatches(bucket, keys);
    if ((await listCatalogueExportPrefix(bucket, revisionId)).length > 0) {
      throw new Error("Catalogue Export cleanup verification failed");
    }
    const completedCleanup: PublicationCleanupRow = {
      ...claimed,
      state: "completed",
      failure_code: null,
      last_attempt_at: observedAt,
      completed_at: observedAt,
      claim_token: null,
      claim_version: claimed.claim_version + 1,
      claim_expires_at: null,
    };
    const result = publicRun(run, completedCleanup);
    const completedRow = await database
      .prepare(
        `UPDATE ingestion_publication_cleanup
        SET state = 'completed',
            failure_code = NULL,
            completed_at = ?,
            claim_token = NULL,
            claim_version = claim_version + 1,
            claim_expires_at = NULL
        WHERE ingestion_run_id = ?
          AND state = 'cleaning'
          AND claim_token = ?
          AND claim_version = ?
        RETURNING *`,
      )
      .bind(observedAt, runId, claimToken, claimed.claim_version)
      .first<PublicationCleanupRow>();
    if (completedRow === null) {
      if (idempotency !== undefined) {
        const replay = await replayAdministration(
          database,
          idempotency.key,
          "retry_publication_cleanup",
          idempotency.requestJson,
        );
        if (replay !== null) return replay;
      }
      const current = await requiredPublicationCleanup(database, runId);
      const operation = activeCleanupOperation(current, run, idempotency, observedAt);
      if (operation !== null) return operation;
      if (
        current.state === "completed" &&
        idempotency !== undefined &&
        current.idempotency_key === idempotency.key &&
        current.request_json === idempotency.requestJson
      ) {
        return cleanupCompletionInProgress(run, idempotency.key, observedAt);
      }
      throw new AdministrationProblem(
        409,
        "publication_cleanup_claim_changed",
        "Publication cleanup ownership changed; retry the request.",
        false,
      );
    }
    if (idempotency !== undefined) {
      await database.batch(
        idempotencyCompletionStatements(database, {
          key: idempotency.key,
          operation: "retry_publication_cleanup",
          requestJson: idempotency.requestJson,
          response: result,
          status: 200,
          createdAt: observedAt,
          claimOwner: idempotency.claimOwner,
        }),
      );
    }
    return result;
  } catch {
    if (idempotency !== undefined) {
      const replay = await replayAdministration(
        database,
        idempotency.key,
        "retry_publication_cleanup",
        idempotency.requestJson,
      );
      if (replay !== null) return replay;
    }
    await database
      .prepare(
        `UPDATE ingestion_publication_cleanup
        SET state = 'failed',
            failure_code = 'publication_cleanup_failed',
            claim_token = NULL,
            claim_version = claim_version + 1,
            claim_expires_at = NULL
        WHERE ingestion_run_id = ?
          AND state = 'cleaning'
          AND claim_token = ?
          AND claim_version = ?`,
      )
      .bind(runId, claimToken, claimed.claim_version)
      .run();
    throw new AdministrationProblem(
      500,
      "publication_cleanup_failed",
      "The abandoned Catalogue Export objects could not be removed.",
    );
  }
}

function cleanupCompletionInProgress(run: RunRow, idempotencyKey: string, observedAt: string): Record<string, unknown> {
  return {
    contract: "card-keepr-administration-operation@1",
    operation: "retry_publication_cleanup",
    status: "in_progress",
    run_id: run.id,
    idempotency_key: idempotencyKey,
    claimed_at: observedAt,
    links: {
      run: `/v1/ingestion-runs/${run.id}`,
      status: "/v1/status",
    },
  };
}

function activeCleanupOperation(
  cleanup: PublicationCleanupRow,
  run: RunRow,
  idempotency: { key: string; requestJson: string } | undefined,
  observedAt: string,
): Record<string, unknown> | null {
  if (
    cleanup.state !== "cleaning" ||
    cleanup.claim_token === null ||
    !isIsoInstant(cleanup.claim_expires_at) ||
    Date.parse(observedAt) >= Date.parse(cleanup.claim_expires_at)
  ) {
    return null;
  }
  if (idempotency !== undefined && cleanup.idempotency_key === idempotency.key) {
    if (cleanup.request_json !== idempotency.requestJson) {
      throw new AdministrationProblem(
        409,
        "idempotency_key_reused",
        "The idempotency key was already used for a different administration request.",
      );
    }
    return {
      contract: "card-keepr-administration-operation@1",
      operation: "retry_publication_cleanup",
      status: "in_progress",
      run_id: run.id,
      idempotency_key: idempotency.key,
      retry_after: cleanup.claim_expires_at,
      links: {
        run: `/v1/ingestion-runs/${run.id}`,
        status: "/v1/status",
      },
    };
  }
  throw new AdministrationProblem(
    409,
    "publication_cleanup_in_progress",
    "The abandoned Catalogue Export cleanup is already in progress.",
    cleanup.idempotency_key !== null,
  );
}

async function deleteR2KeysInBatches(bucket: R2Bucket, keys: readonly string[]): Promise<void> {
  for (let index = 0; index < keys.length; index += 1_000) {
    await bucket.delete(keys.slice(index, index + 1_000));
  }
}

export async function failUnreservedPublication(
  database: D1Database,
  run: RunRow,
  request: ApproveRunRequest,
  requestJson: string,
  terminalAt: string,
  claimOwner: IdempotencyClaimOwner,
  problem: AdministrationProblem,
): Promise<void> {
  await database.batch([
    database
      .prepare(
        `UPDATE ingestion_runs
        SET state = 'failed',
            terminal_at = ?,
            failure_code = ?,
            progress_json = json_set(
              progress_json,
              '$.current_stage',
              'failed'
            )
        WHERE id = ? AND ${ingestionRunTransitionSql("awaiting_approval", "failed")}`,
      )
      .bind(terminalAt, problem.code, run.id),
    database
      .prepare(
        `UPDATE ingestion_evidence_plans
        SET failure_code = ?
        WHERE ingestion_run_id = ?`,
      )
      .bind(problem.code, run.id),
    releaseRunLockStatement(database, run.id),
    database
      .prepare(
        `INSERT INTO administration_idempotency (
          idempotency_key,
          operation,
          request_json,
          response_json,
          http_status,
          outcome,
          created_at,
          claim_owner_token,
          claim_version
        ) VALUES (
          ?, 'approve_ingestion_run', ?, ?, ?, 'problem', ?, ?, ?
        )`,
      )
      .bind(
        request.idempotency_key,
        requestJson,
        canonicalJson({
          code: problem.code,
          detail: problem.message,
        }),
        problem.status,
        terminalAt,
        claimOwner.ownerToken,
        claimOwner.version,
      ),
    administrationClaimDeleteStatement(
      database,
      {
        key: request.idempotency_key,
        operation: "approve_ingestion_run",
        requestJson,
      },
      claimOwner,
    ),
  ]);
}

export async function failReservedPublication(
  database: D1Database,
  run: RunRow,
  objectKeys: readonly string[] | null,
  terminalAt: string,
  problem: AdministrationProblem,
): Promise<void> {
  const key = requiredPublicationValue(run.approval_idempotency_key, "idempotency key");
  if (run.candidate_digest === null || !isSha256Digest(run.candidate_digest)) {
    throw new Error("The reserved publication candidate digest is invalid.");
  }
  const requestJson = canonicalJson({
    run_id: run.id,
    candidate_digest: run.candidate_digest,
    expected_current_revision_id: run.expected_current_revision_id,
  });
  const claimOwner = await currentAdministrationClaimOwner(database, key, "approve_ingestion_run", requestJson);
  const failureStatements = [
    database
      .prepare(
        `UPDATE ingestion_runs
        SET state = 'failed',
            terminal_at = ?,
            failure_code = ?,
            progress_json = json_set(
              progress_json,
              '$.current_stage',
              'failed'
            )
        WHERE id = ? AND ${ingestionRunTransitionSql("publishing", "failed")}`,
      )
      .bind(terminalAt, problem.code, run.id),
    database
      .prepare(
        `UPDATE ingestion_evidence_plans
        SET failure_code = ?
        WHERE ingestion_run_id = ?`,
      )
      .bind(problem.code, run.id),
    releaseRunLockStatement(database, run.id),
    database
      .prepare(
        `INSERT INTO administration_idempotency (
          idempotency_key,
          operation,
          request_json,
          response_json,
          http_status,
          outcome,
          created_at,
          claim_owner_token,
          claim_version
        ) VALUES (
          ?, 'approve_ingestion_run', ?, ?, ?, 'problem', ?, ?, ?
        )`,
      )
      .bind(
        key,
        requestJson,
        canonicalJson({
          code: problem.code,
          detail: problem.message,
        }),
        problem.status,
        terminalAt,
        claimOwner?.ownerToken ?? null,
        claimOwner?.version ?? null,
      ),
    administrationClaimDeleteStatement(
      database,
      {
        key,
        operation: "approve_ingestion_run",
        requestJson,
      },
      claimOwner,
    ),
  ];
  if (objectKeys !== null) {
    failureStatements.push(
      database
        .prepare(
          `INSERT INTO ingestion_publication_cleanup (
            ingestion_run_id,
            state,
            object_keys_json,
            attempts,
            failure_code,
            last_attempt_at,
            completed_at,
            not_before,
            idempotency_key,
            request_json
          ) VALUES (?, 'pending', ?, 0, NULL, NULL, NULL, ?, NULL, NULL)
          ON CONFLICT (ingestion_run_id) DO NOTHING`,
        )
        .bind(run.id, canonicalJson([...new Set(objectKeys)].sort()), publicationCleanupNotBefore(run, terminalAt)),
    );
  }
  await database.batch(failureStatements);
}
