import {
  catalogueStore,
  runEventCommand,
  runEventIdentitySql,
  runEventStatement,
  runTransitionGuardStatement,
} from "../../../../src/catalogue/shared";
// Dedicated test queries. Tests retain binding, execution, and atomic batch composition.

export function insertIngestionEvidencePlans(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_evidence_plans (
        ingestion_run_id, source_lineage, supported_game,
        game_profile_version, adapter_version, request_plan_json,
        plan_origin
      ) VALUES (?, ?, ?, ?, ?, ?, 'synthetic_fixture')`);
}

export function insertSourceRequests(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_requests (
        ingestion_run_id, request_id, sequence_number, method, url,
        request_headers_json, representation_fingerprint, state,
        source_snapshot_id
      ) VALUES (?, ?, 0, 'GET', ?, '{}', ?, 'observed', ?)`);
}

export function insertSourceFetchAttempts(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_fetch_attempts (
        id, ingestion_run_id, request_id, attempt_number,
        requested_at, completed_at, outcome, http_status,
        response_headers_json, retry_after_ms, diagnostic
      ) VALUES (?, ?, ?, 1, '2026-07-30T00:00:00.000Z',
        '2026-07-30T00:00:01.000Z', 'success', 200, '{}', NULL, NULL)`);
}

export function insertSourceSnapshots(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_snapshots (
        id, ingestion_run_id, request_id, fetch_attempt_id,
        request_method, request_url, request_headers_json,
        representation_fingerprint, response_vary_json, retrieved_at,
        http_status, response_headers_json, media_type, content_digest,
        content_byte_length, content_object_key, source_lineage,
        supported_game, game_profile_version, adapter_version,
        reused_source_snapshot_id
      ) VALUES (?, ?, ?, ?, 'GET', ?, '{}', ?, '[]',
        '2026-07-30T00:00:01.000Z', 200, '{}', 'application/json', ?, 2,
        ?, ?, ?, ?, ?, NULL)`);
}

export function insertSourceParseOperations(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_parse_operations (
        id, source_snapshot_id, adapter_version, intent,
        idempotency_key, observation_set_id, content_object_key,
        parsed_at, state, content_digest, content_byte_length,
        observation_count
      ) VALUES (?, ?, ?, 'collection', ?, ?, ?,
        '2026-07-30T00:00:02.000Z', 'finalized', ?, 2, 1)`);
}

export function insertSourceObservationSets(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_observation_sets (
        id, parse_operation_id, source_snapshot_id, source_lineage,
        supported_game, game_profile_version, adapter_version, parsed_at,
        content_digest, content_byte_length, content_object_key,
        observation_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, '2026-07-30T00:00:02.000Z',
        ?, 2, ?, 1)`);
}

export function insertSourceFreshness(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_freshness (
         game, area, source_lineage, region, checked_at, ingestion_run_id
       ) VALUES
         ('one-piece', 'cards-and-printings', '', '',
          '2026-01-01T01:00:00.000Z', 'run_products'),
         ('one-piece', 'products-and-releases', '', '',
          '2026-01-01T02:00:00.000Z', 'run_products')`);
}

export function setSourceFreshnessCheckedAt(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE source_freshness
     SET checked_at = '2026-01-02T02:00:00.000Z'
     WHERE game = 'one-piece'
       AND area = 'products-and-releases'`);
}

export function readSourceRequestsStateFailureCode(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT state, failure_code, retry_generation FROM source_requests
     WHERE ingestion_run_id = ? AND request_id = 'one-piece-en:discovery'`);
}

export function readIngestionRunRetryPauses(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT * FROM ingestion_run_retry_pauses WHERE ingestion_run_id = ?`);
}

export function readSourceRequestsStateRetryGeneration(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT state, retry_generation FROM source_requests
     WHERE ingestion_run_id = ? AND request_id = 'one-piece-en:discovery'`);
}

export function countIngestionRunRetryPausesCount(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT COUNT(*) AS count FROM ingestion_run_retry_pauses
     WHERE ingestion_run_id = ?`);
}

export function insertSourceCaptureOperations(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_capture_operations (
      attempt_id, ingestion_run_id, request_id, attempt_number,
      source_snapshot_id, content_object_key, state, requested_at,
      completed_at, request_headers_json, http_status,
      response_headers_json, response_vary_json, media_type
    ) VALUES (
      ?, ?, 'one-piece-en:discovery', 1, ?, ?, 'response_received', ?,
      ?, '{}', 200, '{"content-type":"application/json"}', '[]',
      'application/json'
    )`);
}

export function readSourceRequestsRequestIdState(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT request_id, state, retry_generation FROM source_requests
     WHERE ingestion_run_id = ? ORDER BY request_id`);
}

export function insertIngestionEvidencePlansForAuthenticatedReparseRejectsNormalizedFixtureEnvelopeThroughUnavailableProduction(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_evidence_plans (
         ingestion_run_id, source_lineage, supported_game,
         game_profile_version, adapter_version, request_plan_json,
         plan_origin
       ) VALUES (?, 'one-piece-en', 'one-piece', 'one-piece@1',
         'fixture-one-piece-json@3', ?, 'synthetic_fixture')`);
}

export function insertSourceRequestsForAuthenticatedReparseRejectsNormalizedFixtureEnvelopeThroughUnavailableProduction(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_requests (
         ingestion_run_id, request_id, sequence_number, method, url,
         request_headers_json, representation_fingerprint, state,
         source_snapshot_id
       ) VALUES (?, 'raw-boundary', 0, 'GET',
         'https://official-source.invalid/normalized-envelope', '{}', ?,
         'observed', ?)`);
}

export function insertSourceFetchAttemptsForAuthenticatedReparseRejectsNormalizedFixtureEnvelopeThroughUnavailableProduction(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_fetch_attempts (
         id, ingestion_run_id, request_id, attempt_number,
         requested_at, completed_at, outcome, http_status,
         response_headers_json, retry_after_ms, diagnostic
       ) VALUES ('srcfetch_unavailable_adapter_raw_boundary', ?,
         'raw-boundary', 1, '2026-08-01T00:00:00.000Z',
         '2026-08-01T00:00:01.000Z', 'success', 200, '{}', NULL, NULL)`);
}

export function insertSourceSnapshotsForAuthenticatedReparseRejectsNormalizedFixtureEnvelopeThroughUnavailableProduction(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_snapshots (
         id, ingestion_run_id, request_id, fetch_attempt_id,
         request_method, request_url, request_headers_json,
         representation_fingerprint, response_vary_json, retrieved_at,
         http_status, response_headers_json, media_type, content_digest,
         content_byte_length, content_object_key, source_lineage,
         supported_game, game_profile_version, adapter_version,
         reused_source_snapshot_id
       ) VALUES (?, ?, 'raw-boundary',
         'srcfetch_unavailable_adapter_raw_boundary', 'GET',
         'https://official-source.invalid/normalized-envelope', '{}', ?, '[]',
         '2026-08-01T00:00:01.000Z', 200, '{}', 'application/json', ?, ?, ?,
         'one-piece-en', 'one-piece', 'one-piece@1',
         'fixture-one-piece-json@3', NULL)`);
}

export function countSourceParseOperationsCount(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT COUNT(*) AS count FROM source_parse_operations
     WHERE source_snapshot_id = ?`);
}

export function countSourceDiscoveryRequestPlansCount(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT COUNT(*) AS count FROM source_discovery_request_plans
     WHERE ingestion_run_id = ?`);
}

export function insertSourceFetchAttemptsForRetainCapturedDiscoveryRoot(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_fetch_attempts (
         id, ingestion_run_id, request_id, attempt_number,
         requested_at, completed_at, outcome, http_status,
         response_headers_json, retry_after_ms, diagnostic
       ) VALUES (?, ?, ?, 1, '2026-08-07T00:00:00.000Z',
         '2026-08-07T00:00:01.000Z', 'success', 200, '{}', NULL, NULL)`);
}

export function insertSourceSnapshotsForRetainCapturedDiscoveryRoot(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_snapshots (
         id, ingestion_run_id, request_id, fetch_attempt_id,
         request_method, request_url, request_headers_json,
         representation_fingerprint, response_vary_json, retrieved_at,
         http_status, response_headers_json, media_type, content_digest,
         content_byte_length, content_object_key, source_lineage,
         supported_game, game_profile_version, adapter_version,
         reused_source_snapshot_id
       ) VALUES (?, ?, ?, ?, 'GET', ?, ?, ?, '[]',
         '2026-08-07T00:00:01.000Z', 200, '{}', 'text/html', ?, ?, ?,
         'fusion-world-en', 'fusion-world', 'fusion-world@1',
         'fusion-world-en@9', NULL)`);
}

export function setSourceRequestsStateSourceSnapshotId(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE source_requests SET state = 'captured', source_snapshot_id = ?
       WHERE ingestion_run_id = ? AND request_id = ? AND state = 'pending'`);
}

export function inspectFiller(database: D1Database): D1PreparedStatement {
  return database.prepare(`WITH RECURSIVE filler(n) AS (
         SELECT 1 UNION ALL SELECT n + 1 FROM filler WHERE n < ?2
       )
       INSERT INTO source_discovery_request_plans (
         ingestion_run_id, request_id, sequence_number, parent_request_id,
         method, url, request_headers_json, representation_fingerprint,
         request_role
       )
       SELECT ?1, 'fusion-world-en:detail:' || printf('%08d', n), 1000 + n,
              ?3, 'GET',
              'https://www.dbs-cardgame.com/fw/en/cardlist/detail/' || n,
              '{}', printf('%064x', n), 'detail'
       FROM filler`);
}

export function insertSourceRequestsForFillLineageToCapacity(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_requests (
         ingestion_run_id, request_id, sequence_number, method, url,
         request_headers_json, representation_fingerprint, state,
         source_snapshot_id, failure_code, request_role,
         discovered_from_request_id
       )
       SELECT ingestion_run_id, request_id, sequence_number, method, url,
              request_headers_json, representation_fingerprint, ?2,
              NULL, NULL, request_role, parent_request_id
       FROM source_discovery_request_plans
       WHERE ingestion_run_id = ?1
         AND request_id LIKE 'fusion-world-en:detail:%'`);
}

export function readIngestionEvidencePlansChildWorkflowIdsJson(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT child_workflow_ids_json FROM ingestion_evidence_plans
     WHERE ingestion_run_id = ?`);
}

export function readIngestionRunCapacityPausesOverflowRequestCountRequiredCapacity(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT overflow_request_count, required_capacity
     FROM ingestion_run_capacity_pauses WHERE ingestion_run_id = ?`);
}

export function readSourceRequestsState(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT state FROM source_requests
         WHERE ingestion_run_id = ? AND request_id = ?`);
}

export function countSourceRequestsCount(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT COUNT(*) AS count FROM source_requests
       WHERE ingestion_run_id = ?`);
}

export function countSourceFetchAttemptsCount(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT COUNT(*) AS count FROM source_fetch_attempts
       WHERE ingestion_run_id = ?`);
}

export function readSourceRequestsStateSourceSnapshotId(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT state, source_snapshot_id FROM source_requests
       WHERE ingestion_run_id = ? AND request_id = ?`);
}

export function countSourceObservationSetsCount(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT COUNT(*) AS count FROM source_observation_sets
       WHERE source_snapshot_id = ?`);
}

export function countIngestionRunCapacityPausesCount(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT COUNT(*) AS count FROM ingestion_run_capacity_pauses
       WHERE ingestion_run_id = ?`);
}

export function readIngestionRunCapacityExtensionsCapacityGeneration(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT capacity_generation FROM ingestion_run_capacity_extensions
       WHERE ingestion_run_id = ?`);
}

export function readSourceRequestsRequestIdFailureCode(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT request_id, failure_code FROM source_requests
       WHERE ingestion_run_id = ? AND failure_code IS NOT NULL
       ORDER BY sequence_number`);
}

export function createFailInitialObservationSetInsert(database: D1Database): D1PreparedStatement {
  return database.prepare(`CREATE TRIGGER fail_initial_observation_set_insert
     BEFORE INSERT ON source_observation_sets
     BEGIN
       SELECT RAISE(FAIL, 'synthetic_initial_parse_d1_outage');
     END`);
}

export function setIngestionEvidencePlansChildWorkflowIdsJson(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE ingestion_evidence_plans SET child_workflow_ids_json = ?
     WHERE ingestion_run_id = ?`);
}

export function setIngestionEvidencePlansParentWorkflowId(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE ingestion_evidence_plans SET parent_workflow_id = ?
     WHERE ingestion_run_id = ?`);
}

export function readSourceRequestsStateForHostnameWorkflowThatWakesTerminatedRunFinishesWithoutReloading(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT state FROM source_requests WHERE ingestion_run_id = ?`);
}

export function setSourceRequestsState(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE source_requests SET state = 'observed'
     WHERE ingestion_run_id = ? AND sequence_number BETWEEN 1 AND 199`);
}

export function readSourceSnapshotsId(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT snapshot.id
     FROM source_snapshots AS snapshot
     WHERE snapshot.ingestion_run_id = ?
       AND snapshot.request_id = 'fusion-world-en:products'`);
}

export function countIngestionEvidencePlansCount(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT COUNT(*) AS count
     FROM ingestion_evidence_plans AS plan
     JOIN ingestion_run_read AS run ON run.id = plan.ingestion_run_id
     WHERE run.idempotency_key = 'production-route-fixture-bypass'`);
}

export function readSourceObservationSetsContentObjectKey(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT observations.content_object_key
     FROM source_observation_sets AS observations
     JOIN source_snapshots AS snapshots
       ON snapshots.id = observations.source_snapshot_id
     WHERE snapshots.ingestion_run_id = ?
     ORDER BY snapshots.request_id`);
}

export function dropSourceObservationSetsAreImmutableOnUpdate(database: D1Database): D1PreparedStatement {
  return database.prepare(`DROP TRIGGER source_observation_sets_are_immutable_on_update`);
}

export function setSourceObservationSetsContentByteLength(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE source_observation_sets
     SET content_byte_length = ?
     WHERE source_snapshot_id IN (
       SELECT id FROM source_snapshots WHERE ingestion_run_id = ?
     )`);
}

export function createSourceObservationSetsAreImmutableOnUpdate(database: D1Database): D1PreparedStatement {
  return database.prepare(`CREATE TRIGGER source_observation_sets_are_immutable_on_update
     BEFORE UPDATE ON source_observation_sets
     BEGIN
       SELECT RAISE(ABORT, 'immutable_source_observation_set');
     END`);
}

export function insertSourceRequestsForUnplannedRequestsFailAtD1WhileDuplicateUnplannedObservation(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_requests (
         ingestion_run_id, request_id, sequence_number, method, url,
         request_headers_json, representation_fingerprint, state
       ) VALUES (?, 'partition-missing', 1, 'GET',
         'https://official-source.invalid/reconciliation/new-locator',
         '{}', 'missing', 'pending')`);
}

export function insertSourceParseOperationsForUnplannedRequestsFailAtD1WhileDuplicateUnplannedObservation(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_parse_operations (
       id, source_snapshot_id, adapter_version, intent, idempotency_key,
       observation_set_id, content_object_key, parsed_at, state,
       content_digest, content_byte_length, observation_count
     )
     SELECT ?, source_snapshot_id, adapter_version, 'collection', ?,
            ?, ?, parsed_at, 'finalized',
            content_digest, content_byte_length, observation_count
     FROM source_parse_operations
     WHERE source_snapshot_id = (
       SELECT source_snapshot_id FROM source_requests
       WHERE ingestion_run_id = ? AND request_id = 'one-piece-en:discovery'
     ) AND intent = 'collection'`);
}

export function insertSourceObservationSetsForUnplannedRequestsFailAtD1WhileDuplicateUnplannedObservation(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_observation_sets (
       id, parse_operation_id, source_snapshot_id, source_lineage,
       supported_game, game_profile_version, adapter_version, parsed_at,
       content_digest, content_byte_length, content_object_key,
       observation_count
     )
     SELECT ?, ?, source_snapshot_id, source_lineage, supported_game,
            game_profile_version, adapter_version, parsed_at,
            content_digest, content_byte_length, ?, observation_count
     FROM source_observation_sets
     WHERE source_snapshot_id = (
       SELECT source_snapshot_id FROM source_requests
       WHERE ingestion_run_id = ? AND request_id = 'one-piece-en:discovery'
     ) ORDER BY id LIMIT 1`);
}

export function insertSourceFetchAttemptsForUnplannedRequestsFailAtD1WhileDuplicateUnplannedObservation(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_fetch_attempts (
       id, ingestion_run_id, request_id, attempt_number, requested_at,
       completed_at, outcome, http_status, response_headers_json,
       retry_after_ms, diagnostic
     )
     SELECT ?, ingestion_run_id, request_id, 99, requested_at,
            completed_at, outcome, http_status, response_headers_json,
            retry_after_ms, diagnostic
     FROM source_fetch_attempts
     WHERE ingestion_run_id = ? ORDER BY attempt_number LIMIT 1`);
}

export function insertSourceSnapshotsForUnplannedRequestsFailAtD1WhileDuplicateUnplannedObservation(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_snapshots (
       id, ingestion_run_id, request_id, fetch_attempt_id, request_method,
       request_url, request_headers_json, representation_fingerprint,
       response_vary_json, retrieved_at, http_status, response_headers_json,
       media_type, content_digest, content_byte_length, content_object_key,
       source_lineage, supported_game, game_profile_version, adapter_version,
       reused_source_snapshot_id
     )
     SELECT ?, ingestion_run_id, request_id, ?, request_method,
            request_url, request_headers_json, representation_fingerprint,
            response_vary_json, retrieved_at, http_status,
            response_headers_json, media_type, content_digest,
            content_byte_length, content_object_key, source_lineage,
            supported_game, game_profile_version, adapter_version, NULL
     FROM source_snapshots
     WHERE id = (
       SELECT source_snapshot_id FROM source_requests
       WHERE ingestion_run_id = ? AND request_id = 'one-piece-en:discovery'
     )`);
}

export function insertSourceParseOperationsForUnplannedRequestsFailAtD1WhileDuplicateUnplannedObservationWithCollection(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_parse_operations (
       id, source_snapshot_id, adapter_version, intent, idempotency_key,
       observation_set_id, content_object_key, parsed_at, state,
       content_digest, content_byte_length, observation_count
     )
     SELECT ?, ?, adapter_version, 'collection', ?, ?, ?, parsed_at,
            'finalized', content_digest, content_byte_length,
            observation_count
     FROM source_parse_operations
     WHERE source_snapshot_id = (
       SELECT source_snapshot_id FROM source_requests
       WHERE ingestion_run_id = ? AND request_id = 'one-piece-en:discovery'
     ) AND intent = 'collection'`);
}

export function insertSourceObservationSetsForUnplannedRequestsFailAtD1WhileDuplicateUnplannedObservationWithPartitionA(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_observation_sets (
       id, parse_operation_id, source_snapshot_id, source_lineage,
       supported_game, game_profile_version, adapter_version, parsed_at,
       content_digest, content_byte_length, content_object_key,
       observation_count
     )
     SELECT ?, ?, ?, source_lineage, supported_game, game_profile_version,
            adapter_version, parsed_at, content_digest, content_byte_length,
            ?, observation_count
     FROM source_observation_sets
     WHERE source_snapshot_id = (
       SELECT source_snapshot_id FROM source_requests
       WHERE ingestion_run_id = ? AND request_id = 'one-piece-en:discovery'
     ) ORDER BY id LIMIT 1`);
}

export function readSourceAdapterVersionsAdapterVersionSourceLineage(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT adapter_version, source_lineage, supported_game,
            game_profile_version, parser_contract, adapter_origin,
            request_capacity
     FROM source_adapter_versions ORDER BY adapter_version`);
}

export function readSourceRequestsRequestIdStateForRuntimeCaptureFailures(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT request_id, state, failure_code
           FROM source_requests
           WHERE ingestion_run_id = ? AND failure_code IS NOT NULL
           ORDER BY sequence_number`);
}

export function readSourceRequestsRequestIdFailureCodeForRuntimeCaptureFailures(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT request_id, failure_code FROM source_requests
         WHERE ingestion_run_id = ? AND state = 'failed'
         ORDER BY sequence_number`);
}

export function setSourceRequestsStateForProductionDiscoveryThatProvesNoCollectionSurfaceFailsLast(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE source_requests SET state = 'observed'
     WHERE ingestion_run_id = ? AND request_id != ?`);
}

export function readSourceRequestsRequestIdStateForProductionDiscoveryThatProvesNoCollectionSurfaceFailsLast(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT request_id, state, failure_code FROM source_requests
     WHERE ingestion_run_id = ? AND failure_code IS NOT NULL`);
}

export function insertSourceParseOperationsForOfficialSourceCollectionPlanBeyondAdapterCapacityRejectedWithout(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_parse_operations (
         id, source_snapshot_id, adapter_version, intent, idempotency_key,
         observation_set_id, content_object_key, parsed_at, state,
         content_digest, content_byte_length, observation_count
       ) VALUES (?, ?, 'fusion-world-en@9', 'collection', ?, ?, ?,
         '2026-08-07T00:00:02.000Z', 'finalized', 'digest', 2, 1)`);
}

export function insertSourceObservationSetsForOfficialSourceCollectionPlanBeyondAdapterCapacityRejectedWithout(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_observation_sets (
         id, parse_operation_id, source_snapshot_id, source_lineage,
         supported_game, game_profile_version, adapter_version, parsed_at,
         content_digest, content_byte_length, content_object_key,
         observation_count
       ) VALUES (?, ?, ?, 'fusion-world-en', 'fusion-world',
         'fusion-world@1', 'fusion-world-en@9', '2026-08-07T00:00:02.000Z',
         'digest', 2, ?, 1)`);
}

export function inspectFillerForOfficialSourceCollectionPlanBeyondAdapterCapacityRejectedWithout(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`WITH RECURSIVE filler(n) AS (
         SELECT 1 UNION ALL SELECT n + 1 FROM filler WHERE n < 14999
       )
       INSERT INTO source_discovery_request_plans (
         ingestion_run_id, request_id, sequence_number, parent_request_id,
         method, url, request_headers_json, representation_fingerprint,
         request_role
       )
       SELECT ?1, 'fusion-world-en:detail:' || printf('%08d', n), 1000 + n,
              ?2, 'GET',
              'https://www.dbs-cardgame.com/fw/en/cardlist/detail/' || n,
              '{}', printf('%064x', n), 'detail'
       FROM filler`);
}

export function insertSourceRequestsForOfficialSourceCollectionPlanBeyondAdapterCapacityRejectedWithout(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_requests (
         ingestion_run_id, request_id, sequence_number, method, url,
         request_headers_json, representation_fingerprint, state,
         source_snapshot_id, failure_code, request_role,
         discovered_from_request_id
       )
       SELECT ingestion_run_id, request_id, sequence_number, method, url,
              request_headers_json, representation_fingerprint, 'pending',
              NULL, NULL, request_role, parent_request_id
       FROM source_discovery_request_plans
       WHERE ingestion_run_id = ?1
         AND request_id LIKE 'fusion-world-en:detail:%'`);
}

export function countSourceRequestsCountForOfficialSourceCollectionPlanBeyondAdapterCapacityRejectedWithout(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT COUNT(*) AS count FROM source_requests
     WHERE ingestion_run_id = ? AND request_id = 'fusion-world-en:cards'`);
}

export function countSourceFetchAttemptsCountForExtendedProductionShapedRunResumesIntoBoundedHostShards(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT COUNT(*) AS count FROM source_fetch_attempts
       WHERE ingestion_run_id = ? AND request_id = ?`);
}

export function insertSourceRequestsForAppliedD1RequestCopiesOwningRunIdentitiesAreImmutable(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_requests (
         ingestion_run_id, request_id, sequence_number, method, url,
         request_headers_json, representation_fingerprint, state
       ) VALUES (?, 'update-target', 0, 'GET',
         'https://en.onepiece-cardgame.com/cardlist/',
         '{"accept":"text/html"}', ?, 'pending')`);
}

export function insertSourceRequestsForAppliedD1RequestCopiesOwningRunIdentitiesAreImmutableWithPending(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_requests (
         ingestion_run_id, request_id, sequence_number, method, url,
         request_headers_json, representation_fingerprint, state
       ) VALUES (?, 'delete-target', 1, 'GET',
         'https://en.onepiece-cardgame.com/rules/',
         '{"accept":"text/html"}', ?, 'pending')`);
}

export function setSourceRequestsUrlRequestHeadersJson(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE source_requests
       SET url = 'https://attacker.example/changed',
           request_headers_json = '{"accept":"application/json"}',
           representation_fingerprint = ?
       WHERE ingestion_run_id = ? AND request_id = 'update-target'`);
}

export function deleteSourceRequests(database: D1Database): D1PreparedStatement {
  return database.prepare(`DELETE FROM source_requests
       WHERE ingestion_run_id = ? AND request_id = 'delete-target'`);
}

export function insertSourceRequestWithMismatchedPlanFields(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_requests (
         ingestion_run_id, request_id, sequence_number, method, url,
         request_headers_json, representation_fingerprint, state
       ) VALUES (?, 'insert-target', 2, 'GET',
         'https://attacker.example/wrong-plan-fields',
         '{"accept":"application/json"}', ?, 'pending')`);
}

export function insertUnplannedSourceRequest(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_requests (
         ingestion_run_id, request_id, sequence_number, method, url,
         request_headers_json, representation_fingerprint, state
       ) VALUES (?, 'unplanned', 3, 'GET',
         'https://attacker.example/unplanned', '{}', ?, 'pending')`);
}

export function setSourceRequestsIngestionRunId(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE source_requests SET ingestion_run_id = ?
       WHERE ingestion_run_id = ? AND request_id = 'update-target'`);
}

export function setIngestionEvidencePlansIngestionRunId(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE ingestion_evidence_plans SET ingestion_run_id = ?
       WHERE ingestion_run_id = ?`);
}

export function insertSourceRequestsForOfficialSourceCollectionPlanCannotFreezeAnotherRunS(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_requests (
         ingestion_run_id, request_id, sequence_number, method, url,
         request_headers_json, representation_fingerprint, state
       ) VALUES (?, 'discovery', 0, 'GET',
         'https://en.onepiece-cardgame.com/cardlist/', '{}', ?, 'observed')`);
}

export function insertSourceFetchAttemptsForOfficialSourceCollectionPlanCannotFreezeAnotherRunS(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_fetch_attempts (
         id, ingestion_run_id, request_id, attempt_number,
         requested_at, completed_at, outcome, http_status,
         response_headers_json, retry_after_ms, diagnostic
       ) VALUES ('srcfetch_collection_owner', ?, 'discovery', 1,
         '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:01.000Z',
         'success', 200, '{}', NULL, NULL)`);
}

export function insertSourceSnapshotsForOfficialSourceCollectionPlanCannotFreezeAnotherRunS(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_snapshots (
         id, ingestion_run_id, request_id, fetch_attempt_id,
         request_method, request_url, request_headers_json,
         representation_fingerprint, response_vary_json, retrieved_at,
         http_status, response_headers_json, media_type, content_digest,
         content_byte_length, content_object_key, source_lineage,
         supported_game, game_profile_version, adapter_version,
         reused_source_snapshot_id
       ) VALUES ('srcsnap_collection_owner', ?, 'discovery',
         'srcfetch_collection_owner', 'GET',
         'https://en.onepiece-cardgame.com/cardlist/', '{}', ?, '[]',
         '2026-08-01T00:00:01.000Z', 200, '{}', 'application/json', ?,
         2, 'source-snapshots/collection-owner.bin', 'one-piece-en',
         'one-piece', 'one-piece@1', 'fixture-one-piece-json@3', NULL)`);
}

export function insertSourceParseOperationsForOfficialSourceCollectionPlanCannotFreezeAnotherRunS(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_parse_operations (
         id, source_snapshot_id, adapter_version, intent,
         idempotency_key, observation_set_id, content_object_key,
         parsed_at, state, content_digest, content_byte_length,
         observation_count
       ) VALUES ('srcparse_collection_owner', 'srcsnap_collection_owner',
         'fixture-one-piece-json@3', 'collection',
         'collection-owner-parse', 'srcobsset_collection_owner',
         'source-observations/collection-owner.json',
         '2026-08-01T00:00:02.000Z', 'finalized', ?, 2, 1)`);
}

export function insertSourceObservationSetsForOfficialSourceCollectionPlanCannotFreezeAnotherRunS(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_observation_sets (
         id, parse_operation_id, source_snapshot_id, source_lineage,
         supported_game, game_profile_version, adapter_version, parsed_at,
         content_digest, content_byte_length, content_object_key,
         observation_count
       ) VALUES ('srcobsset_collection_owner',
         'srcparse_collection_owner', 'srcsnap_collection_owner',
         'one-piece-en', 'one-piece', 'one-piece@1',
         'fixture-one-piece-json@3', '2026-08-01T00:00:02.000Z', ?, 2,
         'source-observations/collection-owner.json', 1)`);
}

export function insertOfficialSourceCollectionPlans(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO official_source_collection_plans (
         ingestion_run_id, source_lineage,
         discovery_observation_set_id, contract,
         collection_plan_json, content_digest, created_at
       ) VALUES (?, 'one-piece-en', 'srcobsset_collection_owner',
         'card-keepr-official-source-collection-plan@1', ?, ?,
         '2026-08-01T00:00:03.000Z')`);
}

export function insertOfficialSourceCollectionPlansForFreshD1EnforcesFullLowercaseDigestsCanonicalRevisionRule(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO official_source_collection_plans (
        ingestion_run_id, source_lineage,
        discovery_observation_set_id, contract,
        collection_plan_json, content_digest, created_at
      ) VALUES ('run_missing', 'missing-lineage', 'srcobsset_missing',
        'card-keepr-official-source-collection-plan@1', '{}', ?,
        '2026-08-01T00:00:00.000Z')`);
}

export function insertIngestionEvidencePlansForFreshD1EnforcesFullLowercaseDigestsCanonicalRevisionRule(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_evidence_plans (
         ingestion_run_id, source_lineage, supported_game,
         game_profile_version, adapter_version, request_plan_json,
         plan_origin
       ) VALUES ('run_upgraded_legality_guard', 'one-piece-en',
         'one-piece', 'one-piece@1', 'fixture-one-piece-json@3', ?,
         'synthetic_fixture')`);
}

export function insertSourceRequestsForFreshD1EnforcesFullLowercaseDigestsCanonicalRevisionRule(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_requests (
         ingestion_run_id, request_id, sequence_number, method, url,
         request_headers_json, representation_fingerprint, state,
         source_snapshot_id
       ) VALUES ('run_upgraded_legality_guard', 'upgraded-legality', 0,
         'GET', 'https://en.onepiece-cardgame.com/rules/restriction/',
         '{}', ?, 'observed', 'srcsnap_upgraded_legality_guard')`);
}

export function insertSourceFetchAttemptsForFreshD1EnforcesFullLowercaseDigestsCanonicalRevisionRule(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_fetch_attempts (
         id, ingestion_run_id, request_id, attempt_number,
         requested_at, completed_at, outcome, http_status,
         response_headers_json, retry_after_ms, diagnostic
       ) VALUES ('srcfetch_upgraded_legality_guard',
         'run_upgraded_legality_guard', 'upgraded-legality', 1,
         '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:01.000Z',
         'success', 200, '{}', NULL, NULL)`);
}

export function insertSourceSnapshotsForFreshD1EnforcesFullLowercaseDigestsCanonicalRevisionRule(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_snapshots (
         id, ingestion_run_id, request_id, fetch_attempt_id,
         request_method, request_url, request_headers_json,
         representation_fingerprint, response_vary_json, retrieved_at,
         http_status, response_headers_json, media_type, content_digest,
         content_byte_length, content_object_key, source_lineage,
         supported_game, game_profile_version, adapter_version,
         reused_source_snapshot_id
       ) VALUES ('srcsnap_upgraded_legality_guard',
         'run_upgraded_legality_guard', 'upgraded-legality',
         'srcfetch_upgraded_legality_guard', 'GET',
         'https://en.onepiece-cardgame.com/rules/restriction/', '{}', ?,
         '[]', '2026-08-01T00:00:01.000Z', 200, '{}',
         'application/json', ?, 2,
         'source-snapshots/upgraded-legality-guard.bin', 'one-piece-en',
         'one-piece', 'one-piece@1', 'fixture-one-piece-json@3', NULL)`);
}

export function insertSourceParseOperationsForFreshD1EnforcesFullLowercaseDigestsCanonicalRevisionRule(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_parse_operations (
         id, source_snapshot_id, adapter_version, intent,
         idempotency_key, observation_set_id, content_object_key,
         parsed_at, state, content_digest, content_byte_length,
         observation_count
       ) VALUES ('srcparse_upgraded_legality_guard',
         'srcsnap_upgraded_legality_guard', 'fixture-one-piece-json@3',
         'collection', 'upgraded-legality-guard-parse',
         'srcobsset_upgraded_legality_guard',
         'source-observations/upgraded-legality-guard.json',
         '2026-08-01T00:00:02.000Z', 'finalized', ?, 2, 1)`);
}

export function insertSourceObservationSetsForFreshD1EnforcesFullLowercaseDigestsCanonicalRevisionRule(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_observation_sets (
         id, parse_operation_id, source_snapshot_id, source_lineage,
         supported_game, game_profile_version, adapter_version, parsed_at,
         content_digest, content_byte_length, content_object_key,
         observation_count
       ) VALUES ('srcobsset_upgraded_legality_guard',
         'srcparse_upgraded_legality_guard',
         'srcsnap_upgraded_legality_guard', 'one-piece-en', 'one-piece',
         'one-piece@1', 'fixture-one-piece-json@3',
         '2026-08-01T00:00:02.000Z', ?, 2,
         'source-observations/upgraded-legality-guard.json', 1)`);
}

export function countSourceSnapshotsCount(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT request_id, COUNT(*) AS count
     FROM source_snapshots WHERE ingestion_run_id = ?
     GROUP BY request_id HAVING COUNT(*) > 1`);
}

export function readSourceDiscoveryRequestPlansParentRequestIdUrl(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT parent_request_id, url, request_role
     FROM source_discovery_request_plans
     WHERE ingestion_run_id = ?
     ORDER BY sequence_number`);
}

export function insertIngestionEvidencePlansForAuthenticatedParsingRetainsStagedLiveFusionPolicyRootDetail(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_evidence_plans (
         ingestion_run_id, source_lineage, supported_game,
         game_profile_version, adapter_version, request_plan_json,
         plan_origin
       ) VALUES (?, 'fusion-world-en', 'fusion-world', 'fusion-world@1',
         'fusion-world-en@9', ?, 'production')`);
}

export function insertSourceRequestsForAuthenticatedParsingRetainsStagedLiveFusionPolicyRootDetail(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_requests (
           ingestion_run_id, request_id, sequence_number, method, url,
           request_headers_json, representation_fingerprint, state,
           source_snapshot_id
         ) VALUES (?, ?, ?, 'GET', ?, ?, ?, 'observed', ?)`);
}

export function insertSourceFetchAttemptsForAuthenticatedParsingRetainsStagedLiveFusionPolicyRootDetail(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_fetch_attempts (
           id, ingestion_run_id, request_id, attempt_number,
           requested_at, completed_at, outcome, http_status,
           response_headers_json, retry_after_ms, diagnostic
         ) VALUES (?, ?, ?, 1, '2026-08-03T00:00:00.000Z',
           '2026-08-03T00:00:01.000Z', 'success', 200, '{}', NULL, NULL)`);
}

export function insertSourceSnapshotsForAuthenticatedParsingRetainsStagedLiveFusionPolicyRootDetail(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_snapshots (
           id, ingestion_run_id, request_id, fetch_attempt_id,
           request_method, request_url, request_headers_json,
           representation_fingerprint, response_vary_json, retrieved_at,
           http_status, response_headers_json, media_type, content_digest,
           content_byte_length, content_object_key, source_lineage,
           supported_game, game_profile_version, adapter_version,
           reused_source_snapshot_id
         ) VALUES (?, ?, ?, ?, 'GET', ?, ?, ?, '[]',
           '2026-08-03T00:00:01.000Z', 200, '{}', ?, ?, ?, ?,
           'fusion-world-en', 'fusion-world', 'fusion-world@1',
           'fusion-world-en@9', NULL)`);
}

export function readSourceObservationSetsSourceSnapshotIdObservationCount(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT source_snapshot_id, observation_count, content_object_key
     FROM source_observation_sets
     WHERE source_snapshot_id IN (?, ?)
     ORDER BY source_snapshot_id`);
}

export function readSourceObservationSetsContentObjectKeyForOfficialErratumPreservesObservedPrintedRulesTextWhilePublishing(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT observation.content_object_key
       FROM source_observation_sets AS observation
       JOIN source_snapshots AS snapshot
         ON snapshot.id = observation.source_snapshot_id
       WHERE snapshot.ingestion_run_id = ?`);
}

export function readSourceFreshnessAreaIngestionRunId(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT area, ingestion_run_id
       FROM source_freshness
       WHERE game = 'one-piece'
       ORDER BY area`);
}

export function countSourceRequestsCountForRetainedEvidenceCounts(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT state, COUNT(*) AS count FROM source_requests
       WHERE ingestion_run_id = ? GROUP BY state ORDER BY state`);
}

export function readIngestionRunTerminations(database: D1Database): D1PreparedStatement {
  return database.prepare("SELECT * FROM ingestion_run_terminations WHERE ingestion_run_id = ?");
}

export function setIngestionRunTerminationsTerminatedAt(database: D1Database): D1PreparedStatement {
  return database.prepare("UPDATE ingestion_run_terminations SET terminated_at = '2099-01-01T00:00:00.000Z'");
}

export function deleteIngestionRunTerminations(database: D1Database): D1PreparedStatement {
  return database.prepare("DELETE FROM ingestion_run_terminations");
}

export function readSourceRequestsStateSourceSnapshotIdForTerminatingPausedRunRecordsOwnerDecisionReleasesReservationRetains(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT state, source_snapshot_id FROM source_requests
     WHERE ingestion_run_id = ? AND source_snapshot_id = ?`);
}

export function countSourceCaptureOperationsCount(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT COUNT(*) AS count FROM source_capture_operations
     WHERE ingestion_run_id = ?`);
}

export function countIngestionRunTerminationsCount(database: D1Database): D1PreparedStatement {
  return database.prepare("SELECT COUNT(*) AS count FROM ingestion_run_terminations WHERE ingestion_run_id = ?");
}

export function countIngestionRunCapacityExtensionsCount(database: D1Database): D1PreparedStatement {
  return database.prepare("SELECT COUNT(*) AS count FROM ingestion_run_capacity_extensions WHERE ingestion_run_id = ?");
}

export function readSourceRequestsStateFailureCodeForTerminatingTransportPausedRunFencesCollectionWorkflows(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT state, failure_code FROM source_requests WHERE ingestion_run_id = ?`);
}

export function inspectFillerForSingleLineageGraphLargerThan5000RequestsCompletes(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`WITH RECURSIVE filler(n) AS (
         SELECT 1 UNION ALL SELECT n + 1 FROM filler WHERE n < ?2
       )
       INSERT INTO source_discovery_request_plans (
         ingestion_run_id, request_id, sequence_number, parent_request_id,
         method, url, request_headers_json, representation_fingerprint,
         request_role
       )
       SELECT ?1, 'fusion-world-en:detail:' || printf('%08d', n), 999 + n,
              ?3, 'GET',
              'https://retained-official-source.invalid/sequence/' || n,
              '{}', printf('%064x', n), 'detail'
       FROM filler`);
}

export function insertSourceRequestsForSingleLineageGraphLargerThan5000RequestsCompletes(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_requests (
         ingestion_run_id, request_id, sequence_number, method, url,
         request_headers_json, representation_fingerprint, state,
         source_snapshot_id, failure_code, request_role,
         discovered_from_request_id
       )
       SELECT ingestion_run_id, request_id, sequence_number, method, url,
              request_headers_json, representation_fingerprint, 'observed',
              NULL, NULL, request_role, parent_request_id
       FROM source_discovery_request_plans
       WHERE ingestion_run_id = ?1
         AND request_id LIKE 'fusion-world-en:detail:%'`);
}

export function createHoldChildWorkflowIds(database: D1Database): D1PreparedStatement {
  return database.prepare(`CREATE TRIGGER hold_child_workflow_ids
     BEFORE UPDATE OF child_workflow_ids_json ON ingestion_evidence_plans
     BEGIN
       SELECT RAISE(FAIL, 'synthetic_record_step_outage');
     END`);
}

export function setIngestionRunWorkflowPausesWorkflowStatus(database: D1Database): D1PreparedStatement {
  return database.prepare("UPDATE ingestion_run_workflow_pauses SET workflow_status = 'errored'");
}

export function deleteIngestionRunWorkflowPauses(database: D1Database): D1PreparedStatement {
  return database.prepare("DELETE FROM ingestion_run_workflow_pauses");
}

export function deleteIngestionWorkflowAttempts(database: D1Database): D1PreparedStatement {
  return database.prepare("DELETE FROM ingestion_workflow_attempts");
}

export function readIngestionRunWorkflowPausesPauseReasonWorkflowInstanceId(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT pause_reason, workflow_instance_id, workflow_status,
            last_progress_at
     FROM ingestion_run_workflow_pauses WHERE ingestion_run_id = ?`);
}

export function readIngestionRunWorkflowPausesPauseReasonWorkflowInstanceIdForCollectingRunWhoseParentWorkflowDiedBeTerminatedWithout(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT pause_reason, workflow_instance_id, workflow_status
     FROM ingestion_run_workflow_pauses WHERE ingestion_run_id = ?`);
}

export function countIngestionWorkflowAttemptsCount(database: D1Database): D1PreparedStatement {
  return database.prepare(
    "SELECT count(*) AS count FROM ingestion_workflow_attempts WHERE ingestion_run_id = ? AND workflow_kind = 'parent'",
  );
}

export function readIngestionWorkflowAttemptsWorkflowInstanceId(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT workflow_instance_id FROM ingestion_workflow_attempts
     WHERE ingestion_run_id = ? AND workflow_kind = 'parent'
     ORDER BY attempt_number`);
}

export function countIngestionRunWorkflowPausesCount(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT COUNT(*) AS count FROM ingestion_run_workflow_pauses
     WHERE ingestion_run_id = ?`);
}

export function readSourceRequestsRequestIdStateForChildIdentityExhaustionFailsOnlyExhaustedHostnameShard(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT request_id, state FROM source_requests
     WHERE ingestion_run_id = ? ORDER BY request_id`);
}

export function countSourceCaptureOperationsCountForParentWorkflowThatCompletedRequestStillPendingResumesAs(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT request_id, COUNT(*) AS count FROM source_capture_operations
     WHERE ingestion_run_id = ? GROUP BY request_id ORDER BY request_id`);
}

export function readSourceFreshnessGameAreaForInterruptedReconciliationPublicationRecoversExactDigestBoundCandidateExport(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT game, area, source_lineage, region, checked_at
     FROM source_freshness
     WHERE area IN (
       'cards-and-printings', 'products-and-releases', 'errata'
     )`);
}

export function readSourceFetchAttemptsRequestIdAttemptNumber(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT attempts.request_id, attempts.attempt_number, attempts.outcome FROM source_fetch_attempts AS attempts
     JOIN source_requests AS requests ON requests.ingestion_run_id = attempts.ingestion_run_id AND requests.request_id = attempts.request_id
     WHERE attempts.ingestion_run_id = ? ORDER BY requests.sequence_number, attempts.attempt_number`);
}

export function readSourceCaptureOperationsRequestIdAttemptNumber(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT operations.request_id, operations.attempt_number, operations.state, operations.completed_at, operations.content_digest,
            operations.source_snapshot_id
     FROM source_capture_operations AS operations
     JOIN source_requests AS requests ON requests.ingestion_run_id = operations.ingestion_run_id AND requests.request_id = operations.request_id
     WHERE operations.ingestion_run_id = ? ORDER BY requests.sequence_number, operations.attempt_number`);
}

export function countSourceSnapshotsCountForBatchThatFailsMidwayReplaysWithoutDuplicatingSnapshotsOr(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT COUNT(*) AS count FROM source_snapshots
     WHERE ingestion_run_id = ? AND request_id = ?`);
}

export function readSourceSnapshotsIdRetrievedAt(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT id, retrieved_at, content_digest FROM source_snapshots
     WHERE ingestion_run_id = ? AND request_id = ?`);
}

export function countSourceSnapshotsCountForBatchThatFailsMidwayReplaysWithoutDuplicatingSnapshotsOrWithundefined(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT COUNT(*) AS count FROM source_snapshots WHERE ingestion_run_id = ?`);
}

export function readSourceRequestsRequestIdRetryGeneration(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT request_id, retry_generation FROM source_requests
     WHERE ingestion_run_id = ? AND retry_generation > 1`);
}

export function readSourceRequestsRequestStateFetchDiagnostic(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT requests.request_id, requests.state AS request_state,
                requests.failure_code, requests.request_role,
                requests.method, requests.url,
                requests.request_headers_json,
                attempts.attempt_number, attempts.outcome,
                attempts.http_status, attempts.response_headers_json,
                attempts.diagnostic AS fetch_diagnostic,
                capture.state AS capture_state,
                capture.diagnostic AS capture_diagnostic,
                snapshots.id AS snapshot_id,
                snapshots.content_digest AS snapshot_content_digest,
                snapshots.content_byte_length AS snapshot_content_byte_length,
                snapshots.media_type AS snapshot_media_type,
                parse.id AS parse_operation_id,
                parse.state AS parse_operation_state
         FROM source_requests AS requests
         LEFT JOIN source_fetch_attempts AS attempts
           ON attempts.ingestion_run_id = requests.ingestion_run_id
          AND attempts.request_id = requests.request_id
         LEFT JOIN source_capture_operations AS capture
           ON capture.ingestion_run_id = requests.ingestion_run_id
          AND capture.request_id = requests.request_id
          AND capture.attempt_number = attempts.attempt_number
         LEFT JOIN source_snapshots AS snapshots
           ON snapshots.ingestion_run_id = requests.ingestion_run_id
          AND snapshots.request_id = requests.request_id
          AND snapshots.fetch_attempt_id = attempts.id
         LEFT JOIN source_parse_operations AS parse
           ON parse.source_snapshot_id = snapshots.id
         WHERE requests.ingestion_run_id = ?
           AND (requests.failure_code IS NOT NULL
             OR attempts.diagnostic IS NOT NULL
             OR capture.diagnostic IS NOT NULL)
         ORDER BY requests.request_id, attempts.attempt_number`);
}

export function readSourceDiscoveryRequestPlansParentRequestIdRequestId(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT parent_request_id, request_id, sequence_number,
                method, url, request_headers_json,
                representation_fingerprint, request_role
         FROM source_discovery_request_plans
         WHERE ingestion_run_id = ?
         ORDER BY sequence_number`);
}

export function readSourceFreshnessCheckedAtForIdenticalProductFactsAreSemanticNoChangeWhileSource(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT checked_at
     FROM source_freshness
     WHERE game = 'one-piece'
       AND area = 'products-and-releases'`);
}

export function readSourceSnapshotsRetrievedAt(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT retrieved_at
     FROM source_snapshots
     WHERE ingestion_run_id = ?`);
}

export function readIngestionRunCapacityExtensions(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT * FROM ingestion_run_capacity_extensions
     WHERE ingestion_run_id = ?`);
}

export function setIngestionRunsStateTerminalAtForTerminalEvidenceDiagnosticsExposeCollectionRetryGuidanceWithoutStale(
  database: D1Database,
  terminalAt: string,
  runId: string,
): D1PreparedStatement {
  const store = catalogueStore(database);
  const event = runEventCommand("failed", { runId, occurredAt: terminalAt });
  return runEventStatement(store, {
    event,
    statement: database
      .prepare(`UPDATE ingestion_run_current
      SET ${runEventIdentitySql}, state = 'failed', terminal_at = ?,
          failure_code = 'source_request_retries_exhausted'
      WHERE ingestion_run_id = ? AND state = 'collecting'`)
      .bind(event.eventId, terminalAt, runId),
    guards: [runTransitionGuardStatement(store, { runId, from: "collecting", to: "failed" })],
  });
}

export function insertIngestionEvidencePlansForPublishedEvidenceDiagnosticsExplicitlyAdvertiseNoRetryRoute(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_evidence_plans (
         ingestion_run_id, source_lineage, supported_game,
         game_profile_version, adapter_version, request_plan_json,
         plan_origin
       )
       SELECT ?, source_lineage, supported_game, game_profile_version,
              adapter_version, request_plan_json, plan_origin
       FROM ingestion_evidence_plans WHERE ingestion_run_id = ?`);
}

export function readSourceObservationSetsIdSourceSnapshotId(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT id, source_snapshot_id
     FROM source_observation_sets
     ORDER BY id`);
}

export function readSourceFreshness(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT * FROM source_freshness ORDER BY game, area`);
}

export function readSourceObservationSetsIdParseOperationId(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT observations.id, observations.parse_operation_id,
              observations.content_object_key
       FROM source_observation_sets AS observations
       JOIN source_snapshots AS snapshots
         ON snapshots.id = observations.source_snapshot_id
       WHERE snapshots.ingestion_run_id = ?`);
}

export function setSourceObservationSetsContentDigestContentByteLength(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE source_observation_sets
         SET content_digest = ?, content_byte_length = ?,
             observation_count = ?
         WHERE id = ?`);
}

export function setSourceParseOperationsContentDigestContentByteLength(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE source_parse_operations
         SET content_digest = ?, content_byte_length = ?,
             observation_count = ?
         WHERE id = ?`);
}

export function readSourceRequestsRequestIdStateForImageRequestThatExhaustsTransportRetriesFailsAloneCollection(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT request_id, state, failure_code FROM source_requests
     WHERE ingestion_run_id = ? ORDER BY sequence_number`);
}

export function readIngestionRunRetryPausesRequestIdPauseReason(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT request_id, pause_reason, failure_classification
     FROM ingestion_run_retry_pauses WHERE ingestion_run_id = ?`);
}

export function readSourceRequestsStateFailureCodeForImageRequestThatExhaustsStorageRetriesStillPausesRun(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT state, failure_code FROM source_requests
     WHERE ingestion_run_id = ? AND request_id = ?`);
}

export function readSourceRequestsRequestIdUrl(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT request_id, url, failure_code
       FROM source_requests
       WHERE ingestion_run_id = ? AND failure_code IS NOT NULL
       ORDER BY sequence_number`);
}

export function readSourceRequestsUrl(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT url
     FROM source_requests
     WHERE ingestion_run_id = ? AND request_role = 'listing'
       AND url LIKE '%package=619102%'
     ORDER BY url`);
}

export function readSourceRequestsRequestRoleRequestHeadersJson(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT request_role, request_headers_json
     FROM source_requests
     WHERE ingestion_run_id = ?
       AND request_role IN ('listing', 'detail', 'image')
       AND (
         url LIKE '%package=619102%'
         OR url LIKE '%detailSearch=GD02-00%'
         OR url LIKE '%/GD02-00%.png'
       )
     ORDER BY sequence_number`);
}

export function readSourceRequestsContentObjectKey(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT observation.content_object_key
     FROM source_requests AS request
     JOIN source_snapshots AS snapshot
       ON snapshot.id = request.source_snapshot_id
     JOIN source_observation_sets AS observation
       ON observation.source_snapshot_id = snapshot.id
     WHERE request.ingestion_run_id = ?
       AND request.url = ?`);
}

export function insertSourceCaptureOperationsForR2RecoveryOutagesPauseRunResumeCompletesSameCapture(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_capture_operations (
      attempt_id, ingestion_run_id, request_id, attempt_number,
      source_snapshot_id, content_object_key, state, requested_at,
      completed_at, request_headers_json, http_status,
      response_headers_json, response_vary_json, media_type
    ) VALUES (
      ?, ?, 'one-piece-en:discovery', 1, ?, ?, 'response_received', ?,
      ?, '{}', 200, '{"content-type":"application/json"}', '[]',
      'application/json'
    )`);
}

export function readIngestionRunRetryPausesPauseReasonFailureClassification(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT pause_reason, failure_classification, retry_generation
     FROM ingestion_run_retry_pauses WHERE ingestion_run_id = ?`);
}

export function readSourceRequestsStateFailureCodeForR2RecoveryOutagesPauseRunResumeCompletesSameCapture(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT state, failure_code FROM source_requests
     WHERE ingestion_run_id = ? AND request_id = 'one-piece-en:discovery'`);
}

export function readSourceCaptureOperationsStateContentDigest(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT state, content_digest, content_byte_length
     FROM source_capture_operations WHERE attempt_id = ?`);
}

export function createFailObservationSetInsert(database: D1Database): D1PreparedStatement {
  return database.prepare(`CREATE TRIGGER fail_observation_set_insert
     BEFORE INSERT ON source_observation_sets
     BEGIN
       SELECT RAISE(FAIL, 'synthetic_observation_d1_outage');
     END`);
}

export function readSourceParseOperationsStateContentObjectKey(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT state, content_object_key FROM source_parse_operations
     WHERE source_snapshot_id = ? AND adapter_version = ?
       AND idempotency_key = ?`);
}

export function readIngestionRunCapacityPausesPausedAtOverflowRequestCount(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT paused_at, overflow_request_count, required_capacity
     FROM ingestion_run_capacity_pauses WHERE ingestion_run_id = ?`);
}

export function readSourceSnapshotsContentByteLength(database: D1Database): D1PreparedStatement {
  return database.prepare("SELECT content_byte_length FROM source_snapshots WHERE id = ?");
}

export function inspectFillerForPerRequestDetailBoundedWhileAggregateCountsStayExact(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`WITH RECURSIVE filler(n) AS (
       SELECT 1 UNION ALL SELECT n + 1 FROM filler WHERE n < 250
     )
     INSERT INTO source_fetch_attempts (
       id, ingestion_run_id, request_id, attempt_number, requested_at,
       completed_at, outcome, http_status, response_headers_json,
       retry_after_ms, diagnostic
     )
     SELECT 'srcfetch_bounded_' || printf('%08d', n), ?1,
            'fusion-world-en:detail:' || printf('%08d', n), 1,
            '2026-08-07T01:00:00.000Z',
            '2026-08-07T01:' || printf('%02d', n / 60) || ':' ||
              printf('%02d', n % 60) || '.000Z',
            'http_failure', 503, '{}', NULL, NULL
     FROM filler`);
}

export function countSourceRequestsCountForReachingRequestCapacityPausesIngestionRunWithoutFailingRetained(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT COUNT(*) AS count FROM source_requests
     WHERE ingestion_run_id = ? AND state = 'failed'`);
}

export function readIngestionRunCapacityPauses(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT * FROM ingestion_run_capacity_pauses WHERE ingestion_run_id = ?`);
}

export function countSourceCaptureOperationsCountForPausedIngestionRunFailsClosedOnEveryAdvancingOperation(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT COUNT(*) AS count FROM source_capture_operations
     WHERE ingestion_run_id = ? AND request_id = ?`);
}

export function readSourceParseOperationsState(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT state FROM source_parse_operations
       WHERE intent = 'collection' AND source_snapshot_id IN (
         SELECT source_snapshot_id FROM source_requests
         WHERE ingestion_run_id = ?
       )`);
}

export function countSourceObservationSetsCountForRetainedEvidenceCounts(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT COUNT(*) AS count FROM source_observation_sets
       WHERE source_snapshot_id IN (
         SELECT id FROM source_snapshots WHERE ingestion_run_id = ?
       )`);
}

export function sourceRequestIdentitiesInSequence(database: D1Database, runId: string): D1PreparedStatement {
  return database
    .prepare("SELECT request_id, url FROM source_requests WHERE ingestion_run_id = ? ORDER BY sequence_number")
    .bind(runId);
}
