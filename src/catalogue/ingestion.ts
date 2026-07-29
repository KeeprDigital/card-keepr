import { buildCatalogueExport } from "./export";
import {
  FixtureInputError,
  fixtureCandidate,
  type FixtureCandidate,
} from "./fixture";
import { canonicalJson, sha256 } from "./serialization";

const sevenDaysInMilliseconds = 7 * 24 * 60 * 60 * 1_000;
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
};

type FreshnessRow = {
  game: string;
  area: string;
  checked_at: string;
  ingestion_run_id: string;
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

export async function startFixtureRun(
  database: D1Database,
  request: StartRunRequest,
): Promise<Record<string, unknown>> {
  assertOpaqueId(request.idempotency_key, "idempotency_key");
  const requestJson = canonicalJson({
    fixture: request.fixture,
    selected_games: request.selected_games,
  });
  const replay = await replayAdministration(
    database,
    request.idempotency_key,
    "start_ingestion_run",
    requestJson,
  );
  if (replay !== null) return replay;

  const candidate = await validatedFixtureCandidate(request);
  return startPreparedRun(database, {
    candidate: candidate.candidate,
    candidateDigest: candidate.digest,
    idempotencyKey: request.idempotency_key,
    idempotencyOperation: "start_ingestion_run",
    idempotencyRequestJson: requestJson,
    linkedRunId: null,
  });
}

export async function retryRun(
  database: D1Database,
  sourceRunId: string,
  request: RetryRunRequest,
): Promise<Record<string, unknown>> {
  assertOpaqueId(sourceRunId, "run_id");
  assertOpaqueId(request.idempotency_key, "idempotency_key");
  const requestJson = canonicalJson({ source_run_id: sourceRunId });
  const replay = await replayAdministration(
    database,
    request.idempotency_key,
    "retry_ingestion_run",
    requestJson,
  );
  if (replay !== null) return replay;

  await expireOverdueRuns(database, new Date().toISOString());
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
  });
}

export async function showRun(
  database: D1Database,
  runId: string,
): Promise<Record<string, unknown>> {
  assertOpaqueId(runId, "run_id");
  await expireOverdueRuns(database, new Date().toISOString());
  return publicRun(await requiredRun(database, runId));
}

export async function administrationStatus(
  database: D1Database,
): Promise<Record<string, unknown>> {
  await expireOverdueRuns(database, new Date().toISOString());
  const [
    catalogue,
    operation,
    freshness,
    recentRuns,
    revisionCount,
    exportCount,
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
    ]);
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
    active_ingestion_run: active === null ? null : publicRun(active),
    source_freshness: freshness.results,
    diagnostics: {
      catalogue_revision_count: revisionCount?.count ?? 0,
      catalogue_export_count: exportCount?.count ?? 0,
    },
    recent_runs: recentRuns.results.map(publicRun),
  };
}

export async function inspectCandidate(
  database: D1Database,
  runId: string,
): Promise<Record<string, unknown>> {
  assertOpaqueId(runId, "run_id");
  await expireOverdueRuns(database, new Date().toISOString());
  const row = await requiredRun(database, runId);
  if (row.state !== "awaiting_approval") {
    throw new AdministrationProblem(
      409,
      "candidate_not_approvable",
      "The Ingestion Run does not have a candidate awaiting approval.",
    );
  }
  const candidate = parseCandidate(row);
  const warnings = parseJsonArray(row.warnings_json);
  return {
    run_id: row.id,
    candidate_digest: row.candidate_digest,
    expected_current_revision_id: row.expected_current_revision_id,
    candidate_created_at: row.candidate_created_at,
    approval_deadline: row.approval_deadline,
    progress: JSON.parse(row.progress_json),
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
  const replay = await replayAdministration(
    database,
    request.idempotency_key,
    "approve_ingestion_run",
    requestJson,
  );
  if (replay !== null) return replay;

  const now = new Date().toISOString();
  await expireOverdueRuns(database, now);
  const run = await requiredRun(database, runId);
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
  const resultingRun = publicRun({
    ...run,
    state: "published",
    approval_json: JSON.stringify(approval),
    approval_idempotency_key: request.idempotency_key,
    approval_history_json: JSON.stringify([approval]),
    published_revision_id: revisionId,
    export_manifest_digest:
      catalogueExport.manifest.manifest_sha256,
    terminal_at: now,
    progress_json: JSON.stringify(progressFor("published")),
    publication_outcome: "revision",
    resulting_revision_id: revisionId,
    freshness_checked_at: now,
  });

  try {
    await storeAndVerifyExport(catalogueExports, catalogueExport.objects);
    const cardDocument = catalogueCard(candidate, revisionId);
    const printingDocument = cataloguePrinting(candidate, revisionId);
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
          run.id,
          now,
          request.candidate_digest,
          request.expected_current_revision_id,
          request.candidate_digest,
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
          candidate.cards[0].id,
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
          candidate.printings[0].id,
          candidate.printings[0].card_id,
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
        .bind(
          revisionId,
          catalogueExport.manifestKey,
          catalogueExport.manifest.manifest_sha256,
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
      database
        .prepare(
          `UPDATE catalogue_state
          SET current_revision_id = ?, published_at = ?
          WHERE singleton = 1
            AND current_revision_id = ?`,
        )
        .bind(
          revisionId,
          now,
          request.expected_current_revision_id,
        ),
      ...freshnessStatements(database, candidate.selected_games, run.id, now),
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
          catalogueExport.manifest.manifest_sha256,
          now,
          JSON.stringify(progressFor("published")),
          revisionId,
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

export async function rejectRun(
  database: D1Database,
  runId: string,
  request: RejectRunRequest,
): Promise<Record<string, unknown>> {
  assertOpaqueId(runId, "run_id");
  assertSha256(request.candidate_digest, "candidate_digest");
  assertOpaqueId(request.idempotency_key, "idempotency_key");
  const requestJson = canonicalJson({
    run_id: runId,
    candidate_digest: request.candidate_digest,
  });
  const replay = await replayAdministration(
    database,
    request.idempotency_key,
    "reject_ingestion_run",
    requestJson,
  );
  if (replay !== null) return replay;

  const now = new Date().toISOString();
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
  const resultingRun = publicRun({
    ...run,
    state: "rejected",
    terminal_at: now,
    progress_json: JSON.stringify(progressFor("rejected")),
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
          JSON.stringify(progressFor("rejected")),
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
  },
): Promise<Record<string, unknown>> {
  await expireOverdueRuns(database, new Date().toISOString());
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

  const startedAt = new Date().toISOString();
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
  await expireOverdueRuns(database, new Date().toISOString());
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

async function replayAdministration(
  database: D1Database,
  key: string,
  operation: string,
  requestJson: string,
): Promise<Record<string, unknown> | null> {
  const prior = await database
    .prepare(
      `SELECT operation, request_json, response_json, http_status
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
  return JSON.parse(prior.response_json) as Record<string, unknown>;
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
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
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
            progress_json = ?
        WHERE state = 'awaiting_approval'
          AND approval_deadline IS NOT NULL
          AND approval_deadline <= ?`,
      )
      .bind(
        observedAt,
        JSON.stringify(progressFor("expired")),
        observedAt,
      ),
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
            progress_json = ?
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
        JSON.stringify(progressFor("failed")),
        runId,
      ),
    releaseRunLockStatement(database, runId),
  ]);
}

function parseCandidate(row: RunRow): FixtureCandidate {
  return JSON.parse(row.candidate_json) as FixtureCandidate;
}

function parseJsonArray(value: string): unknown[] {
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed : [];
}

function publicRun(row: RunRow): Record<string, unknown> {
  return {
    id: row.id,
    state: row.state,
    selected_games: JSON.parse(row.selected_games_json),
    started_at: row.started_at,
    expected_current_revision_id: row.expected_current_revision_id,
    linked_run_id: row.linked_run_id,
    idempotency_key: row.idempotency_key,
    candidate_digest: row.candidate_digest,
    candidate_created_at: row.candidate_created_at,
    approval_deadline: row.approval_deadline,
    approval:
      row.approval_json === null ? null : JSON.parse(row.approval_json),
    approval_history: parseJsonArray(row.approval_history_json),
    progress: JSON.parse(row.progress_json),
    warnings: parseJsonArray(row.warnings_json),
    failure_code: row.failure_code,
    publication_outcome: row.publication_outcome,
    published_revision_id: row.published_revision_id,
    resulting_revision_id: row.resulting_revision_id,
    ...(row.export_manifest_digest === null
      ? {}
      : { export_manifest_digest: row.export_manifest_digest }),
    freshness_checked_at: row.freshness_checked_at,
    terminal_at: row.terminal_at,
  };
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
