import { AdministrationProblem } from "./ingestion";
import { canonicalJson, sha256, utf8 } from "./serialization";
import {
  assertBoundedOfficialSourceRequest,
  assertIdentifier,
  parseEvidencePlans,
  parseStringRecord,
  type EvidencePlan,
  type OfficialSourceCollectionPlan,
  type OfficialSourceCollectionRequest,
  type StartEvidenceRunRequest,
  validateEvidencePlans,
} from "./source-evidence-model";
import {
  globalEmergencySourceRequestCeiling,
  type SourceAdapterRegistration,
} from "./source-adapters";
import { evidenceRunIdentity } from "./idempotent-identities";
import {
  curatedRevisionSetForRun,
  curatedRevisionPinStatementsForNewRun,
} from "./curated-revisions";
import { operationalDiagnostics } from "./operational-diagnostics";

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
  discoveryKey?: string;
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
      supportedGames: [
        ...new Set(plans.map(({ supported_game }) => supported_game)),
      ].sort(),
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
    const concurrent = await evidenceRunByIdempotencyKey(
      database,
      request.idempotency_key,
    );
    if (
      concurrent !== null &&
      sameEvidencePlanIntent(concurrent.request_plan_json, planJson)
    ) {
      return showEvidenceRun(database, concurrent.id);
    }
    await throwIfRecoveryBlocked(database);
    await throwIfAnotherRunActive(database);
    if (errorMessage(error).includes("active_ingestion_run")) {
      throw activeRunProblem();
    }
    if (errorMessage(error).includes("curated_revision_reconfirmation_required")) {
      throw new AdministrationProblem(409, "curated_revision_reconfirmation_required", "A Curated Revision for a selected Supported Game requires reconfirmation.");
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

function sameEvidencePlanIntent(
  retainedJson: string,
  requestedJson: string,
): boolean {
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
    .prepare(
      "SELECT recovery_health FROM operation_state WHERE singleton = 1",
    )
    .first<{ recovery_health: string }>();
  if (operation === null) throw new Error("Operation state is unavailable.");
  assertRecoveryAvailable(operation.recovery_health);
  const runId = await evidenceRunIdentity(idempotencyKey);
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
      throw new AdministrationProblem(409, "curated_revision_reconfirmation_required", "A Curated Revision for a selected Supported Game requires reconfirmation.");
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
    .prepare(
      "SELECT recovery_health FROM operation_state WHERE singleton = 1",
    )
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

// Request capacity is the immutable policy of the exact Source Adapter
// Version owning an Evidence Plan, counted per Source Lineage over unique
// Source Request identities across initial, dynamically discovered, and
// collection-plan roles. The registered column is clamped by the global
// emergency ceiling so no database row can authorize unbounded discovery.
async function adapterRequestCapacity(
  database: D1Database,
  adapterVersion: string,
): Promise<number> {
  const registered = await database
    .prepare(
      `SELECT request_capacity FROM source_adapter_versions
       WHERE adapter_version = ?`,
    )
    .bind(adapterVersion)
    .first<{ request_capacity: number }>();
  if (
    registered === null ||
    !Number.isSafeInteger(registered.request_capacity) ||
    registered.request_capacity < 1
  ) {
    throw new Error(
      `Source Adapter Version ${adapterVersion} has no registered request capacity.`,
    );
  }
  return Math.min(
    registered.request_capacity,
    globalEmergencySourceRequestCeiling,
  );
}

function requestCapacityProblem(): AdministrationProblem {
  return new AdministrationProblem(
    422,
    "source_discovery_too_large",
    "The Official Source request graph exceeds the Source Adapter Version request capacity.",
  );
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
  const normalizedById = new Map<string, {
    id: string;
    url: string;
    headers_json: string;
    representation_fingerprint: string;
    role: DiscoveredEvidenceRequest["role"];
    sequence_floor: number;
  }>();
  for (const request of discovered) {
    if (
      request.discoveryKey !== undefined &&
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(request.discoveryKey)
    ) {
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
    const requestId = request.discoveryKey === undefined
      ? `${plan.source_lineage}:${request.role}:${digest}`
      : `${plan.source_lineage}:${request.role}:${request.discoveryKey}:${digest}`;
    normalizedById.set(requestId, {
      id: requestId,
      url,
      headers_json: headersJson,
      representation_fingerprint: await sha256(
        utf8(canonicalJson({ method: "GET", url, headers: request.headers })),
      ),
      role: request.role,
      sequence_floor: request.discoveryKey === undefined ? 0 : 1_000_000,
    });
  }
  const normalized = [...normalizedById.values()];
  const proposedRequestIds = JSON.stringify(normalized.map(({ id }) => id));
  const requestCapacity = await adapterRequestCapacity(
    database,
    plan.adapter_version,
  );
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
  const existing = normalized.length === 0
    ? { count: 0 }
    : await database
      .prepare(
        `SELECT COUNT(*) AS count FROM source_requests
         WHERE ingestion_run_id = ?
           AND request_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(run.id, proposedRequestIds)
      .first<{ count: number }>();
  if (
    count === null || existing === null ||
    count.count + normalized.length - existing.count > requestCapacity
  ) {
    throw requestCapacityProblem();
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
    database.prepare(
      `SELECT CASE WHEN ${admittedLineageCountSql} > ?5
         THEN json('source_discovery_too_large') ELSE 1 END`,
    ).bind(
      run.id,
      lineageRequestPattern,
      planRequestIds,
      proposedRequestIds,
      requestCapacity,
    ),
  ];
  for (const chunk of chunks) {
    const json = JSON.stringify(chunk);
    statements.push(
      database.prepare(
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
      ).bind(json, run.id),
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
        .bind(
          run.id,
          parent.request_id,
          json,
          run.id,
        ),
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
      lineageRequestPattern,
      planRequestIds,
      proposedRequestIds,
      requestCapacity,
    );
  }
  const retainedResults = await database.batch<EvidenceRequestRow>(
    chunks.map((chunk) =>
      database.prepare(
        `SELECT * FROM source_requests
         WHERE ingestion_run_id = ?
           AND request_id IN (
             SELECT json_extract(value, '$.id') FROM json_each(?)
           )`,
      ).bind(run.id, JSON.stringify(chunk))
    ),
  );
  const retainedById = new Map(
    retainedResults.flatMap(({ results }) => results)
      .map((row) => [row.request_id, row] as const),
  );
  const inserted: EvidenceRequestRow[] = [];
  for (const expected of normalized) {
    const retained = retainedById.get(expected.id);
    if (
      retained === null ||
      retained === undefined ||
      retained.url !== expected.url ||
      retained.request_headers_json !== expected.headers_json ||
      retained.representation_fingerprint !==
        expected.representation_fingerprint ||
      retained.request_role !== expected.role
    ) {
      throw new Error(
        "Discovered Source Request identity collided with different immutable evidence.",
      );
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
  lineageRequestPattern: string,
  planRequestIds: string,
  proposedRequestIds: string,
  requestCapacity: number,
): Promise<unknown> {
  if (!/malformed JSON/iu.test(errorMessage(error))) return error;
  const recounted = await database
    .prepare(`SELECT ${admittedLineageCountSql} AS count`)
    .bind(runId, lineageRequestPattern, planRequestIds, proposedRequestIds)
    .first<{ count: number }>();
  if (recounted === null || recounted.count > requestCapacity) {
    return requestCapacityProblem();
  }
  return new Error(
    "Discovered Source Request identity collided with different immutable evidence.",
  );
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
  const owner = await database.prepare(
    `SELECT snapshot.source_lineage
     FROM source_observation_sets AS observation_set
     JOIN source_snapshots AS snapshot
       ON snapshot.id = observation_set.source_snapshot_id
     WHERE observation_set.id = ? AND snapshot.ingestion_run_id = ?`,
  ).bind(discoveryObservationSetId, runId)
    .first<{ source_lineage: string }>();
  if (owner === null) {
    throw new Error(
      "The discovery observation is not owned by this Ingestion Run.",
    );
  }
  const plans = parseEvidencePlans(run.request_plan_json);
  const planIndex = plans.findIndex(
    (plan) => plan.source_lineage === owner.source_lineage,
  );
  const discoveryPlan = plans[planIndex];
  if (discoveryPlan === undefined) {
    throw new Error(
      "The discovery observation has no owning immutable Evidence Plan.",
    );
  }
  if (
    discoveryPlan.requests.length !== 1 ||
    ![
      "discovery",
      `${discoveryPlan.source_lineage}:discovery`,
    ].includes(discoveryPlan.requests[0]!.id)
  ) {
    throw new Error(
      "Complete Official Source planning lost its discovery seed.",
    );
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
    if (
      retained.collection_plan_json !== collectionPlanJson ||
      retained.content_digest !== contentDigest
    ) {
      throw new Error(
        "Live Official Source discovery changed after immutable collection planning.",
      );
    }
    return;
  }
  const requestCapacity = await adapterRequestCapacity(
    database,
    discoveryPlan.adapter_version,
  );
  const lineageRequestPattern = `${discoveryPlan.source_lineage}:%`;
  const planRequestIds = JSON.stringify(
    discoveryPlan.requests.map(({ id }) => id),
  );
  const collectionRequestIds = JSON.stringify(
    discoveredRequests.map(({ id }) => id),
  );
  const admitted = await database
    .prepare(`SELECT ${admittedLineageCountSql} AS count`)
    .bind(runId, lineageRequestPattern, planRequestIds, collectionRequestIds)
    .first<{ count: number }>();
  if (admitted === null || admitted.count > requestCapacity) {
    throw requestCapacityProblem();
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
        .bind(
          runId,
          lineageRequestPattern,
          planRequestIds,
          collectionRequestIds,
          requestCapacity,
        ),
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
            plans.flatMap((plan) => plan.requests).length +
              planIndex * 10000 + index,
            request.url,
            canonicalJson(request.headers),
            request.representation_fingerprint,
          ),
      ),
    ]);
  } catch (error) {
    if (/malformed JSON/iu.test(errorMessage(error))) {
      throw requestCapacityProblem();
    }
    throw error;
  }
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

export async function failActiveEvidenceRequestsForWorkflowExhaustion(
  database: D1Database,
  runId: string,
): Promise<void> {
  await database
    .prepare(
      `UPDATE source_requests
       SET state = 'failed', failure_code = 'source_workflow_retries_exhausted'
       WHERE ingestion_run_id = ? AND state IN ('pending', 'captured')`,
    )
    .bind(runId)
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
  const [snapshots, observations, attempts, collectionPlans, curatedSet] = await Promise.all([
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
  ]);
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
    ...(curatedSet === null ? {} : {
      curated_revision_ids: curatedSet.revision_ids,
      curated_revision_set_digest: curatedSet.set_digest,
    }),
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
  return {
    ...document,
    operational_diagnostics: operationalDiagnostics({
      ...document,
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
  const columns = await database
    .prepare("PRAGMA table_info(ingestion_runs)")
    .all<{ name: string }>();
  return columns.results.some((column) => column.name === "progress_json");
}
