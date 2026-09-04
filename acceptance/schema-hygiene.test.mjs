import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
// ADR 0006: the baseline seeds catalogue_schema_state at level 1 and every
// later migration opens with the level guard, so the walk starts at the
// first file and the guard proof covers every file after it.
const firstSchemaStateLevel = 1;
const firstGuardedLevel = 2;

test("every migration leaves catalogue_schema_state at its own level", async () => {
  const migrations = await readMigrations();
  const database = new DatabaseSync(":memory:");
  for (const { level, sql } of migrations) {
    database.exec(sql);
    if (level < firstSchemaStateLevel) continue;
    assert.equal(
      schemaLevel(database),
      level,
      `migration ${String(level).padStart(4, "0")} must leave the schema level at ${level}`,
    );
  }
  database.close();
});

test("a guarded migration aborts before changing anything when the recorded level mismatches", async (t) => {
  const migrations = await readMigrations();
  const guarded = migrations.filter(({ level }) => level >= firstGuardedLevel);
  if (guarded.length === 0) {
    t.skip("no migration after the baseline yet; every later file is guarded");
    return;
  }
  for (const migration of guarded) {
    const database = new DatabaseSync(":memory:");
    for (const earlier of migrations) {
      if (earlier.level >= migration.level) break;
      database.exec(earlier.sql);
    }
    const expectedObjects = schemaObjects(database);
    database.prepare("UPDATE catalogue_schema_state SET migration_level = 99 WHERE singleton = 1").run();
    assert.throws(
      () => database.exec(migration.sql),
      /malformed JSON/u,
      `migration ${migration.name} must abort on a schema level mismatch`,
    );
    assert.deepEqual(schemaObjects(database), expectedObjects);
    assert.equal(schemaLevel(database), 99);
    database.close();
  }
});

// Migration 0002 rebuilds the two tables whose CHECK enumerates the Workflow
// Pause reasons. Production already holds retained pause and termination
// rows, so the rebuild is proven on a populated database: every row
// survives, the immutability and paused-run guards are back, and the new
// owner_requested reason is accepted where the old vocabulary was.
test("migration 0002 retains pause and termination rows and re-guards both tables", async () => {
  const migrations = await readMigrations();
  const baseline = migrations.find(({ level }) => level === 1);
  const rebuild = migrations.find(({ level }) => level === 2);
  assert.ok(baseline && rebuild);
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(baseline.sql);
  const terminateRun = (id, reason) => {
    database.exec(
      `INSERT INTO ingestion_runs (
         id, state, selected_games_json, started_at,
         expected_current_revision_id, idempotency_key, candidate_json
       ) VALUES ('${id}', 'planning', '["one-piece"]', '2026-09-03T00:00:00.000Z',
                 'catrev_spine_000', 'key_${id}', '{}')`,
    );
    database.exec(`UPDATE operation_state SET active_ingestion_run_id = '${id}' WHERE singleton = 1`);
    database.exec(`UPDATE ingestion_runs SET state = 'collecting' WHERE id = '${id}'`);
    database.exec(`UPDATE ingestion_runs SET state = 'paused' WHERE id = '${id}'`);
    database.exec(
      `INSERT INTO ingestion_run_workflow_pauses VALUES
         ('${id}', 'evidence-${id}', '${reason}', 'terminated',
          '2026-09-03T01:00:00.000Z', NULL)`,
    );
    database.exec(
      `INSERT INTO ingestion_run_terminations VALUES
         ('${id}', '${reason}', '2026-09-03T01:00:00.000Z',
          '2026-09-03T02:00:00.000Z', 'terminate_${id}', '${"a".repeat(64)}', '{}')`,
    );
    database.exec(
      `UPDATE ingestion_runs SET state = 'failed', failure_code = 'ingestion_run_terminated'
       WHERE id = '${id}'`,
    );
    database.exec("UPDATE operation_state SET active_ingestion_run_id = NULL WHERE singleton = 1");
  };
  terminateRun("run_retained", "source_workflow_terminated");
  const rows = (table) => database.prepare(`SELECT * FROM ${table} ORDER BY ingestion_run_id`).all();
  const before = {
    pauses: rows("ingestion_run_workflow_pauses"),
    terminations: rows("ingestion_run_terminations"),
  };

  database.exec(rebuild.sql);

  assert.equal(schemaLevel(database), 2);
  assert.deepEqual(
    { pauses: rows("ingestion_run_workflow_pauses"), terminations: rows("ingestion_run_terminations") },
    before,
  );
  assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.throws(
    () =>
      database.exec(
        `INSERT INTO ingestion_run_workflow_pauses VALUES
         ('run_retained', 'late', 'owner_requested', 'running', '2026-09-03T03:00:00.000Z', NULL)`,
      ),
    /workflow_pause_requires_paused_run/u,
  );
  assert.throws(
    () => database.exec("UPDATE ingestion_run_workflow_pauses SET workflow_status = 'errored'"),
    /workflow_pause_immutable/u,
  );
  assert.throws(() => database.exec("DELETE FROM ingestion_run_terminations"), /termination_immutable/u);
  assert.throws(
    () => database.exec("UPDATE ingestion_run_terminations SET terminated_at = '2026-09-04T00:00:00.000Z'"),
    /termination_immutable/u,
  );
  // The widened vocabulary is accepted end to end: an owner-requested pause
  // can be recorded and terminated on the migrated schema.
  terminateRun("run_owner", "owner_requested");
  assert.equal(database.prepare("SELECT state FROM ingestion_runs WHERE id = 'run_owner'").get().state, "failed");
  database.close();
});

// Migration 0004 projects the Printing Image content facts and the Legality
// Rule Source Snapshot retrieval instant onto the revision rows (issue #98).
// The backfill is proven on a populated database: existing rows receive the
// facts from the tables the api used to join, the revision_legality_rules
// immutability guard is back, and a new row omitting the facts is rejected.
test("migration 0004 backfills the projected read facts and guards new rows", async () => {
  const migrations = await readMigrations();
  const projection = migrations.find(({ level }) => level === 4);
  assert.ok(projection);
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const earlier of migrations) {
    if (earlier.level >= 4) break;
    database.exec(earlier.sql);
  }
  const sha = "a".repeat(64);
  const pointer = "/observations/0/value/legality_rules/0";
  const document = {
    id: "legality_0004",
    official_id: "official-0004",
    game: "one-piece",
    region: "EN-OCEANIA",
    format: "standard",
    event_tier: null,
    effective_from: "2026-01-01",
    effective_until: null,
    card_ids: [],
    official_wording: "Backfilled rule.",
    unresolved_scope: null,
    effect: { type: "ban" },
    source_lineage: "one-piece-en",
    source_snapshot_id: "snapshot_0004",
    source_observation_set_id: "set_0004",
    source_observation_id: "observation_0004",
    source_observation_pointer: pointer,
    source_field_pointers: Object.fromEntries(
      [
        "official_wording",
        "effective_from",
        "effective_until",
        "region",
        "unresolved_scope",
        "format",
        "event_tier",
        "card_numbers",
        "effect",
      ].map((field) => [field, `${pointer}/${field}`]),
    ),
    first_revision_id: "catrev_0004",
    last_observed_revision_id: "catrev_0004",
    current: true,
    last_missing_revision_id: null,
  };
  database.exec(`
    INSERT INTO ingestion_runs (
      id, state, selected_games_json, started_at,
      expected_current_revision_id, idempotency_key, candidate_json,
      candidate_digest, candidate_created_at, approval_deadline, approval_json
    ) VALUES ('run_0004', 'publishing', '["one-piece"]', '2026-09-03T00:00:00.000Z',
              'catrev_spine_000', 'key_0004', '{}', '${sha}',
              '2026-09-03T00:30:00.000Z', '2099-01-01T00:00:00.000Z',
              '{"candidate_digest":"${sha}","expected_current_revision_id":"catrev_spine_000","approved_at":"2026-09-03T00:45:00.000Z"}');
    UPDATE operation_state SET active_ingestion_run_id = 'run_0004' WHERE singleton = 1;
    INSERT INTO catalogue_revisions (
      id, ingestion_run_id, published_at, content_digest,
      expected_previous_revision_id, approved_candidate_digest
    ) VALUES ('catrev_0004', 'run_0004', '2026-09-03T01:00:00.000Z', '${sha}',
              'catrev_spine_000', '${sha}');
    INSERT INTO reconciled_printing_images (
      id, printing_id, role, media_type, width, height,
      content_sha256, content_byte_length, object_key
    ) VALUES ('image_0004', 'printing_0004', 'front', 'image/webp', 1, 1,
              '${sha}', 18, 'printing-images/${sha}');
    INSERT INTO revision_printing_images (catalogue_revision_id, image_id, printing_id)
      VALUES ('catrev_0004', 'image_0004', 'printing_0004');
    INSERT INTO ingestion_evidence_plans (
      ingestion_run_id, source_lineage, supported_game, game_profile_version,
      adapter_version, request_plan_json, plan_origin
    ) VALUES ('run_0004', 'one-piece-en', 'one-piece', 'one-piece@1', 'fixture-one-piece-json@3',
              '${JSON.stringify({
                requests: [
                  {
                    id: "request_0004",
                    method: "GET",
                    url: "https://example.invalid/0004",
                    headers: {},
                    representation_fingerprint: sha,
                  },
                ],
              })}', 'synthetic_fixture');
    INSERT INTO source_requests (
      ingestion_run_id, request_id, sequence_number, method, url,
      request_headers_json, representation_fingerprint, state
    ) VALUES ('run_0004', 'request_0004', 0, 'GET', 'https://example.invalid/0004',
              '{}', '${sha}', 'pending');
    INSERT INTO source_fetch_attempts (
      id, ingestion_run_id, request_id, attempt_number, requested_at,
      completed_at, outcome, http_status, response_headers_json
    ) VALUES ('fetch_0004', 'run_0004', 'request_0004', 1, '2026-09-03T00:00:00.000Z',
              '2026-09-03T00:00:01.000Z', 'success', 200, '{}');
    INSERT INTO source_snapshots (
      id, ingestion_run_id, request_id, fetch_attempt_id, request_method,
      request_url, request_headers_json, representation_fingerprint,
      response_vary_json, retrieved_at, http_status, response_headers_json,
      media_type, content_digest, content_byte_length, content_object_key,
      source_lineage, supported_game, game_profile_version, adapter_version
    ) VALUES ('snapshot_0004', 'run_0004', 'request_0004', 'fetch_0004', 'GET',
              'https://example.invalid/0004', '{}', '${sha}', '[]',
              '2026-09-03T00:00:01.000Z', 200, '{}', 'application/json', '${sha}', 2,
              'evidence/0004.json', 'one-piece-en', 'one-piece', 'one-piece@1',
              'fixture-one-piece-json@3');
    INSERT INTO source_parse_operations (
      id, source_snapshot_id, adapter_version, intent, idempotency_key,
      observation_set_id, content_object_key, parsed_at, state,
      content_digest, content_byte_length, observation_count
    ) VALUES ('parse_0004', 'snapshot_0004', 'fixture-one-piece-json@3', 'collection',
              'parse-0004', 'set_0004', 'observations/0004.json',
              '2026-09-03T00:00:02.000Z', 'finalized', '${sha}', 2, 1);
    INSERT INTO source_observation_sets (
      id, parse_operation_id, source_snapshot_id, source_lineage,
      supported_game, game_profile_version, adapter_version, parsed_at,
      content_digest, content_byte_length, content_object_key, observation_count
    ) VALUES ('set_0004', 'parse_0004', 'snapshot_0004', 'one-piece-en',
              'one-piece', 'one-piece@1', 'fixture-one-piece-json@3',
              '2026-09-03T00:00:02.000Z', '${sha}', 2, 'observations/0004.json', 1);
    INSERT INTO legality_rules (
      id, official_id, supported_game, region, format, event_tier,
      effective_from, effective_until, unresolved_scope_json, official_wording,
      effect_json, card_ids_json, direct_card_ids_json, source_lineage,
      source_snapshot_id, source_observation_set_id, source_observation_id,
      source_observation_pointer, source_field_pointers_json,
      first_revision_id, last_observed_revision_id, current
    ) VALUES ('legality_0004', 'official-0004', 'one-piece', 'EN-OCEANIA',
              'standard', NULL, '2026-01-01', NULL, 'null', 'Backfilled rule.',
              '{"type":"ban"}', '[]', '[]', 'one-piece-en', 'snapshot_0004',
              'set_0004', 'observation_0004', '${pointer}',
              '${JSON.stringify(document.source_field_pointers)}',
              'catrev_0004', 'catrev_0004', 1);
    INSERT INTO revision_legality_rules (
      catalogue_revision_id, legality_rule_id, supported_game, region, format,
      event_tier, effective_from, effective_until, unresolved_scope_json,
      card_ids_json, document_json
    ) VALUES ('catrev_0004', 'legality_0004', 'one-piece', 'EN-OCEANIA',
              'standard', NULL, '2026-01-01', NULL, 'null', '[]',
              '${JSON.stringify(document)}');
  `);

  database.exec(projection.sql);

  assert.equal(schemaLevel(database), 4);
  assert.deepEqual(
    {
      ...database
        .prepare(
          `SELECT media_type, content_sha256, content_byte_length, object_key
         FROM revision_printing_images WHERE image_id = 'image_0004'`,
        )
        .get(),
    },
    { media_type: "image/webp", content_sha256: sha, content_byte_length: 18, object_key: `printing-images/${sha}` },
  );
  assert.equal(
    database
      .prepare("SELECT source_retrieved_at FROM revision_legality_rules WHERE legality_rule_id = 'legality_0004'")
      .get().source_retrieved_at,
    "2026-09-03T00:00:01.000Z",
  );
  assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.throws(
    () => database.exec("UPDATE revision_legality_rules SET source_retrieved_at = '2027-01-01T00:00:00.000Z'"),
    /revision_legality_rule_immutable/u,
  );
  database.exec(`
    INSERT INTO reconciled_printing_images (
      id, printing_id, role, media_type, width, height,
      content_sha256, content_byte_length, object_key
    ) VALUES ('image_0004_late', 'printing_0004', 'back', 'image/webp', 1, 1,
              '${"b".repeat(64)}', 17, 'printing-images/${"b".repeat(64)}');
    INSERT INTO legality_rules (
      id, official_id, supported_game, region, format, event_tier,
      effective_from, effective_until, unresolved_scope_json, official_wording,
      effect_json, card_ids_json, direct_card_ids_json, source_lineage,
      source_snapshot_id, source_observation_set_id, source_observation_id,
      source_observation_pointer, source_field_pointers_json,
      first_revision_id, last_observed_revision_id, current
    ) VALUES ('legality_0004_late', 'official-0004-late', 'one-piece', 'EN-OCEANIA',
              'standard', NULL, '2026-01-01', NULL, 'null', 'Late rule.',
              '{"type":"ban"}', '[]', '[]', 'one-piece-en', 'snapshot_0004',
              'set_0004', 'observation_0004_late', '${pointer}',
              '${JSON.stringify(document.source_field_pointers)}',
              'catrev_0004', 'catrev_0004', 1);
  `);
  const lateDocument = JSON.stringify({
    ...document,
    id: "legality_0004_late",
    official_id: "official-0004-late",
    official_wording: "Late rule.",
    source_observation_id: "observation_0004_late",
  });
  assert.throws(
    () =>
      database.exec(
        `INSERT INTO revision_printing_images (catalogue_revision_id, image_id, printing_id)
       VALUES ('catrev_0004', 'image_0004_late', 'printing_0004')`,
      ),
    /revision_printing_image_content_missing/u,
  );
  assert.throws(
    () =>
      database.exec(
        `INSERT INTO revision_legality_rules (
         catalogue_revision_id, legality_rule_id, supported_game, region, format,
         event_tier, effective_from, effective_until, unresolved_scope_json,
         card_ids_json, document_json
       ) VALUES ('catrev_0004', 'legality_0004_late', 'one-piece', 'EN-OCEANIA',
                 'standard', NULL, '2026-01-01', NULL, 'null', '[]', '${lateDocument}')`,
      ),
    /revision_legality_rule_source_retrieved_at_missing/u,
  );
  database.exec(`
    INSERT INTO revision_printing_images (
      catalogue_revision_id, image_id, printing_id,
      media_type, content_sha256, content_byte_length, object_key
    ) VALUES ('catrev_0004', 'image_0004_late', 'printing_0004', 'image/webp',
              '${"b".repeat(64)}', 17, 'printing-images/${"b".repeat(64)}');
    INSERT INTO revision_legality_rules (
      catalogue_revision_id, legality_rule_id, supported_game, region, format,
      event_tier, effective_from, effective_until, unresolved_scope_json,
      card_ids_json, source_retrieved_at, document_json
    ) VALUES ('catrev_0004', 'legality_0004_late', 'one-piece', 'EN-OCEANIA',
              'standard', NULL, '2026-01-01', NULL, 'null', '[]',
              '2026-09-03T00:00:01.000Z', '${lateDocument}');
  `);
  database.close();
});

test("the schema carries the hot-path indexes and not the dead ones", async () => {
  const database = await migratedDatabase();
  const indexes = database
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' ORDER BY name")
    .all()
    .map((row) => row.name);
  assert.ok(!indexes.includes("revision_products_region"));
  assert.ok(!indexes.includes("revision_errata_by_revision"));

  assert.deepEqual(
    plan(
      database,
      `SELECT document_json FROM revision_printings
       WHERE catalogue_revision_id = ? AND card_id = ?
       ORDER BY printing_id`,
    ),
    ["SEARCH revision_printings USING INDEX revision_printings_by_card (catalogue_revision_id=? AND card_id=?)"],
  );
  assert.deepEqual(
    plan(
      database,
      `SELECT * FROM source_snapshots WHERE ingestion_run_id = ?
       ORDER BY retrieved_at DESC, id DESC LIMIT ?`,
    ),
    ["SEARCH source_snapshots USING INDEX source_snapshots_by_run (ingestion_run_id=?)"],
  );
  assert.deepEqual(plan(database, "SELECT COUNT(*) FROM source_snapshots WHERE ingestion_run_id = ?"), [
    "SEARCH source_snapshots USING COVERING INDEX source_snapshots_by_run (ingestion_run_id=?)",
  ]);
  assert.deepEqual(
    plan(
      database,
      `SELECT * FROM source_fetch_attempts WHERE ingestion_run_id = ?
       ORDER BY completed_at DESC, request_id DESC, attempt_number DESC LIMIT ?`,
    ),
    ["SEARCH source_fetch_attempts USING INDEX source_fetch_attempts_by_run (ingestion_run_id=?)"],
  );
  assert.equal(
    plan(
      database,
      `SELECT printing_id, source_lineage, locator FROM reconciled_printing_locators
       WHERE printing_id = ? ORDER BY locator`,
    )[0],
    "SEARCH reconciled_printing_locators USING COVERING INDEX reconciled_printing_locators_by_printing (printing_id=?)",
  );
  assert.deepEqual(
    plan(
      database,
      `SELECT printing_id, source_lineage, locator, variant_key
       FROM reconciled_printing_locators
       WHERE printing_id IN (SELECT value FROM json_each(?))
       ORDER BY printing_id, source_lineage, locator, COALESCE(variant_key, '')`,
    ).filter((step) => step.includes("reconciled_printing_locators")),
    ["SEARCH reconciled_printing_locators USING INDEX reconciled_printing_locators_by_printing (printing_id=?)"],
  );
  assert.deepEqual(
    plan(
      database,
      `SELECT idempotency_key FROM catalogue_backup_attempts
       WHERE catalogue_revision_id = ?
       ORDER BY started_at DESC, idempotency_key DESC`,
    ),
    [
      "SEARCH catalogue_backup_attempts USING COVERING INDEX catalogue_backup_attempts_by_revision (catalogue_revision_id=?)",
    ],
  );
  assert.deepEqual(
    plan(
      database,
      `SELECT idempotency_key FROM catalogue_backup_attempts
       WHERE state = 'verified' AND catalogue_revision_id = ?
         AND d1_bookmark IS NOT NULL AND manifest_sha256 IS NOT NULL
       ORDER BY completed_at DESC LIMIT 1`,
    )[0],
    "SEARCH catalogue_backup_attempts USING INDEX catalogue_backup_attempts_by_revision (catalogue_revision_id=?)",
  );
  assert.deepEqual(
    plan(database, "SELECT idempotency_key FROM catalogue_backup_attempts WHERE linked_attempt_id = ? LIMIT 1"),
    [
      "SEARCH catalogue_backup_attempts USING INDEX one_catalogue_backup_retry_per_failed_attempt (linked_attempt_id=?)",
    ],
  );
  assert.deepEqual(plan(database, "SELECT * FROM ingestion_runs ORDER BY started_at DESC, id DESC LIMIT 20"), [
    "SCAN ingestion_runs USING INDEX ingestion_runs_recent",
  ]);
  assert.deepEqual(
    plan(
      database,
      `SELECT * FROM ingestion_runs
       WHERE state = 'publishing'
         AND publication_reconcile_after IS NOT NULL
         AND publication_reconcile_after <= ?
       ORDER BY publication_reconcile_after, id LIMIT 1`,
    ),
    [
      "SEARCH ingestion_runs USING INDEX ingestion_runs_by_state (state=? AND publication_reconcile_after>? AND publication_reconcile_after<?)",
    ],
  );
  assert.deepEqual(plan(database, "SELECT id FROM ingestion_runs WHERE state = 'expired'"), [
    "SEARCH ingestion_runs USING COVERING INDEX ingestion_runs_by_state (state=?)",
  ]);
  database.close();
});

test("dropping the dead indexes leaves their queries on an equivalent seek", async () => {
  const database = await migratedDatabase();
  assert.match(
    plan(database, "SELECT product_id FROM revision_products WHERE catalogue_revision_id = ? ORDER BY product_id")[0],
    /^SEARCH revision_products USING (?:COVERING )?INDEX \S+ \(catalogue_revision_id=\?\)$/u,
  );
  assert.deepEqual(plan(database, "SELECT erratum_id FROM revision_errata WHERE catalogue_revision_id = ?"), [
    "SEARCH revision_errata USING COVERING INDEX sqlite_autoindex_revision_errata_1 (catalogue_revision_id=?)",
  ]);
  database.close();
});

function plan(database, sql) {
  return database
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all()
    .map((row) => row.detail);
}

function schemaLevel(database) {
  return database.prepare("SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1").get()
    .migration_level;
}

function schemaObjects(database) {
  return database.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name").all();
}

async function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const { sql } of await readMigrations()) database.exec(sql);
  return database;
}

async function readMigrations() {
  const directory = resolve(root, "migrations");
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      level: Number.parseInt(name, 10),
      sql: await readFile(resolve(directory, name), "utf8"),
    })),
  );
}
