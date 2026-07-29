import {
  buildCatalogueExport,
  type BuiltCatalogueExport,
} from "./export";
import {
  FixtureInputError,
  fixtureCandidate,
  type FixtureCandidate,
} from "./fixture";
import { canonicalJson, sha256 } from "./serialization";

const sevenDaysInMilliseconds = 7 * 24 * 60 * 60 * 1_000;
const publicationLeaseMilliseconds = 5 * 60 * 1_000;
const terminalRunStates = new Set([
  "published",
  "rejected",
  "expired",
  "failed",
]);

type RunRow = {
  id: string;
  state: string;
  selected_games_json: string;
  started_at: string;
  expected_current_revision_id: string;
  linked_run_id: string | null;
  idempotency_key: string;
  candidate_digest: string | null;
  candidate_created_at: string | null;
  approval_deadline: string | null;
  approval_json: string | null;
  published_revision_id: string | null;
  export_manifest_digest: string | null;
  terminal_at: string | null;
  candidate_json: string;
  approval_idempotency_key: string | null;
  failure_code: string | null;
  progress_json: string;
  warnings_json: string;
  approval_history_json: string;
  publication_outcome: string | null;
  resulting_revision_id: string | null;
  freshness_checked_at: string | null;
  publication_revision_id: string | null;
  publication_started_at: string | null;
  publication_reconcile_after: string | null;
  publication_manifest_digest: string | null;
};

type CatalogueStateRow = {
  current_revision_id: string;
  published_at: string;
};

type OperationStateRow = {
  active_ingestion_run_id: string | null;
  recovery_health: string;
};

type IdempotencyRow = {
  operation: string;
  request_json: string;
  response_json: string;
  http_status: number;
  outcome: "success" | "problem";
};

type FreshnessRow = {
  game: string;
  area: string;
  checked_at: string;
  ingestion_run_id: string;
};

type PublicationCleanupRow = {
  ingestion_run_id: string;
  state: "pending" | "cleaning" | "completed" | "failed";
  object_keys_json: string;
  attempts: number;
  failure_code: string | null;
  last_attempt_at: string | null;
  completed_at: string | null;
};

type IdempotencyContext = {
  key: string;
  operation: string;
  requestJson: string;
  observedAt: string;
};

export type StartRunRequest = {
  fixture: string;
  selected_games: readonly string[];
  idempotency_key: string;
};

export type ApproveRunRequest = {
  candidate_digest: string;
  expected_current_revision_id: string;
  idempotency_key: string;
};

export type RejectRunRequest = {
  candidate_digest: string;
  idempotency_key: string;
};

export type RetryRunRequest = {
  idempotency_key: string;
};

export type RetryPublicationCleanupRequest = {
  idempotency_key: string;
};

export async function startFixtureRun(
  database: D1Database,
  catalogueExports: R2Bucket,
  request: StartRunRequest,
  observedAt = new Date().toISOString(),
): Promise<Record<string, unknown>> {
  await reconcileAbandonedPublication(
    database,
    catalogueExports,
    observedAt,
  );
  assertOpaqueId(request.idempotency_key, "idempotency_key");
  const requestJson = canonicalJson({
    fixture: request.fixture,
    selected_games: request.selected_games,
  });
  return idempotentAdministration(
    database,
    {
      key: request.idempotency_key,
      operation: "start_ingestion_run",
      requestJson,
      observedAt,
    },
    async () => {
      const candidate = await validatedFixtureCandidate(request);
      return startPreparedRun(database, {
        candidate: candidate.candidate,
        candidateDigest: candidate.digest,
        idempotencyKey: request.idempotency_key,
        idempotencyOperation: "start_ingestion_run",
        idempotencyRequestJson: requestJson,
        linkedRunId: null,
        observedAt,
      });
    },
  );
}

export async function retryRun(
  database: D1Database,
  catalogueExports: R2Bucket,
  sourceRunId: string,
  request: RetryRunRequest,
  observedAt = new Date().toISOString(),
): Promise<Record<string, unknown>> {
  await reconcileAbandonedPublication(
    database,
    catalogueExports,
    observedAt,
  );
  assertOpaqueId(sourceRunId, "run_id");
  assertOpaqueId(request.idempotency_key, "idempotency_key");
  const requestJson = canonicalJson({ source_run_id: sourceRunId });
  return idempotentAdministration(
    database,
    {
      key: request.idempotency_key,
      operation: "retry_ingestion_run",
      requestJson,
      observedAt,
    },
    async () => {
      await expireOverdueRuns(database, observedAt);
      const source = await requiredRun(database, sourceRunId);
      if (!terminalRunStates.has(source.state)) {
        throw new AdministrationProblem(
          409,
          "source_run_not_terminal",
          "Only a terminal Ingestion Run can be retried.",
        );
      }
      const candidate = parseCandidate(source);
      const candidateDigest = await sha256(
        new TextEncoder().encode(canonicalJson(candidate)),
      );
      return startPreparedRun(database, {
        candidate,
        candidateDigest,
        idempotencyKey: request.idempotency_key,
        idempotencyOperation: "retry_ingestion_run",
        idempotencyRequestJson: requestJson,
        linkedRunId: source.id,
        observedAt,
      });
    },
  );
}

export async function retryPublicationCleanup(
  database: D1Database,
  catalogueExports: R2Bucket,
  runId: string,
  request: RetryPublicationCleanupRequest,
  observedAt = new Date().toISOString(),
): Promise<Record<string, unknown>> {
  await reconcileAbandonedPublication(
    database,
    catalogueExports,
    observedAt,
  );
  assertOpaqueId(runId, "run_id");
  assertOpaqueId(request.idempotency_key, "idempotency_key");
  const requestJson = canonicalJson({ run_id: runId });
  return idempotentAdministration(
    database,
    {
      key: request.idempotency_key,
      operation: "retry_publication_cleanup",
      requestJson,
      observedAt,
    },
    async () => {
      const result = await attemptPublicationCleanup(
        database,
        catalogueExports,
        runId,
        observedAt,
        {
          key: request.idempotency_key,
          requestJson,
        },
      );
      if (result === null) {
        throw new Error(
          "Publication cleanup did not produce an administration result.",
        );
      }
      return result;
    },
  );
}

export async function showRun(
  database: D1Database,
  catalogueExports: R2Bucket,
  runId: string,
  observedAt = new Date().toISOString(),
): Promise<Record<string, unknown>> {
  await reconcileAbandonedPublication(
    database,
    catalogueExports,
    observedAt,
  );
  assertOpaqueId(runId, "run_id");
  await expireOverdueRuns(database, observedAt);
  const run = await requiredRun(database, runId);
  return publicRun(run, await publicationCleanup(database, run.id));
}

export async function administrationStatus(
  database: D1Database,
  catalogueExports: R2Bucket,
  observedAt = new Date().toISOString(),
): Promise<Record<string, unknown>> {
  await reconcileAbandonedPublication(
    database,
    catalogueExports,
    observedAt,
  );
  await expireOverdueRuns(database, observedAt);
  const [
    catalogue,
    operation,
    freshness,
    recentRuns,
    revisionCount,
    exportCount,
    publishedRevisionIds,
    exportObjects,
    cleanupRows,
  ] =
    await Promise.all([
      currentCatalogueState(database),
      currentOperationState(database),
      database
        .prepare(
          `SELECT game, area, checked_at, ingestion_run_id
          FROM source_freshness
          ORDER BY game, area`,
        )
        .all<FreshnessRow>(),
      database
        .prepare(
          `SELECT * FROM ingestion_runs
          ORDER BY started_at DESC, id DESC
          LIMIT 20`,
        )
        .all<RunRow>(),
      database
        .prepare("SELECT COUNT(*) AS count FROM catalogue_revisions")
        .first<{ count: number }>(),
      database
        .prepare("SELECT COUNT(*) AS count FROM catalogue_exports")
        .first<{ count: number }>(),
      database
        .prepare("SELECT id FROM catalogue_revisions")
        .all<{ id: string }>(),
      listAllCatalogueExportObjects(catalogueExports),
      database
        .prepare(
          `SELECT *
          FROM ingestion_publication_cleanup
          ORDER BY ingestion_run_id`,
        )
        .all<PublicationCleanupRow>(),
    ]);
  const cleanupByRun = new Map(
    cleanupRows.results.map((cleanup) => [
      cleanup.ingestion_run_id,
      cleanup,
    ]),
  );
  const active =
    operation.active_ingestion_run_id === null
      ? null
      : await requiredRun(
          database,
          operation.active_ingestion_run_id,
        );
  return {
    contract: "card-keepr-administration-status@1",
    safe_state: {
      current_revision_id: catalogue.current_revision_id,
      recovery_health: operation.recovery_health,
      active_ingestion_run_id: operation.active_ingestion_run_id,
      mutation_safe:
        operation.recovery_health === "healthy" &&
        operation.active_ingestion_run_id === null,
    },
    active_ingestion_run:
      active === null
        ? null
        : publicRun(active, cleanupByRun.get(active.id) ?? null),
    source_freshness: freshness.results,
    diagnostics: {
      catalogue_revision_count: revisionCount?.count ?? 0,
      catalogue_export_count: exportCount?.count ?? 0,
      catalogue_export_object_count: exportObjects.length,
      orphaned_catalogue_export_object_count:
        orphanedCatalogueExportObjectCount(
          exportObjects,
          publishedRevisionIds.results.map((row) => row.id),
        ),
      pending_publication_cleanup_count: cleanupRows.results.filter(
        (cleanup) =>
          cleanup.state === "pending" || cleanup.state === "failed",
      ).length,
    },
    recent_runs: recentRuns.results.map((run) =>
      publicRun(run, cleanupByRun.get(run.id) ?? null),
    ),
  };
}

export async function inspectCandidate(
  database: D1Database,
  catalogueExports: R2Bucket,
  runId: string,
  observedAt = new Date().toISOString(),
): Promise<Record<string, unknown>> {
  await reconcileAbandonedPublication(
    database,
    catalogueExports,
    observedAt,
  );
  assertOpaqueId(runId, "run_id");
  await expireOverdueRuns(database, observedAt);
  const row = await requiredRun(database, runId);
  if (row.state !== "awaiting_approval") {
    throw new AdministrationProblem(
      409,
      "candidate_not_approvable",
      "The Ingestion Run does not have a candidate awaiting approval.",
    );
  }
  const candidate = parseCandidate(row);
  const warnings = parseWarnings(row.warnings_json);
  return {
    run_id: row.id,
    candidate_digest: row.candidate_digest,
    expected_current_revision_id: row.expected_current_revision_id,
    candidate_created_at: row.candidate_created_at,
    approval_deadline: row.approval_deadline,
    progress: parseProgress(row.progress_json),
    diff: {
      summary: {
        cards_added: candidate.cards.length,
        printings_added: candidate.printings.length,
        warnings: warnings.length,
      },
      cards: {
        added: candidate.cards.map((card) => card.id),
        changed: [],
        missing_observations: [],
      },
      printings: {
        added: candidate.printings.map((printing) => printing.id),
        changed: [],
        identity_matches: [],
      },
      warnings,
    },
  };
}

export async function approveRun(
  database: D1Database,
  catalogueExports: R2Bucket,
  runId: string,
  request: ApproveRunRequest,
  observedAt = new Date().toISOString(),
): Promise<Record<string, unknown>> {
  await reconcileAbandonedPublication(
    database,
    catalogueExports,
    observedAt,
  );
  assertOpaqueId(runId, "run_id");
  assertSha256(request.candidate_digest, "candidate_digest");
  assertOpaqueId(
    request.expected_current_revision_id,
    "expected_current_revision_id",
  );
  assertOpaqueId(request.idempotency_key, "idempotency_key");
  const requestJson = canonicalJson({
    run_id: runId,
    candidate_digest: request.candidate_digest,
    expected_current_revision_id:
      request.expected_current_revision_id,
  });
  return idempotentAdministration(
    database,
    {
      key: request.idempotency_key,
      operation: "approve_ingestion_run",
      requestJson,
      observedAt,
    },
    () =>
      approveRunAttempt(
        database,
        catalogueExports,
        runId,
        request,
        requestJson,
        observedAt,
      ),
  );
}

async function approveRunAttempt(
  database: D1Database,
  catalogueExports: R2Bucket,
  runId: string,
  request: ApproveRunRequest,
  requestJson: string,
  now: string,
): Promise<Record<string, unknown>> {
  await expireOverdueRuns(database, now);
  const run = await requiredRun(database, runId);
  if (run.state === "publishing") {
    throw new AdministrationProblem(
      409,
      "publication_in_progress",
      "The Ingestion Run already has a publication in progress.",
      run.approval_idempotency_key !== request.idempotency_key,
    );
  }
  assertRunIsApprovable(run, request);
  const [catalogueState, operationState] = await Promise.all([
    currentCatalogueState(database),
    currentOperationState(database),
  ]);
  if (
    catalogueState.current_revision_id !==
      request.expected_current_revision_id ||
    run.expected_current_revision_id !==
      request.expected_current_revision_id
  ) {
    throw new AdministrationProblem(
      409,
      "current_revision_mismatch",
      "The current Catalogue Revision no longer matches the requested approval.",
    );
  }
  if (operationState.active_ingestion_run_id !== run.id) {
    throw new AdministrationProblem(
      409,
      "run_not_active",
      "The active Ingestion Run identity no longer matches.",
    );
  }
  if (operationState.recovery_health !== "healthy") {
    throw new AdministrationProblem(
      409,
      "recovery_not_verified",
      "Recovery is not healthy, so publication is blocked.",
    );
  }

  const approval = {
    action: "approved",
    approved_at: now,
    candidate_digest: request.candidate_digest,
    expected_current_revision_id:
      request.expected_current_revision_id,
  };
  const currentRevision = await database
    .prepare(
      `SELECT content_digest
      FROM catalogue_revisions
      WHERE id = ?`,
    )
    .bind(catalogueState.current_revision_id)
    .first<{ content_digest: string }>();
  if (currentRevision?.content_digest === request.candidate_digest) {
    return publishNoChange(database, run, request, requestJson, approval, now);
  }

  const candidate = parseCandidate(run);
  const revisionId = `catrev_${crypto.randomUUID()}`;
  const catalogueExport = await buildCatalogueExport(
    candidate,
    request.candidate_digest,
    revisionId,
    now,
  );
  try {
    await reservePublication(
      database,
      run.id,
      approval,
      request.idempotency_key,
      revisionId,
      catalogueExport.manifest.manifest_sha256,
      now,
    );
  } catch (error) {
    const reserved = await requiredRun(database, run.id);
    if (reserved.state === "publishing") {
      throw new AdministrationProblem(
        409,
        "publication_in_progress",
        "The Ingestion Run already has a publication in progress.",
        reserved.approval_idempotency_key !==
          request.idempotency_key,
      );
    }
    await throwApprovalFailure(database, run, error, now);
  }
  try {
    await storeAndVerifyExport(catalogueExports, catalogueExport.objects);
    return await commitVerifiedPublication(database, {
      run: await requiredRun(database, run.id),
      candidate,
      catalogueExport,
      requestJson,
      completedAt: now,
    });
  } catch (error) {
    const concurrentReplay = await replayAfterConflict(
      database,
      request.idempotency_key,
      "approve_ingestion_run",
      requestJson,
      error,
    );
    if (concurrentReplay !== null) return concurrentReplay;
    const problem = publicationFailureProblem(error);
    await failReservedPublication(
      database,
      await requiredRun(database, run.id),
      catalogueExport.objects.map((object) => object.key),
      now,
      problem,
    );
    try {
      await attemptPublicationCleanup(
        database,
        catalogueExports,
        run.id,
        now,
      );
    } catch {
      // Cleanup is durable and independently retryable. The terminal
      // publication outcome must remain the original problem.
    }
    throw problem;
  }
}

export async function rejectRun(
  database: D1Database,
  catalogueExports: R2Bucket,
  runId: string,
  request: RejectRunRequest,
  observedAt = new Date().toISOString(),
): Promise<Record<string, unknown>> {
  await reconcileAbandonedPublication(
    database,
    catalogueExports,
    observedAt,
  );
  assertOpaqueId(runId, "run_id");
  assertSha256(request.candidate_digest, "candidate_digest");
  assertOpaqueId(request.idempotency_key, "idempotency_key");
  const requestJson = canonicalJson({
    run_id: runId,
    candidate_digest: request.candidate_digest,
  });
  return idempotentAdministration(
    database,
    {
      key: request.idempotency_key,
      operation: "reject_ingestion_run",
      requestJson,
      observedAt,
    },
    () =>
      rejectRunAttempt(
        database,
        runId,
        request,
        requestJson,
        observedAt,
      ),
  );
}

async function rejectRunAttempt(
  database: D1Database,
  runId: string,
  request: RejectRunRequest,
  requestJson: string,
  now: string,
): Promise<Record<string, unknown>> {
  await expireOverdueRuns(database, now);
  const run = await requiredRun(database, runId);
  if (run.state === "expired") {
    throw new AdministrationProblem(
      409,
      "candidate_expired",
      "The candidate approval deadline has passed.",
    );
  }
  if (run.state !== "awaiting_approval") {
    throw new AdministrationProblem(
      409,
      "run_not_awaiting_approval",
      "The Ingestion Run is not awaiting approval.",
    );
  }
  if (run.candidate_digest !== request.candidate_digest) {
    throw new AdministrationProblem(
      409,
      "candidate_digest_mismatch",
      "The candidate digest no longer matches the requested rejection.",
    );
  }
  const decision = {
    action: "rejected",
    rejected_at: now,
    candidate_digest: request.candidate_digest,
  };
  const rejectedProgress = terminalProgress(run, "rejected");
  const resultingRun = publicRun({
    ...run,
    state: "rejected",
    terminal_at: now,
    progress_json: JSON.stringify(rejectedProgress),
    approval_history_json: JSON.stringify([decision]),
  });
  try {
    await database.batch([
      database
        .prepare(
          `UPDATE ingestion_runs
          SET state = 'rejected',
              terminal_at = ?,
              progress_json = ?,
              approval_history_json = ?
          WHERE id = ? AND state = 'awaiting_approval'`,
        )
        .bind(
          now,
          JSON.stringify(rejectedProgress),
          JSON.stringify([decision]),
          run.id,
        ),
      releaseRunLockStatement(database, run.id),
      idempotencyInsertStatement(database, {
        key: request.idempotency_key,
        operation: "reject_ingestion_run",
        requestJson,
        response: resultingRun,
        status: 200,
        createdAt: now,
      }),
    ]);
  } catch (error) {
    const concurrentReplay = await replayAfterConflict(
      database,
      request.idempotency_key,
      "reject_ingestion_run",
      requestJson,
      error,
    );
    if (concurrentReplay !== null) return concurrentReplay;
    if (errorMessage(error).includes("run_not_active")) {
      throw new AdministrationProblem(
        409,
        "run_not_active",
        "The active Ingestion Run identity no longer matches.",
      );
    }
    throw error;
  }
  return resultingRun;
}

export class AdministrationProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly persistOutcome = true,
  ) {
    super(message);
  }
}

async function startPreparedRun(
  database: D1Database,
  input: {
    candidate: FixtureCandidate;
    candidateDigest: string;
    idempotencyKey: string;
    idempotencyOperation: string;
    idempotencyRequestJson: string;
    linkedRunId: string | null;
    observedAt: string;
  },
): Promise<Record<string, unknown>> {
  await expireOverdueRuns(database, input.observedAt);
  const [catalogueState, operationState] = await Promise.all([
    currentCatalogueState(database),
    currentOperationState(database),
  ]);
  if (operationState.active_ingestion_run_id !== null) {
    throw new AdministrationProblem(
      409,
      "active_ingestion_run",
      "Another Ingestion Run is already active.",
    );
  }
  if (operationState.recovery_health === "blocked") {
    throw new AdministrationProblem(
      409,
      "recovery_in_progress",
      "Recovery blocks new Ingestion Runs.",
    );
  }

  const startedAt = input.observedAt;
  const approvalDeadline = new Date(
    Date.parse(startedAt) + sevenDaysInMilliseconds,
  ).toISOString();
  const runId = `run_${crypto.randomUUID()}`;
  const candidateJson = canonicalJson(input.candidate);
  const resultingRun = publicRun({
    id: runId,
    state: "awaiting_approval",
    selected_games_json: JSON.stringify(input.candidate.selected_games),
    started_at: startedAt,
    expected_current_revision_id: catalogueState.current_revision_id,
    linked_run_id: input.linkedRunId,
    idempotency_key: input.idempotencyKey,
    candidate_digest: input.candidateDigest,
    candidate_created_at: startedAt,
    approval_deadline: approvalDeadline,
    approval_json: null,
    published_revision_id: null,
    export_manifest_digest: null,
    terminal_at: null,
    candidate_json: candidateJson,
    approval_idempotency_key: null,
    failure_code: null,
    progress_json: JSON.stringify(progressFor("awaiting_approval")),
    warnings_json: "[]",
    approval_history_json: "[]",
    publication_outcome: null,
    resulting_revision_id: null,
    freshness_checked_at: null,
    publication_revision_id: null,
    publication_started_at: null,
    publication_reconcile_after: null,
    publication_manifest_digest: null,
  });

  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO ingestion_runs (
            id,
            state,
            selected_games_json,
            started_at,
            expected_current_revision_id,
            linked_run_id,
            idempotency_key,
            candidate_digest,
            candidate_created_at,
            approval_deadline,
            approval_json,
            published_revision_id,
            export_manifest_digest,
            terminal_at,
            candidate_json,
            approval_idempotency_key,
            failure_code,
            progress_json,
            warnings_json,
            approval_history_json,
            publication_outcome,
            resulting_revision_id,
            freshness_checked_at
          ) VALUES (
            ?, 'planning', ?, ?, ?, ?, ?,
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL,
            NULL, ?, '[]', '[]', NULL, NULL, NULL
          )`,
        )
        .bind(
          runId,
          JSON.stringify(input.candidate.selected_games),
          startedAt,
          catalogueState.current_revision_id,
          input.linkedRunId,
          input.idempotencyKey,
          candidateJson,
          JSON.stringify(progressFor("planning")),
        ),
      database
        .prepare(
          `UPDATE operation_state
          SET active_ingestion_run_id = ?
          WHERE singleton = 1
            AND active_ingestion_run_id IS NULL
            AND recovery_health <> 'blocked'`,
        )
        .bind(runId),
      transitionStatement(database, runId, "planning", "collecting"),
      transitionStatement(database, runId, "collecting", "parsing"),
      transitionStatement(database, runId, "parsing", "reconciling"),
      database
        .prepare(
          `UPDATE ingestion_runs
          SET state = 'awaiting_approval',
              candidate_digest = ?,
              candidate_created_at = ?,
              approval_deadline = ?,
              progress_json = ?
          WHERE id = ? AND state = 'reconciling'`,
        )
        .bind(
          input.candidateDigest,
          startedAt,
          approvalDeadline,
          JSON.stringify(progressFor("awaiting_approval")),
          runId,
        ),
      idempotencyInsertStatement(database, {
        key: input.idempotencyKey,
        operation: input.idempotencyOperation,
        requestJson: input.idempotencyRequestJson,
        response: resultingRun,
        status: 201,
        createdAt: startedAt,
      }),
    ]);
  } catch (error) {
    const concurrentReplay = await replayAfterConflict(
      database,
      input.idempotencyKey,
      input.idempotencyOperation,
      input.idempotencyRequestJson,
      error,
    );
    if (concurrentReplay !== null) return concurrentReplay;
    if (
      errorMessage(error).includes("active_ingestion_run") ||
      errorMessage(error).includes("run_not_active")
    ) {
      throw new AdministrationProblem(
        409,
        "active_ingestion_run",
        "Another Ingestion Run is already active.",
      );
    }
    if (errorMessage(error).includes("recovery_in_progress")) {
      throw new AdministrationProblem(
        409,
        "recovery_in_progress",
        "Recovery blocks new Ingestion Runs.",
      );
    }
    throw error;
  }
  return resultingRun;
}

async function publishNoChange(
  database: D1Database,
  run: RunRow,
  request: ApproveRunRequest,
  requestJson: string,
  approval: Record<string, unknown>,
  now: string,
): Promise<Record<string, unknown>> {
  const resultingRun = publicRun({
    ...run,
    state: "published",
    approval_json: JSON.stringify(approval),
    approval_idempotency_key: request.idempotency_key,
    approval_history_json: JSON.stringify([approval]),
    terminal_at: now,
    progress_json: JSON.stringify(progressFor("published")),
    publication_outcome: "no_change",
    resulting_revision_id: request.expected_current_revision_id,
    freshness_checked_at: now,
  });
  const candidate = parseCandidate(run);
  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO ingestion_no_change_results (
            ingestion_run_id,
            catalogue_revision_id,
            candidate_digest,
            checked_at
          ) VALUES (?, ?, ?, ?)`,
        )
        .bind(
          run.id,
          request.expected_current_revision_id,
          request.candidate_digest,
          now,
        ),
      database
        .prepare(
          `UPDATE ingestion_runs
          SET state = 'publishing',
              approval_json = ?,
              approval_idempotency_key = ?,
              approval_history_json = ?,
              progress_json = ?
          WHERE id = ? AND state = 'awaiting_approval'`,
        )
        .bind(
          JSON.stringify(approval),
          request.idempotency_key,
          JSON.stringify([approval]),
          JSON.stringify(progressFor("publishing")),
          run.id,
        ),
      ...freshnessStatements(database, candidate.selected_games, run.id, now),
      database
        .prepare(
          `UPDATE ingestion_runs
          SET state = 'published',
              terminal_at = ?,
              progress_json = ?,
              publication_outcome = 'no_change',
              resulting_revision_id = ?,
              freshness_checked_at = ?
          WHERE id = ? AND state = 'publishing'`,
        )
        .bind(
          now,
          JSON.stringify(progressFor("published")),
          request.expected_current_revision_id,
          now,
          run.id,
        ),
      releaseRunLockStatement(database, run.id),
      idempotencyInsertStatement(database, {
        key: request.idempotency_key,
        operation: "approve_ingestion_run",
        requestJson,
        response: resultingRun,
        status: 200,
        createdAt: now,
      }),
    ]);
  } catch (error) {
    const concurrentReplay = await replayAfterConflict(
      database,
      request.idempotency_key,
      "approve_ingestion_run",
      requestJson,
      error,
    );
    if (concurrentReplay !== null) return concurrentReplay;
    await throwApprovalFailure(database, run, error, now);
  }
  return resultingRun;
}

function assertRunIsApprovable(
  run: RunRow,
  request: ApproveRunRequest,
): void {
  if (run.state === "expired") {
    throw new AdministrationProblem(
      409,
      "candidate_expired",
      "The candidate approval deadline has passed.",
    );
  }
  if (run.state !== "awaiting_approval") {
    throw new AdministrationProblem(
      409,
      "run_not_awaiting_approval",
      "The Ingestion Run is not awaiting approval.",
    );
  }
  if (run.candidate_digest !== request.candidate_digest) {
    throw new AdministrationProblem(
      409,
      "candidate_digest_mismatch",
      "The candidate digest no longer matches the requested approval.",
    );
  }
}

async function throwApprovalFailure(
  database: D1Database,
  run: RunRow,
  error: unknown,
  now: string,
): Promise<never> {
  const message = errorMessage(error);
  await expireOverdueRuns(database, now);
  const guardedRun = await requiredRun(database, run.id);
  if (guardedRun.state === "expired") {
    throw new AdministrationProblem(
      409,
      "candidate_expired",
      "The candidate approval deadline has passed.",
    );
  }
  if (message.includes("run_not_active")) {
    throw new AdministrationProblem(
      409,
      "run_not_active",
      "The active Ingestion Run identity no longer matches.",
    );
  }
  if (
    message.includes("publication_guard_failed") ||
    message.includes("approval_guard_failed") ||
    message.includes("no_change_guard_failed")
  ) {
    const [catalogue, operation] = await Promise.all([
      currentCatalogueState(database),
      currentOperationState(database),
    ]);
    if (
      catalogue.current_revision_id !==
      run.expected_current_revision_id
    ) {
      throw new AdministrationProblem(
        409,
        "current_revision_mismatch",
        "The current Catalogue Revision no longer matches the requested approval.",
      );
    }
    if (operation.active_ingestion_run_id !== run.id) {
      throw new AdministrationProblem(
        409,
        "run_not_active",
        "The active Ingestion Run identity no longer matches.",
      );
    }
    if (operation.recovery_health !== "healthy") {
      throw new AdministrationProblem(
        409,
        "recovery_not_verified",
        "Recovery is not healthy, so publication is blocked.",
      );
    }
    throw new AdministrationProblem(
      409,
      "publication_precondition_failed",
      "The publication guards changed before the approval could commit.",
    );
  }
  await failRun(database, run.id, now, "export_verification_failed");
  throw new AdministrationProblem(
    500,
    "export_verification_failed",
    "The Catalogue Export could not be verified, so no revision was published.",
  );
}

function catalogueCard(candidate: FixtureCandidate, revisionId: string) {
  const card = candidate.cards[0];
  return {
    type: "card",
    ...card,
    printing_ids: candidate.printings.map((printing) => printing.id),
    lifecycle: lifecycle(revisionId),
    links: {
      self: `/v1/cards/${card.id}`,
    },
  };
}

function cataloguePrinting(
  candidate: FixtureCandidate,
  revisionId: string,
) {
  const printing = candidate.printings[0];
  return {
    type: "printing",
    ...printing,
    printing_images: [],
    distribution_contexts: [],
    lifecycle: lifecycle(revisionId),
    links: {
      self: `/v1/printings/${printing.id}`,
    },
  };
}

function lifecycle(revisionId: string) {
  return {
    first_revision_id: revisionId,
    last_observed_revision_id: revisionId,
    withdrawn: false,
  };
}

async function reservePublication(
  database: D1Database,
  runId: string,
  approval: Record<string, unknown>,
  idempotencyKey: string,
  revisionId: string,
  manifestDigest: string,
  startedAt: string,
): Promise<void> {
  const reconcileAfter = new Date(
    Date.parse(startedAt) + publicationLeaseMilliseconds,
  ).toISOString();
  const reserved = await database
    .prepare(
      `UPDATE ingestion_runs
      SET state = 'publishing',
          approval_json = ?,
          approval_idempotency_key = ?,
          approval_history_json = ?,
          progress_json = ?,
          publication_revision_id = ?,
          publication_started_at = ?,
          publication_reconcile_after = ?,
          publication_manifest_digest = ?
      WHERE id = ? AND state = 'awaiting_approval'
      RETURNING id`,
    )
    .bind(
      JSON.stringify(approval),
      idempotencyKey,
      JSON.stringify([approval]),
      JSON.stringify(progressFor("publishing")),
      revisionId,
      startedAt,
      reconcileAfter,
      manifestDigest,
      runId,
    )
    .first<{ id: string }>();
  if (reserved === null) {
    throw new AdministrationProblem(
      409,
      "publication_precondition_failed",
      "The Ingestion Run could not reserve publication.",
    );
  }
}

async function storeAndVerifyExport(
  bucket: R2Bucket,
  objects: readonly {
    key: string;
    bytes: Uint8Array;
    contentType: string;
    contentEncoding?: string;
  }[],
): Promise<void> {
  for (const object of objects) {
    const expectedDigest = await sha256(object.bytes);
    const existing = await bucket.get(object.key);
    if (existing !== null) {
      if (existing.size !== object.bytes.byteLength) {
        throw new Error("Immutable Catalogue Export object changed");
      }
      const existingDigest = await sha256(await existing.arrayBuffer());
      if (existingDigest !== expectedDigest) {
        throw new Error("Immutable Catalogue Export object changed");
      }
      continue;
    }
    await bucket.put(object.key, object.bytes, {
      httpMetadata: {
        contentType: object.contentType,
        ...(object.contentEncoding === undefined
          ? {}
          : { contentEncoding: object.contentEncoding }),
        cacheControl: "private, max-age=31536000, immutable",
      },
    });
    const stored = await bucket.get(object.key);
    if (
      stored === null ||
      stored.size !== object.bytes.byteLength ||
      (await sha256(await stored.arrayBuffer())) !== expectedDigest
    ) {
      throw new Error("Catalogue Export object verification failed");
    }
  }
}

async function commitVerifiedPublication(
  database: D1Database,
  input: {
    run: RunRow;
    candidate: FixtureCandidate;
    catalogueExport: BuiltCatalogueExport;
    requestJson: string;
    completedAt: string;
  },
): Promise<Record<string, unknown>> {
  const revisionId = requiredPublicationValue(
    input.run.publication_revision_id,
    "revision ID",
  );
  const publishedAt = requiredPublicationValue(
    input.run.publication_started_at,
    "start time",
  );
  const idempotencyKey = requiredPublicationValue(
    input.run.approval_idempotency_key,
    "idempotency key",
  );
  const manifestDigest = requiredPublicationValue(
    input.run.publication_manifest_digest,
    "manifest digest",
  );
  if (
    input.catalogueExport.manifest.manifest_sha256 !== manifestDigest ||
    input.catalogueExport.manifestKey !==
      `catalogue-exports/${revisionId}/manifest.json`
  ) {
    throw new Error("Reserved Catalogue Export identity changed");
  }
  const resultingRun = publicRun({
    ...input.run,
    state: "published",
    published_revision_id: revisionId,
    export_manifest_digest: manifestDigest,
    terminal_at: input.completedAt,
    progress_json: JSON.stringify(progressFor("published")),
    publication_outcome: "revision",
    resulting_revision_id: revisionId,
    freshness_checked_at: input.completedAt,
  });
  const cardDocument = catalogueCard(input.candidate, revisionId);
  const printingDocument = cataloguePrinting(
    input.candidate,
    revisionId,
  );
  await database.batch([
    database
      .prepare(
        `INSERT INTO catalogue_revisions (
          id,
          ingestion_run_id,
          published_at,
          content_digest,
          expected_previous_revision_id,
          approved_candidate_digest
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        revisionId,
        input.run.id,
        publishedAt,
        input.run.candidate_digest,
        input.run.expected_current_revision_id,
        input.run.candidate_digest,
      ),
    database
      .prepare(
        `INSERT INTO revision_cards (
          catalogue_revision_id,
          card_id,
          document_json
        ) VALUES (?, ?, ?)`,
      )
      .bind(
        revisionId,
        input.candidate.cards[0].id,
        JSON.stringify(cardDocument),
      ),
    database
      .prepare(
        `INSERT INTO revision_printings (
          catalogue_revision_id,
          printing_id,
          card_id,
          document_json
        ) VALUES (?, ?, ?, ?)`,
      )
      .bind(
        revisionId,
        input.candidate.printings[0].id,
        input.candidate.printings[0].card_id,
        JSON.stringify(printingDocument),
      ),
    database
      .prepare(
        `INSERT INTO catalogue_exports (
          catalogue_revision_id,
          manifest_key,
          manifest_digest,
          verified
        ) VALUES (?, ?, ?, 1)`,
      )
      .bind(revisionId, input.catalogueExport.manifestKey, manifestDigest),
    database
      .prepare(
        `UPDATE catalogue_state
        SET current_revision_id = ?, published_at = ?
        WHERE singleton = 1
          AND current_revision_id = ?`,
      )
      .bind(
        revisionId,
        publishedAt,
        input.run.expected_current_revision_id,
      ),
    ...freshnessStatements(
      database,
      input.candidate.selected_games,
      input.run.id,
      input.completedAt,
    ),
    database
      .prepare(
        `UPDATE ingestion_runs
        SET state = 'published',
            published_revision_id = ?,
            export_manifest_digest = ?,
            terminal_at = ?,
            progress_json = ?,
            publication_outcome = 'revision',
            resulting_revision_id = ?,
            freshness_checked_at = ?
        WHERE id = ? AND state = 'publishing'`,
      )
      .bind(
        revisionId,
        manifestDigest,
        input.completedAt,
        JSON.stringify(progressFor("published")),
        revisionId,
        input.completedAt,
        input.run.id,
      ),
    releaseRunLockStatement(database, input.run.id),
    idempotencyInsertStatement(database, {
      key: idempotencyKey,
      operation: "approve_ingestion_run",
      requestJson: input.requestJson,
      response: resultingRun,
      status: 200,
      createdAt: input.completedAt,
    }),
  ]);
  return resultingRun;
}

async function reconcileAbandonedPublication(
  database: D1Database,
  bucket: R2Bucket,
  observedAt: string,
): Promise<void> {
  const run = await database
    .prepare(
      `SELECT *
      FROM ingestion_runs
      WHERE state = 'publishing'
        AND publication_reconcile_after IS NOT NULL
        AND publication_reconcile_after <= ?
      ORDER BY publication_reconcile_after, id
      LIMIT 1`,
    )
    .bind(observedAt)
    .first<RunRow>();
  if (run === null) return;
  try {
    await reconcileReservedPublication(
      database,
      bucket,
      run,
      observedAt,
    );
  } catch (error) {
    const revisionId = run.publication_revision_id;
    const objectKeys =
      revisionId !== null &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(revisionId)
        ? await listCatalogueExportPrefix(bucket, revisionId)
        : [];
    await failReservedPublication(
      database,
      run,
      objectKeys,
      observedAt,
      error instanceof AdministrationProblem
        ? error
        : errorMessage(error).includes("publication_guard_failed")
          ? new AdministrationProblem(
              409,
              "publication_precondition_failed",
              "The publication guards changed while the reserved publication was interrupted.",
            )
          : new AdministrationProblem(
              500,
              "publication_abandoned",
              "The reserved publication could not be safely reconciled.",
            ),
    );
  }
}

async function reconcileReservedPublication(
  database: D1Database,
  bucket: R2Bucket,
  run: RunRow,
  observedAt: string,
): Promise<void> {
  const candidate = parseCandidate(run);
  const approval = parseApproval(run.approval_json);
  const revisionId = requiredPublicationValue(
    run.publication_revision_id,
    "revision ID",
  );
  const publishedAt = requiredPublicationValue(
    run.publication_started_at,
    "start time",
  );
  const manifestDigest = requiredPublicationValue(
    run.publication_manifest_digest,
    "manifest digest",
  );
  requiredPublicationValue(
    run.approval_idempotency_key,
    "idempotency key",
  );
  if (
    approval.candidate_digest !== run.candidate_digest ||
    approval.expected_current_revision_id !==
      run.expected_current_revision_id ||
    approval.approved_at !== publishedAt ||
    !isIsoInstant(publishedAt) ||
    !/^[a-f0-9]{64}$/.test(manifestDigest) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(revisionId) ||
    !isExactStringTuple(
      JSON.parse(run.selected_games_json),
      candidate.selected_games,
    ) ||
    (await sha256(
      new TextEncoder().encode(canonicalJson(candidate)),
    )) !== run.candidate_digest
  ) {
    throw new Error("The reserved publication metadata is invalid.");
  }
  const requestJson = canonicalJson({
    run_id: run.id,
    candidate_digest: approval.candidate_digest,
    expected_current_revision_id:
      approval.expected_current_revision_id,
  });
  const catalogueExport = await buildCatalogueExport(
    candidate,
    approval.candidate_digest,
    revisionId,
    publishedAt,
  );
  const exactExport =
    catalogueExport.manifest.manifest_sha256 === manifestDigest &&
    (await isExactVerifiedExport(bucket, revisionId, catalogueExport));
  const [catalogue, operation] = await Promise.all([
    currentCatalogueState(database),
    currentOperationState(database),
  ]);
  const guardsValid =
    catalogue.current_revision_id ===
      approval.expected_current_revision_id &&
    run.expected_current_revision_id ===
      approval.expected_current_revision_id &&
    operation.active_ingestion_run_id === run.id &&
    operation.recovery_health === "healthy";
  if (exactExport && guardsValid) {
    await commitVerifiedPublication(database, {
      run,
      candidate,
      catalogueExport,
      requestJson,
      completedAt: observedAt,
    });
    return;
  }

  const problem = guardsValid
    ? new AdministrationProblem(
        500,
        "publication_abandoned",
        "The reserved publication did not contain the complete verified Catalogue Export.",
      )
    : new AdministrationProblem(
        409,
        "publication_precondition_failed",
        "The publication guards changed while the reserved publication was interrupted.",
      );
  await failReservedPublication(
    database,
    run,
    catalogueExport.objects.map((object) => object.key),
    observedAt,
    problem,
  );
}

async function listCatalogueExportPrefix(
  bucket: R2Bucket,
  revisionId: string,
): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: `catalogue-exports/${revisionId}/`,
      ...(cursor === undefined ? {} : { cursor }),
    });
    keys.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return keys;
}

async function isExactVerifiedExport(
  bucket: R2Bucket,
  revisionId: string,
  catalogueExport: BuiltCatalogueExport,
): Promise<boolean> {
  const prefix = `catalogue-exports/${revisionId}/`;
  const actualKeys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix,
      ...(cursor === undefined ? {} : { cursor }),
    });
    actualKeys.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  const expectedKeys = [
    ...new Set(catalogueExport.objects.map((object) => object.key)),
  ].sort();
  actualKeys.sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    return false;
  }
  for (const object of catalogueExport.objects) {
    const stored = await bucket.get(object.key);
    if (
      stored === null ||
      stored.size !== object.bytes.byteLength ||
      (await sha256(await stored.arrayBuffer())) !==
        (await sha256(object.bytes))
    ) {
      return false;
    }
  }
  return true;
}

function publicationFailureProblem(error: unknown): AdministrationProblem {
  if (errorMessage(error).includes("publication_guard_failed")) {
    return new AdministrationProblem(
      409,
      "publication_precondition_failed",
      "The publication guards changed after approval was reserved.",
    );
  }
  return new AdministrationProblem(
    500,
    "export_verification_failed",
    "The Catalogue Export could not be verified, so no revision was published.",
  );
}

async function failReservedPublication(
  database: D1Database,
  run: RunRow,
  objectKeys: readonly string[],
  terminalAt: string,
  problem: AdministrationProblem,
): Promise<void> {
  const key = requiredPublicationValue(
    run.approval_idempotency_key,
    "idempotency key",
  );
  if (
    run.candidate_digest === null ||
    !/^[a-f0-9]{64}$/.test(run.candidate_digest)
  ) {
    throw new Error(
      "The reserved publication candidate digest is invalid.",
    );
  }
  const requestJson = canonicalJson({
    run_id: run.id,
    candidate_digest: run.candidate_digest,
    expected_current_revision_id:
      run.expected_current_revision_id,
  });
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
        WHERE id = ? AND state = 'publishing'`,
      )
      .bind(terminalAt, problem.code, run.id),
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
          created_at
        ) VALUES (?, 'approve_ingestion_run', ?, ?, ?, 'problem', ?)`,
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
      ),
    database
      .prepare(
        `INSERT INTO ingestion_publication_cleanup (
          ingestion_run_id,
          state,
          object_keys_json,
          attempts,
          failure_code,
          last_attempt_at,
          completed_at
        ) VALUES (?, 'pending', ?, 0, NULL, NULL, NULL)
        ON CONFLICT (ingestion_run_id) DO NOTHING`,
      )
      .bind(run.id, canonicalJson([...new Set(objectKeys)].sort())),
  ]);
}

async function attemptPublicationCleanup(
  database: D1Database,
  bucket: R2Bucket,
  runId: string,
  observedAt: string,
  idempotency?: {
    key: string;
    requestJson: string;
  },
): Promise<Record<string, unknown> | null> {
  const cleanup = await database
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
  if (run.state !== "failed") {
    throw new AdministrationProblem(
      409,
      "publication_cleanup_not_terminal",
      "Publication cleanup is only available for a failed Ingestion Run.",
    );
  }
  if (cleanup.state === "completed") {
    throw new AdministrationProblem(
      409,
      "publication_cleanup_not_required",
      "The abandoned Catalogue Export objects have already been removed.",
    );
  }
  if (cleanup.state === "cleaning") {
    const retryAfter =
      cleanup.last_attempt_at === null
        ? Number.NEGATIVE_INFINITY
        : Date.parse(cleanup.last_attempt_at) +
          publicationLeaseMilliseconds;
    if (Date.parse(observedAt) < retryAfter) {
      throw new AdministrationProblem(
        409,
        "publication_cleanup_in_progress",
        "The abandoned Catalogue Export cleanup is already in progress.",
      );
    }
  }
  const keys = parseCleanupKeys(cleanup.object_keys_json, run);
  await database
    .prepare(
      `UPDATE ingestion_publication_cleanup
      SET state = 'cleaning',
          attempts = attempts + 1,
          failure_code = NULL,
          last_attempt_at = ?
      WHERE ingestion_run_id = ?
        AND state IN ('pending', 'failed', 'cleaning')`,
    )
    .bind(observedAt, runId)
    .run();
  try {
    if (keys.length > 0) await bucket.delete(keys);
    for (const key of keys) {
      if ((await bucket.get(key)) !== null) {
        throw new Error("Catalogue Export cleanup verification failed");
      }
    }
    const completedCleanup: PublicationCleanupRow = {
      ...cleanup,
      state: "completed",
      attempts: cleanup.attempts + 1,
      failure_code: null,
      last_attempt_at: observedAt,
      completed_at: observedAt,
    };
    const result = publicRun(run, completedCleanup);
    await database.batch([
      database.prepare(
        `UPDATE ingestion_publication_cleanup
        SET state = 'completed',
            failure_code = NULL,
            completed_at = ?
        WHERE ingestion_run_id = ? AND state = 'cleaning'`,
      ).bind(observedAt, runId),
      ...(idempotency === undefined
        ? []
        : [
            idempotencyInsertStatement(database, {
              key: idempotency.key,
              operation: "retry_publication_cleanup",
              requestJson: idempotency.requestJson,
              response: result,
              status: 200,
              createdAt: observedAt,
            }),
          ]),
    ]);
    return result;
  } catch {
    await database
      .prepare(
        `UPDATE ingestion_publication_cleanup
        SET state = 'failed',
            failure_code = 'publication_cleanup_failed'
        WHERE ingestion_run_id = ? AND state = 'cleaning'`,
      )
      .bind(runId)
      .run();
    throw new AdministrationProblem(
      500,
      "publication_cleanup_failed",
      "The abandoned Catalogue Export objects could not be removed.",
    );
  }
}

function requiredPublicationValue(
  value: string | null,
  description: string,
): string {
  if (value === null || value.length === 0) {
    throw new Error(`The reserved publication ${description} is invalid.`);
  }
  return value;
}

async function validatedFixtureCandidate(
  request: StartRunRequest,
): Promise<{ candidate: FixtureCandidate; digest: string }> {
  return fixtureCandidate(
    request.fixture,
    request.selected_games,
  ).catch((error: unknown) => {
    if (error instanceof FixtureInputError) {
      throw new AdministrationProblem(422, error.code, error.message);
    }
    throw error;
  });
}

async function currentCatalogueState(
  database: D1Database,
): Promise<CatalogueStateRow> {
  const state = await database
    .prepare(
      `SELECT current_revision_id, published_at
      FROM catalogue_state
      WHERE singleton = 1`,
    )
    .first<CatalogueStateRow>();
  if (state === null) {
    throw new Error("Catalogue state is unavailable");
  }
  return state;
}

async function listAllCatalogueExportObjects(
  bucket: R2Bucket,
): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: "catalogue-exports/",
      ...(cursor === undefined ? {} : { cursor }),
    });
    keys.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return keys;
}

function orphanedCatalogueExportObjectCount(
  keys: readonly string[],
  publishedRevisionIds: readonly string[],
): number {
  const published = new Set(publishedRevisionIds);
  return keys.filter((key) => {
    const [, revisionId] = key.split("/", 3);
    return revisionId === undefined || !published.has(revisionId);
  }).length;
}

async function currentOperationState(
  database: D1Database,
): Promise<OperationStateRow> {
  const state = await database
    .prepare(
      `SELECT active_ingestion_run_id, recovery_health
      FROM operation_state
      WHERE singleton = 1`,
    )
    .first<OperationStateRow>();
  if (state === null) {
    throw new Error("Operation state is unavailable");
  }
  return state;
}

async function requiredRun(
  database: D1Database,
  runId: string,
): Promise<RunRow> {
  const run = await database
    .prepare("SELECT * FROM ingestion_runs WHERE id = ?")
    .bind(runId)
    .first<RunRow>();
  if (run === null) {
    throw new AdministrationProblem(
      404,
      "ingestion_run_not_found",
      "The requested Ingestion Run does not exist.",
    );
  }
  return run;
}

async function publicationCleanup(
  database: D1Database,
  runId: string,
): Promise<PublicationCleanupRow | null> {
  return database
    .prepare(
      `SELECT *
      FROM ingestion_publication_cleanup
      WHERE ingestion_run_id = ?`,
    )
    .bind(runId)
    .first<PublicationCleanupRow>();
}

async function replayAdministration(
  database: D1Database,
  key: string,
  operation: string,
  requestJson: string,
): Promise<Record<string, unknown> | null> {
  const prior = await database
    .prepare(
      `SELECT
        operation,
        request_json,
        response_json,
        http_status,
        outcome
      FROM administration_idempotency
      WHERE idempotency_key = ?`,
    )
    .bind(key)
    .first<IdempotencyRow>();
  if (prior === null) {
    return replayLegacyAdministration(
      database,
      key,
      operation,
      requestJson,
    );
  }
  if (
    prior.operation !== operation ||
    prior.request_json !== requestJson
  ) {
    throw new AdministrationProblem(
      409,
      "idempotency_key_reused",
      "The idempotency key was already used for a different administration request.",
    );
  }
  const persisted = parsePersistedObject(
    prior.response_json,
    "Administration idempotency outcome",
  );
  if (prior.outcome === "problem") {
    if (
      typeof persisted.code !== "string" ||
      typeof persisted.detail !== "string" ||
      !Number.isInteger(prior.http_status) ||
      prior.http_status < 400 ||
      prior.http_status > 599
    ) {
      throw new Error(
        "The persisted administration problem outcome is invalid.",
      );
    }
    throw new AdministrationProblem(
      prior.http_status,
      persisted.code,
      persisted.detail,
    );
  }
  if (!isPublicRunDocument(persisted)) {
    throw new Error(
      "The persisted administration success outcome is invalid.",
    );
  }
  return persisted;
}

async function idempotentAdministration(
  database: D1Database,
  context: IdempotencyContext,
  operation: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const replay = await replayAdministration(
    database,
    context.key,
    context.operation,
    context.requestJson,
  );
  if (replay !== null) return replay;
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof AdministrationProblem)) throw error;
    if (!error.persistOutcome) throw error;
    try {
      await database
        .prepare(
          `INSERT INTO administration_idempotency (
            idempotency_key,
            operation,
            request_json,
            response_json,
            http_status,
            outcome,
            created_at
          ) VALUES (?, ?, ?, ?, ?, 'problem', ?)`,
        )
        .bind(
          context.key,
          context.operation,
          context.requestJson,
          canonicalJson({
            code: error.code,
            detail: error.message,
          }),
          error.status,
          context.observedAt,
        )
        .run();
    } catch (persistError) {
      if (
        !errorMessage(persistError).includes(
          "administration_idempotency.idempotency_key",
        )
      ) {
        throw persistError;
      }
      const concurrentReplay = await replayAdministration(
        database,
        context.key,
        context.operation,
        context.requestJson,
      );
      if (concurrentReplay !== null) return concurrentReplay;
    }
    throw error;
  }
}

async function replayLegacyAdministration(
  database: D1Database,
  key: string,
  operation: string,
  requestJson: string,
): Promise<Record<string, unknown> | null> {
  const run = await database
    .prepare(
      `SELECT *
      FROM ingestion_runs
      WHERE idempotency_key = ?
        OR approval_idempotency_key = ?
      LIMIT 1`,
    )
    .bind(key, key)
    .first<RunRow>();
  if (run === null) return null;

  if (
    operation === "start_ingestion_run" &&
    run.idempotency_key === key
  ) {
    const candidate = parseCandidate(run);
    const legacyRequestJson = canonicalJson({
      fixture: candidate.fixture,
      selected_games: candidate.selected_games,
    });
    if (legacyRequestJson === requestJson) return publicRun(run);
  }
  if (
    operation === "approve_ingestion_run" &&
    run.approval_idempotency_key === key
  ) {
    const legacyRequestJson = canonicalJson({
      run_id: run.id,
      candidate_digest: run.candidate_digest,
      expected_current_revision_id:
        run.expected_current_revision_id,
    });
    if (legacyRequestJson === requestJson) return publicRun(run);
  }
  throw new AdministrationProblem(
    409,
    "idempotency_key_reused",
    "The idempotency key was already used for a different administration request.",
  );
}

async function replayAfterConflict(
  database: D1Database,
  key: string,
  operation: string,
  requestJson: string,
  error: unknown,
): Promise<Record<string, unknown> | null> {
  if (
    !errorMessage(error).includes(
      "administration_idempotency.idempotency_key",
    ) &&
    !errorMessage(error).includes("active_ingestion_run")
  ) {
    return null;
  }
  return replayAdministration(database, key, operation, requestJson);
}

function idempotencyInsertStatement(
  database: D1Database,
  input: {
    key: string;
    operation: string;
    requestJson: string;
    response: Record<string, unknown>;
    status: number;
    createdAt: string;
  },
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO administration_idempotency (
        idempotency_key,
        operation,
        request_json,
        response_json,
        http_status,
        outcome,
        created_at
      ) VALUES (?, ?, ?, ?, ?, 'success', ?)`,
    )
    .bind(
      input.key,
      input.operation,
      input.requestJson,
      canonicalJson(input.response),
      input.status,
      input.createdAt,
    );
}

function transitionStatement(
  database: D1Database,
  runId: string,
  from: string,
  to: string,
): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE ingestion_runs
      SET state = ?, progress_json = ?
      WHERE id = ? AND state = ?`,
    )
    .bind(to, JSON.stringify(progressFor(to)), runId, from);
}

function releaseRunLockStatement(
  database: D1Database,
  runId: string,
): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE operation_state
      SET active_ingestion_run_id = NULL
      WHERE singleton = 1 AND active_ingestion_run_id = ?`,
    )
    .bind(runId);
}

function freshnessStatements(
  database: D1Database,
  games: readonly string[],
  runId: string,
  checkedAt: string,
): D1PreparedStatement[] {
  return games.map((game) =>
    database
      .prepare(
        `INSERT INTO source_freshness (
          game,
          area,
          checked_at,
          ingestion_run_id
        ) VALUES (?, 'cards-and-printings', ?, ?)
        ON CONFLICT (game, area) DO UPDATE SET
          checked_at = excluded.checked_at,
          ingestion_run_id = excluded.ingestion_run_id`,
      )
      .bind(game, checkedAt, runId),
  );
}

async function expireOverdueRuns(
  database: D1Database,
  observedAt: string,
): Promise<void> {
  await database.batch([
    database
      .prepare(
        `UPDATE ingestion_runs
        SET state = 'expired',
            terminal_at = ?,
            progress_json = json_set(
              progress_json,
              '$.current_stage',
              'expired'
            )
        WHERE state = 'awaiting_approval'
          AND approval_deadline IS NOT NULL
          AND approval_deadline <= ?`,
      )
      .bind(observedAt, observedAt),
    database.prepare(
      `UPDATE operation_state
      SET active_ingestion_run_id = NULL
      WHERE singleton = 1
        AND active_ingestion_run_id IN (
          SELECT id
          FROM ingestion_runs
          WHERE state = 'expired'
        )`,
    ),
  ]);
}

async function failRun(
  database: D1Database,
  runId: string,
  terminalAt: string,
  failureCode: string,
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
        WHERE id = ?
          AND state IN (
            'planning',
            'collecting',
            'parsing',
            'reconciling',
            'awaiting_approval',
            'publishing'
          )`,
      )
      .bind(
        terminalAt,
        failureCode,
        runId,
      ),
    releaseRunLockStatement(database, runId),
  ]);
}

function parseCandidate(row: RunRow): FixtureCandidate {
  const parsed: unknown = JSON.parse(row.candidate_json);
  if (!isFixtureCandidate(parsed)) {
    throw new Error("The persisted fixture candidate is invalid.");
  }
  return parsed;
}

function parsePersistedObject(
  value: string,
  description: string,
): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) {
    throw new Error(`${description} is not a JSON object.`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function isFixtureCandidate(
  value: unknown,
): value is FixtureCandidate {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "fixture",
      "selected_games",
      "cards",
      "printings",
    ]) ||
    value.fixture !== "first-catalogue" ||
    !Array.isArray(value.selected_games) ||
    value.selected_games.length !== 1 ||
    value.selected_games[0] !== "one-piece" ||
    !Array.isArray(value.cards) ||
    value.cards.length !== 1 ||
    !Array.isArray(value.printings) ||
    value.printings.length !== 1
  ) {
    return false;
  }
  const card = value.cards[0];
  const printing = value.printings[0];
  return (
    isRecord(card) &&
    hasOnlyKeys(card, [
      "id",
      "game",
      "official_identity",
      "name",
      "effective_rules_text",
      "game_data",
    ]) &&
    typeof card.id === "string" &&
    card.game === "one-piece" &&
    typeof card.name === "string" &&
    typeof card.effective_rules_text === "string" &&
    isRecord(card.official_identity) &&
    hasOnlyKeys(card.official_identity, ["kind", "value"]) &&
    card.official_identity.kind === "card_number" &&
    typeof card.official_identity.value === "string" &&
    isRecord(card.game_data) &&
    hasOnlyKeys(card.game_data, ["profile", "attributes"]) &&
    card.game_data.profile === "one-piece@1" &&
    isFixtureCardAttributes(card.game_data.attributes) &&
    isRecord(printing) &&
    hasOnlyKeys(printing, [
      "id",
      "card_id",
      "rarity",
      "printed_rules_text",
      "game_data",
    ]) &&
    typeof printing.id === "string" &&
    typeof printing.card_id === "string" &&
    printing.card_id === card.id &&
    typeof printing.printed_rules_text === "string" &&
    isRecord(printing.rarity) &&
    hasOnlyKeys(printing.rarity, ["normalized", "raw"]) &&
    typeof printing.rarity.normalized === "string" &&
    typeof printing.rarity.raw === "string" &&
    isRecord(printing.game_data) &&
    hasOnlyKeys(printing.game_data, ["profile", "attributes"]) &&
    printing.game_data.profile === "one-piece@1" &&
    isRecord(printing.game_data.attributes) &&
    hasOnlyKeys(printing.game_data.attributes, [
      "illustration_types",
    ]) &&
    Array.isArray(
      printing.game_data.attributes.illustration_types,
    ) &&
    printing.game_data.attributes.illustration_types.length === 0
  );
}

function isFixtureCardAttributes(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "card_type",
      "colours",
      "cost",
      "life",
      "battle_attributes",
      "power",
      "counter",
      "traits",
      "block_icons",
      "effect_text",
      "trigger_text",
    ]) &&
    value.card_type === "leader" &&
    isExactStringTuple(value.colours, ["red"]) &&
    value.cost === null &&
    typeof value.life === "number" &&
    Number.isInteger(value.life) &&
    isExactStringTuple(value.battle_attributes, ["strike"]) &&
    typeof value.power === "number" &&
    Number.isInteger(value.power) &&
    value.counter === null &&
    isExactStringTuple(value.traits, ["Straw Hat Crew"]) &&
    isExactStringTuple(value.block_icons, ["1"]) &&
    typeof value.effect_text === "string" &&
    value.trigger_text === null
  );
}

function isExactStringTuple(
  value: unknown,
  expected: readonly string[],
): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}

function parseSelectedGames(value: string): readonly ["one-piece"] {
  const parsed: unknown = JSON.parse(value);
  if (!isExactStringTuple(parsed, ["one-piece"])) {
    throw new Error("The persisted selected games are invalid.");
  }
  return ["one-piece"];
}

function parseProgress(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  const stages = new Set([
    "planning",
    "collecting",
    "parsing",
    "reconciling",
    "awaiting_approval",
    "publishing",
    "published",
    "rejected",
    "expired",
    "failed",
  ]);
  if (
    !isRecord(parsed) ||
    !hasOnlyKeys(parsed, ["completed_stages", "current_stage"]) ||
    !Array.isArray(parsed.completed_stages) ||
    parsed.completed_stages.some(
      (stage) => typeof stage !== "string" || !stages.has(stage),
    ) ||
    new Set(parsed.completed_stages).size !==
      parsed.completed_stages.length ||
    typeof parsed.current_stage !== "string" ||
    !stages.has(parsed.current_stage)
  ) {
    throw new Error("The persisted Ingestion Run progress is invalid.");
  }
  return parsed;
}

function parseWarnings(value: string): Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.some(
      (warning) =>
        !isRecord(warning) ||
        !(
          hasOnlyKeys(warning, ["code", "detail"]) ||
          hasOnlyKeys(warning, ["code", "detail", "severity"])
        ) ||
        typeof warning.code !== "string" ||
        typeof warning.detail !== "string" ||
        ("severity" in warning &&
          !["info", "warning", "error"].includes(
            String(warning.severity),
          )),
    )
  ) {
    throw new Error("The persisted Ingestion Run warnings are invalid.");
  }
  return parsed;
}

function parseApproval(value: string | null): {
  action: "approved";
  approved_at: string;
  candidate_digest: string;
  expected_current_revision_id: string;
} {
  if (value === null) {
    throw new Error("The persisted Ingestion Run approval is missing.");
  }
  const parsed: unknown = JSON.parse(value);
  if (
    !isRecord(parsed) ||
    !hasOnlyKeys(parsed, [
      "action",
      "approved_at",
      "candidate_digest",
      "expected_current_revision_id",
    ]) ||
    parsed.action !== "approved" ||
    !isIsoInstant(parsed.approved_at) ||
    typeof parsed.candidate_digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(parsed.candidate_digest) ||
    typeof parsed.expected_current_revision_id !== "string" ||
    parsed.expected_current_revision_id.length === 0
  ) {
    throw new Error("The persisted Ingestion Run approval is invalid.");
  }
  return {
    action: "approved",
    approved_at: parsed.approved_at,
    candidate_digest: parsed.candidate_digest,
    expected_current_revision_id:
      parsed.expected_current_revision_id,
  };
}

function parseApprovalHistory(
  value: string,
): Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.some((decision) => !isApprovalDecision(decision))
  ) {
    throw new Error(
      "The persisted Ingestion Run approval history is invalid.",
    );
  }
  return parsed;
}

function isApprovalDecision(value: unknown): boolean {
  if (!isRecord(value) || typeof value.candidate_digest !== "string") {
    return false;
  }
  if (value.action === "approved") {
    return (
      hasOnlyKeys(value, [
        "action",
        "approved_at",
        "candidate_digest",
        "expected_current_revision_id",
      ]) &&
      isIsoInstant(value.approved_at) &&
      /^[a-f0-9]{64}$/.test(value.candidate_digest) &&
      typeof value.expected_current_revision_id === "string" &&
      value.expected_current_revision_id.length > 0
    );
  }
  return (
    value.action === "rejected" &&
    hasOnlyKeys(value, [
      "action",
      "rejected_at",
      "candidate_digest",
    ]) &&
    isIsoInstant(value.rejected_at) &&
    /^[a-f0-9]{64}$/.test(value.candidate_digest)
  );
}

function isIsoInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

function parseCleanupKeys(
  value: string,
  run: RunRow,
): string[] {
  const parsed: unknown = JSON.parse(value);
  const revisionId = requiredPublicationValue(
    run.publication_revision_id,
    "revision ID",
  );
  const prefix = `catalogue-exports/${revisionId}/`;
  if (
    !Array.isArray(parsed) ||
    parsed.some(
      (key) =>
        typeof key !== "string" ||
        key.length <= prefix.length ||
        !key.startsWith(prefix),
    ) ||
    new Set(parsed).size !== parsed.length
  ) {
    throw new Error(
      "The persisted publication cleanup object keys are invalid.",
    );
  }
  return parsed;
}

function publicRun(
  row: RunRow,
  cleanup: PublicationCleanupRow | null = null,
): Record<string, unknown> {
  const candidate = parseCandidate(row);
  const selectedGames = parseSelectedGames(row.selected_games_json);
  const progress = parseProgress(row.progress_json);
  const approval =
    row.approval_json === null ? null : parseApproval(row.approval_json);
  const approvalHistory = parseApprovalHistory(
    row.approval_history_json,
  );
  if (
    !isExactStringTuple(selectedGames, candidate.selected_games) ||
    progress.current_stage !== row.state ||
    (approval !== null &&
      (approval.candidate_digest !== row.candidate_digest ||
        approval.expected_current_revision_id !==
          row.expected_current_revision_id)) ||
    approvalHistory.some(
      (decision) =>
        decision.candidate_digest !== row.candidate_digest,
    )
  ) {
    throw new Error(
      "The persisted Ingestion Run document is inconsistent.",
    );
  }
  return {
    id: row.id,
    state: row.state,
    selected_games: selectedGames,
    started_at: row.started_at,
    expected_current_revision_id: row.expected_current_revision_id,
    linked_run_id: row.linked_run_id,
    idempotency_key: row.idempotency_key,
    candidate_digest: row.candidate_digest,
    candidate_created_at: row.candidate_created_at,
    approval_deadline: row.approval_deadline,
    approval,
    approval_history: approvalHistory,
    progress,
    warnings: parseWarnings(row.warnings_json),
    failure_code: row.failure_code,
    publication_outcome: row.publication_outcome,
    published_revision_id: row.published_revision_id,
    resulting_revision_id: row.resulting_revision_id,
    ...(row.export_manifest_digest === null
      ? {}
      : { export_manifest_digest: row.export_manifest_digest }),
    freshness_checked_at: row.freshness_checked_at,
    terminal_at: row.terminal_at,
    publication_reservation: publicPublicationReservation(row),
    publication_cleanup: publicPublicationCleanup(cleanup),
  };
}

function publicPublicationReservation(
  row: RunRow,
): Record<string, unknown> | null {
  const values = [
    row.publication_revision_id,
    row.publication_started_at,
    row.publication_reconcile_after,
    row.publication_manifest_digest,
  ];
  if (values.every((value) => value === null)) return null;
  if (
    row.publication_revision_id === null ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(
      row.publication_revision_id,
    ) ||
    !isIsoInstant(row.publication_started_at) ||
    !isIsoInstant(row.publication_reconcile_after) ||
    Date.parse(row.publication_reconcile_after) <
      Date.parse(row.publication_started_at) ||
    row.publication_manifest_digest === null ||
    !/^[a-f0-9]{64}$/.test(row.publication_manifest_digest)
  ) {
    throw new Error("The persisted publication reservation is invalid.");
  }
  return {
    revision_id: row.publication_revision_id,
    started_at: row.publication_started_at,
    reconcile_after: row.publication_reconcile_after,
    manifest_digest: row.publication_manifest_digest,
  };
}

function publicPublicationCleanup(
  cleanup: PublicationCleanupRow | null,
): Record<string, unknown> | null {
  if (cleanup === null) return null;
  if (
    !["pending", "cleaning", "completed", "failed"].includes(
      cleanup.state,
    ) ||
    !Number.isInteger(cleanup.attempts) ||
    cleanup.attempts < 0 ||
    (cleanup.failure_code !== null &&
      typeof cleanup.failure_code !== "string") ||
    (cleanup.last_attempt_at !== null &&
      !isIsoInstant(cleanup.last_attempt_at)) ||
    (cleanup.completed_at !== null &&
      !isIsoInstant(cleanup.completed_at)) ||
    (cleanup.state === "completed" &&
      cleanup.completed_at === null)
  ) {
    throw new Error(
      "The persisted publication cleanup state is invalid.",
    );
  }
  return {
    state: cleanup.state,
    attempts: cleanup.attempts,
    failure_code: cleanup.failure_code,
    last_attempt_at: cleanup.last_attempt_at,
    completed_at: cleanup.completed_at,
  };
}

function isPublicRunDocument(
  value: Record<string, unknown>,
): boolean {
  const states = new Set([
    "planning",
    "collecting",
    "parsing",
    "reconciling",
    "awaiting_approval",
    "publishing",
    "published",
    "rejected",
    "expired",
    "failed",
  ]);
  return (
    typeof value.id === "string" &&
    typeof value.state === "string" &&
    states.has(value.state) &&
    Array.isArray(value.selected_games) &&
    isExactStringTuple(value.selected_games, ["one-piece"]) &&
    isIsoInstant(value.started_at) &&
    isPublicProgress(value.progress, value.state) &&
    Array.isArray(value.warnings) &&
    value.warnings.every(isPublicWarning) &&
    Array.isArray(value.approval_history) &&
    value.approval_history.every(isApprovalDecision) &&
    (value.approval === null ||
      (isRecord(value.approval) &&
        value.approval.action === "approved" &&
        isApprovalDecision(value.approval))) &&
    (value.failure_code === null ||
      typeof value.failure_code === "string") &&
    (value.publication_cleanup === null ||
      isPublicCleanupDocument(value.publication_cleanup))
  );
}

function isPublicProgress(value: unknown, state: string): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["completed_stages", "current_stage"]) &&
    Array.isArray(value.completed_stages) &&
    value.completed_stages.every(
      (stage) => typeof stage === "string",
    ) &&
    new Set(value.completed_stages).size ===
      value.completed_stages.length &&
    value.current_stage === state
  );
}

function isPublicWarning(value: unknown): boolean {
  return (
    isRecord(value) &&
    (hasOnlyKeys(value, ["code", "detail"]) ||
      hasOnlyKeys(value, ["code", "detail", "severity"])) &&
    typeof value.code === "string" &&
    typeof value.detail === "string" &&
    (!("severity" in value) ||
      ["info", "warning", "error"].includes(
        String(value.severity),
      ))
  );
}

function isPublicCleanupDocument(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "state",
      "attempts",
      "failure_code",
      "last_attempt_at",
      "completed_at",
    ]) &&
    typeof value.state === "string" &&
    ["pending", "cleaning", "completed", "failed"].includes(
      value.state,
    ) &&
    Number.isInteger(value.attempts) &&
    typeof value.attempts === "number" &&
    value.attempts >= 0 &&
    (value.failure_code === null ||
      typeof value.failure_code === "string") &&
    (value.last_attempt_at === null ||
      isIsoInstant(value.last_attempt_at)) &&
    (value.completed_at === null ||
      isIsoInstant(value.completed_at))
  );
}

function progressFor(state: string): Record<string, unknown> {
  const ordered = [
    "planning",
    "collecting",
    "parsing",
    "reconciling",
    "awaiting_approval",
    "publishing",
  ];
  const position = ordered.indexOf(state);
  if (position >= 0) {
    return {
      completed_stages: ordered.slice(0, position),
      current_stage: state,
    };
  }
  return {
    completed_stages: ordered,
    current_stage: state,
  };
}

function terminalProgress(
  run: RunRow,
  terminalState: "rejected" | "expired" | "failed",
): Record<string, unknown> {
  const progress = parseProgress(run.progress_json);
  return {
    ...progress,
    current_stage: terminalState,
  };
}

function assertOpaqueId(value: string, field: string): void {
  if (
    value.length < 1 ||
    value.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    throw new AdministrationProblem(
      422,
      "invalid_parameter",
      `${field} is not a valid opaque identity.`,
    );
  }
}

function assertSha256(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new AdministrationProblem(
      422,
      "invalid_parameter",
      `${field} is not a lower-case SHA-256 digest.`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
