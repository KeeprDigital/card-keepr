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
         ORDER BY snapshots.request_id, observations.id`)
    .bind(runId);
}

export function reconciliationSnapshotEvidenceStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
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
         WHERE snapshot.ingestion_run_id = ?
           AND request.request_role = 'image'
           AND request.state = 'observed'
         ORDER BY snapshot.request_url`)
    .bind(runId);
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

export function reconciliationObservationCountsStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT snapshots.request_id, snapshots.source_lineage,
              observations.observation_count
       FROM catalogue_revisions AS prior_revision
       JOIN source_snapshots AS snapshots
         ON snapshots.ingestion_run_id = prior_revision.ingestion_run_id
       JOIN source_observation_sets AS observations
         ON observations.source_snapshot_id = snapshots.id
       JOIN source_parse_operations AS parse
         ON parse.id = observations.parse_operation_id
       WHERE parse.intent = 'collection'
         AND snapshots.ingestion_run_id <> ?
       ORDER BY prior_revision.published_at DESC, prior_revision.id DESC,
                snapshots.source_lineage, snapshots.request_id`)
    .bind(runId);
}
