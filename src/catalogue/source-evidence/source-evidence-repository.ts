import {
  AdministrationProblem,
  canonicalJson,
  sha256,
  utf8,
  evidenceRunIdentity,
  replayByDigest,
  operationalDiagnostics,
} from "../shared";
import {
  assertBoundedOfficialSourceRequest,
  assertIdentifier,
  defaultSourceHostPacingIntervalMilliseconds,
  parseEvidencePlans,
  parseStringRecord,
  toleratedPrintingImageFailureCodes,
  type EvidencePlan,
  type OfficialSourceCollectionPlan,
  type OfficialSourceCollectionRequest,
  type StartEvidenceRunRequest,
  validateEvidencePlans,
  type EvidenceHostWorkflowParams,
  type EvidenceParentWorkflowParams,
} from "./source-evidence-model";
import { globalEmergencySourceRequestCeiling, type SourceAdapterRegistration } from "../adapters";
import { curatedRevisionSetForRun, curatedRevisionPinStatementsForNewRun } from "../curated";
import {
  classifyCollectionProgress,
  ownerRequestedPauseReason,
  parentAttemptNumber,
  parentWorkflowAttemptId,
  safeWorkflowStatus,
  workflowAttemptRecord,
  type CollectionProgressFacts,
  type RecordedWorkflowPauseReason,
  type SafeWorkflowStatus,
} from "./collection-recovery";
import {
  boundedEvidenceDetail,
  collectionInspection,
  type PacingConfiguration,
  sourceRequestHostnameSql,
} from "./collection-inspection";
import type {
  CurrentPause,
  ObservationSetRow,
  RunCapacityPolicy,
  SnapshotRow,
} from "./source-evidence-repository-types";
// The row and policy shapes the collection inspection reads live in the
// leaf module `source-evidence-repository-types`; they stay importable from
// here.
export type {
  CurrentPause,
  ObservationSetRow,
  RunCapacityPolicy,
  SnapshotRow,
} from "./source-evidence-repository-types";

export type IngestionEvidenceRow = {
  id: string;
  state: string;
  selected_games_json: string;
  started_at: string;
  expected_current_revision_id: string;
  linked_run_id: string | null;
  idempotency_key: string;
  operational_request_id: string | null;
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
  candidate_digest: string | null;
  progress_json: string;
  warnings_json: string;
  approval_history_json: string;
  published_revision_id: string | null;
  resulting_revision_id: string | null;
  publication_outcome: string | null;
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
  retry_generation: number;
  request_role: "surface" | "listing" | "detail" | "product_detail" | "image";
  discovered_from_request_id: string | null;
};

export type DiscoveredEvidenceRequest = {
  role: Exclude<EvidenceRequestRow["request_role"], "surface">;
  discoveryKey?: string;
  url: string;
  headers: Record<string, string>;
};

export async function startEvidenceRun(
  database: D1Database,
  request: StartEvidenceRunRequest,
  planOrigin: SourceAdapterRegistration["origin"] = "production",
): Promise<Record<string, unknown>> {
  const plans = await validateEvidencePlans(request, planOrigin);
  const firstPlan = plans[0]!;
  const planJson = canonicalJson(plans.length === 1 ? firstPlan : { plans });
  const replay = await evidenceRunByIdempotencyKey(database, request.idempotency_key);
  if (replay !== null) {
    if (!sameEvidencePlanIntent(replay.request_plan_json, planJson)) {
      throw new AdministrationProblem(
        409,
        "idempotency_key_reused",
        "The idempotency key was already used for a different Ingestion Run.",
      );
    }
    return showEvidenceRun(database, replay.id);
  }

  const runId = await evidenceRunIdentity(request.idempotency_key);
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
  assertRecoveryAvailable(catalogue.recovery_health);
  const statements: D1PreparedStatement[] = [
    await ingestionRunInsert(database, {
      runId,
      supportedGames: [...new Set(plans.map(({ supported_game }) => supported_game))].sort(),
      startedAt,
      linkedRunId: null,
      idempotencyKey: request.idempotency_key,
      operationalRequestId: request.operational_request_id ?? null,
    }),
    ...(await curatedRevisionPinStatementsForNewRun(
      database,
      runId,
      [...new Set(plans.map(({ supported_game }) => supported_game))].sort(),
      startedAt,
    )),
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
           AND recovery_health <> 'blocked'
           AND active_ingestion_run_id IS NULL`,
      )
      .bind(runId),
  ];
  try {
    await database.batch(statements);
  } catch (error) {
    const concurrent = await evidenceRunByIdempotencyKey(database, request.idempotency_key);
    if (concurrent !== null && sameEvidencePlanIntent(concurrent.request_plan_json, planJson)) {
      return showEvidenceRun(database, concurrent.id);
    }
    await throwIfRecoveryBlocked(database);
    await throwIfAnotherRunActive(database);
    if (errorMessage(error).includes("active_ingestion_run")) {
      throw activeRunProblem();
    }
    if (errorMessage(error).includes("curated_revision_reconfirmation_required")) {
      throw new AdministrationProblem(
        409,
        "curated_revision_reconfirmation_required",
        "A Curated Revision for a selected Supported Game requires reconfirmation.",
      );
    }
    if (errorMessage(error).includes("credential_execution_in_progress")) {
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

function sameEvidencePlanIntent(retainedJson: string, requestedJson: string): boolean {
  return retainedJson === requestedJson;
}

export async function retryEvidenceRun(
  database: D1Database,
  sourceRunId: string,
  idempotencyKey: string,
  operationalRequestId: string,
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
    .prepare("SELECT recovery_health FROM operation_state WHERE singleton = 1")
    .first<{ recovery_health: string }>();
  if (operation === null) throw new Error("Operation state is unavailable.");
  assertRecoveryAvailable(operation.recovery_health);
  const runId = await evidenceRunIdentity(idempotencyKey);
  const startedAt = new Date().toISOString();
  try {
    await database.batch([
      await ingestionRunInsert(database, {
        runId,
        supportedGames: [...new Set(plans.map(({ supported_game }) => supported_game))].sort(),
        startedAt,
        linkedRunId: source.id,
        idempotencyKey,
        operationalRequestId,
      }),
      ...(await curatedRevisionPinStatementsForNewRun(
        database,
        runId,
        [...new Set(plans.map(({ supported_game }) => supported_game))].sort(),
        startedAt,
      )),
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
             AND recovery_health <> 'blocked'
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
    if (errorMessage(error).includes("curated_revision_reconfirmation_required")) {
      throw new AdministrationProblem(
        409,
        "curated_revision_reconfirmation_required",
        "A Curated Revision for a selected Supported Game requires reconfirmation.",
      );
    }
    if (errorMessage(error).includes("credential_execution_in_progress")) {
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

function assertRecoveryAvailable(recoveryHealth: string): void {
  if (recoveryHealth === "blocked") {
    throw new AdministrationProblem(
      409,
      "recovery_not_verified",
      "An active Backup Attempt blocks evidence ingestion.",
    );
  }
}

async function throwIfRecoveryBlocked(database: D1Database): Promise<void> {
  const operation = await database
    .prepare("SELECT recovery_health FROM operation_state WHERE singleton = 1")
    .first<{ recovery_health: string }>();
  if (operation === null) throw new Error("Operation state is unavailable.");
  assertRecoveryAvailable(operation.recovery_health);
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
  return new AdministrationProblem(409, "active_ingestion_run", "Another Ingestion Run is already active.");
}

function requestStatements(database: D1Database, runId: string, plans: readonly EvidencePlan[]): D1PreparedStatement[] {
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
    const dynamicMatches = parseEvidencePlans(run.request_plan_json).filter((plan) => plan.source_lineage === lineage);
    if (dynamicMatches.length === 1) return dynamicMatches[0]!;
  }
  if (matches.length !== 1) {
    throw new Error(`Source Request ${requestId} does not have exactly one Evidence Plan.`);
  }
  return matches[0]!;
}

// Request capacity is the immutable policy of the exact Source Adapter
// Version owning an Evidence Plan, counted per Source Lineage over unique
// Source Request identities across initial, dynamically discovered, and
// collection-plan roles. The registered column is clamped by the global
// emergency ceiling so no database row can authorize unbounded discovery.
async function adapterRequestCapacity(database: D1Database, adapterVersion: string): Promise<number> {
  const registered = await database
    .prepare(
      `SELECT request_capacity FROM source_adapter_versions
       WHERE adapter_version = ?`,
    )
    .bind(adapterVersion)
    .first<{ request_capacity: number }>();
  if (registered === null || !Number.isSafeInteger(registered.request_capacity) || registered.request_capacity < 1) {
    throw new Error(`Source Adapter Version ${adapterVersion} has no registered request capacity.`);
  }
  return Math.min(registered.request_capacity, globalEmergencySourceRequestCeiling);
}

// Capacity admission rejections carry the facts a request-capacity pause
// must persist: they are computed where admission still knows the exact
// Source Lineage, the retained unique-identity count, and the size of the
// rejected all-or-nothing overflow batch.
export type RequestCapacityFacts = Readonly<{
  source_lineage: string;
  request_capacity: number;
  capacity_generation: number;
  used_capacity: number;
  overflow_request_count: number;
  required_capacity: number;
}>;

export class RequestCapacityProblem extends AdministrationProblem {
  readonly capacity: RequestCapacityFacts;

  constructor(capacity: RequestCapacityFacts) {
    super(
      422,
      "source_discovery_too_large",
      "The Official Source request graph exceeds the Source Adapter Version request capacity.",
    );
    this.capacity = capacity;
  }
}

// The initial request capacity of an Evidence Plan is its Source Adapter
// Version's registered policy at generation 1; each owner-approved capacity
// extension supersedes it with a larger absolute capacity at the next
// generation.
export const initialRequestCapacityGeneration = 1;

export async function runRequestCapacityPolicy(
  database: D1Database,
  runId: string,
  adapterVersion: string,
): Promise<RunCapacityPolicy> {
  const extension = await database
    .prepare(
      `SELECT capacity_generation, request_capacity
       FROM ingestion_run_capacity_extensions
       WHERE ingestion_run_id = ?
       ORDER BY capacity_generation DESC LIMIT 1`,
    )
    .bind(runId)
    .first<{ capacity_generation: number; request_capacity: number }>();
  if (extension !== null) {
    return {
      request_capacity: Math.min(extension.request_capacity, globalEmergencySourceRequestCeiling),
      capacity_generation: extension.capacity_generation,
    };
  }
  return {
    request_capacity: await adapterRequestCapacity(database, adapterVersion),
    capacity_generation: initialRequestCapacityGeneration,
  };
}

function requestCapacityProblem(
  sourceLineage: string,
  policy: RunCapacityPolicy,
  usedCapacity: number,
  overflowRequestCount: number,
): RequestCapacityProblem {
  return new RequestCapacityProblem({
    source_lineage: sourceLineage,
    request_capacity: policy.request_capacity,
    capacity_generation: policy.capacity_generation,
    used_capacity: usedCapacity,
    overflow_request_count: overflowRequestCount,
    required_capacity: usedCapacity + overflowRequestCount,
  });
}

function recountedRequestCapacityProblem(
  sourceLineage: string,
  policy: RunCapacityPolicy,
  recounted: { admitted: number; overflow: number } | null,
  proposedRequestIds: string,
): RequestCapacityProblem {
  if (recounted === null) {
    // COUNT queries always return one row, so a null recount is defensive
    // only; report the whole proposed batch as overflow above the full
    // capacity so the persisted pause facts still satisfy their invariants.
    const proposed = JSON.parse(proposedRequestIds) as unknown[];
    return requestCapacityProblem(sourceLineage, policy, policy.request_capacity, Math.max(1, proposed.length));
  }
  return requestCapacityProblem(sourceLineage, policy, recounted.admitted - recounted.overflow, recounted.overflow);
}

// Unique Source Request identities the Source Lineage would hold if the
// proposed batch were admitted: retained initial-plan and lineage-prefixed
// rows plus proposed identities not yet retained. Binds: ?1 run id,
// ?2 lineage LIKE pattern, ?3 initial-plan request-id JSON, ?4 proposed
// request-id JSON.
const admittedLineageCountSql = `(
  SELECT COUNT(*) FROM source_requests
  WHERE ingestion_run_id = ?1
    AND (
      request_id LIKE ?2
      OR request_id IN (SELECT value FROM json_each(?3))
    )
) + (
  SELECT COUNT(*) FROM json_each(?4) AS proposed
  WHERE NOT EXISTS (
    SELECT 1 FROM source_requests
    WHERE ingestion_run_id = ?1
      AND request_id = proposed.value
  )
)`;

export async function appendDiscoveredEvidenceRequests(
  database: D1Database,
  run: Pick<IngestionEvidenceRow, "id" | "request_plan_json">,
  parent: EvidenceRequestRow,
  discovered: readonly DiscoveredEvidenceRequest[],
): Promise<readonly EvidenceRequestRow[]> {
  const plan = evidencePlanForRequest(run, parent.request_id);
  const normalizedById = new Map<
    string,
    {
      id: string;
      url: string;
      headers_json: string;
      representation_fingerprint: string;
      role: DiscoveredEvidenceRequest["role"];
      sequence_floor: number;
    }
  >();
  for (const request of discovered) {
    if (request.discoveryKey !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(request.discoveryKey)) {
      throw new AdministrationProblem(
        422,
        "source_discovery_failed",
        "The Official Source discovery stage identity is invalid.",
      );
    }
    const url = new URL(request.url).href;
    const headersJson = canonicalJson(request.headers);
    assertBoundedOfficialSourceRequest(url, request.headers, true);
    const digest = await sha256(
      utf8(
        canonicalJson({
          source_lineage: plan.source_lineage,
          role: request.role,
          discovery_key: request.discoveryKey ?? null,
          method: "GET",
          url,
          headers: request.headers,
        }),
      ),
    );
    const requestId =
      request.discoveryKey === undefined
        ? `${plan.source_lineage}:${request.role}:${digest}`
        : `${plan.source_lineage}:${request.role}:${request.discoveryKey}:${digest}`;
    normalizedById.set(requestId, {
      id: requestId,
      url,
      headers_json: headersJson,
      representation_fingerprint: await sha256(utf8(canonicalJson({ method: "GET", url, headers: request.headers }))),
      role: request.role,
      sequence_floor: request.discoveryKey === undefined ? 0 : 1_000_000,
    });
  }
  const normalized = [...normalizedById.values()];
  const proposedRequestIds = JSON.stringify(normalized.map(({ id }) => id));
  const capacityPolicy = await runRequestCapacityPolicy(database, run.id, plan.adapter_version);
  const requestCapacity = capacityPolicy.request_capacity;
  const planRequestIds = JSON.stringify(plan.requests.map(({ id }) => id));
  const lineageRequestPattern = `${plan.source_lineage}:%`;
  const count = await database
    .prepare(
      `SELECT COUNT(*) AS count
       FROM source_requests
       WHERE ingestion_run_id = ?
         AND (
           request_id LIKE ?
           OR request_id IN (SELECT value FROM json_each(?))
         )`,
    )
    .bind(run.id, lineageRequestPattern, planRequestIds)
    .first<{ count: number }>();
  const existing =
    normalized.length === 0
      ? { count: 0 }
      : await database
          .prepare(
            `SELECT COUNT(*) AS count FROM source_requests
         WHERE ingestion_run_id = ?
           AND request_id IN (SELECT value FROM json_each(?))`,
          )
          .bind(run.id, proposedRequestIds)
          .first<{ count: number }>();
  const usedCapacity = count?.count ?? 0;
  const overflowRequestCount = normalized.length - (existing?.count ?? 0);
  if (count === null || existing === null || usedCapacity + overflowRequestCount > requestCapacity) {
    throw requestCapacityProblem(plan.source_lineage, capacityPolicy, usedCapacity, overflowRequestCount);
  }
  if (normalized.length === 0) return [];
  const chunks = chunked(normalized, 100);
  const statements: D1PreparedStatement[] = [
    // Capacity admission must hold atomically inside the batch: this guard
    // recounts under the same implicit transaction, so concurrent Workflow
    // children cannot admit two batches that only fit individually. A CASE
    // arm cannot RAISE outside a trigger, so an over-capacity recount
    // deliberately selects json('source_discovery_too_large') — invalid JSON
    // — to abort the whole batch; the catch below maps that opaque SQLite
    // error back to the admission problem.
    database
      .prepare(
        `SELECT CASE WHEN ${admittedLineageCountSql} > ?5
         THEN json('source_discovery_too_large') ELSE 1 END`,
      )
      .bind(run.id, lineageRequestPattern, planRequestIds, proposedRequestIds, requestCapacity),
  ];
  for (const chunk of chunks) {
    const json = JSON.stringify(chunk);
    statements.push(
      database
        .prepare(
          `SELECT CASE WHEN EXISTS (
           SELECT 1
           FROM json_each(?) AS proposed
           JOIN source_discovery_request_plans AS retained
             ON retained.ingestion_run_id = ?
            AND retained.request_id = json_extract(proposed.value, '$.id')
           WHERE retained.method <> 'GET'
              OR retained.url <> json_extract(proposed.value, '$.url')
              OR retained.request_headers_json <>
                   json_extract(proposed.value, '$.headers_json')
              OR retained.representation_fingerprint <>
                   json_extract(proposed.value, '$.representation_fingerprint')
              OR retained.request_role <>
                   json_extract(proposed.value, '$.role')
         ) THEN json('source_discovery_identity_collision') ELSE 1 END`,
        )
        .bind(json, run.id),
      database
        .prepare(
          `INSERT OR IGNORE INTO source_discovery_request_plans (
             ingestion_run_id, request_id, sequence_number,
             parent_request_id, method, url, request_headers_json,
             representation_fingerprint, request_role
           )
           SELECT ?, json_extract(proposed.value, '$.id'),
                  MAX(
                    base.maximum_sequence,
                    json_extract(proposed.value, '$.sequence_floor') - 1
                  ) + CAST(proposed.key AS INTEGER) + 1,
                  ?, 'GET', json_extract(proposed.value, '$.url'),
                  json_extract(proposed.value, '$.headers_json'),
                  json_extract(proposed.value, '$.representation_fingerprint'),
                  json_extract(proposed.value, '$.role')
           FROM json_each(?) AS proposed
           CROSS JOIN (
             SELECT COALESCE(MAX(sequence_number), -1) AS maximum_sequence
             FROM source_requests WHERE ingestion_run_id = ?
           ) AS base`,
        )
        .bind(run.id, parent.request_id, json, run.id),
      database
        .prepare(
          `INSERT OR IGNORE INTO source_requests (
             ingestion_run_id, request_id, sequence_number, method, url,
             request_headers_json, representation_fingerprint, state,
             source_snapshot_id, failure_code, request_role,
             discovered_from_request_id
           )
           SELECT ingestion_run_id, request_id, sequence_number, method, url,
                  request_headers_json, representation_fingerprint,
                  'pending', NULL, NULL, request_role, parent_request_id
           FROM source_discovery_request_plans
           WHERE ingestion_run_id = ?
             AND request_id IN (
               SELECT json_extract(value, '$.id') FROM json_each(?)
             )`,
        )
        .bind(run.id, json),
    );
  }
  try {
    await database.batch(statements);
  } catch (error) {
    throw await mappedDiscoveryAdmissionError(
      error,
      database,
      run.id,
      plan.source_lineage,
      lineageRequestPattern,
      planRequestIds,
      proposedRequestIds,
      capacityPolicy,
    );
  }
  const retainedResults = await database.batch<EvidenceRequestRow>(
    chunks.map((chunk) =>
      database
        .prepare(
          `SELECT * FROM source_requests
         WHERE ingestion_run_id = ?
           AND request_id IN (
             SELECT json_extract(value, '$.id') FROM json_each(?)
           )`,
        )
        .bind(run.id, JSON.stringify(chunk)),
    ),
  );
  const retainedById = new Map(
    retainedResults.flatMap(({ results }) => results).map((row) => [row.request_id, row] as const),
  );
  const inserted: EvidenceRequestRow[] = [];
  for (const expected of normalized) {
    const retained = retainedById.get(expected.id);
    if (
      retained === null ||
      retained === undefined ||
      retained.url !== expected.url ||
      retained.request_headers_json !== expected.headers_json ||
      retained.representation_fingerprint !== expected.representation_fingerprint ||
      retained.request_role !== expected.role
    ) {
      throw new Error("Discovered Source Request identity collided with different immutable evidence.");
    }
    inserted.push(retained);
  }
  return inserted;
}

// Both in-batch admission guards abort by selecting json('<code>') — invalid
// JSON — so nothing distinguishes a capacity abort from an identity-collision
// abort in the surfaced SQLite error. Nothing was inserted, so recounting the
// retained state recovers which guard fired: retained counts only grow
// (deletion is trigger-blocked), so a genuine capacity abort always recounts
// over capacity; only a collision abort racing a concurrent admission can be
// conservatively reported as the capacity problem instead.
async function mappedDiscoveryAdmissionError(
  error: unknown,
  database: D1Database,
  runId: string,
  sourceLineage: string,
  lineageRequestPattern: string,
  planRequestIds: string,
  proposedRequestIds: string,
  capacityPolicy: RunCapacityPolicy,
): Promise<unknown> {
  if (!/malformed JSON/iu.test(errorMessage(error))) return error;
  const recounted = await admittedLineageCapacityFacts(
    database,
    runId,
    lineageRequestPattern,
    planRequestIds,
    proposedRequestIds,
  );
  if (recounted === null || recounted.admitted > capacityPolicy.request_capacity) {
    return recountedRequestCapacityProblem(sourceLineage, capacityPolicy, recounted, proposedRequestIds);
  }
  return new Error("Discovered Source Request identity collided with different immutable evidence.");
}

// The unique Source Request identities the Source Lineage would hold if the
// proposed batch were admitted, alongside how many proposed identities are
// not yet retained (the all-or-nothing overflow batch size). Recounted after
// an in-batch admission abort: nothing was inserted, so retained state still
// reflects the rejected admission.
async function admittedLineageCapacityFacts(
  database: D1Database,
  runId: string,
  lineageRequestPattern: string,
  planRequestIds: string,
  proposedRequestIds: string,
): Promise<{ admitted: number; overflow: number } | null> {
  const [admitted, overflow] = await database.batch<{ count: number }>([
    database
      .prepare(`SELECT ${admittedLineageCountSql} AS count`)
      .bind(runId, lineageRequestPattern, planRequestIds, proposedRequestIds),
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM json_each(?2) AS proposed
         WHERE NOT EXISTS (
           SELECT 1 FROM source_requests
           WHERE ingestion_run_id = ?1
             AND request_id = proposed.value
         )`,
      )
      .bind(runId, proposedRequestIds),
  ]);
  const admittedCount = admitted?.results[0]?.count;
  const overflowCount = overflow?.results[0]?.count;
  if (admittedCount === undefined || overflowCount === undefined) return null;
  return { admitted: admittedCount, overflow: overflowCount };
}

function chunked<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export async function persistOfficialSourceCollectionPlan(
  database: D1Database,
  runId: string,
  discoveryObservationSetId: string,
  discoveredRequests: readonly OfficialSourceCollectionRequest[],
): Promise<void> {
  const run = await requiredEvidenceRun(database, runId);
  const owner = await database
    .prepare(
      `SELECT snapshot.source_lineage
     FROM source_observation_sets AS observation_set
     JOIN source_snapshots AS snapshot
       ON snapshot.id = observation_set.source_snapshot_id
     WHERE observation_set.id = ? AND snapshot.ingestion_run_id = ?`,
    )
    .bind(discoveryObservationSetId, runId)
    .first<{ source_lineage: string }>();
  if (owner === null) {
    throw new Error("The discovery observation is not owned by this Ingestion Run.");
  }
  const plans = parseEvidencePlans(run.request_plan_json);
  const planIndex = plans.findIndex((plan) => plan.source_lineage === owner.source_lineage);
  const discoveryPlan = plans[planIndex];
  if (discoveryPlan === undefined) {
    throw new Error("The discovery observation has no owning immutable Evidence Plan.");
  }
  if (
    discoveryPlan.requests.length !== 1 ||
    !["discovery", `${discoveryPlan.source_lineage}:discovery`].includes(discoveryPlan.requests[0]!.id)
  ) {
    throw new Error("Complete Official Source planning lost its discovery seed.");
  }
  const collectionPlan: OfficialSourceCollectionPlan = {
    contract: "card-keepr-official-source-collection-plan@1",
    supported_game: discoveryPlan.supported_game,
    source_lineage: discoveryPlan.source_lineage,
    game_profile_version: discoveryPlan.game_profile_version,
    adapter_version: discoveryPlan.adapter_version,
    discovery_observation_set_id: discoveryObservationSetId,
    requests: [...discoveredRequests],
  };
  const collectionPlanJson = canonicalJson(collectionPlan);
  const contentDigest = await sha256(utf8(collectionPlanJson));
  const retained = await database
    .prepare(
      `SELECT collection_plan_json, content_digest
       FROM official_source_collection_plans
       WHERE ingestion_run_id = ? AND source_lineage = ?`,
    )
    .bind(runId, discoveryPlan.source_lineage)
    .first<{
      collection_plan_json: string;
      content_digest: string;
    }>();
  if (retained !== null) {
    if (retained.collection_plan_json !== collectionPlanJson || retained.content_digest !== contentDigest) {
      throw new Error("Live Official Source discovery changed after immutable collection planning.");
    }
    return;
  }
  const capacityPolicy = await runRequestCapacityPolicy(database, runId, discoveryPlan.adapter_version);
  const requestCapacity = capacityPolicy.request_capacity;
  const lineageRequestPattern = `${discoveryPlan.source_lineage}:%`;
  const planRequestIds = JSON.stringify(discoveryPlan.requests.map(({ id }) => id));
  const collectionRequestIds = JSON.stringify(discoveredRequests.map(({ id }) => id));
  const admitted = await admittedLineageCapacityFacts(
    database,
    runId,
    lineageRequestPattern,
    planRequestIds,
    collectionRequestIds,
  );
  if (admitted === null || admitted.admitted > requestCapacity) {
    throw recountedRequestCapacityProblem(discoveryPlan.source_lineage, capacityPolicy, admitted, collectionRequestIds);
  }
  try {
    await database.batch([
      // Collection-plan requests consume the same per-lineage capacity as
      // dynamically discovered requests, admitted atomically inside the batch
      // through the documented json('source_discovery_too_large') abort.
      database
        .prepare(
          `SELECT CASE WHEN ${admittedLineageCountSql} > ?5
             THEN json('source_discovery_too_large') ELSE 1 END`,
        )
        .bind(runId, lineageRequestPattern, planRequestIds, collectionRequestIds, requestCapacity),
      database
        .prepare(
          `INSERT INTO official_source_collection_plans (
             ingestion_run_id, source_lineage,
             discovery_observation_set_id, contract,
             collection_plan_json, content_digest, created_at
           ) VALUES (?, ?, ?,
             'card-keepr-official-source-collection-plan@1', ?, ?, ?)`,
        )
        .bind(
          runId,
          discoveryPlan.source_lineage,
          discoveryObservationSetId,
          collectionPlanJson,
          contentDigest,
          new Date().toISOString(),
        ),
      ...discoveredRequests.map((request, index) =>
        database
          .prepare(
            `INSERT INTO source_requests (
               ingestion_run_id, request_id, sequence_number, method, url,
               request_headers_json, representation_fingerprint, state,
               source_snapshot_id, failure_code
             ) VALUES (?, ?, ?, 'GET', ?, ?, ?, 'pending', NULL, NULL)`,
          )
          .bind(
            runId,
            request.id,
            plans.flatMap((plan) => plan.requests).length + planIndex * 10000 + index,
            request.url,
            canonicalJson(request.headers),
            request.representation_fingerprint,
          ),
      ),
    ]);
  } catch (error) {
    if (/malformed JSON/iu.test(errorMessage(error))) {
      // The only in-batch guard in this admission is the capacity abort, so a
      // malformed-JSON abort is always a capacity rejection; the recount
      // recovers the facts under the same retained state.
      const recounted = await admittedLineageCapacityFacts(
        database,
        runId,
        lineageRequestPattern,
        planRequestIds,
        collectionRequestIds,
      );
      throw recountedRequestCapacityProblem(
        discoveryPlan.source_lineage,
        capacityPolicy,
        recounted,
        collectionRequestIds,
      );
    }
    throw error;
  }
}

export async function requiredEvidenceRun(database: D1Database, runId: string): Promise<IngestionEvidenceRow> {
  assertIdentifier(runId, "run_id");
  const row = await database
    .prepare(
      `SELECT runs.*, plans.source_lineage, plans.supported_game,
              plans.game_profile_version, plans.adapter_version,
              plans.request_plan_json, plans.plan_origin,
              plans.parent_workflow_id,
              plans.child_workflow_ids_json,
              plans.collection_completed_at
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

async function evidenceRunByIdempotencyKey(database: D1Database, key: string): Promise<IngestionEvidenceRow | null> {
  return database
    .prepare(
      `SELECT runs.*, plans.source_lineage, plans.supported_game,
              plans.game_profile_version, plans.adapter_version,
              plans.request_plan_json, plans.plan_origin,
              plans.parent_workflow_id,
              plans.child_workflow_ids_json,
              plans.collection_completed_at
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

export async function pendingEvidenceRequestPage(
  database: D1Database,
  runId: string,
  afterSequenceNumber: number,
  maximumSequenceNumber: number,
  limit: number,
): Promise<EvidenceRequestRow[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Pending evidence request pages must contain 1-100 rows.");
  }
  const result = await database
    .prepare(
      `SELECT * FROM source_requests
       WHERE ingestion_run_id = ? AND state IN ('pending', 'captured')
         AND sequence_number > ? AND sequence_number <= ?
       ORDER BY sequence_number
       LIMIT ?`,
    )
    .bind(runId, afterSequenceNumber, maximumSequenceNumber, limit)
    .all<EvidenceRequestRow>();
  return result.results;
}

export async function recordWorkflowIds(
  database: D1Database,
  runId: string,
  parentWorkflowId: string,
  childWorkflowIds: readonly string[],
): Promise<void> {
  await database.batch([
    database
      .prepare(
        `UPDATE ingestion_evidence_plans
         SET parent_workflow_id = ?, child_workflow_ids_json = ?
         WHERE ingestion_run_id = ?
           AND (parent_workflow_id IS NULL OR parent_workflow_id = ?)`,
      )
      .bind(parentWorkflowId, canonicalJson(childWorkflowIds), runId, parentWorkflowId),
    ...workflowAttemptStatements(database, runId, [parentWorkflowId, ...childWorkflowIds]),
  ]);
}

// Every observed Workflow identity becomes one immutable Workflow Attempt
// row. Identities are self-describing (see workflowAttemptRecord), so the
// same record is recomputed idempotently wherever an identity is observed
// and INSERT OR IGNORE preserves the first recorded creation time.
export function workflowAttemptStatements(
  database: D1Database,
  runId: string,
  workflowInstanceIds: readonly string[],
): D1PreparedStatement[] {
  const createdAt = new Date().toISOString();
  return workflowInstanceIds.map((instanceId) => {
    const record = workflowAttemptRecord(runId, instanceId);
    return database
      .prepare(
        `INSERT OR IGNORE INTO ingestion_workflow_attempts (
           ingestion_run_id, workflow_kind, base_workflow_id,
           attempt_number, workflow_instance_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        runId,
        record.workflow_kind,
        record.base_workflow_id,
        record.attempt_number,
        record.workflow_instance_id,
        createdAt,
      );
  });
}

// Exhausting the bounded replacement identities of one hostname shard fails
// only that shard's active requests: other hosts' healthy shards keep
// collecting, and the completeness gate still fails the run at the barrier.
// The host is extracted from the normalized request URL and compared for
// equality (evidence requests are plain https URLs without ports).
export async function failActiveEvidenceRequestsForWorkflowExhaustion(
  database: D1Database,
  runId: string,
  shard: Readonly<{
    hostname: string;
    minimumSequenceNumber: number;
    maximumSequenceNumber: number;
  }>,
): Promise<void> {
  await database
    .prepare(
      `UPDATE source_requests
       SET state = 'failed', failure_code = 'source_workflow_retries_exhausted'
       WHERE ingestion_run_id = ? AND state IN ('pending', 'captured')
         AND sequence_number BETWEEN ? AND ?
         AND ${sourceRequestHostnameSql("url")} = ?`,
    )
    .bind(runId, shard.minimumSequenceNumber, shard.maximumSequenceNumber, shard.hostname)
    .run();
}

// Capacity exhaustion is a circuit breaker, not proof the retained collection
// attempt is invalid: the run pauses non-terminally, keeps the single
// active-run reservation and its expected Catalogue Revision, and records the
// immutable facts the owner needs to extend capacity. The parent Source
// Request stays 'captured' so the overflow batch can be derived again from
// its retained Source Snapshot without another Official Source fetch.
export async function pauseEvidenceRunForRequestCapacity(
  database: D1Database,
  runId: string,
  parentRequestId: string,
  problem: RequestCapacityProblem,
): Promise<void> {
  const pausedAt = new Date().toISOString();
  await database.batch([
    database
      .prepare(
        `UPDATE ingestion_runs
         SET state = 'paused',
             progress_json =
               '{"completed_stages":["planning"],"current_stage":"paused"}'
         WHERE id = ? AND state = 'collecting'`,
      )
      .bind(runId),
    // Guarded and idempotent under durable Workflow step replay: the run is
    // paused by the statement above (or already was), and one immutable pause
    // record exists per capacity generation. The replay guard is an explicit
    // NOT EXISTS rather than INSERT OR IGNORE so an unexpected constraint
    // failure (a facts-computation bug violating the table CHECKs) aborts
    // loudly instead of silently pausing without a record.
    database
      .prepare(
        `INSERT INTO ingestion_run_capacity_pauses (
           ingestion_run_id, capacity_generation, pause_reason, paused_at,
           source_lineage, parent_request_id, request_capacity,
           used_capacity, overflow_request_count, required_capacity
         )
         SELECT ?, ?, 'source_request_capacity_exhausted', ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM ingestion_runs WHERE id = ?1 AND state = 'paused'
         )
         AND NOT EXISTS (
           SELECT 1 FROM ingestion_run_capacity_pauses
           WHERE ingestion_run_id = ?1 AND capacity_generation = ?2
         )`,
      )
      .bind(
        runId,
        problem.capacity.capacity_generation,
        pausedAt,
        problem.capacity.source_lineage,
        parentRequestId,
        problem.capacity.request_capacity,
        problem.capacity.used_capacity,
        problem.capacity.overflow_request_count,
        problem.capacity.required_capacity,
      ),
  ]);
}

// Each Source Request owns a bounded budget of fetch attempts per retry
// generation. Attempt numbers grow monotonically across generations, so the
// append-only attempt history and the deterministic capture-operation
// identities never renumber; resuming after a retry-exhaustion pause raises
// the counted window by advancing the request's generation instead.
export const captureAttemptsPerRetryGeneration = 4;

export type RetryExhaustionFacts = {
  request_id: string;
  source_lineage: string;
  hostname: string;
  retry_generation: number;
  attempt_count: number;
  failure_classification: "network_failure" | "http_failure" | "storage_failure";
  http_status: number | null;
};

// Exhausting the bounded transport or storage retries for one immutable
// Source Request is not proof the retained collection attempt is invalid:
// the run pauses non-terminally with a reason distinct from capacity
// exhaustion, the request stays pending with its append-only attempt
// history, and the immutable pause record identifies the safe request
// reference, hostname, exhausted generation, and latest safe classification.
// The statements are returned unexecuted so callers can commit them in the
// same atomic batch that records the final failed attempt.
export function retryExhaustionPauseStatements(
  database: D1Database,
  runId: string,
  facts: RetryExhaustionFacts,
): D1PreparedStatement[] {
  const pauseReason =
    facts.failure_classification === "storage_failure"
      ? "source_storage_retries_exhausted"
      : "source_transport_retries_exhausted";
  return [
    database
      .prepare(
        `UPDATE ingestion_runs
         SET state = 'paused',
             progress_json =
               '{"completed_stages":["planning"],"current_stage":"paused"}'
         WHERE id = ? AND state = 'collecting'`,
      )
      .bind(runId),
    // Guarded and idempotent under durable Workflow step replay, mirroring
    // the capacity pause: the run is paused by the statement above (or a
    // concurrent exhaustion already paused it), and one immutable record
    // exists per (request, generation). The replay guard is an explicit
    // NOT EXISTS so a facts bug violating the table CHECKs aborts loudly
    // instead of silently pausing without a record. When the run already
    // reached a terminal state through a sibling request, both statements
    // deliberately record nothing: the terminal outcome stands.
    database
      .prepare(
        `INSERT INTO ingestion_run_retry_pauses (
           ingestion_run_id, request_id, retry_generation, pause_reason,
           paused_at, source_lineage, hostname, attempt_count,
           failure_classification, http_status
         )
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
         WHERE EXISTS (
           SELECT 1 FROM ingestion_runs WHERE id = ?1 AND state = 'paused'
         )
         AND NOT EXISTS (
           SELECT 1 FROM ingestion_run_retry_pauses
           WHERE ingestion_run_id = ?1 AND request_id = ?2
             AND retry_generation = ?3
         )`,
      )
      .bind(
        runId,
        facts.request_id,
        facts.retry_generation,
        pauseReason,
        new Date().toISOString(),
        facts.source_lineage,
        facts.hostname,
        facts.attempt_count,
        facts.failure_classification,
        facts.http_status,
      ),
  ];
}

export type WorkflowRecoveryFacts = {
  workflow_instance_id: string;
  pause_reason: RecordedWorkflowPauseReason;
  workflow_status: SafeWorkflowStatus;
  last_progress_at: string | null;
};

// A stalled, errored, terminated, or unavailable collection Workflow is not
// proof the retained collection attempt is invalid: the run pauses
// non-terminally with the Workflow Pause reason, no Source Request changes
// state, and the immutable record identifies the abandoned Workflow Attempt,
// the safe status that classified it, and the deterministic last-progress
// time the classification was derived from.
export async function pauseEvidenceRunForWorkflowRecovery(
  database: D1Database,
  runId: string,
  facts: WorkflowRecoveryFacts,
): Promise<void> {
  await database.batch(workflowPauseStatements(database, runId, facts, new Date().toISOString()));
}

// The two guarded statements every Workflow Pause applies atomically.
function workflowPauseStatements(
  database: D1Database,
  runId: string,
  facts: WorkflowRecoveryFacts,
  pausedAt: string,
): D1PreparedStatement[] {
  return [
    // Compare-and-set on the abandoned instance still being the bound
    // parent: a concurrent recovery that already superseded it rebound the
    // identity, so a stale classification of the old instance must not
    // re-pause the freshly recovered run.
    database
      .prepare(
        `UPDATE ingestion_runs
         SET state = 'paused',
             progress_json =
               '{"completed_stages":["planning"],"current_stage":"paused"}'
         WHERE id = ?1 AND state = 'collecting'
           AND EXISTS (
             SELECT 1 FROM ingestion_evidence_plans
             WHERE ingestion_run_id = ?1 AND parent_workflow_id = ?2
           )`,
      )
      .bind(runId, facts.workflow_instance_id),
    // Guarded and idempotent, mirroring the capacity and retry pauses: the
    // run is paused by the statement above (or already was), and one
    // immutable record exists per abandoned Workflow instance. When the run
    // already reached another state, both statements record nothing.
    database
      .prepare(
        `INSERT INTO ingestion_run_workflow_pauses (
           ingestion_run_id, workflow_instance_id, pause_reason,
           workflow_status, paused_at, last_progress_at
         )
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
         WHERE EXISTS (
           SELECT 1 FROM ingestion_runs WHERE id = ?1 AND state = 'paused'
         )
         AND NOT EXISTS (
           SELECT 1 FROM ingestion_run_workflow_pauses
           WHERE ingestion_run_id = ?1 AND workflow_instance_id = ?2
         )`,
      )
      .bind(
        runId,
        facts.workflow_instance_id,
        facts.pause_reason,
        facts.workflow_status,
        pausedAt,
        facts.last_progress_at,
      ),
  ];
}

export type CollectionPauseRequest = {
  idempotency_key: string;
  workflow_instance_id: string;
  workflow_status: SafeWorkflowStatus;
  last_progress_at: string | null;
};

export type CollectionPauseOutcome = {
  document: Record<string, unknown>;
  // True when this call recorded the pause, false when it replayed one.
  applied: boolean;
};

const collectionPauseOperation = "pause_collection";
const collectionPauseContract = "card-keepr-collection-pause@1";

// The owner's deliberate pause of a collecting Ingestion Run. It is a
// Workflow Pause with the reason 'owner_requested': the current parent
// attempt is abandoned and recorded with the safe status observed at the
// time, nothing is recorded as failed, and the paused run admits exactly the
// resume and terminate actions. The pause is idempotent under its key: the
// retained response replays without applying anything, and a key reused for
// another request is refused. Only a collecting run can be paused.
export async function pauseEvidenceRunOnOwnerRequest(
  database: D1Database,
  runId: string,
  request: CollectionPauseRequest,
): Promise<CollectionPauseOutcome> {
  assertIdentifier(request.idempotency_key, "idempotency_key");
  const requestJson = canonicalJson({
    ingestion_run_id: runId,
    idempotency_key: request.idempotency_key,
  });
  const replayed = await collectionPauseReplay(database, request.idempotency_key, requestJson);
  if (replayed !== null) return { document: replayed, applied: false };
  const run = await requiredEvidenceRun(database, runId);
  if (run.state !== "collecting") throw ingestionRunNotCollectingForPause();
  const pausedAt = new Date().toISOString();
  const response: Record<string, unknown> = {
    contract: collectionPauseContract,
    ingestion_run_id: runId,
    state: "paused",
    pause_reason: ownerRequestedPauseReason,
    paused_at: pausedAt,
    workflow: {
      id: request.workflow_instance_id,
      attempt_number: parentAttemptNumber(runId, request.workflow_instance_id),
      status: request.workflow_status,
    },
    last_progress_at: request.last_progress_at,
    actions: collectionActions("paused", ownerRequestedPauseReason),
  };
  let applied = false;
  try {
    const outcome = await database.batch([
      ...workflowPauseStatements(
        database,
        runId,
        {
          workflow_instance_id: request.workflow_instance_id,
          pause_reason: ownerRequestedPauseReason,
          workflow_status: request.workflow_status,
          last_progress_at: request.last_progress_at,
        },
        pausedAt,
      ),
      // The retained response exists only when this request's own pause
      // record does, so a request that lost the race records no outcome and
      // re-reads the winner's instead.
      database
        .prepare(
          `INSERT INTO administration_idempotency (
             idempotency_key, operation, request_json, response_json,
             http_status, outcome, created_at
           )
           SELECT ?1, ?2, ?3, ?4, 200, 'success', ?5
           WHERE EXISTS (
             SELECT 1 FROM ingestion_run_workflow_pauses
             WHERE ingestion_run_id = ?6 AND workflow_instance_id = ?7
               AND pause_reason = ?8 AND paused_at = ?5
           )`,
        )
        .bind(
          request.idempotency_key,
          collectionPauseOperation,
          requestJson,
          canonicalJson(response),
          pausedAt,
          runId,
          request.workflow_instance_id,
          ownerRequestedPauseReason,
        ),
    ]);
    applied = outcome[2]?.meta.changes === 1;
  } catch {
    // A raced key or fence; the retained state below reports the outcome.
  }
  const recorded = await collectionPauseReplay(database, request.idempotency_key, requestJson);
  if (recorded !== null) return { document: recorded, applied };
  const current = await requiredEvidenceRun(database, runId);
  if (current.state !== "collecting") throw ingestionRunNotCollectingForPause();
  throw new AdministrationProblem(
    409,
    "collection_pause_conflict",
    "A concurrent lifecycle action prevented this pause from applying.",
  );
}

function ingestionRunNotCollectingForPause(): AdministrationProblem {
  return new AdministrationProblem(
    409,
    "ingestion_run_not_collecting",
    "Only a collecting Ingestion Run can be paused.",
  );
}

async function collectionPauseReplay(
  database: D1Database,
  idempotencyKey: string,
  requestJson: string,
): Promise<Record<string, unknown> | null> {
  const retained = await database
    .prepare(
      `SELECT operation, request_json, response_json
       FROM administration_idempotency WHERE idempotency_key = ?`,
    )
    .bind(idempotencyKey)
    .first<{ operation: string; request_json: string; response_json: string }>();
  if (retained === null) return null;
  if (retained.operation !== collectionPauseOperation || retained.request_json !== requestJson) {
    throw new AdministrationProblem(
      409,
      "idempotency_conflict",
      "The idempotency key was already used for a different request.",
    );
  }
  return JSON.parse(retained.response_json) as Record<string, unknown>;
}

export type { CollectionProgressFacts } from "./collection-recovery";

// The deterministic progress evidence stall classification consumes: the
// newest persisted lifecycle event across transitions, fetch attempts,
// capture operations, parses, collection plans, and Workflow Attempts —
// never log arrival time — plus the persisted wait deadlines that must not
// be misread as silence (the host pacing table's next-request deadline and
// the newest scheduled Retry-After deadline).
export async function collectionProgressFacts(database: D1Database, runId: string): Promise<CollectionProgressFacts> {
  const [progress, pacing, retry] = await Promise.all([
    database
      .prepare(
        `SELECT
           (SELECT MAX(transitioned_at) FROM ingestion_run_transitions
            WHERE ingestion_run_id = ?1) AS transitioned_at,
           (SELECT MAX(completed_at) FROM source_fetch_attempts
            WHERE ingestion_run_id = ?1) AS fetched_at,
           (SELECT MAX(COALESCE(completed_at, requested_at))
            FROM source_capture_operations
            WHERE ingestion_run_id = ?1) AS captured_at,
           (SELECT MAX(created_at) FROM ingestion_workflow_attempts
            WHERE ingestion_run_id = ?1) AS attempted_at,
           (SELECT MAX(observations.parsed_at)
            FROM source_observation_sets AS observations
            JOIN source_snapshots AS snapshots
              ON snapshots.id = observations.source_snapshot_id
            WHERE snapshots.ingestion_run_id = ?1) AS parsed_at,
           (SELECT MAX(created_at) FROM official_source_collection_plans
            WHERE ingestion_run_id = ?1) AS planned_at,
           (SELECT started_at FROM ingestion_runs WHERE id = ?1) AS started_at`,
      )
      .bind(runId)
      .first<Record<string, string | null>>(),
    // Pacing deadlines are keyed by hostname rather than run, so the scan
    // keeps only hosts this run still has open requests against. The host is
    // extracted from the normalized request URL and compared for equality
    // (evidence requests are plain https URLs without ports), and any
    // residual over-approximation is bounded by the pacing interval cap plus
    // jitter — it can only delay a stall verdict briefly, never manufacture
    // one.
    database
      .prepare(
        `SELECT MAX(pacing.next_request_not_before) AS pacing_deadline_at
         FROM source_host_pacing AS pacing
         WHERE EXISTS (
           SELECT 1 FROM source_requests AS requests
           WHERE requests.ingestion_run_id = ?
             AND requests.state IN ('pending', 'captured')
             AND ${sourceRequestHostnameSql("requests.url")} = pacing.hostname
         )`,
      )
      .bind(runId)
      .first<{ pacing_deadline_at: string | null }>(),
    database
      .prepare(
        `SELECT MAX(
           (julianday(completed_at) - 2440587.5) * 86400000.0 + retry_after_ms
         ) AS retry_deadline_ms
         FROM source_fetch_attempts
         WHERE ingestion_run_id = ? AND retry_after_ms IS NOT NULL`,
      )
      .bind(runId)
      .first<{ retry_deadline_ms: number | null }>(),
  ]);
  // Every source column carries the same UTC ISO-8601 shape, so the newest
  // event is the lexicographic maximum of the non-null values.
  const progressTimes = Object.values(progress ?? {})
    .filter((value): value is string => typeof value === "string")
    .sort();
  return {
    last_progress_at: progressTimes.at(-1) ?? null,
    pacing_deadline_at: pacing?.pacing_deadline_at ?? null,
    retry_deadline_at:
      retry?.retry_deadline_ms == null ? null : new Date(Math.round(retry.retry_deadline_ms)).toISOString(),
  };
}

// Move a paused Ingestion Run back into its collection phase and bind the
// deterministic parent Workflow identity that will reacquire the remaining
// work. Every statement is idempotent under replayed resumes: the retry
// budgets reopen only while a generation is exhausted, the state update is a
// no-op once the run collects again, and the identity is derived from the
// count of recorded paused -> collecting transitions, so a replay reassigns
// the same value.
export async function resumePausedEvidenceRun(database: D1Database, runId: string): Promise<void> {
  const resumed = await database
    .prepare(
      `SELECT COUNT(*) AS count FROM ingestion_run_transitions
       WHERE ingestion_run_id = ?
         AND from_state = 'paused' AND to_state = 'collecting'`,
    )
    .bind(runId)
    .first<{ count: number }>();
  const resumeCount = resumed?.count ?? 0;
  const parentWorkflowId = parentWorkflowAttemptId(runId, resumeCount + 2);
  const attemptRecord = workflowAttemptRecord(runId, parentWorkflowId);
  await database.batch([
    // Resuming after retry exhaustion opens the next bounded retry
    // generation for each affected Source Request: attempts stay
    // append-only, and the raised counted window admits the next
    // captureAttemptsPerRetryGeneration attempts. Requests that still have
    // budget (every request after a capacity pause) are untouched, which
    // also makes a replayed resume a natural no-op.
    database
      .prepare(
        `UPDATE source_requests
         SET retry_generation = retry_generation + 1
         WHERE ingestion_run_id = ?1
           AND state IN ('pending', 'captured')
           AND (
             SELECT COALESCE(MAX(attempts.attempt_number), 0)
             FROM source_fetch_attempts AS attempts
             WHERE attempts.ingestion_run_id = source_requests.ingestion_run_id
               AND attempts.request_id = source_requests.request_id
           ) >= retry_generation * ?2`,
      )
      .bind(runId, captureAttemptsPerRetryGeneration),
    database
      .prepare(
        `UPDATE ingestion_runs
         SET state = 'collecting',
             progress_json =
               '{"completed_stages":["planning"],"current_stage":"collecting"}'
         WHERE id = ? AND state = 'paused'`,
      )
      .bind(runId),
    // The reassignment holds only while the run is actually collecting (the
    // statement above just moved it there, or an earlier replay already did)
    // AND the transition count still matches the count this identity was
    // derived from: a concurrent resume that lost the paused -> collecting
    // race derived a later identity, records nothing here, and re-reads the
    // winner's identity instead of binding a competing Workflow Attempt.
    database
      .prepare(
        `UPDATE ingestion_evidence_plans SET parent_workflow_id = ?1
         WHERE ingestion_run_id = ?2
           AND EXISTS (
             SELECT 1 FROM ingestion_runs
             WHERE id = ingestion_evidence_plans.ingestion_run_id
               AND state = 'collecting'
           )
           AND (
             SELECT COUNT(*) FROM ingestion_run_transitions
             WHERE ingestion_run_id = ?2
               AND from_state = 'paused' AND to_state = 'collecting'
           ) = ?3`,
      )
      .bind(parentWorkflowId, runId, resumeCount + 1),
    // The Workflow Attempt row appends atomically with the binding above and
    // under the same guard, so exactly one new current parent attempt exists
    // per recorded resume.
    database
      .prepare(
        `INSERT OR IGNORE INTO ingestion_workflow_attempts (
           ingestion_run_id, workflow_kind, base_workflow_id,
           attempt_number, workflow_instance_id, created_at
         )
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
         WHERE (
           SELECT COUNT(*) FROM ingestion_run_transitions
           WHERE ingestion_run_id = ?1
             AND from_state = 'paused' AND to_state = 'collecting'
         ) = ?7`,
      )
      .bind(
        runId,
        attemptRecord.workflow_kind,
        attemptRecord.base_workflow_id,
        attemptRecord.attempt_number,
        attemptRecord.workflow_instance_id,
        new Date().toISOString(),
        resumeCount + 1,
      ),
  ]);
}

export type CapacityExtensionRequest = Readonly<{
  expected_request_capacity: unknown;
  expected_capacity_generation: unknown;
  request_capacity: unknown;
  idempotency_key: string;
}>;

function requiredCapacityInteger(value: unknown, code: string, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new AdministrationProblem(422, code, `${field} must be a positive integer.`);
  }
  return value as number;
}

// Extend the Request Capacity of a capacity-paused Ingestion Run through a
// compare-and-set on the run's effective capacity and capacity generation.
// The guarded insert advances the generation atomically: a concurrent
// extension can commit at most one record per generation, and every losing
// writer re-reads the retained state to report the precise conflict. The
// immutable extension row doubles as the idempotency record, so an exact
// replay returns the original response without applying another extension.
export async function extendRunRequestCapacity(
  database: D1Database,
  runId: string,
  request: CapacityExtensionRequest,
): Promise<Record<string, unknown>> {
  assertIdentifier(request.idempotency_key, "idempotency_key");
  const expectedRequestCapacity = requiredCapacityInteger(
    request.expected_request_capacity,
    "request_capacity_invalid",
    "expected_request_capacity",
  );
  const expectedCapacityGeneration = requiredCapacityInteger(
    request.expected_capacity_generation,
    "capacity_generation_invalid",
    "expected_capacity_generation",
  );
  const requestedCapacity = requiredCapacityInteger(
    request.request_capacity,
    "request_capacity_invalid",
    "request_capacity",
  );
  const run = await requiredEvidenceRun(database, runId);
  const requestDigest = await sha256(
    utf8(
      canonicalJson({
        ingestion_run_id: runId,
        expected_request_capacity: expectedRequestCapacity,
        expected_capacity_generation: expectedCapacityGeneration,
        request_capacity: requestedCapacity,
        idempotency_key: request.idempotency_key,
      }),
    ),
  );
  const replayed = await capacityExtensionReplay(database, request.idempotency_key, requestDigest);
  if (replayed !== null) return replayed;
  if (run.state !== "paused") throw ingestionRunNotPausedProblem();
  const policy = await runRequestCapacityPolicy(database, runId, run.adapter_version);
  assertExpectedCapacityPolicy(policy, expectedRequestCapacity, expectedCapacityGeneration);
  if (requestedCapacity < policy.request_capacity) {
    throw new AdministrationProblem(
      422,
      "request_capacity_decreased",
      "A capacity extension cannot decrease the effective request capacity.",
    );
  }
  if (requestedCapacity === policy.request_capacity) {
    throw new AdministrationProblem(
      422,
      "request_capacity_unchanged",
      "A capacity extension must exceed the effective request capacity.",
    );
  }
  if (requestedCapacity >= globalEmergencySourceRequestCeiling) {
    throw new AdministrationProblem(
      422,
      "request_capacity_exceeds_global_ceiling",
      "No request capacity may reach the global emergency ceiling.",
    );
  }
  const capacityGeneration = policy.capacity_generation + 1;
  const response: Record<string, unknown> = {
    contract: "card-keepr-capacity-extension@1",
    ingestion_run_id: runId,
    source_lineage: run.source_lineage,
    previous_request_capacity: policy.request_capacity,
    previous_capacity_generation: policy.capacity_generation,
    request_capacity: requestedCapacity,
    capacity_generation: capacityGeneration,
    extended_at: new Date().toISOString(),
  };
  let outcome: D1Result | null = null;
  try {
    outcome = await database
      .prepare(
        `INSERT INTO ingestion_run_capacity_extensions (
           ingestion_run_id, capacity_generation, previous_request_capacity,
           request_capacity, source_lineage, extended_at, idempotency_key,
           request_digest, response_json
         )
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
         WHERE EXISTS (
           SELECT 1 FROM ingestion_runs WHERE id = ?1 AND state = 'paused'
         )
         AND NOT EXISTS (
           SELECT 1 FROM ingestion_run_capacity_extensions
           WHERE ingestion_run_id = ?1 AND capacity_generation >= ?2
         )`,
      )
      .bind(
        runId,
        capacityGeneration,
        policy.request_capacity,
        requestedCapacity,
        run.source_lineage,
        response.extended_at,
        request.idempotency_key,
        requestDigest,
        canonicalJson(response),
      )
      .run();
  } catch {
    outcome = null;
  }
  if (outcome !== null && outcome.meta.changes === 1) return response;
  // The guarded insert lost a race: a replay of this exact request, another
  // extension advancing the generation, or a resumed run. Re-reading the
  // retained state reports the precise conflict.
  const raced = await capacityExtensionReplay(database, request.idempotency_key, requestDigest);
  if (raced !== null) return raced;
  const current = await requiredEvidenceRun(database, runId);
  if (current.state !== "paused") throw ingestionRunNotPausedProblem();
  assertExpectedCapacityPolicy(
    await runRequestCapacityPolicy(database, runId, current.adapter_version),
    expectedRequestCapacity,
    expectedCapacityGeneration,
  );
  throw new AdministrationProblem(
    409,
    "capacity_extension_conflict",
    "A concurrent capacity extension prevented this extension from applying.",
  );
}

function ingestionRunNotPausedProblem(): AdministrationProblem {
  return new AdministrationProblem(
    409,
    "ingestion_run_not_paused",
    "Only a capacity-paused Ingestion Run can have its request capacity extended.",
  );
}

function assertExpectedCapacityPolicy(
  policy: RunCapacityPolicy,
  expectedRequestCapacity: number,
  expectedCapacityGeneration: number,
): void {
  if (expectedCapacityGeneration !== policy.capacity_generation) {
    throw new AdministrationProblem(
      409,
      "capacity_generation_mismatch",
      `The expected capacity generation is stale: the run is at generation ${policy.capacity_generation}.`,
    );
  }
  if (expectedRequestCapacity !== policy.request_capacity) {
    throw new AdministrationProblem(
      409,
      "request_capacity_mismatch",
      `The expected request capacity is stale: the effective capacity is ${policy.request_capacity}.`,
    );
  }
}

async function capacityExtensionReplay(
  database: D1Database,
  idempotencyKey: string,
  requestDigest: string,
): Promise<Record<string, unknown> | null> {
  const retained = await database
    .prepare(
      `SELECT request_digest, response_json
       FROM ingestion_run_capacity_extensions
       WHERE idempotency_key = ?`,
    )
    .bind(idempotencyKey)
    .first<{ request_digest: string; response_json: string }>();
  if (retained === null) return null;
  if (retained.request_digest !== requestDigest) {
    throw new AdministrationProblem(
      409,
      "idempotency_conflict",
      "The idempotency key was already used for a different capacity extension.",
    );
  }
  return JSON.parse(retained.response_json) as Record<string, unknown>;
}

export type CollectionTerminationRequest = Readonly<{
  idempotency_key: string;
}>;

// The stable terminal reason of an owner-terminated Ingestion Run.
export const ingestionRunTerminatedFailureCode = "ingestion_run_terminated";

// The collection actions the lifecycle currently admits for a run in the
// given state (approval and rejection belong to the run document): the
// inspection document lists them explicitly so automation never infers
// valid transitions. A capacity-paused run may be
// resumed as-is (re-admission simply pauses it again if nothing changed),
// extended, or terminated; every other pause resumes or terminates; a
// terminal evidence run can only be retried as a new linked run.
export function collectionActions(state: string, pauseReason: string | null): string[] {
  if (state === "paused") {
    return pauseReason === "source_request_capacity_exhausted"
      ? ["resume", "extend_capacity", "terminate"]
      : ["resume", "terminate"];
  }
  if (state === "collecting") return ["pause"];
  if (state === "failed" || state === "rejected" || state === "expired") {
    return ["retry"];
  }
  return [];
}

type CapacityPauseRow = {
  pause_reason: string;
  paused_at: string;
  source_lineage: string;
  parent_request_id: string;
  request_capacity: number;
  capacity_generation: number;
  used_capacity: number;
  overflow_request_count: number;
  required_capacity: number;
};

type RetryPauseRow = {
  pause_reason: string;
  paused_at: string;
  source_lineage: string;
  request_id: string;
  hostname: string;
  retry_generation: number;
  attempt_count: number;
  failure_classification: string;
  http_status: number | null;
};

type WorkflowPauseRow = {
  pause_reason: string;
  paused_at: string;
  workflow_instance_id: string;
  workflow_status: string;
  last_progress_at: string | null;
};

// The current pause of a run: the newest record across the capacity,
// retry-exhaustion, and Workflow pause tables (a retry pause wins an equal
// capacity-pause timestamp, because a run can only re-enter capacity
// admission after the exhausted request recovers; a Workflow pause wins any
// equal timestamp, because it is recorded by a later explicit recovery
// classification). Historical records from earlier pauses of the same run
// stay retained but are not the current pause. The pause documents have a
// closed shape: correlation identifiers, bounded counters, and machine codes
// only, so the owner-facing status surface stays free of request headers,
// payloads, and credentials.
export async function currentPause(database: D1Database, runId: string): Promise<CurrentPause | null> {
  const [capacity, retry, workflow] = await Promise.all([
    database
      .prepare(
        `SELECT * FROM ingestion_run_capacity_pauses
         WHERE ingestion_run_id = ?
         ORDER BY capacity_generation DESC LIMIT 1`,
      )
      .bind(runId)
      .first<CapacityPauseRow>(),
    database
      .prepare(
        `SELECT * FROM ingestion_run_retry_pauses
         WHERE ingestion_run_id = ?
         ORDER BY paused_at DESC, retry_generation DESC LIMIT 1`,
      )
      .bind(runId)
      .first<RetryPauseRow>(),
    database
      .prepare(
        `SELECT * FROM ingestion_run_workflow_pauses
         WHERE ingestion_run_id = ?
         ORDER BY paused_at DESC LIMIT 1`,
      )
      .bind(runId)
      .first<WorkflowPauseRow>(),
  ]);
  const retryNewest = retry !== null && (capacity === null || retry.paused_at >= capacity.paused_at);
  const requestPause: CurrentPause | null =
    retryNewest && retry !== null
      ? {
          reason: retry.pause_reason,
          paused_at: retry.paused_at,
          document: retryPauseDocument(retry),
        }
      : capacity === null
        ? null
        : {
            reason: capacity.pause_reason,
            paused_at: capacity.paused_at,
            document: capacityPauseDocument(capacity),
          };
  if (workflow !== null && (requestPause === null || workflow.paused_at >= requestPause.paused_at)) {
    return {
      reason: workflow.pause_reason,
      paused_at: workflow.paused_at,
      document: workflowPauseDocument(workflow),
    };
  }
  return requestPause;
}

type TerminationRow = {
  pause_reason: string;
  paused_at: string;
  terminated_at: string;
  idempotency_key: string;
  request_digest: string;
  response_json: string;
};

// Terminate a paused Ingestion Run deliberately. The guarded batch is a
// compare-and-set on the run still being paused: the immutable termination
// record is inserted first (its trigger requires the paused run), and the
// paused -> failed transition is legal only once that record exists, so a
// concurrent resume, capacity extension, or second termination resolves as
// an explicit state conflict rather than a double outcome. Nothing retained
// is deleted; the active-run reservation is released separately by the
// administration layer after it has fenced late Workflow work, so the
// retained response records only the decision, never the release.
export async function terminateEvidenceRun(
  database: D1Database,
  runId: string,
  request: CollectionTerminationRequest,
): Promise<Record<string, unknown>> {
  assertIdentifier(request.idempotency_key, "idempotency_key");
  const run = await requiredEvidenceRun(database, runId);
  const requestDigest = await sha256(
    utf8(
      canonicalJson({
        ingestion_run_id: runId,
        idempotency_key: request.idempotency_key,
      }),
    ),
  );
  const replayed = await terminationReplay(database, request.idempotency_key, requestDigest);
  if (replayed !== null) return replayed;
  if (run.state !== "paused") throw ingestionRunNotPausedForTermination();
  const pause = await currentPause(database, runId);
  if (pause === null) {
    throw new Error("The paused Ingestion Run has no retained pause record.");
  }
  const terminatedAt = new Date().toISOString();
  const response: Record<string, unknown> = {
    contract: "card-keepr-collection-termination@1",
    ingestion_run_id: runId,
    state: "failed",
    failure_code: ingestionRunTerminatedFailureCode,
    pause_reason: pause.reason,
    paused_at: pause.paused_at,
    terminated_at: terminatedAt,
  };
  let transitioned = false;
  try {
    const outcome = await database.batch([
      database
        .prepare(
          `INSERT INTO ingestion_run_terminations (
             ingestion_run_id, pause_reason, paused_at, terminated_at,
             idempotency_key, request_digest, response_json
           )
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
           WHERE EXISTS (
             SELECT 1 FROM ingestion_runs WHERE id = ?1 AND state = 'paused'
           )`,
        )
        .bind(
          runId,
          pause.reason,
          pause.paused_at,
          terminatedAt,
          request.idempotency_key,
          requestDigest,
          canonicalJson(response),
        ),
      database
        .prepare(
          `UPDATE ingestion_runs
           SET state = 'failed', terminal_at = ?2, failure_code = ?3,
               progress_json =
                 '{"completed_stages":["planning"],"current_stage":"failed"}'
           WHERE id = ?1 AND state = 'paused'
             AND EXISTS (
               SELECT 1 FROM ingestion_run_terminations
               WHERE ingestion_run_id = ?1 AND idempotency_key = ?4
             )`,
        )
        .bind(runId, terminatedAt, ingestionRunTerminatedFailureCode, request.idempotency_key),
      database
        .prepare(
          `UPDATE ingestion_evidence_plans SET failure_code = ?2
           WHERE ingestion_run_id = ?1
             AND EXISTS (
               SELECT 1 FROM ingestion_runs
               WHERE id = ?1 AND state = 'failed' AND failure_code = ?2
             )`,
        )
        .bind(runId, ingestionRunTerminatedFailureCode),
    ]);
    transitioned = outcome[1]?.meta.changes === 1;
  } catch {
    transitioned = false;
  }
  if (transitioned) return response;
  // The guarded batch lost a race: a replay of this exact request, a resume,
  // an extension, or another termination. Re-reading the retained state
  // reports the precise conflict.
  const raced = await terminationReplay(database, request.idempotency_key, requestDigest);
  if (raced !== null) return raced;
  const current = await requiredEvidenceRun(database, runId);
  if (current.state !== "paused") throw ingestionRunNotPausedForTermination();
  throw new AdministrationProblem(
    409,
    "collection_termination_conflict",
    "A concurrent lifecycle action prevented this termination from applying.",
  );
}

function ingestionRunNotPausedForTermination(): AdministrationProblem {
  return new AdministrationProblem(409, "ingestion_run_not_paused", "Only a paused Ingestion Run can be terminated.");
}

async function terminationReplay(
  database: D1Database,
  idempotencyKey: string,
  requestDigest: string,
): Promise<Record<string, unknown> | null> {
  const retained = await replayByDigest({
    lookup: () =>
      database
        .prepare(
          `SELECT request_digest, response_json
         FROM ingestion_run_terminations
         WHERE idempotency_key = ?`,
        )
        .bind(idempotencyKey)
        .first<Pick<TerminationRow, "request_digest" | "response_json">>(),
    retainedDigest: (row) => row.request_digest,
    requestDigest,
    conflictDetail: "The idempotency key was already used for a different termination.",
  });
  if (retained === null) return null;
  return JSON.parse(retained.response_json) as Record<string, unknown>;
}

// Release the single active-run reservation of a terminated run and report
// whether the run holds it no longer. Guarded on the terminal owner decision
// so it can never release a live run, and idempotent so a replayed
// termination re-runs it harmlessly.
export async function releaseTerminatedEvidenceRun(database: D1Database, runId: string): Promise<boolean> {
  await database
    .prepare(
      `UPDATE operation_state SET active_ingestion_run_id = NULL
       WHERE singleton = 1 AND active_ingestion_run_id = ?1
         AND EXISTS (
           SELECT 1 FROM ingestion_runs
           WHERE id = ?1 AND state = 'failed' AND failure_code = ?2
         )`,
    )
    .bind(runId, ingestionRunTerminatedFailureCode)
    .run();
  const operation = await database
    .prepare("SELECT active_ingestion_run_id FROM operation_state WHERE singleton = 1")
    .first<{ active_ingestion_run_id: string | null }>();
  return operation !== null && operation.active_ingestion_run_id !== runId;
}

// The retained owner decision of a terminated run, or null while the run was
// never terminated.
export async function terminationDocument(
  database: D1Database,
  runId: string,
): Promise<Record<string, unknown> | null> {
  const row = await database
    .prepare(
      `SELECT pause_reason, paused_at, terminated_at
       FROM ingestion_run_terminations WHERE ingestion_run_id = ?`,
    )
    .bind(runId)
    .first<Pick<TerminationRow, "pause_reason" | "paused_at" | "terminated_at">>();
  return row === null
    ? null
    : {
        reason: ingestionRunTerminatedFailureCode,
        pause_reason: row.pause_reason,
        paused_at: row.paused_at,
        terminated_at: row.terminated_at,
      };
}

// The Workflow instance identities termination must fence: the current
// parent attempt and every current hostname-shard child attempt.
export async function currentCollectionWorkflowIds(
  database: D1Database,
  runId: string,
): Promise<{ parent: string[]; child: string[] }> {
  const run = await requiredEvidenceRun(database, runId);
  const rows = await workflowAttemptRows(database, runId);
  const attempts = resolvedWorkflowAttempts(run, rows);
  const current = attempts.attempts.filter(attempts.isCurrent);
  return {
    parent: current
      .filter((attempt) => attempt.workflow_kind === "parent")
      .map((attempt) => attempt.workflow_instance_id),
    child: current
      .filter((attempt) => attempt.workflow_kind === "child")
      .map((attempt) => attempt.workflow_instance_id),
  };
}

export async function finalizeEvidenceRun(database: D1Database, runId: string): Promise<void> {
  // A Printing Image that failed under one of its tolerated codes (exhausted
  // transport retries, or a terminal outcome such as a missing or redirected
  // file) is recorded on its own request, reported by inspection, and
  // carried into reconciliation as an explicit gap, but it never fails the
  // run. Every other failed request is missing catalogue facts.
  const toleratedImageCodes = JSON.stringify(toleratedPrintingImageFailureCodes);
  const counts = await database
    .prepare(
      `SELECT
        SUM(CASE WHEN state IN ('pending', 'captured') THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN state = 'failed'
                  AND NOT (request_role = 'image'
                    AND failure_code IN (SELECT value FROM json_each(?2)))
                 THEN 1 ELSE 0 END) AS failed
       FROM source_requests WHERE ingestion_run_id = ?1`,
    )
    .bind(runId, toleratedImageCodes)
    .first<{ active: number | null; failed: number | null }>();
  if (counts === null || (counts.active ?? 0) > 0) return;
  const completedAt = new Date().toISOString();
  const lifecycleV2 = await supportsLifecycleV2(database);
  if ((counts.failed ?? 0) > 0) {
    const failure = await database
      .prepare(
        `SELECT failure_code FROM source_requests
         WHERE ingestion_run_id = ?1 AND state = 'failed'
           AND NOT (request_role = 'image'
             AND failure_code IN (SELECT value FROM json_each(?2)))
         ORDER BY sequence_number LIMIT 1`,
      )
      .bind(runId, toleratedImageCodes)
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
      // Completion is recorded once: a superseded parent attempt that wakes
      // from its barrier sleep after the run completed under a later attempt
      // must not move the retained completion facts.
      database
        .prepare(
          `UPDATE ingestion_evidence_plans
           SET collection_completed_at = ?, failure_code = ?
           WHERE ingestion_run_id = ? AND collection_completed_at IS NULL`,
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
         WHERE ingestion_run_id = ? AND collection_completed_at IS NULL`,
      )
      .bind(completedAt, runId),
  ]);
}

// The Workflow bindings and pacing configuration the inspection document
// reads live facts from. All are optional: repository callers without the
// runtime (creation replies, tests) still get every persisted fact.
export type EvidenceInspectionOptions = Readonly<{
  parentWorkflow?: Workflow<EvidenceParentWorkflowParams>;
  hostWorkflow?: Workflow<EvidenceHostWorkflowParams>;
  pacing?: PacingConfiguration;
}>;

const defaultPacingConfiguration: PacingConfiguration = {
  mode: "production",
  interval_ms: defaultSourceHostPacingIntervalMilliseconds,
};

export async function showEvidenceRun(
  database: D1Database,
  runId: string,
  options: EvidenceInspectionOptions = {},
): Promise<Record<string, unknown>> {
  const run = await requiredEvidenceRun(database, runId);
  const evidencePlans = parseEvidencePlans(run.request_plan_json);
  const [detail, collectionPlans, curatedSet, pause, termination, workflowAttempts, progress] = await Promise.all([
    boundedEvidenceDetail(database, runId),
    database
      .prepare(
        `SELECT source_lineage, discovery_observation_set_id, contract,
                collection_plan_json, content_digest, created_at
         FROM official_source_collection_plans
         WHERE ingestion_run_id = ? ORDER BY source_lineage`,
      )
      .bind(runId)
      .all<{
        source_lineage: string;
        discovery_observation_set_id: string;
        contract: string;
        collection_plan_json: string;
        content_digest: string;
        created_at: string;
      }>(),
    curatedRevisionSetForRun(database, runId),
    currentPause(database, runId),
    terminationDocument(database, runId),
    workflowAttemptRows(database, runId),
    collectionProgressFacts(database, runId),
  ]);
  // A paused run reports exactly one pause, its current one; a terminated
  // run reports the owner decision instead. Both carry the exact owner
  // actions the lifecycle admits for the run's state and pause reason.
  const actions = collectionActions(run.state, run.state === "paused" ? (pause?.reason ?? null) : null);
  const lifecycleBlocks: Record<string, unknown> = {
    ...(run.state === "paused" && pause !== null ? { pause: { ...pause.document, actions } } : {}),
    ...(termination === null ? {} : { termination }),
    actions,
  };
  const capacityPolicies = new Map<string, RunCapacityPolicy>();
  for (const plan of evidencePlans) {
    if (capacityPolicies.has(plan.source_lineage)) continue;
    capacityPolicies.set(plan.source_lineage, await runRequestCapacityPolicy(database, runId, plan.adapter_version));
  }
  const inspection = await collectionInspection(database, {
    run,
    plans: evidencePlans,
    capacityPolicies,
    pause,
    lastProgressAt: progress.last_progress_at,
    pacing: options.pacing ?? defaultPacingConfiguration,
    nowMs: Date.now(),
  });
  const document: Record<string, unknown> = {
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
    official_source_collection_plans: collectionPlans.results.map((row) => ({
      source_lineage: row.source_lineage,
      discovery_observation_set_id: row.discovery_observation_set_id,
      contract: row.contract,
      content_digest: row.content_digest,
      created_at: row.created_at,
      plan: JSON.parse(row.collection_plan_json),
    })),
    idempotency_key: run.idempotency_key,
    linked_run_id: run.linked_run_id,
    expected_current_revision_id: run.expected_current_revision_id,
    started_at: run.started_at,
    collection_completed_at: run.collection_completed_at,
    failure_code: run.failure_code,
    ...lifecycleBlocks,
    ...(curatedSet === null
      ? {}
      : {
          curated_revision_ids: curatedSet.revision_ids,
          curated_revision_set_digest: curatedSet.set_digest,
        }),
    collection: inspection.collection,
    workflow: await collectionWorkflowDocument(
      run,
      workflowAttempts,
      progress,
      options.parentWorkflow,
      options.hostWorkflow,
    ),
    snapshots: detail.snapshots.map(publicSnapshot),
    observation_sets: detail.observationSets.map(publicObservationSet),
    diagnostics: detail.attempts.map((row) => ({
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
  return {
    ...document,
    operational_diagnostics: operationalDiagnostics({
      ...document,
      evidence_counts: inspection.counts,
      operational_request_id: run.operational_request_id,
      candidate_digest: run.candidate_digest,
      progress: JSON.parse(run.progress_json),
      warnings: JSON.parse(run.warnings_json),
      approval_history: JSON.parse(run.approval_history_json),
      terminal_at: run.terminal_at,
      published_revision_id: run.published_revision_id,
      resulting_revision_id: run.resulting_revision_id,
      publication_outcome: run.publication_outcome,
    }),
  };
}

// The closed pause block shapes: correlation identifiers, bounded counters,
// and machine codes only, so the owner-facing status surface stays free of
// request headers, payloads, and credentials.
function retryPauseDocument(row: RetryPauseRow): Record<string, unknown> {
  return {
    reason: row.pause_reason,
    paused_at: row.paused_at,
    source_lineage: row.source_lineage,
    request_id: row.request_id,
    hostname: row.hostname,
    retry_generation: row.retry_generation,
    attempt_count: row.attempt_count,
    failure_classification: row.failure_classification,
    http_status: row.http_status,
  };
}

function workflowPauseDocument(row: WorkflowPauseRow): Record<string, unknown> {
  return {
    reason: row.pause_reason,
    paused_at: row.paused_at,
    workflow_instance_id: row.workflow_instance_id,
    workflow_status: row.workflow_status,
    last_progress_at: row.last_progress_at,
  };
}

type WorkflowAttemptRow = {
  workflow_kind: string;
  base_workflow_id: string;
  attempt_number: number;
  workflow_instance_id: string;
  created_at: string;
};

async function workflowAttemptRows(database: D1Database, runId: string): Promise<WorkflowAttemptRow[]> {
  const rows = await database
    .prepare(
      `SELECT workflow_kind, base_workflow_id, attempt_number,
              workflow_instance_id, created_at
       FROM ingestion_workflow_attempts
       WHERE ingestion_run_id = ?
       ORDER BY workflow_kind, base_workflow_id, attempt_number`,
    )
    .bind(runId)
    .all<WorkflowAttemptRow>();
  return rows.results;
}

// Every Workflow Attempt of a run with exactly one current attempt per
// scope. Runs recorded before the attempt table existed synthesize their
// attempts from the retained identity columns, so historical Workflow
// references stay auditable, and parent identities are deterministic, so
// attempts predating their recorded rows are reconstructed below the highest
// known attempt.
function resolvedWorkflowAttempts(
  run: IngestionEvidenceRow,
  attemptRows: readonly WorkflowAttemptRow[],
): {
  attempts: WorkflowAttemptRow[];
  isCurrent: (attempt: WorkflowAttemptRow) => boolean;
} {
  const childIds: string[] = run.child_workflow_ids_json === null ? [] : JSON.parse(run.child_workflow_ids_json);
  const recorded = new Map(attemptRows.map((row) => [row.workflow_instance_id, row]));
  for (const legacyId of [run.parent_workflow_id, ...childIds]) {
    if (legacyId === null || recorded.has(legacyId)) continue;
    const record = workflowAttemptRecord(run.id, legacyId);
    recorded.set(legacyId, { ...record, created_at: "" });
  }
  const highestParentAttempt = Math.max(
    0,
    ...[...recorded.values()]
      .filter((record) => record.workflow_kind === "parent")
      .map((record) => record.attempt_number),
  );
  for (let attempt = 1; attempt < highestParentAttempt; attempt += 1) {
    const attemptId = parentWorkflowAttemptId(run.id, attempt);
    if (recorded.has(attemptId)) continue;
    recorded.set(attemptId, {
      ...workflowAttemptRecord(run.id, attemptId),
      created_at: "",
    });
  }
  const attempts = [...recorded.values()].sort(
    (left, right) =>
      left.workflow_kind.localeCompare(right.workflow_kind) ||
      left.base_workflow_id.localeCompare(right.base_workflow_id) ||
      left.attempt_number - right.attempt_number,
  );
  const currentAttemptNumbers = new Map<string, number>();
  for (const attempt of attempts) {
    const scope = `${attempt.workflow_kind} ${attempt.base_workflow_id}`;
    currentAttemptNumbers.set(scope, Math.max(currentAttemptNumbers.get(scope) ?? 0, attempt.attempt_number));
  }
  return {
    attempts,
    isCurrent: (attempt) =>
      currentAttemptNumbers.get(`${attempt.workflow_kind} ${attempt.base_workflow_id}`) === attempt.attempt_number,
  };
}

// The safe Workflow observability block: append-only attempt references with
// exactly one current attempt per scope, the deterministic last-progress
// time, and — when the parent Workflow binding is supplied — the current
// parent attempt's platform status mapped onto the closed safe vocabulary
// plus its stall classification while the run collects.
async function collectionWorkflowDocument(
  run: IngestionEvidenceRow,
  attemptRows: readonly WorkflowAttemptRow[],
  progress: CollectionProgressFacts,
  parentWorkflow?: Workflow<EvidenceParentWorkflowParams>,
  hostWorkflow?: Workflow<EvidenceHostWorkflowParams>,
): Promise<Record<string, unknown>> {
  const childIds: string[] = run.child_workflow_ids_json === null ? [] : JSON.parse(run.child_workflow_ids_json);
  const { attempts, isCurrent } = resolvedWorkflowAttempts(run, attemptRows);
  const currentParent =
    attempts
      .filter((attempt) => attempt.workflow_kind === "parent")
      .filter(isCurrent)
      .at(-1) ?? null;
  // Every recorded attempt, active or historical, reports its platform
  // status mapped onto the closed safe vocabulary; a binding that is not
  // supplied leaves the status unknown (null) rather than guessing.
  const statuses = new Map<string, SafeWorkflowStatus | null>(
    await Promise.all(
      attempts.map(async (attempt) => {
        const binding = attempt.workflow_kind === "parent" ? parentWorkflow : hostWorkflow;
        if (binding === undefined) {
          return [attempt.workflow_instance_id, null] as const;
        }
        try {
          const instance = await binding.get(attempt.workflow_instance_id);
          return [attempt.workflow_instance_id, safeWorkflowStatus((await instance.status()).status)] as const;
        } catch {
          return [attempt.workflow_instance_id, "unavailable"] as const;
        }
      }),
    ),
  );
  const status: SafeWorkflowStatus | null =
    currentParent === null ? null : (statuses.get(currentParent.workflow_instance_id) ?? null);
  const classification =
    status === null || run.state !== "collecting" ? null : classifyCollectionProgress(status, progress);
  return {
    parent_id: run.parent_workflow_id,
    child_ids: childIds,
    last_progress_at: progress.last_progress_at,
    current_attempt:
      currentParent === null
        ? null
        : {
            id: currentParent.workflow_instance_id,
            attempt_number: currentParent.attempt_number,
            created_at: currentParent.created_at === "" ? null : currentParent.created_at,
            status,
          },
    attempts: attempts.map((attempt) => ({
      id: attempt.workflow_instance_id,
      kind: attempt.workflow_kind,
      attempt_number: attempt.attempt_number,
      created_at: attempt.created_at === "" ? null : attempt.created_at,
      current: isCurrent(attempt),
      status: statuses.get(attempt.workflow_instance_id) ?? null,
    })),
    ...(status === null ? {} : { status }),
    ...(classification === null
      ? {}
      : {
          classification: classification.kind === "recover" ? classification.reason : classification.kind,
        }),
  };
}

function capacityPauseDocument(row: CapacityPauseRow): Record<string, unknown> {
  return {
    reason: row.pause_reason,
    paused_at: row.paused_at,
    source_lineage: row.source_lineage,
    parent_request_id: row.parent_request_id,
    request_capacity: row.request_capacity,
    capacity_generation: row.capacity_generation,
    used_capacity: row.used_capacity,
    overflow_request_count: row.overflow_request_count,
    required_capacity: row.required_capacity,
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

export function publicObservationSet(row: ObservationSetRow): Record<string, unknown> {
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
    operationalRequestId?: string | null;
  },
): Promise<D1PreparedStatement> {
  const baseValues = [
    input.runId,
    canonicalJson(input.supportedGames),
    input.startedAt,
    input.linkedRunId,
    input.idempotencyKey,
    input.operationalRequestId ?? null,
  ];
  if (await supportsLifecycleV2(database)) {
    return database
      .prepare(
        `INSERT INTO ingestion_runs (
          id, state, selected_games_json, started_at,
          expected_current_revision_id, linked_run_id, idempotency_key,
          operational_request_id,
          candidate_digest, candidate_created_at, approval_deadline,
          approval_json, published_revision_id, export_manifest_digest,
          terminal_at, candidate_json, approval_idempotency_key,
          progress_json, warnings_json, approval_history_json
        ) SELECT
          ?, 'collecting', ?, ?, catalogue.current_revision_id, ?, ?, ?,
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{}', NULL,
          '{"completed_stages":["planning"],"current_stage":"collecting"}',
          '[]', '[]'
        FROM catalogue_state AS catalogue
        JOIN operation_state AS operation ON operation.singleton = 1
        WHERE catalogue.singleton = 1
          AND operation.recovery_health <> 'blocked'
          AND operation.active_ingestion_run_id IS NULL`,
      )
      .bind(...baseValues);
  }
  return database
    .prepare(
      `INSERT INTO ingestion_runs (
        id, state, selected_games_json, started_at,
        expected_current_revision_id, linked_run_id, idempotency_key,
        operational_request_id,
        candidate_digest, candidate_created_at, approval_deadline,
        approval_json, published_revision_id, export_manifest_digest,
        terminal_at, candidate_json, approval_idempotency_key
      ) SELECT
        ?, 'collecting', ?, ?, catalogue.current_revision_id, ?, ?, ?,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{}', NULL
      FROM catalogue_state AS catalogue
      JOIN operation_state AS operation ON operation.singleton = 1
      WHERE catalogue.singleton = 1
        AND operation.recovery_health <> 'blocked'
        AND operation.active_ingestion_run_id IS NULL`,
    )
    .bind(...baseValues);
}

async function supportsLifecycleV2(database: D1Database): Promise<boolean> {
  const columns = await database.prepare("PRAGMA table_info(ingestion_runs)").all<{ name: string }>();
  return columns.results.some((column) => column.name === "progress_json");
}
