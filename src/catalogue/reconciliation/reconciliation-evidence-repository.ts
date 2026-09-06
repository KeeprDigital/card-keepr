import { type CatalogueStore, repositoryStatements } from "../shared";
// Prepared statements only; callers own execution and atomic batch composition.

export function reconciliationSourceRequestsStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT request_id, sequence_number, method, url,
                request_headers_json, representation_fingerprint,
                request_role,
                discovered_from_request_id, state, source_snapshot_id,
                failure_code
         FROM source_requests
         WHERE ingestion_run_id = ?
         ORDER BY sequence_number, request_id`)
    .bind(runId);
}

export function reconciliationObservationSetsStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT
          snapshots.request_id,
          observations.id AS observation_set_id,
          observations.source_snapshot_id,
          snapshots.retrieved_at,
          observations.source_lineage,
          observations.supported_game,
          observations.game_profile_version,
          observations.adapter_version,
          observations.content_digest,
          snapshots.content_digest AS snapshot_content_digest,
          observations.content_byte_length,
          observations.content_object_key,
          observations.observation_count,
          plan.request_plan_json,
          plan.source_lineage AS plan_source_lineage,
          plan.supported_game AS plan_supported_game,
          plan.game_profile_version AS plan_game_profile_version,
          plan.adapter_version AS plan_adapter_version,
          plan.plan_origin,
          snapshots.request_method AS snapshot_request_method,
          snapshots.request_url AS snapshot_request_url,
          snapshots.request_headers_json AS snapshot_request_headers_json,
          snapshots.representation_fingerprint AS snapshot_representation_fingerprint
         FROM source_observation_sets AS observations
         JOIN source_parse_operations AS parse
           ON parse.id = observations.parse_operation_id
         JOIN source_snapshots AS snapshots
           ON snapshots.id = observations.source_snapshot_id
         JOIN ingestion_evidence_plans AS plan
           ON plan.ingestion_run_id = snapshots.ingestion_run_id
         WHERE snapshots.ingestion_run_id = ?
           AND parse.intent = 'collection'
           AND observations.rowid <= (SELECT observation_cutoff FROM reconciliation_operations WHERE ingestion_run_id = snapshots.ingestion_run_id)
         ORDER BY snapshots.request_id, observations.id`)
    .bind(runId);
}

export function reconciliationSnapshotEvidenceStatement(
  database: CatalogueStore,
  runId: string,
  sourceUrl: string,
  sourceLineage: string,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT
          snapshot.request_url,
          snapshot.media_type,
          snapshot.content_digest,
          snapshot.content_byte_length,
          snapshot.content_object_key
         FROM source_snapshots AS snapshot
         JOIN source_requests AS request
           ON request.ingestion_run_id = snapshot.ingestion_run_id
          AND request.request_id = snapshot.request_id
         WHERE snapshot.ingestion_run_id = ? AND snapshot.request_url = ? AND snapshot.source_lineage = ?
           AND request.source_snapshot_id = snapshot.id
           AND request.request_role = 'image'
           AND request.state = 'observed'
         ORDER BY snapshot.rowid DESC LIMIT 1`)
    .bind(runId, sourceUrl, sourceLineage);
}

export function reconciliationCollectionPlansStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT source_lineage, discovery_observation_set_id, contract,
                collection_plan_json, content_digest
         FROM official_source_collection_plans
         WHERE ingestion_run_id = ?
         ORDER BY source_lineage`)
    .bind(runId);
}

export function reconciliationEvidencePlanStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT request_plan_json
         FROM ingestion_evidence_plans
         WHERE ingestion_run_id = ?`)
    .bind(runId);
}

export function reconciliationOverflowRequestsStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT ingestion_run_id, request_id, sequence_number,
                  parent_request_id, method, url, request_headers_json,
                  representation_fingerprint, request_role
           FROM source_discovery_request_plans
           WHERE ingestion_run_id = ?
           ORDER BY sequence_number, request_id`)
    .bind(runId);
}

export function reconciliationObservationCountsStatement(
  database: CatalogueStore,
  runId: string,
  lineage: string,
  adapter: string,
  requestId: string,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT observations.observation_count
       FROM catalogue_revisions AS prior_revision
       JOIN source_snapshots AS snapshots
         ON snapshots.ingestion_run_id = prior_revision.ingestion_run_id
       JOIN source_observation_sets AS observations
         ON observations.source_snapshot_id = snapshots.id
       JOIN source_parse_operations AS parse
         ON parse.id = observations.parse_operation_id
       WHERE parse.intent = 'collection'
         AND snapshots.ingestion_run_id <> ? AND snapshots.source_lineage = ?
         AND observations.adapter_version = ? AND snapshots.request_id = ?
       ORDER BY prior_revision.published_at DESC, prior_revision.id DESC,
                snapshots.source_lineage, snapshots.request_id LIMIT 1`)
    .bind(runId, lineage, adapter, requestId);
}

// A source may verify its already accepted bytes without collecting a different
// designated authority. Only the latest *selected, published* scope counts:
// partial optional captures in a published run were never accepted evidence.
export function unchangedAcceptedSourceStatement(
  database: CatalogueStore,
  runId: string,
  lineage: string,
  adapterVersion: string,
) {
  return repositoryStatements(database)
    .prepare(`WITH prior_run AS (
    SELECT partitions.ingestion_run_id FROM reconciliation_evidence_partitions AS partitions
    JOIN ingestion_run_read AS run ON run.id = partitions.ingestion_run_id
    WHERE partitions.source_lineage = ?2 AND partitions.adapter_version = ?3 AND run.state = 'published'
    ORDER BY run.terminal_at DESC, run.id DESC LIMIT 1
  ), previous AS (
    SELECT snapshots.request_id, snapshots.content_digest FROM reconciliation_evidence_partitions AS partitions
    JOIN source_snapshots AS snapshots ON snapshots.id = partitions.source_snapshot_id
    JOIN source_requests AS requests ON requests.ingestion_run_id = snapshots.ingestion_run_id AND requests.request_id = snapshots.request_id
    WHERE partitions.ingestion_run_id = (SELECT ingestion_run_id FROM prior_run)
      AND partitions.source_lineage = ?2 AND partitions.adapter_version = ?3 AND requests.request_role <> 'image'
  ), current AS (
    SELECT snapshots.request_id, snapshots.content_digest FROM source_snapshots AS snapshots
    JOIN source_requests AS requests ON requests.ingestion_run_id = snapshots.ingestion_run_id AND requests.request_id = snapshots.request_id
      AND requests.source_snapshot_id = snapshots.id
    WHERE snapshots.ingestion_run_id = ?1 AND snapshots.source_lineage = ?2 AND snapshots.adapter_version = ?3 AND requests.request_role <> 'image'
  ) SELECT 1 AS unchanged WHERE EXISTS (SELECT 1 FROM current)
    AND (SELECT COUNT(*) FROM current) = (SELECT COUNT(*) FROM previous)
    AND NOT EXISTS (SELECT 1 FROM current LEFT JOIN previous USING(request_id)
      WHERE previous.content_digest IS NULL OR current.content_digest <> previous.content_digest)`)
    .bind(runId, lineage, adapterVersion);
}
