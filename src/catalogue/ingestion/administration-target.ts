import { inspectCatalogueRecovery } from "../backup-recovery";
import { showCuratedRevision } from "../curated";
import { AdministrationProblem, type CatalogueStore } from "../shared";
import { requiredRun } from "./run-storage";

/** Read-only checks behind the existing status route; mutation CAS remains authoritative. */
export async function resolveAdministrationTarget(
  database: CatalogueStore,
  backups: R2Bucket,
  status: Record<string, unknown>,
  query: URLSearchParams,
): Promise<Record<string, unknown>> {
  const allowed = [
    "expected_current_revision_id",
    "ingestion_run_id",
    "repair_revision_id",
    "recovery_id",
    "target_digest",
    "expected_restored_revision_id",
    "curated_operation",
    "curated_binding",
  ];
  if (
    [...query.keys()].some((key) => !allowed.includes(key)) ||
    [...new Set(query.keys())].some((key) => query.getAll(key).length !== 1)
  )
    throw new AdministrationProblem(422, "invalid_request", "Target resolution parameters are invalid.");
  const safe = status.safe_state as Record<string, unknown>;
  const expected = query.get("expected_current_revision_id");
  const runId = query.get("ingestion_run_id");
  if (runId !== null) {
    const run = await requiredRun(database, runId);
    if (run.expected_current_revision_id !== expected)
      mismatch("The production Ingestion Run does not resolve to the supplied run and expected Catalogue Revision.");
  }
  if (expected !== null && safe.current_revision_id !== expected)
    mismatch(
      `Production currently resolves to Catalogue Revision ${String(safe.current_revision_id ?? "unknown")}, not ${expected}.`,
    );
  const repair = query.get("repair_revision_id");
  if (repair !== null && !(status.repairable_catalogue_revision_ids as string[]).includes(repair))
    mismatch("The target Catalogue Revision was not resolved from the authoritative retained revision chain.");
  const recoveryId = query.get("recovery_id");
  if (recoveryId !== null) {
    const recovery = await inspectCatalogueRecovery(database, backups, recoveryId);
    const restored = query.get("expected_restored_revision_id");
    if (
      recovery.id !== recoveryId ||
      recovery.target_digest !== query.get("target_digest") ||
      (restored !== null && recovery.target_revision_id !== restored)
    )
      mismatch("The production recovery operation does not match the supplied exact target evidence.");
    if (
      safe.current_revision_id !== recovery.expected_current_revision_id &&
      safe.current_revision_id !== recovery.target_revision_id
    )
      mismatch("Production does not resolve to either the recovery source or restored Catalogue Revision.");
  }
  let confirmation = JSON.stringify(status.production_target);
  const operation = query.get("curated_operation");
  if (operation !== null) {
    if (!["create", "reaffirm", "supersede", "retire"].includes(operation)) invalidCurated();
    let binding: Record<string, unknown>;
    try {
      binding = JSON.parse(query.get("curated_binding") ?? "null") as Record<string, unknown>;
    } catch {
      invalidCurated();
    }
    if (binding === null || typeof binding !== "object" || Array.isArray(binding)) invalidCurated();
    const fields =
      operation === "create"
        ? ["affected_supported_game", "target", "content_digest", "idempotency_key"]
        : [
            "curated_revision_id",
            "expected_event_version",
            "conflict_digest",
            "idempotency_key",
            ...(operation === "supersede"
              ? ["replacement_supported_game", "replacement_target", "replacement_content_digest"]
              : []),
          ];
    if (Object.keys(binding).sort().join("|") !== fields.sort().join("|")) invalidCurated();
    if (operation !== "create") {
      const shown = await showCuratedRevision(database, String(binding.curated_revision_id));
      const revision = shown.revision as Record<string, unknown>;
      const content = revision.content as Record<string, unknown>;
      const conflict = revision.pending_conflict as Record<string, unknown> | null;
      if (revision.event_version !== binding.expected_event_version)
        mismatch("The Curated Revision does not resolve to the supplied lifecycle event version.");
      if ((conflict?.digest ?? null) !== binding.conflict_digest)
        mismatch("The Curated Revision does not resolve to the supplied conflict digest.");
      binding = {
        ...binding,
        affected_supported_game: content.game,
        current_content_digest: revision.content_digest,
        target: content.target,
        conflict_id: conflict?.id ?? null,
      };
    }
    confirmation = JSON.stringify({
      production_target: status.production_target,
      operation,
      current_catalogue_revision_id: expected,
      ...binding,
    });
  }
  return { ...status, resolved_target: { production_target: status.production_target, confirmation } };
}
function mismatch(detail: string): never {
  throw new AdministrationProblem(409, "production_target_mismatch", detail);
}
function invalidCurated(): never {
  throw new AdministrationProblem(422, "invalid_request", "Curated Revision target choices are invalid.");
}
