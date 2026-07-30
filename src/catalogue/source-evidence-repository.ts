import { AdministrationProblem } from "./ingestion";
import { canonicalJson, sha256, utf8 } from "./serialization";
import {
  assertIdentifier,
  parseEvidencePlans,
  parseStringRecord,
  type EvidencePlan,
  type StartEvidenceRunRequest,
  validateEvidencePlans,
} from "./source-evidence-model";
import type { SourceAdapterRegistration } from "./source-adapters";

export type IngestionEvidenceRow = {
  id: string;
  state: string;
  selected_games_json: string;
  started_at: string;
  expected_current_revision_id: string;
  linked_run_id: string | null;
  idempotency_key: string;
  terminal_at: string | null;
  source_lineage: string;
  supported_game: string;
  game_profile_version: string;
  adapter_version: string;
  plan_origin: SourceAdapterRegistration["origin"];
  request_plan_json: string;
  parent_workflow_id: string | null;
  child_workflow_ids_json: string | null;
  collection_completed_at: string | null;
  failure_code: string | null;
};

export type EvidenceRequestRow = {
  ingestion_run_id: string;
  request_id: string;
  sequence_number: number;
  method: "GET";
  url: string;
  request_headers_json: string;
  representation_fingerprint: string;
  state: "pending" | "captured" | "observed" | "failed";
  source_snapshot_id: string | null;
  failure_code: string | null;
  request_role:
    | "surface"
    | "listing"
    | "detail"
    | "product_detail"
    | "image";
  discovered_from_request_id: string | null;
};

export type DiscoveredEvidenceRequest = {
  role: Exclude<EvidenceRequestRow["request_role"], "surface">;
  url: string;
  headers: Record<string, string>;
};

export type SnapshotRow = {
  id: string;
  ingestion_run_id: string;
  request_id: string;
  fetch_attempt_id: string;
  request_method: string;
  request_url: string;
  request_headers_json: string;
  representation_fingerprint: string;
  response_vary_json: string;
  retrieved_at: string;
  http_status: number;
  response_headers_json: string;
  media_type: string | null;
  content_digest: string;
  content_byte_length: number;
  content_object_key: string;
  source_lineage: string;
  supported_game: string;
  game_profile_version: string;
  adapter_version: string;
  reused_source_snapshot_id: string | null;
};

export type ObservationSetRow = {
  id: string;
  source_snapshot_id: string;
  source_lineage: string;
  supported_game: string;
  game_profile_version: string;
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

export async function startEvidenceRun(
  database: D1Database,
  request: StartEvidenceRunRequest,
  planOrigin: SourceAdapterRegistration["origin"] = "production",
): Promise<Record<string, unknown>> {
  const plans = await validateEvidencePlans(request, planOrigin);
  const firstPlan = plans[0]!;
  const planJson = canonicalJson(
    plans.length === 1 ? firstPlan : { plans },
  );
  const replay = await evidenceRunByIdempotencyKey(
    database,
    request.idempotency_key,
  );
  if (replay !== null) {
    if (replay.request_plan_json !== planJson) {
      throw new AdministrationProblem(
        409,
        "idempotency_key_reused",
        "The idempotency key was already used for a different Ingestion Run.",
      );
    }
    return showEvidenceRun(database, replay.id);
  }

  const runId = `run_${crypto.randomUUID()}`;
  const startedAt = new Date().toISOString();
  const catalogue = await database
    .prepare(
      `SELECT catalogue.current_revision_id, operation.recovery_health
       FROM catalogue_state AS catalogue
       JOIN operation_state AS operation ON operation.singleton = 1
       WHERE catalogue.singleton = 1`,
    )
    .first<{ current_revision_id: string; recovery_health: string }>();
  if (catalogue === null) throw new Error("Catalogue state is unavailable");
  assertRecoveryHealthy(catalogue.recovery_health);
  const statements: D1PreparedStatement[] = [
    await ingestionRunInsert(database, {
      runId,
      supportedGames: [
        ...new Set(plans.map(({ supported_game }) => supported_game)),
      ].sort(),
      startedAt,
      linkedRunId: null,
      idempotencyKey: request.idempotency_key,
    }),
    database
      .prepare(
        `INSERT INTO ingestion_evidence_plans (
          ingestion_run_id, source_lineage, supported_game,
          game_profile_version, adapter_version, request_plan_json,
          plan_origin
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        runId,
        firstPlan.source_lineage,
        firstPlan.supported_game,
        firstPlan.game_profile_version,
        firstPlan.adapter_version,
        planJson,
        planOrigin,
      ),
    ...requestStatements(database, runId, plans),
    database
      .prepare(
        `UPDATE operation_state
         SET active_ingestion_run_id = ?
         WHERE singleton = 1
           AND recovery_health = 'healthy'
           AND active_ingestion_run_id IS NULL`,
      )
      .bind(runId),
  ];
  try {
    await database.batch(statements);
  } catch (error) {
    const concurrent = await evidenceRunByIdempotencyKey(
      database,
      request.idempotency_key,
    );
    if (concurrent !== null && concurrent.request_plan_json === planJson) {
      return showEvidenceRun(database, concurrent.id);
    }
    await throwIfRecoveryBlocked(database);
    await throwIfAnotherRunActive(database);
    if (errorMessage(error).includes("active_ingestion_run")) {
      throw activeRunProblem();
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
    if (errorMessage(error).includes("ingestion_runs.idempotency_key")) {
      throw new AdministrationProblem(
        409,
        "idempotency_key_reused",
        "The idempotency key was already used for a different Ingestion Run.",
      );
    }
    throw error;
  }
  return showEvidenceRun(database, runId);
}

export async function retryEvidenceRun(
  database: D1Database,
  sourceRunId: string,
  idempotencyKey: string,
): Promise<Record<string, unknown>> {
  assertIdentifier(idempotencyKey, "idempotency_key");
  const source = await requiredEvidenceRun(database, sourceRunId);
  if (!["failed", "rejected", "expired"].includes(source.state)) {
    throw new AdministrationProblem(
      409,
      "ingestion_run_not_retryable",
      "Only a failed, rejected, or expired evidence Ingestion Run can be retried.",
    );
  }
  const replay = await evidenceRunByIdempotencyKey(database, idempotencyKey);
  if (replay !== null) {
    if (replay.linked_run_id !== source.id) {
      throw new AdministrationProblem(
        409,
        "idempotency_key_reused",
        "The idempotency key was already used for a different Ingestion Run.",
      );
    }
    return showEvidenceRun(database, replay.id);
  }
  const plans = parseEvidencePlans(source.request_plan_json);
  const firstPlan = plans[0]!;
  const operation = await database
    .prepare(
      "SELECT recovery_health FROM operation_state WHERE singleton = 1",
    )
    .first<{ recovery_health: string }>();
  if (operation === null) throw new Error("Operation state is unavailable.");
  assertRecoveryHealthy(operation.recovery_health);
  const runId = `run_${crypto.randomUUID()}`;
  const startedAt = new Date().toISOString();
  try {
    await database.batch([
      await ingestionRunInsert(database, {
        runId,
        supportedGames: [
          ...new Set(plans.map(({ supported_game }) => supported_game)),
        ].sort(),
        startedAt,
        linkedRunId: source.id,
        idempotencyKey,
      }),
      database
        .prepare(
          `INSERT INTO ingestion_evidence_plans (
            ingestion_run_id, source_lineage, supported_game,
            game_profile_version, adapter_version, request_plan_json,
            plan_origin
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          runId,
          firstPlan.source_lineage,
          firstPlan.supported_game,
          firstPlan.game_profile_version,
          firstPlan.adapter_version,
          source.request_plan_json,
          source.plan_origin,
        ),
      ...requestStatements(database, runId, plans),
      database
        .prepare(
          `UPDATE operation_state
           SET active_ingestion_run_id = ?
           WHERE singleton = 1
             AND recovery_health = 'healthy'
             AND active_ingestion_run_id IS NULL`,
        )
        .bind(runId),
    ]);
  } catch (error) {
    await throwIfRecoveryBlocked(database);
    await throwIfAnotherRunActive(database);
    if (errorMessage(error).includes("active_ingestion_run")) {
      throw activeRunProblem();
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
    if (errorMessage(error).includes("ingestion_runs.idempotency_key")) {
      throw new AdministrationProblem(
        409,
        "idempotency_key_reused",
        "The idempotency key was already used for a different Ingestion Run.",
      );
    }
    throw error;
  }
  return showEvidenceRun(database, runId);
}

function assertRecoveryHealthy(recoveryHealth: string): void {
  if (recoveryHealth !== "healthy") {
    throw new AdministrationProblem(
      409,
      "recovery_not_verified",
      "Recovery is not healthy, so evidence ingestion is blocked.",
    );
  }
}

async function throwIfRecoveryBlocked(database: D1Database): Promise<void> {
  const operation = await database
    .prepare(
      "SELECT recovery_health FROM operation_state WHERE singleton = 1",
    )
    .first<{ recovery_health: string }>();
  if (operation === null) throw new Error("Operation state is unavailable.");
  assertRecoveryHealthy(operation.recovery_health);
}

async function throwIfAnotherRunActive(database: D1Database): Promise<void> {
  const operation = await database
    .prepare(
      `SELECT active_ingestion_run_id
       FROM operation_state
       WHERE singleton = 1`,
    )
    .first<{ active_ingestion_run_id: string | null }>();
  if (operation === null) throw new Error("Operation state is unavailable.");
  if (operation.active_ingestion_run_id !== null) {
    throw activeRunProblem();
  }
}

function activeRunProblem(): AdministrationProblem {
  return new AdministrationProblem(
    409,
    "active_ingestion_run",
    "Another Ingestion Run is already active.",
  );
}

function requestStatements(
  database: D1Database,
  runId: string,
  plans: readonly EvidencePlan[],
): D1PreparedStatement[] {
  return plans
    .flatMap(({ requests }) => requests)
    .map((sourceRequest, sequenceNumber) =>
      database
        .prepare(
          `INSERT INTO source_requests (
            ingestion_run_id, request_id, sequence_number, method, url,
            request_headers_json, representation_fingerprint, state,
            source_snapshot_id, failure_code
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL)`,
        )
        .bind(
          runId,
          sourceRequest.id,
          sequenceNumber,
          sourceRequest.method,
          sourceRequest.url,
          canonicalJson(sourceRequest.headers),
          sourceRequest.representation_fingerprint,
        ),
    );
}

export function evidencePlanForRequest(
  run: Pick<IngestionEvidenceRow, "request_plan_json">,
  requestId: string,
): EvidencePlan {
  const matches = parseEvidencePlans(run.request_plan_json).filter((plan) =>
    plan.requests.some(({ id }) => id === requestId),
  );
  if (matches.length === 0) {
    const lineage = requestId.split(":", 1)[0]!;
    const dynamicMatches = parseEvidencePlans(run.request_plan_json).filter(
      (plan) => plan.source_lineage === lineage,
    );
    if (dynamicMatches.length === 1) return dynamicMatches[0]!;
  }
  if (matches.length !== 1) {
    throw new Error(
      `Source Request ${requestId} does not have exactly one Evidence Plan.`,
    );
  }
  return matches[0]!;
}

export async function appendDiscoveredEvidenceRequests(
  database: D1Database,
  run: Pick<IngestionEvidenceRow, "id" | "request_plan_json">,
  parent: EvidenceRequestRow,
  discovered: readonly DiscoveredEvidenceRequest[],
): Promise<readonly EvidenceRequestRow[]> {
  const plan = evidencePlanForRequest(run, parent.request_id);
  const count = await database
    .prepare(
      `SELECT COUNT(*) AS count
       FROM source_requests
       WHERE ingestion_run_id = ?`,
    )
    .bind(run.id)
    .first<{ count: number }>();
  if (
    count === null ||
    count.count + discovered.length > 5_000
  ) {
    throw new AdministrationProblem(
      422,
      "source_discovery_too_large",
      "The Official Source request graph exceeds its bounded request limit.",
    );
  }
  const inserted: EvidenceRequestRow[] = [];
  for (const request of discovered) {
    const digest = await sha256(
      utf8(
        canonicalJson({
          source_lineage: plan.source_lineage,
          role: request.role,
          method: "GET",
          url: new URL(request.url).href,
          headers: request.headers,
        }),
      ),
    );
    const requestId = `${plan.source_lineage}:${request.role}:${digest}`;
    const representationFingerprint = await sha256(
      utf8(
        canonicalJson({
          method: "GET",
          url: new URL(request.url).href,
          headers: request.headers,
        }),
      ),
    );
    const sequenceNumber =
      1_000_000 + Number.parseInt(digest.slice(0, 12), 16);
    await database
      .prepare(
        `INSERT OR IGNORE INTO source_requests (
          ingestion_run_id, request_id, sequence_number, method, url,
          request_headers_json, representation_fingerprint, state,
          source_snapshot_id, failure_code, request_role,
          discovered_from_request_id
        ) VALUES (?, ?, ?, 'GET', ?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
      )
      .bind(
        run.id,
        requestId,
        sequenceNumber,
        new URL(request.url).href,
        canonicalJson(request.headers),
        representationFingerprint,
        request.role,
        parent.request_id,
      )
      .run();
    const retained = await database
      .prepare(
        `SELECT * FROM source_requests
         WHERE ingestion_run_id = ? AND request_id = ?`,
      )
      .bind(run.id, requestId)
      .first<EvidenceRequestRow>();
    if (
      retained === null ||
      retained.url !== new URL(request.url).href ||
      retained.request_headers_json !== canonicalJson(request.headers) ||
      retained.request_role !== request.role
    ) {
      throw new Error(
        "Discovered Source Request identity collided with different immutable evidence.",
      );
    }
    inserted.push(retained);
  }
  return inserted;
}

export async function requiredEvidenceRun(
  database: D1Database,
  runId: string,
): Promise<IngestionEvidenceRow> {
  assertIdentifier(runId, "run_id");
  const row = await database
    .prepare(
      `SELECT runs.*, plans.source_lineage, plans.supported_game,
              plans.game_profile_version, plans.adapter_version,
              plans.request_plan_json, plans.plan_origin,
              plans.parent_workflow_id,
              plans.child_workflow_ids_json,
              plans.collection_completed_at, plans.failure_code
       FROM ingestion_runs AS runs
       JOIN ingestion_evidence_plans AS plans
         ON plans.ingestion_run_id = runs.id
       WHERE runs.id = ?`,
    )
    .bind(runId)
    .first<IngestionEvidenceRow>();
  if (row === null) {
    throw new AdministrationProblem(
      404,
      "ingestion_evidence_not_found",
      "The requested Ingestion Run has no evidence plan.",
    );
  }
  return row;
}

async function evidenceRunByIdempotencyKey(
  database: D1Database,
  key: string,
): Promise<IngestionEvidenceRow | null> {
  return database
    .prepare(
      `SELECT runs.*, plans.source_lineage, plans.supported_game,
              plans.game_profile_version, plans.adapter_version,
              plans.request_plan_json, plans.plan_origin,
              plans.parent_workflow_id,
              plans.child_workflow_ids_json,
              plans.collection_completed_at, plans.failure_code
       FROM ingestion_runs AS runs
       JOIN ingestion_evidence_plans AS plans
         ON plans.ingestion_run_id = runs.id
       WHERE runs.idempotency_key = ?`,
    )
    .bind(key)
    .first<IngestionEvidenceRow>();
}

export async function pendingEvidenceRequests(
  database: D1Database,
  runId: string,
  hostname?: string,
): Promise<EvidenceRequestRow[]> {
  const result = await database
    .prepare(
      `SELECT * FROM source_requests
       WHERE ingestion_run_id = ? AND state IN ('pending', 'captured')
       ORDER BY sequence_number`,
    )
    .bind(runId)
    .all<EvidenceRequestRow>();
  return hostname === undefined
    ? result.results
    : result.results.filter((row) => new URL(row.url).hostname === hostname);
}

export async function recordWorkflowIds(
  database: D1Database,
  runId: string,
  parentWorkflowId: string,
  childWorkflowIds: readonly string[],
): Promise<void> {
  await database
    .prepare(
      `UPDATE ingestion_evidence_plans
       SET parent_workflow_id = ?, child_workflow_ids_json = ?
       WHERE ingestion_run_id = ?
         AND (parent_workflow_id IS NULL OR parent_workflow_id = ?)`,
    )
    .bind(
      parentWorkflowId,
      canonicalJson(childWorkflowIds),
      runId,
      parentWorkflowId,
    )
    .run();
}

export async function finalizeEvidenceRun(
  database: D1Database,
  runId: string,
): Promise<void> {
  const counts = await database
    .prepare(
      `SELECT
        SUM(CASE WHEN state IN ('pending', 'captured') THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM source_requests WHERE ingestion_run_id = ?`,
    )
    .bind(runId)
    .first<{ active: number | null; failed: number | null }>();
  if (counts === null || (counts.active ?? 0) > 0) return;
  const completedAt = new Date().toISOString();
  const lifecycleV2 = await supportsLifecycleV2(database);
  if ((counts.failed ?? 0) > 0) {
    const failure = await database
      .prepare(
        `SELECT failure_code FROM source_requests
         WHERE ingestion_run_id = ? AND state = 'failed'
         ORDER BY sequence_number LIMIT 1`,
      )
      .bind(runId)
      .first<{ failure_code: string | null }>();
    const failureCode = failure?.failure_code ?? "source_evidence_failed";
    await database.batch([
      lifecycleV2
        ? database
            .prepare(
              `UPDATE ingestion_runs
               SET state = 'failed', terminal_at = ?, failure_code = ?,
                   progress_json =
                     '{"completed_stages":["planning"],"current_stage":"failed"}'
               WHERE id = ? AND state = 'collecting'`,
            )
            .bind(completedAt, failureCode, runId)
        : database
            .prepare(
              `UPDATE ingestion_runs
               SET state = 'failed', terminal_at = ?
               WHERE id = ? AND state = 'collecting'`,
            )
            .bind(completedAt, runId),
      database
        .prepare(
          `UPDATE ingestion_evidence_plans
           SET collection_completed_at = ?, failure_code = ?
           WHERE ingestion_run_id = ?`,
        )
        .bind(completedAt, failureCode, runId),
      database
        .prepare(
          `UPDATE operation_state SET active_ingestion_run_id = NULL
           WHERE singleton = 1 AND active_ingestion_run_id = ?`,
        )
        .bind(runId),
    ]);
    return;
  }
  await database.batch([
    lifecycleV2
      ? database
          .prepare(
            `UPDATE ingestion_runs
             SET state = 'parsing',
                 progress_json =
                   '{"completed_stages":["planning","collecting"],"current_stage":"parsing"}'
             WHERE id = ? AND state = 'collecting'`,
          )
          .bind(runId)
      : database
          .prepare(
            `UPDATE ingestion_runs SET state = 'parsing'
             WHERE id = ? AND state = 'collecting'`,
          )
          .bind(runId),
    database
      .prepare(
        `UPDATE ingestion_evidence_plans
         SET collection_completed_at = ?, failure_code = NULL
         WHERE ingestion_run_id = ?`,
      )
      .bind(completedAt, runId),
  ]);
}

export async function showEvidenceRun(
  database: D1Database,
  runId: string,
): Promise<Record<string, unknown>> {
  const run = await requiredEvidenceRun(database, runId);
  const evidencePlans = parseEvidencePlans(run.request_plan_json);
  const [snapshots, observations, attempts] = await Promise.all([
    database
      .prepare(
        `SELECT * FROM source_snapshots
         WHERE ingestion_run_id = ? ORDER BY retrieved_at, id`,
      )
      .bind(runId)
      .all<SnapshotRow>(),
    database
      .prepare(
        `SELECT observations.* FROM source_observation_sets AS observations
         JOIN source_snapshots AS snapshots
           ON snapshots.id = observations.source_snapshot_id
         WHERE snapshots.ingestion_run_id = ?
         ORDER BY observations.parsed_at, observations.id`,
      )
      .bind(runId)
      .all<ObservationSetRow>(),
    database
      .prepare(
        `SELECT * FROM source_fetch_attempts
         WHERE ingestion_run_id = ? ORDER BY request_id, attempt_number`,
      )
      .bind(runId)
      .all<AttemptRow>(),
  ]);
  return {
    id: run.id,
    state: run.state,
    selected_games: JSON.parse(run.selected_games_json),
    evidence_plans: evidencePlans,
    ...(evidencePlans.length === 1
      ? {
          supported_game: run.supported_game,
          game_profile_version: run.game_profile_version,
          source_lineage: run.source_lineage,
          adapter_version: run.adapter_version,
        }
      : {}),
    plan_origin: run.plan_origin,
    idempotency_key: run.idempotency_key,
    linked_run_id: run.linked_run_id,
    expected_current_revision_id: run.expected_current_revision_id,
    started_at: run.started_at,
    collection_completed_at: run.collection_completed_at,
    failure_code: run.failure_code,
    workflow: {
      parent_id: run.parent_workflow_id,
      child_ids:
        run.child_workflow_ids_json === null
          ? []
          : JSON.parse(run.child_workflow_ids_json),
    },
    snapshots: snapshots.results.map(publicSnapshot),
    observation_sets: observations.results.map(publicObservationSet),
    diagnostics: attempts.results.map((row) => ({
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
    })),
  };
}

export function publicSnapshot(row: SnapshotRow): Record<string, unknown> {
  return {
    id: row.id,
    request: {
      method: row.request_method,
      url: row.request_url,
      headers: parseStringRecord(row.request_headers_json),
      representation_fingerprint: row.representation_fingerprint,
    },
    retrieval: {
      retrieved_at: row.retrieved_at,
      fetch_attempt_id: row.fetch_attempt_id,
    },
    http: {
      status: row.http_status,
      headers: parseStringRecord(row.response_headers_json),
      vary: JSON.parse(row.response_vary_json),
    },
    content: {
      digest: row.content_digest,
      byte_length: row.content_byte_length,
      object_key: row.content_object_key,
      media_type: row.media_type,
    },
    source_lineage: row.source_lineage,
    supported_game: row.supported_game,
    game_profile_version: row.game_profile_version,
    adapter_version: row.adapter_version,
    ingestion_run_id: row.ingestion_run_id,
    reused_source_snapshot_id: row.reused_source_snapshot_id,
  };
}

export function publicObservationSet(
  row: ObservationSetRow,
): Record<string, unknown> {
  return {
    id: row.id,
    source_snapshot_id: row.source_snapshot_id,
    source_lineage: row.source_lineage,
    supported_game: row.supported_game,
    game_profile_version: row.game_profile_version,
    adapter_version: row.adapter_version,
    parsed_at: row.parsed_at,
    content_digest: row.content_digest,
    content_byte_length: row.content_byte_length,
    object_key: row.content_object_key,
    observation_count: row.observation_count,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function ingestionRunInsert(
  database: D1Database,
  input: {
    runId: string;
    supportedGames: readonly string[];
    startedAt: string;
    linkedRunId: string | null;
    idempotencyKey: string;
  },
): Promise<D1PreparedStatement> {
  const baseValues = [
    input.runId,
    canonicalJson(input.supportedGames),
    input.startedAt,
    input.linkedRunId,
    input.idempotencyKey,
  ];
  if (await supportsLifecycleV2(database)) {
    return database
      .prepare(
        `INSERT INTO ingestion_runs (
          id, state, selected_games_json, started_at,
          expected_current_revision_id, linked_run_id, idempotency_key,
          candidate_digest, candidate_created_at, approval_deadline,
          approval_json, published_revision_id, export_manifest_digest,
          terminal_at, candidate_json, approval_idempotency_key,
          progress_json, warnings_json, approval_history_json
        ) SELECT
          ?, 'collecting', ?, ?, catalogue.current_revision_id, ?, ?,
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{}', NULL,
          '{"completed_stages":["planning"],"current_stage":"collecting"}',
          '[]', '[]'
        FROM catalogue_state AS catalogue
        JOIN operation_state AS operation ON operation.singleton = 1
        WHERE catalogue.singleton = 1
          AND operation.recovery_health = 'healthy'
          AND operation.active_ingestion_run_id IS NULL`,
      )
      .bind(...baseValues);
  }
  return database
    .prepare(
      `INSERT INTO ingestion_runs (
        id, state, selected_games_json, started_at,
        expected_current_revision_id, linked_run_id, idempotency_key,
        candidate_digest, candidate_created_at, approval_deadline,
        approval_json, published_revision_id, export_manifest_digest,
        terminal_at, candidate_json, approval_idempotency_key
      ) SELECT
        ?, 'collecting', ?, ?, catalogue.current_revision_id, ?, ?,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{}', NULL
      FROM catalogue_state AS catalogue
      JOIN operation_state AS operation ON operation.singleton = 1
      WHERE catalogue.singleton = 1
        AND operation.recovery_health = 'healthy'
        AND operation.active_ingestion_run_id IS NULL`,
    )
    .bind(...baseValues);
}

async function supportsLifecycleV2(database: D1Database): Promise<boolean> {
  const columns = await database
    .prepare("PRAGMA table_info(ingestion_runs)")
    .all<{ name: string }>();
  return columns.results.some((column) => column.name === "progress_json");
}
