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
// A plan's bounded tranche of one discovered role (#409); the scope decides
// which roles are selectable and the adapter what a group names.
const discoverySelectionSchema = z.strictObject({
  role: z.enum(["listing", "detail", "product_detail", "image"]),
  groups: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u))
    .min(1)
    .max(2000)
    .optional(),
  maximum_requests: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
});
export const planInputSchema = z.strictObject({
  ...sourceFields,
  participation: z.enum(["required", "optional"]).optional(),
  subset: identifier.optional(),
  discovery_selection: discoverySelectionSchema.optional(),
  requests: z.array(requestSchema).min(1).max(100),
});
export const acquisitionBudgetSchema = z.strictObject({
  max_dispatches: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  max_source_bytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  dispatch_deadline: timestamp,
});
export const acquisitionExtensionInputSchema = z.strictObject({
  expected_generation: z.number().int().min(0),
  expected_budget: acquisitionBudgetSchema.nullable(),
  acquisition_budget: acquisitionBudgetSchema,
  idempotency_key: identifier,
});
export const acquisitionExtensionSchema = z.strictObject({
  contract: z.literal("card-keepr-acquisition-budget-extension@1"),
  ingestion_run_id: identifier,
  previous_generation: count,
  generation: count,
  previous_budget: acquisitionBudgetSchema.nullable(),
  acquisition_budget: acquisitionBudgetSchema,
  extended_at: timestamp,
});
const acquisitionDimensionSchema = z.enum(["dispatches", "source_bytes", "deadline", "policy_missing", "ownership"]);
const acquisitionInspectionSchema = z.strictObject({
  generation: count,
  coverage_started_at: timestamp,
  historical_dispatches_unknown: z.boolean(),
  baseline_source_bytes: count,
  budget: acquisitionBudgetSchema,
  charged_dispatches: count,
  charged_source_bytes: count,
  reserved_source_bytes: count,
  remaining_dispatches: count,
  remaining_source_bytes: count,
  limiting_dimension: acquisitionDimensionSchema.nullable(),
  unsettled: z.array(
    z.strictObject({
      id: identifier,
      request_id: identifier,
      capture_operation_id: identifier,
      parent_workflow_id: nullableReference,
      workflow_instance_id: nullableReference,
      budget_generation: count,
      maximum_source_bytes: count,
      reserved_at: timestamp,
    }),
  ),
  unsettled_truncated: z.boolean(),
});
export const evidenceInputSchema = z.union([
  planInputSchema.extend({ idempotency_key: identifier, acquisition_budget: acquisitionBudgetSchema }),
  z.strictObject({
    plans: z.array(planInputSchema).min(1),
    idempotency_key: identifier,
    acquisition_budget: acquisitionBudgetSchema,
  }),
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
  discovery_selection: discoverySelectionSchema.optional(),
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
const actions = z.array(
  z.enum(["resume", "pause", "terminate", "retry", "extend_capacity", "extend_acquisition_budget"]),
);
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
    reason: z.literal("source_acquisition_budget_exhausted"),
    paused_at: timestamp,
    generation: count.nullable(),
    request_id: identifier,
    maximum_source_bytes: count,
    dimension: acquisitionDimensionSchema,
    actions,
  }),
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
      "source_workflow_attempt_exhausted",
      "source_collection_no_progress",
    ]),
    paused_at: timestamp,
    workflow_instance_id: identifier,
    workflow_status: safeWorkflowStatus,
    last_progress_at: nullableTime,
    // The collection still owed when the barrier abandoned its attempt; null
    // for every Workflow Pause the barrier did not record about itself.
    stranded: z
      .strictObject({
        pending_request_count: count,
        by_host: z.array(z.strictObject({ hostname: identifier, pending_request_count: count })),
      })
      .nullable(),
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
    revalidated_attempt_count: count,
    skipped_request_count: count,
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
  deferred_requests: z.strictObject({
    count,
    selections: z.array(
      z.strictObject({
        source_lineage: identifier,
        role: identifier,
        group_count: count.nullable(),
        maximum_requests: count.nullable(),
      }),
    ),
    by_lineage: z.array(z.strictObject({ source_lineage: identifier, role: identifier, count })),
    group_count: count,
    detail_limit: count,
    groups_truncated: z.boolean(),
    groups: z.array(z.strictObject({ group: z.string(), count })),
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
        interval_ms: count,
        concurrency: count,
      }),
    ),
    limits: z.array(
      z.strictObject({
        hostname: identifier,
        kind: z.enum(["page", "asset"]),
        source: z.enum(["registration", "default"]),
        floor_ms: count,
        ceiling_ms: count,
        maximum_concurrency: count,
        interval_ms: count,
        concurrency: count,
        clean_streak: count,
        backoff_count: count,
        recovery_count: count,
      }),
    ),
    events: z.strictObject({
      count,
      detail_limit: count,
      truncated: z.boolean(),
      recent: z.array(
        z.strictObject({
          hostname: identifier,
          request_id: identifier,
          occurred_at: timestamp,
          kind: z.enum(["backoff", "recovery"]),
          reason: z.enum([
            "rate_limited",
            "unavailable",
            "gateway",
            "retry_after",
            "timeout",
            "connection",
            "latency",
            "clean_streak",
          ]),
          interval_before_ms: count,
          interval_after_ms: count,
          concurrency_before: count,
          concurrency_after: count,
          http_status: z.number().int().nullable(),
          retry_after_ms: count.nullable(),
          latency_ms: count.nullable(),
        }),
      ),
    }),
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
export const operationalDiagnosticsSchema = z.strictObject({
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
const sourceCoverageSchema = z.strictObject({
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
});
const terminationSchema = z.strictObject({
  reason: z.literal("ingestion_run_terminated"),
  pause_reason: identifier,
  paused_at: timestamp,
  terminated_at: timestamp,
});
// The compact status summary (#397): every list is bounded by plan, host,
// closed-vocabulary or fixed detail limits, never by the run's request count.
export const evidenceSummarySchema = z
  .strictObject({
    contract: z.literal("card-keepr-evidence-summary@1"),
    id: identifier,
    state,
    selected_games: z.array(identifier),
    plan_origin: z.enum(["production", "fixture"]),
    supported_game: identifier.optional(),
    source_lineage: identifier.optional(),
    adapter_version: identifier.optional(),
    game_profile_version: identifier.optional(),
    source_coverage: z.array(sourceCoverageSchema),
    idempotency_key: identifier,
    linked_run_id: nullableReference,
    expected_current_revision_id: identifier,
    started_at: timestamp,
    collection_completed_at: nullableTime,
    failure_code: nullableReference,
    pause: pauseSchema.optional(),
    termination: terminationSchema.optional(),
    actions,
    acquisition: acquisitionInspectionSchema.nullable(),
    collection: collectionSchema,
    failures: z.strictObject({
      attempts_by_outcome: z.record(z.string(), count),
      requests_by_failure_code: z.record(z.string(), count),
    }),
    workflow: workflowSchema.extend({
      attempt_count: count,
      current_attempt_count: count,
      attempts_truncated: z.boolean(),
    }),
    operational_diagnostics: operationalDiagnosticsSchema,
  })
  .openapi("EvidenceSummary");
export const evidenceRequestsSchema = z
  .strictObject({
    contract: z.literal("card-keepr-evidence-requests@1"),
    ingestion_run_id: identifier,
    page_size: count,
    requests: z.array(
      z.strictObject({
        sequence_number: count,
        request_id: identifier,
        role: identifier,
        state: identifier,
        hostname: identifier,
        url: z.url(),
        discovered_from_request_id: nullableReference,
        retry_generation: count,
        failure_code: nullableReference,
        source_snapshot_id: nullableReference,
        attempt_count: count,
        latest_attempt: z
          .strictObject({
            attempt_number: count,
            outcome: identifier,
            http_status: z.number().int().nullable(),
            completed_at: timestamp,
          })
          .nullable(),
      }),
    ),
    next_after: z
      .string()
      .regex(/^(0|[1-9]\d*)$/)
      .nullable(),
  })
  .openapi("EvidenceRequests");
export const evidenceStatusSchema = z
  .strictObject({
    acquisition: acquisitionInspectionSchema.nullable(),
    id: identifier,
    state,
    selected_games: z.array(identifier),
    evidence_plans: z.array(evidencePlanSchema),
    source_coverage: z.array(sourceCoverageSchema),
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
    termination: terminationSchema.optional(),
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
