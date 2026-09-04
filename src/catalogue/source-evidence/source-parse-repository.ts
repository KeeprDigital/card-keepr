// Prepared statements only; callers own execution and atomic batch composition.

export function uploadedParseStatement(
  database: D1Database,
  input: Readonly<{ digest: string; byteLength: number; observationCount: number; operationId: string }>,
): D1PreparedStatement {
  return database
    .prepare(`UPDATE source_parse_operations
         SET state = 'uploaded', content_digest = ?,
             content_byte_length = ?, observation_count = ?
         WHERE id = ? AND state = 'planned'`)
    .bind(input.digest, input.byteLength, input.observationCount, input.operationId);
}

export function retainedDiscoveryObservationsStatement(
  database: D1Database,
  input: Readonly<{ runId: string; sourceLineage: string }>,
): D1PreparedStatement {
  return database
    .prepare(`SELECT observation_set.*, snapshot.request_id
     FROM source_observation_sets AS observation_set
     JOIN source_snapshots AS snapshot
       ON snapshot.id = observation_set.source_snapshot_id
     WHERE snapshot.ingestion_run_id = ?
       AND snapshot.source_lineage = ?
     ORDER BY snapshot.retrieved_at, observation_set.id`)
    .bind(input.runId, input.sourceLineage);
}

export function createParseOperationStatement(
  database: D1Database,
  input: Readonly<{
    operationId: string;
    snapshotId: string;
    adapterVersion: string;
    intent: string;
    idempotencyKey: string;
    observationSetId: string;
    objectKey: string;
    parsedAt: string;
  }>,
): D1PreparedStatement {
  return database
    .prepare(`INSERT OR IGNORE INTO source_parse_operations (
        id, source_snapshot_id, adapter_version, intent, idempotency_key,
        observation_set_id, content_object_key, parsed_at, state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned')`)
    .bind(
      input.operationId,
      input.snapshotId,
      input.adapterVersion,
      input.intent,
      input.idempotencyKey,
      input.observationSetId,
      input.objectKey,
      input.parsedAt,
    );
}

export function finalizedObservationSetStatement(
  database: D1Database,
  input: Readonly<{
    observationSetId: string;
    operationId: string;
    snapshotId: string;
    sourceLineage: string;
    supportedGame: string;
    gameProfileVersion: string;
    adapterVersion: string;
    parsedAt: string;
    digest: string;
    byteLength: number;
    objectKey: string;
    observationCount: number;
  }>,
): D1PreparedStatement {
  return database
    .prepare(`INSERT OR IGNORE INTO source_observation_sets (
          id, parse_operation_id, source_snapshot_id, source_lineage,
          supported_game, game_profile_version, adapter_version, parsed_at,
          content_digest, content_byte_length, content_object_key,
          observation_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      input.observationSetId,
      input.operationId,
      input.snapshotId,
      input.sourceLineage,
      input.supportedGame,
      input.gameProfileVersion,
      input.adapterVersion,
      input.parsedAt,
      input.digest,
      input.byteLength,
      input.objectKey,
      input.observationCount,
    );
}

export function finalizeParseStatement(database: D1Database, operationId: string): D1PreparedStatement {
  return database
    .prepare(`UPDATE source_parse_operations SET state = 'finalized'
         WHERE id = ? AND state = 'uploaded'`)
    .bind(operationId);
}

export function parseOperationStatement(database: D1Database, operationId: string): D1PreparedStatement {
  return database.prepare("SELECT * FROM source_parse_operations WHERE id = ?").bind(operationId);
}

export function observationSetByParseOperationStatement(
  database: D1Database,
  operationId: string,
): D1PreparedStatement {
  return database.prepare("SELECT * FROM source_observation_sets WHERE parse_operation_id = ?").bind(operationId);
}
