import { AdministrationProblem, type CatalogueStore, canonicalJson } from "../shared";
import { administrationStatus } from "./administration-inspection";
import { type ProductionTarget, prepareProductionRelease, validatedPlan } from "./production-release";
import { preparedProductionReleaseStatement } from "./production-release-repository";

/** Resolve owner choices against current authority; a preview only reads. */
export async function resolveProductionRelease(
  database: CatalogueStore,
  exports: R2Bucket,
  request: Record<string, unknown>,
  target: ProductionTarget,
  observedAt: string,
): Promise<Record<string, unknown>> {
  const fields = [
    "release_id",
    "idempotency_key",
    "expected_current_revision_id",
    "expected_head_sha",
    "expected_actor",
    "expected_migration_level",
    "bootstrap",
    "replacement_handoff",
    "prepare",
    "confirmation",
  ];
  if (Object.keys(request).some((key) => !fields.includes(key))) invalid();
  if (typeof request.idempotency_key !== "string") invalid();
  const prior = await preparedProductionReleaseStatement(database, request.idempotency_key).first<{
    operation: string;
    request_json: string;
    response_json: string;
  }>();
  if (prior !== null) {
    if (prior.operation !== "prepare_production_release")
      throw new AdministrationProblem(409, "idempotency_key_reused", "The idempotency key belongs to another request.");
    const plan = validatedPlan(JSON.parse(prior.request_json) as Record<string, unknown>, target);
    const desired =
      plan.replacement_handoff === null
        ? null
        : {
            recovery_id: plan.replacement_handoff.recovery_id,
            replacement_database_id: plan.replacement_handoff.replacement_database_id,
            retained_database_id: plan.replacement_handoff.retained_database_id,
          };
    const same = fields
      .filter((key) => key !== "confirmation" && key !== "prepare")
      .every(
        (key) =>
          canonicalJson(request[key] ?? null) ===
          canonicalJson(key === "replacement_handoff" ? desired : (plan[key as keyof typeof plan] ?? null)),
      );
    if (prior.operation !== "prepare_production_release" || !same) {
      throw new AdministrationProblem(409, "idempotency_key_reused", "The idempotency key belongs to another request.");
    }
    const confirmation = releaseConfirmation(plan, desired, target);
    if (request.prepare === true)
      return { contract: "card-keepr-production-release-confirmation@1", release_id: plan.release_id, confirmation };
    requireConfirmation(request, confirmation);
    return JSON.parse(prior.response_json) as Record<string, unknown>;
  }
  const status = await administrationStatus(database, exports, observedAt, target, false);
  const safe = status.safe_state as Record<string, unknown>;
  const preflight = status.release_preflight as Record<string, unknown>;
  const replacement = request.replacement_handoff;
  if (replacement !== null && (typeof replacement !== "object" || Array.isArray(replacement))) invalid();
  const supplied = replacement as Record<string, unknown> | null;
  const desired: Record<string, unknown> | null =
    supplied === null
      ? null
      : {
          recovery_id: supplied.recovery_id,
          replacement_database_id: supplied.replacement_database_id,
          retained_database_id: supplied.retained_database_id,
        };
  if (
    desired !== null &&
    Object.keys(supplied!).sort().join("|") !== "recovery_id|replacement_database_id|retained_database_id"
  )
    invalid();
  const handoff = preflight.replacement_handoff as Record<string, unknown> | null;
  if (
    desired !== null &&
    (handoff === null || handoff.verified !== true || Object.keys(desired).some((key) => desired[key] !== handoff[key]))
  ) {
    throw new AdministrationProblem(
      409,
      "replacement_handoff_not_verified",
      "The replacement D1 target is not the exact verified recovery target.",
    );
  }
  const ordinarySafe = safe.mutation_safe === true && safe.recovery_health === "healthy";
  const replacementSafe =
    desired !== null &&
    safe.recovery_health === "blocked" &&
    safe.active_recovery_id === desired.recovery_id &&
    safe.active_ingestion_run_id === null &&
    safe.active_production_release_id === null;
  if (request.bootstrap === true && preflight.bootstrap !== true) {
    throw new AdministrationProblem(
      409,
      "bootstrap_not_applicable",
      "The catalogue is not provably empty: Bootstrap Mode is only usable before the first published Catalogue Revision.",
    );
  }
  if (
    safe.current_revision_id !== request.expected_current_revision_id ||
    preflight.schema_migration_level !== request.expected_migration_level ||
    request.bootstrap !== preflight.bootstrap ||
    (!ordinarySafe && !replacementSafe)
  ) {
    throw new AdministrationProblem(
      409,
      "release_preflight_failed",
      preflight.bootstrap === true && request.bootstrap !== true
        ? "The empty catalogue requires --bootstrap for its first Production Release."
        : "Production status did not satisfy the exact revision, migration, target, and idle mutation gates.",
    );
  }
  const plan = validatedPlan(
    {
      release_id: request.release_id,
      idempotency_key: request.idempotency_key,
      expected_current_revision_id: request.expected_current_revision_id,
      expected_head_sha: request.expected_head_sha,
      expected_actor: request.expected_actor,
      expected_migration_level: request.expected_migration_level,
      production_target: target,
      production_target_digest: preflight.production_target_digest,
      bootstrap: request.bootstrap,
      recovery_bookmark: request.bootstrap ? null : preflight.recovery_bookmark,
      recovery_backup_attempt_id: request.bootstrap ? null : preflight.recovery_backup_attempt_id,
      smoke_targets: request.bootstrap ? null : preflight.smoke_targets,
      retained_revision_evidence: request.bootstrap ? null : preflight.retained_revision_evidence,
      replacement_handoff:
        desired === null
          ? null
          : { ...desired, target_revision_id: handoff?.target_revision_id, target_digest: handoff?.target_digest },
    },
    target,
  );
  const confirmation = releaseConfirmation(plan, desired, target);
  if (request.prepare === true)
    return { contract: "card-keepr-production-release-confirmation@1", release_id: plan.release_id, confirmation };
  requireConfirmation(request, confirmation);
  return prepareProductionRelease(database, plan, target, observedAt);
}
function invalid(): never {
  throw new AdministrationProblem(422, "invalid_production_release_request", "Production Release choices are invalid.");
}

function releaseConfirmation(
  plan: ReturnType<typeof validatedPlan>,
  desired: Record<string, unknown> | null,
  target: ProductionTarget,
): string {
  return JSON.stringify({
    production_target: target,
    release_id: plan.release_id,
    expected_current_revision_id: plan.expected_current_revision_id,
    expected_head_sha: plan.expected_head_sha,
    expected_migration_level: plan.expected_migration_level,
    ...(plan.bootstrap
      ? { bootstrap: true }
      : { recovery_bookmark: plan.recovery_bookmark, recovery_backup_attempt_id: plan.recovery_backup_attempt_id }),
    idempotency_key: plan.idempotency_key,
    ...(desired === null ? {} : { replacement_handoff: desired }),
  });
}
function requireConfirmation(request: Record<string, unknown>, confirmation: string): void {
  if (request.prepare !== undefined || request.confirmation !== confirmation)
    throw new AdministrationProblem(409, "confirmation_required", `Confirmation must exactly equal ${confirmation}`);
}
