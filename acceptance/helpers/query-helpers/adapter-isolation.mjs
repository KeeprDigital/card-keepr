export const productionRegistrations = (database) =>
  database.prepare(
    "SELECT * FROM source_adapter_versions WHERE adapter_origin = 'production' ORDER BY adapter_version",
  );
export const syntheticRegistrations = (database) =>
  database.prepare(
    "SELECT * FROM source_adapter_versions WHERE adapter_origin = 'synthetic_fixture' ORDER BY adapter_version",
  );
export const schemaLevel = (database) =>
  database.prepare("SELECT migration_level FROM catalogue_schema_state WHERE singleton=1");
export const foreignKeyViolations = (database) => database.prepare("PRAGMA foreign_key_check");

export function snapshot(database) {
  return database
    .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
    .all()
    .map(({ name }) => ({
      name,
      rows: database
        .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" `)
        .all()
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    }));
}

// This fixture deliberately targets schema 12, before retirement migration 13.
// A current repository seeder also writes tables introduced in later migrations.
function seedRun(database) {
  database.exec(`INSERT INTO ingestion_runs
    (id, started_at, expected_current_revision_id, idempotency_key)
    VALUES ('adapter-isolation-run', '2026-09-04T00:00:00.000Z', 'catrev_spine_000', 'adapter-isolation-run');
    INSERT INTO ingestion_run_events
    (ingestion_run_id, sequence_number, event_id, event_kind, occurred_at, from_state, to_state, payload_json)
    VALUES ('adapter-isolation-run', 1, 'adapter-isolation-created', 'created',
      '2026-09-04T00:00:00.000Z', NULL, 'planning', '{}');
    INSERT INTO ingestion_run_current
    (ingestion_run_id, last_event_sequence, last_event_id, state, completed_stage_count)
    VALUES ('adapter-isolation-run', 1, 'adapter-isolation-created', 'planning', 0);
    INSERT INTO ingestion_run_selected_games VALUES ('adapter-isolation-run', 0, 'one-piece');`);
}

/** All evidence links are valid; each adapter field can independently name a
 * synthetic registration so the migration must guard every retained surface.
 */
export async function seedEvidence(database, overrides = {}) {
  seedRun(database);
  const adapter = "one-piece-en@6";
  const identity = ["one-piece-en", "one-piece", "one-piece@1"];
  database
    .prepare(
      `INSERT INTO ingestion_evidence_plans
    (ingestion_run_id, source_lineage, supported_game, game_profile_version, adapter_version, request_plan_json, plan_origin)
    VALUES ('adapter-isolation-run', ?, ?, ?, ?, '{}', ?)`,
    )
    .run(...identity, overrides.planAdapter ?? adapter, overrides.planOrigin ?? "production");
  database
    .prepare(
      `INSERT INTO source_requests
    (ingestion_run_id, request_id, sequence_number, method, url, request_headers_json, representation_fingerprint, state)
    VALUES ('adapter-isolation-run', 'one-piece-en:cards', 1, 'GET', 'https://en.onepiece-cardgame.com/cardlist/', '{}', 'fingerprint', 'captured')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO source_fetch_attempts
    (id, ingestion_run_id, request_id, attempt_number, requested_at, completed_at, outcome, response_headers_json)
    VALUES ('adapter-isolation-fetch', 'adapter-isolation-run', 'one-piece-en:cards', 1, '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z', 'success', '{}')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO source_snapshots
    (id, ingestion_run_id, request_id, fetch_attempt_id, request_method, request_url, request_headers_json, representation_fingerprint,
    response_vary_json, retrieved_at, http_status, response_headers_json, content_digest, content_byte_length, content_object_key,
    source_lineage, supported_game, game_profile_version, adapter_version)
    VALUES ('adapter-isolation-snapshot', 'adapter-isolation-run', 'one-piece-en:cards', 'adapter-isolation-fetch', 'GET',
    'https://en.onepiece-cardgame.com/cardlist/', '{}', 'fingerprint', '[]', '2026-09-04T00:00:00Z', 200, '{}', ?, 2, 'source/bytes', ?, ?, ?, ?)`,
    )
    .run("a".repeat(64), ...identity, overrides.snapshotAdapter ?? adapter);
  database
    .prepare(
      `INSERT INTO source_parse_operations
    (id, source_snapshot_id, adapter_version, intent, idempotency_key, observation_set_id, content_object_key, parsed_at, state)
    VALUES ('adapter-isolation-parse', 'adapter-isolation-snapshot', ?, 'collection', 'adapter-isolation-parse',
    'adapter-isolation-observations', 'observations/bytes', '2026-09-04T00:00:00Z', 'finalized')`,
    )
    .run(overrides.parseAdapter ?? adapter);
  database
    .prepare(
      `INSERT INTO source_observation_sets
    (id, parse_operation_id, source_snapshot_id, source_lineage, supported_game, game_profile_version, adapter_version,
    parsed_at, content_digest, content_byte_length, content_object_key, observation_count)
    VALUES ('adapter-isolation-observations', 'adapter-isolation-parse', 'adapter-isolation-snapshot', ?, ?, ?, ?,
    '2026-09-04T00:00:00Z', ?, 2, 'observations/bytes', 0)`,
    )
    .run(...identity, overrides.observationAdapter ?? adapter, "b".repeat(64));
  database
    .prepare(
      `INSERT INTO reconciliation_evidence_partitions
    (ingestion_run_id, sequence_number, request_id, source_observation_set_id, source_snapshot_id,
    source_lineage, supported_game, game_profile_version, adapter_version)
    VALUES ('adapter-isolation-run', 1, 'one-piece-en:cards', 'adapter-isolation-observations', 'adapter-isolation-snapshot', ?, ?, ?, ?)`,
    )
    .run(...identity, overrides.partitionAdapter ?? adapter);
}
