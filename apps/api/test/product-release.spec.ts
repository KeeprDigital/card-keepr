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
  await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
  const seeded = await testEnv.CATALOGUE_DB.prepare(
    "SELECT 1 AS present FROM catalogue_revisions WHERE id = 'catrev_products'",
  ).first<{ present: number }>();
  if (seeded !== null) return;
  const product = {
    type: "product",
    id: "product_st15",
    game: "one-piece",
    official_code: "ST-15",
    name: "Starter Deck RED Edward.Newgate",
    releases: [
      {
        id: "release_st15_oceania",
        region: "EN-OCEANIA",
        date: { precision: "month", value: "2026-09" },
        status: "announced",
      },
    ],
    lifecycle: {
      first_revision_id: "catrev_products",
      last_observed_revision_id: "catrev_products",
      withdrawn: false,
    },
    links: { self: "/v1/products/product_st15" },
  };
  const printing = {
    type: "printing",
    id: "printing_st15_event",
    card_id: "card_st15_event",
    rarity: { normalized: "leader", raw: "L" },
    printed_rules_text: "Official printed rules",
    game_data: {
      profile: "one-piece@1",
      attributes: { illustration_types: [] },
    },
    printing_images: [],
    distribution_contexts: [
      {
        id: "context_championship_2026",
        kind: "tournament_pack",
        label: "Championship 2026 Participation Pack",
        product_id: product.id,
        evidence_category: "derived",
      },
    ],
    relationship_evidence: [],
    locator_evidence: { current: [], historical: [] },
    lifecycle: product.lifecycle,
    links: { self: "/v1/printings/printing_st15_event" },
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
         'run_products', 'publishing', '["one-piece"]',
         '2026-01-01T00:00:00.000Z', 'catrev_spine_000', NULL,
         'products-seed', ?, '2026-01-01T00:00:00.000Z',
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
      `UPDATE operation_state SET active_ingestion_run_id = 'run_products'
       WHERE singleton = 1`,
    ),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO catalogue_revisions (
         id, ingestion_run_id, published_at, content_digest,
         expected_previous_revision_id, approved_candidate_digest
       ) VALUES (
         'catrev_products', 'run_products',
         '2026-01-01T00:00:00.000Z', ?,
         'catrev_spine_000', ?
       )`,
    ).bind("a".repeat(64), "a".repeat(64)),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO revision_products (
         catalogue_revision_id, product_id, supported_game, official_code,
         name, search_text, release_regions_json, document_json
       ) VALUES (
         'catrev_products', 'product_st15', 'one-piece', 'ST-15',
         'Starter Deck RED Edward.Newgate',
         'st-15 starter deck red edward.newgate',
         '["EN-OCEANIA"]', ?
       )`,
    ).bind(
      JSON.stringify({
        data: product,
        included: [],
        provenance: {},
        disagreements: [],
      }),
    ),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO revision_printings (
         catalogue_revision_id, printing_id, card_id, document_json
       ) VALUES ('catrev_products', ?, ?, ?)`,
    ).bind(printing.id, printing.card_id, JSON.stringify(printing)),
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE catalogue_state
       SET current_revision_id = 'catrev_products',
           published_at = '2026-01-01T00:00:00.000Z'
       WHERE singleton = 1`,
    ),
  ]);
});

test("authenticated Product reads preserve regional precision and announced status", async () => {
  const collection = await api("/v1/products?q=st-15");
  expect(collection.status).toBe(200);
  const collectionBody = await collection.json();
  expectSchema("ProductCollection", collectionBody);
  expect(collectionBody).toMatchObject({
    data: [
      {
        id: "product_st15",
        official_code: "ST-15",
        releases: [
          {
            region: "EN-OCEANIA",
            date: { precision: "month", value: "2026-09" },
            status: "announced",
          },
        ],
      },
    ],
  });

  const detail = await api("/v1/products/product_st15");
  expect(detail.status).toBe(200);
  const detailBody = await detail.json<{
    data: { lifecycle: Record<string, unknown> };
  }>();
  expectSchema("ProductDocument", detailBody);
  expect(detailBody.data.lifecycle).toEqual({
    first_revision_id: "catrev_products",
    last_observed_revision_id: "catrev_products",
    withdrawn: false,
  });

  const invalidProjection = await api(
    "/v1/products/product_st15?include=source_buckets",
  );
  expect(invalidProjection.status).toBe(400);
  await expect(invalidProjection.json()).resolves.toMatchObject({
    code: "invalid_parameter",
  });

  const printingRead = await api("/v1/printings/printing_st15_event");
  expect(printingRead.status).toBe(200);
  await expect(printingRead.json()).resolves.toMatchObject({
    data: {
      id: "printing_st15_event",
      distribution_contexts: [
        {
          kind: "tournament_pack",
          product_id: "product_st15",
          evidence_category: "derived",
        },
      ],
    },
  });
});

test("Product conditional reads return 304 for matching revision ETags", async () => {
  for (const path of ["/v1/products?q=st-15", "/v1/products/product_st15"]) {
    const first = await api(path);
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^".+"$/);
    const conditional = await api(path, { "if-none-match": etag! });
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe("");
    expect(conditional.headers.get("etag")).toBe(etag);
    expect(conditional.headers.get("x-catalogue-revision")).toBe(
      "catrev_products",
    );
  }
});

test("Product detail returns revision-pinned immutable provenance and disagreements", async () => {
  const unresolved = {
    data: {
      type: "product",
      id: "product_unresolved",
      game: "one-piece",
      official_code: "ST-UNRESOLVED",
      name: null,
      releases: [
        {
          id: "release_st15_oceania",
          region: "EN-OCEANIA",
          date: { precision: "month", value: "2026-09" },
          status: null,
        },
      ],
      lifecycle: {
        first_revision_id: "catrev_products",
        last_observed_revision_id: "catrev_products",
        withdrawn: false,
      },
      links: { self: "/v1/products/product_unresolved" },
    },
    included: [
      {
        type: "source_observation",
        id: "srcobs_product_a",
        captured_at: "2025-12-15T03:04:05.000Z",
        source: "one-piece-en",
      },
      {
        type: "source_observation",
        id: "srcobs_product_b",
        captured_at: "2025-12-16T04:05:06.000Z",
        source: "one-piece-en",
      },
    ],
    provenance: {
      "/data/official_code": ["srcobs_product_a", "srcobs_product_b"],
      "/data/releases/0/date/value": ["srcobs_product_a"],
    },
    disagreements: [
      {
        path: "/data/name",
        status: "unresolved",
        candidates: [
          { value: "Starter Deck A", observation_id: "srcobs_product_a" },
          { value: "Starter Deck B", observation_id: "srcobs_product_b" },
        ],
      },
      {
        path: "/data/releases/0/status",
        status: "unresolved",
        candidates: [
          { value: "announced", observation_id: "srcobs_product_a" },
          { value: "released", observation_id: "srcobs_product_b" },
        ],
      },
    ],
  };
  await testEnv.CATALOGUE_DB.prepare(
    `INSERT INTO revision_products (
       catalogue_revision_id, product_id, supported_game, official_code,
       name, search_text, release_regions_json, document_json
     ) VALUES (
       'catrev_products', 'product_unresolved', 'one-piece',
       'ST-UNRESOLVED', NULL, 'st-unresolved', '["EN-OCEANIA"]', ?
     )`,
  )
    .bind(JSON.stringify(unresolved))
    .run();

  try {
    const response = await api(
      "/v1/products/product_unresolved?include=evidence,disagreements",
    );
    expect(response.status).toBe(200);
    const document = await response.json();
    expectSchema("ProductDocument", document);
    expect(document).toMatchObject(unresolved);
  } finally {
    await testEnv.CATALOGUE_DB.prepare(
      `DELETE FROM revision_products
       WHERE catalogue_revision_id = 'catrev_products'
         AND product_id = 'product_unresolved'`,
    ).run();
  }
});

test("Product cursors pin the route and preserve filtered keyset order", async () => {
  const earlier = {
    type: "product",
    id: "product_st14",
    game: "one-piece",
    official_code: "ST-14",
    name: "Starter Deck 14",
    releases: [
      {
        id: "release_st14_oceania",
        region: "EN-OCEANIA",
        date: { precision: "day", value: "2026-08-01" },
        status: "released",
      },
    ],
    lifecycle: {
      first_revision_id: "catrev_products",
      last_observed_revision_id: "catrev_products",
      withdrawn: false,
    },
    links: { self: "/v1/products/product_st14" },
  };
  await testEnv.CATALOGUE_DB.prepare(
    `INSERT INTO revision_products (
       catalogue_revision_id, product_id, supported_game, official_code,
       name, search_text, release_regions_json, document_json
     ) VALUES (
       'catrev_products', 'product_st14', 'one-piece', 'ST-14',
       'Starter Deck 14', 'st-14 starter deck 14', '["EN-OCEANIA"]', ?
     )`,
  )
    .bind(
      JSON.stringify({
        data: earlier,
        included: [],
        provenance: {},
        disagreements: [],
      }),
    )
    .run();

  const firstResponse = await api(
    "/v1/products?game=one-piece&release_region=EN-OCEANIA&limit=1",
  );
  expect(firstResponse.status).toBe(200);
  const first = await firstResponse.json<{
    data: { id: string }[];
    page: { next_cursor: string };
  }>();
  expect(first.data.map(({ id }) => id)).toEqual(["product_st14"]);
  const second = await api(
    `/v1/products?game=one-piece&release_region=EN-OCEANIA&limit=1&after=${encodeURIComponent(first.page.next_cursor)}`,
  );
  expect(second.status).toBe(200);
  await expect(second.json()).resolves.toMatchObject({
    data: [{ id: "product_st15" }],
  });

  const forged = decodeCursor(first.page.next_cursor);
  const wrongRoute = encodeCursor({ ...forged, route: "/v1/cards" });
  const rejected = await api(
    `/v1/products?game=one-piece&release_region=EN-OCEANIA&limit=1&after=${encodeURIComponent(wrongRoute)}`,
  );
  expect(rejected.status).toBe(400);
  await expect(rejected.json()).resolves.toMatchObject({
    code: "invalid_cursor",
  });
});

function api(
  path: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://card-keepr.invalid${path}`, {
      headers: {
        authorization: "Bearer vitest-api-key",
        "cf-connecting-ip": "203.0.113.28",
        ...headers,
      },
    }),
  );
}

function decodeCursor(value: string): Record<string, unknown> {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4),
    "=",
  );
  return JSON.parse(atob(padded)) as Record<string, unknown>;
}

function encodeCursor(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function expectSchema(definition: string, value: unknown): void {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(apiSchema);
  const validate = ajv.getSchema(`${apiSchema.$id}#/$defs/${definition}`);
  expect(validate).toBeDefined();
  expect(validate!(value), JSON.stringify(validate!.errors)).toBe(true);
}
