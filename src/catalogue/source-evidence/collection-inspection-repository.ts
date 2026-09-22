import { type CatalogueStore, repositoryStatements } from "../shared";
// Prepared statements only; callers own execution and atomic batch composition.

export function collectionRequestGroupsStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string; lineagesJson: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
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
    .bind(input.runId, input.lineagesJson);
}

export function collectionEvidenceCountsStatement(
  database: CatalogueStore,
  runId: string,
  skipDiagnostic: string,
): D1PreparedStatement {
  return repositoryStatements(database)
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
             ) AS failed_attempt_count,
             (SELECT COUNT(*) FROM source_fetch_attempts
              WHERE ingestion_run_id = ?1
                AND outcome = 'cache_revalidated' AND http_status = 304
             ) AS revalidated_attempt_count,
             (SELECT COUNT(*) FROM source_fetch_attempts
              WHERE ingestion_run_id = ?1
                AND outcome = 'cache_revalidated' AND http_status IS NULL
                AND diagnostic = ?2
             ) AS skipped_request_count`,
    )
    .bind(runId, skipDiagnostic);
}

export function latestCollectionFailureStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
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
    .bind(runId);
}

export function latestCollectionRequestStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
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
    .bind(runId);
}

export function collectionHostProgressStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(
      `SELECT open.hostname,
                  SUM(CASE WHEN open.state = 'pending' THEN 1 ELSE 0 END)
                    AS pending_request_count,
                  SUM(CASE WHEN open.state = 'captured' THEN 1 ELSE 0 END)
                    AS captured_request_count,
                  pacing.next_request_not_before,
                  pacing.interval_ms,
                  pacing.concurrency
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
    .bind(runId);
}

// Every hostname the run has requested with its current adaptive pacing state
// and this run's backoff/recovery receipt counts (#389).
export function collectionPacingLimitsStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string; limit: number }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(
      `SELECT hosts.hostname, pacing.interval_ms, pacing.concurrency, pacing.clean_streak,
              (SELECT COUNT(*) FROM source_host_pacing_events AS events
               WHERE events.ingestion_run_id = ?1 AND events.hostname = hosts.hostname
                 AND events.kind = 'backoff') AS backoff_count,
              (SELECT COUNT(*) FROM source_host_pacing_events AS events
               WHERE events.ingestion_run_id = ?1 AND events.hostname = hosts.hostname
                 AND events.kind = 'recovery') AS recovery_count
       FROM (SELECT DISTINCT ${hostnameSql} AS hostname FROM source_requests WHERE ingestion_run_id = ?1) AS hosts
       LEFT JOIN source_host_pacing AS pacing ON pacing.hostname = hosts.hostname
       ORDER BY hosts.hostname
       LIMIT ?2`,
    )
    .bind(input.runId, input.limit);
}

// The newest backoff/recovery receipts of one run, with the exact total.
export function recentPacingEventsStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string; limit: number }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(
      `SELECT hostname, request_id, occurred_at, kind, reason, interval_before_ms, interval_after_ms,
              concurrency_before, concurrency_after, http_status, retry_after_ms, latency_ms,
              COUNT(*) OVER () AS total
       FROM source_host_pacing_events
       WHERE ingestion_run_id = ?
       ORDER BY occurred_at DESC, id DESC
       LIMIT ?`,
    )
    .bind(input.runId, input.limit);
}

export function failedPrintingImagesStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string; toleratedCodesJson: string; limit: number }>,
): D1PreparedStatement {
  return repositoryStatements(database)
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
    .bind(input.runId, input.toleratedCodesJson, input.limit);
}

export function recentCollectionSnapshotsStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string; limit: number }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(
      `SELECT * FROM source_snapshots
         WHERE ingestion_run_id = ?
         ORDER BY retrieved_at DESC, id DESC LIMIT ?`,
    )
    .bind(input.runId, input.limit);
}

export function recentCollectionObservationsStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string; limit: number }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(
      `SELECT observations.* FROM source_observation_sets AS observations
         JOIN source_snapshots AS snapshots
           ON snapshots.id = observations.source_snapshot_id
         WHERE snapshots.ingestion_run_id = ?
         ORDER BY observations.parsed_at DESC, observations.id DESC LIMIT ?`,
    )
    .bind(input.runId, input.limit);
}

export function recentCollectionAttemptsStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string; limit: number }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(
      `SELECT * FROM source_fetch_attempts
         WHERE ingestion_run_id = ?
         ORDER BY completed_at DESC, request_id DESC, attempt_number DESC
         LIMIT ?`,
    )
    .bind(input.runId, input.limit);
}

// Unsuccessful fetch attempts by outcome and failed Source Requests by failure
// code: bounded by the closed vocabularies, never by the run's size (#397).
export function collectionFailureGroupsStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(
      `SELECT 'attempt' AS kind, outcome AS code, COUNT(*) AS count
       FROM source_fetch_attempts
       WHERE ingestion_run_id = ?1 AND outcome NOT IN ${successfulOutcomes}
       GROUP BY outcome
       UNION ALL
       SELECT 'request' AS kind, COALESCE(failure_code, 'unclassified') AS code, COUNT(*) AS count
       FROM source_requests
       WHERE ingestion_run_id = ?1 AND state = 'failed'
       GROUP BY COALESCE(failure_code, 'unclassified')
       ORDER BY kind, code`,
    )
    .bind(runId);
}

// One keyset page of Source Requests in sequence order, each with its attempt
// count and latest fetch attempt. Headers and bodies are never selected.
export function collectionRequestPageStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string; afterSequence: number; limit: number }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(
      `SELECT requests.sequence_number, requests.request_id, requests.request_role,
              requests.state, ${hostnameSql} AS hostname, requests.url,
              requests.discovered_from_request_id, requests.retry_generation,
              requests.failure_code, requests.source_snapshot_id,
              (SELECT COUNT(*) FROM source_fetch_attempts AS attempts
               WHERE attempts.ingestion_run_id = requests.ingestion_run_id
                 AND attempts.request_id = requests.request_id) AS attempt_count,
              latest.attempt_number AS latest_attempt_number,
              latest.outcome AS latest_outcome,
              latest.http_status AS latest_http_status,
              latest.completed_at AS latest_completed_at
       FROM source_requests AS requests
       LEFT JOIN source_fetch_attempts AS latest
         ON latest.ingestion_run_id = requests.ingestion_run_id
        AND latest.request_id = requests.request_id
        AND latest.attempt_number = (
          SELECT MAX(newest.attempt_number) FROM source_fetch_attempts AS newest
          WHERE newest.ingestion_run_id = requests.ingestion_run_id
            AND newest.request_id = requests.request_id)
       WHERE requests.ingestion_run_id = ?1 AND requests.sequence_number > ?2
       ORDER BY requests.sequence_number
       LIMIT ?3`,
    )
    .bind(input.runId, input.afterSequence, input.limit);
}

const successfulOutcomes = "('success', 'cache_revalidated')";

// Match URL.hostname for normalized, credential-free HTTPS evidence URLs:
// retain IPv6 brackets and remove an optional port. URL.href canonicalization
// already supplies a path and normalizes domain case and IPv6 spelling.
// Exported so every query that keys Source Requests by host derives the
// hostname the same way, rather than building a LIKE pattern from source data
// (workerd caps LIKE patterns at 50 characters, which a long hostname
// exceeds).
export function sourceRequestHostnameSql(urlColumn: string): string {
  const location = `substr(${urlColumn}, instr(${urlColumn}, '://') + 3)`;
  const authority = `substr(${location}, 1, instr(${location}, '/') - 1)`;
  return `CASE WHEN substr(${authority}, 1, 1) = '[' THEN substr(${authority}, 1, instr(${authority}, ']'))
    WHEN instr(${authority}, ':') > 0 THEN substr(${authority}, 1, instr(${authority}, ':') - 1)
    ELSE ${authority} END`;
}

const hostnameSql = sourceRequestHostnameSql("url");
