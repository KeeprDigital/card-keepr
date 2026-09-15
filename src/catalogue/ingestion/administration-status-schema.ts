import { z } from "@hono/zod-openapi";
import { digest, identifier } from "../../http/openapi";
import { activeRunStages, ingestionRunStates, registeredSupportedGames, sourceValue } from "../shared";
import { operationalDiagnosticsSchema } from "../source-evidence";
import { releaseHead, releaseIdentity, releaseTargetSchema } from "./release-http-schemas";

const count = z.number().int().nonnegative();
const time = z.string().datetime();
const reference = identifier.nullable();
const approved = z.strictObject({
  action: z.literal("approved"),
  approved_at: time,
  candidate_digest: digest,
  expected_current_revision_id: identifier,
});
const diagnostics = operationalDiagnosticsSchema.extend({
  references: operationalDiagnosticsSchema.shape.references.extend({
    workflow: z.strictObject({ status_path: reference }),
  }),
});
export const retainedRunStatusSchema = z
  .strictObject({
    id: identifier,
    state: z.enum(ingestionRunStates),
    selected_games: z.array(z.enum(registeredSupportedGames())).min(1),
    started_at: time,
    expected_current_revision_id: identifier,
    linked_run_id: reference,
    idempotency_key: identifier,
    candidate_digest: digest.nullable(),
    candidate_created_at: time.nullable(),
    approval_deadline: time.nullable(),
    approval: approved.nullable(),
    approval_history: z
      .array(
        z.union([
          approved,
          z.strictObject({ action: z.literal("rejected"), rejected_at: time, candidate_digest: digest }),
        ]),
      )
      .max(1),
    progress: z.strictObject({
      completed_stages: z.array(z.enum(activeRunStages)),
      current_stage: z.enum(ingestionRunStates),
    }),
    warnings: z.array(
      z.union([
        z.strictObject({
          code: identifier,
          detail: z.string(),
          severity: z.enum(["info", "warning", "error"]).optional(),
        }),
        z.strictObject({
          code: z.literal("curated_revision_reconfirmation_required"),
          detail: z.string(),
          curated_revision_id: identifier,
          conflict_id: identifier,
          conflict_digest: digest,
        }),
      ]),
    ),
    failure_code: z.string().nullable(),
    publication_outcome: z.enum(["revision", "no_change"]).nullable(),
    published_revision_id: reference,
    resulting_revision_id: reference,
    export_manifest_digest: digest.optional(),
    freshness_checked_at: time.nullable(),
    terminal_at: time.nullable(),
    publication_reservation: z
      .strictObject({
        revision_id: identifier,
        started_at: time,
        reconcile_after: time,
        manifest_digest: digest,
        writer_token: identifier,
      })
      .nullable(),
    publication_cleanup: z
      .strictObject({
        state: z.enum(["pending", "cleaning", "completed", "failed"]),
        attempts: count,
        failure_code: z.string().nullable(),
        last_attempt_at: time.nullable(),
        completed_at: time.nullable(),
        not_before: time,
        generation: count,
      })
      .nullable(),
    operational_diagnostics: diagnostics,
  })
  .openapi("RetainedRunStatus");
const retainedRevision = z.strictObject({
  revision_id: identifier,
  depth: count,
  export_verified: z.boolean(),
  recovery_verified: z.boolean(),
});
const smoke = z.strictObject({
  revisions: z
    .array(
      z.strictObject({
        revision_id: identifier,
        card_id: identifier,
        printing_id: identifier,
        search_query: identifier,
        card_cursor: identifier,
        search_cursor: identifier,
        printing_cursor: identifier,
      }),
    )
    .min(3)
    .max(3),
  printing_image_id: identifier,
  stale_cursor: identifier,
  stale_revision_id: identifier,
});
const handoff = z.strictObject({
  release_id: releaseIdentity,
  role: z.enum(["source", "destination"]),
  phase: z.number().int().min(1).max(7),
  dispatch_digest: digest,
  request_json: identifier,
  evidence_json: identifier,
  request: sourceValue,
  evidence: z.array(sourceValue),
  mutation_blocked: z.boolean(),
  correction: z
    .strictObject({
      request_json: identifier,
      evidence_json: identifier,
      state: count,
      generation: count,
      correction_digest: digest,
      request: sourceValue,
      evidence: z.array(sourceValue),
    })
    .nullable(),
});
export const administrationStatusSchema = z
  .strictObject({
    contract: z.literal("card-keepr-administration-status@1"),
    production_target: releaseTargetSchema,
    safe_state: z.strictObject({
      current_revision_id: identifier,
      recovery_health: z.enum(["healthy", "blocked", "degraded"]),
      active_ingestion_run_id: reference,
      active_production_release_id: reference,
      active_recovery_id: reference,
      mutation_safe: z.boolean(),
    }),
    fresh_baseline_handoff: handoff.nullable(),
    active_production_release: z
      .strictObject({
        id: releaseIdentity,
        state: z.enum(["requested", "preflight", "migrating", "deploying", "smoke_testing"]),
        expected_head_sha: releaseHead,
        api_version_id: reference,
        ingestion_version_id: reference,
        failure_code: reference,
        roll_forward_required: z.union([z.literal(0), z.literal(1)]),
      })
      .nullable(),
    release_preflight: z.strictObject({
      bootstrap: z.boolean(),
      schema_migration_level: count,
      production_target_digest: digest,
      recovery_bookmark: reference,
      recovery_backup_attempt_id: reference,
      recovery_manifest_digest: digest.nullable(),
      retained_revision_evidence: z.array(retainedRevision).max(3),
      retention_ready: z.boolean(),
      smoke_targets: smoke.nullable(),
      replacement_handoff: z
        .strictObject({
          recovery_id: identifier,
          target_revision_id: identifier,
          target_digest: digest,
          replacement_database_id: identifier,
          retained_database_id: identifier,
          verified: z.boolean(),
        })
        .nullable(),
    }),
    active_ingestion_run: z.union([retainedRunStatusSchema, z.null()]),
    source_freshness: z.array(
      z.strictObject({
        game: z.enum(registeredSupportedGames()),
        area: z.enum(["cards-and-printings", "products-and-releases", "errata"]),
        checked_at: time,
        ingestion_run_id: identifier,
      }),
    ),
    diagnostics: z.strictObject({
      catalogue_revision_count: count,
      catalogue_export_count: count,
      catalogue_export_object_count: count,
      orphaned_catalogue_export_object_count: count,
      pending_publication_cleanup_count: count,
      backup_dispatches: z
        .array(
          z.strictObject({
            idempotency_key: identifier,
            state: z.enum(["pending", "failed", "dispatched"]),
            attempt_count: count,
            updated_at: time,
            workflow_instance_id: identifier,
            failure: z
              .strictObject({ code: z.literal("catalogue_backup_dispatch_failed"), detail: z.string() })
              .nullable(),
            retry: z
              .strictObject({
                method: z.literal("POST"),
                path: z.literal("/v1/backups"),
                body: z.strictObject({
                  expected_current_revision_id: identifier,
                  idempotency_key: identifier,
                  failed_attempt_id: identifier.optional(),
                  failed_attempt_digest: digest.optional(),
                }),
                maximum_attempts_per_request: count,
              })
              .nullable(),
          }),
        )
        .max(20),
    }),
    repairable_catalogue_revision_ids: z.array(identifier).max(3),
    recent_runs: z.array(retainedRunStatusSchema).max(20),
  })
  .openapi("AdministrationStatus");
