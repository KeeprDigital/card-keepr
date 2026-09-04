import { AdministrationProblem, canonicalJson, sha256Text, SPINE_REVISION_ID } from "./shared";

export { SPINE_REVISION_ID };

export type ProductionTarget = Readonly<{
  cloudflare_account_id: string;
  worker_scripts: readonly string[];
  d1_databases: readonly Readonly<{ name: string; id: string }>[];
  r2_buckets: readonly string[];
}>;

export async function prepareProductionRelease(
  database: D1Database,
  request: Record<string, unknown>,
  expectedTarget: ProductionTarget,
  observedAt: string,
): Promise<Record<string, unknown>> {
  const plan = validatedPlan(request, expectedTarget);
  if ((await sha256Text(canonicalJson(plan.production_target))) !== plan.production_target_digest) invalid();
  const requestJson = canonicalJson(plan);
  const dispatchDigest = await sha256Text(requestJson);
  const response = {
    contract: "card-keepr-production-release-request@1",
    release_id: plan.release_id,
    state: "requested",
    dispatch_digest: dispatchDigest,
  };
  const existing = await database
    .prepare(
      `SELECT operation, request_json, response_json FROM administration_idempotency
     WHERE idempotency_key = ?`,
    )
    .bind(plan.idempotency_key)
    .first<{
      operation: string;
      request_json: string;
      response_json: string;
    }>();
  if (existing !== null) {
    if (existing.operation !== "prepare_production_release" || existing.request_json !== requestJson) {
      throw new AdministrationProblem(409, "idempotency_key_reused", "The idempotency key belongs to another request.");
    }
    return JSON.parse(existing.response_json) as Record<string, unknown>;
  }
  const gate = plan.bootstrap ? bootstrapGate(database, plan, observedAt) : populatedGate(database, plan, observedAt);
  try {
    await database.batch([
      gate,
      database
        .prepare(
          `INSERT INTO administration_idempotency (
           idempotency_key, operation, request_json, response_json,
           http_status, outcome, created_at
         ) VALUES (?, 'prepare_production_release', ?, ?, 201, 'success', ?)`,
        )
        .bind(plan.idempotency_key, requestJson, canonicalJson(response), observedAt),
    ]);
  } catch {
    throw new AdministrationProblem(
      409,
      "release_preflight_failed",
      "Production changed while the Production Release request was prepared.",
    );
  }
  return response;
}

type PreparedPlan = ReturnType<typeof validatedPlan>;

// Bootstrap Mode (issue #141): the catalogue is provably empty, so no backup,
// bookmark, retained window, or smoke target can exist. The gate keeps every
// data-independent check and additionally proves emptiness, so a bootstrap
// plan is refused the moment a Catalogue Revision has been published.
function bootstrapGate(
  database: D1Database,
  plan: Extract<PreparedPlan, { bootstrap: true }>,
  observedAt: string,
): D1PreparedStatement {
  return database
    .prepare(
      `SELECT CASE WHEN EXISTS (
       SELECT 1 FROM catalogue_state AS catalogue
       JOIN operation_state AS operation ON operation.singleton = 1
       JOIN catalogue_schema_state AS schema_state ON schema_state.singleton = 1
       WHERE catalogue.singleton = 1
         AND catalogue.current_revision_id = ?
         AND NOT EXISTS (SELECT 1 FROM catalogue_revisions)
         AND schema_state.migration_level = ?
         AND operation.active_ingestion_run_id IS NULL
         AND (operation.active_release_id IS NULL
           OR operation.active_release_expires_at <= ?)
         AND operation.recovery_health = 'healthy' AND operation.active_recovery_id IS NULL
     ) THEN 1 ELSE json_extract('invalid', '$') END`,
    )
    .bind(SPINE_REVISION_ID, plan.expected_migration_level, observedAt);
}

function populatedGate(
  database: D1Database,
  plan: Extract<PreparedPlan, { bootstrap: false }>,
  observedAt: string,
): D1PreparedStatement {
  const replacement = plan.replacement_handoff;
  const recoveryGate =
    replacement === null
      ? `operation.recovery_health = 'healthy' AND operation.active_recovery_id IS NULL`
      : `operation.recovery_health = 'blocked' AND operation.active_recovery_id = ?
       AND EXISTS (SELECT 1 FROM catalogue_recovery_operations AS recovery
         WHERE recovery.id = ? AND recovery.state = 'awaiting_acceptance'
           AND recovery.method = 'replacement_database'
           AND recovery.target_revision_id = ? AND recovery.target_digest = ?
           AND recovery.restored_database_id = ? AND recovery.retained_database_id = ?
           AND recovery.verification_json IS NOT NULL)`;
  const gateBindings =
    replacement === null
      ? []
      : [
          replacement.recovery_id,
          replacement.recovery_id,
          replacement.target_revision_id,
          replacement.target_digest,
          replacement.replacement_database_id,
          replacement.retained_database_id,
        ];
  const retainedRevisionIds = plan.retained_revision_evidence.map((item) => item.revision_id);
  return database
    .prepare(
      `SELECT CASE WHEN EXISTS (
       SELECT 1 FROM catalogue_state AS catalogue
       JOIN operation_state AS operation ON operation.singleton = 1
       JOIN catalogue_schema_state AS schema_state ON schema_state.singleton = 1
       WHERE catalogue.singleton = 1
         AND catalogue.current_revision_id = ?
         AND schema_state.migration_level = ?
         AND operation.active_ingestion_run_id IS NULL
         AND (operation.active_release_id IS NULL
           OR operation.active_release_expires_at <= ?)
         AND ${recoveryGate}
         AND EXISTS (SELECT 1 FROM catalogue_backup_attempts AS backup
           WHERE backup.idempotency_key = ? AND backup.catalogue_revision_id = ?
             AND backup.state = 'verified' AND backup.d1_bookmark = ?
             AND backup.manifest_sha256 IS NOT NULL)
         AND 3 = (WITH RECURSIVE retained(revision_id,depth) AS (
           SELECT catalogue.current_revision_id,0 UNION ALL
           SELECT revision.expected_previous_revision_id,retained.depth+1
           FROM retained JOIN catalogue_revisions AS revision ON revision.id=retained.revision_id
           WHERE retained.depth<2 AND revision.expected_previous_revision_id IS NOT NULL
         ), expected(revision_id,depth) AS (VALUES (?,0),(?,1),(?,2))
         SELECT COUNT(*) FROM retained
           JOIN expected USING (revision_id,depth)
           JOIN catalogue_exports AS export ON export.catalogue_revision_id=retained.revision_id
           WHERE export.verified=1 AND export.maintenance_state='available'
             AND EXISTS (SELECT 1 FROM catalogue_backup_attempts AS backup
               WHERE backup.catalogue_revision_id=retained.revision_id AND backup.state='verified'
                 AND backup.d1_bookmark IS NOT NULL AND backup.manifest_sha256 IS NOT NULL))
         AND EXISTS (SELECT 1 FROM catalogue_query_revisions
           WHERE catalogue_revision_id = ? AND state = 'archived')
     ) THEN 1 ELSE json_extract('invalid', '$') END`,
    )
    .bind(
      plan.expected_current_revision_id,
      plan.expected_migration_level,
      observedAt,
      ...gateBindings,
      plan.recovery_backup_attempt_id,
      plan.expected_current_revision_id,
      plan.recovery_bookmark,
      ...retainedRevisionIds,
      plan.smoke_targets.stale_revision_id,
    );
}

function validatedPlan(request: Record<string, unknown>, target: ProductionTarget) {
  const required = [
    "release_id",
    "idempotency_key",
    "expected_current_revision_id",
    "expected_head_sha",
    "expected_actor",
    "expected_migration_level",
    "production_target",
    "production_target_digest",
    "bootstrap",
    "recovery_bookmark",
    "recovery_backup_attempt_id",
    "smoke_targets",
    "retained_revision_evidence",
    "replacement_handoff",
  ];
  if (Object.keys(request).sort().join("|") !== required.sort().join("|")) invalid();
  const opaque = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:@|-]{0,255}$/u.test(value);
  if (
    !opaque(request.release_id) ||
    !opaque(request.idempotency_key) ||
    !opaque(request.expected_current_revision_id) ||
    !/^[0-9a-f]{40}$/u.test(String(request.expected_head_sha)) ||
    !/^[A-Za-z0-9-]+\[bot\]$/u.test(String(request.expected_actor)) ||
    !Number.isSafeInteger(request.expected_migration_level) ||
    (request.expected_migration_level as number) < 1 ||
    canonicalJson(request.production_target) !== canonicalJson(target) ||
    !/^[0-9a-f]{64}$/u.test(String(request.production_target_digest)) ||
    typeof request.bootstrap !== "boolean"
  )
    invalid();
  const common = request as {
    release_id: string;
    idempotency_key: string;
    expected_current_revision_id: string;
    expected_head_sha: string;
    expected_actor: string;
    expected_migration_level: number;
    production_target: ProductionTarget;
    production_target_digest: string;
  };
  if (request.bootstrap) {
    if (
      request.expected_current_revision_id !== SPINE_REVISION_ID ||
      request.recovery_bookmark !== null ||
      request.recovery_backup_attempt_id !== null ||
      request.smoke_targets !== null ||
      request.retained_revision_evidence !== null ||
      request.replacement_handoff !== null
    )
      invalid();
    return {
      ...common,
      bootstrap: true as const,
      recovery_bookmark: null,
      recovery_backup_attempt_id: null,
      smoke_targets: null,
      retained_revision_evidence: null,
      replacement_handoff: null,
    };
  }
  if (
    !opaque(request.recovery_bookmark) ||
    !opaque(request.recovery_backup_attempt_id) ||
    !Array.isArray(request.retained_revision_evidence) ||
    request.retained_revision_evidence.length !== 3
  )
    invalid();
  const retained = request.retained_revision_evidence;
  if (
    !retained.every(
      (item, depth) =>
        isRecord(item) &&
        exactKeys(item, ["depth", "export_verified", "recovery_verified", "revision_id"]) &&
        item.depth === depth &&
        opaque(item.revision_id) &&
        item.export_verified === true &&
        item.recovery_verified === true,
    ) ||
    retained[0]?.revision_id !== request.expected_current_revision_id ||
    new Set(retained.map((item) => item.revision_id)).size !== 3 ||
    !validSmokeTargets(
      request.smoke_targets,
      retained.map((item) => String(item.revision_id)),
    )
  )
    invalid();
  const replacement = request.replacement_handoff;
  if (replacement !== null && (typeof replacement !== "object" || Array.isArray(replacement))) invalid();
  return request as typeof common & {
    bootstrap: false;
    recovery_bookmark: string;
    recovery_backup_attempt_id: string;
    smoke_targets: {
      revisions: Array<{
        revision_id: string;
        card_id: string;
        printing_id: string;
        search_query: string;
        card_cursor: string;
        search_cursor: string;
        printing_cursor: string;
      }>;
      printing_image_id: string;
      legality_card_id: string;
      legality_format: string;
      legality_region: string;
      stale_cursor: string;
      stale_revision_id: string;
    };
    retained_revision_evidence: Array<{
      revision_id: string;
      depth: number;
      export_verified: true;
      recovery_verified: true;
    }>;
    replacement_handoff: null | {
      recovery_id: string;
      target_revision_id: string;
      target_digest: string;
      replacement_database_id: string;
      retained_database_id: string;
    };
  };
}

function validSmokeTargets(value: unknown, retainedRevisionIds: readonly string[]): boolean {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "legality_card_id",
      "legality_format",
      "legality_region",
      "printing_image_id",
      "revisions",
      "stale_cursor",
      "stale_revision_id",
    ]) ||
    !Array.isArray(value.revisions) ||
    value.revisions.length !== 3 ||
    ![
      value.printing_image_id,
      value.legality_card_id,
      value.legality_format,
      value.legality_region,
      value.stale_cursor,
      value.stale_revision_id,
    ].every((item) => typeof item === "string" && item.length > 0) ||
    retainedRevisionIds.includes(String(value.stale_revision_id))
  )
    return false;
  return value.revisions.every(
    (fixture, index) =>
      isRecord(fixture) &&
      exactKeys(fixture, [
        "card_cursor",
        "card_id",
        "printing_cursor",
        "printing_id",
        "revision_id",
        "search_cursor",
        "search_query",
      ]) &&
      fixture.revision_id === retainedRevisionIds[index] &&
      [
        fixture.card_id,
        fixture.printing_id,
        fixture.search_query,
        fixture.card_cursor,
        fixture.search_cursor,
        fixture.printing_cursor,
      ].every((item) => typeof item === "string" && item.length > 0),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function invalid(): never {
  throw new AdministrationProblem(
    422,
    "invalid_production_release_request",
    "The Production Release request is malformed or does not match the configured production target.",
  );
}
