import { applyD1Migrations } from "cloudflare:test";
import { expect, test } from "vitest";
import { sha256 } from "../../../src/catalogue/shared";
import { injectFixtureEvidencePlan } from "./fixture-plan-injection";
import {
  approve,
  canonicalLegalityCardIdInvariantErrors,
  canonicalLegalityEffectInvariantErrors,
  canonicalLegalityScopeInvariantErrors,
  exportedLegalityRule,
  exportedManifest,
  installContextualLegalitySuite,
  officialAdapterUrl,
  productionFusionLegalityRequests,
  productionOnePieceReleaseTimingRequests,
  reconcile,
  rejectedError,
  request,
  requiredString,
  revisionLegalityRule,
  testEnv,
  waitForState,
} from "./contextual-legality-helpers";
import fusionLivePolicyRoot from "../../../acceptance/fixtures/retained-official-source/fusion-world-en-policy-live.json";
import fusionLivePolicyDetail from "../../../acceptance/fixtures/retained-official-source/fusion-world-en-policy-detail.json";

installContextualLegalitySuite();

test("D1 freshness scope remains structural while registered Source metadata owns lineage semantics", async () => {
  await testEnv.CATALOGUE_DB.prepare(
    `INSERT INTO ingestion_runs (
       id, state, selected_games_json, started_at,
       expected_current_revision_id, linked_run_id, idempotency_key,
       candidate_json
     ) VALUES (
       'run_future_legality_scope', 'planning', '["gundam"]',
       '2026-08-02T00:00:00.000Z', 'catrev_spine_000', NULL,
       'future-legality-scope', '{}'
     )`,
  ).run();
  await expect(
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO source_freshness (
       game, area, source_lineage, region, checked_at, ingestion_run_id
     ) VALUES (
       'gundam', 'legality-rules', 'gundam-en-future', 'EN-FUTURE',
       '2026-08-02T00:00:00.000Z', 'run_future_legality_scope'
     )`,
    ).run(),
  ).resolves.toBeDefined();
  await testEnv.CATALOGUE_DB.prepare(
    "DELETE FROM source_freshness WHERE ingestion_run_id = 'run_future_legality_scope'",
  ).run();
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
         'fixture-one-piece-json@3', ?, 'synthetic_fixture')`,
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
    )
      .bind("c".repeat(64), runId)
      .run(),
  );
  const deleteError = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `DELETE FROM source_requests
       WHERE ingestion_run_id = ? AND request_id = 'delete-target'`,
    )
      .bind(runId)
      .run(),
  );
  const insertError = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO source_requests (
         ingestion_run_id, request_id, sequence_number, method, url,
         request_headers_json, representation_fingerprint, state
       ) VALUES (?, 'insert-target', 2, 'GET',
         'https://attacker.example/wrong-plan-fields',
         '{"accept":"application/json"}', ?, 'pending')`,
    )
      .bind(runId, "f".repeat(64))
      .run(),
  );
  const unplannedInsertError = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO source_requests (
         ingestion_run_id, request_id, sequence_number, method, url,
         request_headers_json, representation_fingerprint, state
       ) VALUES (?, 'unplanned', 3, 'GET',
         'https://attacker.example/unplanned', '{}', ?, 'pending')`,
    )
      .bind(runId, "d".repeat(64))
      .run(),
  );
  const requestOwnerError = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE source_requests SET ingestion_run_id = ?
       WHERE ingestion_run_id = ? AND request_id = 'update-target'`,
    )
      .bind(ownerTargetRunId, runId)
      .run(),
  );
  const planOwnerError = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE ingestion_evidence_plans SET ingestion_run_id = ?
       WHERE ingestion_run_id = ?`,
    )
      .bind(ownerTargetRunId, runId)
      .run(),
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
           'fixture-one-piece-json@3', ?, 'synthetic_fixture')`,
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
         'one-piece', 'one-piece@1', 'fixture-one-piece-json@3', NULL)`,
    ).bind(sourceRunId, "1".repeat(64), "2".repeat(64)),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO source_parse_operations (
         id, source_snapshot_id, adapter_version, intent,
         idempotency_key, observation_set_id, content_object_key,
         parsed_at, state, content_digest, content_byte_length,
         observation_count
       ) VALUES ('srcparse_collection_owner', 'srcsnap_collection_owner',
         'fixture-one-piece-json@3', 'collection',
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
         'fixture-one-piece-json@3', '2026-08-01T00:00:02.000Z', ?, 2,
         'source-observations/collection-owner.json', 1)`,
    ).bind("3".repeat(64)),
  ]);

  const collectionPlan = JSON.stringify({
    contract: "card-keepr-official-source-collection-plan@1",
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    game_profile_version: "one-piece@1",
    adapter_version: "fixture-one-piece-json@3",
    discovery_observation_set_id: "srcobsset_collection_owner",
    requests: [],
  });
  await expect(
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO official_source_collection_plans (
         ingestion_run_id, source_lineage,
         discovery_observation_set_id, contract,
         collection_plan_json, content_digest, created_at
       ) VALUES (?, 'one-piece-en', 'srcobsset_collection_owner',
         'card-keepr-official-source-collection-plan@1', ?, ?,
         '2026-08-01T00:00:03.000Z')`,
    )
      .bind(sourceRunId, collectionPlan, `a${"Z".repeat(63)}`)
      .run(),
  ).rejects.toThrow(/CHECK constraint failed/);
  await expect(
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO official_source_collection_plans (
         ingestion_run_id, source_lineage,
         discovery_observation_set_id, contract,
         collection_plan_json, content_digest, created_at
       ) VALUES (?, 'one-piece-en', 'srcobsset_collection_owner',
         'card-keepr-official-source-collection-plan@1', ?, ?,
         '2026-08-01T00:00:03.000Z')`,
    )
      .bind(targetRunId, collectionPlan, "4".repeat(64))
      .run(),
  ).rejects.toThrow(/official_source_collection_plan_discovery_owner_mismatch/);
});

test("a fresh D1 enforces full lowercase digests and canonical revision rule identity", async () => {
  // A separate database: the discovery-owner trigger is dropped below so
  // the digest and identity guards can be exercised without a real plan.
  const scratchDatabase = testEnv.SCRATCH_DB;
  await applyD1Migrations(scratchDatabase, testEnv.TEST_MIGRATIONS);
  await scratchDatabase.prepare(`DROP TRIGGER official_source_collection_plan_discovery_owner`).run();

  const malformedDigest = await rejectedError(
    scratchDatabase
      .prepare(
        `INSERT INTO official_source_collection_plans (
        ingestion_run_id, source_lineage,
        discovery_observation_set_id, contract,
        collection_plan_json, content_digest, created_at
      ) VALUES ('run_missing', 'missing-lineage', 'srcobsset_missing',
        'card-keepr-official-source-collection-plan@1', '{}', ?,
        '2026-08-01T00:00:00.000Z')`,
      )
      .bind(`a${"Z".repeat(63)}`)
      .run(),
  );
  const validDigestMissingOwner = await rejectedError(
    scratchDatabase
      .prepare(
        `INSERT INTO official_source_collection_plans (
        ingestion_run_id, source_lineage,
        discovery_observation_set_id, contract,
        collection_plan_json, content_digest, created_at
      ) VALUES ('run_missing', 'missing-lineage', 'srcobsset_missing',
        'card-keepr-official-source-collection-plan@1', '{}', ?,
        '2026-08-01T00:00:00.000Z')`,
      )
      .bind("a".repeat(64))
      .run(),
  );
  expect(String(malformedDigest)).toMatch(/CHECK constraint failed/);
  expect(String(validDigestMissingOwner)).toMatch(
    /official_source_collection_plan_discovery_owner_mismatch|FOREIGN KEY constraint failed/,
  );

  const foreignKeys = await scratchDatabase
    .prepare(`PRAGMA foreign_key_list(revision_legality_rules)`)
    .all<{ table: string; from: string }>();
  expect(foreignKeys.results).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        table: "legality_rules",
        from: "legality_rule_id",
      }),
    ]),
  );
  const guards = await scratchDatabase
    .prepare(
      `SELECT name FROM sqlite_master
     WHERE type = 'trigger' AND name IN (
       'guard_legality_rule_identity',
       'legality_rule_card_ids_canonical_insert',
       'legality_rule_card_ids_canonical_update',
       'legality_rule_provenance_owner_insert',
       'legality_rule_provenance_owner_update',
       'legality_rule_provenance_immutable',
       'legality_rule_scope_valid_insert',
       'legality_rules_immutable_delete',
       'revision_legality_rule_matches_canonical',
       'revision_legality_rule_scope_valid_insert',
       'revision_legality_rules_immutable_delete',
       'revision_legality_rules_immutable_update'
     ) ORDER BY name`,
    )
    .all<{ name: string }>();
  expect(guards.results.map((row) => row.name)).toEqual([
    "guard_legality_rule_identity",
    "legality_rule_card_ids_canonical_insert",
    "legality_rule_card_ids_canonical_update",
    "legality_rule_provenance_immutable",
    "legality_rule_provenance_owner_insert",
    "legality_rule_provenance_owner_update",
    "legality_rule_scope_valid_insert",
    "legality_rules_immutable_delete",
    "revision_legality_rule_matches_canonical",
    "revision_legality_rule_scope_valid_insert",
    "revision_legality_rules_immutable_delete",
    "revision_legality_rules_immutable_update",
  ]);

  const requestPlan = JSON.stringify({
    requests: [
      {
        id: "upgraded-legality",
        method: "GET",
        url: "https://en.onepiece-cardgame.com/rules/restriction/",
        headers: {},
        representation_fingerprint: "5".repeat(64),
      },
    ],
  });
  const sourceFieldPointers = JSON.stringify({
    official_wording: "/observations/0/value/legality_rules/0/official_wording",
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
    unresolved_scope: null,
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
  await scratchDatabase.batch([
    scratchDatabase
      .prepare(
        `INSERT INTO ingestion_runs (
         id, state, selected_games_json, started_at,
         expected_current_revision_id, linked_run_id, idempotency_key,
         candidate_digest, candidate_created_at, approval_deadline,
         approval_json, candidate_json
       ) VALUES ('run_upgraded_legality_guard', 'publishing',
         '["one-piece"]', '2026-08-01T00:00:00.000Z',
         'catrev_spine_000', NULL, 'upgraded-legality-guard', ?,
         '2026-08-01T00:00:02.000Z', '2099-01-01T00:00:00.000Z', ?, '{}')`,
      )
      .bind(
        "8".repeat(64),
        JSON.stringify({
          candidate_digest: "8".repeat(64),
          expected_current_revision_id: "catrev_spine_000",
        }),
      ),
    scratchDatabase.prepare(
      `UPDATE operation_state
       SET active_ingestion_run_id = 'run_upgraded_legality_guard'
       WHERE singleton = 1`,
    ),
    scratchDatabase
      .prepare(
        `INSERT INTO ingestion_evidence_plans (
         ingestion_run_id, source_lineage, supported_game,
         game_profile_version, adapter_version, request_plan_json,
         plan_origin
       ) VALUES ('run_upgraded_legality_guard', 'one-piece-en',
         'one-piece', 'one-piece@1', 'fixture-one-piece-json@3', ?,
         'synthetic_fixture')`,
      )
      .bind(requestPlan),
    scratchDatabase
      .prepare(
        `INSERT INTO source_requests (
         ingestion_run_id, request_id, sequence_number, method, url,
         request_headers_json, representation_fingerprint, state,
         source_snapshot_id
       ) VALUES ('run_upgraded_legality_guard', 'upgraded-legality', 0,
         'GET', 'https://en.onepiece-cardgame.com/rules/restriction/',
         '{}', ?, 'observed', 'srcsnap_upgraded_legality_guard')`,
      )
      .bind("5".repeat(64)),
    scratchDatabase.prepare(
      `INSERT INTO source_fetch_attempts (
         id, ingestion_run_id, request_id, attempt_number,
         requested_at, completed_at, outcome, http_status,
         response_headers_json, retry_after_ms, diagnostic
       ) VALUES ('srcfetch_upgraded_legality_guard',
         'run_upgraded_legality_guard', 'upgraded-legality', 1,
         '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:01.000Z',
         'success', 200, '{}', NULL, NULL)`,
    ),
    scratchDatabase
      .prepare(
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
         'one-piece', 'one-piece@1', 'fixture-one-piece-json@3', NULL)`,
      )
      .bind("5".repeat(64), "6".repeat(64)),
    scratchDatabase
      .prepare(
        `INSERT INTO source_parse_operations (
         id, source_snapshot_id, adapter_version, intent,
         idempotency_key, observation_set_id, content_object_key,
         parsed_at, state, content_digest, content_byte_length,
         observation_count
       ) VALUES ('srcparse_upgraded_legality_guard',
         'srcsnap_upgraded_legality_guard', 'fixture-one-piece-json@3',
         'collection', 'upgraded-legality-guard-parse',
         'srcobsset_upgraded_legality_guard',
         'source-observations/upgraded-legality-guard.json',
         '2026-08-01T00:00:02.000Z', 'finalized', ?, 2, 1)`,
      )
      .bind("7".repeat(64)),
    scratchDatabase
      .prepare(
        `INSERT INTO source_observation_sets (
         id, parse_operation_id, source_snapshot_id, source_lineage,
         supported_game, game_profile_version, adapter_version, parsed_at,
         content_digest, content_byte_length, content_object_key,
         observation_count
       ) VALUES ('srcobsset_upgraded_legality_guard',
         'srcparse_upgraded_legality_guard',
         'srcsnap_upgraded_legality_guard', 'one-piece-en', 'one-piece',
         'one-piece@1', 'fixture-one-piece-json@3',
         '2026-08-01T00:00:02.000Z', ?, 2,
         'source-observations/upgraded-legality-guard.json', 1)`,
      )
      .bind("7".repeat(64)),
    scratchDatabase
      .prepare(
        `INSERT INTO catalogue_revisions (
         id, ingestion_run_id, published_at, content_digest,
         expected_previous_revision_id, approved_candidate_digest
       ) VALUES ('catrev_upgraded_legality_guard',
         'run_upgraded_legality_guard', '2026-08-01T00:00:03.000Z', ?,
         'catrev_spine_000', ?)`,
      )
      .bind("8".repeat(64), "8".repeat(64)),
    scratchDatabase
      .prepare(
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
      )
      .bind(
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
        JSON.stringify([...upgradedRule.card_ids, ...upgradedRule.effect.with_card_ids].sort()),
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
    scratchDatabase
      .prepare(
        `INSERT INTO revision_legality_rules (
         catalogue_revision_id, legality_rule_id, supported_game,
         region, format, event_tier, effective_from, effective_until,
         card_ids_json, document_json
       ) VALUES ('catrev_upgraded_legality_guard', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        upgradedRule.id,
        upgradedRule.game,
        upgradedRule.region,
        upgradedRule.format,
        upgradedRule.event_tier,
        upgradedRule.effective_from,
        upgradedRule.effective_until,
        JSON.stringify([...upgradedRule.card_ids, ...upgradedRule.effect.with_card_ids].sort()),
        JSON.stringify(upgradedRule),
      ),
  ]);
  const upgradedCanonicalCardIdErrors = await canonicalLegalityCardIdInvariantErrors(
    scratchDatabase,
    {
      ...upgradedRule,
      effect_json: JSON.stringify(upgradedRule.effect),
      source_field_pointers_json: sourceFieldPointers,
    },
    "upgraded",
  );
  expect(upgradedCanonicalCardIdErrors.map(String)).toEqual(
    upgradedCanonicalCardIdErrors.map(() => expect.stringMatching(/legality_rule_card_ids_not_canonical/)),
  );
  const upgradedCanonicalEffectErrors = await canonicalLegalityEffectInvariantErrors(
    scratchDatabase,
    {
      ...upgradedRule,
      source_field_pointers_json: sourceFieldPointers,
    },
    "upgraded",
  );
  expect(upgradedCanonicalEffectErrors.map(String)).toEqual(
    upgradedCanonicalEffectErrors.map(() => expect.stringMatching(/legality_rule_effect_invalid/)),
  );
  const upgradedScopeErrors = await canonicalLegalityScopeInvariantErrors(
    scratchDatabase,
    {
      ...upgradedRule,
      source_field_pointers_json: sourceFieldPointers,
    },
    "upgraded",
  );
  expect(upgradedScopeErrors.map(String)).toEqual(
    upgradedScopeErrors.map(() => expect.stringMatching(/legality_rule_scope_invalid/)),
  );
  const upgradedProvenanceMutation = await rejectedError(
    scratchDatabase
      .prepare(
        `UPDATE legality_rules
       SET source_snapshot_id = 'srcsnap_attacker'
       WHERE id = ?`,
      )
      .bind(upgradedRule.id)
      .run(),
  );
  const upgradedCrossOwner = await rejectedError(
    scratchDatabase
      .prepare(
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
      )
      .run(),
  );
  const upgradedRevisionMutation = await rejectedError(
    scratchDatabase
      .prepare(
        `UPDATE revision_legality_rules SET format = 'attacker-format'
       WHERE catalogue_revision_id = 'catrev_upgraded_legality_guard'
         AND legality_rule_id = ?`,
      )
      .bind(upgradedRule.id)
      .run(),
  );
  const upgradedRevisionDelete = await rejectedError(
    scratchDatabase
      .prepare(
        `DELETE FROM revision_legality_rules
       WHERE catalogue_revision_id = 'catrev_upgraded_legality_guard'
         AND legality_rule_id = ?`,
      )
      .bind(upgradedRule.id)
      .run(),
  );
  const { event_tier: _missingUpgradedEventTier, ...upgradedWithoutNullableKey } = upgradedRule;
  const { effective_until: _replacedUpgradedEffectiveUntil, ...upgradedWithReplacementKey } = upgradedRule;
  const upgradedMissingNullableKey = await rejectedError(
    scratchDatabase
      .prepare(
        `INSERT INTO revision_legality_rules (
         catalogue_revision_id, legality_rule_id, supported_game,
         region, format, event_tier, effective_from, effective_until,
         card_ids_json, document_json
       ) VALUES ('catrev_upgraded_legality_guard', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        upgradedRule.id,
        upgradedRule.game,
        upgradedRule.region,
        upgradedRule.format,
        upgradedRule.event_tier,
        upgradedRule.effective_from,
        upgradedRule.effective_until,
        JSON.stringify(upgradedRule.card_ids),
        JSON.stringify(upgradedWithoutNullableKey),
      )
      .run(),
  );
  const upgradedArbitraryKeySubstitution = await rejectedError(
    scratchDatabase
      .prepare(
        `INSERT INTO revision_legality_rules (
         catalogue_revision_id, legality_rule_id, supported_game,
         region, format, event_tier, effective_from, effective_until,
         card_ids_json, document_json
       ) VALUES ('catrev_upgraded_legality_guard', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
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
      )
      .run(),
  );
  const upgradedDuplicateRequiredKey = await rejectedError(
    scratchDatabase
      .prepare(
        `INSERT INTO revision_legality_rules (
         catalogue_revision_id, legality_rule_id, supported_game,
         region, format, event_tier, effective_from, effective_until,
         card_ids_json, document_json
       ) VALUES ('catrev_upgraded_legality_guard', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        upgradedRule.id,
        upgradedRule.game,
        upgradedRule.region,
        upgradedRule.format,
        upgradedRule.event_tier,
        upgradedRule.effective_from,
        upgradedRule.effective_until,
        JSON.stringify(upgradedRule.card_ids),
        JSON.stringify(upgradedRule).replace(/\}$/u, ',"official_wording":"Attacker-controlled duplicate."}'),
      )
      .run(),
  );
  const upgradedNestedDocuments = [
    { ...upgradedRule, card_ids: upgradedRule.card_ids[0] },
    {
      ...upgradedRule,
      card_ids: [upgradedRule.card_ids[0], upgradedRule.card_ids[0]],
    },
    {
      ...upgradedRule,
      card_ids: [...upgradedRule.card_ids, ...upgradedRule.effect.with_card_ids],
    },
  ];
  const upgradedNestedCardIds = await Promise.all(
    upgradedNestedDocuments.map((document) =>
      rejectedError(
        scratchDatabase
          .prepare(
            `INSERT INTO revision_legality_rules (
             catalogue_revision_id, legality_rule_id, supported_game,
             region, format, event_tier, effective_from, effective_until,
             card_ids_json, document_json
           ) VALUES ('catrev_upgraded_legality_guard', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            upgradedRule.id,
            upgradedRule.game,
            upgradedRule.region,
            upgradedRule.format,
            upgradedRule.event_tier,
            upgradedRule.effective_from,
            upgradedRule.effective_until,
            JSON.stringify([...upgradedRule.card_ids, ...upgradedRule.effect.with_card_ids]),
            JSON.stringify(document),
          )
          .run(),
      ),
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
])("production planning rejects the unregistered %s publisher representation", async (adapter, game, lineage) => {
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
});

test("legality freshness remains independent across partial regional refreshes", async () => {
  const publishScope = async (
    key: string,
    lineage: "gundam-en-asia" | "gundam-en-us",
    url: string,
    observedAt: string,
  ) => {
    const started = await injectFixtureEvidencePlan(testEnv.CATALOGUE_DB, {
      idempotency_key: key,
      supported_game: "gundam",
      source_lineage: lineage,
      adapter_version: lineage === "gundam-en-asia" ? "fixture-gundam-en-asia-json@2" : "fixture-gundam-en-us-json@2",
      requests: [
        {
          id: `${key}-rules`,
          method: "GET",
          url,
          headers: { accept: "application/json" },
        },
      ],
    });
    const runId = requiredString(started, "id");
    expect((await request(`/v1/ingestion-runs/${runId}/collection/resume`, {}, observedAt)).response.status).toBe(202);
    await waitForState(runId, "parsing");
    const reconciled = await reconcile(runId, observedAt);
    expect(reconciled.response.status).toBe(200);
    const published = await approve(reconciled.document, `publish-${key}`, observedAt);
    expect(published.response.status).toBe(200);
    const freshness = await testEnv.CATALOGUE_DB.prepare(
      `SELECT checked_at
       FROM source_freshness
       WHERE game = 'gundam'
         AND area = 'legality-rules'
         AND source_lineage = ?
         AND ingestion_run_id = ?`,
    )
      .bind(lineage, runId)
      .first<{ checked_at: string }>();
    if (freshness === null) {
      throw new Error(`Freshness for ${lineage} is absent`);
    }
    return {
      runId,
      checkedAt: freshness.checked_at,
      revisionId: requiredString(published.document, "resulting_revision_id"),
      reconciled: reconciled.document,
    };
  };
  const freshnessRows = () =>
    testEnv.CATALOGUE_DB.prepare(
      `SELECT game, area, source_lineage, region, checked_at, ingestion_run_id
     FROM source_freshness
     WHERE game = 'gundam' AND area = 'legality-rules'
     ORDER BY source_lineage, region`,
    ).all<Record<string, unknown>>();

  const asia = await publishScope(
    "regional-freshness-asia",
    "gundam-en-asia",
    "https://official-source.invalid/reconciliation/contextual-legality-domain?rules=current",
    "2026-08-02T01:00:00.000Z",
  );
  expect((await freshnessRows()).results).toEqual([
    {
      game: "gundam",
      area: "legality-rules",
      source_lineage: "gundam-en-asia",
      region: "EN-ASIA",
      checked_at: asia.checkedAt,
      ingestion_run_id: asia.runId,
    },
  ]);

  const us = await publishScope(
    "regional-freshness-us",
    "gundam-en-us",
    "https://official-source.invalid/reconciliation/contextual-legality-domain-us",
    "2026-08-02T02:00:00.000Z",
  );
  const afterUs = (await freshnessRows()).results;
  expect(us.checkedAt).not.toBe(asia.checkedAt);
  expect(afterUs).toEqual([
    {
      game: "gundam",
      area: "legality-rules",
      source_lineage: "gundam-en-asia",
      region: "EN-ASIA",
      checked_at: asia.checkedAt,
      ingestion_run_id: asia.runId,
    },
    {
      game: "gundam",
      area: "legality-rules",
      source_lineage: "gundam-en-us",
      region: "EN-US",
      checked_at: us.checkedAt,
      ingestion_run_id: us.runId,
    },
  ]);
  const retainedUsFreshness = structuredClone(afterUs[1]);

  const retiredAsia = await publishScope(
    "regional-freshness-asia-empty",
    "gundam-en-asia",
    "https://official-source.invalid/reconciliation/contextual-legality-domain?rules=empty",
    "2026-08-02T03:00:00.000Z",
  );
  const afterPartialRefresh = (await freshnessRows()).results;
  expect(retiredAsia.checkedAt).not.toBe(asia.checkedAt);
  expect(retiredAsia.checkedAt).not.toBe(us.checkedAt);
  expect(afterPartialRefresh[0]).toEqual({
    game: "gundam",
    area: "legality-rules",
    source_lineage: "gundam-en-asia",
    region: "EN-ASIA",
    checked_at: retiredAsia.checkedAt,
    ingestion_run_id: retiredAsia.runId,
  });
  expect(afterPartialRefresh[1]).toEqual(retainedUsFreshness);

  expect(await revisionLegalityRule(retiredAsia.revisionId, "legality_rule_us_eligible")).toMatchObject({
    current: true,
    source_lineage: "gundam-en-us",
  });
  expect(await revisionLegalityRule(retiredAsia.revisionId, "legality_rule_asia_eligible")).toMatchObject({
    current: false,
    source_lineage: "gundam-en-asia",
  });
  expect((await exportedManifest(retiredAsia.revisionId)).source_freshness).toEqual(
    expect.arrayContaining([
      {
        game: "gundam",
        area: "legality-rules",
        source_lineage: "gundam-en-asia",
        region: "EN-ASIA",
        checked_at: retiredAsia.checkedAt,
      },
      {
        game: "gundam",
        area: "legality-rules",
        source_lineage: "gundam-en-us",
        region: "EN-US",
        checked_at: us.checkedAt,
      },
    ]),
  );
}, 90_000);

test("a versioned production adapter derives and exports an exact representable Legality Rule", async () => {
  const seeded = await injectFixtureEvidencePlan(testEnv.CATALOGUE_DB, {
    supported_game: "fusion-world",
    source_lineage: "fusion-world-en",
    adapter_version: "fixture-fusion-world-json@2",
    idempotency_key: "seed-production-legality-card",
    requests: [
      {
        id: "seed-card",
        method: "GET",
        url: "https://official-source.invalid/reconciliation/profile-fusion-world",
        headers: { accept: "application/json" },
      },
    ],
  });
  const seededRunId = requiredString(seeded, "id");
  expect((await request(`/v1/ingestion-runs/${seededRunId}/collection/resume`, {})).response.status).toBe(202);
  await waitForState(seededRunId, "parsing");
  const seededCandidate = await reconcile(seededRunId);
  expect(seededCandidate.response.status).toBe(200);
  const card = (seededCandidate.document.cards as Array<Record<string, unknown>>).find(
    (item) => (item.official_identity as Record<string, unknown>).value === "FB01-001",
  );
  if (card === undefined) throw new Error("FB01-001 is absent");
  expect((await approve(seededCandidate.document, "publish-production-legality-card")).response.status).toBe(200);

  const started = await request("/v1/ingestion-runs/evidence", {
    supported_game: "fusion-world",
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@9",
    idempotency_key: "production-representable-legality-v3",
    requests: productionFusionLegalityRequests("card-keepr-representable-legality-v3"),
  });
  expect(started.response.status).toBe(201);
  const runId = requiredString(started.document, "id");
  expect((await request(`/v1/ingestion-runs/${runId}/collection/resume`, {})).response.status).toBe(202);
  const completedProductionRun = await waitForState(runId, "awaiting_approval");
  const childIds = (
    completedProductionRun.workflow as {
      child_ids: string[];
    }
  ).child_ids;
  expect(childIds.length).toBeGreaterThanOrEqual(3);
  expect(new Set(childIds).size).toBe(childIds.length);
  const duplicateSnapshots = await testEnv.CATALOGUE_DB.prepare(
    `SELECT request_id, COUNT(*) AS count
     FROM source_snapshots WHERE ingestion_run_id = ?
     GROUP BY request_id HAVING COUNT(*) > 1`,
  )
    .bind(runId)
    .all();
  expect(duplicateSnapshots.results).toEqual([]);
  const candidate = await request(`/v1/ingestion-runs/${runId}/candidate`);
  expect(candidate.response.status).toBe(200);
  expect(requiredString(candidate.document, "candidate_digest")).toMatch(/^[0-9a-f]{64}$/u);
  const published = await approve(candidate.document, "publish-production-representable-legality-v3");
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(published.document, "resulting_revision_id");

  expect(await exportedLegalityRule(revisionId, "fw_production_eligible")).toMatchObject({
    official_wording: "FB01-001 is eligible 'as printed' – publisher–confirmed &#39;literal&#39;.",
    region: "EN-OCEANIA",
    format: "standard",
    event_tier: null,
    effective_from: "2026-01-01",
    effective_until: null,
    effect: { type: "eligible" },
  });

  const conflicting = await request("/v1/ingestion-runs/evidence", {
    supported_game: "fusion-world",
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@9",
    idempotency_key: "production-conflicting-shared-legality-v3",
    requests: productionFusionLegalityRequests(
      "card-keepr-representable-legality-v3",
      "card-keepr-conflicting-shared-legality-v3",
    ),
  });
  expect(conflicting.response.status).toBe(201);
  const conflictingRunId = requiredString(conflicting.document, "id");
  expect((await request(`/v1/ingestion-runs/${conflictingRunId}/collection/resume`, {})).response.status).toBe(202);
  expect(await waitForState(conflictingRunId, "failed")).toMatchObject({
    state: "failed",
    failure_code: "printing_reconciliation_blocked",
  });
}, 90_000);

test("production discovery retains literal stages and cannot freeze a Collection Plan before closure", async () => {
  const started = await request("/v1/ingestion-runs/evidence", {
    supported_game: "fusion-world",
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@9",
    idempotency_key: "production-staged-discovery-gap-v3",
    requests: productionFusionLegalityRequests("card-keepr-staged-discovery-gap-v3"),
  });
  expect(started.response.status).toBe(201);
  const runId = requiredString(started.document, "id");
  expect((await request(`/v1/ingestion-runs/${runId}/collection/resume`, {})).response.status).toBe(202);
  expect(await waitForState(runId, "failed")).toMatchObject({
    state: "failed",
  });

  const frozen = await testEnv.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count
     FROM official_source_collection_plans
     WHERE ingestion_run_id = ?`,
  )
    .bind(runId)
    .first<{ count: number }>();
  expect(frozen?.count).toBe(0);

  const staged = await testEnv.CATALOGUE_DB.prepare(
    `SELECT parent_request_id, url, request_role
     FROM source_discovery_request_plans
     WHERE ingestion_run_id = ?
     ORDER BY sequence_number`,
  )
    .bind(runId)
    .all<{
      parent_request_id: string;
      url: string;
      request_role: string;
    }>();
  expect(staged.results).toEqual(
    expect.arrayContaining([
      {
        parent_request_id: "fusion-world-en:discovery",
        url: "https://www.dbs-cardgame.com/fw/en/cardlist/?search=true&category%5B0%5D=583301",
        request_role: "listing",
      },
      {
        parent_request_id: "fusion-world-en:discovery",
        url: "https://www.dbs-cardgame.com/fw/en/products/",
        request_role: "listing",
      },
      {
        parent_request_id: "fusion-world-en:discovery",
        url: "https://www.dbs-cardgame.com/fw/en/news/01_31.html",
        request_role: "listing",
      },
    ]),
  );
  expect((await request(`/v1/ingestion-runs/${runId}/candidate`)).response.status).toBe(409);
}, 90_000);

test("authenticated parsing retains staged live Fusion policy root and detail observations", async () => {
  const runId = "run_live_fusion_policy_evidence";
  const rootRequestId = `fusion-world-en:listing:rules:${"a".repeat(64)}`;
  const detailRequestId = `fusion-world-en:detail:${"b".repeat(64)}`;
  const fixtures = [
    {
      requestId: rootRequestId,
      snapshotId: "srcsnap_live_fusion_policy_root",
      fetchId: "srcfetch_live_fusion_policy_root",
      fixture: fusionLivePolicyRoot,
    },
    {
      requestId: detailRequestId,
      snapshotId: "srcsnap_live_fusion_policy_detail",
      fetchId: "srcfetch_live_fusion_policy_detail",
      fixture: fusionLivePolicyDetail,
    },
  ];
  const retained = await Promise.all(
    fixtures.map(async (item) => {
      const bytes = Uint8Array.from(atob(item.fixture.body_base64), (character) => character.charCodeAt(0));
      return { ...item, bytes, digest: await sha256(bytes) };
    }),
  );
  await testEnv.CATALOGUE_DB.batch([
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO ingestion_runs (
         id, state, selected_games_json, started_at,
         expected_current_revision_id, linked_run_id, idempotency_key,
         candidate_json
       ) VALUES (?, 'parsing', '["fusion-world"]',
         '2026-08-03T00:00:00.000Z', 'catrev_spine_000', NULL, ?, '{}')`,
    ).bind(runId, "live-fusion-policy-evidence"),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO ingestion_evidence_plans (
         ingestion_run_id, source_lineage, supported_game,
         game_profile_version, adapter_version, request_plan_json,
         plan_origin
       ) VALUES (?, 'fusion-world-en', 'fusion-world', 'fusion-world@1',
         'fusion-world-en@9', ?, 'production')`,
    ).bind(
      runId,
      JSON.stringify({
        requests: retained.map((item) => ({
          id: item.requestId,
          method: "GET",
          url: item.fixture.source_url,
          headers: { accept: "text/html" },
          representation_fingerprint: item.digest,
        })),
      }),
    ),
    ...retained.flatMap((item, index) => [
      testEnv.CATALOGUE_DB.prepare(
        `INSERT INTO source_requests (
           ingestion_run_id, request_id, sequence_number, method, url,
           request_headers_json, representation_fingerprint, state,
           source_snapshot_id
         ) VALUES (?, ?, ?, 'GET', ?, ?, ?, 'observed', ?)`,
      ).bind(
        runId,
        item.requestId,
        index,
        item.fixture.source_url,
        JSON.stringify({ accept: "text/html" }),
        item.digest,
        item.snapshotId,
      ),
      testEnv.CATALOGUE_DB.prepare(
        `INSERT INTO source_fetch_attempts (
           id, ingestion_run_id, request_id, attempt_number,
           requested_at, completed_at, outcome, http_status,
           response_headers_json, retry_after_ms, diagnostic
         ) VALUES (?, ?, ?, 1, '2026-08-03T00:00:00.000Z',
           '2026-08-03T00:00:01.000Z', 'success', 200, '{}', NULL, NULL)`,
      ).bind(item.fetchId, runId, item.requestId),
      testEnv.CATALOGUE_DB.prepare(
        `INSERT INTO source_snapshots (
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
           'fusion-world-en@9', NULL)`,
      ).bind(
        item.snapshotId,
        runId,
        item.requestId,
        item.fetchId,
        item.fixture.source_url,
        JSON.stringify({ accept: "text/html" }),
        item.digest,
        item.fixture.content_type,
        item.digest,
        item.bytes.byteLength,
        `source-snapshots/${item.snapshotId}.bin`,
      ),
    ]),
  ]);
  await Promise.all(
    retained.map((item) => testEnv.EVIDENCE_OBJECTS.put(`source-snapshots/${item.snapshotId}.bin`, item.bytes)),
  );

  for (const item of retained) {
    const parsed = await request(`/v1/source-snapshots/${item.snapshotId}/observations`, {
      adapter_version: "fusion-world-en@9",
      idempotency_key: `parse-${item.snapshotId}`,
    });
    expect(parsed.response.status).toBe(201);
  }

  const observationSets = await testEnv.CATALOGUE_DB.prepare(
    `SELECT source_snapshot_id, observation_count, content_object_key
     FROM source_observation_sets
     WHERE source_snapshot_id IN (?, ?)
     ORDER BY source_snapshot_id`,
  )
    .bind(fixtures[0]!.snapshotId, fixtures[1]!.snapshotId)
    .all<{
      source_snapshot_id: string;
      observation_count: number;
      content_object_key: string;
    }>();
  expect(observationSets.results.map((row) => row.observation_count)).toEqual([1, 1]);
  const documents = await Promise.all(
    observationSets.results.map(async (row) => {
      const object = await testEnv.EVIDENCE_OBJECTS.get(row.content_object_key);
      if (object === null) throw new Error("Live policy observations are absent");
      return object.json<{
        observations: Array<{ value: Record<string, unknown> }>;
      }>();
    }),
  );
  const rootObservation = documents
    .flatMap(({ observations }) => observations)
    .find(({ value }) => value.observation_type === "official_surface_evidence")?.value;
  expect(rootObservation?.records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        surface: "legality-current",
        url: "https://www.dbs-cardgame.com/fw/en/news/01_305.html",
      }),
    ]),
  );
  const legalityObservation = documents
    .flatMap(({ observations }) => observations)
    .find(({ value }) => value.observation_type === "legality_rules")?.value;
  const rules = legalityObservation?.legality_rules as Array<Record<string, unknown>> | undefined;
  expect(rules).toHaveLength(8);
  expect(
    rules?.every(
      (rule) => rule.effective_from === null && (rule.effect as Record<string, unknown>).type === "unresolved",
    ),
  ).toBe(true);
}, 90_000);

test("the One Piece production release surface publishes release timing through the export seam", async () => {
  const seeded = await injectFixtureEvidencePlan(testEnv.CATALOGUE_DB, {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: "seed-production-one-piece-release-card",
    requests: [
      {
        id: "seed-card",
        method: "GET",
        url: "https://official-source.invalid/reconciliation/base",
        headers: { accept: "application/json" },
      },
    ],
  });
  const seededRunId = requiredString(seeded, "id");
  expect((await request(`/v1/ingestion-runs/${seededRunId}/collection/resume`, {})).response.status).toBe(202);
  await waitForState(seededRunId, "parsing");
  const seededCandidate = await reconcile(seededRunId);
  expect(seededCandidate.response.status).toBe(200);
  const card = (seededCandidate.document.cards as Array<Record<string, unknown>>).find(
    (item) => (item.official_identity as Record<string, unknown>).value === "OP01-001",
  );
  if (card === undefined) throw new Error("OP01-001 is absent");
  expect((await approve(seededCandidate.document, "publish-production-one-piece-release-card")).response.status).toBe(
    200,
  );

  const started = await request("/v1/ingestion-runs/evidence", {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "one-piece-en@6",
    idempotency_key: "production-one-piece-release-timing-v2",
    requests: productionOnePieceReleaseTimingRequests(),
  });
  expect(started.response.status).toBe(201);
  const runId = requiredString(started.document, "id");
  expect((await request(`/v1/ingestion-runs/${runId}/collection/resume`, {})).response.status).toBe(202);
  await waitForState(runId, "awaiting_approval");
  const candidate = await request(`/v1/ingestion-runs/${runId}/candidate`);
  const published = await approve(candidate.document, "publish-production-one-piece-release-timing-v2");
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(published.document, "resulting_revision_id");

  expect(await exportedLegalityRule(revisionId, "OP-RELEASE-2026-001")).toMatchObject({
    game: "one-piece",
    official_wording: "OP01-001 becomes legal for standard tournament play on 2026-09-04.",
    effect: { type: "release_timing", legal_from: "2026-09-04" },
  });

  const changed = await request("/v1/ingestion-runs/evidence", {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "one-piece-en@6",
    idempotency_key: "production-one-piece-unrecognized-release-v2",
    requests: productionOnePieceReleaseTimingRequests("card-keepr-one-piece-unrecognized-release-v2"),
  });
  expect(changed.response.status).toBe(201);
  const changedRunId = requiredString(changed.document, "id");
  expect((await request(`/v1/ingestion-runs/${changedRunId}/collection/resume`, {})).response.status).toBe(202);
  await waitForState(changedRunId, "awaiting_approval");
  const changedCandidate = await request(`/v1/ingestion-runs/${changedRunId}/candidate`);
  expect(changedCandidate.response.status).toBe(200);
  const rejected = await request(`/v1/ingestion-runs/${changedRunId}/rejection`, {
    candidate_digest: requiredString(changedCandidate.document, "candidate_digest"),
    idempotency_key: "reject-ordinary-one-piece-product-release",
  });
  expect(rejected.response.status).toBe(200);
  expect(
    await testEnv.CATALOGUE_DB.prepare("SELECT current_revision_id FROM catalogue_state WHERE singleton = 1").first(
      "current_revision_id",
    ),
  ).toBe(revisionId);
}, 90_000);
