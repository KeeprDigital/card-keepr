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
import {
  cardSearchChunks,
  cardSearchQuery,
  cardSearchTerms,
  cardSearchText,
} from "../../../src/catalogue/card-search";

const testEnv = env as Env & {
  TEST_MIGRATIONS: D1Migration[];
};

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

test("an empty current Catalogue Revision remains queryable through its projection", async () => {
  await seedApiRevision({
    revisionId: "catrev_empty_query_projection",
    runId: "run_empty_query_projection",
    cards: [],
  });
  const response = await exports.default.fetch(
    new Request("https://card-keepr.invalid/v1/cards", {
      headers: apiHeaders("203.0.113.59"),
    }),
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    data: [],
    meta: {
      catalogue_revision_id: "catrev_empty_query_projection",
    },
    page: { next_cursor: null },
  });
});

test("every Card collection shape returns the normative 503 while the current projection is unavailable", async () => {
  await seedApiRevision({
    revisionId: "catrev_pending_query_projection",
    runId: "run_pending_query_projection",
    cards: [
      apiCard({
        id: "card_pending_query_projection",
        cardNumber: "OP29-503",
        name: "Pending Projection",
      }),
    ],
  });
  await testEnv.CATALOGUE_DB.prepare(
    `UPDATE catalogue_query_revisions
     SET state = 'pending'
     WHERE catalogue_revision_id = 'catrev_pending_query_projection'`,
  ).run();
  for (const path of ["/v1/cards", "/v1/cards?q=pending"]) {
    const response = await exports.default.fetch(
      new Request(`https://card-keepr.invalid${path}`, {
        headers: apiHeaders("203.0.113.60"),
      }),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: 503,
      code: "catalogue_query_unavailable",
    });
  }
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
  const previousRevisionId = await testEnv.CATALOGUE_DB.prepare(
    `SELECT current_revision_id
     FROM catalogue_state WHERE singleton = 1`,
  ).first<string>("current_revision_id");
  if (previousRevisionId === null) {
    throw new Error("The API test catalogue state is unavailable.");
  }
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
        '2026-01-01T00:00:00.000Z', ?, NULL,
        'api-context-seed', ?, '2026-01-01T00:00:00.000Z',
        '2099-01-01T00:00:00.000Z', ?, NULL, NULL, NULL, '{}', NULL
      )`,
    ).bind(
      previousRevisionId,
      "a".repeat(64),
      JSON.stringify({
        candidate_digest: "a".repeat(64),
        expected_current_revision_id: previousRevisionId,
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
        ?, ?
      )`,
    ).bind(
      "a".repeat(64),
      previousRevisionId,
      "a".repeat(64),
    ),
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
  const previousRevisionId = await testEnv.CATALOGUE_DB.prepare(
    `SELECT current_revision_id
     FROM catalogue_state WHERE singleton = 1`,
  ).first<string>("current_revision_id");
  if (previousRevisionId === null) {
    throw new Error("The API test catalogue state is unavailable.");
  }
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
        '2026-07-01T00:00:00.000Z', ?, NULL,
        'errata-read-seed', ?, '2026-07-01T00:00:00.000Z',
        '2099-01-01T00:00:00.000Z', ?, NULL, NULL, NULL, '{}', NULL
      )`,
    ).bind(
      previousRevisionId,
      "b".repeat(64),
      JSON.stringify({
        candidate_digest: "b".repeat(64),
        expected_current_revision_id: previousRevisionId,
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
        ?, ?
      )`,
    ).bind(
      "b".repeat(64),
      previousRevisionId,
      "b".repeat(64),
    ),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO revision_cards (
        catalogue_revision_id, card_id, document_json
      ) VALUES (?, ?, ?)`,
    ).bind(
      "catrev_errata_read",
      card.id,
      JSON.stringify(card),
    ),
    ...cardSearchStatements("catrev_errata_read", card),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO catalogue_query_revisions (
         catalogue_revision_id, state, repaired_through_card_id
       ) VALUES ('catrev_errata_read', 'available', NULL)`,
    ),
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
  await testEnv.CATALOGUE_DB.prepare(
    `INSERT INTO revision_cards (
       catalogue_revision_id, card_id, document_json
     ) VALUES (?, ?, ?)`,
  )
    .bind(
      "catrev_errata_read",
      "card_etag_query_must_not_load",
      JSON.stringify({
        ...card,
        id: "card_etag_query_must_not_load",
        official_identity: {
          kind: "card_number",
          value: "OP29-999",
        },
        name: "Does not match the query",
        effective_rules_text: {},
      }),
    )
    .run();
  const conditionalResponses = await Promise.all(
    [
      etag!,
      `W/${etag}`,
      `"unrelated", W/${etag}`,
      "*",
    ].map((ifNoneMatch) =>
      exports.default.fetch(
        new Request(
          "https://card-keepr.invalid/v1/cards?q=discard%201%20card",
          {
            headers: {
              ...headers,
              "if-none-match": ifNoneMatch,
            },
          },
        ),
      ),
    ),
  );
  expect(conditionalResponses.map((response) => response.status)).toEqual([
    304, 304, 304, 304,
  ]);
  for (const response of conditionalResponses) {
    expect(response.headers.get("x-catalogue-revision")).toBe(
      "catrev_errata_read",
    );
  }
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

test("Card collection filtering and keyset pagination remain bounded in D1", async () => {
  const card = apiCard({
    id: "card_bounded_001",
    cardNumber: "OP29-101",
    name: "Bounded Alpha",
  });
  await seedApiRevision({
    revisionId: "catrev_bounded_read",
    runId: "run_bounded_read",
    cards: [
      card,
      apiCard({
        id: "card_bounded_002",
        cardNumber: "OP29-102",
        name: "Bounded Beta",
      }),
      {
        ...apiCard({
          id: "card_bounded_invalid_later",
          cardNumber: "OP29-999",
          name: "Does not match",
        }),
        effective_rules_text: {},
      },
    ],
  });

  const response = await exports.default.fetch(
    new Request(
      "https://card-keepr.invalid/v1/cards?q=bounded&limit=1",
      { headers: apiHeaders("203.0.113.30") },
    ),
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    data: [{ id: card.id }],
    page: {
      limit: 1,
      next_cursor: expect.any(String),
    },
  });
});

test("Card search is canonically Unicode case-insensitive", async () => {
  await seedApiRevision({
    revisionId: "catrev_unicode_search",
    runId: "run_unicode_search",
    cards: [
      apiCard({
        id: "card_unicode_search",
        cardNumber: "OP29-Ü01",
        name: "Éclair LÜFFY",
      }),
    ],
  });
  const response = await exports.default.fetch(
    new Request(
      "https://card-keepr.invalid/v1/cards?q=E%CC%81CLAIR%20lüffy",
      { headers: apiHeaders("203.0.113.34") },
    ),
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    data: [{ id: "card_unicode_search" }],
  });
});

test("Card search uses selective literal trigrams before exact substring filtering", async () => {
  const ordinaryCards = Array.from({ length: 200 }, (_, index) =>
    apiCard({
      id: `card_selectivity_${String(index).padStart(3, "0")}`,
      cardNumber: `OP31-${String(index).padStart(3, "0")}`,
      name: `Ordinary leader number ${index}`,
      effectiveRulesText:
        "Activate Main Once Per Turn: draw one card from your deck.",
    })
  );
  const selected = apiCard({
    id: "card_selectivity_quartz",
    cardNumber: "OP31-999",
    name: "Quartz Vanguard",
    effectiveRulesText:
      "Activate Main: reveal the quartz marker from your deck.",
  });
  await seedApiRevision({
    revisionId: "catrev_selective_trigrams",
    runId: "run_selective_trigrams",
    cards: [...ordinaryCards, selected],
  });

  const query = cardSearchQuery("quartz");
  expect(query).toEqual({ text: "quartz", anchorTerm: "g3:qua" });
  const candidates = await testEnv.CATALOGUE_DB.prepare(
    `SELECT COUNT(DISTINCT card_id) AS count
     FROM revision_card_search_terms
     WHERE catalogue_revision_id = ? AND term = ?`,
  )
    .bind("catrev_selective_trigrams", query!.anchorTerm)
    .first<{ count: number }>();
  expect(candidates?.count).toBe(1);

  const matched = await exports.default.fetch(
    new Request("https://card-keepr.invalid/v1/cards?q=uart", {
      headers: apiHeaders("203.0.113.61"),
    }),
  );
  expect(matched.status).toBe(200);
  await expect(matched.json()).resolves.toMatchObject({
    data: [{ id: "card_selectivity_quartz" }],
  });
  const collisionWithoutSubstring = await exports.default.fetch(
    new Request("https://card-keepr.invalid/v1/cards?q=quarx", {
      headers: apiHeaders("203.0.113.62"),
    }),
  );
  expect(collisionWithoutSubstring.status).toBe(200);
  await expect(collisionWithoutSubstring.json()).resolves.toMatchObject({
    data: [],
  });

  const repeated = cardSearchTerms(cardSearchText({
    official_identity: { value: "A" },
    name: "A".repeat(50_000),
    effective_rules_text: "A".repeat(50_000),
  }));
  expect(repeated).toEqual(["g1:a", "g2:aa", "g3:aaa"]);
});

test("authenticated Card search validates raw q at 1 through 500 characters before normalization", async () => {
  const token = (length: number) => "x".repeat(length);
  await seedApiRevision({
    revisionId: "catrev_query_boundaries",
    runId: "run_query_boundaries",
    cards: [
      apiCard({
        id: "card_query_boundaries",
        cardNumber: "OP29-500",
        name: [
          token(1),
          token(128),
          token(129),
          token(500),
        ].join(" "),
      }),
    ],
  });
  let sequence = 40;
  for (const query of [
    token(1),
    token(128),
    token(129),
    token(500),
    "ﬀ".repeat(500),
    "---",
  ]) {
    const response = await exports.default.fetch(
      new Request(
        `https://card-keepr.invalid/v1/cards?q=${
          encodeURIComponent(query)
        }`,
        { headers: apiHeaders(`203.0.113.${sequence++}`) },
      ),
    );
    expect(response.status, `${query.length}: ${await response.clone().text()}`)
      .toBe(200);
  }
  for (const [query, reason] of [
    [token(501), "q must contain at most 500 characters."],
  ] as const) {
    const response = await exports.default.fetch(
      new Request(
        `https://card-keepr.invalid/v1/cards?q=${
          encodeURIComponent(query)
        }`,
        { headers: apiHeaders(`203.0.113.${sequence++}`) },
      ),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_parameter",
      invalid_params: [{ name: "q", reason }],
    });
  }
});

test("authenticated Card collection pages remain byte-bounded for large valid records", async () => {
  const cards = Array.from({ length: 18 }, (_, index) =>
    apiCard({
      id: `card_large_page_${String(index).padStart(3, "0")}`,
      cardNumber: `OP29-${String(600 + index)}`,
      name: `Large Card ${String(index).padStart(3, "0")} ${
        "x".repeat(250_000)
      }`,
    })
  );
  await seedApiRevision({
    revisionId: "catrev_large_page",
    runId: "run_large_page",
    cards,
  });
  const response = await exports.default.fetch(
    new Request("https://card-keepr.invalid/v1/cards?limit=100", {
      headers: apiHeaders("203.0.113.58"),
    }),
  );
  expect(response.status).toBe(200);
  const bytes = new Uint8Array(await response.clone().arrayBuffer());
  const document = await response.json<{
    data: unknown[];
    page: { next_cursor: string | null };
  }>();
  expect(bytes.byteLength).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(document.data.length).toBeGreaterThan(0);
  expect(document.data.length).toBeLessThan(cards.length);
  expect(document.page.next_cursor).toEqual(expect.any(String));
});

test("Card search persistence remains compatible with D1 export", async () => {
  const virtualTables = await testEnv.CATALOGUE_DB.prepare(
    `SELECT name FROM sqlite_schema
     WHERE type = 'table' AND lower(sql) LIKE '%create virtual table%'`,
  ).all<{ name: string }>();
  expect(virtualTables.results).toEqual([]);
});

test("Card cursors continue on an available pinned revision and conflict only after it is unavailable", async () => {
  await seedApiRevision({
    revisionId: "catrev_cursor_old",
    runId: "run_cursor_old",
    cards: [
      apiCard({
        id: "card_cursor_001",
        cardNumber: "OP29-201",
        name: "Cursor Alpha",
      }),
      apiCard({
        id: "card_cursor_002",
        cardNumber: "OP29-202",
        name: "Cursor Beta",
      }),
    ],
  });
  const firstPage = await exports.default.fetch(
    new Request(
      "https://card-keepr.invalid/v1/cards?q=cursor&limit=1",
      { headers: apiHeaders("203.0.113.31") },
    ),
  );
  expect(firstPage.status).toBe(200);
  const firstPageDocument = await firstPage.json<{
    page: { next_cursor: string };
  }>();
  expect(firstPageDocument.page.next_cursor).toEqual(expect.any(String));

  await seedApiRevision({
    revisionId: "catrev_cursor_new",
    runId: "run_cursor_new",
    cards: [
      apiCard({
        id: "card_cursor_new",
        cardNumber: "OP29-203",
        name: "Cursor New Revision",
      }),
    ],
  });
  const pinnedUrl =
    `https://card-keepr.invalid/v1/cards?q=cursor&limit=1&after=` +
    encodeURIComponent(firstPageDocument.page.next_cursor);
  const available = await exports.default.fetch(
    new Request(pinnedUrl, {
      headers: apiHeaders("203.0.113.32"),
    }),
  );
  expect(available.status).toBe(200);
  await expect(available.json()).resolves.toMatchObject({
    data: [{ id: "card_cursor_002" }],
    meta: { catalogue_revision_id: "catrev_cursor_old" },
  });

  await testEnv.CATALOGUE_DB.prepare(
    `INSERT INTO catalogue_exports (
       catalogue_revision_id, manifest_key, manifest_digest, verified
     ) VALUES (
       'catrev_cursor_old',
       'catalogue/catrev_cursor_old/manifest.json',
       ?, 1
     )`,
  )
    .bind("e".repeat(64))
    .run();
  await testEnv.CATALOGUE_DB.prepare(
    `DELETE FROM revision_card_query_documents
     WHERE catalogue_revision_id = 'catrev_cursor_old'`,
  ).run();
  await expect(
    testEnv.CATALOGUE_DB.prepare(
      `SELECT
         EXISTS(
           SELECT 1 FROM catalogue_revisions
           WHERE id = 'catrev_cursor_old'
         ) AS revision_retained,
         EXISTS(
           SELECT 1 FROM catalogue_exports
           WHERE catalogue_revision_id = 'catrev_cursor_old'
         ) AS export_retained`,
    ).first(),
  ).resolves.toMatchObject({
    revision_retained: 1,
    export_retained: 1,
  });
  const unavailable = await exports.default.fetch(
    new Request(pinnedUrl, {
      headers: apiHeaders("203.0.113.33"),
    }),
  );
  expect(unavailable.status).toBe(409);
  await expect(unavailable.json()).resolves.toMatchObject({
    code: "cursor_revision_unavailable",
  });
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

function apiHeaders(ip: string): Record<string, string> {
  return {
    authorization: "Bearer vitest-api-key",
    "cf-connecting-ip": ip,
  };
}

function encodeTestCardCursor(input: {
  revisionId: string;
  q: string | null;
  limit: number;
  after: {
    game: string;
    identityKind: string;
    identityValue: string;
    id: string;
  };
}): string {
  const bytes = new TextEncoder().encode(JSON.stringify({
    contract: "card-keepr-card-cursor@1",
    revision_id: input.revisionId,
    q: input.q,
    game: null,
    card_number: null,
    limit: input.limit,
    after: {
      game: input.after.game,
      identity_kind: input.after.identityKind,
      identity_value: input.after.identityValue,
      id: input.after.id,
    },
  }));
  return btoa(String.fromCharCode(...bytes));
}

type ApiCardFixture = Record<string, unknown> & {
  id: string;
  official_identity: { kind: string; value: string };
  name: string;
  effective_rules_text: unknown;
};

function apiCard(input: {
  id: string;
  cardNumber: string;
  name: string;
  effectiveRulesText?: string;
}): ApiCardFixture {
  return {
    type: "card",
    id: input.id,
    game: "one-piece",
    official_identity: {
      kind: "card_number",
      value: input.cardNumber,
    },
    name: input.name,
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
        effect_text: input.name,
        trigger_text: null,
      },
    },
    effective_rules_text: input.effectiveRulesText ?? input.name,
    printing_ids: [],
    lifecycle: {
      first_revision_id: "catrev_fixture",
      last_observed_revision_id: "catrev_fixture",
      withdrawn: false,
    },
    links: { self: `/v1/cards/${input.id}` },
  };
}

async function seedApiRevision(input: {
  revisionId: string;
  runId: string;
  cards: readonly ApiCardFixture[];
}): Promise<void> {
  const digest = "b".repeat(64);
  const previousRevisionId = await testEnv.CATALOGUE_DB.prepare(
    `SELECT current_revision_id
     FROM catalogue_state WHERE singleton = 1`,
  ).first<string>("current_revision_id");
  if (previousRevisionId === null) {
    throw new Error("The API test catalogue state is unavailable.");
  }
  await testEnv.CATALOGUE_DB.batch([
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO ingestion_runs (
         id, state, selected_games_json, started_at,
         expected_current_revision_id, linked_run_id, idempotency_key,
         candidate_digest, candidate_created_at, approval_deadline,
         approval_json, published_revision_id, export_manifest_digest,
         terminal_at, candidate_json, approval_idempotency_key
       ) VALUES (
         ?, 'publishing', '["one-piece"]',
         '2026-07-20T00:00:00.000Z', ?, NULL, ?, ?,
         '2026-07-20T00:00:00.000Z',
         '2099-01-01T00:00:00.000Z', ?, NULL, NULL, NULL, '{}', NULL
       )`,
    ).bind(
      input.runId,
      previousRevisionId,
      `${input.runId}-seed`,
      digest,
      JSON.stringify({
        candidate_digest: digest,
        expected_current_revision_id: previousRevisionId,
        approved_at: "2026-07-20T00:00:00.000Z",
      }),
    ),
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE operation_state
       SET active_ingestion_run_id = ?
       WHERE singleton = 1`,
    ).bind(input.runId),
  ]);
  await testEnv.CATALOGUE_DB.prepare(
    `INSERT INTO catalogue_revisions (
       id, ingestion_run_id, published_at, content_digest,
       expected_previous_revision_id, approved_candidate_digest
     ) VALUES (?, ?, '2026-07-20T00:00:00.000Z', ?, ?, ?)`,
  )
    .bind(
      input.revisionId,
      input.runId,
      digest,
      previousRevisionId,
      digest,
    )
    .run();
  await testEnv.CATALOGUE_DB.batch([
    ...input.cards.flatMap((card) => [
      testEnv.CATALOGUE_DB.prepare(
        `INSERT INTO revision_cards (
           catalogue_revision_id, card_id, document_json
         ) VALUES (?, ?, ?)`,
      ).bind(
        input.revisionId,
        card.id,
        JSON.stringify(card),
      ),
      ...cardSearchStatements(input.revisionId, card),
    ]),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO catalogue_query_revisions (
         catalogue_revision_id, state, repaired_through_card_id
       ) VALUES (?, 'available', NULL)`,
    ).bind(input.revisionId),
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE catalogue_state
       SET current_revision_id = ?,
           published_at = '2026-07-20T00:00:00.000Z'
       WHERE singleton = 1`,
    ).bind(input.revisionId),
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE ingestion_runs
       SET state = 'published',
           published_revision_id = ?,
           resulting_revision_id = ?,
           publication_outcome = 'revision',
           terminal_at = '2026-07-20T00:00:00.000Z'
       WHERE id = ?`,
    ).bind(input.revisionId, input.revisionId, input.runId),
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE operation_state
       SET active_ingestion_run_id = NULL
       WHERE active_ingestion_run_id = ?`,
    ).bind(input.runId),
  ]);
}

function cardSearchStatements(
  revisionId: string,
  card: ApiCardFixture,
): D1PreparedStatement[] {
  return [
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO revision_card_query_documents (
         catalogue_revision_id, card_id, summary_json, search_text
       ) VALUES (?, ?, ?, ?)`,
    ).bind(
      revisionId,
      card.id,
      JSON.stringify(apiCardSummary(card)),
      apiCardSearchText(card),
    ),
    ...cardSearchTerms(apiCardSearchText(card)).map((term) =>
      testEnv.CATALOGUE_DB.prepare(
        `INSERT INTO revision_card_search_terms (
           catalogue_revision_id, card_id, term, sort_game,
           sort_identity_kind, sort_identity_value, sort_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        revisionId,
        card.id,
        term,
        card.game,
        card.official_identity.kind,
        card.official_identity.value,
        card.id,
      )
    ),
    ...cardSearchChunks(apiCardSearchText(card)).map((chunk) =>
      testEnv.CATALOGUE_DB.prepare(
        `INSERT INTO revision_card_search_chunks (
           catalogue_revision_id, card_id, field_ordinal,
           chunk_ordinal, search_text
         ) VALUES (?, ?, ?, ?, ?)`,
      ).bind(
        revisionId,
        card.id,
        chunk.field,
        chunk.ordinal,
        chunk.text,
      )
    ),
  ];
}

function apiCardSummary(card: ApiCardFixture) {
  return {
    type: card.type,
    id: card.id,
    game: card.game,
    official_identity: card.official_identity,
    name: card.name,
    game_data: card.game_data,
    lifecycle: card.lifecycle,
    links: card.links,
  };
}

function apiCardSearchText(card: ApiCardFixture): string {
  return cardSearchText({
    official_identity: card.official_identity,
    name: card.name,
    effective_rules_text:
      typeof card.effective_rules_text === "string" ||
      card.effective_rules_text === null
        ? card.effective_rules_text
        : null,
  });
}
