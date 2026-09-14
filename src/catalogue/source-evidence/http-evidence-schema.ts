import { z } from "@hono/zod-openapi";
import { digest, identifier } from "../../http/openapi";

const count = z.number().int().nonnegative();
const timestamp = z.string().datetime();
const strings = z.record(z.string(), z.string());
const nullableReference = identifier.nullable();
const nullableTime = timestamp.nullable();
export const coverageSchema = z.strictObject({ locale: z.literal("en"), area: identifier, subset: identifier });
const sourceFields = { supported_game: identifier, source_lineage: identifier, adapter_version: identifier };
const requestSchema = z.strictObject({
  id: identifier,
  url: z.url(),
  method: z.literal("GET").optional(),
  headers: strings.optional(),
});
export const planInputSchema = z.strictObject({
  ...sourceFields,
  participation: z.enum(["required", "optional"]).optional(),
  subset: identifier.optional(),
  requests: z.array(requestSchema).min(1).max(100),
});
export const evidenceInputSchema = z.union([
  planInputSchema.extend({ idempotency_key: identifier }),
  z.strictObject({ plans: z.array(planInputSchema).min(1), idempotency_key: identifier }),
]);
const retainedRequestSchema = requestSchema.extend({
  method: z.literal("GET"),
  headers: strings,
  representation_fingerprint: digest,
});
export const evidencePlanSchema = z.strictObject({
  ...sourceFields,
  game_profile_version: identifier,
  participation: z.enum(["required", "optional"]).optional(),
  coverage: coverageSchema.optional(),
  requests: z.array(retainedRequestSchema),
});
export const evidenceAcceptanceSchema = z
  .strictObject({
    contract: z.literal("card-keepr-evidence-acceptance@1"),
    id: identifier,
    state: z.literal("collecting"),
    idempotency_key: identifier,
    linked_run_id: nullableReference,
    started_at: timestamp,
    selected_games: z.array(identifier),
    evidence_plans: z.array(evidencePlanSchema),
    links: z.strictObject({ status: z.url() }),
  })
  .openapi("EvidenceAcceptance");
export const observationSetSchema = z
  .strictObject({
    id: identifier,
    source_snapshot_id: identifier,
    ...sourceFields,
    game_profile_version: identifier,
    parsed_at: timestamp,
    content_digest: digest,
    content_byte_length: count,
    object_key: identifier,
    observation_count: count,
  })
  .openapi("SourceObservationSet");
const snapshotSchema = z
  .strictObject({
    id: identifier,
    ...sourceFields,
    game_profile_version: identifier,
    ingestion_run_id: identifier,
    reused_source_snapshot_id: nullableReference,
    request: retainedRequestSchema.omit({ id: true }),
    retrieval: z.strictObject({ retrieved_at: timestamp, fetch_attempt_id: identifier }),
    http: z.strictObject({ status: z.number().int(), headers: strings, vary: z.array(z.string()) }),
    content: z.strictObject({ digest, byte_length: count, object_key: identifier, media_type: nullableReference }),
  })
  .openapi("SourceSnapshot");
const state = z.enum([
  "collecting",
  "paused",
  "parsing",
  "reconciling",
  "awaiting_approval",
  "publishing",
  "published",
  "failed",
  "rejected",
  "expired",
]);
const safeWorkflowStatus = z.enum([
  "queued",
  "running",
  "paused",
  "errored",
  "terminated",
  "complete",
  "waiting",
  "waiting_for_pause",
  "unknown",
  "unavailable",
]);
const workflowReceipt = z.strictObject({ id: identifier, attempt_number: count, status: safeWorkflowStatus });
export const collectionResumeSchema = z
  .strictObject({
    contract: z.literal("card-keepr-collection-dispatch@1"),
    ingestion_run_id: identifier,
    workflow: workflowReceipt,
    recovery: z
      .strictObject({
        reason: identifier,
        superseded_workflow_id: identifier,
        workflow_status: safeWorkflowStatus,
        last_progress_at: nullableTime,
      })
      .optional(),
    links: z.strictObject({ status: z.url() }),
  })
  .openapi("CollectionDispatch");
const actions = z.array(z.enum(["resume", "pause", "terminate", "retry", "extend_capacity"]));
export const collectionPauseSchema = z
  .strictObject({
    contract: z.literal("card-keepr-collection-pause@1"),
    ingestion_run_id: identifier,
    state: z.literal("paused"),
    pause_reason: z.literal("owner_requested"),
    paused_at: timestamp,
    workflow: workflowReceipt,
    last_progress_at: nullableTime,
    actions,
  })
  .openapi("CollectionPause");
export const collectionTerminationSchema = z
  .strictObject({
    contract: z.literal("card-keepr-collection-termination@1"),
    ingestion_run_id: identifier,
    state: z.literal("failed"),
    failure_code: z.literal("ingestion_run_terminated"),
    pause_reason: identifier,
    paused_at: timestamp,
    terminated_at: timestamp,
    active_run_released: z.boolean(),
  })
  .openapi("CollectionTermination");
export const capacityExtensionSchema = z
  .strictObject({
    contract: z.literal("card-keepr-capacity-extension@1"),
    ingestion_run_id: identifier,
    source_lineage: identifier,
    previous_request_capacity: count,
    previous_capacity_generation: count,
    request_capacity: count,
    capacity_generation: count,
    extended_at: timestamp,
  })
  .openapi("CapacityExtension");
const pauseSchema = z.union([
  z.strictObject({
    reason: z.literal("source_request_capacity_exhausted"),
    paused_at: timestamp,
    source_lineage: identifier,
    parent_request_id: identifier,
    request_capacity: count,
    capacity_generation: count,
    used_capacity: count,
    overflow_request_count: count,
    required_capacity: count,
    actions,
  }),
  z.strictObject({
    reason: z.enum(["source_transport_retries_exhausted", "source_storage_retries_exhausted"]),
    paused_at: timestamp,
    source_lineage: identifier,
    request_id: identifier,
    hostname: identifier,
    retry_generation: count,
    attempt_count: count,
    failure_classification: identifier,
    http_status: z.number().int().nullable(),
    actions,
  }),
  z.strictObject({
    reason: z.enum([
      "owner_requested",
      "source_workflow_stalled",
      "source_workflow_errored",
      "source_workflow_terminated",
      "source_workflow_unavailable",
    ]),
    paused_at: timestamp,
    workflow_instance_id: identifier,
    workflow_status: safeWorkflowStatus,
    last_progress_at: nullableTime,
    actions,
  }),
]);
const grouping = { total: count, by_state: z.record(z.string(), count), by_role: z.record(z.string(), count) };
const collectionSchema = z.strictObject({
  state,
  pause_reason: nullableReference,
  paused_at: nullableTime,
  started_at: timestamp,
  last_progress_at: nullableTime,
  collection_completed_at: nullableTime,
  terminal_at: nullableTime,
  expected_catalogue_revision_id: identifier,
  capacity: z.array(
    z.strictObject({
      source_lineage: identifier,
      adapter_version: identifier,
      capacity_generation: count,
      request_capacity: count,
      used_capacity: count,
      remaining_capacity: count,
      required_capacity: count.nullable(),
      overflow_request_count: count.nullable(),
    }),
  ),
  requests: z.strictObject({
    ...grouping,
    by_lineage: z.array(z.strictObject({ source_lineage: identifier, ...grouping })),
  }),
  evidence: z.strictObject({
    snapshot_count: count,
    retained_byte_total: count,
    observation_set_count: count,
    fetch_attempt_count: count,
    retry_attempt_count: count,
    failed_attempt_count: count,
    latest_failure: z
      .strictObject({
        request_id: identifier,
        hostname: identifier,
        classification: identifier,
        http_status: z.number().int().nullable(),
        attempt_number: count,
        at: timestamp,
      })
      .nullable(),
    detail_limit: count,
    snapshots_truncated: z.boolean(),
    observation_sets_truncated: z.boolean(),
    diagnostics_truncated: z.boolean(),
  }),
  failed_images: z.strictObject({
    count,
    detail_limit: count,
    truncated: z.boolean(),
    requests: z.array(
      z.strictObject({ request_id: identifier, hostname: identifier, failure_code: identifier, attempt_count: count }),
    ),
  }),
  progress: z.strictObject({
    current_request: z
      .strictObject({
        request_id: identifier,
        hostname: identifier,
        role: identifier,
        state: identifier,
        attempt_count: count,
        last_attempt_at: timestamp,
      })
      .nullable(),
  }),
  pacing: z.strictObject({
    mode: z.enum(["production", "immediate"]),
    interval_ms: count,
    hosts: z.array(
      z.strictObject({
        hostname: identifier,
        pending_request_count: count,
        captured_request_count: count,
        next_request_not_before: nullableTime,
        waiting_ms: count,
      }),
    ),
  }),
  estimate: z.strictObject({
    advisory: z.literal(true),
    pending_request_count: count,
    captured_request_count: count,
    active_host_count: count,
    minimum_remaining_ms: count,
  }),
});
const workflowSchema = z.strictObject({
  parent_id: nullableReference,
  child_ids: z.array(identifier),
  last_progress_at: nullableTime,
  current_attempt: z
    .strictObject({
      id: identifier,
      attempt_number: count,
      created_at: nullableTime,
      status: safeWorkflowStatus.nullable(),
    })
    .nullable(),
  attempts: z.array(
    z.strictObject({
      id: identifier,
      kind: z.enum(["parent", "child"]),
      attempt_number: count,
      created_at: nullableTime,
      current: z.boolean(),
      last_progress_at: nullableTime,
      last_step_name: nullableReference,
      last_phase: nullableReference,
      status: safeWorkflowStatus.nullable(),
    }),
  ),
  status: safeWorkflowStatus.optional(),
  classification: identifier.optional(),
});
const operationLink = z.strictObject({ code: identifier, method: z.enum(["GET", "POST"]), path: identifier });
const operationalDiagnosticsSchema = z.strictObject({
  contract: z.literal("card-keepr-operational-diagnostics@1"),
  references: z.strictObject({
    run_id: nullableReference,
    request_id: nullableReference,
    expected_catalogue_revision_id: nullableReference,
    resulting_catalogue_revision_id: nullableReference,
    candidate_digest: nullableReference,
    adapter_versions: z.array(identifier),
    workflow: z.strictObject({
      status_path: nullableReference,
      parent_id: nullableReference,
      child_ids: z.array(identifier),
      current_attempt_id: nullableReference,
      status: nullableReference,
      classification: nullableReference,
      last_progress_at: nullableReference,
      attempt_count: count,
    }),
    backup: z.strictObject({ status_path: nullableReference }),
    recovery: z.strictObject({ status_path: identifier }),
  }),
  terminal_evidence: z.strictObject({
    state: nullableReference,
    terminal_at: nullableReference,
    failure: z.strictObject({ code: identifier, retryability_code: identifier, retryable: z.literal(true) }).nullable(),
    warning_count: count,
    approval_decision_count: count,
    coverage: z.strictObject({
      evidence_plan_count: count,
      source_snapshot_count: count,
      source_observation_set_count: count,
      fetch_attempt_count: count,
    }),
  }),
  retry: operationLink.extend({ source_run_id: identifier }).nullable(),
  retry_available: z.boolean(),
  diagnosis_sequence: z.array(operationLink),
});
export const evidenceStatusSchema = z
  .strictObject({
    id: identifier,
    state,
    selected_games: z.array(identifier),
    evidence_plans: z.array(evidencePlanSchema),
    source_coverage: z.array(
      z.strictObject({
        ...sourceFields,
        participation: z.enum(["required", "optional"]).optional(),
        coverage: coverageSchema.optional(),
        status: z.enum(["complete", "incomplete"]),
        attempted_at: timestamp,
        successful_checked_at: nullableTime,
        content_captured_at: nullableTime,
        last_capture_at: nullableTime,
        planned_requests: count,
        observed_requests: count,
        revalidated_requests: count,
      }),
    ),
    supported_game: identifier.optional(),
    source_lineage: identifier.optional(),
    adapter_version: identifier.optional(),
    game_profile_version: identifier.optional(),
    plan_origin: z.enum(["production", "fixture"]),
    official_source_collection_plans: z.array(
      z.strictObject({
        source_lineage: identifier,
        discovery_observation_set_id: identifier,
        contract: identifier,
        content_digest: digest,
        created_at: timestamp,
        plan: z.strictObject({
          contract: z.literal("card-keepr-official-source-collection-plan@1"),
          ...sourceFields,
          game_profile_version: identifier,
          discovery_observation_set_id: identifier,
          requests: z.array(retainedRequestSchema.extend({ surface: identifier })),
        }),
      }),
    ),
    idempotency_key: identifier,
    linked_run_id: nullableReference,
    expected_current_revision_id: identifier,
    started_at: timestamp,
    collection_completed_at: nullableTime,
    failure_code: nullableReference,
    pause: pauseSchema.optional(),
    termination: z
      .strictObject({
        reason: z.literal("ingestion_run_terminated"),
        pause_reason: identifier,
        paused_at: timestamp,
        terminated_at: timestamp,
      })
      .optional(),
    actions,
    curated_revision_ids: z.array(identifier).optional(),
    curated_revision_set_digest: digest.optional(),
    collection: collectionSchema,
    workflow: workflowSchema,
    snapshots: z.array(snapshotSchema),
    observation_sets: z.array(observationSetSchema),
    diagnostics: z.array(
      z.strictObject({
        id: identifier,
        request_id: identifier,
        attempt_number: count,
        requested_at: timestamp,
        completed_at: timestamp,
        outcome: identifier,
        http_status: z.number().int().nullable(),
        response_headers: strings,
        retry_after_ms: count.nullable(),
        diagnostic: z.string().nullable(),
      }),
    ),
    operational_diagnostics: operationalDiagnosticsSchema,
  })
  .openapi("EvidenceStatus");
