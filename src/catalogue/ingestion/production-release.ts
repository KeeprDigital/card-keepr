import { bootstrapGate, populatedGate } from "./production-release-repository";
import {
  preparedProductionReleaseStatement,
  recordPreparedProductionReleaseStatement,
} from "./production-release-repository";
import { AdministrationProblem, canonicalJson, sha256Text, SPINE_REVISION_ID } from "../shared";

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
  const existing = await preparedProductionReleaseStatement(database, plan.idempotency_key).first<{
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
      recordPreparedProductionReleaseStatement(database, {
        key: plan.idempotency_key,
        requestJson: requestJson,
        responseJson: canonicalJson(response),
        createdAt: observedAt,
      }),
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
