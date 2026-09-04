import type { CatalogueStore } from "../shared";
import {
  collectionEvidenceCountsStatement,
  collectionHostProgressStatement,
  collectionRequestGroupsStatement,
  failedPrintingImagesStatement,
  latestCollectionFailureStatement,
  latestCollectionRequestStatement,
  recentCollectionAttemptsStatement,
  recentCollectionObservationsStatement,
  recentCollectionSnapshotsStatement,
} from "./collection-inspection-repository";
// The owner's aggregated view of one Ingestion Run's collection: capacity
// per Source Lineage, request counts by lineage, role, and state, evidence
// volume, retry facts, the current safe request reference, host pacing, and
// an advisory remaining-time estimate. Every figure is an aggregate query;
// per-request detail is bounded separately so a production-sized run (many
// thousands of Source Requests) never materializes into a multi-megabyte
// status document. Nothing here carries request headers, credentials,
// response bodies, or unvetted provider text: identifiers, hostnames,
// bounded counters, timestamps, and closed machine codes only.
import { type EvidencePlan, toleratedPrintingImageFailureCodes } from "./source-evidence-model";
import type {
  CurrentPause,
  ObservationSetRow,
  RunCapacityPolicy,
  SnapshotRow,
} from "./source-evidence-repository-types";

export const inspectionDetailLimit = 200;

export type PacingConfiguration = Readonly<{
  mode: "production" | "immediate";
  interval_ms: number;
}>;

export type CollectionInspectionInput = Readonly<{
  run: Readonly<{
    id: string;
    state: string;
    started_at: string;
    expected_current_revision_id: string;
    collection_completed_at: string | null;
    terminal_at: string | null;
  }>;
  plans: readonly EvidencePlan[];
  // Effective capacity policy per Source Lineage, keyed by lineage.
  capacityPolicies: ReadonlyMap<string, RunCapacityPolicy>;
  pause: CurrentPause | null;
  lastProgressAt: string | null;
  pacing: PacingConfiguration;
  nowMs: number;
}>;

export type EvidenceCounts = Readonly<{
  snapshot_count: number;
  retained_byte_total: number;
  observation_set_count: number;
  fetch_attempt_count: number;
  retry_attempt_count: number;
  failed_attempt_count: number;
}>;

type RequestGroupRow = {
  group_key: string;
  request_role: string;
  state: string;
  count: number;
};

type AttemptRow = {
  id: string;
  request_id: string;
  attempt_number: number;
  requested_at: string;
  completed_at: string;
  outcome: string;
  http_status: number | null;
  response_headers_json: string;
  retry_after_ms: number | null;
  diagnostic: string | null;
};

export async function collectionInspection(
  database: CatalogueStore,
  input: CollectionInspectionInput,
): Promise<{ collection: Record<string, unknown>; counts: EvidenceCounts }> {
  const runId = input.run.id;
  const [groups, counts, latestFailure, currentRequest, hosts, failedImages] = await Promise.all([
    // Dynamically discovered and collection-plan identities carry their
    // Source Lineage as a prefix and group by it; every other identity is
    // an initial Evidence Plan request that resolves through its plan, so
    // it groups by its whole identity.
    collectionRequestGroupsStatement(database, {
      runId: runId,
      lineagesJson: JSON.stringify(input.plans.map((plan) => plan.source_lineage)),
    }).all<RequestGroupRow>(),
    collectionEvidenceCountsStatement(database, runId).first<EvidenceCounts>(),
    latestCollectionFailureStatement(database, runId).first<{
      request_id: string;
      outcome: string;
      http_status: number | null;
      attempt_number: number;
      completed_at: string;
      hostname: string;
    }>(),
    // The request most recently worked on: the newest fetch attempt or
    // capture operation, whichever is later.
    latestCollectionRequestStatement(database, runId).first<{
      request_id: string;
      request_role: string;
      state: string;
      hostname: string;
      attempt_count: number;
      last_attempt_at: string;
    }>(),
    collectionHostProgressStatement(database, runId).all<{
      hostname: string;
      pending_request_count: number;
      captured_request_count: number;
      next_request_not_before: string | null;
    }>(),
    // Printing Images that failed under a tolerated code (exhausted
    // transport retries, a missing or redirected file, a rejected
    // revalidation, a body-contract violation): failures the run completed
    // around. The list is bounded like every other per-request detail; the
    // count is exact.
    failedPrintingImagesStatement(database, {
      runId: runId,
      toleratedCodesJson: JSON.stringify(toleratedPrintingImageFailureCodes),
      limit: inspectionDetailLimit,
    }).all<{
      request_id: string;
      hostname: string;
      failure_code: string;
      attempt_count: number;
      total: number;
    }>(),
  ]);
  if (counts === null) throw new Error("Evidence counts are unavailable.");
  const failedImageCount = failedImages.results[0]?.total ?? 0;
  const requests = groupedRequests(groups.results, input.plans);
  const capacityPause =
    input.run.state === "paused" && input.pause?.reason === "source_request_capacity_exhausted"
      ? input.pause.document
      : null;
  const capacity = input.plans
    .map((plan) => plan.source_lineage)
    .filter((lineage, index, all) => all.indexOf(lineage) === index)
    .map((lineage) => {
      const policy = input.capacityPolicies.get(lineage);
      if (policy === undefined) {
        throw new Error(`Source Lineage ${lineage} has no capacity policy.`);
      }
      const used = requests.by_lineage.find((group) => group.source_lineage === lineage)?.total ?? 0;
      const paused = capacityPause !== null && capacityPause.source_lineage === lineage;
      return {
        source_lineage: lineage,
        adapter_version: input.plans.find((plan) => plan.source_lineage === lineage)!.adapter_version,
        capacity_generation: policy.capacity_generation,
        request_capacity: policy.request_capacity,
        used_capacity: used,
        remaining_capacity: Math.max(0, policy.request_capacity - used),
        required_capacity: paused ? numberOrNull(capacityPause.required_capacity) : null,
        overflow_request_count: paused ? numberOrNull(capacityPause.overflow_request_count) : null,
      };
    });
  const pacingHosts = hosts.results.map((host) => {
    const deadline = host.next_request_not_before === null ? null : Date.parse(host.next_request_not_before);
    return {
      hostname: host.hostname,
      pending_request_count: host.pending_request_count,
      captured_request_count: host.captured_request_count,
      next_request_not_before: host.next_request_not_before,
      waiting_ms: deadline === null || Number.isNaN(deadline) ? 0 : Math.max(0, deadline - input.nowMs),
    };
  });
  // Hosts collect in parallel and each host's requests are paced
  // sequentially, so the floor on remaining time is the slowest host's
  // pending fetches at the configured interval, plus whatever pacing wait it
  // is already serving. Advisory only: it ignores transport time, retries,
  // parse work, and dynamic discovery that has not happened yet.
  const minimumRemainingMs =
    input.pacing.mode === "immediate"
      ? 0
      : Math.max(
          0,
          ...pacingHosts.map((host) => host.waiting_ms + host.pending_request_count * input.pacing.interval_ms),
        );
  const collection: Record<string, unknown> = {
    state: input.run.state,
    pause_reason: input.run.state === "paused" ? (input.pause?.reason ?? null) : null,
    paused_at: input.run.state === "paused" ? (input.pause?.paused_at ?? null) : null,
    started_at: input.run.started_at,
    last_progress_at: input.lastProgressAt,
    collection_completed_at: input.run.collection_completed_at,
    terminal_at: input.run.terminal_at,
    expected_catalogue_revision_id: input.run.expected_current_revision_id,
    capacity,
    requests,
    evidence: {
      ...counts,
      latest_failure:
        latestFailure === null
          ? null
          : {
              request_id: latestFailure.request_id,
              hostname: latestFailure.hostname,
              classification: latestFailure.outcome,
              http_status: latestFailure.http_status,
              attempt_number: latestFailure.attempt_number,
              at: latestFailure.completed_at,
            },
      detail_limit: inspectionDetailLimit,
      snapshots_truncated: counts.snapshot_count > inspectionDetailLimit,
      observation_sets_truncated: counts.observation_set_count > inspectionDetailLimit,
      diagnostics_truncated: counts.fetch_attempt_count > inspectionDetailLimit,
    },
    failed_images: {
      count: failedImageCount,
      detail_limit: inspectionDetailLimit,
      truncated: failedImageCount > inspectionDetailLimit,
      requests: failedImages.results.map((image) => ({
        request_id: image.request_id,
        hostname: image.hostname,
        failure_code: image.failure_code,
        attempt_count: image.attempt_count,
      })),
    },
    progress: {
      current_request:
        currentRequest === null
          ? null
          : {
              request_id: currentRequest.request_id,
              hostname: currentRequest.hostname,
              role: currentRequest.request_role,
              state: currentRequest.state,
              attempt_count: currentRequest.attempt_count,
              last_attempt_at: currentRequest.last_attempt_at,
            },
    },
    pacing: {
      mode: input.pacing.mode,
      interval_ms: input.pacing.interval_ms,
      hosts: pacingHosts,
    },
    estimate: {
      advisory: true,
      pending_request_count: pacingHosts.reduce((total, host) => total + host.pending_request_count, 0),
      captured_request_count: pacingHosts.reduce((total, host) => total + host.captured_request_count, 0),
      active_host_count: pacingHosts.length,
      minimum_remaining_ms: minimumRemainingMs,
    },
  };
  return { collection, counts };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

type RequestGrouping = {
  total: number;
  by_state: Record<string, number>;
  by_role: Record<string, number>;
  by_lineage: Array<{
    source_lineage: string;
    total: number;
    by_state: Record<string, number>;
    by_role: Record<string, number>;
  }>;
};

// A group key is either a Source Lineage (the prefix of discovered and
// collection-plan identities) or one initial Evidence Plan identity, which
// resolves through the plan that declared it.
function groupedRequests(rows: readonly RequestGroupRow[], plans: readonly EvidencePlan[]): RequestGrouping {
  const lineages = new Set(plans.map((plan) => plan.source_lineage));
  const lineageOfPlanRequest = new Map(
    plans.flatMap((plan) => plan.requests.map(({ id }) => [id, plan.source_lineage] as const)),
  );
  const lineageOf = (row: RequestGroupRow): string =>
    lineages.has(row.group_key) ? row.group_key : (lineageOfPlanRequest.get(row.group_key) ?? row.group_key);
  const grouping: RequestGrouping = {
    total: 0,
    by_state: {},
    by_role: {},
    by_lineage: [],
  };
  const byLineage = new Map<string, RequestGrouping["by_lineage"][number]>();
  for (const row of rows) {
    const lineage = lineageOf(row);
    let group = byLineage.get(lineage);
    if (group === undefined) {
      group = { source_lineage: lineage, total: 0, by_state: {}, by_role: {} };
      byLineage.set(lineage, group);
    }
    for (const target of [grouping, group]) {
      target.total += row.count;
      target.by_state[row.state] = (target.by_state[row.state] ?? 0) + row.count;
      target.by_role[row.request_role] = (target.by_role[row.request_role] ?? 0) + row.count;
    }
  }
  grouping.by_lineage = [...byLineage.values()].sort((left, right) =>
    left.source_lineage.localeCompare(right.source_lineage),
  );
  return grouping;
}

// The newest bounded slice of each per-request detail list, returned in the
// stable ascending order the status document has always used. Counts come
// from the aggregate query, so truncation never changes them.
export async function boundedEvidenceDetail(
  database: CatalogueStore,
  runId: string,
): Promise<{
  snapshots: SnapshotRow[];
  observationSets: ObservationSetRow[];
  attempts: AttemptRow[];
}> {
  const [snapshots, observations, attempts] = await Promise.all([
    recentCollectionSnapshotsStatement(database, { runId: runId, limit: inspectionDetailLimit }).all<SnapshotRow>(),
    recentCollectionObservationsStatement(database, {
      runId: runId,
      limit: inspectionDetailLimit,
    }).all<ObservationSetRow>(),
    recentCollectionAttemptsStatement(database, { runId: runId, limit: inspectionDetailLimit }).all<AttemptRow>(),
  ]);
  return {
    snapshots: snapshots.results.sort(
      (left, right) => left.retrieved_at.localeCompare(right.retrieved_at) || left.id.localeCompare(right.id),
    ),
    observationSets: observations.results.sort(
      (left, right) => left.parsed_at.localeCompare(right.parsed_at) || left.id.localeCompare(right.id),
    ),
    attempts: attempts.results.sort(
      (left, right) => left.request_id.localeCompare(right.request_id) || left.attempt_number - right.attempt_number,
    ),
  };
}
