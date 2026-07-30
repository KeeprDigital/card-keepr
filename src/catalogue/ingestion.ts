import {
  buildCatalogueExport,
  distributionContextExportId,
  type BuiltCatalogueExport,
  type ExportObject,
  type SourceFreshness,
} from "./export";
import {
  FixtureInputError,
  fixtureCandidate,
  type FixtureCandidate,
  type SupportedGame,
} from "./fixture";
import { canonicalJson, sha256 } from "./serialization";
import {
  reconciliationPublication,
  type ReconciliationPublicationPlan,
} from "./reconciliation-publication";
import { digestBoundCandidatePayload } from "./reconciliation-candidate-store";
import { inspectCatalogueCandidate } from "./candidate-inspection";
import {
  byteBoundedJsonArrays,
  guardedAtomicBatch,
  retainedPayload,
} from "./reconciliation-payload";
import { productReleasePublicationStatements } from "./product-release-publication";
import { typedPrintingProjections } from "./product-release-projection";

const sevenDaysInMilliseconds = 7 * 24 * 60 * 60 * 1_000;
const publicationLeaseMilliseconds = 5 * 60 * 1_000;
const activeRunStages = [
  "planning",
  "collecting",
  "parsing",
  "reconciling",
  "awaiting_approval",
  "publishing",
] as const;
const runStates = new Set([
  ...activeRunStages,
  "published",
  "rejected",
  "expired",
  "failed",
]);
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
  candidate_catalogue_digest: string | null;
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
  publication_writer_token: string | null;
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
  not_before: string;
  idempotency_key: string | null;
  request_json: string | null;
  claim_token: string | null;
  claim_version: number;
  claim_expires_at: string | null;
};

type IdempotencyContext = {
  key: string;
  operation: string;
  requestJson: string;
  observedAt: string;
};

type IdempotencyClaimRow = {
  operation: string;
  request_json: string;
  claimed_at: string;
  owner_token: string;
  claim_version: number;
  claim_expires_at: string;
};

type IdempotencyClaimOwner = {
  ownerToken: string;
  version: number;
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
    async (claimOwner) => {
      await expireOverdueRuns(database, observedAt);
      await reconcileAbandonedPublication(
        database,
        catalogueExports,
        observedAt,
      );
      const candidate = await validatedFixtureCandidate(request);
      return startPreparedRun(database, {
        candidate: candidate.candidate,
        candidateDigest: candidate.digest,
        idempotencyKey: request.idempotency_key,
        idempotencyOperation: "start_ingestion_run",
        idempotencyRequestJson: requestJson,
        linkedRunId: null,
        observedAt,
        claimOwner,
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
    async (claimOwner) => {
      await expireOverdueRuns(database, observedAt);
      await reconcileAbandonedPublication(
        database,
        catalogueExports,
        observedAt,
      );
      const source = await requiredRun(database, sourceRunId);
      if (!terminalRunStates.has(source.state)) {
        throw new AdministrationProblem(
          409,
          "source_run_not_terminal",
          "Only a terminal Ingestion Run can be retried.",
        );
      }
      const evidencePlan = await database
        .prepare(
          "SELECT ingestion_run_id FROM ingestion_evidence_plans WHERE ingestion_run_id = ?",
        )
        .bind(source.id)
        .first<{ ingestion_run_id: string }>();
      if (evidencePlan !== null) {
        throw new AdministrationProblem(
          409,
          "evidence_retry_required",
          "Evidence-backed runs must be retried through their linked collection workflow so immutable provenance is retained.",
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
        claimOwner,
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
    async (claimOwner) => {
      await expireOverdueRuns(database, observedAt);
      await reconcileAbandonedPublication(
        database,
        catalogueExports,
        observedAt,
      );
      const result = await attemptPublicationCleanup(
        database,
        catalogueExports,
        runId,
        observedAt,
        {
          key: request.idempotency_key,
          requestJson,
          claimOwner,
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
  await expireOverdueRuns(database, observedAt);
  await reconcileAbandonedPublication(
    database,
    catalogueExports,
    observedAt,
  );
  assertOpaqueId(runId, "run_id");
  const run = await requiredRun(database, runId);
  return publicRun(run, await publicationCleanup(database, run.id));
}

export async function administrationStatus(
  database: D1Database,
  catalogueExports: R2Bucket,
  observedAt = new Date().toISOString(),
): Promise<Record<string, unknown>> {
  await expireOverdueRuns(database, observedAt);
  await reconcileAbandonedPublication(
    database,
    catalogueExports,
    observedAt,
  );
  const [
    catalogue,
    operation,
    freshness,
    recentRuns,
    revisionCount,
    exportCount,
    cleanupCount,
    objectDiagnostics,
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
        .prepare(
          `SELECT COUNT(*) AS count
          FROM ingestion_publication_cleanup
          WHERE state IN ('pending', 'failed')`,
        )
        .first<{ count: number }>(),
      catalogueExportObjectDiagnostics(database, catalogueExports),
    ]);
  const active =
    operation.active_ingestion_run_id === null
      ? null
      : await requiredRun(
          database,
          operation.active_ingestion_run_id,
        );
  const cleanupByRun = await publicationCleanupsForRuns(
    database,
    [
      ...recentRuns.results.map((run) => run.id),
      ...(active === null ? [] : [active.id]),
    ],
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
      catalogue_export_object_count:
        objectDiagnostics.objectCount,
      orphaned_catalogue_export_object_count:
        objectDiagnostics.orphanedObjectCount,
      pending_publication_cleanup_count: cleanupCount?.count ?? 0,
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
  await expireOverdueRuns(database, observedAt);
  await reconcileAbandonedPublication(
    database,
    catalogueExports,
    observedAt,
  );
  assertOpaqueId(runId, "run_id");
  const row = await requiredRun(database, runId);
  const blockedReconciliation =
    row.state === "failed" &&
    row.candidate_digest !== null &&
    (await database
      .prepare(
        `SELECT 1 AS present
         FROM reconciliation_contexts
         WHERE ingestion_run_id = ?`,
      )
      .bind(row.id)
      .first<{ present: number }>()) !== null;
  if (row.state !== "awaiting_approval" && !blockedReconciliation) {
    throw new AdministrationProblem(
      409,
      "candidate_not_approvable",
      "The Ingestion Run does not have an inspectable reconciliation candidate.",
    );
  }
  const candidate = JSON.parse(
    await retainedPayload(
      database,
      row.id,
      "candidate",
      row.candidate_json,
    ),
  ) as FixtureCandidate;
  const diff = await inspectCatalogueCandidate(database, {
    runId: row.id,
    expectedRevisionId: row.expected_current_revision_id,
    candidate,
    fallbackWarnings: parseWarnings(row.warnings_json),
  });
  return {
    run_id: row.id,
    candidate_digest: row.candidate_digest,
    expected_current_revision_id: row.expected_current_revision_id,
    candidate_created_at: row.candidate_created_at,
    approval_deadline: row.approval_deadline,
    progress: parseProgress(row.progress_json),
    diff,
  };
}

export async function approveRun(
  database: D1Database,
  catalogueExports: R2Bucket,
  runId: string,
  request: ApproveRunRequest,
  observedAt = new Date().toISOString(),
): Promise<Record<string, unknown>> {
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
    async (claimOwner) => {
      await expireOverdueRuns(database, observedAt);
      await reconcileAbandonedPublication(
        database,
        catalogueExports,
        observedAt,
      );
      return approveRunAttempt(
        database,
        catalogueExports,
        runId,
        request,
        requestJson,
        observedAt,
        claimOwner,
      );
    },
  );
}

async function approveRunAttempt(
  database: D1Database,
  catalogueExports: R2Bucket,
  runId: string,
  request: ApproveRunRequest,
  requestJson: string,
  now: string,
  claimOwner: IdempotencyClaimOwner,
): Promise<Record<string, unknown>> {
  await expireOverdueRuns(database, now);
  const run = await requiredRun(database, runId);
  if (run.state === "publishing") {
    return approvalInProgress(
      run,
      request,
      requestJson,
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
  const candidate = JSON.parse(
    await retainedPayload(
      database,
      run.id,
      "candidate",
      run.candidate_json,
    ),
  ) as FixtureCandidate;
  const currentRevision = await database
    .prepare(
      `SELECT content_digest
      FROM catalogue_revisions
      WHERE id = ?`,
    )
    .bind(catalogueState.current_revision_id)
    .first<{ content_digest: string }>();
  if (
    run.candidate_catalogue_digest !== null &&
    currentRevision?.content_digest === run.candidate_catalogue_digest
  ) {
    return publishNoChange(
      database,
      run,
      request,
      requestJson,
      approval,
      now,
      claimOwner,
      candidate,
    );
  }
  const revisionId = `catrev_${crypto.randomUUID()}`;
  const writerToken = publicationWriterToken(revisionId);
  const reconciliation = await reconciliationPublication(
    database,
    run.id,
    revisionId,
    now,
  );
  const sourceFreshness = await sourceFreshnessForExport(
    database,
    candidate.selected_games,
    checkedFreshnessAreas(
      parseSelectedGames(run.selected_games_json),
      candidate,
    ),
    now,
  );
  const catalogueExport = await buildCatalogueExport(
    candidate,
    requiredCandidateCatalogueDigest(run),
    revisionId,
    now,
    reconciliation === null
      ? undefined
      : {
          cards: reconciliation.cardLifecycles,
          printings: reconciliation.printingLifecycles,
          products: reconciliation.productLifecycles,
          productRelationships:
            reconciliation.productRelationshipLifecycles,
          relationships: reconciliation.relationshipEvidence,
          locators: reconciliation.locatorEvidence,
        },
    sourceFreshness,
  );
  try {
    await reservePublication(
      database,
      run.id,
      approval,
      request.idempotency_key,
      revisionId,
      catalogueExport.manifest.manifest_sha256,
      writerToken,
      now,
    );
  } catch (error) {
    const reserved = await requiredRun(database, run.id);
    if (reserved.state === "publishing") {
      return approvalInProgress(
        reserved,
        request,
        requestJson,
      );
    }
    await throwApprovalFailure(database, run, error, now);
  }
  try {
    await storeAndVerifyExport(
      database,
      catalogueExports,
      run.id,
      revisionId,
      writerToken,
      catalogueExport.objects,
    );
    if (
      !(await isExactVerifiedExport(
        catalogueExports,
        revisionId,
        catalogueExport,
      ))
    ) {
      throw new Error(
        "The Catalogue Export attempt contains unexpected objects.",
      );
    }
    return await commitVerifiedPublication(database, {
      run: await requiredRun(database, run.id),
      candidate,
      catalogueExport,
      reconciliation,
      requestJson,
      completedAt: now,
      claimOwner,
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
    const cleanupKeys = await listCatalogueExportPrefix(
      catalogueExports,
      revisionId,
    );
    await failReservedPublication(
      database,
      await requiredRun(database, run.id),
      cleanupKeys,
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
    async (claimOwner) => {
      await expireOverdueRuns(database, observedAt);
      await reconcileAbandonedPublication(
        database,
        catalogueExports,
        observedAt,
      );
      return rejectRunAttempt(
        database,
        runId,
        request,
        requestJson,
        observedAt,
        claimOwner,
      );
    },
  );
}

async function rejectRunAttempt(
  database: D1Database,
  runId: string,
  request: RejectRunRequest,
  requestJson: string,
  now: string,
  claimOwner: IdempotencyClaimOwner,
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
      ...idempotencyCompletionStatements(database, {
        key: request.idempotency_key,
        operation: "reject_ingestion_run",
        requestJson,
        response: resultingRun,
        status: 200,
        createdAt: now,
        claimOwner,
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
    claimOwner: IdempotencyClaimOwner;
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
    candidate_catalogue_digest: input.candidateDigest,
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
    publication_writer_token: null,
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
            candidate_catalogue_digest,
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
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL,
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
              candidate_catalogue_digest = ?,
              candidate_created_at = ?,
              approval_deadline = ?,
              progress_json = ?
          WHERE id = ? AND state = 'reconciling'`,
        )
        .bind(
          input.candidateDigest,
          input.candidateDigest,
          startedAt,
          approvalDeadline,
          JSON.stringify(progressFor("awaiting_approval")),
          runId,
        ),
      ...idempotencyCompletionStatements(database, {
        key: input.idempotencyKey,
        operation: input.idempotencyOperation,
        requestJson: input.idempotencyRequestJson,
        response: resultingRun,
        status: 201,
        createdAt: startedAt,
        claimOwner: input.claimOwner,
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
    if (
      errorMessage(error).includes(
        "credential_execution_in_progress",
      )
    ) {
      throw new AdministrationProblem(
        409,
        "credential_execution_in_progress",
        "Credential execution blocks new Ingestion Runs.",
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
  claimOwner: IdempotencyClaimOwner,
  candidate: FixtureCandidate,
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
  const reconciliation = await reconciliationPublication(
    database,
    run.id,
    request.expected_current_revision_id,
    now,
  );
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
      ...(reconciliation?.statements ?? []),
      ...freshnessStatements(
        database,
        checkedFreshnessAreas(
          parseSelectedGames(run.selected_games_json),
          candidate,
          now,
        ),
        run.id,
      ),
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
      ...idempotencyCompletionStatements(database, {
        key: request.idempotency_key,
        operation: "approve_ingestion_run",
        requestJson,
        response: resultingRun,
        status: 200,
        createdAt: now,
        claimOwner,
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

function catalogueCard(
  card: FixtureCandidate["cards"][number],
  printingIds: readonly string[],
  revisionId: string,
  reconciledLifecycle?: Record<string, unknown>,
) {
  return {
    type: "card",
    ...card,
    printing_ids: printingIds,
    lifecycle: reconciledLifecycle ?? lifecycle(revisionId),
    links: {
      self: `/v1/cards/${card.id}`,
    },
  };
}

async function cataloguePrinting(
  printing: FixtureCandidate["printings"][number],
  game: SupportedGame,
  revisionId: string,
  reconciledLifecycle?: Record<string, unknown>,
  relationshipEvidence: readonly Record<string, unknown>[] = [],
  locatorEvidence: Record<string, unknown> = {
    current: [],
    historical: [],
  },
  declaredContexts: readonly NonNullable<
    FixtureCandidate["distribution_contexts"]
  >[number][] = [],
  declaredProducts: readonly NonNullable<
    FixtureCandidate["products"]
  >[number][] = [],
  declaredRelationships: readonly NonNullable<
    FixtureCandidate["product_relationships"]
  >[number][] = [],
) {
  const canonicalRelationshipEvidence = relationshipEvidence.filter(
    (relationship) =>
      relationship.relationship_kind !== "source_bucket",
  );
  const contexts = await Promise.all(
    canonicalRelationshipEvidence
      .filter(
        (relationship) =>
          relationship.current === true &&
          relationship.relationship_kind === "distribution_context",
      )
      .map(async (relationship) => {
        const declared = declaredContexts.find(
          (context) =>
            context.game === game &&
            context.key === String(relationship.relationship_value),
        );
        return (
          declared ?? {
            id: await distributionContextExportId(
              game,
              String(relationship.source_lineage),
              String(relationship.relationship_value),
            ),
            kind: "other" as const,
            label: String(relationship.relationship_value),
            product_id: null,
            evidence_category: "explicit" as const,
          }
        );
      }),
  );
  const typed = typedPrintingProjections(
    printing.id,
    declaredProducts,
    declaredContexts,
    declaredRelationships,
  );
  const projectedContexts = [
    ...new Map(
      [...contexts, ...typed.distribution_contexts].map((context) => [
        context.id,
        context,
      ]),
    ).values(),
  ].sort((left, right) => left.id.localeCompare(right.id));
  return {
    type: "printing",
    ...printing,
    printing_images: [],
    products: typed.products,
    distribution_contexts: projectedContexts,
    relationship_evidence: canonicalRelationshipEvidence,
    locator_evidence: locatorEvidence,
    lifecycle: reconciledLifecycle ?? lifecycle(revisionId),
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
  writerToken: string,
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
          publication_manifest_digest = ?,
          publication_writer_token = ?
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
      writerToken,
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
  database: D1Database,
  bucket: R2Bucket,
  runId: string,
  revisionId: string,
  writerToken: string,
  objects: readonly ExportObject[],
): Promise<void> {
  for (const object of objects) {
    await assertPublicationWriterActive(
      database,
      runId,
      revisionId,
      writerToken,
    );
    const existing = await bucket.head(object.key);
    if (existing !== null) {
      if (!(await storedExportObjectMatches(bucket, object))) {
        throw new Error("Immutable Catalogue Export object changed");
      }
      continue;
    }
    const body = object.body();
    await Promise.all([
      bucket.put(object.key, body.readable, {
        sha256: object.sha256,
        httpMetadata: {
          contentType: object.contentType,
          ...(object.contentEncoding === undefined
            ? {}
            : { contentEncoding: object.contentEncoding }),
          cacheControl: "private, max-age=31536000, immutable",
        },
      }),
      body.completed,
    ]);
    if (!(await storedExportObjectMatches(bucket, object))) {
      throw new Error("Catalogue Export object verification failed");
    }
    await assertPublicationWriterActive(
      database,
      runId,
      revisionId,
      writerToken,
      bucket,
      object.key,
    );
  }
}

async function assertPublicationWriterActive(
  database: D1Database,
  runId: string,
  revisionId: string,
  writerToken: string,
  bucket?: R2Bucket,
  lateObjectKey?: string,
): Promise<void> {
  const reservation = await database
    .prepare(
      `SELECT id
      FROM ingestion_runs
      WHERE id = ?
        AND (
          state = 'publishing'
          OR (? = 1 AND state = 'published')
        )
        AND publication_revision_id = ?
        AND publication_writer_token = ?`,
    )
    .bind(
      runId,
      bucket === undefined ? 0 : 1,
      revisionId,
      writerToken,
    )
    .first<{ id: string }>();
  if (reservation === null) {
    if (bucket !== undefined && lateObjectKey !== undefined) {
      await compensateLatePublicationWrite(
        database,
        bucket,
        runId,
        lateObjectKey,
      );
    }
    throw new Error("publication_writer_fenced");
  }
}

function publicationWriterToken(revisionId: string): string {
  return `writer:${revisionId}`;
}

async function compensateLatePublicationWrite(
  database: D1Database,
  bucket: R2Bucket,
  runId: string,
  objectKey: string,
): Promise<void> {
  try {
    await bucket.delete(objectKey);
    if ((await bucket.get(objectKey)) === null) return;
  } catch {
    // Persisting cleanup ownership below is the fail-closed fallback.
  }
  const run = await requiredRun(database, runId);
  if (run.state !== "failed" || run.terminal_at === null) {
    throw new Error(
      "The late publication write could not be attached to terminal cleanup.",
    );
  }
  const failureAt = run.terminal_at;
  await database
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
        request_json,
        claim_token,
        claim_version,
        claim_expires_at
      ) VALUES (
        ?, 'failed', json_array(?), 1,
        'late_publication_write', ?, NULL, ?,
        NULL, NULL, NULL, 1, NULL
      )
      ON CONFLICT (ingestion_run_id) DO UPDATE SET
        state = 'failed',
        object_keys_json = (
          SELECT json_group_array(object_key)
          FROM (
            SELECT value AS object_key
            FROM json_each(
              ingestion_publication_cleanup.object_keys_json
            )
            UNION
            SELECT excluded_key.object_key
            FROM (SELECT ? AS object_key) AS excluded_key
            ORDER BY object_key
          )
        ),
        attempts = MAX(ingestion_publication_cleanup.attempts, 1),
        failure_code = 'late_publication_write',
        last_attempt_at = ?,
        completed_at = NULL,
        idempotency_key = NULL,
        request_json = NULL,
        claim_token = NULL,
        claim_version =
          ingestion_publication_cleanup.claim_version + 1,
        claim_expires_at = NULL`,
    )
    .bind(
      runId,
      objectKey,
      failureAt,
      publicationCleanupNotBefore(run, failureAt),
      objectKey,
      failureAt,
    )
    .run();
}

async function commitVerifiedPublication(
  database: D1Database,
  input: {
    run: RunRow;
    candidate: FixtureCandidate;
    catalogueExport: BuiltCatalogueExport;
    reconciliation: ReconciliationPublicationPlan | null;
    requestJson: string;
    completedAt: string;
    claimOwner?: IdempotencyClaimOwner;
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
  const cardDocuments = input.candidate.cards.map((card) => ({
    card,
    document: catalogueCard(
      card,
      input.candidate.printings
        .filter((printing) => printing.card_id === card.id)
        .map((printing) => printing.id),
      revisionId,
      input.reconciliation?.cardLifecycles[card.id],
    ),
  }));
  const printingDocuments = await Promise.all(
    input.candidate.printings.map(async (printing) => ({
      printing,
      document: await cataloguePrinting(
        printing,
        input.candidate.cards.find(
          (card) => card.id === printing.card_id,
        )!.game,
        revisionId,
        input.reconciliation?.printingLifecycles[printing.id],
        input.reconciliation?.relationshipEvidence[printing.id] ?? [],
        input.reconciliation?.locatorEvidence[printing.id] ?? {
          current: [],
          historical: [],
        },
        input.candidate.distribution_contexts ?? [],
        input.candidate.products ?? [],
        input.candidate.product_relationships ?? [],
      ),
    })),
  );
  const productReleaseStatements = productReleasePublicationStatements(
    database,
    input.candidate,
    revisionId,
    {
      products: input.reconciliation?.productLifecycles ?? {},
      releases:
        input.reconciliation?.releaseLifecycles ??
        Object.fromEntries(
          (input.candidate.products ?? []).flatMap((product) =>
            product.releases.map((release) => [
              release.id,
              {
                first_revision_id: revisionId,
                last_observed_revision_id: revisionId,
              },
            ]),
          ),
        ),
      relationships:
        input.reconciliation?.productRelationshipLifecycles ?? {},
    },
  );
  const revisionCardStatements = byteBoundedJsonArrays(
    cardDocuments.map(({ card, document }) => ({
      card_id: card.id,
      document_json: JSON.stringify(document),
    })),
  ).map((chunk) =>
    database
      .prepare(
        `INSERT INTO revision_cards (
           catalogue_revision_id, card_id, document_json
         )
         SELECT ?, json_extract(value, '$.card_id'),
                json_extract(value, '$.document_json')
         FROM json_each(?)`,
      )
      .bind(revisionId, chunk),
  );
  const revisionPrintingStatements = byteBoundedJsonArrays(
    printingDocuments.map(({ printing, document }) => ({
      printing_id: printing.id,
      card_id: printing.card_id,
      document_json: JSON.stringify(document),
    })),
  ).map((chunk) =>
    database
      .prepare(
        `INSERT INTO revision_printings (
           catalogue_revision_id, printing_id, card_id, document_json
         )
         SELECT ?, json_extract(value, '$.printing_id'),
                json_extract(value, '$.card_id'),
                json_extract(value, '$.document_json')
         FROM json_each(?)`,
      )
      .bind(revisionId, chunk),
  );
  const commitStatements = [
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
        requiredCandidateCatalogueDigest(input.run),
        input.run.expected_current_revision_id,
        input.run.candidate_digest,
      ),
    ...(input.reconciliation?.statements ?? []),
    ...revisionCardStatements,
    ...revisionPrintingStatements,
    ...productReleaseStatements,
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
      checkedFreshnessAreas(
        parseSelectedGames(input.run.selected_games_json),
        input.candidate,
        input.completedAt,
      ),
      input.run.id,
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
    ...idempotencyCompletionStatements(database, {
      key: idempotencyKey,
      operation: "approve_ingestion_run",
      requestJson: input.requestJson,
      response: resultingRun,
      status: 200,
      createdAt: input.completedAt,
      claimOwner: input.claimOwner ?? null,
    }),
  ];
  await database.batch(guardedAtomicBatch(commitStatements));
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
      isOpaqueIdentity(revisionId)
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
  const candidate = JSON.parse(
    await retainedPayload(
      database,
      run.id,
      "candidate",
      run.candidate_json,
    ),
  ) as FixtureCandidate;
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
  const digestPayload =
    (await digestBoundCandidatePayload(database, run.id)) ??
    canonicalJson(candidate);
  if (
    approval.candidate_digest !== run.candidate_digest ||
    approval.expected_current_revision_id !==
      run.expected_current_revision_id ||
    approval.approved_at !== publishedAt ||
    !isIsoInstant(publishedAt) ||
    !isSha256Digest(manifestDigest) ||
    !isOpaqueIdentity(revisionId) ||
    run.publication_writer_token !==
      publicationWriterToken(revisionId) ||
    !parseSelectedGames(run.selected_games_json).every((game) =>
      candidate.selected_games.includes(game as SupportedGame),
    ) ||
    (await sha256(
      new TextEncoder().encode(digestPayload),
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
  const reconciliation = await reconciliationPublication(
    database,
    run.id,
    revisionId,
    publishedAt,
  );
  const sourceFreshness = await sourceFreshnessForExport(
    database,
    candidate.selected_games,
    checkedFreshnessAreas(
      parseSelectedGames(run.selected_games_json),
      candidate,
    ),
    publishedAt,
  );
  const catalogueExport = await buildCatalogueExport(
    candidate,
    requiredCandidateCatalogueDigest(run),
    revisionId,
    publishedAt,
    reconciliation === null
      ? undefined
      : {
          cards: reconciliation.cardLifecycles,
          printings: reconciliation.printingLifecycles,
          products: reconciliation.productLifecycles,
          productRelationships:
            reconciliation.productRelationshipLifecycles,
          relationships: reconciliation.relationshipEvidence,
          locators: reconciliation.locatorEvidence,
        },
    sourceFreshness,
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
    const claimOwner = await currentAdministrationClaimOwner(
      database,
      requiredPublicationValue(
        run.approval_idempotency_key,
        "idempotency key",
      ),
      "approve_ingestion_run",
      requestJson,
    );
    await commitVerifiedPublication(database, {
      run,
      candidate,
      catalogueExport,
      reconciliation,
      requestJson,
      completedAt: observedAt,
      ...(claimOwner === null ? {} : { claimOwner }),
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
  const cleanupKeys = await listCatalogueExportPrefix(
    bucket,
    revisionId,
  );
  await failReservedPublication(
    database,
    run,
    cleanupKeys,
    observedAt,
    problem,
  );
}

function requiredCandidateCatalogueDigest(run: RunRow): string {
  if (
    run.candidate_catalogue_digest === null ||
    !isSha256Digest(run.candidate_catalogue_digest)
  ) {
    throw new Error("The candidate Catalogue Data digest is invalid.");
  }
  return run.candidate_catalogue_digest;
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
    if (!(await storedExportObjectMatches(bucket, object))) {
      return false;
    }
  }
  return true;
}

async function storedExportObjectMatches(
  bucket: R2Bucket,
  expected: ExportObject,
): Promise<boolean> {
  const stored = await bucket.head(expected.key);
  if (stored === null || stored.size !== expected.byteLength) return false;
  const checksum = stored.checksums.toJSON().sha256;
  if (checksum !== undefined) return checksum === expected.sha256;
  const body = await bucket.get(expected.key);
  if (body === null) return false;
  const digest = new crypto.DigestStream("SHA-256");
  await body.body.pipeTo(digest);
  return digestHex(await digest.digest) === expected.sha256;
}

function digestHex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
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
    !isSha256Digest(run.candidate_digest)
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
  const claimOwner = await currentAdministrationClaimOwner(
    database,
    key,
    "approve_ingestion_run",
    requestJson,
  );
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
    administrationClaimDeleteStatement(database, {
      key,
      operation: "approve_ingestion_run",
      requestJson,
    }, claimOwner),
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
      .bind(
        run.id,
        canonicalJson([...new Set(objectKeys)].sort()),
        publicationCleanupNotBefore(run, terminalAt),
      ),
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
    throw new Error(
      "The persisted publication cleanup fence is invalid.",
    );
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
    const operation = activeCleanupOperation(
      cleanup,
      run,
      idempotency,
      observedAt,
    );
    if (operation !== null) return operation;
  }
  const recordedKeys = parseCleanupKeys(
    cleanup.object_keys_json,
    run,
  );
  const revisionId = requiredPublicationValue(
    run.publication_revision_id,
    "revision ID",
  );
  const observedKeys = await listCatalogueExportPrefix(
    bucket,
    revisionId,
  );
  const keys = [...new Set([...recordedKeys, ...observedKeys])].sort();
  const claimToken = `cleanup-claim:${crypto.randomUUID()}`;
  const claimExpiresAt = new Date(
    Date.parse(observedAt) + publicationLeaseMilliseconds,
  ).toISOString();
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
    const operation = activeCleanupOperation(
      cleanup,
      run,
      idempotency,
      observedAt,
    );
    if (operation !== null) return operation;
    throw new AdministrationProblem(
      409,
      "publication_cleanup_claim_changed",
      "Publication cleanup ownership changed; retry the request.",
      false,
    );
  }
  try {
    await deleteR2KeysInBatches(bucket, keys);
    if (
      (await listCatalogueExportPrefix(bucket, revisionId)).length > 0
    ) {
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
      .bind(
        observedAt,
        runId,
        claimToken,
        claimed.claim_version,
      )
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
      const current = await requiredPublicationCleanup(
        database,
        runId,
      );
      const operation = activeCleanupOperation(
        current,
        run,
        idempotency,
        observedAt,
      );
      if (operation !== null) return operation;
      if (
        current.state === "completed" &&
        idempotency !== undefined &&
        current.idempotency_key === idempotency.key &&
        current.request_json === idempotency.requestJson
      ) {
        return cleanupCompletionInProgress(
          run,
          idempotency.key,
          observedAt,
        );
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

function cleanupCompletionInProgress(
  run: RunRow,
  idempotencyKey: string,
  observedAt: string,
): Record<string, unknown> {
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
  if (
    idempotency !== undefined &&
    cleanup.idempotency_key === idempotency.key
  ) {
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

async function requiredPublicationCleanup(
  database: D1Database,
  runId: string,
): Promise<PublicationCleanupRow> {
  const cleanup = await publicationCleanup(database, runId);
  if (cleanup === null) {
    throw new Error("The publication cleanup claim disappeared.");
  }
  return cleanup;
}

async function deleteR2KeysInBatches(
  bucket: R2Bucket,
  keys: readonly string[],
): Promise<void> {
  for (let index = 0; index < keys.length; index += 1_000) {
    await bucket.delete(keys.slice(index, index + 1_000));
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

function publicationCleanupNotBefore(
  run: RunRow,
  terminalAt: string,
): string {
  const reconcileAt =
    run.publication_reconcile_after === null
      ? Date.parse(terminalAt)
      : Date.parse(run.publication_reconcile_after);
  return new Date(
    Math.max(Date.parse(terminalAt), reconcileAt) +
      publicationLeaseMilliseconds,
  ).toISOString();
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

async function catalogueExportObjectDiagnostics(
  database: D1Database,
  bucket: R2Bucket,
): Promise<{
  objectCount: number;
  orphanedObjectCount: number;
}> {
  let objectCount = 0;
  let orphanedObjectCount = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: "catalogue-exports/",
      limit: 1_000,
      ...(cursor === undefined ? {} : { cursor }),
    });
    objectCount += page.objects.length;
    const revisionIds = [
      ...new Set(
        page.objects.flatMap((object) => {
          const [, revisionId] = object.key.split("/", 3);
          return revisionId === undefined ? [] : [revisionId];
        }),
      ),
    ];
    const published = new Set<string>();
    for (let index = 0; index < revisionIds.length; index += 50) {
      const chunk = revisionIds.slice(index, index + 50);
      const placeholders = chunk.map(() => "?").join(", ");
      const matches = await database
        .prepare(
          `SELECT id
          FROM catalogue_revisions
          WHERE id IN (${placeholders})`,
        )
        .bind(...chunk)
        .all<{ id: string }>();
      for (const match of matches.results) published.add(match.id);
    }
    orphanedObjectCount += page.objects.filter((object) => {
      const [, revisionId] = object.key.split("/", 3);
      return revisionId === undefined || !published.has(revisionId);
    }).length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return { objectCount, orphanedObjectCount };
}

async function publicationCleanupsForRuns(
  database: D1Database,
  runIds: readonly string[],
): Promise<Map<string, PublicationCleanupRow>> {
  const uniqueRunIds = [...new Set(runIds)].slice(0, 21);
  if (uniqueRunIds.length === 0) return new Map();
  const placeholders = uniqueRunIds.map(() => "?").join(", ");
  const cleanups = await database
    .prepare(
      `SELECT *
      FROM ingestion_publication_cleanup
      WHERE ingestion_run_id IN (${placeholders})`,
    )
    .bind(...uniqueRunIds)
    .all<PublicationCleanupRow>();
  return new Map(
    cleanups.results.map((cleanup) => [
      cleanup.ingestion_run_id,
      cleanup,
    ]),
  );
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
  const persisted = parseJson(
    prior.response_json,
    "Administration idempotency outcome",
  );
  if (prior.outcome === "problem") {
    if (
      !isRecord(persisted) ||
      !hasOnlyKeys(persisted, ["code", "detail"]) ||
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
  const result = decodePublicRunDocument(persisted);
  await assertSuccessfulReplayCorrelation(
    database,
    result,
    prior,
    key,
    requestJson,
  );
  return result;
}

async function assertSuccessfulReplayCorrelation(
  database: D1Database,
  run: Record<string, unknown>,
  prior: IdempotencyRow,
  key: string,
  requestJson: string,
): Promise<void> {
  const request = parseJson(
    requestJson,
    "Administration idempotency request",
  );
  const expectedStatus =
    prior.operation === "start_ingestion_run" ||
    prior.operation === "retry_ingestion_run"
      ? 201
      : 200;
  let correlated = false;
  if (isRecord(request)) {
    if (prior.operation === "start_ingestion_run") {
      correlated =
        hasOnlyKeys(request, ["fixture", "selected_games"]) &&
        request.fixture === "first-catalogue" &&
        isExactStringTuple(request.selected_games, ["one-piece"]) &&
        run.idempotency_key === key &&
        run.linked_run_id === null &&
        run.state === "awaiting_approval";
    } else if (prior.operation === "retry_ingestion_run") {
      correlated =
        hasOnlyKeys(request, ["source_run_id"]) &&
        typeof request.source_run_id === "string" &&
        run.linked_run_id === request.source_run_id &&
        run.idempotency_key === key &&
        run.state === "awaiting_approval";
    } else if (prior.operation === "approve_ingestion_run") {
      correlated =
        hasOnlyKeys(request, [
          "run_id",
          "candidate_digest",
          "expected_current_revision_id",
        ]) &&
        run.id === request.run_id &&
        run.state === "published" &&
        isRecord(run.approval) &&
        run.approval.candidate_digest ===
          request.candidate_digest &&
        run.approval.expected_current_revision_id ===
          request.expected_current_revision_id;
    } else if (prior.operation === "reject_ingestion_run") {
      correlated =
        hasOnlyKeys(request, ["run_id", "candidate_digest"]) &&
        run.id === request.run_id &&
        run.state === "rejected" &&
        Array.isArray(run.approval_history) &&
        run.approval_history.length === 1 &&
        isRecord(run.approval_history[0]) &&
        run.approval_history[0].action === "rejected" &&
        run.approval_history[0].candidate_digest ===
          request.candidate_digest;
    } else if (
      prior.operation === "retry_publication_cleanup"
    ) {
      const currentCleanup =
        typeof request.run_id === "string"
          ? await publicationCleanup(database, request.run_id)
          : null;
      correlated =
        hasOnlyKeys(request, ["run_id"]) &&
        run.id === request.run_id &&
        run.state === "failed" &&
        isRecord(run.publication_cleanup) &&
        run.publication_cleanup.state === "completed" &&
        currentCleanup?.state === "completed" &&
        currentCleanup.claim_version ===
          run.publication_cleanup.generation;
    }
  }
  if (
    prior.outcome !== "success" ||
    prior.http_status !== expectedStatus ||
    !correlated
  ) {
    throw new Error(
      "The persisted administration success outcome does not match its request.",
    );
  }
}

async function idempotentAdministration(
  database: D1Database,
  context: IdempotencyContext,
  operation: (
    owner: IdempotencyClaimOwner,
  ) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const replay = await replayAdministration(
    database,
    context.key,
    context.operation,
    context.requestJson,
  );
  if (replay !== null) return replay;
  const acquisition = await claimAdministration(database, context);
  if (acquisition.owner === null) {
    const concurrentReplay = await replayAdministration(
      database,
      context.key,
      context.operation,
      context.requestJson,
    );
    if (concurrentReplay !== null) return concurrentReplay;
    return pendingAdministrationOperation(
      context,
      acquisition.claim,
    );
  }
  const owner = acquisition.owner;
  const takeoverReplay = await replayAdministration(
    database,
    context.key,
    context.operation,
    context.requestJson,
  );
  if (takeoverReplay !== null) return takeoverReplay;
  if (!isReplaySafeAdministrationOperation(context.operation)) {
    return pendingAdministrationOperation(context, acquisition.claim);
  }
  try {
    const result = await operation(owner);
    return isAdministrationInProgress(result)
      ? pendingAdministrationOperation(context, {
          operation: context.operation,
          request_json: context.requestJson,
          claimed_at: context.observedAt,
          owner_token: owner.ownerToken,
          claim_version: owner.version,
          claim_expires_at: acquisition.claim.claim_expires_at,
        })
      : result;
  } catch (error) {
    if (!(error instanceof AdministrationProblem)) throw error;
    if (!error.persistOutcome) {
      await releaseAdministrationClaim(database, context, owner);
      throw error;
    }
    try {
      await database.batch([
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
            ) VALUES (?, ?, ?, ?, ?, 'problem', ?, ?, ?)`,
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
            owner.ownerToken,
            owner.version,
          ),
        administrationClaimDeleteStatement(database, context, owner),
      ]);
    } catch (persistError) {
      const ownerChanged = errorMessage(persistError).includes(
        "administration_idempotency_owner_changed",
      );
      if (
        !ownerChanged &&
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
      if (ownerChanged) {
        const currentClaim = await administrationClaim(
          database,
          context.key,
        );
        if (
          currentClaim !== null &&
          currentClaim.operation === context.operation &&
          currentClaim.request_json === context.requestJson
        ) {
          return pendingAdministrationOperation(
            context,
            currentClaim,
          );
        }
      }
    }
    throw error;
  }
}

function isReplaySafeAdministrationOperation(
  operation: string,
): boolean {
  return [
    "start_ingestion_run",
    "retry_ingestion_run",
    "approve_ingestion_run",
    "reject_ingestion_run",
    "retry_publication_cleanup",
  ].includes(operation);
}

function isAdministrationInProgress(
  value: Record<string, unknown>,
): boolean {
  return (
    value.contract === "card-keepr-administration-operation@1" &&
    value.status === "in_progress"
  );
}

async function claimAdministration(
  database: D1Database,
  context: IdempotencyContext,
): Promise<{
  claim: IdempotencyClaimRow;
  owner: IdempotencyClaimOwner | null;
}> {
  const ownerToken = `administration-claim:${crypto.randomUUID()}`;
  const expiresAt = new Date(
    Date.parse(context.observedAt) + publicationLeaseMilliseconds,
  ).toISOString();
  try {
    const inserted = await database
      .prepare(
        `INSERT INTO administration_idempotency_claims (
          idempotency_key,
          operation,
          request_json,
          claimed_at,
          owner_token,
          claim_version,
          claim_expires_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?)
        RETURNING operation, request_json, claimed_at,
          owner_token, claim_version, claim_expires_at`,
      )
      .bind(
        context.key,
        context.operation,
        context.requestJson,
        context.observedAt,
        ownerToken,
        expiresAt,
      )
      .first<IdempotencyClaimRow>();
    if (inserted === null) {
      throw new Error("The administration claim was not inserted.");
    }
    return {
      claim: inserted,
      owner: { ownerToken, version: inserted.claim_version },
    };
  } catch (error) {
    if (
      errorMessage(error).includes(
        "administration_idempotency_claims.idempotency_key",
      ) ||
      errorMessage(error).includes(
        "administration_idempotency_completed",
      )
    ) {
      const prior = await administrationClaim(database, context.key);
      if (prior === null) {
        const replay = await replayAdministration(
          database,
          context.key,
          context.operation,
          context.requestJson,
        );
        if (replay !== null) {
          return {
            claim: {
              operation: context.operation,
              request_json: context.requestJson,
              claimed_at: context.observedAt,
              owner_token: ownerToken,
              claim_version: 0,
              claim_expires_at: context.observedAt,
            },
            owner: null,
          };
        }
        throw new Error(
          "The administration idempotency claim changed without an outcome.",
        );
      }
      if (
        prior.operation !== context.operation ||
        prior.request_json !== context.requestJson
      ) {
        throw new AdministrationProblem(
          409,
          "idempotency_key_reused",
          "The idempotency key was already used for a different administration request.",
        );
      }
      if (
        !isIsoInstant(prior.claim_expires_at) ||
        Date.parse(context.observedAt) <
          Date.parse(prior.claim_expires_at)
      ) {
        return { claim: prior, owner: null };
      }
      const takenOver = await database
        .prepare(
          `UPDATE administration_idempotency_claims
          SET claimed_at = ?,
              owner_token = ?,
              claim_version = claim_version + 1,
              claim_expires_at = ?
          WHERE idempotency_key = ?
            AND operation = ?
            AND request_json = ?
            AND owner_token = ?
            AND claim_version = ?
            AND claim_expires_at = ?
          RETURNING operation, request_json, claimed_at,
            owner_token, claim_version, claim_expires_at`,
        )
        .bind(
          context.observedAt,
          ownerToken,
          expiresAt,
          context.key,
          context.operation,
          context.requestJson,
          prior.owner_token,
          prior.claim_version,
          prior.claim_expires_at,
        )
        .first<IdempotencyClaimRow>();
      if (takenOver === null) {
        const winner = await administrationClaim(
          database,
          context.key,
        );
        if (winner === null) {
          const replay = await replayAdministration(
            database,
            context.key,
            context.operation,
            context.requestJson,
          );
          if (replay !== null) {
            return { claim: prior, owner: null };
          }
          throw new Error(
            "The administration claim takeover changed without an outcome.",
          );
        }
        return { claim: winner, owner: null };
      }
      return {
        claim: takenOver,
        owner: {
          ownerToken,
          version: takenOver.claim_version,
        },
      };
    }
    throw error;
  }
}

async function administrationClaim(
  database: D1Database,
  key: string,
): Promise<IdempotencyClaimRow | null> {
  return database
    .prepare(
      `SELECT
        operation,
        request_json,
        claimed_at,
        owner_token,
        claim_version,
        claim_expires_at
      FROM administration_idempotency_claims
      WHERE idempotency_key = ?`,
    )
    .bind(key)
    .first<IdempotencyClaimRow>();
}

async function currentAdministrationClaimOwner(
  database: D1Database,
  key: string,
  operation: string,
  requestJson: string,
): Promise<IdempotencyClaimOwner | null> {
  const claim = await administrationClaim(database, key);
  if (claim === null) return null;
  if (
    claim.operation !== operation ||
    claim.request_json !== requestJson
  ) {
    throw new Error(
      "The administration claim does not match its domain operation.",
    );
  }
  return {
    ownerToken: claim.owner_token,
    version: claim.claim_version,
  };
}

function pendingAdministrationOperation(
  context: IdempotencyContext,
  claim: IdempotencyClaimRow,
): Record<string, unknown> {
  const request = parseJson(
    context.requestJson,
    "Administration idempotency claim request",
  );
  const runId =
    isRecord(request) && typeof request.run_id === "string"
      ? request.run_id
      : null;
  return {
    contract: "card-keepr-administration-operation@1",
    operation: context.operation,
    status: "in_progress",
    idempotency_key: context.key,
    claimed_at: claim.claimed_at,
    retry_after: claim.claim_expires_at,
    ...(runId === null ? {} : { run_id: runId }),
    links: {
      ...(runId === null
        ? {}
        : { run: `/v1/ingestion-runs/${runId}` }),
      status: "/v1/status",
    },
  };
}

async function releaseAdministrationClaim(
  database: D1Database,
  context: IdempotencyContext,
  owner: IdempotencyClaimOwner,
): Promise<void> {
  await administrationClaimDeleteStatement(
    database,
    context,
    owner,
  ).run();
}

function administrationClaimDeleteStatement(
  database: D1Database,
  context: {
    key: string;
    operation: string;
    requestJson: string;
  },
  owner: IdempotencyClaimOwner | null,
): D1PreparedStatement {
  return database
    .prepare(
      `DELETE FROM administration_idempotency_claims
      WHERE idempotency_key = ?
        AND operation = ?
        AND request_json = ?
        AND (? IS NULL OR owner_token = ?)
        AND (? IS NULL OR claim_version = ?)`,
    )
    .bind(
      context.key,
      context.operation,
      context.requestJson,
      owner?.ownerToken ?? null,
      owner?.ownerToken ?? null,
      owner?.version ?? null,
      owner?.version ?? null,
    );
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
    if (
      legacyRequestJson === requestJson &&
      terminalRunStates.has(run.state)
    ) {
      return publicRun(run);
    }
    if (legacyRequestJson === requestJson) return null;
  }
  throw new AdministrationProblem(
    409,
    "idempotency_key_reused",
    "The idempotency key was already used for a different administration request.",
  );
}

function approvalInProgress(
  run: RunRow,
  request: ApproveRunRequest,
  requestJson: string,
): Record<string, unknown> {
  const reservedRequestJson = canonicalJson({
    run_id: run.id,
    candidate_digest: run.candidate_digest,
    expected_current_revision_id:
      run.expected_current_revision_id,
  });
  if (
    run.approval_idempotency_key !== request.idempotency_key ||
    run.candidate_digest !== request.candidate_digest ||
    run.expected_current_revision_id !==
      request.expected_current_revision_id ||
    reservedRequestJson !== requestJson
  ) {
    throw new AdministrationProblem(
      409,
      run.approval_idempotency_key === request.idempotency_key
        ? "idempotency_key_reused"
        : "publication_in_progress",
      run.approval_idempotency_key === request.idempotency_key
        ? "The idempotency key was already used for a different administration request."
        : "The Ingestion Run already has a publication in progress.",
    );
  }
  const approval = parseApproval(run.approval_json);
  if (
    approval.candidate_digest !== request.candidate_digest ||
    approval.expected_current_revision_id !==
      request.expected_current_revision_id
  ) {
    throw new Error("The reserved approval request is invalid.");
  }
  return {
    contract: "card-keepr-administration-operation@1",
    operation: "approve_ingestion_run",
    status: "in_progress",
    run_id: run.id,
    idempotency_key: request.idempotency_key,
    retry_after: run.publication_reconcile_after,
    links: {
      run: `/v1/ingestion-runs/${run.id}`,
      status: "/v1/status",
    },
  };
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
    !errorMessage(error).includes("active_ingestion_run") &&
    !errorMessage(error).includes("publication_writer_fenced")
  ) {
    return null;
  }
  return replayAdministration(database, key, operation, requestJson);
}

function idempotencyCompletionStatements(
  database: D1Database,
  input: {
    key: string;
    operation: string;
    requestJson: string;
    response: Record<string, unknown>;
    status: number;
    createdAt: string;
    claimOwner?: IdempotencyClaimOwner | null;
  },
): D1PreparedStatement[] {
  return [
    database.prepare(
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
      ) VALUES (?, ?, ?, ?, ?, 'success', ?, ?, ?)`,
    ).bind(
      input.key,
      input.operation,
      input.requestJson,
      canonicalJson(input.response),
      input.status,
      input.createdAt,
      input.claimOwner?.ownerToken ?? null,
      input.claimOwner?.version ?? null,
    ),
    administrationClaimDeleteStatement(
      database,
      input,
      input.claimOwner ?? null,
    ),
  ];
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
  checks: readonly SourceFreshness[],
  runId: string,
): D1PreparedStatement[] {
  return checks.map((check) =>
    database
      .prepare(
        `INSERT INTO source_freshness (
          game,
          area,
          checked_at,
          ingestion_run_id
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT (game, area) DO UPDATE SET
          checked_at = excluded.checked_at,
          ingestion_run_id = excluded.ingestion_run_id`,
      )
      .bind(check.game, check.area, check.checked_at, runId),
  );
}

function checkedFreshnessAreas(
  games: readonly string[],
  candidate: FixtureCandidate,
  checkedAt = "",
): SourceFreshness[] {
  const capturedChecks = new Map(
    (candidate.source_checks ?? []).map((check) => [
      `${check.game}:${check.area}`,
      check.checked_at,
    ]),
  );
  return games.flatMap((game) => {
    const supported = game as SupportedGame;
    const cardObservedGames =
      candidate.card_observed_games ?? candidate.selected_games;
    return [
      ...(cardObservedGames.includes(supported)
        ? [{
            game: supported,
            area: "cards-and-printings" as const,
            checked_at:
              capturedChecks.get(`${supported}:cards-and-printings`) ??
              checkedAt,
          }]
        : []),
      ...(candidate.product_observed_games?.includes(supported)
        ? [{
            game: supported,
            area: "products-and-releases" as const,
            checked_at:
              capturedChecks.get(`${supported}:products-and-releases`) ??
              checkedAt,
          }]
        : []),
    ];
  });
}

async function sourceFreshnessForExport(
  database: D1Database,
  catalogueGames: readonly SupportedGame[],
  refreshedChecks: readonly SourceFreshness[],
  publishedAt: string,
): Promise<SourceFreshness[]> {
  const prior = await database
    .prepare(
      `SELECT game, area, checked_at
       FROM source_freshness
       WHERE area IN ('cards-and-printings', 'products-and-releases')
       ORDER BY game, area`,
    )
    .all<SourceFreshness>();
  const freshness = new Map<string, SourceFreshness>();
  for (const row of prior.results) {
    if (catalogueGames.includes(row.game)) {
      freshness.set(`${row.game}:${row.area}`, row);
    }
  }
  for (const check of refreshedChecks) {
    if (catalogueGames.includes(check.game)) {
      freshness.set(`${check.game}:${check.area}`, {
        ...check,
        checked_at:
          check.checked_at.length === 0
            ? publishedAt
            : check.checked_at,
      });
    }
  }
  return [...freshness.values()].sort(
    (left, right) =>
      left.game.localeCompare(right.game) ||
      left.area.localeCompare(right.area),
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
            terminal_at = approval_deadline,
            progress_json = json_set(
              progress_json,
              '$.current_stage',
              'expired'
            )
        WHERE state = 'awaiting_approval'
          AND approval_deadline IS NOT NULL
          AND approval_deadline <= ?`,
      )
      .bind(observedAt),
    database.prepare(
      `UPDATE operation_state
      SET active_ingestion_run_id = NULL
      WHERE singleton = 1
        AND active_ingestion_run_id IS NOT NULL
        AND (
          active_ingestion_run_id IN (
            SELECT id
            FROM ingestion_runs
            WHERE state = 'expired'
          )
          OR NOT EXISTS (
            SELECT 1
            FROM ingestion_runs
            WHERE id = operation_state.active_ingestion_run_id
              AND state IN (
                'planning',
                'collecting',
                'parsing',
                'reconciling',
                'awaiting_approval',
                'publishing'
              )
          )
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
  if (
    isRecord(parsed) &&
    parsed.chunked_reconciliation_payload === "candidate"
  ) {
    return {
      fixture: "first-catalogue",
      selected_games: parseSelectedGames(row.selected_games_json),
      cards: [],
      printings: [],
    };
  }
  if (!isFixtureCandidate(parsed)) {
    throw new Error("The persisted fixture candidate is invalid.");
  }
  return parsed;
}

function parseJson(
  value: string,
  description: string,
): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${description} is not valid JSON.`);
  }
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
    !hasRequiredAndAllowedKeys(
      value,
      ["fixture", "selected_games", "cards", "printings"],
      [
        "fixture",
        "selected_games",
        "cards",
        "printings",
        "products",
        "distribution_contexts",
        "product_relationships",
        "card_observed_games",
        "product_observed_games",
        "product_observed_lineages",
      ],
    ) ||
    value.fixture !== "first-catalogue" ||
    !Array.isArray(value.selected_games) ||
    value.selected_games.length === 0 ||
    !value.selected_games.every(isSupportedGame) ||
    !Array.isArray(value.cards) ||
    !Array.isArray(value.printings)
  ) {
    return false;
  }
  const cards = value.cards;
  const cardIds = new Set<string>();
  for (const card of cards) {
    if (
      !isRecord(card) ||
      !hasOnlyKeys(card, [
      "id",
      "game",
      "official_identity",
      "name",
      "effective_rules_text",
      "game_data",
      ]) ||
      typeof card.id !== "string" ||
      !isSupportedGame(card.game) ||
      typeof card.name !== "string" ||
      (card.effective_rules_text !== null &&
        typeof card.effective_rules_text !== "string") ||
      !isRecord(card.official_identity) ||
      !hasOnlyKeys(card.official_identity, ["kind", "value"]) ||
      !validOfficialIdentity(card.official_identity, card.game) ||
      !isRecord(card.game_data) ||
      !hasOnlyKeys(card.game_data, ["profile", "attributes"]) ||
      card.game_data.profile !== `${card.game}@1` ||
      !isRecord(card.game_data.attributes)
    ) {
      return false;
    }
    cardIds.add(card.id);
  }
  const printingsValid = value.printings.every((printing) => {
    if (
      !isRecord(printing) ||
      !hasOnlyKeys(printing, [
        "id",
        "card_id",
        "rarity",
        "printed_rules_text",
        "game_data",
      ]) ||
      typeof printing.id !== "string" ||
      typeof printing.card_id !== "string" ||
      !cardIds.has(printing.card_id) ||
      (printing.printed_rules_text !== null &&
        typeof printing.printed_rules_text !== "string") ||
      !isRecord(printing.rarity) ||
      !hasOnlyKeys(printing.rarity, ["normalized", "raw"]) ||
      (printing.rarity.normalized !== null &&
        typeof printing.rarity.normalized !== "string") ||
      (printing.rarity.raw !== null &&
        typeof printing.rarity.raw !== "string")
    ) {
      return false;
    }
    return (
      printing.game_data === null ||
      (isRecord(printing.game_data) &&
        hasOnlyKeys(printing.game_data, ["profile", "attributes"]) &&
        typeof printing.game_data.profile === "string" &&
        isRecord(printing.game_data.attributes))
    );
  });
  return (
    printingsValid &&
    (value.products === undefined ||
      (Array.isArray(value.products) && value.products.every(isRecord))) &&
    (value.distribution_contexts === undefined ||
      (Array.isArray(value.distribution_contexts) &&
        value.distribution_contexts.every(isRecord))) &&
    (value.product_relationships === undefined ||
      (Array.isArray(value.product_relationships) &&
        value.product_relationships.every(isRecord))) &&
    (value.card_observed_games === undefined ||
      (Array.isArray(value.card_observed_games) &&
        value.card_observed_games.every(isSupportedGame))) &&
    (value.product_observed_games === undefined ||
      (Array.isArray(value.product_observed_games) &&
        value.product_observed_games.every(isSupportedGame))) &&
    (value.product_observed_lineages === undefined ||
      (Array.isArray(value.product_observed_lineages) &&
        value.product_observed_lineages.every(
          (lineage) => typeof lineage === "string" && lineage.length > 0,
        )))
  );
}

function validOfficialIdentity(
  identity: Record<string, unknown>,
  game: SupportedGame,
): boolean {
  return (
    (identity.kind === "card_number" &&
      typeof identity.value === "string" &&
      identity.value.length > 0) ||
    (game === "one-piece" &&
      identity.kind === "functional_designation" &&
      identity.value === "DON!!")
  );
}

function isSupportedGame(value: unknown): value is SupportedGame {
  return (
    value === "one-piece" ||
    value === "fusion-world" ||
    value === "digimon" ||
    value === "gundam"
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

function hasRequiredAndAllowedKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  allowed: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => allowed.includes(key))
  );
}

function parseSelectedGames(value: string): readonly SupportedGame[] {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every(isSupportedGame)
  ) {
    throw new Error("The persisted selected games are invalid.");
  }
  return parsed;
}

function parseProgress(
  value: string,
  expectedState?: string,
): Record<string, unknown> {
  return decodeProgress(
    parseJson(value, "Ingestion Run progress"),
    expectedState,
  );
}

function decodeProgress(
  value: unknown,
  expectedState?: string,
): Record<string, unknown> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["completed_stages", "current_stage"]) ||
    !Array.isArray(value.completed_stages) ||
    value.completed_stages.some(
      (stage) =>
        typeof stage !== "string" ||
        !activeRunStages.some((knownStage) => knownStage === stage),
    ) ||
    value.completed_stages.length > activeRunStages.length ||
    value.completed_stages.some(
      (stage, index) => stage !== activeRunStages[index],
    ) ||
    typeof value.current_stage !== "string" ||
    !runStates.has(value.current_stage) ||
    (expectedState !== undefined &&
      value.current_stage !== expectedState) ||
    !validCompletedStageCount(
      value.current_stage,
      value.completed_stages.length,
    )
  ) {
    throw new Error("The persisted Ingestion Run progress is invalid.");
  }
  return {
    completed_stages: [...value.completed_stages],
    current_stage: value.current_stage,
  };
}

function parseWarnings(value: string): Record<string, unknown>[] {
  return decodeWarnings(
    parseJson(value, "Ingestion Run warnings"),
  );
}

function decodeWarnings(value: unknown): Record<string, unknown>[] {
  if (
    !Array.isArray(value) ||
    value.some((warning) => !isWarningDocument(warning))
  ) {
    throw new Error("The persisted Ingestion Run warnings are invalid.");
  }
  return value;
}

function validCompletedStageCount(
  state: string,
  completedCount: number,
): boolean {
  const activeIndex = activeRunStages.findIndex(
    (knownStage) => knownStage === state,
  );
  if (activeIndex >= 0) return completedCount === activeIndex;
  if (state === "published") {
    return completedCount === activeRunStages.length;
  }
  if (state === "rejected" || state === "expired") {
    return completedCount ===
      activeRunStages.indexOf("awaiting_approval");
  }
  return state === "failed";
}

function isWarningDocument(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    (hasOnlyKeys(value, ["code", "detail"]) ||
      hasOnlyKeys(value, ["code", "detail", "severity"])) &&
    typeof value.code === "string" &&
    value.code.length > 0 &&
    typeof value.detail === "string" &&
    (!("severity" in value) ||
      (typeof value.severity === "string" &&
        ["info", "warning", "error"].includes(value.severity)))
  );
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
  return decodeApproval(
    parseJson(value, "Ingestion Run approval"),
  );
}

function decodeApproval(value: unknown): {
  action: "approved";
  approved_at: string;
  candidate_digest: string;
  expected_current_revision_id: string;
} {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "action",
      "approved_at",
      "candidate_digest",
      "expected_current_revision_id",
    ]) ||
    value.action !== "approved" ||
    !isIsoInstant(value.approved_at) ||
    typeof value.candidate_digest !== "string" ||
    !isSha256Digest(value.candidate_digest) ||
    typeof value.expected_current_revision_id !== "string" ||
    !isOpaqueIdentity(value.expected_current_revision_id)
  ) {
    throw new Error("The persisted Ingestion Run approval is invalid.");
  }
  return {
    action: "approved",
    approved_at: value.approved_at,
    candidate_digest: value.candidate_digest,
    expected_current_revision_id:
      value.expected_current_revision_id,
  };
}

function parseApprovalHistory(
  value: string,
): Record<string, unknown>[] {
  return decodeApprovalHistory(
    parseJson(value, "Ingestion Run approval history"),
  );
}

function decodeApprovalHistory(
  value: unknown,
): Record<string, unknown>[] {
  if (
    !Array.isArray(value) ||
    value.length > 1 ||
    value.some((decision) => !isApprovalDecision(decision))
  ) {
    throw new Error(
      "The persisted Ingestion Run approval history is invalid.",
    );
  }
  return value;
}

function isApprovalDecision(
  value: unknown,
): value is Record<string, unknown> {
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
      isSha256Digest(value.candidate_digest) &&
      typeof value.expected_current_revision_id === "string" &&
      isOpaqueIdentity(value.expected_current_revision_id)
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
    isSha256Digest(value.candidate_digest)
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
  const revisionId = requiredPublicationValue(
    run.publication_revision_id,
    "revision ID",
  );
  const prefix = `catalogue-exports/${revisionId}/`;
  return decodeCleanupKeySet(
    parseJson(value, "Publication cleanup object keys"),
    prefix,
  );
}

function decodeCleanupKeySet(
  value: unknown,
  prefix: string,
): string[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (key) =>
        typeof key !== "string" ||
        key.length <= prefix.length ||
        !key.startsWith(prefix),
    ) ||
    new Set(value).size !== value.length ||
    value.some(
      (key, index) =>
        key !== [...value].sort()[index],
    )
  ) {
    throw new Error(
      "The persisted publication cleanup object keys are invalid.",
    );
  }
  return value;
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
    !selectedGames.every((game) =>
      candidate.selected_games.includes(game),
    )
  ) {
    throw new Error(
      "The persisted Ingestion Run document is inconsistent.",
    );
  }
  return decodePublicRunDocument({
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
  });
}

function publicPublicationReservation(
  row: RunRow,
): Record<string, unknown> | null {
  const values = [
    row.publication_revision_id,
    row.publication_started_at,
    row.publication_reconcile_after,
    row.publication_manifest_digest,
    row.publication_writer_token,
  ];
  return decodePublicationReservation(
    values.every((value) => value === null)
      ? null
      : {
          revision_id: row.publication_revision_id,
          started_at: row.publication_started_at,
          reconcile_after: row.publication_reconcile_after,
          manifest_digest: row.publication_manifest_digest,
          writer_token: row.publication_writer_token,
        },
  );
}

function publicPublicationCleanup(
  cleanup: PublicationCleanupRow | null,
): Record<string, unknown> | null {
  return decodePublicationCleanup(
    cleanup === null
      ? null
      : {
          state: cleanup.state,
          attempts: cleanup.attempts,
          failure_code: cleanup.failure_code,
          last_attempt_at: cleanup.last_attempt_at,
          completed_at: cleanup.completed_at,
          not_before: cleanup.not_before,
          generation: cleanup.claim_version,
        },
  );
}

function decodePublicRunDocument(
  value: unknown,
): Record<string, unknown> {
  const requiredKeys = [
    "id",
    "state",
    "selected_games",
    "started_at",
    "expected_current_revision_id",
    "linked_run_id",
    "idempotency_key",
    "candidate_digest",
    "candidate_created_at",
    "approval_deadline",
    "approval",
    "approval_history",
    "progress",
    "warnings",
    "failure_code",
    "publication_outcome",
    "published_revision_id",
    "resulting_revision_id",
    "freshness_checked_at",
    "terminal_at",
    "publication_reservation",
    "publication_cleanup",
  ];
  if (
    !isRecord(value) ||
    requiredKeys.some((key) => !(key in value)) ||
    Object.keys(value).some(
      (key) =>
        !requiredKeys.includes(key) &&
        key !== "export_manifest_digest",
    ) ||
    typeof value.id !== "string" ||
    !isOpaqueIdentity(value.id) ||
    typeof value.state !== "string" ||
    !runStates.has(value.state) ||
    !Array.isArray(value.selected_games) ||
    value.selected_games.length === 0 ||
    !value.selected_games.every(isSupportedGame) ||
    !isIsoInstant(value.started_at) ||
    typeof value.expected_current_revision_id !== "string" ||
    !isOpaqueIdentity(value.expected_current_revision_id) ||
    !isNullableOpaqueIdentity(value.linked_run_id) ||
    typeof value.idempotency_key !== "string" ||
    !isOpaqueIdentity(value.idempotency_key) ||
    !isNullableSha256(value.candidate_digest) ||
    !isNullableIsoInstant(value.candidate_created_at) ||
    !isNullableIsoInstant(value.approval_deadline) ||
    !isNullableString(value.failure_code) ||
    !isNullableOpaqueIdentity(value.published_revision_id) ||
    !isNullableOpaqueIdentity(value.resulting_revision_id) ||
    !isNullableIsoInstant(value.freshness_checked_at) ||
    !isNullableIsoInstant(value.terminal_at) ||
    !(
      value.publication_outcome === null ||
      value.publication_outcome === "revision" ||
      value.publication_outcome === "no_change"
    ) ||
    ("export_manifest_digest" in value &&
      (typeof value.export_manifest_digest !== "string" ||
        !isSha256Digest(value.export_manifest_digest)))
  ) {
    throw new Error(
      "The persisted administration success outcome is invalid.",
    );
  }
  const progress = decodeProgress(value.progress, value.state);
  const warnings = decodeWarnings(value.warnings);
  const approval =
    value.approval === null
      ? null
      : decodeApproval(value.approval);
  const approvalHistory = decodeApprovalHistory(
    value.approval_history,
  );
  const reservation = decodePublicationReservation(
    value.publication_reservation,
  );
  const cleanup = decodePublicationCleanup(
    value.publication_cleanup,
  );
  assertPublicRunCrossFieldInvariants(value, {
    progress,
    approval,
    approvalHistory,
    reservation,
    cleanup,
  });
  return {
    ...value,
    progress,
    warnings,
    approval,
    approval_history: approvalHistory,
    publication_reservation: reservation,
    publication_cleanup: cleanup,
  };
}

function decodePublicationReservation(
  value: unknown,
): Record<string, unknown> | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "revision_id",
      "started_at",
      "reconcile_after",
      "manifest_digest",
      "writer_token",
    ]) ||
    typeof value.revision_id !== "string" ||
    !isOpaqueIdentity(value.revision_id) ||
    !isIsoInstant(value.started_at) ||
    !isIsoInstant(value.reconcile_after) ||
    Date.parse(value.reconcile_after) <
      Date.parse(value.started_at) ||
    typeof value.manifest_digest !== "string" ||
    !isSha256Digest(value.manifest_digest) ||
    typeof value.writer_token !== "string" ||
    value.writer_token !== publicationWriterToken(value.revision_id)
  ) {
    throw new Error("The persisted publication reservation is invalid.");
  }
  return {
    revision_id: value.revision_id,
    started_at: value.started_at,
    reconcile_after: value.reconcile_after,
    manifest_digest: value.manifest_digest,
    writer_token: value.writer_token,
  };
}

function decodePublicationCleanup(
  value: unknown,
): Record<string, unknown> | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "state",
      "attempts",
      "failure_code",
      "last_attempt_at",
      "completed_at",
      "not_before",
      "generation",
    ]) ||
    typeof value.state !== "string" ||
    !["pending", "cleaning", "completed", "failed"].includes(
      value.state,
    ) ||
    typeof value.attempts !== "number" ||
    !Number.isInteger(value.attempts) ||
    value.attempts < 0 ||
    !isNullableString(value.failure_code) ||
    !isNullableIsoInstant(value.last_attempt_at) ||
    !isNullableIsoInstant(value.completed_at) ||
    !isIsoInstant(value.not_before) ||
    typeof value.generation !== "number" ||
    !Number.isInteger(value.generation) ||
    value.generation < 0 ||
    (value.state === "pending" &&
      (value.attempts !== 0 ||
        value.last_attempt_at !== null ||
        value.completed_at !== null)) ||
    (value.state === "cleaning" &&
      (value.attempts < 1 ||
        value.last_attempt_at === null ||
        value.completed_at !== null)) ||
    (value.state === "failed" &&
      (value.attempts < 1 ||
        value.failure_code === null ||
        value.last_attempt_at === null ||
        value.completed_at !== null)) ||
    (value.state === "completed" &&
      (value.attempts < 1 ||
        value.failure_code !== null ||
        value.last_attempt_at === null ||
        value.completed_at === null))
  ) {
    throw new Error(
      "The persisted publication cleanup state is invalid.",
    );
  }
  return {
    state: value.state,
    attempts: value.attempts,
    failure_code: value.failure_code,
    last_attempt_at: value.last_attempt_at,
    completed_at: value.completed_at,
    not_before: value.not_before,
    generation: value.generation,
  };
}

function assertPublicRunCrossFieldInvariants(
  value: Record<string, unknown>,
  decoded: {
    progress: Record<string, unknown>;
    approval: {
      action: "approved";
      approved_at: string;
      candidate_digest: string;
      expected_current_revision_id: string;
    } | null;
    approvalHistory: Record<string, unknown>[];
    reservation: Record<string, unknown> | null;
    cleanup: Record<string, unknown> | null;
  },
): void {
  const state = value.state;
  const terminal = typeof state === "string" &&
    terminalRunStates.has(state);
  const completedStages = decoded.progress.completed_stages;
  const candidateRequired =
    state === "awaiting_approval" ||
    state === "publishing" ||
    state === "published" ||
    state === "rejected" ||
    state === "expired" ||
    (Array.isArray(completedStages) &&
      completedStages.includes("reconciling"));
  if (
    (terminal && value.terminal_at === null) ||
    (!terminal && value.terminal_at !== null) ||
    (candidateRequired &&
      (typeof value.candidate_digest !== "string" ||
        typeof value.candidate_created_at !== "string" ||
        typeof value.approval_deadline !== "string" ||
        Date.parse(value.approval_deadline) -
          Date.parse(value.candidate_created_at) !==
          sevenDaysInMilliseconds)) ||
    (!candidateRequired &&
      (value.candidate_digest !== null ||
        value.candidate_created_at !== null ||
        value.approval_deadline !== null)) ||
    (decoded.approval !== null &&
      (decoded.approval.candidate_digest !==
        value.candidate_digest ||
        decoded.approval.expected_current_revision_id !==
          value.expected_current_revision_id ||
        typeof value.approval_deadline !== "string" ||
        Date.parse(decoded.approval.approved_at) >=
          Date.parse(value.approval_deadline) ||
        !["publishing", "published", "failed"].includes(
          String(state),
        ) ||
        decoded.approvalHistory.length !== 1 ||
        canonicalJson(decoded.approvalHistory[0]) !==
          canonicalJson(decoded.approval))) ||
    (decoded.approval === null &&
      decoded.approvalHistory.some(
        (decision) => decision.action === "approved",
      )) ||
    decoded.approvalHistory.some(
      (decision) =>
        decision.candidate_digest !== value.candidate_digest,
    ) ||
    (state === "rejected" &&
      (decoded.approvalHistory.length !== 1 ||
        decoded.approvalHistory[0]?.action !== "rejected")) ||
    (state !== "rejected" &&
      decoded.approvalHistory.some(
        (decision) => decision.action === "rejected",
      )) ||
    (state === "expired" &&
      decoded.approvalHistory.length !== 0) ||
    (decoded.reservation !== null &&
      (decoded.approval === null ||
        !["publishing", "published", "failed"].includes(
          String(state),
        ) ||
        decoded.reservation.started_at !==
          decoded.approval.approved_at ||
        typeof decoded.reservation.started_at !== "string" ||
        typeof decoded.reservation.reconcile_after !== "string" ||
        Date.parse(decoded.reservation.reconcile_after) -
          Date.parse(decoded.reservation.started_at) !==
          publicationLeaseMilliseconds)) ||
    (state === "publishing" &&
      (decoded.approval === null ||
        decoded.reservation === null)) ||
    (decoded.cleanup !== null &&
      (state !== "failed" ||
        decoded.reservation === null ||
        typeof decoded.cleanup.not_before !== "string" ||
        typeof decoded.reservation.reconcile_after !== "string" ||
        typeof value.terminal_at !== "string" ||
        Date.parse(decoded.cleanup.not_before) -
          Math.max(
            Date.parse(decoded.reservation.reconcile_after),
            Date.parse(value.terminal_at),
          ) !==
          publicationLeaseMilliseconds)) ||
    (state === "failed" &&
      decoded.reservation !== null &&
      decoded.cleanup === null) ||
    (state === "failed" &&
      (decoded.approval === null) !==
        (decoded.reservation === null)) ||
    (state === "failed" &&
      (typeof value.failure_code !== "string" ||
        value.failure_code.length === 0)) ||
    (state !== "failed" && value.failure_code !== null) ||
    !validPublicationOutcome(value, decoded)
  ) {
    throw new Error(
      "The persisted Ingestion Run document is inconsistent.",
    );
  }
}

function validPublicationOutcome(
  value: Record<string, unknown>,
  decoded: {
    approval: Record<string, unknown> | null;
    reservation: Record<string, unknown> | null;
  },
): boolean {
  if (value.state !== "published") {
    return (
      value.publication_outcome === null &&
      value.published_revision_id === null &&
      value.resulting_revision_id === null &&
      !("export_manifest_digest" in value) &&
      value.freshness_checked_at === null
    );
  }
  if (
    decoded.approval === null ||
    value.terminal_at === null ||
    value.freshness_checked_at === null
  ) {
    return false;
  }
  if (value.publication_outcome === "no_change") {
    return (
      decoded.reservation === null &&
      value.published_revision_id === null &&
      value.resulting_revision_id ===
        value.expected_current_revision_id &&
      !("export_manifest_digest" in value)
    );
  }
  return (
    value.publication_outcome === "revision" &&
    decoded.reservation !== null &&
    value.published_revision_id ===
      decoded.reservation.revision_id &&
    value.resulting_revision_id ===
      decoded.reservation.revision_id &&
    value.export_manifest_digest ===
      decoded.reservation.manifest_digest
  );
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isNullableIsoInstant(value: unknown): boolean {
  return value === null || isIsoInstant(value);
}

function isNullableOpaqueIdentity(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "string" && isOpaqueIdentity(value))
  );
}

function isNullableSha256(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "string" && isSha256Digest(value))
  );
}

function isOpaqueIdentity(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  );
}

function isSha256Digest(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function progressFor(state: string): Record<string, unknown> {
  const position = activeRunStages.findIndex(
    (knownStage) => knownStage === state,
  );
  if (position >= 0) {
    return {
      completed_stages: activeRunStages.slice(0, position),
      current_stage: state,
    };
  }
  return {
    completed_stages: [...activeRunStages],
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
  if (!isOpaqueIdentity(value)) {
    throw new AdministrationProblem(
      422,
      "invalid_parameter",
      `${field} is not a valid opaque identity.`,
    );
  }
}

function assertSha256(value: string, field: string): void {
  if (!isSha256Digest(value)) {
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
