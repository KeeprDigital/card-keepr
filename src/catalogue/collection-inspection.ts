// The owner's aggregated view of one Ingestion Run's collection: capacity
// per Source Lineage, request counts by lineage, role, and state, evidence
// volume, retry facts, the current safe request reference, host pacing, and
// an advisory remaining-time estimate. Every figure is an aggregate query;
// per-request detail is bounded separately so a production-sized run (many
// thousands of Source Requests) never materializes into a multi-megabyte
// status document. Nothing here carries request headers, credentials,
// response bodies, or unvetted provider text: identifiers, hostnames,
// bounded counters, timestamps, and closed machine codes only.
import {
  toleratedPrintingImageFailureCodes,
  type EvidencePlan,
} from "./source-evidence-model";
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

const successfulOutcomes = "('success', 'cache_revalidated')";

// The hostname of a plain https evidence URL, extracted in SQL: everything
// between '://' and the first '/' of the path (evidence requests are
// normalized URLs without ports, and always carry a path).
const hostnameSql =
  `substr(substr(url, instr(url, '://') + 3), 1,
          instr(substr(url, instr(url, '://') + 3), '/') - 1)`;

export async function collectionInspection(
  database: D1Database,
  input: CollectionInspectionInput,
): Promise<{ collection: Record<string, unknown>; counts: EvidenceCounts }> {
  const runId = input.run.id;
  const [groups, counts, latestFailure, currentRequest, hosts, failedImages] =
    await Promise.all([
      // Dynamically discovered and collection-plan identities carry their
      // Source Lineage as a prefix and group by it; every other identity is
      // an initial Evidence Plan request that resolves through its plan, so
      // it groups by its whole identity.
      database
        .prepare(
          `SELECT
             CASE WHEN instr(request_id, ':') > 0
               AND substr(request_id, 1, instr(request_id, ':') - 1)
                 IN (SELECT value FROM json_each(?2))
               THEN substr(request_id, 1, instr(request_id, ':') - 1)
               ELSE request_id END AS group_key,
             request_role, state, COUNT(*) AS count
           FROM source_requests
           WHERE ingestion_run_id = ?1
           GROUP BY group_key, request_role, state
           ORDER BY group_key, request_role, state`,
        )
        .bind(
          runId,
          JSON.stringify(input.plans.map((plan) => plan.source_lineage)),
        )
        .all<RequestGroupRow>(),
      database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM source_snapshots
              WHERE ingestion_run_id = ?1) AS snapshot_count,
             (SELECT COALESCE(SUM(content_byte_length), 0)
              FROM source_snapshots
              WHERE ingestion_run_id = ?1) AS retained_byte_total,
             (SELECT COUNT(*)
              FROM source_observation_sets AS observations
              JOIN source_snapshots AS snapshots
                ON snapshots.id = observations.source_snapshot_id
              WHERE snapshots.ingestion_run_id = ?1) AS observation_set_count,
             (SELECT COUNT(*) FROM source_fetch_attempts
              WHERE ingestion_run_id = ?1) AS fetch_attempt_count,
             (SELECT COUNT(*) FROM source_fetch_attempts
              WHERE ingestion_run_id = ?1
                AND attempt_number > 1) AS retry_attempt_count,
             (SELECT COUNT(*) FROM source_fetch_attempts
              WHERE ingestion_run_id = ?1
                AND outcome NOT IN ${successfulOutcomes}
             ) AS failed_attempt_count`,
        )
        .bind(runId)
        .first<EvidenceCounts>(),
      database
        .prepare(
          `SELECT attempts.request_id, attempts.outcome, attempts.http_status,
                  attempts.attempt_number, attempts.completed_at,
                  ${hostnameSql} AS hostname
           FROM source_fetch_attempts AS attempts
           JOIN source_requests AS requests
             ON requests.ingestion_run_id = attempts.ingestion_run_id
            AND requests.request_id = attempts.request_id
           WHERE attempts.ingestion_run_id = ?1
             AND attempts.outcome NOT IN ${successfulOutcomes}
           ORDER BY attempts.completed_at DESC, attempts.request_id DESC,
                    attempts.attempt_number DESC
           LIMIT 1`,
        )
        .bind(runId)
        .first<{
          request_id: string;
          outcome: string;
          http_status: number | null;
          attempt_number: number;
          completed_at: string;
          hostname: string;
        }>(),
      // The request most recently worked on: the newest fetch attempt or
      // capture operation, whichever is later.
      database
        .prepare(
          `SELECT requests.request_id, requests.request_role, requests.state,
                  ${hostnameSql} AS hostname,
                  (SELECT COUNT(*) FROM source_fetch_attempts AS attempts
                   WHERE attempts.ingestion_run_id = requests.ingestion_run_id
                     AND attempts.request_id = requests.request_id
                  ) AS attempt_count,
                  newest.at AS last_attempt_at
           FROM (
             SELECT request_id, at FROM (
               SELECT request_id, completed_at AS at
               FROM source_fetch_attempts WHERE ingestion_run_id = ?1
               UNION ALL
               SELECT request_id, COALESCE(completed_at, requested_at) AS at
               FROM source_capture_operations WHERE ingestion_run_id = ?1
             )
             ORDER BY at DESC, request_id DESC LIMIT 1
           ) AS newest
           JOIN source_requests AS requests
             ON requests.ingestion_run_id = ?1
            AND requests.request_id = newest.request_id`,
        )
        .bind(runId)
        .first<{
          request_id: string;
          request_role: string;
          state: string;
          hostname: string;
          attempt_count: number;
          last_attempt_at: string;
        }>(),
      database
        .prepare(
          `SELECT open.hostname,
                  SUM(CASE WHEN open.state = 'pending' THEN 1 ELSE 0 END)
                    AS pending_request_count,
                  SUM(CASE WHEN open.state = 'captured' THEN 1 ELSE 0 END)
                    AS captured_request_count,
                  pacing.next_request_not_before
           FROM (
             SELECT ${hostnameSql} AS hostname, state
             FROM source_requests
             WHERE ingestion_run_id = ?1
               AND state IN ('pending', 'captured')
           ) AS open
           LEFT JOIN source_host_pacing AS pacing
             ON pacing.hostname = open.hostname
           GROUP BY open.hostname
           ORDER BY open.hostname`,
        )
        .bind(runId)
        .all<{
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
      database
        .prepare(
          `SELECT requests.request_id, ${hostnameSql} AS hostname,
                  requests.failure_code,
                  (SELECT COUNT(*) FROM source_fetch_attempts AS attempts
                   WHERE attempts.ingestion_run_id = requests.ingestion_run_id
                     AND attempts.request_id = requests.request_id
                  ) AS attempt_count,
                  COUNT(*) OVER () AS total
           FROM source_requests AS requests
           WHERE requests.ingestion_run_id = ?1
             AND requests.request_role = 'image'
             AND requests.state = 'failed'
             AND requests.failure_code IN (SELECT value FROM json_each(?2))
           ORDER BY requests.request_id
           LIMIT ?3`,
        )
        .bind(
          runId,
          JSON.stringify(toleratedPrintingImageFailureCodes),
          inspectionDetailLimit,
        )
        .all<{
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
  const capacityPause = input.run.state === "paused" &&
      input.pause?.reason === "source_request_capacity_exhausted"
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
      const used = requests.by_lineage.find(
        (group) => group.source_lineage === lineage,
      )?.total ?? 0;
      const paused = capacityPause !== null &&
        capacityPause.source_lineage === lineage;
      return {
        source_lineage: lineage,
        adapter_version: input.plans.find(
          (plan) => plan.source_lineage === lineage,
        )!.adapter_version,
        capacity_generation: policy.capacity_generation,
        request_capacity: policy.request_capacity,
        used_capacity: used,
        remaining_capacity: Math.max(0, policy.request_capacity - used),
        required_capacity: paused
          ? numberOrNull(capacityPause.required_capacity)
          : null,
        overflow_request_count: paused
          ? numberOrNull(capacityPause.overflow_request_count)
          : null,
      };
    });
  const pacingHosts = hosts.results.map((host) => {
    const deadline = host.next_request_not_before === null
      ? null
      : Date.parse(host.next_request_not_before);
    return {
      hostname: host.hostname,
      pending_request_count: host.pending_request_count,
      captured_request_count: host.captured_request_count,
      next_request_not_before: host.next_request_not_before,
      waiting_ms: deadline === null || Number.isNaN(deadline)
        ? 0
        : Math.max(0, deadline - input.nowMs),
    };
  });
  // Hosts collect in parallel and each host's requests are paced
  // sequentially, so the floor on remaining time is the slowest host's
  // pending fetches at the configured interval, plus whatever pacing wait it
  // is already serving. Advisory only: it ignores transport time, retries,
  // parse work, and dynamic discovery that has not happened yet.
  const minimumRemainingMs = input.pacing.mode === "immediate"
    ? 0
    : Math.max(
      0,
      ...pacingHosts.map((host) =>
        host.waiting_ms + host.pending_request_count * input.pacing.interval_ms
      ),
    );
  const collection: Record<string, unknown> = {
    state: input.run.state,
    pause_reason: input.run.state === "paused"
      ? input.pause?.reason ?? null
      : null,
    paused_at: input.run.state === "paused"
      ? input.pause?.paused_at ?? null
      : null,
    started_at: input.run.started_at,
    last_progress_at: input.lastProgressAt,
    collection_completed_at: input.run.collection_completed_at,
    terminal_at: input.run.terminal_at,
    expected_catalogue_revision_id: input.run.expected_current_revision_id,
    capacity,
    requests,
    evidence: {
      ...counts,
      latest_failure: latestFailure === null ? null : {
        request_id: latestFailure.request_id,
        hostname: latestFailure.hostname,
        classification: latestFailure.outcome,
        http_status: latestFailure.http_status,
        attempt_number: latestFailure.attempt_number,
        at: latestFailure.completed_at,
      },
      detail_limit: inspectionDetailLimit,
      snapshots_truncated: counts.snapshot_count > inspectionDetailLimit,
      observation_sets_truncated:
        counts.observation_set_count > inspectionDetailLimit,
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
      current_request: currentRequest === null ? null : {
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
      pending_request_count: pacingHosts.reduce(
        (total, host) => total + host.pending_request_count,
        0,
      ),
      captured_request_count: pacingHosts.reduce(
        (total, host) => total + host.captured_request_count,
        0,
      ),
      active_host_count: pacingHosts.length,
      minimum_remaining_ms: minimumRemainingMs,
    },
  };
  return { collection, counts };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
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
function groupedRequests(
  rows: readonly RequestGroupRow[],
  plans: readonly EvidencePlan[],
): RequestGrouping {
  const lineages = new Set(plans.map((plan) => plan.source_lineage));
  const lineageOfPlanRequest = new Map(
    plans.flatMap((plan) =>
      plan.requests.map(({ id }) => [id, plan.source_lineage] as const)
    ),
  );
  const lineageOf = (row: RequestGroupRow): string =>
    lineages.has(row.group_key)
      ? row.group_key
      : lineageOfPlanRequest.get(row.group_key) ?? row.group_key;
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
      target.by_role[row.request_role] =
        (target.by_role[row.request_role] ?? 0) + row.count;
    }
  }
  grouping.by_lineage = [...byLineage.values()].sort((left, right) =>
    left.source_lineage.localeCompare(right.source_lineage)
  );
  return grouping;
}

// The newest bounded slice of each per-request detail list, returned in the
// stable ascending order the status document has always used. Counts come
// from the aggregate query, so truncation never changes them.
export async function boundedEvidenceDetail(
  database: D1Database,
  runId: string,
): Promise<{
  snapshots: SnapshotRow[];
  observationSets: ObservationSetRow[];
  attempts: AttemptRow[];
}> {
  const [snapshots, observations, attempts] = await Promise.all([
    database
      .prepare(
        `SELECT * FROM source_snapshots
         WHERE ingestion_run_id = ?
         ORDER BY retrieved_at DESC, id DESC LIMIT ?`,
      )
      .bind(runId, inspectionDetailLimit)
      .all<SnapshotRow>(),
    database
      .prepare(
        `SELECT observations.* FROM source_observation_sets AS observations
         JOIN source_snapshots AS snapshots
           ON snapshots.id = observations.source_snapshot_id
         WHERE snapshots.ingestion_run_id = ?
         ORDER BY observations.parsed_at DESC, observations.id DESC LIMIT ?`,
      )
      .bind(runId, inspectionDetailLimit)
      .all<ObservationSetRow>(),
    database
      .prepare(
        `SELECT * FROM source_fetch_attempts
         WHERE ingestion_run_id = ?
         ORDER BY completed_at DESC, request_id DESC, attempt_number DESC
         LIMIT ?`,
      )
      .bind(runId, inspectionDetailLimit)
      .all<AttemptRow>(),
  ]);
  return {
    snapshots: snapshots.results.sort((left, right) =>
      left.retrieved_at.localeCompare(right.retrieved_at) ||
      left.id.localeCompare(right.id)
    ),
    observationSets: observations.results.sort((left, right) =>
      left.parsed_at.localeCompare(right.parsed_at) ||
      left.id.localeCompare(right.id)
    ),
    attempts: attempts.results.sort((left, right) =>
      left.request_id.localeCompare(right.request_id) ||
      left.attempt_number - right.attempt_number
    ),
  };
}
