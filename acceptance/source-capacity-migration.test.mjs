import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import * as queries from "./helpers/query-helpers/source-capacity-migration.mjs";
import * as schema from "./helpers/query-helpers/schema.mjs";

test("capacity migration preserves populated source dependencies, decisions and fences", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys=ON");
    const root = new URL("../migrations/", import.meta.url);
    for (const name of (await readdir(root))
      .filter((name) => name.endsWith(".sql") && Number.parseInt(name, 10) < 36)
      .sort()) {
      database.exec("BEGIN");
      database.exec(await readFile(new URL(name, root), "utf8"));
      database.exec("COMMIT");
    }
    assert.equal(schema.schemaMigrationLevel(database).get().migration_level, 35);
    // Retained metadata covers all four inbound adapter foreign-key owners.
    // It does not stand in for capture or publication.
    const source = {
      source_lineage: "one-piece-en",
      supported_game: "one-piece",
      game_profile_version: "one-piece@1",
    };
    const adapterVersion = "one-piece-en@6";
    const runId = "capacity-migration";
    const requestId = "root";
    const sourceUrl = "https://official-source.invalid/cards";
    const retainedAt = "2026-09-15";
    queries.insertIngestionRun(database).run({
      id: runId,
      started_at: "2026-09-15T00:00:00.000Z",
      expected_current_revision_id: "catrev_spine_000",
      idempotency_key: runId,
    });
    queries.insertEvidencePlan(database).run({
      ingestion_run_id: runId,
      ...source,
      adapter_version: adapterVersion,
      request_plan_json: "{}",
    });
    queries.insertSourceRequest(database).run({
      ingestion_run_id: runId,
      request_id: requestId,
      sequence_number: 0,
      method: "GET",
      url: sourceUrl,
      request_headers_json: "{}",
      representation_fingerprint: "fingerprint",
      state: "observed",
    });
    queries.insertFetchAttempt(database).run({
      id: "capacity-fetch",
      ingestion_run_id: runId,
      request_id: requestId,
      attempt_number: 1,
      requested_at: retainedAt,
      completed_at: retainedAt,
      outcome: "success",
      http_status: 200,
      response_headers_json: "{}",
    });
    queries.insertSourceSnapshot(database).run({
      id: "capacity-snapshot",
      ingestion_run_id: runId,
      request_id: requestId,
      fetch_attempt_id: "capacity-fetch",
      request_method: "GET",
      request_url: sourceUrl,
      request_headers_json: "{}",
      representation_fingerprint: "fingerprint",
      response_vary_json: "[]",
      retrieved_at: retainedAt,
      http_status: 200,
      response_headers_json: "{}",
      media_type: "application/json",
      content_digest: "digest",
      content_byte_length: 2,
      content_object_key: "capacity-raw",
      ...source,
      adapter_version: adapterVersion,
    });
    queries.insertParseOperation(database).run({
      id: "capacity-parse",
      source_snapshot_id: "capacity-snapshot",
      adapter_version: adapterVersion,
      intent: "collection",
      idempotency_key: "capacity-parse",
      observation_set_id: "capacity-observation",
      content_object_key: "capacity-observation-object",
      parsed_at: retainedAt,
      state: "finalized",
      content_digest: "digest",
      content_byte_length: 2,
      observation_count: 1,
    });
    queries.insertObservationSet(database).run({
      id: "capacity-observation",
      parse_operation_id: "capacity-parse",
      source_snapshot_id: "capacity-snapshot",
      ...source,
      adapter_version: adapterVersion,
      parsed_at: retainedAt,
      content_digest: "digest",
      content_byte_length: 2,
      content_object_key: "capacity-observation-object",
      observation_count: 1,
    });
    const insertAdapter = (version, capacity) =>
      queries.insertAdapter(database).run({
        adapter_version: version,
        ...source,
        parser_contract: "migration-probe",
        request_capacity: capacity,
      });
    const insertExtension = (generation, capacity, key, digest) =>
      queries.insertCapacityExtension(database).run({
        ingestion_run_id: runId,
        capacity_generation: generation,
        previous_request_capacity: 10000,
        request_capacity: capacity,
        source_lineage: source.source_lineage,
        extended_at: retainedAt,
        idempotency_key: key,
        request_digest: digest,
        response_json: "{}",
      });
    insertExtension(2, 20000, "before-capacity-migration", "a".repeat(64));
    const before = schema.seedRows(database);
    const foreignKeys = queries.inboundForeignKeys(database).all();
    const definitions = () =>
      schema
        .schemaDefinitionRows(database)
        .all()
        .filter(
          ({ type, name }) =>
            type === "trigger" || type === "view" || (type === "index" && !name.startsWith("source_requests_pending_")),
        );
    const retainedDefinitions = definitions();
    assert.throws(() => insertAdapter("before-large@1", 249999), /CHECK constraint/u);
    database.exec("BEGIN");
    const migration = await readFile(new URL("0036_source_collection_capacity.sql", root), "utf8");
    database.exec(migration);
    database.exec("COMMIT");
    assert.equal(schema.schemaMigrationLevel(database).get().migration_level, 36);
    database.exec("BEGIN");
    assert.throws(() => database.exec(migration), /malformed JSON/u);
    database.exec("ROLLBACK");
    assert.equal(schema.schemaMigrationLevel(database).get().migration_level, 36);
    assert.deepEqual(schema.seedRows(database), before);
    assert.deepEqual(queries.inboundForeignKeys(database).all(), foreignKeys);
    assert.deepEqual(definitions(), retainedDefinitions);
    assert.throws(
      () => queries.mutateRetainedAdapter(database).run(12000, adapterVersion),
      /source_adapter_version_immutable/u,
    );
    assert.throws(() => queries.mutateRetainedExtension(database).run(22000, 2), /capacity_extension_immutable/u);
    assert.throws(() => queries.deleteRetainedExtension(database).run(2), /capacity_extension_immutable/u);
    assert.throws(() => insertAdapter("ceiling@1", 250000), /CHECK constraint/u);
    assert.throws(() => insertExtension(3, 250000, "ceiling", "b".repeat(64)), /CHECK constraint/u);
    insertAdapter("last-valid@1", 249999);
    insertExtension(3, 249999, "last-valid", "c".repeat(64));
    queries.recoveryFence(database).run("blocked");
    assert.throws(() => insertAdapter("fenced@1", 12000), /catalogue_recovery_writer_fenced/u);
    assert.throws(() => insertExtension(4, 22000, "fenced", "d".repeat(64)), /catalogue_recovery_writer_fenced/u);
    queries.recoveryFence(database).run("clear");
    assert.deepEqual(schema.foreignKeyViolations(database).all(), []);
    assert.equal(schema.integrityCheck(database).get().integrity_check, "ok");
  } finally {
    database.close();
  }
});
