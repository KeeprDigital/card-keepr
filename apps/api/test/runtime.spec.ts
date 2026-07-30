import {
  applyD1Migrations,
  env,
  type D1Migration,
} from "cloudflare:test";
import { exports } from "cloudflare:workers";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { beforeEach, expect, test } from "vitest";
import apiSchema from "../../../prototype/formalize-implementation-contracts/schemas/api.schema.json";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };

beforeEach(async () => {
  await applyD1Migrations(
    testEnv.CATALOGUE_DB,
    testEnv.TEST_MIGRATIONS,
  );
});

test("the API authentication boundary runs in the Workers runtime", async () => {
  const response = await exports.default.fetch(
    new Request("https://card-keepr.invalid/health", {
      headers: { authorization: "Bearer vitest-api-key" },
    }),
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    contract: "card-keepr-runtime-health@1",
    runtime: "api",
    status: "ok",
  });
});

test("the public Printing response validates full Distribution Context objects", async () => {
  const document = {
    type: "printing",
    id: "printing_api_context",
    card_id: "card_api_context",
    rarity: { normalized: "leader", raw: "L" },
    printed_rules_text: "Official printed rules",
    game_data: {
      profile: "one-piece@1",
      attributes: { illustration_types: [] },
    },
    printing_images: [],
    products: [],
    distribution_contexts: [
      {
        id: "context_event",
        kind: "other",
        label: "context_event",
        product_id: null,
        evidence_category: "explicit",
      },
    ],
    relationship_evidence: [
      {
        source_lineage: "one-piece-en",
        relationship_kind: "distribution_context",
        relationship_value: "context_event",
        source_observation_ids: ["srcobs_api_context_1"],
        first_revision_id: "catrev_api_context",
        last_observed_revision_id: "catrev_api_context",
        current: true,
        last_missing_revision_id: null,
      },
    ],
    locator_evidence: {
      current: [
        {
          source_lineage: "one-piece-en",
          locator: "/official/api-context",
          variant_key: null,
          first_revision_id: "catrev_api_context",
          last_observed_revision_id: "catrev_api_context",
          current: true,
          last_missing_revision_id: null,
        },
      ],
      historical: [],
    },
    lifecycle: {
      first_revision_id: "catrev_api_context",
      last_observed_revision_id: "catrev_api_context",
      withdrawn: false,
    },
    links: { self: "/v1/printings/printing_api_context" },
  };
  await testEnv.CATALOGUE_DB.batch([
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO ingestion_runs (
        id, state, selected_games_json, started_at,
        expected_current_revision_id, linked_run_id, idempotency_key,
        candidate_digest, candidate_created_at, approval_deadline,
        approval_json, published_revision_id, export_manifest_digest,
        terminal_at, candidate_json, approval_idempotency_key
      ) VALUES (
        'run_api_context', 'publishing', '["one-piece"]',
        '2026-01-01T00:00:00.000Z', 'catrev_spine_000', NULL,
        'api-context-seed', ?, '2026-01-01T00:00:00.000Z',
        '2099-01-01T00:00:00.000Z', ?, NULL, NULL, NULL, '{}', NULL
      )`,
    ).bind(
      "a".repeat(64),
      JSON.stringify({
        candidate_digest: "a".repeat(64),
        expected_current_revision_id: "catrev_spine_000",
        approved_at: "2026-01-01T00:00:00.000Z",
      }),
    ),
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE operation_state
       SET active_ingestion_run_id = 'run_api_context'
       WHERE singleton = 1`,
    ),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO catalogue_revisions (
        id, ingestion_run_id, published_at, content_digest,
        expected_previous_revision_id, approved_candidate_digest
      ) VALUES (
        'catrev_api_context', 'run_api_context',
        '2026-01-01T00:00:00.000Z', ?,
        'catrev_spine_000', ?
      )`,
    ).bind("a".repeat(64), "a".repeat(64)),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO revision_printings (
        catalogue_revision_id, printing_id, card_id, document_json
      ) VALUES (?, ?, ?, ?)`,
    ).bind(
      "catrev_api_context",
      document.id,
      document.card_id,
      JSON.stringify(document),
    ),
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE catalogue_state
       SET current_revision_id = 'catrev_api_context',
           published_at = '2026-01-01T00:00:00.000Z'
       WHERE singleton = 1`,
    ),
  ]);
  const response = await exports.default.fetch(
    new Request(
      "https://card-keepr.invalid/v1/printings/printing_api_context",
      {
        headers: {
          authorization: "Bearer vitest-api-key",
          "cf-connecting-ip": "203.0.113.10",
        },
      },
    ),
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(apiSchema);
  const validate = ajv.getSchema(
    `${apiSchema.$id}#/$defs/PrintingDocument`,
  );
  expect(validate).toBeDefined();
  expect(validate!(body), JSON.stringify(validate!.errors)).toBe(true);
  expect(body).toMatchObject({
    data: {
      distribution_contexts: [
        {
          id: "context_event",
          kind: "other",
          evidence_category: "explicit",
        },
      ],
    },
  });
  await testEnv.CATALOGUE_DB.batch([
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE ingestion_runs
       SET state = 'published',
           published_revision_id = 'catrev_api_context',
           resulting_revision_id = 'catrev_api_context',
           publication_outcome = 'revision',
           terminal_at = '2026-01-01T00:00:00.000Z'
       WHERE id = 'run_api_context'`,
    ),
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE operation_state
       SET active_ingestion_run_id = NULL
       WHERE active_ingestion_run_id = 'run_api_context'`,
    ),
  ]);
});

test("authenticated Card and Printing reads expose Effective and Printed Rules Text as distinct values", async () => {
  const lifecycle = {
    first_revision_id: "catrev_errata_read",
    last_observed_revision_id: "catrev_errata_read",
    withdrawn: false,
  };
  const card = {
    type: "card",
    id: "card_errata_read",
    game: "one-piece",
    official_identity: { kind: "card_number", value: "OP29-001" },
    name: "Errata Rules Card",
    game_data: {
      profile: "one-piece@1",
      attributes: {
        card_type: "leader",
        colours: ["red"],
        cost: null,
        life: 5,
        battle_attributes: [],
        power: 5000,
        counter: null,
        traits: [],
        block_icons: [],
        effect_text: "[On Play] Draw 1 card.",
        trigger_text: null,
      },
    },
    effective_rules_text:
      "[On Play] Draw 2 cards, then discard 1 card.",
    printing_ids: ["printing_errata_read"],
    lifecycle,
    links: { self: "/v1/cards/card_errata_read" },
  };
  const printing = {
    type: "printing",
    id: "printing_errata_read",
    card_id: card.id,
    rarity: { normalized: "leader", raw: "L" },
    printed_rules_text: "[On Play] Draw 1 card.",
    game_data: {
      profile: "one-piece@1",
      attributes: { illustration_types: [] },
    },
    printing_images: [],
    distribution_contexts: [],
    relationship_evidence: [],
    locator_evidence: { current: [], historical: [] },
    lifecycle,
    links: { self: "/v1/printings/printing_errata_read" },
  };
  await testEnv.CATALOGUE_DB.batch([
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO ingestion_runs (
        id, state, selected_games_json, started_at,
        expected_current_revision_id, linked_run_id, idempotency_key,
        candidate_digest, candidate_created_at, approval_deadline,
        approval_json, published_revision_id, export_manifest_digest,
        terminal_at, candidate_json, approval_idempotency_key
      ) VALUES (
        'run_errata_read', 'publishing', '["one-piece"]',
        '2026-07-01T00:00:00.000Z', 'catrev_api_context', NULL,
        'errata-read-seed', ?, '2026-07-01T00:00:00.000Z',
        '2099-01-01T00:00:00.000Z', ?, NULL, NULL, NULL, '{}', NULL
      )`,
    ).bind(
      "b".repeat(64),
      JSON.stringify({
        candidate_digest: "b".repeat(64),
        expected_current_revision_id: "catrev_api_context",
        approved_at: "2026-07-01T00:00:00.000Z",
      }),
    ),
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE operation_state
       SET active_ingestion_run_id = 'run_errata_read'
       WHERE singleton = 1`,
    ),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO catalogue_revisions (
        id, ingestion_run_id, published_at, content_digest,
        expected_previous_revision_id, approved_candidate_digest
      ) VALUES (
        'catrev_errata_read', 'run_errata_read',
        '2026-07-01T00:00:00.000Z', ?,
        'catrev_api_context', ?
      )`,
    ).bind("b".repeat(64), "b".repeat(64)),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO revision_cards (
        catalogue_revision_id, card_id, document_json
      ) VALUES (?, ?, ?)`,
    ).bind("catrev_errata_read", card.id, JSON.stringify(card)),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO revision_printings (
        catalogue_revision_id, printing_id, card_id, document_json
      ) VALUES (?, ?, ?, ?)`,
    ).bind(
      "catrev_errata_read",
      printing.id,
      printing.card_id,
      JSON.stringify(printing),
    ),
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE catalogue_state
       SET current_revision_id = 'catrev_errata_read',
           published_at = '2026-07-01T00:00:00.000Z'
       WHERE singleton = 1`,
    ),
  ]);

  const headers = {
    authorization: "Bearer vitest-api-key",
    "cf-connecting-ip": "203.0.113.29",
  };
  const [cardResponse, printingResponse, searchResponse] = await Promise.all([
    exports.default.fetch(
      new Request("https://card-keepr.invalid/v1/cards/card_errata_read", {
        headers,
      }),
    ),
    exports.default.fetch(
      new Request(
        "https://card-keepr.invalid/v1/printings/printing_errata_read",
        { headers },
      ),
    ),
    exports.default.fetch(
      new Request(
        "https://card-keepr.invalid/v1/cards?q=discard%201%20card",
        { headers },
      ),
    ),
  ]);
  expect(cardResponse.status).toBe(200);
  expect(printingResponse.status).toBe(200);
  expect(searchResponse.status).toBe(200);
  await expect(cardResponse.json()).resolves.toMatchObject({
    data: {
      effective_rules_text:
        "[On Play] Draw 2 cards, then discard 1 card.",
    },
  });
  await expect(printingResponse.json()).resolves.toMatchObject({
    data: { printed_rules_text: "[On Play] Draw 1 card." },
  });
  await expect(searchResponse.json()).resolves.toMatchObject({
    data: [{ id: card.id }],
    page: { limit: 50, next_cursor: null },
  });
  const etag = searchResponse.headers.get("etag");
  expect(etag).not.toBeNull();
  const notModifiedResponse = await exports.default.fetch(
    new Request(
      "https://card-keepr.invalid/v1/cards?q=discard%201%20card",
      {
        headers: {
          ...headers,
          "if-none-match": etag!,
        },
      },
    ),
  );
  expect(notModifiedResponse.status).toBe(304);
  expect(notModifiedResponse.headers.get("x-catalogue-revision")).toBe(
    "catrev_errata_read",
  );
  await testEnv.CATALOGUE_DB.batch([
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE ingestion_runs
       SET state = 'published',
           published_revision_id = 'catrev_errata_read',
           resulting_revision_id = 'catrev_errata_read',
           publication_outcome = 'revision',
           terminal_at = '2026-07-01T00:00:00.000Z'
       WHERE id = 'run_errata_read'`,
    ),
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE operation_state
       SET active_ingestion_run_id = NULL
       WHERE active_ingestion_run_id = 'run_errata_read'`,
    ),
  ]);
});

test("the normative Printing schema excludes SourceBucket from canonical relationship evidence", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(apiSchema);
  const validate = ajv.getSchema(
    `${apiSchema.$id}#/$defs/RelationshipEvidence`,
  );
  expect(validate).toBeDefined();
  const relationship = {
    source_lineage: "one-piece-en",
    relationship_kind: "product",
    relationship_value: "product_op10",
    source_observation_ids: ["srcobs_contract_1"],
    first_revision_id: "catrev_contract",
    last_observed_revision_id: "catrev_contract",
    current: true,
    last_missing_revision_id: null,
  };
  expect(validate!(relationship), JSON.stringify(validate!.errors)).toBe(
    true,
  );
  expect(
    validate!({
      ...relationship,
      relationship_kind: "source_bucket",
      relationship_value: "primary-card-list",
    }),
  ).toBe(false);
});
