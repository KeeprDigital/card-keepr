import { z } from "@hono/zod-openapi";
import { digest, identifier } from "../../http/openapi";
import { activeRunStages, ingestionRunStates, registeredSupportedGames, sourceValue } from "../shared";
import { operationalDiagnosticsSchema } from "../source-evidence";

export const retainedRunIdentifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const count = z.number().int().nonnegative();
const timestamp = z.iso.datetime();
const approval = z.strictObject({
  action: z.literal("approved"),
  approved_at: timestamp,
  candidate_digest: digest,
  expected_current_revision_id: retainedRunIdentifier,
});
const rejection = z.strictObject({ action: z.literal("rejected"), rejected_at: timestamp, candidate_digest: digest });
const progress = z.strictObject({
  completed_stages: z.array(z.enum(activeRunStages)).max(activeRunStages.length),
  current_stage: z.enum(ingestionRunStates),
});
const warning = z.union([
  z.strictObject({ code: identifier, detail: z.string() }),
  z.strictObject({ code: identifier, detail: z.string(), severity: z.enum(["info", "warning", "error"]) }),
  z.strictObject({
    code: z.literal("curated_revision_reconfirmation_required"),
    detail: z.string(),
    curated_revision_id: retainedRunIdentifier,
    conflict_id: retainedRunIdentifier,
    conflict_digest: digest,
  }),
]);
export const retainedRunSchema = z
  .strictObject({
    id: retainedRunIdentifier,
    state: z.enum(ingestionRunStates),
    selected_games: z.array(z.enum(registeredSupportedGames())).min(1),
    started_at: timestamp,
    expected_current_revision_id: retainedRunIdentifier,
    linked_run_id: retainedRunIdentifier.nullable(),
    idempotency_key: retainedRunIdentifier,
    candidate_digest: digest.nullable(),
    candidate_created_at: timestamp.nullable(),
    approval_deadline: timestamp.nullable(),
    approval: approval.nullable(),
    approval_history: z.array(z.union([approval, rejection])).max(1),
    progress,
    warnings: z.array(warning),
    failure_code: z.string().nullable(),
    publication_outcome: z.enum(["revision", "no_change"]).nullable(),
    published_revision_id: retainedRunIdentifier.nullable(),
    resulting_revision_id: retainedRunIdentifier.nullable(),
    export_manifest_digest: digest.optional(),
    freshness_checked_at: timestamp.nullable(),
    terminal_at: timestamp.nullable(),
    publication_reservation: z
      .strictObject({
        revision_id: retainedRunIdentifier,
        started_at: timestamp,
        reconcile_after: timestamp,
        manifest_digest: digest,
        writer_token: z.string(),
      })
      .nullable(),
    publication_cleanup: z
      .strictObject({
        state: z.enum(["pending", "cleaning", "completed", "failed"]),
        attempts: count,
        failure_code: z.string().nullable(),
        last_attempt_at: timestamp.nullable(),
        completed_at: timestamp.nullable(),
        not_before: timestamp,
        generation: count,
      })
      .nullable(),
    operational_diagnostics: operationalDiagnosticsSchema.extend({
      references: operationalDiagnosticsSchema.shape.references.extend({
        workflow: z.union([
          operationalDiagnosticsSchema.shape.references.shape.workflow,
          operationalDiagnosticsSchema.shape.references.shape.workflow.pick({ status_path: true }),
        ]),
      }),
    }),
  })
  .openapi("RetainedRun", {
    description:
      "Historical publicRun representation without a contract discriminator. The retained decoder validates cross-field invariants; optional export_manifest_digest remains absent when no export was retained. Diagnostics are derived without rewriting stored receipts.",
  });
export const retainedAdministrationOperationSchema = z
  .strictObject({
    contract: z.literal("card-keepr-administration-operation@1"),
    operation: z.enum([
      "approve_ingestion_run",
      "reject_ingestion_run",
      "retry_ingestion_run",
      "retry_publication_cleanup",
    ]),
    status: z.literal("in_progress"),
    idempotency_key: retainedRunIdentifier,
    run_id: retainedRunIdentifier.optional(),
    claimed_at: timestamp.optional(),
    retry_after: timestamp,
    links: z.strictObject({ run: z.url().optional(), status: z.url() }),
  })
  .openapi("RetainedAdministrationOperation", {
    description:
      "Existing administration claim or exact historical approval reservation. claimed_at exists only for a real administration claim; retry may omit run_id before its child is allocated.",
  });
const changes = { added: z.array(identifier), changed: z.array(identifier), missing_observations: z.array(identifier) };
export const retainedCandidateInspectionSchema = z
  .strictObject({
    run_id: retainedRunIdentifier,
    candidate_digest: digest,
    expected_current_revision_id: retainedRunIdentifier,
    candidate_created_at: timestamp,
    approval_deadline: timestamp,
    progress,
    curated_revision_ids: z.array(identifier).optional(),
    curated_revision_set_digest: digest.optional(),
    diff: z.strictObject({
      summary: z.strictObject({ cards_added: count, printings_added: count, warnings: count }),
      cards: z.strictObject(changes),
      printings: z.strictObject({ ...changes, identity_matches: z.array(identifier) }),
      warnings: z.array(z.object({ code: identifier, detail: z.string().optional() }).catchall(sourceValue)),
      curated_effects: z.array(
        z.strictObject({
          revision_id: identifier,
          target: z.string(),
          assertion: sourceValue,
          evidence_category: z.literal("curated"),
        }),
      ),
    }),
  })
  .openapi("RetainedCandidateInspection");
