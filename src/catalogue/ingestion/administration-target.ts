import { retainedWireValue } from "../../http/openapi";
import { backupRecoveryConfirmationBinding, backupRecoveryTargetCommand } from "../backup-recovery";
import { showCuratedRevision } from "../curated";
import { AdministrationProblem, type CatalogueStore } from "../shared";
import { requiredRun } from "./run-storage";

/** Read-only owner target resolution; mutation CAS remains authoritative. */
export async function resolveAdministrationTarget(
  database: CatalogueStore,
  backups: R2Bucket,
  status: Record<string, unknown>,
  input: Record<string, unknown>,
  target: { environment: string; catalogueDatabaseId: string },
): Promise<Record<string, unknown>> {
  if ("backup" in input || "recovery" in input) {
    const choices = retainedWireValue(backupRecoveryTargetCommand, input);
    const safe = status.safe_state as Record<string, unknown>;
    const binding = await backupRecoveryConfirmationBinding(
      database,
      backups,
      choices,
      safe.current_revision_id,
      target,
    );
    return {
      contract: "card-keepr-administration-target@1",
      resolved_target: {
        production_target: status.production_target,
        confirmation: JSON.stringify({ production_target: status.production_target, ...binding }),
      },
    };
  }
  const choice = (name: string): string | null => (typeof input[name] === "string" ? input[name] : null);
  const safe = status.safe_state as Record<string, unknown>;
  const expected = choice("expected_current_revision_id");
  const runId = choice("ingestion_run_id");
  if (runId !== null) {
    const run = await requiredRun(database, runId);
    if (run.expected_current_revision_id !== expected)
      mismatch("The production Ingestion Run does not resolve to the supplied run and expected Catalogue Revision.");
  }
  if (expected !== null && safe.current_revision_id !== expected)
    mismatch(
      `Production currently resolves to Catalogue Revision ${String(safe.current_revision_id ?? "unknown")}, not ${expected}.`,
    );
  const repair = choice("repair_revision_id");
  if (repair !== null && !(status.repairable_catalogue_revision_ids as string[]).includes(repair))
    mismatch("The target Catalogue Revision was not resolved from the authoritative retained revision chain.");
  let confirmation = JSON.stringify(status.production_target);
  const operation = choice("curated_operation");
  if (operation !== null) {
    if (!["create", "reaffirm", "supersede", "retire"].includes(operation)) invalidCurated();
    let binding = input.curated_binding as Record<string, unknown>;
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
  return {
    contract: "card-keepr-administration-target@1",
    resolved_target: { production_target: status.production_target, confirmation },
  };
}
function mismatch(detail: string): never {
  throw new AdministrationProblem(409, "production_target_mismatch", detail);
}
function invalidCurated(): never {
  throw new AdministrationProblem(422, "invalid_request", "Curated Revision target choices are invalid.");
}
