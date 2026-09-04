import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createServer } from "vite";
import {
  prepareCardSearchForD1ExportStatements,
  reconstructCardSearchAfterD1RestoreStatements,
} from "../src/catalogue/backup-recovery/card-search-recovery-statements.ts";
import * as backupQueries from "./helpers/query-helpers/backup.mjs";
import * as schemaQueries from "./helpers/query-helpers/schema.mjs";
import { d1Adapter } from "./helpers/query-helpers/sqlite-d1-adapter.mjs";

const root = resolve(import.meta.dirname, "..");

test("a real SQL export restores a multi-Card catalogue whose FTS, API, and Curated provenance are verified", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "card-keepr-backup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, "source.sqlite");
  const restoredPath = join(directory, "restored.sqlite");
  const source = new DatabaseSync(sourcePath);
  const migrations = (await readdir(join(root, "migrations"))).filter((name) => name.endsWith(".sql")).sort();
  for (const migration of migrations) {
    source.exec(await readFile(join(root, "migrations", migration), "utf8"));
  }
  const expectedSchemaMigrationLevel = schemaQueries.schemaMigrationLevel(source).get().migration_level;
  const currentSchemaMigrationLevel = Number.parseInt(migrations.at(-1) ?? "", 10);
  assert.ok(Number.isSafeInteger(currentSchemaMigrationLevel));
  assert.equal(expectedSchemaMigrationLevel, currentSchemaMigrationLevel);
  seedRepresentativeCatalogue(source);

  const vite = await createServer({
    root,
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  t.after(() => vite.close());
  const recovery = await vite.ssrLoadModule("/src/catalogue/backup-recovery/backup-recovery.ts");
  const { catalogueStore } = await vite.ssrLoadModule("/src/catalogue/shared/index.ts");
  const expected = await recovery.captureCatalogueVerificationEvidence(
    catalogueStore(d1Adapter(source)),
    "catrev_restore_acceptance",
  );
  assert.equal(expected.cards, 2);
  assert.equal(expected.provenance, 1);

  for (const statement of prepareCardSearchForD1ExportStatements) {
    source.exec(statement);
  }
  backupQueries.reserveSearchReconstruction(source).run("backup:restore-acceptance", "2099-01-01T00:00:00.000Z");
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
  backupQueries.completeSearchReconstruction(restored).run();
  const database = catalogueStore(d1Adapter(restored));
  await assert.doesNotReject(
    recovery.verifyRestoredCatalogue(database, {
      expectedRevisionId: "catrev_restore_acceptance",
      expectedSchemaMigrationLevel,
      expected,
    }),
  );

  backupQueries.deleteCardSearchFts(restored).run("card_alpha");
  await assert.rejects(
    recovery.verifyRestoredCatalogue(database, {
      expectedRevisionId: "catrev_restore_acceptance",
      expectedSchemaMigrationLevel,
      expected,
    }),
    /Restored D1 verification failed/u,
  );
  backupQueries.reinsertCardSearchFts(restored).run("card_alpha");
  backupQueries.corruptCardApiIdentity(restored).run("catrev_restore_acceptance", "card_alpha");
  await assert.rejects(
    recovery.verifyRestoredCatalogue(database, {
      expectedRevisionId: "catrev_restore_acceptance",
      expectedSchemaMigrationLevel,
      expected,
    }),
    /Restored D1 verification failed/u,
  );

  removeCardAndLegalityProjection(restored);
  const productOnlyExpected = await recovery.captureCatalogueVerificationEvidence(
    database,
    "catrev_restore_acceptance",
  );
  assert.equal(productOnlyExpected.cards, 0);
  assert.equal(productOnlyExpected.printings, 0);
  assert.equal(productOnlyExpected.products, 1);
  assert.equal(productOnlyExpected.legality_rules, 0);
  assert.match(productOnlyExpected.representative_product_digest, /^[a-f0-9]{64}$/u);
  assert.equal(productOnlyExpected.representative_legality_rule_digest, null);
  await assert.doesNotReject(
    recovery.verifyRestoredCatalogue(database, {
      expectedRevisionId: "catrev_restore_acceptance",
      expectedSchemaMigrationLevel,
      expected: productOnlyExpected,
    }),
  );

  const {
    representative_product_digest: _legacyProductDigest,
    representative_legality_rule_digest: _legacyLegalityRuleDigest,
    ...legacyProductOnlyExpected
  } = productOnlyExpected;
  await assert.doesNotReject(
    recovery.verifyRestoredCatalogue(database, {
      expectedRevisionId: "catrev_restore_acceptance",
      expectedSchemaMigrationLevel,
      expected: legacyProductOnlyExpected,
    }),
  );

  backupQueries.corruptProductName(restored).run("catrev_restore_acceptance", "product_alpha");
  await assert.rejects(
    recovery.verifyRestoredCatalogue(database, {
      expectedRevisionId: "catrev_restore_acceptance",
      expectedSchemaMigrationLevel,
      expected: productOnlyExpected,
    }),
    /Restored D1 verification failed/u,
  );

  backupQueries.corruptProductReleases(restored).run("catrev_restore_acceptance", "product_alpha");
  const malformedProductExpected = await recovery.captureCatalogueVerificationEvidence(
    database,
    "catrev_restore_acceptance",
  );
  await assert.rejects(
    recovery.verifyRestoredCatalogue(database, {
      expectedRevisionId: "catrev_restore_acceptance",
      expectedSchemaMigrationLevel,
      expected: malformedProductExpected,
    }),
    /Restored D1 verification failed/u,
  );

  seedGlobalLegalityRuleOnly(restored);
  const globalRuleOnlyExpected = await recovery.captureCatalogueVerificationEvidence(
    database,
    "catrev_restore_acceptance",
  );
  assert.equal(globalRuleOnlyExpected.cards, 0);
  assert.equal(globalRuleOnlyExpected.products, 0);
  assert.equal(globalRuleOnlyExpected.legality_rules, 1);
  assert.equal(globalRuleOnlyExpected.representative_product_digest, null);
  assert.match(globalRuleOnlyExpected.representative_legality_rule_digest, /^[a-f0-9]{64}$/u);
  await assert.doesNotReject(
    recovery.verifyRestoredCatalogue(database, {
      expectedRevisionId: "catrev_restore_acceptance",
      expectedSchemaMigrationLevel,
      expected: globalRuleOnlyExpected,
    }),
  );

  backupQueries.corruptLegalityFieldPointers(restored).run("catrev_restore_acceptance", "legality_global");
  const malformedRuleExpected = await recovery.captureCatalogueVerificationEvidence(
    database,
    "catrev_restore_acceptance",
  );
  await assert.rejects(
    recovery.verifyRestoredCatalogue(database, {
      expectedRevisionId: "catrev_restore_acceptance",
      expectedSchemaMigrationLevel,
      expected: malformedRuleExpected,
    }),
    /Restored D1 verification failed/u,
  );
});

function removeCardAndLegalityProjection(database) {
  database.exec(`
    DROP TRIGGER revision_legality_rules_immutable_update;
    DROP TRIGGER revision_legality_rules_immutable_delete;
    DROP TRIGGER revision_legality_rule_applicability_immutable_update;
    DROP TRIGGER revision_legality_rule_applicability_immutable_delete;
    DROP TRIGGER catalogue_curated_provenance_is_immutable_on_delete;
    DELETE FROM revision_card_search_fts;
    DELETE FROM revision_card_search_fts_rows;
    DELETE FROM revision_card_search_chunks;
    DELETE FROM revision_card_query_documents;
    DELETE FROM revision_printings;
    DELETE FROM revision_legality_rule_applicability;
    DELETE FROM revision_legality_rules;
    DELETE FROM revision_cards;
    DELETE FROM catalogue_curated_provenance;
  `);
}

function seedGlobalLegalityRuleOnly(database) {
  const document = validStoredLegalityRule("legality_global", []);
  database.exec(`
    DELETE FROM revision_products;
    INSERT INTO legality_rules (
      id, official_id, supported_game, region, format, event_tier,
      effective_from, effective_until, unresolved_scope_json,
      official_wording, effect_json, card_ids_json, direct_card_ids_json,
      source_lineage, source_snapshot_id, source_observation_set_id,
      source_observation_id, source_observation_pointer,
      source_field_pointers_json, first_revision_id,
      last_observed_revision_id, current
    ) VALUES (
      'legality_global', 'official-legality-global', 'one-piece',
      'EN-OCEANIA', 'standard', NULL, '2026-01-01', NULL, 'null',
      'The global tournament restriction applies.', '{"type":"ban"}',
      '[]', '[]', 'one-piece-en', 'snapshot_alpha', 'set_alpha',
      'observation_alpha', '/observations/0',
      '${JSON.stringify(document.source_field_pointers)}',
      'catrev_restore_acceptance', 'catrev_restore_acceptance', 1
    );
    INSERT INTO revision_legality_rules (
      catalogue_revision_id, legality_rule_id, supported_game, region,
      format, event_tier, effective_from, effective_until,
      unresolved_scope_json, card_ids_json, source_retrieved_at, document_json
    ) VALUES (
      'catrev_restore_acceptance', 'legality_global', 'one-piece',
      'EN-OCEANIA', 'standard', NULL, '2026-01-01', NULL, 'null', '[]',
      '2026-08-05T00:00:01.000Z', '${JSON.stringify(document)}'
    );
  `);
}

function validStoredLegalityRule(id, cardIds, officialWording = "The global tournament restriction applies.") {
  const observationPointer = "/observations/0";
  return {
    id,
    official_id: `official-${id.replaceAll("_", "-")}`,
    game: "one-piece",
    region: "EN-OCEANIA",
    format: "standard",
    event_tier: null,
    effective_from: "2026-01-01",
    effective_until: null,
    unresolved_scope: null,
    official_wording: officialWording,
    effect: { type: "ban" },
    card_ids: cardIds,
    source_lineage: "one-piece-en",
    source_snapshot_id: "snapshot_alpha",
    source_observation_set_id: "set_alpha",
    source_observation_id: "observation_alpha",
    source_observation_pointer: observationPointer,
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
      ].map((field) => [field, `${observationPointer}/${field}`]),
    ),
    first_revision_id: "catrev_restore_acceptance",
    last_observed_revision_id: "catrev_restore_acceptance",
    current: true,
    last_missing_revision_id: null,
  };
}

function seedRepresentativeCatalogue(database) {
  const digest = "a".repeat(64);
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
      'one-piece@1', 'one-piece-en@6',
      '{"source_lineage":"one-piece-en","supported_game":"one-piece","game_profile_version":"one-piece@1","adapter_version":"one-piece-en@6","requests":[{"id":"request_alpha","method":"GET","url":"https://example.invalid/alpha","headers":{},"representation_fingerprint":"${"b".repeat(64)}"}]}',
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
      'one-piece@1', 'one-piece-en@6'
    );
    INSERT INTO source_parse_operations (
      id, source_snapshot_id, adapter_version, intent, idempotency_key,
      observation_set_id, content_object_key, parsed_at, state,
      content_digest, content_byte_length, observation_count
    ) VALUES (
      'parse_alpha', 'snapshot_alpha', 'one-piece-en@6', 'collection',
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
      'one-piece', 'one-piece@1', 'one-piece-en@6',
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
    backupQueries.insertRevisionCard(database).run("catrev_restore_acceptance", id, summary);
    backupQueries
      .insertCardQueryDocument(database)
      .run("catrev_restore_acceptance", id, summary, `${number} ${name}`.toLowerCase());
    backupQueries
      .insertCardSearchChunk(database)
      .run("catrev_restore_acceptance", id, `${number} ${name}`.toLowerCase());
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
      '{"id":"product_alpha","game":"one-piece","official_code":"PRD-001","name":"Alpha Product","releases":[]}'
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
      'observation_alpha', '/observations/0',
      '${JSON.stringify(validStoredLegalityRule("legality_alpha", ["card_alpha"]).source_field_pointers)}',
      'catrev_restore_acceptance', 'catrev_restore_acceptance', 1
    );
    INSERT INTO revision_legality_rules (
      catalogue_revision_id, legality_rule_id, supported_game, region,
      format, event_tier, effective_from, effective_until,
      unresolved_scope_json, card_ids_json, source_retrieved_at, document_json
    ) VALUES (
      'catrev_restore_acceptance', 'legality_alpha', 'one-piece',
      'EN-OCEANIA', 'standard', NULL, '2026-01-01', NULL, 'null',
      '["card_alpha"]', '2026-08-05T00:00:01.000Z',
      '${JSON.stringify(validStoredLegalityRule("legality_alpha", ["card_alpha"], "Alpha is restricted."))}'
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
}
