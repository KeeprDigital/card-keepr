import { atomicRepositoryStatement, type CatalogueStore, repositoryStatements } from "../shared";

export type SourceRequestInsert = Readonly<{
  runId: string;
  requestId: string;
  sequenceNumber: number;
  method: string;
  url: string;
  requestHeadersJson: string;
  representationFingerprint: string;
}>;

export function sourceRequestInsertionStatement(
  database: CatalogueStore,
  input: SourceRequestInsert,
): D1PreparedStatement {
  return atomicRepositoryStatement(database, {
    statement: repositoryStatements(database)
      .prepare(`INSERT INTO source_requests (
      ingestion_run_id, request_id, sequence_number, method, url,
      request_headers_json, representation_fingerprint, state,
      source_snapshot_id, failure_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL)`)
      .bind(
        input.runId,
        input.requestId,
        input.sequenceNumber,
        input.method,
        input.url,
        input.requestHeadersJson,
        input.representationFingerprint,
      ),
    after: [sourceRequestPlanGuardStatement(database, input.runId, JSON.stringify([input.requestId]))],
  });
}

// Check the complete affected set after insertion in the same native batch.
// A malformed final row aborts earlier siblings as well as the primary insert.
export function sourceRequestPlanGuardStatement(
  database: CatalogueStore,
  runId: string,
  requestIdsJson: string,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN EXISTS (
    SELECT 1 FROM source_requests AS request
    WHERE request.ingestion_run_id = ?1
      AND request.request_id IN (SELECT value FROM json_each(?2))
      AND (NOT EXISTS (
  SELECT 1
  FROM ingestion_evidence_plans AS plan,
       json_each(
         CASE
           WHEN json_type(plan.request_plan_json, '$.plans') = 'array'
             THEN json_extract(plan.request_plan_json, '$.plans')
           ELSE json_array(json(plan.request_plan_json))
         END
       ) AS evidence_plan,
       json_each(evidence_plan.value, '$.requests') AS planned
  WHERE plan.ingestion_run_id = request.ingestion_run_id
    AND json_extract(planned.value, '$.id') = request.request_id
    AND CAST(planned.key AS INTEGER) + (
      SELECT COALESCE(
        SUM(json_array_length(json_extract(preceding.value, '$.requests'))),
        0
      )
      FROM json_each(
        CASE
          WHEN json_type(plan.request_plan_json, '$.plans') = 'array'
            THEN json_extract(plan.request_plan_json, '$.plans')
          ELSE json_array(json(plan.request_plan_json))
        END
      ) AS preceding
      WHERE CAST(preceding.key AS INTEGER) <
        CAST(evidence_plan.key AS INTEGER)
    ) = request.sequence_number
    AND json_extract(planned.value, '$.method') = request.method
    AND json_extract(planned.value, '$.url') = request.url
    AND json_extract(planned.value, '$.headers') = request.request_headers_json
    AND json_extract(planned.value, '$.representation_fingerprint') =
      request.representation_fingerprint
)
AND NOT EXISTS (
  SELECT 1
  FROM ingestion_evidence_plans AS plan
  JOIN official_source_collection_plans AS collection
    ON collection.ingestion_run_id = plan.ingestion_run_id,
       json_each(collection.collection_plan_json, '$.requests') AS planned
  WHERE plan.ingestion_run_id = request.ingestion_run_id
    AND json_extract(planned.value, '$.id') = request.request_id
    AND (
      SELECT SUM(json_array_length(json_extract(value, '$.requests')))
      FROM json_each(
        CASE
          WHEN json_type(plan.request_plan_json, '$.plans') = 'array'
            THEN json_extract(plan.request_plan_json, '$.plans')
          ELSE json_array(json(plan.request_plan_json))
        END
      )
    ) + 10000 * (
      SELECT CAST(key AS INTEGER)
      FROM json_each(
        CASE
          WHEN json_type(plan.request_plan_json, '$.plans') = 'array'
            THEN json_extract(plan.request_plan_json, '$.plans')
          ELSE json_array(json(plan.request_plan_json))
        END
      )
      WHERE json_extract(value, '$.source_lineage') =
        collection.source_lineage
    ) + CAST(planned.key AS INTEGER) = request.sequence_number
    AND json_extract(planned.value, '$.method') = request.method
    AND json_extract(planned.value, '$.url') = request.url
    AND json_extract(planned.value, '$.headers') = request.request_headers_json
    AND json_extract(planned.value, '$.representation_fingerprint') =
      request.representation_fingerprint
    AND json_type(planned.value, '$.surface') = 'text'
    AND length(json_extract(planned.value, '$.surface')) > 0
)
AND NOT EXISTS (
  SELECT 1
  FROM source_discovery_request_plans AS planned
  WHERE planned.ingestion_run_id = request.ingestion_run_id
    AND planned.request_id = request.request_id
    AND planned.sequence_number = request.sequence_number
    AND planned.method = request.method
    AND planned.url = request.url
    AND planned.request_headers_json = request.request_headers_json
    AND planned.representation_fingerprint = request.representation_fingerprint
    AND planned.request_role = request.request_role
    AND planned.parent_request_id = request.discovered_from_request_id
))
  ) THEN json_extract('{}', 'source_request_not_in_immutable_plan') ELSE 1 END`)
    .bind(runId, requestIdsJson);
}

export function officialCollectionPlanInsertionStatement(
  database: CatalogueStore,
  input: Readonly<{
    runId: string;
    sourceLineage: string;
    observationSetId: string;
    collectionPlanJson: string;
    contentDigest: string;
    createdAt: string;
  }>,
): D1PreparedStatement {
  return atomicRepositoryStatement(database, {
    statement: repositoryStatements(database)
      .prepare(`INSERT INTO official_source_collection_plans (
    ingestion_run_id, source_lineage, discovery_observation_set_id, contract,
    collection_plan_json, content_digest, created_at
  ) VALUES (?, ?, ?, 'card-keepr-official-source-collection-plan@1', ?, ?, ?)`)
      .bind(
        input.runId,
        input.sourceLineage,
        input.observationSetId,
        input.collectionPlanJson,
        input.contentDigest,
        input.createdAt,
      ),
    after: [
      repositoryStatements(database)
        .prepare(`SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM source_observation_sets AS observation_set
      JOIN source_snapshots AS snapshot ON snapshot.id = observation_set.source_snapshot_id
      WHERE observation_set.id = ? AND snapshot.ingestion_run_id = ? AND snapshot.source_lineage = ?
    ) THEN json_extract('{}', 'official_source_collection_plan_discovery_owner_mismatch') ELSE 1 END`)
        .bind(input.observationSetId, input.runId, input.sourceLineage),
    ],
  });
}

export function evidencePlanInsertionStatement(
  database: CatalogueStore,
  input: Readonly<{
    runId: string;
    sourceLineage: string;
    supportedGame: string;
    gameProfileVersion: string;
    adapterVersion: string;
    requestPlanJson: string;
    planOrigin: string;
  }>,
): D1PreparedStatement {
  return atomicRepositoryStatement(database, {
    statement: repositoryStatements(database)
      .prepare(`INSERT INTO ingestion_evidence_plans (
    ingestion_run_id, source_lineage, supported_game, game_profile_version,
    adapter_version, request_plan_json, plan_origin
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        input.runId,
        input.sourceLineage,
        input.supportedGame,
        input.gameProfileVersion,
        input.adapterVersion,
        input.requestPlanJson,
        input.planOrigin,
      ),
    after: [
      repositoryStatements(database)
        .prepare(`SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM source_adapter_versions WHERE adapter_version = ? AND adapter_origin = ?
    ) THEN json_extract('{}', 'evidence_plan_origin_mismatch') ELSE 1 END`)
        .bind(input.adapterVersion, input.planOrigin),
    ],
  });
}

// Publication owners run this after retaining evidence, within their original
// atomic batch. The bounded record ID set covers every inserted sibling row.
export function retainedSourceEvidenceGuardStatement(
  database: CatalogueStore,
  retainedRecordIdsJson: string,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN EXISTS (
    SELECT 1 FROM retained_source_observation_evidence AS retained
    WHERE retained.retained_record_id IN (SELECT value FROM json_each(?))
      AND (NOT EXISTS (
  SELECT 1 FROM reconciliation_candidates
  WHERE source_observation_id = retained.source_observation_id
    AND source_observation_set_id = retained.retained_record_id
) AND NOT EXISTS (
  SELECT 1 FROM legality_rules
  WHERE source_observation_id = retained.source_observation_id
    AND id = retained.retained_record_id
) AND NOT EXISTS (
  SELECT 1
  FROM revision_products AS product,
       json_each(product.document_json, '$.included') AS evidence
  WHERE product.product_id = retained.retained_record_id
    AND json_extract(evidence.value, '$.type') = 'source_observation'
    AND json_extract(evidence.value, '$.id') = retained.source_observation_id
) AND NOT EXISTS (
  SELECT 1
  FROM reconciled_product_relationships AS relationship,
       json_each(relationship.source_observation_ids_json) AS observation
  WHERE relationship.id = retained.retained_record_id
    AND observation.value = retained.source_observation_id
))
  ) THEN json_extract('{}', 'retained_source_observation_evidence_not_found') ELSE 1 END`)
    .bind(retainedRecordIdsJson);
}
