import {
  applyD1Migrations,
  env,
  type D1Migration,
} from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { contextualLegalityStatusResponse } from "../../../src/catalogue/legality-status";
import { sha256, utf8 } from "../../../src/catalogue/serialization";
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
       'legality_rules_immutable_delete'
     ) ORDER BY name`,
  ).all<{ name: string }>();
  expect(guards.results.map((row) => row.name)).toEqual([
    "guard_legality_rule_identity",
    "legality_rules_immutable_delete",
  ]);
});

test.each([
  ["one-piece-json-document@3", "one-piece", "one-piece-en"],
  ["fusion-world-en@2", "fusion-world", "fusion-world-en"],
  ["digimon-en@2", "digimon", "digimon-en"],
  ["gundam-en-asia@2", "gundam", "gundam-en-asia"],
  ["gundam-en-us@2", "gundam", "gundam-en-us"],
])(
  "production planning rejects the undemonstrated %s JSON publisher representation",
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
  ["one-piece-json-document@1", "one-piece", "one-piece-en"],
  ["one-piece-json-document@2", "one-piece", "one-piece-en"],
  ["fusion-world-en@1", "fusion-world", "fusion-world-en"],
  ["digimon-en@1", "digimon", "digimon-en"],
  ["gundam-en-asia@1", "gundam", "gundam-en-asia"],
  ["gundam-en-us@1", "gundam", "gundam-en-us"],
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
      adapter_version: "one-piece-json-document@1",
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

test("an unfetched nested image URL cannot enter the official pipeline as byte-proven Printing identity", async () => {
  const blocked = await request("/v1/ingestion-runs/evidence", {
    supported_game: "gundam",
    source_lineage: "gundam-en-asia",
    adapter_version: "gundam-en-asia@2",
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

test("every nested Fusion World image candidate is refused until final bytes and authority are captured", async () => {
  const blocked = await request("/v1/ingestion-runs/evidence", {
    supported_game: "fusion-world",
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@2",
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
      adapter_version: "gundam-en-asia@2",
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
  expect([
    String(identityUpdate),
    String(firstRevisionUpdate),
    String(canonicalDelete),
    String(orphanRevisionRule),
  ]).toEqual([
    expect.stringMatching(/legality_rule_identity_conflict/),
    expect.stringMatching(/legality_rule_identity_conflict/),
    expect.stringMatching(/legality_rule_immutable/),
    expect.stringMatching(/FOREIGN KEY constraint failed/),
  ]);
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

async function collectFixtureLegality(
  url: string,
  idempotencyKey: string,
  expectedStatus = 200,
): Promise<{
  runId: string;
  reconciled: Record<string, unknown>;
}> {
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
  const reconciled = await request(
    `/v1/ingestion-runs/${runId}/reconciliation`,
    {},
  );
  expect(reconciled.response.status).toBe(expectedStatus);
  return { runId, reconciled: reconciled.document };
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

function resolveJsonPointer(document: unknown, pointer: string): unknown {
  return pointer.split("/").slice(1).reduce<unknown>((value, encoded) => {
    if (value === null || typeof value !== "object") {
      throw new Error(`JSON Pointer ${pointer} does not resolve`);
    }
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    return (value as Record<string, unknown>)[key];
  }, document);
}

async function rejectedError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}
