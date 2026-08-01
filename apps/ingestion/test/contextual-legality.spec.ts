import {
  applyD1Migrations,
  env,
  type D1Migration,
} from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { contextualLegalityStatusResponse } from "../../../src/catalogue/legality-status";
import {
  canonicalJson,
  sha256,
  utf8,
} from "../../../src/catalogue/serialization";
import { injectFixtureEvidencePlan } from "./fixture-plan-injection";

const testEnv = env as Env & {
  TEST_MIGRATIONS: D1Migration[];
  LEGACY_DB: D1Database;
};
let requestSequence = 0;

beforeEach(async () => {
  await applyD1Migrations(
    testEnv.CATALOGUE_DB,
    testEnv.TEST_MIGRATIONS,
  );
});

test("applied D1 request copies and owning run identities are immutable", async () => {
  const runId = "run_operational_plan_immutability";
  const ownerTargetRunId = "run_operational_plan_owner_target";
  await testEnv.CATALOGUE_DB.batch([
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO ingestion_runs (
         id, state, selected_games_json, started_at,
         expected_current_revision_id, linked_run_id, idempotency_key,
         candidate_json
       ) VALUES (?, 'collecting', '["one-piece"]',
         '2026-08-01T00:00:00.000Z', 'catrev_spine_000', NULL, ?, '{}')`,
    ).bind(runId, "operational-plan-immutability"),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO ingestion_runs (
         id, state, selected_games_json, started_at,
         expected_current_revision_id, linked_run_id, idempotency_key,
         candidate_json
       ) VALUES (?, 'collecting', '["one-piece"]',
         '2026-08-01T00:00:00.000Z', 'catrev_spine_000', NULL, ?, '{}')`,
    ).bind(ownerTargetRunId, "operational-plan-owner-target"),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO ingestion_evidence_plans (
         ingestion_run_id, source_lineage, supported_game,
         game_profile_version, adapter_version, request_plan_json,
         plan_origin
       ) VALUES (?, 'one-piece-en', 'one-piece', 'one-piece@1',
         'one-piece-json-document@1', ?, 'production')`,
    ).bind(
      runId,
      JSON.stringify({
        requests: [
          {
            id: "update-target",
            method: "GET",
            url: "https://en.onepiece-cardgame.com/cardlist/",
            headers: { accept: "text/html" },
            representation_fingerprint: "a".repeat(64),
          },
          {
            id: "delete-target",
            method: "GET",
            url: "https://en.onepiece-cardgame.com/rules/",
            headers: { accept: "text/html" },
            representation_fingerprint: "b".repeat(64),
          },
          {
            id: "insert-target",
            method: "GET",
            url: "https://en.onepiece-cardgame.com/products/",
            headers: { accept: "text/html" },
            representation_fingerprint: "e".repeat(64),
          },
        ],
      }),
    ),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO source_requests (
         ingestion_run_id, request_id, sequence_number, method, url,
         request_headers_json, representation_fingerprint, state
       ) VALUES (?, 'update-target', 0, 'GET',
         'https://en.onepiece-cardgame.com/cardlist/',
         '{"accept":"text/html"}', ?, 'pending')`,
    ).bind(runId, "a".repeat(64)),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO source_requests (
         ingestion_run_id, request_id, sequence_number, method, url,
         request_headers_json, representation_fingerprint, state
       ) VALUES (?, 'delete-target', 1, 'GET',
         'https://en.onepiece-cardgame.com/rules/',
         '{"accept":"text/html"}', ?, 'pending')`,
    ).bind(runId, "b".repeat(64)),
  ]);

  const updateError = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE source_requests
       SET url = 'https://attacker.example/changed',
           request_headers_json = '{"accept":"application/json"}',
           representation_fingerprint = ?
       WHERE ingestion_run_id = ? AND request_id = 'update-target'`,
    ).bind("c".repeat(64), runId).run(),
  );
  const deleteError = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `DELETE FROM source_requests
       WHERE ingestion_run_id = ? AND request_id = 'delete-target'`,
    ).bind(runId).run(),
  );
  const insertError = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO source_requests (
         ingestion_run_id, request_id, sequence_number, method, url,
         request_headers_json, representation_fingerprint, state
       ) VALUES (?, 'insert-target', 2, 'GET',
         'https://attacker.example/wrong-plan-fields',
         '{"accept":"application/json"}', ?, 'pending')`,
    ).bind(runId, "f".repeat(64)).run(),
  );
  const unplannedInsertError = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO source_requests (
         ingestion_run_id, request_id, sequence_number, method, url,
         request_headers_json, representation_fingerprint, state
       ) VALUES (?, 'unplanned', 3, 'GET',
         'https://attacker.example/unplanned', '{}', ?, 'pending')`,
    ).bind(runId, "d".repeat(64)).run(),
  );
  const requestOwnerError = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE source_requests SET ingestion_run_id = ?
       WHERE ingestion_run_id = ? AND request_id = 'update-target'`,
    ).bind(ownerTargetRunId, runId).run(),
  );
  const planOwnerError = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE ingestion_evidence_plans SET ingestion_run_id = ?
       WHERE ingestion_run_id = ?`,
    ).bind(ownerTargetRunId, runId).run(),
  );

  expect([
    String(updateError),
    String(deleteError),
    String(insertError),
    String(unplannedInsertError),
    String(requestOwnerError),
    String(planOwnerError),
  ]).toEqual([
    expect.stringMatching(/source_request_plan_fields_immutable/),
    expect.stringMatching(/source_request_immutable/),
    expect.stringMatching(/source_request_not_in_immutable_plan/),
    expect.stringMatching(/source_request_not_in_immutable_plan/),
    expect.stringMatching(/source_request_plan_fields_immutable/),
    expect.stringMatching(/ingestion_evidence_plan_request_set_immutable/),
  ]);
});

test("an Official Source Collection Plan cannot freeze another run's discovery evidence", async () => {
  const sourceRunId = "run_collection_plan_discovery_source";
  const targetRunId = "run_collection_plan_discovery_target";
  const plan = JSON.stringify({
    requests: [
      {
        id: "discovery",
        method: "GET",
        url: "https://en.onepiece-cardgame.com/cardlist/",
        headers: {},
        representation_fingerprint: "1".repeat(64),
      },
    ],
  });
  await testEnv.CATALOGUE_DB.batch([
    ...[sourceRunId, targetRunId].map((runId, index) =>
      testEnv.CATALOGUE_DB.prepare(
        `INSERT INTO ingestion_runs (
           id, state, selected_games_json, started_at,
           expected_current_revision_id, linked_run_id, idempotency_key,
           candidate_json
         ) VALUES (?, 'collecting', '["one-piece"]',
           '2026-08-01T00:00:00.000Z', 'catrev_spine_000', NULL, ?, '{}')`,
      ).bind(runId, `collection-plan-owner-${index}`),
    ),
    ...[sourceRunId, targetRunId].map((runId) =>
      testEnv.CATALOGUE_DB.prepare(
        `INSERT INTO ingestion_evidence_plans (
           ingestion_run_id, source_lineage, supported_game,
           game_profile_version, adapter_version, request_plan_json,
           plan_origin
         ) VALUES (?, 'one-piece-en', 'one-piece', 'one-piece@1',
           'one-piece-json-document@1', ?, 'production')`,
      ).bind(runId, plan),
    ),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO source_requests (
         ingestion_run_id, request_id, sequence_number, method, url,
         request_headers_json, representation_fingerprint, state
       ) VALUES (?, 'discovery', 0, 'GET',
         'https://en.onepiece-cardgame.com/cardlist/', '{}', ?, 'observed')`,
    ).bind(sourceRunId, "1".repeat(64)),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO source_fetch_attempts (
         id, ingestion_run_id, request_id, attempt_number,
         requested_at, completed_at, outcome, http_status,
         response_headers_json, retry_after_ms, diagnostic
       ) VALUES ('srcfetch_collection_owner', ?, 'discovery', 1,
         '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:01.000Z',
         'success', 200, '{}', NULL, NULL)`,
    ).bind(sourceRunId),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO source_snapshots (
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
         'one-piece', 'one-piece@1', 'one-piece-json-document@1', NULL)`,
    ).bind(sourceRunId, "1".repeat(64), "2".repeat(64)),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO source_parse_operations (
         id, source_snapshot_id, adapter_version, intent,
         idempotency_key, observation_set_id, content_object_key,
         parsed_at, state, content_digest, content_byte_length,
         observation_count
       ) VALUES ('srcparse_collection_owner', 'srcsnap_collection_owner',
         'one-piece-json-document@1', 'collection',
         'collection-owner-parse', 'srcobsset_collection_owner',
         'source-observations/collection-owner.json',
         '2026-08-01T00:00:02.000Z', 'finalized', ?, 2, 1)`,
    ).bind("3".repeat(64)),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO source_observation_sets (
         id, parse_operation_id, source_snapshot_id, source_lineage,
         supported_game, game_profile_version, adapter_version, parsed_at,
         content_digest, content_byte_length, content_object_key,
         observation_count
       ) VALUES ('srcobsset_collection_owner',
         'srcparse_collection_owner', 'srcsnap_collection_owner',
         'one-piece-en', 'one-piece', 'one-piece@1',
         'one-piece-json-document@1', '2026-08-01T00:00:02.000Z', ?, 2,
         'source-observations/collection-owner.json', 1)`,
    ).bind("3".repeat(64)),
  ]);

  const collectionPlan = JSON.stringify({
    contract: "card-keepr-official-source-collection-plan@1",
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    game_profile_version: "one-piece@1",
    adapter_version: "one-piece-json-document@1",
    discovery_observation_set_id: "srcobsset_collection_owner",
    requests: [],
  });
  await expect(
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO official_source_collection_plans (
         ingestion_run_id, discovery_observation_set_id, contract,
         collection_plan_json, content_digest, created_at
       ) VALUES (?, 'srcobsset_collection_owner',
         'card-keepr-official-source-collection-plan@1', ?, ?,
         '2026-08-01T00:00:03.000Z')`,
    ).bind(
      sourceRunId,
      collectionPlan,
      `a${"Z".repeat(63)}`,
    ).run(),
  ).rejects.toThrow(/CHECK constraint failed/);
  await expect(
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO official_source_collection_plans (
         ingestion_run_id, discovery_observation_set_id, contract,
         collection_plan_json, content_digest, created_at
       ) VALUES (?, 'srcobsset_collection_owner',
         'card-keepr-official-source-collection-plan@1', ?, ?,
         '2026-08-01T00:00:03.000Z')`,
    ).bind(targetRunId, collectionPlan, "4".repeat(64)).run(),
  ).rejects.toThrow(
    /official_source_collection_plan_discovery_owner_mismatch/,
  );
});

test("an upgraded D1 enforces full lowercase digests and canonical revision rule identity", async () => {
  const legacyDatabase = testEnv.LEGACY_DB;
  const legalityMigration = testEnv.TEST_MIGRATIONS.at(-1);
  if (legalityMigration === undefined) {
    throw new Error("Legality migration is absent");
  }
  await applyD1Migrations(
    legacyDatabase,
    testEnv.TEST_MIGRATIONS.slice(0, -1),
  );
  await applyD1Migrations(legacyDatabase, [legalityMigration]);
  await legacyDatabase.prepare(
    `DROP TRIGGER official_source_collection_plan_discovery_owner`,
  ).run();

  const malformedDigest = await rejectedError(
    legacyDatabase.prepare(
      `INSERT INTO official_source_collection_plans (
        ingestion_run_id, discovery_observation_set_id, contract,
        collection_plan_json, content_digest, created_at
      ) VALUES ('run_missing', 'srcobsset_missing',
        'card-keepr-official-source-collection-plan@1', '{}', ?,
        '2026-08-01T00:00:00.000Z')`,
    ).bind(`a${"Z".repeat(63)}`).run(),
  );
  const validDigestMissingOwner = await rejectedError(
    legacyDatabase.prepare(
      `INSERT INTO official_source_collection_plans (
        ingestion_run_id, discovery_observation_set_id, contract,
        collection_plan_json, content_digest, created_at
      ) VALUES ('run_missing', 'srcobsset_missing',
        'card-keepr-official-source-collection-plan@1', '{}', ?,
        '2026-08-01T00:00:00.000Z')`,
    ).bind("a".repeat(64)).run(),
  );
  expect(String(malformedDigest)).toMatch(/CHECK constraint failed/);
  expect(String(validDigestMissingOwner)).toMatch(
    /official_source_collection_plan_discovery_owner_mismatch|FOREIGN KEY constraint failed/,
  );

  const foreignKeys = await legacyDatabase.prepare(
    `PRAGMA foreign_key_list(revision_legality_rules)`,
  ).all<{ table: string; from: string }>();
  expect(foreignKeys.results).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        table: "legality_rules",
        from: "legality_rule_id",
      }),
    ]),
  );
  const guards = await legacyDatabase.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'trigger' AND name IN (
       'guard_legality_rule_identity',
       'legality_rule_card_ids_canonical_insert',
       'legality_rule_card_ids_canonical_update',
       'legality_rule_provenance_owner_insert',
       'legality_rule_provenance_owner_update',
       'legality_rule_provenance_immutable',
       'legality_rules_immutable_delete',
       'revision_legality_rule_matches_canonical',
       'revision_legality_rules_immutable_delete',
       'revision_legality_rules_immutable_update'
     ) ORDER BY name`,
  ).all<{ name: string }>();
  expect(guards.results.map((row) => row.name)).toEqual([
    "guard_legality_rule_identity",
    "legality_rule_card_ids_canonical_insert",
    "legality_rule_card_ids_canonical_update",
    "legality_rule_provenance_immutable",
    "legality_rule_provenance_owner_insert",
    "legality_rule_provenance_owner_update",
    "legality_rules_immutable_delete",
    "revision_legality_rule_matches_canonical",
    "revision_legality_rules_immutable_delete",
    "revision_legality_rules_immutable_update",
  ]);

  const requestPlan = JSON.stringify({
    requests: [{
      id: "upgraded-legality",
      method: "GET",
      url: "https://en.onepiece-cardgame.com/rules/restriction/",
      headers: {},
      representation_fingerprint: "5".repeat(64),
    }],
  });
  const sourceFieldPointers = JSON.stringify({
    official_wording:
      "/observations/0/value/legality_rules/0/official_wording",
  });
  const upgradedRule = {
    id: "legality_rule_upgraded_guard",
    official_id: "upgraded-guard",
    game: "one-piece",
    region: "EN-OCEANIA",
    format: "standard",
    event_tier: null,
    effective_from: "2026-01-01",
    effective_until: null,
    card_ids: ["card_upgraded_guard"],
    official_wording: "The upgraded guard remains authoritative.",
    effect: {
      type: "prohibited_combination",
      with_card_ids: ["card_upgraded_companion"],
    },
    source_lineage: "one-piece-en",
    source_snapshot_id: "srcsnap_upgraded_legality_guard",
    source_observation_set_id: "srcobsset_upgraded_legality_guard",
    source_observation_id: "srcobs_upgraded_legality_guard",
    source_observation_pointer: "/observations/0/value/legality_rules/0",
    source_field_pointers: JSON.parse(sourceFieldPointers),
    first_revision_id: "catrev_upgraded_legality_guard",
    last_observed_revision_id: "catrev_upgraded_legality_guard",
    current: true,
    last_missing_revision_id: null,
  };
  await legacyDatabase.batch([
    legacyDatabase.prepare(
      `INSERT INTO ingestion_runs (
         id, state, selected_games_json, started_at,
         expected_current_revision_id, linked_run_id, idempotency_key,
         candidate_digest, candidate_created_at, approval_deadline,
         approval_json, candidate_json
       ) VALUES ('run_upgraded_legality_guard', 'publishing',
         '["one-piece"]', '2026-08-01T00:00:00.000Z',
         'catrev_spine_000', NULL, 'upgraded-legality-guard', ?,
         '2026-08-01T00:00:02.000Z', '2099-01-01T00:00:00.000Z', ?, '{}')`,
    ).bind(
      "8".repeat(64),
      JSON.stringify({
        candidate_digest: "8".repeat(64),
        expected_current_revision_id: "catrev_spine_000",
      }),
    ),
    legacyDatabase.prepare(
      `UPDATE operation_state
       SET active_ingestion_run_id = 'run_upgraded_legality_guard'
       WHERE singleton = 1`,
    ),
    legacyDatabase.prepare(
      `INSERT INTO ingestion_evidence_plans (
         ingestion_run_id, source_lineage, supported_game,
         game_profile_version, adapter_version, request_plan_json,
         plan_origin
       ) VALUES ('run_upgraded_legality_guard', 'one-piece-en',
         'one-piece', 'one-piece@1', 'one-piece-json-document@1', ?,
         'production')`,
    ).bind(requestPlan),
    legacyDatabase.prepare(
      `INSERT INTO source_requests (
         ingestion_run_id, request_id, sequence_number, method, url,
         request_headers_json, representation_fingerprint, state,
         source_snapshot_id
       ) VALUES ('run_upgraded_legality_guard', 'upgraded-legality', 0,
         'GET', 'https://en.onepiece-cardgame.com/rules/restriction/',
         '{}', ?, 'observed', 'srcsnap_upgraded_legality_guard')`,
    ).bind("5".repeat(64)),
    legacyDatabase.prepare(
      `INSERT INTO source_fetch_attempts (
         id, ingestion_run_id, request_id, attempt_number,
         requested_at, completed_at, outcome, http_status,
         response_headers_json, retry_after_ms, diagnostic
       ) VALUES ('srcfetch_upgraded_legality_guard',
         'run_upgraded_legality_guard', 'upgraded-legality', 1,
         '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:01.000Z',
         'success', 200, '{}', NULL, NULL)`,
    ),
    legacyDatabase.prepare(
      `INSERT INTO source_snapshots (
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
         'one-piece', 'one-piece@1', 'one-piece-json-document@1', NULL)`,
    ).bind("5".repeat(64), "6".repeat(64)),
    legacyDatabase.prepare(
      `INSERT INTO source_parse_operations (
         id, source_snapshot_id, adapter_version, intent,
         idempotency_key, observation_set_id, content_object_key,
         parsed_at, state, content_digest, content_byte_length,
         observation_count
       ) VALUES ('srcparse_upgraded_legality_guard',
         'srcsnap_upgraded_legality_guard', 'one-piece-json-document@1',
         'collection', 'upgraded-legality-guard-parse',
         'srcobsset_upgraded_legality_guard',
         'source-observations/upgraded-legality-guard.json',
         '2026-08-01T00:00:02.000Z', 'finalized', ?, 2, 1)`,
    ).bind("7".repeat(64)),
    legacyDatabase.prepare(
      `INSERT INTO source_observation_sets (
         id, parse_operation_id, source_snapshot_id, source_lineage,
         supported_game, game_profile_version, adapter_version, parsed_at,
         content_digest, content_byte_length, content_object_key,
         observation_count
       ) VALUES ('srcobsset_upgraded_legality_guard',
         'srcparse_upgraded_legality_guard',
         'srcsnap_upgraded_legality_guard', 'one-piece-en', 'one-piece',
         'one-piece@1', 'one-piece-json-document@1',
         '2026-08-01T00:00:02.000Z', ?, 2,
         'source-observations/upgraded-legality-guard.json', 1)`,
    ).bind("7".repeat(64)),
    legacyDatabase.prepare(
      `INSERT INTO catalogue_revisions (
         id, ingestion_run_id, published_at, content_digest,
         expected_previous_revision_id, approved_candidate_digest
       ) VALUES ('catrev_upgraded_legality_guard',
         'run_upgraded_legality_guard', '2026-08-01T00:00:03.000Z', ?,
         'catrev_spine_000', ?)`,
    ).bind("8".repeat(64), "8".repeat(64)),
    legacyDatabase.prepare(
      `INSERT INTO legality_rules (
         id, official_id, supported_game, region, format, event_tier,
         effective_from, effective_until, official_wording, effect_json,
         card_ids_json, direct_card_ids_json, source_lineage, source_snapshot_id,
         source_observation_set_id, source_observation_id,
         source_observation_pointer, source_field_pointers_json,
         first_revision_id, last_observed_revision_id, current,
         last_missing_revision_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         1, NULL)`,
    ).bind(
      upgradedRule.id,
      upgradedRule.official_id,
      upgradedRule.game,
      upgradedRule.region,
      upgradedRule.format,
      upgradedRule.event_tier,
      upgradedRule.effective_from,
      upgradedRule.effective_until,
      upgradedRule.official_wording,
      JSON.stringify(upgradedRule.effect),
      JSON.stringify([
        ...upgradedRule.card_ids,
        ...upgradedRule.effect.with_card_ids,
      ].sort()),
      JSON.stringify(upgradedRule.card_ids),
      upgradedRule.source_lineage,
      upgradedRule.source_snapshot_id,
      upgradedRule.source_observation_set_id,
      upgradedRule.source_observation_id,
      upgradedRule.source_observation_pointer,
      sourceFieldPointers,
      upgradedRule.first_revision_id,
      upgradedRule.last_observed_revision_id,
    ),
    legacyDatabase.prepare(
      `INSERT INTO revision_legality_rules (
         catalogue_revision_id, legality_rule_id, supported_game,
         region, format, event_tier, effective_from, effective_until,
         card_ids_json, document_json
       ) VALUES ('catrev_upgraded_legality_guard', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      upgradedRule.id,
      upgradedRule.game,
      upgradedRule.region,
      upgradedRule.format,
      upgradedRule.event_tier,
      upgradedRule.effective_from,
      upgradedRule.effective_until,
      JSON.stringify([
        ...upgradedRule.card_ids,
        ...upgradedRule.effect.with_card_ids,
      ].sort()),
      JSON.stringify(upgradedRule),
    ),
  ]);
  const upgradedCanonicalCardIdErrors =
    await canonicalLegalityCardIdInvariantErrors(
      legacyDatabase,
      {
        ...upgradedRule,
        effect_json: JSON.stringify(upgradedRule.effect),
        source_field_pointers_json: sourceFieldPointers,
      },
      "upgraded",
    );
  expect(upgradedCanonicalCardIdErrors.map(String)).toEqual(
    upgradedCanonicalCardIdErrors.map(() =>
      expect.stringMatching(/legality_rule_card_ids_not_canonical/),
    ),
  );
  const upgradedProvenanceMutation = await rejectedError(
    legacyDatabase.prepare(
      `UPDATE legality_rules
       SET source_snapshot_id = 'srcsnap_attacker'
       WHERE id = ?`,
    ).bind(upgradedRule.id).run(),
  );
  const upgradedCrossOwner = await rejectedError(
    legacyDatabase.prepare(
      `INSERT INTO legality_rules (
         id, official_id, supported_game, region, format, event_tier,
         effective_from, effective_until, official_wording, effect_json,
         card_ids_json, direct_card_ids_json, source_lineage, source_snapshot_id,
         source_observation_set_id, source_observation_id,
         source_observation_pointer, source_field_pointers_json,
         first_revision_id, last_observed_revision_id, current,
         last_missing_revision_id
       ) VALUES ('legality_rule_upgraded_cross_owner', 'cross-owner',
         'one-piece', 'EN-OCEANIA', 'standard', NULL, '2026-01-01', NULL,
         'Cross-owner rule.', '{"type":"ban"}', '[]', '[]', 'one-piece-en',
         'srcsnap_attacker', 'srcobsset_upgraded_legality_guard',
         'srcobs_attacker', '/observations/0/value/legality_rules/1', '{}',
         'catrev_upgraded_legality_guard',
         'catrev_upgraded_legality_guard', 1, NULL)`,
    ).run(),
  );
  const upgradedRevisionMutation = await rejectedError(
    legacyDatabase.prepare(
      `UPDATE revision_legality_rules SET format = 'attacker-format'
       WHERE catalogue_revision_id = 'catrev_upgraded_legality_guard'
         AND legality_rule_id = ?`,
    ).bind(upgradedRule.id).run(),
  );
  const upgradedRevisionDelete = await rejectedError(
    legacyDatabase.prepare(
      `DELETE FROM revision_legality_rules
       WHERE catalogue_revision_id = 'catrev_upgraded_legality_guard'
         AND legality_rule_id = ?`,
    ).bind(upgradedRule.id).run(),
  );
  const {
    event_tier: _missingUpgradedEventTier,
    ...upgradedWithoutNullableKey
  } = upgradedRule;
  const {
    effective_until: _replacedUpgradedEffectiveUntil,
    ...upgradedWithReplacementKey
  } = upgradedRule;
  const upgradedMissingNullableKey = await rejectedError(
    legacyDatabase.prepare(
      `INSERT INTO revision_legality_rules (
         catalogue_revision_id, legality_rule_id, supported_game,
         region, format, event_tier, effective_from, effective_until,
         card_ids_json, document_json
       ) VALUES ('catrev_upgraded_legality_guard', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      upgradedRule.id,
      upgradedRule.game,
      upgradedRule.region,
      upgradedRule.format,
      upgradedRule.event_tier,
      upgradedRule.effective_from,
      upgradedRule.effective_until,
      JSON.stringify(upgradedRule.card_ids),
      JSON.stringify(upgradedWithoutNullableKey),
    ).run(),
  );
  const upgradedArbitraryKeySubstitution = await rejectedError(
    legacyDatabase.prepare(
      `INSERT INTO revision_legality_rules (
         catalogue_revision_id, legality_rule_id, supported_game,
         region, format, event_tier, effective_from, effective_until,
         card_ids_json, document_json
       ) VALUES ('catrev_upgraded_legality_guard', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      upgradedRule.id,
      upgradedRule.game,
      upgradedRule.region,
      upgradedRule.format,
      upgradedRule.event_tier,
      upgradedRule.effective_from,
      upgradedRule.effective_until,
      JSON.stringify(upgradedRule.card_ids),
      JSON.stringify({
        ...upgradedWithReplacementKey,
        attacker_replacement: null,
      }),
    ).run(),
  );
  const upgradedDuplicateRequiredKey = await rejectedError(
    legacyDatabase.prepare(
      `INSERT INTO revision_legality_rules (
         catalogue_revision_id, legality_rule_id, supported_game,
         region, format, event_tier, effective_from, effective_until,
         card_ids_json, document_json
       ) VALUES ('catrev_upgraded_legality_guard', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      upgradedRule.id,
      upgradedRule.game,
      upgradedRule.region,
      upgradedRule.format,
      upgradedRule.event_tier,
      upgradedRule.effective_from,
      upgradedRule.effective_until,
      JSON.stringify(upgradedRule.card_ids),
      JSON.stringify(upgradedRule).replace(
        /\}$/u,
        ',"official_wording":"Attacker-controlled duplicate."}',
      ),
    ).run(),
  );
  const upgradedNestedDocuments = [
    { ...upgradedRule, card_ids: upgradedRule.card_ids[0] },
    {
      ...upgradedRule,
      card_ids: [upgradedRule.card_ids[0], upgradedRule.card_ids[0]],
    },
    {
      ...upgradedRule,
      card_ids: [
        ...upgradedRule.card_ids,
        ...upgradedRule.effect.with_card_ids,
      ],
    },
  ];
  const upgradedNestedCardIds = await Promise.all(
    upgradedNestedDocuments.map((document) =>
      rejectedError(
        legacyDatabase.prepare(
          `INSERT INTO revision_legality_rules (
             catalogue_revision_id, legality_rule_id, supported_game,
             region, format, event_tier, effective_from, effective_until,
             card_ids_json, document_json
           ) VALUES ('catrev_upgraded_legality_guard', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          upgradedRule.id,
          upgradedRule.game,
          upgradedRule.region,
          upgradedRule.format,
          upgradedRule.event_tier,
          upgradedRule.effective_from,
          upgradedRule.effective_until,
          JSON.stringify([
            ...upgradedRule.card_ids,
            ...upgradedRule.effect.with_card_ids,
          ]),
          JSON.stringify(document),
        ).run(),
      )
    ),
  );
  expect([
    String(upgradedProvenanceMutation),
    String(upgradedCrossOwner),
    String(upgradedRevisionMutation),
    String(upgradedRevisionDelete),
    String(upgradedMissingNullableKey),
    String(upgradedArbitraryKeySubstitution),
    String(upgradedDuplicateRequiredKey),
    ...upgradedNestedCardIds.map(String),
  ]).toEqual([
    expect.stringMatching(/legality_rule_provenance_immutable/),
    expect.stringMatching(/legality_rule_provenance_owner_mismatch/),
    expect.stringMatching(/revision_legality_rule_immutable/),
    expect.stringMatching(/revision_legality_rule_immutable/),
    expect.stringMatching(/revision_legality_rule_canonical_mismatch/),
    expect.stringMatching(/revision_legality_rule_canonical_mismatch/),
    expect.stringMatching(/revision_legality_rule_canonical_mismatch/),
    expect.stringMatching(/revision_legality_rule_canonical_mismatch/),
    expect.stringMatching(/revision_legality_rule_canonical_mismatch/),
    expect.stringMatching(/revision_legality_rule_canonical_mismatch/),
  ]);
});

test.each([
  ["one-piece-json-document@999", "one-piece", "one-piece-en"],
  ["fusion-world-en@999", "fusion-world", "fusion-world-en"],
  ["digimon-en@999", "digimon", "digimon-en"],
  ["gundam-en-asia@999", "gundam", "gundam-en-asia"],
  ["gundam-en-us@999", "gundam", "gundam-en-us"],
])(
  "production planning rejects the unregistered %s publisher representation",
  async (adapter, game, lineage) => {
    const blocked = await request("/v1/ingestion-runs/evidence", {
      supported_game: game,
      source_lineage: lineage,
      adapter_version: adapter,
      idempotency_key: `reject-undemonstrated-${adapter}`,
      requests: [
        {
          id: "discovery",
          method: "GET",
          url: officialAdapterUrl(adapter, "contextual-legality-asia"),
          headers: { accept: "application/json" },
        },
      ],
    });
    expect(blocked.response.status).toBe(422);
    expect(blocked.document).toMatchObject({
      code: "adapter_not_supported",
    });
  },
);

test.each([
  ["one-piece-normalized-envelope@1", "one-piece", "one-piece-en"],
  ["one-piece-normalized-envelope@2", "one-piece", "one-piece-en"],
  ["fusion-world-normalized-envelope@1", "fusion-world", "fusion-world-en"],
  ["digimon-normalized-envelope@1", "digimon", "digimon-en"],
  ["gundam-asia-normalized-envelope@1", "gundam", "gundam-en-asia"],
  ["gundam-us-normalized-envelope@1", "gundam", "gundam-en-us"],
])(
  "production planning rejects unavailable adapter identity %s before capture",
  async (adapter, game, lineage) => {
    const idempotencyKey = `reject-unavailable-${adapter}`;
    const blocked = await request("/v1/ingestion-runs/evidence", {
      supported_game: game,
      source_lineage: lineage,
      adapter_version: adapter,
      idempotency_key: idempotencyKey,
      requests: [
        {
          id: "discovery",
          method: "GET",
          url: "https://official-source.invalid/normalized-envelope",
          headers: { accept: "application/json" },
        },
      ],
    });
    expect(blocked.response.status).toBe(422);
    expect(blocked.document).toMatchObject({
      code: "adapter_not_supported",
    });
    const retained = await testEnv.CATALOGUE_DB.prepare(
      `SELECT COUNT(*) AS count FROM ingestion_runs
       WHERE idempotency_key = ?`,
    ).bind(idempotencyKey).first<{ count: number }>();
    expect(retained?.count).toBe(0);
  },
);

test("authenticated reparse rejects a normalized fixture envelope through an unavailable production adapter", async () => {
  const runId = "run_unavailable_adapter_raw_boundary";
  const snapshotId = "srcsnap_unavailable_adapter_raw_boundary";
  const objectKey = `source-snapshots/${snapshotId}.bin`;
  const bytes = utf8(JSON.stringify({
    cards: [
      {
        card: {
          game: "one-piece",
          official_identity: { kind: "card_number", value: "OP99-999" },
        },
      },
    ],
    legality_rules: [
      {
        id: "normalized-effect-that-production-must-not-accept",
        effect: { type: "ban" },
      },
    ],
  }));
  const digest = await sha256(bytes);
  const plan = JSON.stringify({
    requests: [
      {
        id: "raw-boundary",
        method: "GET",
        url: "https://official-source.invalid/normalized-envelope",
        headers: {},
        representation_fingerprint: "5".repeat(64),
      },
    ],
  });
  await testEnv.EVIDENCE_OBJECTS.put(objectKey, bytes);
  await testEnv.CATALOGUE_DB.batch([
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO ingestion_runs (
         id, state, selected_games_json, started_at,
         expected_current_revision_id, linked_run_id, idempotency_key,
         candidate_json
       ) VALUES (?, 'parsing', '["one-piece"]',
         '2026-08-01T00:00:00.000Z', 'catrev_spine_000', NULL, ?, '{}')`,
    ).bind(runId, "unavailable-adapter-raw-boundary"),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO ingestion_evidence_plans (
         ingestion_run_id, source_lineage, supported_game,
         game_profile_version, adapter_version, request_plan_json,
         plan_origin
       ) VALUES (?, 'one-piece-en', 'one-piece', 'one-piece@1',
         'fixture-one-piece-json@1', ?, 'synthetic_fixture')`,
    ).bind(runId, plan),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO source_requests (
         ingestion_run_id, request_id, sequence_number, method, url,
         request_headers_json, representation_fingerprint, state,
         source_snapshot_id
       ) VALUES (?, 'raw-boundary', 0, 'GET',
         'https://official-source.invalid/normalized-envelope', '{}', ?,
         'observed', ?)`,
    ).bind(runId, "5".repeat(64), snapshotId),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO source_fetch_attempts (
         id, ingestion_run_id, request_id, attempt_number,
         requested_at, completed_at, outcome, http_status,
         response_headers_json, retry_after_ms, diagnostic
       ) VALUES ('srcfetch_unavailable_adapter_raw_boundary', ?,
         'raw-boundary', 1, '2026-08-01T00:00:00.000Z',
         '2026-08-01T00:00:01.000Z', 'success', 200, '{}', NULL, NULL)`,
    ).bind(runId),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO source_snapshots (
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
         'fixture-one-piece-json@1', NULL)`,
    ).bind(
      snapshotId,
      runId,
      "5".repeat(64),
      digest,
      bytes.byteLength,
      objectKey,
    ),
  ]);

  const blocked = await request(
    `/v1/source-snapshots/${snapshotId}/observations`,
    {
      adapter_version: "one-piece-normalized-envelope@1",
      idempotency_key: "unavailable-adapter-raw-boundary-reparse",
    },
  );
  expect(blocked.response.status).toBe(422);
  expect(blocked.document).toMatchObject({ code: "adapter_not_supported" });
  const retained = await testEnv.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM source_parse_operations
     WHERE source_snapshot_id = ?`,
  ).bind(snapshotId).first<{ count: number }>();
  expect(retained?.count).toBe(0);
});

test("an unfetched nested image URL cannot enter through an unregistered production representation", async () => {
  const blocked = await request("/v1/ingestion-runs/evidence", {
    supported_game: "gundam",
    source_lineage: "gundam-en-asia",
    adapter_version: "gundam-en-asia@999",
    idempotency_key: "reject-unfetched-image-identity",
    requests: [
      {
        id: "discovery",
        method: "GET",
        url:
          "https://www.gundam-gcg.com/asia-en/reconciliation/contextual-legality-unfetched-image",
        headers: { accept: "application/json" },
      },
    ],
  });
  expect(blocked.response.status).toBe(422);
  expect(blocked.document).toMatchObject({
    code: "adapter_not_supported",
  });
});

test("a nested Fusion World image candidate cannot enter through an unregistered representation", async () => {
  const blocked = await request("/v1/ingestion-runs/evidence", {
    supported_game: "fusion-world",
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@999",
    idempotency_key: "reject-unverified-fusion-world-image-list",
    requests: [
      {
        id: "discovery",
        method: "GET",
        url:
          "https://www.dbs-cardgame.com/fw/en/reconciliation/contextual-legality-secondary-foreign-image",
        headers: { accept: "application/json" },
      },
    ],
  });
  expect(blocked.response.status).toBe(422);
  expect(blocked.document).toMatchObject({
    code: "adapter_not_supported",
  });
});

test.each([
  "copy-count",
  "companion-card",
  "membership-value",
  "rotation-block",
  "release-date",
])(
  "invented JSON cannot claim official wording agrees with a structured %s operand",
  async (operand) => {
    const blocked = await request("/v1/ingestion-runs/evidence", {
      supported_game: "gundam",
      source_lineage: "gundam-en-asia",
      adapter_version: "gundam-en-asia@999",
      idempotency_key: `reject-structured-${operand}`,
      requests: [
        {
          id: "discovery",
          method: "GET",
          url:
            `https://www.gundam-gcg.com/asia-en/reconciliation/contextual-legality-${operand}-operand-mismatch`,
          headers: { accept: "application/json" },
        },
      ],
    });
    expect(blocked.response.status).toBe(422);
    expect(blocked.document).toMatchObject({
      code: "adapter_not_supported",
    });
  },
);

test("test-owned domain evidence publishes exact Legality Rules and keeps still-effective history applicable", async () => {
  const first = await collectFixtureLegality(
    "https://official-source.invalid/reconciliation/contextual-legality-domain",
    "contextual-legality-domain-current",
  );
  expect(first.reconciled).toMatchObject({
    state: "awaiting_approval",
    publishable: true,
    legality_rules: expect.arrayContaining([
      expect.objectContaining({
        official_id: "legality_rule_asia_copy_limit",
        effect: { type: "copy_limit", maximum_copies: 1 },
      }),
      expect.objectContaining({
        official_id: "legality_rule_asia_combination",
        effect: expect.objectContaining({
          type: "prohibited_combination",
        }),
      }),
      expect.objectContaining({
        official_id: "legality_rule_asia_membership",
        effect: {
          type: "membership",
          attribute: "traits",
          includes_any: ["Earth Federation"],
        },
      }),
      expect.objectContaining({
        official_id: "legality_rule_asia_rotation",
        effect: { type: "rotation", eligible_blocks: ["1"] },
      }),
      expect.objectContaining({
        official_id: "legality_rule_asia_release_timing",
        effect: { type: "release_timing", legal_from: "2026-01-01" },
      }),
      expect.objectContaining({
        official_id: "legality_rule_asia_unresolved_scope",
        effect: expect.objectContaining({ type: "unresolved" }),
      }),
    ]),
  });
  const retainedRules = first.reconciled.legality_rules as Array<
    Record<string, unknown>
  >;
  const retainedPointers = retainedRules.map((rule) =>
    requiredString(rule, "source_observation_pointer")
  );
  const retainedDocument = await request(
    `/v1/source-observation-sets/${requiredString(retainedRules[0]!, "source_observation_set_id")}/content`,
  );
  expect(retainedDocument.response.status).toBe(200);
  expect(new Set(retainedPointers).size).toBe(retainedRules.length);
  for (const rule of retainedRules) {
    const pointer = requiredString(rule, "source_observation_pointer");
    expect(pointer).toMatch(
      /^\/observations\/\d+\/value\/legality_rules\/\d+$/,
    );
    expect(rule.source_field_pointers).toEqual({
      official_wording: `${pointer}/official_wording`,
      effective_from: `${pointer}/effective_from`,
      effective_until: `${pointer}/effective_until`,
      region: `${pointer}/region`,
      format: `${pointer}/format`,
      event_tier: `${pointer}/event_tier`,
      card_numbers: `${pointer}/card_numbers`,
      effect: `${pointer}/effect`,
    });
    for (const [field, fieldPointer] of Object.entries(
      rule.source_field_pointers as Record<string, string>,
    )) {
      const sourceValue = resolveJsonPointer(
        retainedDocument.document,
        fieldPointer,
      );
      expect(sourceValue).not.toBeUndefined();
      if (
        field !== "card_numbers" &&
        field !== "effect"
      ) {
        expect(sourceValue).toEqual(rule[field]);
      }
    }
  }
  const copyLimit = retainedRules.find(
    (rule) => rule.official_id === "legality_rule_asia_copy_limit",
  );
  const combination = retainedRules.find(
    (rule) => rule.official_id === "legality_rule_asia_combination",
  );
  expect(copyLimit).toBeDefined();
  expect(combination).toBeDefined();
  expect(copyLimit!.source_observation_id).toBe(
    combination!.source_observation_id,
  );
  expect(copyLimit!.source_observation_pointer).not.toBe(
    combination!.source_observation_pointer,
  );
  const published = await approve(first.reconciled, "publish-current-rules");
  expect(published.response.status).toBe(200);

  const omitted = await collectFixtureLegality(
    "https://official-source.invalid/reconciliation/contextual-legality-domain?rules=omitted",
    "contextual-legality-domain-omitted",
  );
  expect(omitted.reconciled.legality_rules).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        official_id: "legality_rule_asia_eligible",
        current: true,
      }),
    ]),
  );
  const omittedPublished = await approve(
    omitted.reconciled,
    "publish-omitted-rules",
  );
  expect(omittedPublished.response.status).toBe(200);
  const omittedRule = await revisionLegalityRule(
    requiredString(omittedPublished.document, "resulting_revision_id"),
    "legality_rule_asia_eligible",
  );
  expect(omittedRule).toMatchObject({ current: true });

  const empty = await collectFixtureLegality(
    "https://official-source.invalid/reconciliation/contextual-legality-domain?rules=empty",
    "contextual-legality-domain-empty",
  );
  const emptyPublished = await approve(
    empty.reconciled,
    "publish-empty-rules",
  );
  expect(emptyPublished.response.status).toBe(200);
  const card = (empty.reconciled.cards as Array<Record<string, unknown>>)
    .find((candidate) =>
      (candidate.official_identity as Record<string, unknown>).value ===
        "GD30-001"
    );
  if (card === undefined) throw new Error("GD30-001 is absent");
  const eligible = await revisionLegalityRule(
    requiredString(emptyPublished.document, "resulting_revision_id"),
    "legality_rule_asia_eligible",
  );
  expect(eligible).toMatchObject({ current: false });

  const response = await contextualLegalityStatusResponse(
    new Request(
      `https://card-keepr.invalid/v1/legality-status?card_id=${requiredString(card, "id")}&on=2026-07-30&format=standard&event_tier=championship&region=EN-ASIA`,
    ),
    testEnv.CATALOGUE_DB,
  );
  expect(response.status).toBe(200);
  const status = await response.json() as {
    data: Array<{ status: string; rule_ids: string[] }>;
  };
  expect(status.data[0]).toMatchObject({ status: "legal" });
  expect(status.data[0]!.rule_ids).toContain(requiredString(eligible!, "id"));

  const canonicalRules = await testEnv.CATALOGUE_DB.prepare(
    `SELECT id FROM legality_rules ORDER BY id LIMIT 3`,
  ).all<{ id: string }>();
  expect(canonicalRules.results).toHaveLength(3);
  const [idMutable, firstRevisionMutable, deleteMutable] =
    canonicalRules.results;
  const identityUpdate = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE legality_rules SET id = ? WHERE id = ?`,
    ).bind(`${idMutable!.id}_changed`, idMutable!.id).run(),
  );
  const firstRevisionUpdate = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE legality_rules SET first_revision_id = ? WHERE id = ?`,
    ).bind(
      requiredString(emptyPublished.document, "resulting_revision_id"),
      firstRevisionMutable!.id,
    ).run(),
  );
  const canonicalDelete = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `DELETE FROM legality_rules WHERE id = ?`,
    ).bind(deleteMutable!.id).run(),
  );
  const orphanRevisionRule = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO revision_legality_rules (
         catalogue_revision_id, legality_rule_id, supported_game,
         region, format, event_tier, effective_from, effective_until,
         card_ids_json, document_json
       ) VALUES (?, 'legality_rule_missing_canonical', 'gundam',
         'EN-ASIA', 'standard', NULL, '2026-01-01', NULL, '[]', ?)`,
    ).bind(
      requiredString(emptyPublished.document, "resulting_revision_id"),
      JSON.stringify({
        id: "legality_rule_missing_canonical",
        official_id: "missing-canonical",
      }),
    ).run(),
  );
  const canonicalSnapshot = await testEnv.CATALOGUE_DB.prepare(
    `SELECT canonical.*, revision.document_json
     FROM legality_rules AS canonical
     JOIN revision_legality_rules AS revision
       ON revision.legality_rule_id = canonical.id
     WHERE revision.catalogue_revision_id = ?
       AND json_extract(canonical.effect_json, '$.type') =
       'prohibited_combination'
     ORDER BY canonical.id
     LIMIT 1`,
  ).bind(
    requiredString(emptyPublished.document, "resulting_revision_id"),
  ).first<Record<string, string | number | null>>();
  if (canonicalSnapshot === null) {
    throw new Error("Published canonical Legality Rule is absent");
  }
  const freshCanonicalCardIdErrors =
    await canonicalLegalityCardIdInvariantErrors(
      testEnv.CATALOGUE_DB,
      canonicalSnapshot,
      "fresh",
    );
  expect(freshCanonicalCardIdErrors.map(String)).toEqual(
    freshCanonicalCardIdErrors.map(() =>
      expect.stringMatching(/legality_rule_card_ids_not_canonical/),
    ),
  );
  const revisionUpdate = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE revision_legality_rules
       SET format = 'attacker-format'
       WHERE catalogue_revision_id = ? AND legality_rule_id = ?`,
    ).bind(
      requiredString(emptyPublished.document, "resulting_revision_id"),
      canonicalSnapshot.id,
    ).run(),
  );
  const revisionDelete = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `DELETE FROM revision_legality_rules
       WHERE catalogue_revision_id = ? AND legality_rule_id = ?`,
    ).bind(
      requiredString(emptyPublished.document, "resulting_revision_id"),
      canonicalSnapshot.id,
    ).run(),
  );
  const inconsistentRevisionContext = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO revision_legality_rules (
         catalogue_revision_id, legality_rule_id, supported_game,
         region, format, event_tier, effective_from, effective_until,
         card_ids_json, document_json
       ) VALUES ('catrev_spine_000', ?, ?, ?, 'attacker-format', ?, ?, ?,
         ?, ?)`,
    ).bind(
      canonicalSnapshot.id,
      canonicalSnapshot.supported_game,
      canonicalSnapshot.region,
      canonicalSnapshot.event_tier,
      canonicalSnapshot.effective_from,
      canonicalSnapshot.effective_until,
      canonicalSnapshot.card_ids_json,
      canonicalSnapshot.document_json,
    ).run(),
  );
  const inconsistentDocument = JSON.stringify({
    ...JSON.parse(String(canonicalSnapshot.document_json)),
    official_wording: "Attacker-controlled wording.",
  });
  const inconsistentRevisionDocument = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO revision_legality_rules (
         catalogue_revision_id, legality_rule_id, supported_game,
         region, format, event_tier, effective_from, effective_until,
         card_ids_json, document_json
       ) VALUES ('catrev_spine_000', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      canonicalSnapshot.id,
      canonicalSnapshot.supported_game,
      canonicalSnapshot.region,
      canonicalSnapshot.format,
      canonicalSnapshot.event_tier,
      canonicalSnapshot.effective_from,
      canonicalSnapshot.effective_until,
      canonicalSnapshot.card_ids_json,
      inconsistentDocument,
    ).run(),
  );
  const canonicalDocument = JSON.parse(
    String(canonicalSnapshot.document_json),
  ) as Record<string, unknown>;
  const {
    event_tier: _missingEventTier,
    ...documentWithoutNullableKey
  } = canonicalDocument;
  const {
    effective_until: _replacedEffectiveUntil,
    ...documentWithReplacementKey
  } = canonicalDocument;
  const missingNullableDocumentKey = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO revision_legality_rules (
         catalogue_revision_id, legality_rule_id, supported_game,
         region, format, event_tier, effective_from, effective_until,
         card_ids_json, document_json
       ) VALUES ('catrev_spine_000', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      canonicalSnapshot.id,
      canonicalSnapshot.supported_game,
      canonicalSnapshot.region,
      canonicalSnapshot.format,
      canonicalSnapshot.event_tier,
      canonicalSnapshot.effective_from,
      canonicalSnapshot.effective_until,
      canonicalSnapshot.card_ids_json,
      JSON.stringify(documentWithoutNullableKey),
    ).run(),
  );
  const arbitraryDocumentKeySubstitution = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO revision_legality_rules (
         catalogue_revision_id, legality_rule_id, supported_game,
         region, format, event_tier, effective_from, effective_until,
         card_ids_json, document_json
       ) VALUES ('catrev_spine_000', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      canonicalSnapshot.id,
      canonicalSnapshot.supported_game,
      canonicalSnapshot.region,
      canonicalSnapshot.format,
      canonicalSnapshot.event_tier,
      canonicalSnapshot.effective_from,
      canonicalSnapshot.effective_until,
      canonicalSnapshot.card_ids_json,
      JSON.stringify({
        ...documentWithReplacementKey,
        attacker_replacement: null,
      }),
    ).run(),
  );
  const duplicateRequiredDocumentKey = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO revision_legality_rules (
         catalogue_revision_id, legality_rule_id, supported_game,
         region, format, event_tier, effective_from, effective_until,
         card_ids_json, document_json
       ) VALUES ('catrev_spine_000', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      canonicalSnapshot.id,
      canonicalSnapshot.supported_game,
      canonicalSnapshot.region,
      canonicalSnapshot.format,
      canonicalSnapshot.event_tier,
      canonicalSnapshot.effective_from,
      canonicalSnapshot.effective_until,
      canonicalSnapshot.card_ids_json,
      String(canonicalSnapshot.document_json).replace(
        /\}$/u,
        ',"official_wording":"Attacker-controlled duplicate."}',
      ),
    ).run(),
  );
  const canonicalCombinationDocument = JSON.parse(
    String(canonicalSnapshot.document_json),
  ) as Record<string, unknown>;
  const canonicalDirectCardIds = canonicalCombinationDocument.card_ids as string[];
  const canonicalEffect = canonicalCombinationDocument.effect as {
    type: string;
    with_card_ids: string[];
  };
  const nestedCardIdDocuments = [
    {
      ...canonicalCombinationDocument,
      card_ids: canonicalDirectCardIds[0],
    },
    {
      ...canonicalCombinationDocument,
      card_ids: [canonicalDirectCardIds[0], canonicalDirectCardIds[0]],
    },
    {
      ...canonicalCombinationDocument,
      card_ids: [
        ...canonicalDirectCardIds,
        ...canonicalEffect.with_card_ids,
      ],
    },
  ];
  const nestedCardIdMutations = await Promise.all(
    nestedCardIdDocuments.map((document) =>
      rejectedError(
        testEnv.CATALOGUE_DB.prepare(
          `INSERT INTO revision_legality_rules (
             catalogue_revision_id, legality_rule_id, supported_game,
             region, format, event_tier, effective_from, effective_until,
             card_ids_json, document_json
           ) VALUES ('catrev_spine_000', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          canonicalSnapshot.id,
          canonicalSnapshot.supported_game,
          canonicalSnapshot.region,
          canonicalSnapshot.format,
          canonicalSnapshot.event_tier,
          canonicalSnapshot.effective_from,
          canonicalSnapshot.effective_until,
          canonicalSnapshot.card_ids_json,
          JSON.stringify(document),
        ).run(),
      )
    ),
  );
  const provenanceOwners = await testEnv.CATALOGUE_DB.prepare(
    `SELECT id, source_snapshot_id
     FROM source_observation_sets
     ORDER BY id`,
  ).all<{ id: string; source_snapshot_id: string }>();
  const firstOwner = provenanceOwners.results[0];
  const differentOwner = provenanceOwners.results.find(
    (row) => row.source_snapshot_id !== firstOwner?.source_snapshot_id,
  );
  if (firstOwner === undefined || differentOwner === undefined) {
    throw new Error("Distinct provenance owners are absent");
  }
  const provenanceUpdate = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE legality_rules SET source_snapshot_id = ? WHERE id = ?`,
    ).bind(differentOwner.source_snapshot_id, canonicalSnapshot.id).run(),
  );
  const crossOwnedProvenance = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO legality_rules (
         id, official_id, supported_game, region, format, event_tier,
         effective_from, effective_until, official_wording, effect_json,
         card_ids_json, direct_card_ids_json, source_lineage, source_snapshot_id,
         source_observation_set_id, source_observation_id,
         source_observation_pointer, source_field_pointers_json,
         first_revision_id, last_observed_revision_id, current,
         last_missing_revision_id
       ) VALUES ('legality_rule_cross_owned', 'cross-owned', ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, ?, 'srcobs_cross_owned',
         '/observations/0/value/legality_rules/0', ?, ?, ?, 1, NULL)`,
    ).bind(
      canonicalSnapshot.supported_game,
      canonicalSnapshot.region,
      canonicalSnapshot.format,
      canonicalSnapshot.event_tier,
      canonicalSnapshot.effective_from,
      canonicalSnapshot.effective_until,
      canonicalSnapshot.official_wording,
      canonicalSnapshot.effect_json,
      canonicalSnapshot.card_ids_json,
      canonicalSnapshot.direct_card_ids_json,
      canonicalSnapshot.source_lineage,
      firstOwner.source_snapshot_id,
      differentOwner.id,
      canonicalSnapshot.source_field_pointers_json,
      canonicalSnapshot.first_revision_id,
      canonicalSnapshot.last_observed_revision_id,
    ).run(),
  );
  expect([
    String(identityUpdate),
    String(firstRevisionUpdate),
    String(canonicalDelete),
    String(orphanRevisionRule),
    String(revisionUpdate),
    String(revisionDelete),
    String(inconsistentRevisionContext),
    String(inconsistentRevisionDocument),
    String(missingNullableDocumentKey),
    String(arbitraryDocumentKeySubstitution),
    String(duplicateRequiredDocumentKey),
    ...nestedCardIdMutations.map(String),
    String(provenanceUpdate),
    String(crossOwnedProvenance),
  ]).toEqual([
    expect.stringMatching(/legality_rule_identity_conflict/),
    expect.stringMatching(/legality_rule_identity_conflict/),
    expect.stringMatching(/legality_rule_immutable/),
    expect.stringMatching(/revision_legality_rule_canonical_mismatch/),
    expect.stringMatching(/revision_legality_rule_immutable/),
    expect.stringMatching(/revision_legality_rule_immutable/),
    expect.stringMatching(/revision_legality_rule_canonical_mismatch/),
    expect.stringMatching(/revision_legality_rule_canonical_mismatch/),
    expect.stringMatching(/revision_legality_rule_canonical_mismatch/),
    expect.stringMatching(/revision_legality_rule_canonical_mismatch/),
    expect.stringMatching(/revision_legality_rule_canonical_mismatch/),
    expect.stringMatching(/revision_legality_rule_canonical_mismatch/),
    expect.stringMatching(/revision_legality_rule_canonical_mismatch/),
    expect.stringMatching(/revision_legality_rule_canonical_mismatch/),
    expect.stringMatching(/legality_rule_provenance_immutable/),
    expect.stringMatching(/legality_rule_provenance_owner_mismatch/),
  ]);
  const immutableResponse = await contextualLegalityStatusResponse(
    new Request(
      `https://card-keepr.invalid/v1/legality-status?card_id=${requiredString(card, "id")}&on=2026-07-30&format=standard&event_tier=championship&region=EN-ASIA`,
    ),
    testEnv.CATALOGUE_DB,
  );
  expect(immutableResponse.status).toBe(200);
  expect(await immutableResponse.json()).toEqual(status);

  const reappeared = await collectFixtureLegality(
    "https://official-source.invalid/reconciliation/contextual-legality-domain?rules=current",
    "contextual-legality-domain-reappeared-provenance",
  );
  const reappearedCandidateRule = (
    reappeared.reconciled.legality_rules as Array<Record<string, unknown>>
  ).find((rule) => rule.official_id === "legality_rule_asia_eligible");
  if (reappearedCandidateRule === undefined) {
    throw new Error("Reappeared Legality Rule is absent");
  }
  const reappearedPublished = await approve(
    reappeared.reconciled,
    "publish-reappeared-provenance",
  );
  const reappearedRevisionId = requiredString(
    reappearedPublished.document,
    "resulting_revision_id",
  );
  const revisionRule = await revisionLegalityRule(
    reappearedRevisionId,
    "legality_rule_asia_eligible",
  );
  if (revisionRule === undefined) {
    throw new Error("Revision Legality Rule is absent");
  }
  const exportRule = await exportedLegalityRule(
    reappearedRevisionId,
    "legality_rule_asia_eligible",
  );
  const reappearedApiResponse = await contextualLegalityStatusResponse(
    new Request(
      `https://card-keepr.invalid/v1/legality-status?card_id=${requiredString(card, "id")}&on=2026-07-30&format=standard&event_tier=championship&region=EN-ASIA`,
    ),
    testEnv.CATALOGUE_DB,
  );
  const reappearedStatus = await reappearedApiResponse.json() as {
    data: Array<{ rule_ids: string[] }>;
  };
  const canonicalProvenance = {
    source_lineage: revisionRule.source_lineage,
    source_observation_id: revisionRule.source_observation_id,
    source_observation_pointer: revisionRule.source_observation_pointer,
    source_field_pointers: revisionRule.source_field_pointers,
  };
  const exportedProvenance = {
    source_lineage: exportRule.source_lineage,
    source_observation_id:
      (exportRule.source_observation_ids as unknown[])[0],
    source_observation_pointer: exportRule.source_observation_pointer,
    source_field_pointers: exportRule.source_field_pointers,
  };
  expect(reappearedCandidateRule.source_observation_id).not.toBe(
    revisionRule.source_observation_id,
  );
  expect(canonicalJson(exportedProvenance)).toBe(
    canonicalJson(canonicalProvenance),
  );
  expect(reappearedApiResponse.status).toBe(200);
  expect(reappearedStatus.data[0]!.rule_ids).toContain(
    requiredString(revisionRule, "id"),
  );
});

test.each(["event-tier", "effective-until"])(
  "nullable legality field %s must be explicitly retained for exact provenance",
  async (field) => {
    const collected = await collectFixtureLegality(
      `https://official-source.invalid/reconciliation/contextual-legality-domain?rules=omit-${field}`,
      `contextual-legality-domain-omit-${field}`,
      409,
    );
    expect(collected.reconciled).toMatchObject({
      state: "failed",
      publishable: false,
      diagnostics: [
        expect.objectContaining({
          code: "retained_evidence_invalid",
          detail: expect.stringContaining(
            field === "event-tier" ? "event_tier" : "effective_until",
          ),
        }),
      ],
    });
  },
);

test.each(["missing", "false"])(
  "an observed fixture legality wrapper with %s completeness cannot carry prior rules across an unrelated card change",
  async (variant) => {
    const initial = await collectFixtureLegality(
      "https://official-source.invalid/reconciliation/contextual-legality-domain",
      `incomplete-legality-${variant}-initial`,
    );
    const published = await approve(
      initial.reconciled,
      `incomplete-legality-${variant}-publish-initial`,
    );
    expect(published.response.status).toBe(200);
    const currentBefore = await testEnv.CATALOGUE_DB.prepare(
      `SELECT current_revision_id FROM catalogue_state WHERE singleton = 1`,
    ).first();
    const freshnessBefore = (await testEnv.CATALOGUE_DB.prepare(
      `SELECT * FROM source_freshness ORDER BY game, area`,
    ).all()).results;
    const initialEvidence = await testEnv.CATALOGUE_DB.prepare(
      `SELECT observations.content_object_key
       FROM source_observation_sets AS observations
       JOIN source_snapshots AS snapshots
         ON snapshots.id = observations.source_snapshot_id
       WHERE snapshots.ingestion_run_id = ?`,
    ).bind(initial.runId).first<{ content_object_key: string }>();
    const initialObject = await testEnv.EVIDENCE_OBJECTS.get(
      initialEvidence?.content_object_key ?? "",
    );
    if (initialObject === null) throw new Error("Initial evidence is absent");
    const initialDocument = await initialObject.json<{
      observations: Array<{ value: Record<string, unknown> }>;
    }>();
    const retainedWrapper = initialDocument.observations.find(
      (observation) =>
        observation.value.observation_type === "legality_rules",
    )?.value;
    if (retainedWrapper === undefined) {
      throw new Error("Initial legality wrapper is absent");
    }

    const runId = await collectFixtureLegalityEvidence(
      "https://official-source.invalid/reconciliation/contextual-legality-domain?rules=omitted",
      `incomplete-legality-${variant}-changed`,
    );
    const retained = await testEnv.CATALOGUE_DB.prepare(
      `SELECT observations.id, observations.parse_operation_id,
              observations.content_object_key
       FROM source_observation_sets AS observations
       JOIN source_snapshots AS snapshots
         ON snapshots.id = observations.source_snapshot_id
       WHERE snapshots.ingestion_run_id = ?`,
    ).bind(runId).first<{
      id: string;
      parse_operation_id: string;
      content_object_key: string;
    }>();
    if (retained === null) throw new Error("Changed evidence is absent");
    const changedObject = await testEnv.EVIDENCE_OBJECTS.get(
      retained.content_object_key,
    );
    if (changedObject === null) throw new Error("Changed bytes are absent");
    const changedDocument = await changedObject.json<{
      evidence_summary: Record<string, unknown>;
      observations: Array<{
        id: string;
        ordinal: number;
        value: Record<string, unknown>;
      }>;
    }>();
    const firstCard = changedDocument.observations[0]!.value.card as
      Record<string, unknown>;
    firstCard.name = `Unrelated changed card ${variant}`;
    const incompleteWrapper = structuredClone(retainedWrapper);
    if (variant === "missing") {
      delete incompleteWrapper.completeness;
    } else {
      incompleteWrapper.completeness = {
        ...(incompleteWrapper.completeness as Record<string, unknown>),
        structurally_complete: false,
      };
    }
    changedDocument.observations.push({
      id: `srcobs_${retained.id.slice(10)}_${changedDocument.observations.length + 1}`,
      ordinal: changedDocument.observations.length + 1,
      value: incompleteWrapper,
    });
    changedDocument.evidence_summary = {
      observation_count: changedDocument.observations.length,
      declared_record_count: changedDocument.observations.length,
      parsed_record_count: changedDocument.observations.length,
      required_surfaces_complete: true,
      partitions_complete: true,
      structurally_complete: true,
    };
    const bytes = utf8(canonicalJson(changedDocument));
    const digest = await sha256(bytes);
    await testEnv.EVIDENCE_OBJECTS.put(retained.content_object_key, bytes);
    await testEnv.CATALOGUE_DB.prepare(
      `DROP TRIGGER IF EXISTS source_observation_sets_are_immutable_on_update`,
    ).run();
    await testEnv.CATALOGUE_DB.batch([
      testEnv.CATALOGUE_DB.prepare(
        `UPDATE source_observation_sets
         SET content_digest = ?, content_byte_length = ?,
             observation_count = ?
         WHERE id = ?`,
      ).bind(digest, bytes.byteLength, changedDocument.observations.length, retained.id),
      testEnv.CATALOGUE_DB.prepare(
        `UPDATE source_parse_operations
         SET content_digest = ?, content_byte_length = ?,
             observation_count = ?
         WHERE id = ?`,
      ).bind(
        digest,
        bytes.byteLength,
        changedDocument.observations.length,
        retained.parse_operation_id,
      ),
    ]);
    await testEnv.CATALOGUE_DB.prepare(
      `CREATE TRIGGER source_observation_sets_are_immutable_on_update
       BEFORE UPDATE ON source_observation_sets
       BEGIN
         SELECT RAISE(ABORT, 'immutable_source_observation_set');
       END`,
    ).run();

    const blocked = await reconcile(runId);
    expect(blocked.response.status).toBe(409);
    expect(blocked.document).toMatchObject({
      state: "failed",
      publishable: false,
      diagnostics: [
        expect.objectContaining({
          code: "retained_evidence_invalid",
          detail: expect.stringContaining(
            "Legality Rule stream lacks explicit structurally complete coverage",
          ),
        }),
      ],
    });
    expect(await testEnv.CATALOGUE_DB.prepare(
      `SELECT current_revision_id FROM catalogue_state WHERE singleton = 1`,
    ).first()).toEqual(currentBefore);
    expect((await testEnv.CATALOGUE_DB.prepare(
      `SELECT * FROM source_freshness ORDER BY game, area`,
    ).all()).results).toEqual(freshnessBefore);
  },
);

test("resolved opaque Card identities are canonical before approval and publication", async () => {
  const directCardNumbers = ["GD30-001", "GD30-002"];
  const companionCardNumbers = ["GD30-003", "GD30-004"];
  const collected = await collectFixtureLegality(
    "https://official-source.invalid/reconciliation/contextual-legality-domain?rules=resolved-card-order",
    "contextual-legality-resolved-card-order",
  );
  expect(collected.reconciled).toMatchObject({
    state: "awaiting_approval",
    publishable: true,
  });
  const cards = collected.reconciled.cards as Array<Record<string, unknown>>;
  const cardsByNumber = new Map(cards.map((card) => [
    requiredString(
      card.official_identity as Record<string, unknown>,
      "value",
    ),
    requiredString(card, "id"),
  ]));
  const cardIds = (cardNumbers: readonly string[]) =>
    cardNumbers.map((number) => {
      const id = cardsByNumber.get(number);
      if (id === undefined) throw new Error(`Card ${number} is absent`);
      return id;
    });
  const directIdsInNumberOrder = cardIds(directCardNumbers);
  const companionIdsInNumberOrder = cardIds(companionCardNumbers);
  const canonicalDirectIds = [...directIdsInNumberOrder].sort();
  const canonicalCompanionIds = [...companionIdsInNumberOrder].sort();
  const canonicalCardIds = [
    ...canonicalDirectIds,
    ...canonicalCompanionIds,
  ].sort();
  expect(directIdsInNumberOrder).not.toEqual(canonicalDirectIds);
  expect(companionIdsInNumberOrder).not.toEqual(canonicalCompanionIds);

  const candidateRule = (
    collected.reconciled.legality_rules as Array<Record<string, unknown>>
  ).find((rule) =>
    rule.official_id === "legality_rule_asia_resolved_card_order"
  );
  expect(candidateRule).toBeDefined();
  expect(candidateRule!.card_ids).toEqual(canonicalDirectIds);
  expect(candidateRule!.effect).toEqual({
    type: "prohibited_combination",
    with_card_ids: canonicalCompanionIds,
  });

  const published = await approve(
    collected.reconciled,
    "publish-resolved-card-order",
  );
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(
    published.document,
    "resulting_revision_id",
  );
  const revisionRule = await revisionLegalityRule(
    revisionId,
    "legality_rule_asia_resolved_card_order",
  );
  expect(revisionRule?.card_ids).toEqual(canonicalDirectIds);
  expect(revisionRule?.effect).toEqual({
    type: "prohibited_combination",
    with_card_ids: canonicalCompanionIds,
  });
  const canonicalRule = await testEnv.CATALOGUE_DB.prepare(
    `SELECT direct_card_ids_json, card_ids_json, effect_json
     FROM legality_rules
     WHERE official_id = ?`,
  ).bind("legality_rule_asia_resolved_card_order")
    .first<{
      direct_card_ids_json: string;
      card_ids_json: string;
      effect_json: string;
    }>();
  expect(canonicalRule).not.toBeNull();
  expect(JSON.parse(canonicalRule!.direct_card_ids_json)).toEqual(
    canonicalDirectIds,
  );
  expect(JSON.parse(canonicalRule!.card_ids_json)).toEqual(
    canonicalCardIds,
  );
  expect(JSON.parse(canonicalRule!.effect_json)).toEqual({
    type: "prohibited_combination",
    with_card_ids: canonicalCompanionIds,
  });
  const exportedRule = await exportedLegalityRule(
    revisionId,
    "legality_rule_asia_resolved_card_order",
  );
  expect(exportedRule.card_ids).toEqual(canonicalCardIds);
  expect(exportedRule.effect).toEqual({
    type: "prohibited_combination",
    with_card_ids: canonicalCompanionIds,
  });
});

test("overlapping prohibited-combination operands fail before a candidate can be approved or published", async () => {
  const currentBefore = await testEnv.CATALOGUE_DB.prepare(
    `SELECT current_revision_id FROM catalogue_state WHERE singleton = 1`,
  ).first();
  const revisionsBefore = await testEnv.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM catalogue_revisions`,
  ).first();
  const rulesBefore = await testEnv.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM legality_rules`,
  ).first();
  const objectsBefore = (await testEnv.CATALOGUE_EXPORTS.list()).objects
    .map((object) => object.key).sort();

  const blocked = await collectFixtureLegality(
    "https://official-source.invalid/reconciliation/contextual-legality-domain?rules=operand-overlap",
    "contextual-legality-operand-overlap",
    409,
  );
  expect(blocked.reconciled).toMatchObject({
    state: "failed",
    publishable: false,
    diagnostics: [
      expect.objectContaining({
        code: "retained_evidence_invalid",
        detail:
          "Legality Rule legality_rule_asia_operand_overlap assigns Card card_83d4134414dab2492b3a209cd1758dd1 to both direct and prohibited-combination operands.",
      }),
    ],
  });
  expect(await testEnv.CATALOGUE_DB.prepare(
    `SELECT current_revision_id FROM catalogue_state WHERE singleton = 1`,
  ).first()).toEqual(currentBefore);
  expect(await testEnv.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM catalogue_revisions`,
  ).first()).toEqual(revisionsBefore);
  expect(await testEnv.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM legality_rules`,
  ).first()).toEqual(rulesBefore);
  expect((await testEnv.CATALOGUE_EXPORTS.list()).objects
    .map((object) => object.key).sort()).toEqual(objectsBefore);
});

async function collectFixtureLegality(
  url: string,
  idempotencyKey: string,
  expectedStatus = 200,
): Promise<{
  runId: string;
  reconciled: Record<string, unknown>;
}> {
  const runId = await collectFixtureLegalityEvidence(url, idempotencyKey);
  const reconciled = await reconcile(runId);
  expect(
    reconciled.response.status,
    JSON.stringify(reconciled.document),
  ).toBe(expectedStatus);
  return { runId, reconciled: reconciled.document };
}

async function collectFixtureLegalityEvidence(
  url: string,
  idempotencyKey: string,
): Promise<string> {
  const started = await injectFixtureEvidencePlan(testEnv.CATALOGUE_DB, {
    supported_game: "gundam",
    source_lineage: "gundam-en-asia",
    adapter_version: "fixture-gundam-en-asia-json@1",
    idempotency_key: idempotencyKey,
    requests: [{
      id: "cards-and-rules",
      method: "GET",
      url,
      headers: { accept: "application/json" },
    }],
  });
  const runId = requiredString(started, "id");
  const resumed = await request(
    `/v1/ingestion-runs/${runId}/collection/resume`,
    {},
  );
  expect(resumed.response.status).toBe(202);
  await waitForState(runId, "parsing");
  return runId;
}

async function reconcile(runId: string) {
  const shown = await request(`/v1/ingestion-runs/${runId}`);
  const body = {
    expected_current_revision_id: requiredString(
      shown.document,
      "expected_current_revision_id",
    ),
    idempotency_key: `reconcile-${runId}`,
  };
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const observed = await request(
      `/v1/ingestion-runs/${runId}/reconciliation`,
      body,
    );
    if (
      observed.response.status !== 200 &&
      observed.response.status !== 202
    ) {
      return observed;
    }
    if (
      observed.document.status === "complete" &&
      observed.document.output !== null &&
      typeof observed.document.output === "object" &&
      !Array.isArray(observed.document.output)
    ) {
      const document = observed.document.output as Record<string, unknown>;
      return {
        response: new Response(null, {
          status: document.publishable === true ? 200 : 409,
        }),
        document,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`reconciliation Workflow ${runId} did not complete`);
}

function approve(
  reconciled: Record<string, unknown>,
  idempotencyKey: string,
) {
  return request(
    `/v1/ingestion-runs/${requiredString(reconciled, "run_id")}/approval`,
    {
      candidate_digest: requiredString(reconciled, "candidate_digest"),
      expected_current_revision_id: requiredString(
        reconciled,
        "expected_current_revision_id",
      ),
      idempotency_key: idempotencyKey,
    },
  );
}

function officialAdapterUrl(adapter: string, scenario: string): string {
  if (adapter === "one-piece-json-document@3") {
    return `https://en.onepiece-cardgame.com/reconciliation/${scenario}`;
  }
  if (adapter === "fusion-world-en@2") {
    return `https://www.dbs-cardgame.com/fw/en/reconciliation/${scenario}`;
  }
  if (adapter === "digimon-en@2") {
    return `https://world.digimoncard.com/reconciliation/${scenario}`;
  }
  if (adapter === "gundam-en-asia@2") {
    return `https://www.gundam-gcg.com/asia-en/reconciliation/${scenario}`;
  }
  return `https://www.gundam-gcg.com/en/reconciliation/${scenario}`;
}

async function waitForState(runId: string, expected: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const shown = await request(`/v1/ingestion-runs/${runId}`);
    if (shown.document.state === expected) return shown.document;
    if (shown.document.state === "failed") {
      throw new Error(JSON.stringify(shown.document));
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} did not reach ${expected}`);
}

async function request(
  pathname: string,
  body?: Record<string, unknown>,
): Promise<{
  response: Response;
  document: Record<string, unknown>;
}> {
  const response = await exports.default.fetch(
    new Request(`https://card-keepr.invalid${pathname}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: "Bearer vitest-administration-key",
        "cf-connecting-ip": `203.0.113.${(requestSequence++ % 250) + 1}`,
        ...(body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return {
    response,
    document: (await response.json()) as Record<string, unknown>,
  };
}

function requiredString(
  document: Record<string, unknown>,
  field: string,
): string {
  const value = document[field];
  if (typeof value !== "string") throw new Error(`${field} is not a string`);
  return value;
}

async function revisionLegalityRule(
  revisionId: string,
  officialId: string,
): Promise<Record<string, unknown> | undefined> {
  const retained = await testEnv.CATALOGUE_DB.prepare(
    `SELECT document_json
     FROM revision_legality_rules
     WHERE catalogue_revision_id = ?
       AND json_extract(document_json, '$.official_id') = ?`,
  )
    .bind(revisionId, officialId)
    .first<{ document_json: string }>();
  return retained === null
    ? undefined
    : JSON.parse(retained.document_json) as Record<string, unknown>;
}

async function exportedLegalityRule(
  revisionId: string,
  officialId: string,
): Promise<Record<string, unknown>> {
  const exportRow = await testEnv.CATALOGUE_DB.prepare(
    `SELECT manifest_key FROM catalogue_exports
     WHERE catalogue_revision_id = ?`,
  ).bind(revisionId).first<{ manifest_key: string }>();
  if (exportRow === null) throw new Error("Catalogue Export is absent");
  const manifestObject = await testEnv.CATALOGUE_EXPORTS.get(
    exportRow.manifest_key,
  );
  if (manifestObject === null) throw new Error("Export manifest is absent");
  const manifest = await manifestObject.json<{
    components: Array<{ name: string; compressed_sha256: string }>;
  }>();
  const component = manifest.components.find(
    (candidate) => candidate.name === "legality-rules",
  );
  if (component === undefined) {
    throw new Error("Legality Rule export component is absent");
  }
  const object = await testEnv.CATALOGUE_EXPORTS.get(
    `catalogue-exports/${revisionId}/components/${component.compressed_sha256}.ndjson.gz`,
  );
  if (object === null) throw new Error("Legality Rule export is absent");
  const text = await new Response(
    object.body.pipeThrough(new DecompressionStream("gzip")),
  ).text();
  const rule = text.trim().split("\n").map((line) =>
    JSON.parse(line) as Record<string, unknown>
  ).find((candidate) => candidate.official_id === officialId);
  if (rule === undefined) throw new Error("Exported Legality Rule is absent");
  return rule;
}

function resolveJsonPointer(document: unknown, pointer: string): unknown {
  return pointer.split("/").slice(1).reduce<unknown>((value, encoded) => {
    if (value === null || typeof value !== "object") {
      throw new Error(`JSON Pointer ${pointer} does not resolve`);
    }
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    return (value as Record<string, unknown>)[key];
  }, document);
}

async function canonicalLegalityCardIdInvariantErrors(
  database: D1Database,
  canonical: Record<string, unknown>,
  prefix: string,
): Promise<unknown[]> {
  const direct = ["card_invariant_a"];
  const withCards = ["card_invariant_b"];
  const union = [...direct, ...withCards];
  const effect = {
    type: "prohibited_combination",
    with_card_ids: withCards,
  };
  const malformed = [
    { direct: direct[0], effect, union },
    { direct: [7], effect, union },
    { direct: [direct[0], direct[0]], effect, union },
    {
      direct: ["card_invariant_z", "card_invariant_a"],
      effect,
      union: [
        "card_invariant_a",
        "card_invariant_b",
        "card_invariant_z",
      ],
    },
    {
      direct,
      effect: {
        type: "prohibited_combination",
        with_card_ids: withCards[0],
      },
      union,
    },
    {
      direct,
      effect: { type: "prohibited_combination", with_card_ids: [7] },
      union,
    },
    {
      direct,
      effect: {
        type: "prohibited_combination",
        with_card_ids: [withCards[0], withCards[0]],
      },
      union,
    },
    {
      direct,
      effect: {
        type: "prohibited_combination",
        with_card_ids: ["card_invariant_z", "card_invariant_b"],
      },
      union: [
        "card_invariant_a",
        "card_invariant_b",
        "card_invariant_z",
      ],
    },
    { direct, effect, union: direct },
    {
      direct,
      effect: {
        type: "prohibited_combination",
        with_card_ids: direct,
      },
      union: direct,
    },
    { direct, effect, union: [...union].reverse() },
    { direct: [" card_invalid"], effect, union },
    { direct: [`card_${"x".repeat(200)}`], effect, union },
  ];
  return Promise.all(
    malformed.map((variant, index) =>
      rejectedError(
        database.prepare(
          `INSERT INTO legality_rules (
             id, official_id, supported_game, region, format, event_tier,
             effective_from, effective_until, official_wording, effect_json,
             card_ids_json, direct_card_ids_json, source_lineage,
             source_snapshot_id, source_observation_set_id,
             source_observation_id, source_observation_pointer,
             source_field_pointers_json, first_revision_id,
             last_observed_revision_id, current, last_missing_revision_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, 1, NULL)`,
        ).bind(
          `legality_rule_${prefix}_malformed_${index}`,
          `${prefix}-malformed-${index}`,
          canonical.supported_game ?? canonical.game,
          canonical.region,
          canonical.format,
          canonical.event_tier,
          canonical.effective_from,
          canonical.effective_until,
          canonical.official_wording,
          JSON.stringify(variant.effect),
          JSON.stringify(variant.union),
          JSON.stringify(variant.direct),
          canonical.source_lineage,
          canonical.source_snapshot_id,
          canonical.source_observation_set_id,
          `srcobs_${prefix}_malformed_${index}`,
          `/observations/0/value/legality_rules/${index + 20}`,
          canonical.source_field_pointers_json ??
            JSON.stringify(canonical.source_field_pointers),
          canonical.first_revision_id,
          canonical.last_observed_revision_id,
        ).run(),
      )
    ),
  );
}

async function rejectedError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}
