import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createServer } from "vite";
import {
  prepareCardSearchForD1ExportStatements,
  reconstructCardSearchAfterD1RestoreStatements,
} from "../src/catalogue/card-search-recovery-statements.mjs";

const root = resolve(import.meta.dirname, "..");

test("a real SQL export restores a multi-Card catalogue whose FTS, API, and Curated provenance are verified", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "card-keepr-backup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, "source.sqlite");
  const restoredPath = join(directory, "restored.sqlite");
  const source = new DatabaseSync(sourcePath);
  const migrations = (await readdir(join(root, "migrations")))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const migration of migrations) {
    source.exec(await readFile(join(root, "migrations", migration), "utf8"));
  }
  const expectedSchemaMigrationLevel = source.prepare(
    "SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1",
  ).get().migration_level;
  assert.equal(expectedSchemaMigrationLevel, 19);
  seedRepresentativeCatalogue(source);

  const vite = await createServer({
    root,
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  t.after(() => vite.close());
  const recovery = await vite.ssrLoadModule("/src/catalogue/backup-recovery.ts");
  const expected = await recovery.captureCatalogueVerificationEvidence(
    d1Adapter(source),
    "catrev_restore_acceptance",
  );
  assert.equal(expected.cards, 2);
  assert.equal(expected.provenance, 1);

  for (const statement of prepareCardSearchForD1ExportStatements) {
    source.exec(statement);
  }
  source.prepare(
    `UPDATE card_search_fts_state
     SET state = 'reconstructing', owner_token = ?, lease_expires_at = ?
     WHERE singleton = 1`,
  ).run("backup:restore-acceptance", "2099-01-01T00:00:00.000Z");
  source.close();
  const sqlExport = execFileSync("/usr/bin/sqlite3", [sourcePath, ".dump"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.match(sqlExport, /CREATE TABLE revision_cards/u);
  assert.match(sqlExport, /INSERT INTO revision_cards/u);

  execFileSync("/usr/bin/sqlite3", [restoredPath], {
    input: sqlExport,
    maxBuffer: 16 * 1024 * 1024,
  });
  const restored = new DatabaseSync(restoredPath);
  t.after(() => restored.close());
  for (const statement of reconstructCardSearchAfterD1RestoreStatements) {
    restored.exec(statement);
  }
  restored.prepare(
    `UPDATE card_search_fts_state
     SET state = 'ready', owner_token = NULL, lease_expires_at = NULL
     WHERE singleton = 1`,
  ).run();
  const database = d1Adapter(restored);
  await assert.doesNotReject(recovery.verifyRestoredCatalogue(database, {
    expectedRevisionId: "catrev_restore_acceptance",
    expectedSchemaMigrationLevel,
    expected,
  }));

  restored.prepare(
    "DELETE FROM revision_card_search_fts WHERE card_id = ?",
  ).run("card_alpha");
  await assert.rejects(
    recovery.verifyRestoredCatalogue(database, {
      expectedRevisionId: "catrev_restore_acceptance",
      expectedSchemaMigrationLevel,
      expected,
    }),
    /Restored D1 verification failed/u,
  );
  restored.prepare(
    `INSERT INTO revision_card_search_fts (
       rowid, revision_token, catalogue_revision_id, card_id,
       field_ordinal, chunk_ordinal, search_text
     ) SELECT indexed.fts_rowid, '|' || chunk.catalogue_revision_id || '|',
              chunk.catalogue_revision_id, chunk.card_id,
              chunk.field_ordinal, chunk.chunk_ordinal, chunk.search_text
       FROM revision_card_search_chunks AS chunk
       JOIN revision_card_search_fts_rows AS indexed USING (
         catalogue_revision_id, card_id, field_ordinal, chunk_ordinal
       ) WHERE chunk.card_id = ?`,
  ).run("card_alpha");
  restored.prepare(
    `UPDATE revision_card_query_documents
     SET summary_json = json_set(summary_json, '$.id', 'corrupt_api_id')
     WHERE catalogue_revision_id = ? AND card_id = ?`,
  ).run("catrev_restore_acceptance", "card_alpha");
  await assert.rejects(
    recovery.verifyRestoredCatalogue(database, {
      expectedRevisionId: "catrev_restore_acceptance",
      expectedSchemaMigrationLevel,
      expected,
    }),
    /Restored D1 verification failed/u,
  );
});

function seedRepresentativeCatalogue(database) {
  const digest = "a".repeat(64);
  const legalityOwnerTrigger = database.prepare(
    `SELECT sql FROM sqlite_schema
     WHERE type = 'trigger' AND name = 'legality_rule_provenance_owner_insert'`,
  ).get().sql;
  database.exec("DROP TRIGGER legality_rule_provenance_owner_insert");
  database.exec(`
    INSERT INTO ingestion_runs (
      id, state, selected_games_json, started_at,
      expected_current_revision_id, idempotency_key, candidate_digest,
      candidate_created_at, approval_deadline, approval_json,
      candidate_json, progress_json
    ) VALUES (
      'run_restore_acceptance', 'publishing', '["one-piece"]',
      '2026-08-05T00:00:00.000Z', 'catrev_spine_000',
      'run-restore-acceptance', '${digest}', '2026-08-05T00:01:00.000Z',
      '2099-01-01T00:00:00.000Z',
      '{"candidate_digest":"${digest}","expected_current_revision_id":"catrev_spine_000"}',
      '{}',
      '{"completed_stages":["planning","collecting","parsing","reconciling","awaiting_approval"],"current_stage":"publishing"}'
    );
    INSERT INTO ingestion_evidence_plans (
      ingestion_run_id, source_lineage, supported_game,
      game_profile_version, adapter_version, request_plan_json, plan_origin
    ) VALUES (
      'run_restore_acceptance', 'one-piece-en', 'one-piece',
      'one-piece@1', 'one-piece-en@3',
      '{"source_lineage":"one-piece-en","supported_game":"one-piece","game_profile_version":"one-piece@1","adapter_version":"one-piece-en@3","requests":[{"id":"request_alpha","method":"GET","url":"https://example.invalid/alpha","headers":{},"representation_fingerprint":"${"b".repeat(64)}"}]}',
      'production'
    );
    INSERT INTO source_requests (
      ingestion_run_id, request_id, sequence_number, method, url,
      request_headers_json, representation_fingerprint, state,
      source_snapshot_id
    ) VALUES (
      'run_restore_acceptance', 'request_alpha', 0, 'GET',
      'https://example.invalid/alpha', '{}', '${"b".repeat(64)}',
      'observed', 'snapshot_alpha'
    );
    INSERT INTO source_fetch_attempts (
      id, ingestion_run_id, request_id, attempt_number, requested_at,
      completed_at, outcome, http_status, response_headers_json
    ) VALUES (
      'fetch_alpha', 'run_restore_acceptance', 'request_alpha', 1,
      '2026-08-05T00:00:00.000Z', '2026-08-05T00:00:01.000Z',
      'success', 200, '{}'
    );
    INSERT INTO source_snapshots (
      id, ingestion_run_id, request_id, fetch_attempt_id, request_method,
      request_url, request_headers_json, representation_fingerprint,
      response_vary_json, retrieved_at, http_status, response_headers_json,
      media_type, content_digest, content_byte_length, content_object_key,
      source_lineage, supported_game, game_profile_version, adapter_version
    ) VALUES (
      'snapshot_alpha', 'run_restore_acceptance', 'request_alpha',
      'fetch_alpha', 'GET', 'https://example.invalid/alpha', '{}',
      '${"b".repeat(64)}', '[]', '2026-08-05T00:00:01.000Z', 200,
      '{}', 'application/json', '${"e".repeat(64)}', 2,
      'evidence/snapshot-alpha.json', 'one-piece-en', 'one-piece',
      'one-piece@1', 'one-piece-en@3'
    );
    INSERT INTO source_parse_operations (
      id, source_snapshot_id, adapter_version, intent, idempotency_key,
      observation_set_id, content_object_key, parsed_at, state,
      content_digest, content_byte_length, observation_count
    ) VALUES (
      'parse_alpha', 'snapshot_alpha', 'one-piece-en@3', 'collection',
      'parse-alpha', 'set_alpha', 'evidence/set-alpha.json',
      '2026-08-05T00:00:02.000Z', 'finalized', '${"f".repeat(64)}', 2, 1
    );
    INSERT INTO source_observation_sets (
      id, parse_operation_id, source_snapshot_id, source_lineage,
      supported_game, game_profile_version, adapter_version, parsed_at,
      content_digest, content_byte_length, content_object_key,
      observation_count
    ) VALUES (
      'set_alpha', 'parse_alpha', 'snapshot_alpha', 'one-piece-en',
      'one-piece', 'one-piece@1', 'one-piece-en@3',
      '2026-08-05T00:00:02.000Z', '${"f".repeat(64)}', 2,
      'evidence/set-alpha.json', 1
    );
    UPDATE operation_state
      SET active_ingestion_run_id = 'run_restore_acceptance'
      WHERE singleton = 1;
    INSERT INTO catalogue_revisions (
      id, ingestion_run_id, published_at, content_digest,
      expected_previous_revision_id, approved_candidate_digest
    ) VALUES (
      'catrev_restore_acceptance', 'run_restore_acceptance',
      '2026-08-05T00:02:00.000Z', '${digest}', 'catrev_spine_000', '${digest}'
    );
    UPDATE ingestion_runs SET state = 'published',
      published_revision_id = 'catrev_restore_acceptance',
      terminal_at = '2026-08-05T00:02:00.000Z',
      progress_json = '{"completed_stages":["planning","collecting","parsing","reconciling","awaiting_approval","publishing","published"],"current_stage":"published"}'
      WHERE id = 'run_restore_acceptance';
    UPDATE catalogue_state SET
      current_revision_id = 'catrev_restore_acceptance',
      published_at = '2026-08-05T00:02:00.000Z'
      WHERE singleton = 1;
    UPDATE operation_state SET active_ingestion_run_id = NULL WHERE singleton = 1;
  `);
  const cards = [
    ["card_alpha", "ALPHA-001", "Alpha Beacon"],
    ["card_beta", "BETA-002", "Beta Sentinel"],
  ];
  for (const [id, number, name] of cards) {
    const summary = JSON.stringify({
      type: "card",
      id,
      game: "one-piece",
      official_identity: { kind: "card_number", value: number },
      name,
      effective_rules_text: `${number} restored search text`,
      game_data: {},
      lifecycle: {},
      links: {},
    });
    database.prepare(
      `INSERT INTO revision_cards (
         catalogue_revision_id, card_id, document_json
       ) VALUES (?, ?, ?)`,
    ).run("catrev_restore_acceptance", id, summary);
    database.prepare(
      `INSERT INTO revision_card_query_documents (
         catalogue_revision_id, card_id, summary_json, search_text
       ) VALUES (?, ?, ?, ?)`,
    ).run(
      "catrev_restore_acceptance",
      id,
      summary,
      `${number} ${name}`.toLowerCase(),
    );
    database.prepare(
      `INSERT INTO revision_card_search_chunks (
         catalogue_revision_id, card_id, field_ordinal, chunk_ordinal,
         search_text
       ) VALUES (?, ?, 0, 0, ?)`,
    ).run(
      "catrev_restore_acceptance",
      id,
      `${number} ${name}`.toLowerCase(),
    );
    database.prepare(
      `INSERT INTO revision_card_search_terms (
         catalogue_revision_id, card_id, term, sort_game,
         sort_identity_kind, sort_identity_value, sort_id
       ) VALUES (?, ?, ?, 'one-piece', 'card_number', ?, ?)`,
    ).run(
      "catrev_restore_acceptance",
      id,
      `g3:${number.slice(0, 3).toLowerCase()}`,
      number,
      id,
    );
  }
  database.exec(`
    INSERT INTO revision_printings (
      catalogue_revision_id, printing_id, card_id, document_json
    ) VALUES (
      'catrev_restore_acceptance', 'printing_alpha', 'card_alpha',
      '{"id":"printing_alpha","card_id":"card_alpha"}'
    );
    INSERT INTO revision_products (
      catalogue_revision_id, product_id, supported_game, official_code,
      name, search_text, release_regions_json, document_json
    ) VALUES (
      'catrev_restore_acceptance', 'product_alpha', 'one-piece', 'PRD-001',
      'Alpha Product', 'PRD-001 Alpha Product', '[]',
      '{"id":"product_alpha","game":"one-piece"}'
    );
    INSERT INTO legality_rules (
      id, official_id, supported_game, region, format, event_tier,
      effective_from, effective_until, unresolved_scope_json,
      official_wording, effect_json, card_ids_json, direct_card_ids_json,
      source_lineage, source_snapshot_id, source_observation_set_id,
      source_observation_id, source_observation_pointer,
      source_field_pointers_json, first_revision_id,
      last_observed_revision_id, current
    ) VALUES (
      'legality_alpha', 'official-legality-alpha', 'one-piece',
      'EN-OCEANIA', 'standard', NULL, '2026-01-01', NULL, 'null',
      'Alpha is restricted.', '{"type":"ban"}', '["card_alpha"]',
      '["card_alpha"]', 'one-piece-en', 'snapshot_alpha', 'set_alpha',
      'observation_alpha', '/observations/0', '{"effect":"/effect"}',
      'catrev_restore_acceptance', 'catrev_restore_acceptance', 1
    );
    INSERT INTO revision_legality_rules (
      catalogue_revision_id, legality_rule_id, supported_game, region,
      format, event_tier, effective_from, effective_until,
      unresolved_scope_json, card_ids_json, document_json
    ) VALUES (
      'catrev_restore_acceptance', 'legality_alpha', 'one-piece',
      'EN-OCEANIA', 'standard', NULL, '2026-01-01', NULL, 'null',
      '["card_alpha"]',
      '{"id":"legality_alpha","official_id":"official-legality-alpha","game":"one-piece","region":"EN-OCEANIA","format":"standard","event_tier":null,"effective_from":"2026-01-01","effective_until":null,"unresolved_scope":null,"official_wording":"Alpha is restricted.","effect":{"type":"ban"},"card_ids":["card_alpha"],"source_lineage":"one-piece-en","source_snapshot_id":"snapshot_alpha","source_observation_set_id":"set_alpha","source_observation_id":"observation_alpha","source_observation_pointer":"/observations/0","source_field_pointers":{"effect":"/effect"},"first_revision_id":"catrev_restore_acceptance","last_observed_revision_id":"catrev_restore_acceptance","current":true,"last_missing_revision_id":null}'
    );
    INSERT INTO catalogue_query_revisions (catalogue_revision_id, state)
      VALUES ('catrev_restore_acceptance', 'available');
    INSERT INTO curated_revisions (
      id, game, target_key, target_kind, effective_from, effective_to,
      proposal_json, content_digest, reviewed_source_digest,
      schema_binding_json, author, created_at, status, event_version
    ) VALUES (
      'curated_alpha', 'one-piece', 'card:card_alpha:/name', 'field',
      NULL, NULL,
      '{"target":{"kind":"field"},"assertion":{"value":"Alpha Beacon"},"rationale":"Owner-reviewed name.","evidence":[]}',
      '${"c".repeat(64)}', '${"d".repeat(64)}',
      '{"catalogue_revision_id":"catrev_restore_acceptance"}',
      'owner', '2026-08-05T00:01:30.000Z', 'active', 1
    );
    INSERT INTO catalogue_curated_provenance (
      catalogue_revision_id, curated_revision_id, target_key,
      content_digest, provenance_json
    ) VALUES (
      'catrev_restore_acceptance', 'curated_alpha',
      'card:card_alpha:/name', '${"c".repeat(64)}',
      '{"author":"owner","created_at":"2026-08-05T00:01:30.000Z","evidence":[],"rationale":"Owner-reviewed name."}'
    );
  `);
  database.exec(legalityOwnerTrigger);
}

function d1Adapter(database) {
  return {
    prepare(sql) {
      let bindings = [];
      const prepared = {
        bind(...values) {
          bindings = values;
          return prepared;
        },
        async all() {
          return { results: database.prepare(sql).all(...bindings) };
        },
        async first() {
          return database.prepare(sql).get(...bindings) ?? null;
        },
      };
      return prepared;
    },
  };
}
