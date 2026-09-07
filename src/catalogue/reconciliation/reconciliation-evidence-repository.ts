import { type CatalogueStore, repositoryStatements } from "../shared";
// Prepared statements only; callers own execution and atomic batch composition.

const evidencePlansSql = `CASE WHEN json_type(plan.request_plan_json, '$.plans') = 'array'
  THEN json_extract(plan.request_plan_json, '$.plans') ELSE json_array(json(plan.request_plan_json)) END`;

// Match immutable roots first. Discovered request IDs use their validated
// Source Lineage prefix, exactly as evidencePlanForRequest does.
function requestInPreparationGame(requestId: string) {
  return `EXISTS (SELECT 1 FROM reconciliation_operations AS operation
    JOIN ingestion_evidence_plans AS plan ON plan.ingestion_run_id = operation.ingestion_run_id
    WHERE operation.id = ?1 AND (operation.supported_game IS NULL OR EXISTS (
      SELECT 1 FROM json_each(${evidencePlansSql}) AS selected
      WHERE json_extract(selected.value, '$.supported_game') = operation.supported_game AND (
        EXISTS (SELECT 1 FROM json_each(selected.value, '$.requests') AS root
          WHERE json_extract(root.value, '$.id') = ${requestId})
        OR (json_extract(selected.value, '$.source_lineage') = substr(${requestId}, 1, instr(${requestId}, ':') - 1)
          AND NOT EXISTS (SELECT 1 FROM json_each(${evidencePlansSql}) AS any_plan,
            json_each(any_plan.value, '$.requests') AS root WHERE json_extract(root.value, '$.id') = ${requestId}))
      ))))`;
}

export function reconciliationSourceRequestsStatement(
  database: CatalogueStore,
  preparationId: string,
  sequence = -1,
  requestId = "",
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT request_id, sequence_number, method, url,
                request_headers_json, representation_fingerprint,
                request_role,
                discovered_from_request_id, state, source_snapshot_id,
                failure_code
         FROM source_requests
         WHERE ingestion_run_id = (SELECT ingestion_run_id FROM reconciliation_operations WHERE id = ?) AND (sequence_number, request_id) > (?, ?)
           AND ${requestInPreparationGame("source_requests.request_id")}
         ORDER BY sequence_number, request_id LIMIT 1`)
    .bind(preparationId, sequence, requestId);
}

export function reconciliationSourceRequestStatement(
  database: CatalogueStore,
  preparationId: string,
  requestId: string,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT request_id, sequence_number, method, url,
                request_headers_json, representation_fingerprint,
                request_role,
                discovered_from_request_id, state, source_snapshot_id,
                failure_code
         FROM source_requests
         WHERE ingestion_run_id = (SELECT ingestion_run_id FROM reconciliation_operations WHERE id = ?) AND request_id = ?`)
    .bind(preparationId, requestId);
}

export function reconciliationObservationSetsStatement(
  database: CatalogueStore,
  preparationId: string,
  afterId: string,
  snapshotId: string | null = null,
): D1PreparedStatement {
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
         WHERE snapshots.ingestion_run_id = (SELECT ingestion_run_id FROM reconciliation_operations WHERE id = ?)
           AND observations.id > ? AND (? IS NULL OR observations.source_snapshot_id = ?)
           AND parse.intent = 'collection'
           AND ((SELECT supported_game FROM reconciliation_operations WHERE id = ?1) IS NULL
             OR observations.supported_game = (SELECT supported_game FROM reconciliation_operations WHERE id = ?1))
           AND observations.rowid <= (SELECT observation_cutoff FROM reconciliation_operations WHERE id = ?)
         ORDER BY observations.id LIMIT 1`)
    .bind(preparationId, afterId, snapshotId, snapshotId, preparationId);
}

export function reconciliationSnapshotEvidenceStatement(
  database: CatalogueStore,
  preparationId: string,
  sourceUrl: string,
  sourceLineage: string,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT
          snapshot.request_url,
          snapshot.media_type,
          snapshot.content_digest,
          snapshot.content_byte_length,
          snapshot.content_object_key,
          selection.content AS selection_content,
          selection.sha256 AS selection_sha256
         FROM source_snapshots AS snapshot
         JOIN reconciliation_evidence_selection AS selection
           ON selection.preparation_id = ?1
          AND selection.request_id = snapshot.request_id
         WHERE snapshot.ingestion_run_id = (SELECT ingestion_run_id FROM reconciliation_operations WHERE id = ?1)
           AND snapshot.request_url = ?2 AND snapshot.source_lineage = ?3
           AND json_extract(selection.content, '$.request.source_snapshot_id') = snapshot.id
           AND json_extract(selection.content, '$.request.request_role') = 'image'
           AND json_extract(selection.content, '$.request.state') = 'observed'
         ORDER BY snapshot.rowid DESC LIMIT 1`)
    .bind(preparationId, sourceUrl, sourceLineage);
}

export function reconciliationCollectionPlansStatement(
  database: CatalogueStore,
  preparationId: string,
  afterLineage = "",
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT source_lineage, discovery_observation_set_id, contract,
                content_digest
         FROM official_source_collection_plans
         WHERE ingestion_run_id = (SELECT ingestion_run_id FROM reconciliation_operations WHERE id = ?) AND source_lineage > ?
           AND EXISTS (SELECT 1 FROM reconciliation_operations AS operation
             JOIN source_observation_sets AS observation ON observation.id = official_source_collection_plans.discovery_observation_set_id
             WHERE operation.id = ?1 AND (operation.supported_game IS NULL OR observation.supported_game = operation.supported_game))
         ORDER BY source_lineage LIMIT 1`)
    .bind(preparationId, afterLineage);
}

export function reconciliationEvidencePlanStatement(
  database: CatalogueStore,
  preparationId: string,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN operation.supported_game IS NULL THEN plan.request_plan_json
      ELSE (SELECT json_object('plans', json_group_array(json(selected.value)))
        FROM json_each(${evidencePlansSql}) AS selected
        WHERE json_extract(selected.value, '$.supported_game') = operation.supported_game) END AS request_plan_json
      FROM reconciliation_operations AS operation JOIN ingestion_evidence_plans AS plan
        ON plan.ingestion_run_id = operation.ingestion_run_id WHERE operation.id = ?`)
    .bind(preparationId);
}

export function reconciliationOverflowRequestsStatement(
  database: CatalogueStore,
  preparationId: string,
  sequence = -1,
  requestId = "",
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT ingestion_run_id, request_id, sequence_number,
                  parent_request_id, method, url, request_headers_json,
                  representation_fingerprint, request_role
           FROM source_discovery_request_plans
           WHERE ingestion_run_id = (SELECT ingestion_run_id FROM reconciliation_operations WHERE id = ?) AND (sequence_number, request_id) > (?, ?)
             AND ${requestInPreparationGame("source_discovery_request_plans.request_id")}
           ORDER BY sequence_number, request_id LIMIT 1`)
    .bind(preparationId, sequence, requestId);
}

export function reconciliationObservationCountsStatement(
  database: CatalogueStore,
  preparationId: string,
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
         AND snapshots.ingestion_run_id <> (SELECT ingestion_run_id FROM reconciliation_operations WHERE id = ?) AND snapshots.source_lineage = ?
         AND observations.adapter_version = ? AND snapshots.request_id = ?
       ORDER BY prior_revision.published_at DESC, prior_revision.id DESC,
                snapshots.source_lineage, snapshots.request_id LIMIT 1`)
    .bind(preparationId, lineage, adapter, requestId);
}

// A source may verify its already accepted bytes without collecting a different
// designated authority. Only the latest *selected, published* scope counts:
// partial optional captures in a published run were never accepted evidence.
export function unchangedAcceptedSourceStatement(
  database: CatalogueStore,
  preparationId: string,
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
    WHERE snapshots.ingestion_run_id = (SELECT ingestion_run_id FROM reconciliation_operations WHERE id = ?1) AND snapshots.source_lineage = ?2 AND snapshots.adapter_version = ?3 AND requests.request_role <> 'image'
  ) SELECT 1 AS unchanged WHERE EXISTS (SELECT 1 FROM current)
    AND (SELECT COUNT(*) FROM current) = (SELECT COUNT(*) FROM previous)
    AND NOT EXISTS (SELECT 1 FROM current LEFT JOIN previous USING(request_id)
      WHERE previous.content_digest IS NULL OR current.content_digest <> previous.content_digest)`)
    .bind(preparationId, lineage, adapterVersion);
}

export function reconciliationCollectionPlanChunkStatement(
  database: CatalogueStore,
  preparationId: string,
  lineage: string,
  offset: number,
) {
  return repositoryStatements(database)
    .prepare(`SELECT substr(collection_plan_json, ?, 32768) AS content
    FROM official_source_collection_plans WHERE ingestion_run_id = (SELECT ingestion_run_id FROM reconciliation_operations WHERE id = ?) AND source_lineage = ?`)
    .bind(offset, preparationId, lineage);
}
