import { validatedEnvironmentTarget } from "../../http/production-target.mjs";
import {
  AdministrationProblem,
  type CatalogueStore,
  canonicalJson,
  isReleaseHead,
  isReleaseIdentity,
  sha256Text,
  stagingValidationChecks,
} from "../shared";
import { administrationStatus } from "./administration-inspection";
import type { ProductionTarget } from "./production-release";
import {
  recordStagingIntentStatement,
  stagingIntentStartingStateGate,
  stagingRecordStatement,
} from "./staging-release-repository";

export type StagingIntent = {
  release_id: string;
  idempotency_key: string;
  expected_head_sha: string;
  expected_actor: string;
  ci_run_id: string;
  required_checks: string[];
  production_start: {
    target: ProductionTarget;
    target_digest: string;
    migration_level: number;
  };
  authorized_at: string;
  expires_at: string;
};
export type StagingReleaseRequest = {
  contract: "card-keepr-staging-release-request@1";
  release_id: string;
  intent: StagingIntent;
  intent_digest: string;
  confirmation: string;
  dispatch_inputs: { release_id: string; expected_head_sha: string; intent_digest: string };
};
type StoredRecord = { operation: string; request_json: string; response_json: string };

/** One owner confirmation creates immutable production-owned authority, without holding a deployment lease. */
export async function resolveStagingRelease(
  database: CatalogueStore,
  exports: R2Bucket,
  request: Record<string, unknown>,
  targetInput: ProductionTarget | (() => Promise<ProductionTarget>),
  at: string,
): Promise<StagingReleaseRequest | { confirmation: string }> {
  // Validation scope is retired (#238): every release runs the same fixed checks.
  const fields = ["release_id", "idempotency_key", "expected_head_sha", "expected_actor", "ci_run_id"];
  if (
    Object.keys(request).some((key) => ![...fields, "prepare", "confirmation"].includes(key)) ||
    !isReleaseIdentity(request.release_id) ||
    !isReleaseIdentity(request.idempotency_key) ||
    !isReleaseHead(request.expected_head_sha) ||
    typeof request.expected_actor !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(request.expected_actor) ||
    typeof request.ci_run_id !== "string" ||
    !/^\d+$/u.test(request.ci_run_id)
  )
    invalid();
  const choices = Object.fromEntries(fields.map((key) => [key, request[key]]));
  const serialized = canonicalJson(choices);
  const key = `staging-intent:${request.release_id}`;
  const prior = await stagingRecordStatement(database, key).first<StoredRecord>();
  if (prior !== null) {
    if (prior.operation !== "prepare_staging_release" || prior.request_json !== serialized) conflict();
    const response = JSON.parse(prior.response_json) as StagingReleaseRequest;
    if (request.prepare === true) return { confirmation: response.confirmation };
    requireConfirmation(request, response.confirmation);
    return response;
  }
  const target = typeof targetInput === "function" ? await targetInput() : targetInput;
  if (validatedEnvironmentTarget(target, "production") === null) invalid();
  const status = await administrationStatus(database, exports, at, target, false);
  const safe = status.safe_state as Record<string, unknown>;
  const preflight = status.release_preflight as Record<string, unknown>;
  if (
    safe.mutation_safe !== true ||
    safe.active_recovery_id !== null ||
    !Number.isSafeInteger(preflight.schema_migration_level)
  )
    throw new AdministrationProblem(
      409,
      "staging_start_not_safe",
      "Production must have a known, idle starting state.",
    );
  const checks = [...stagingValidationChecks];
  const starting = {
    target,
    target_digest: await sha256Text(canonicalJson(target)),
    migration_level: Number(preflight.schema_migration_level),
  };
  const confirmation = canonicalJson({
    ...choices,
    production_start: starting,
    required_checks: checks,
  });
  if (request.prepare === true) return { confirmation };
  requireConfirmation(request, confirmation);
  const intent: StagingIntent = {
    release_id: String(request.release_id),
    idempotency_key: String(request.idempotency_key),
    expected_head_sha: String(request.expected_head_sha),
    expected_actor: String(request.expected_actor),
    ci_run_id: String(request.ci_run_id),
    required_checks: checks,
    production_start: starting,
    authorized_at: at,
    expires_at: new Date(Date.parse(at) + 24 * 60 * 60_000).toISOString(),
  };
  const digest = await sha256Text(canonicalJson(intent));
  const response: StagingReleaseRequest = {
    contract: "card-keepr-staging-release-request@1",
    release_id: intent.release_id,
    intent,
    intent_digest: digest,
    confirmation,
    dispatch_inputs: {
      release_id: intent.release_id,
      expected_head_sha: intent.expected_head_sha,
      intent_digest: digest,
    },
  };
  try {
    await database.batch([
      stagingIntentStartingStateGate(database, starting.migration_level, at),
      recordStagingIntentStatement(database, key, serialized, canonicalJson(response), at),
      recordStagingIntentStatement(database, intent.idempotency_key, serialized, canonicalJson(response), at),
    ]);
  } catch {
    conflict();
  }
  return response;
}

export async function showStagingRelease(database: CatalogueStore, releaseId: string): Promise<StagingReleaseRequest> {
  if (!isReleaseIdentity(releaseId)) invalid();
  const row = await stagingRecordStatement(database, `staging-intent:${releaseId}`).first<StoredRecord>();
  if (row === null || row.operation !== "prepare_staging_release")
    throw new AdministrationProblem(404, "staging_release_not_found", "The staging release intent does not exist.");
  return JSON.parse(row.response_json) as StagingReleaseRequest;
}
export async function inspectStagingRelease(
  database: CatalogueStore,
  releaseId: string,
): Promise<Record<string, unknown>> {
  const intent = await showStagingRelease(database, releaseId);
  const claim = await stagingRecordStatement(database, `staging-claim:${intent.intent_digest}`).first<StoredRecord>();
  return {
    ...intent,
    authorization: claim?.operation === "authorize_staging_release" ? JSON.parse(claim.response_json) : null,
  };
}

function requireConfirmation(request: Record<string, unknown>, confirmation: string): void {
  if (request.prepare !== undefined || request.confirmation !== confirmation)
    throw new AdministrationProblem(409, "confirmation_required", `Confirmation must exactly equal ${confirmation}`);
}
function invalid(): never {
  throw new AdministrationProblem(422, "invalid_staging_intent", "Staging release choices are invalid.");
}
function conflict(): never {
  throw new AdministrationProblem(
    409,
    "staging_intent_conflict",
    "This release identity or idempotency key already belongs to an immutable intent, or production changed.",
  );
}
