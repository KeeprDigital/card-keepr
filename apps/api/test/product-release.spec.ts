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
        event_key: "oceania-announcement",
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
  const printingImage = {
    type: "printing_image",
    id: "printing_image_st15_front",
    printing_id: "printing_st15_event",
    role: "front",
    media_type: "image/webp",
    width: 744,
    height: 1039,
    content_sha256:
      "46f3e4bfb8bc9956482a6491e9b968d82e6fd544da44f9f36d93b443b845f773",
    links: {
      self: "/v1/printing-images/printing_image_st15_front",
      content:
        "/v1/printing-images/printing_image_st15_front/content",
    },
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
    printing_images: [printingImage],
    products: [],
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
  const card = {
    type: "card",
    id: printing.card_id,
    game: "one-piece",
    official_identity: { kind: "card_number", value: "ST15-001" },
    name: "Starter Deck Event Card",
    effective_rules_text: "Official printed rules",
    game_data: {
      profile: "one-piece@1",
      attributes: {
        card_type: "leader",
        colours: ["red"],
        cost: null,
        life: 5,
        battle_attributes: ["strike"],
        power: 5000,
        counter: null,
        traits: ["Test"],
        block_icons: [],
        effect_text: "Official printed rules",
        trigger_text: null,
      },
    },
    printing_ids: [printing.id],
    lifecycle: product.lifecycle,
    links: { self: `/v1/cards/${printing.card_id}` },
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
      `INSERT INTO catalogue_query_revisions (
         catalogue_revision_id, state, repaired_through_card_id
       ) VALUES ('catrev_products', 'available', NULL)`,
    ),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO revision_products_fts (
         catalogue_revision_id, product_id, search_text
       ) VALUES ('catrev_products', 'product_st15',
                 'st-15 starter deck red edward.newgate')`,
    ),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO revision_cards (
         catalogue_revision_id, card_id, document_json
       ) VALUES ('catrev_products', ?, ?)`,
    ).bind(card.id, JSON.stringify(card)),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO revision_printings (
         catalogue_revision_id, printing_id, card_id, document_json
       ) VALUES ('catrev_products', ?, ?, ?)`,
    ).bind(printing.id, printing.card_id, JSON.stringify(printing)),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO reconciled_printing_images (
         id, printing_id, role, media_type, width, height,
         content_sha256, content_byte_length, object_key
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      printingImage.id,
      printingImage.printing_id,
      printingImage.role,
      printingImage.media_type,
      printingImage.width,
      printingImage.height,
      printingImage.content_sha256,
      18,
      `printing-images/${printingImage.content_sha256}`,
    ),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO revision_printing_images (
         catalogue_revision_id, image_id, printing_id
       ) VALUES ('catrev_products', ?, ?)`,
    ).bind(printingImage.id, printingImage.printing_id),
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE catalogue_state
       SET current_revision_id = 'catrev_products',
           published_at = '2026-01-01T00:00:00.000Z'
       WHERE singleton = 1`,
    ),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO source_freshness (
         game, area, source_lineage, region, checked_at, ingestion_run_id
       ) VALUES
         ('one-piece', 'cards-and-printings', '', '',
          '2026-01-01T01:00:00.000Z', 'run_products'),
         ('one-piece', 'products-and-releases', '', '',
          '2026-01-01T02:00:00.000Z', 'run_products'),
         ('one-piece', 'legality-rules', 'one-piece-en', 'EN-OCEANIA',
          '2026-01-01T03:00:00.000Z', 'run_products')`,
    ),
  ]);
  await testEnv.PRINTING_IMAGES.put(
    `printing-images/${printingImage.content_sha256}`,
    new TextEncoder().encode("fusion-front-image"),
    {
      httpMetadata: { contentType: printingImage.media_type },
      sha256: printingImage.content_sha256,
    },
  );
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
            event_key: "oceania-announcement",
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

test("Product search normalizes official codes and names without accepting repeated scalar filters", async () => {
  for (const query of ["ＳＴ－１５", "RED EDWARD.NEWGATE"]) {
    const response = await api(
      `/v1/products?q=${encodeURIComponent(query)}`,
    );
    expect(response.status).toBe(200);
    const document = await response.json();
    expectSchema("ProductCollection", document);
    expect(document).toMatchObject({
      data: [{ id: "product_st15" }],
      meta: { catalogue_revision_id: "catrev_products" },
    });
  }

  for (const path of [
    "/v1/products?game=one-piece&game=digimon",
    "/v1/products?release_region=EN-OCEANIA&release_region=EN-US",
    "/v1/products?limit=1&limit=2",
  ]) {
    const response = await api(path);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_parameter",
    });
  }
});

test("authenticated Printing Image content is immutable, conditional, and range-capable", async () => {
  const content = await api(
    "/v1/printing-images/printing_image_st15_front/content",
  );
  expect(content.status).toBe(200);
  expect(content.headers.get("content-type")).toBe("image/webp");
  expect(content.headers.get("content-length")).toBe("18");
  expect(content.headers.get("cache-control")).toContain("private");
  expect(await content.text()).toBe("fusion-front-image");

  const head = await api(
    "/v1/printing-images/printing_image_st15_front/content",
    {},
    "HEAD",
  );
  expect(head.status).toBe(200);
  expect(head.headers.get("content-length")).toBe("18");
  expect(await head.text()).toBe("");

  const headRequestHeaders: Record<string, string>[] = [
    {
      "if-none-match":
        "\"46f3e4bfb8bc9956482a6491e9b968d82e6fd544da44f9f36d93b443b845f773\"",
    },
    { range: "bytes=7-11" },
    { range: "bytes=99-100" },
  ];
  for (const headers of headRequestHeaders) {
    const metadata = await api(
      "/v1/printing-images/printing_image_st15_front/content",
      headers,
      "HEAD",
    );
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get("content-type")).toBe("image/webp");
    expect(metadata.headers.get("content-length")).toBe("18");
    expect(metadata.headers.get("content-range")).toBeNull();
    expect(await metadata.text()).toBe("");
  }

  const partial = await api(
    "/v1/printing-images/printing_image_st15_front/content",
    { range: "bytes=7-11" },
  );
  expect(partial.status).toBe(206);
  expect(partial.headers.get("content-range")).toBe("bytes 7-11/18");
  expect(await partial.text()).toBe("front");

  const notModified = await api(
    "/v1/printing-images/printing_image_st15_front/content",
    {
      "if-none-match":
        "\"46f3e4bfb8bc9956482a6491e9b968d82e6fd544da44f9f36d93b443b845f773\"",
    },
  );
  expect(notModified.status).toBe(304);
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

test("Printing detail conditional reads bind exact response bytes to one revision", async () => {
  const path = "/v1/printings/printing_st15_event";
  const first = await api(path);
  expect(first.status).toBe(200);
  const etag = first.headers.get("etag");
  expect(etag).toMatch(/^".+"$/);
  const firstBytes = await first.text();

  for (const validator of [
    etag!,
    `W/${etag!}`,
    `"unrelated", W/${etag!}`,
    "*",
  ]) {
    const conditional = await api(path, {
      "if-none-match": validator,
    });
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe("");
    expect(conditional.headers.get("etag")).toBe(etag);
    expect(conditional.headers.get("x-catalogue-revision")).toBe(
      "catrev_products",
    );
  }

  await testEnv.CATALOGUE_DB.batch([
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE operation_state
       SET active_ingestion_run_id = NULL
       WHERE singleton = 1`,
    ),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO ingestion_runs (
         id, state, selected_games_json, started_at,
         expected_current_revision_id, linked_run_id, idempotency_key,
         candidate_digest, candidate_created_at, approval_deadline,
         approval_json, published_revision_id, export_manifest_digest,
         terminal_at, candidate_json, approval_idempotency_key
       ) VALUES (
         'run_products_next', 'publishing', '["one-piece"]',
         '2026-01-02T00:00:00.000Z', 'catrev_products', NULL,
         'products-next-seed', ?, '2026-01-02T00:00:00.000Z',
         '2099-01-01T00:00:00.000Z', ?, NULL, NULL, NULL, '{}', NULL
       )`,
    ).bind(
      "7".repeat(64),
      JSON.stringify({
        candidate_digest: "7".repeat(64),
        expected_current_revision_id: "catrev_products",
        approved_at: "2026-01-02T00:00:00.000Z",
      }),
    ),
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE operation_state
       SET active_ingestion_run_id = 'run_products_next'
       WHERE singleton = 1`,
    ),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO catalogue_revisions (
         id, ingestion_run_id, published_at, content_digest,
         expected_previous_revision_id, approved_candidate_digest
       ) VALUES (
         'catrev_products_next', 'run_products_next',
         '2026-01-02T00:00:00.000Z', ?,
         'catrev_products', ?
       )`,
    ).bind("7".repeat(64), "7".repeat(64)),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO revision_cards (
         catalogue_revision_id, card_id, document_json
       )
       SELECT 'catrev_products_next', card_id, document_json
       FROM revision_cards
       WHERE catalogue_revision_id = 'catrev_products'
         AND card_id = 'card_st15_event'`,
    ),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO revision_printings (
         catalogue_revision_id, printing_id, card_id, document_json
       )
       SELECT 'catrev_products_next', printing_id, card_id, document_json
       FROM revision_printings
       WHERE catalogue_revision_id = 'catrev_products'
         AND printing_id = 'printing_st15_event'`,
    ),
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE catalogue_state
       SET current_revision_id = 'catrev_products_next',
           published_at = '2026-01-02T00:00:00.000Z'
       WHERE singleton = 1`,
    ),
  ]);
  try {
    const changed = await api(path, {
      "if-none-match": etag!,
    });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
    expect(changed.headers.get("x-catalogue-revision")).toBe(
      "catrev_products_next",
    );
    expect(await changed.text()).not.toBe(firstBytes);
  } finally {
    await testEnv.CATALOGUE_DB.prepare(
      `UPDATE catalogue_state
       SET current_revision_id = 'catrev_products',
           published_at = '2026-01-01T00:00:00.000Z'
       WHERE singleton = 1`,
    ).run();
  }
});

test("Printing detail validates and binds optional evidence representations", async () => {
  const path = "/v1/printings/printing_st15_event";
  const stored = await testEnv.CATALOGUE_DB.prepare(
    `SELECT document_json FROM revision_printings
     WHERE catalogue_revision_id = 'catrev_products'
       AND printing_id = 'printing_st15_event'`,
  ).first<{ document_json: string }>();
  expect(stored).not.toBeNull();
  const data = JSON.parse(stored!.document_json);
  await testEnv.CATALOGUE_DB.prepare(
    `UPDATE revision_printings SET document_json = ?
     WHERE catalogue_revision_id = 'catrev_products'
       AND printing_id = 'printing_st15_event'`,
  ).bind(JSON.stringify({
    data,
    included: [{
      type: "source_observation",
      id: "srcobs_printing_detail",
      captured_at: "2026-01-01T00:00:00.000Z",
      source: "one-piece-en",
    }],
    provenance: {
      "/data/rarity": ["srcobs_printing_detail"],
    },
    disagreements: [{
      path: "/data/printed_rules_text",
      status: "unresolved",
      candidates: [{
        value: "Earlier text",
        observation_id: "srcobs_printing_detail",
      }],
    }],
  })).run();

  for (const invalid of [
    `${path}?include=unknown`,
    `${path}?include=evidence,evidence`,
    `${path}?include=evidence&include=disagreements`,
  ]) {
    const response = await api(invalid);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_parameter",
      title: "Invalid Printing request",
    });
  }

  const base = await api(path);
  const evidence = await api(`${path}?include=evidence`);
  const disagreements = await api(`${path}?include=disagreements`);
  const combined = await api(
    `${path}?include=disagreements,evidence`,
  );
  const reordered = await api(
    `${path}?include=evidence,disagreements`,
  );
  expect(base.status).toBe(200);
  expect(evidence.status).toBe(200);
  expect(disagreements.status).toBe(200);
  expect(combined.status).toBe(200);
  expect(reordered.status).toBe(200);
  await expect(base.json()).resolves.not.toHaveProperty("included");
  await expect(evidence.json()).resolves.toMatchObject({
    included: [{ id: "srcobs_printing_detail" }],
    provenance: {
      "/data/rarity": ["srcobs_printing_detail"],
    },
  });
  await expect(disagreements.json()).resolves.toMatchObject({
    disagreements: [{
      path: "/data/printed_rules_text",
      status: "unresolved",
    }],
  });
  expect(combined.headers.get("etag")).toBe(
    reordered.headers.get("etag"),
  );
  expect(await combined.text()).toBe(await reordered.text());
  expect(base.headers.get("etag")).not.toBe(
    evidence.headers.get("etag"),
  );
  const conditional = await api(`${path}?include=evidence`, {
    "if-none-match": evidence.headers.get("etag")!,
  });
  expect(conditional.status).toBe(304);
  await testEnv.CATALOGUE_DB.prepare(
    `UPDATE revision_printings SET document_json = ?
     WHERE catalogue_revision_id = 'catrev_products'
       AND printing_id = 'printing_st15_event'`,
  ).bind(stored!.document_json).run();
});

test("Product query and include parameters reject invalid public representations", async () => {
  for (const path of [
    "/v1/products?q=",
    `/v1/products?q=${"x".repeat(501)}`,
    "/v1/products/product_st15?include=evidence,evidence",
  ]) {
    const response = await api(path);
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    await expect(response.json()).resolves.toEqual({
      type: "https://card-keepr.invalid/problems/invalid_parameter",
      title: "Invalid Product request",
      status: 400,
      code: "invalid_parameter",
      detail: expect.any(String),
      request_id: expect.any(String),
    });
  }
});

test("equal Product representation ETags identify byte-identical responses", async () => {
  for (const [firstPath, secondPath] of [
    [
      "/v1/products?game=one-piece&q=st-15",
      "/v1/products?q=st-15&game=one-piece",
    ],
    [
      "/v1/products/product_st15?include=evidence,disagreements",
      "/v1/products/product_st15?include=disagreements,evidence",
    ],
  ] as const) {
    const first = await api(firstPath);
    const second = await api(secondPath);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get("etag")).toBe(second.headers.get("etag"));
    expect(await first.text()).toBe(await second.text());
  }
});

test("Catalogue status exposes independently checked areas and freshness-sensitive ETags", async () => {
  const first = await api("/v1/catalogue");
  expect(first.status).toBe(200);
  const firstDocument = await first.json<{
    data: {
      current_revision_id: string;
      last_successful_checks: {
        game: string;
        area: string;
        source_lineage?: string;
        region?: string;
        checked_at: string;
      }[];
    };
  }>();
  expectSchema("CatalogueDocument", firstDocument);
  expect(firstDocument.data.last_successful_checks).toEqual([
    {
      game: "one-piece",
      area: "cards-and-printings",
      checked_at: "2026-01-01T01:00:00.000Z",
    },
    {
      game: "one-piece",
      area: "legality-rules",
      source_lineage: "one-piece-en",
      region: "EN-OCEANIA",
      checked_at: "2026-01-01T03:00:00.000Z",
    },
    {
      game: "one-piece",
      area: "products-and-releases",
      checked_at: "2026-01-01T02:00:00.000Z",
    },
  ]);
  const firstEtag = first.headers.get("etag");
  expect(firstEtag).toMatch(/^".+"$/);

  await testEnv.CATALOGUE_DB.prepare(
    `UPDATE source_freshness
     SET checked_at = '2026-01-02T02:00:00.000Z'
     WHERE game = 'one-piece'
       AND area = 'products-and-releases'`,
  ).run();
  const changed = await api("/v1/catalogue", {
    "if-none-match": firstEtag!,
  });
  expect(changed.status).toBe(200);
  expect(changed.headers.get("x-catalogue-revision")).toBe(
    "catrev_products",
  );
  expect(changed.headers.get("etag")).not.toBe(firstEtag);
  const changedDocument = await changed.json<{
    data: { last_successful_checks: { checked_at: string }[] };
  }>();
  expect(
    changedDocument.data.last_successful_checks.at(-1)?.checked_at,
  ).toBe("2026-01-02T02:00:00.000Z");

  const unchanged = await api("/v1/catalogue", {
    "if-none-match": changed.headers.get("etag")!,
  });
  expect(unchanged.status).toBe(304);
  expect(await unchanged.text()).toBe("");

  for (const value of [
    `W/${changed.headers.get("etag")!}`,
    `"unrelated", W/${changed.headers.get("etag")!}`,
    "*",
  ]) {
    const conditional = await api("/v1/catalogue", {
      "if-none-match": value,
    });
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe("");
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
          event_key: "oceania-unresolved",
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

test("Product evidence projects Curated Revisions onto exact Product and nested Release fields", async () => {
  const stored = await testEnv.CATALOGUE_DB.prepare(
    `SELECT document_json FROM revision_products
     WHERE catalogue_revision_id = 'catrev_products'
       AND product_id = 'product_st15'`,
  ).first<{ document_json: string }>();
  expect(stored).not.toBeNull();
  const envelope = JSON.parse(stored!.document_json) as {
    data: Record<string, unknown> & {
      releases: Record<string, unknown>[];
    };
    included: unknown[];
    provenance: Record<string, string[]>;
    disagreements: unknown[];
  };
  const productRevision = {
    curated_revision_id: "currev_product_name",
    content_digest: "b".repeat(64),
    target: {
      kind: "field",
      entity_type: "product",
      entity_id: "product_st15",
      path: "/name",
    },
    rationale: "Use the owner-verified official Product name.",
    evidence: [{ kind: "source_observation", id: "srcobs_product_name" }],
    author: "owner",
    reviewed_source_value: "Starter Deck RED Edward.Newgate",
  };
  const releaseRevision = {
    curated_revision_id: "currev_release_status",
    content_digest: "c".repeat(64),
    target: {
      kind: "field",
      entity_type: "release",
      entity_id: "release_st15_oceania",
      path: "/status",
    },
    rationale: "Record the owner-verified regional Release status.",
    evidence: [{ kind: "source_observation", id: "srcobs_release_status" }],
    author: "owner",
    reviewed_source_value: "announced",
  };
  envelope.data.name = "Starter Deck Red Edward Newgate";
  envelope.data.curated_provenance = [productRevision];
  envelope.data.releases[0] = {
    ...envelope.data.releases[0],
    status: "released",
    curated_provenance: [releaseRevision],
  };
  envelope.included = [
    {
      type: "source_observation",
      id: "srcobs_product_name",
      captured_at: "2026-01-01T00:00:00.000Z",
      source: "one-piece-en",
    },
    {
      type: "source_observation",
      id: "srcobs_release_status",
      captured_at: "2026-01-01T00:00:00.000Z",
      source: "one-piece-en",
    },
  ];
  envelope.provenance = {
    "/data/name": ["srcobs_product_name"],
    "/data/releases/0/status": ["srcobs_release_status"],
  };

  await testEnv.CATALOGUE_DB.batch([
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE operation_state SET active_ingestion_run_id = NULL
       WHERE singleton = 1`,
    ),
    ...[
      {
        id: "currev_product_name",
        target: productRevision.target,
        digest: productRevision.content_digest,
        createdAt: "2026-01-02T00:00:00.000Z",
      },
      {
        id: "currev_release_status",
        target: releaseRevision.target,
        digest: releaseRevision.content_digest,
        createdAt: "2026-01-03T00:00:00.000Z",
      },
    ].map(({ id, target, digest, createdAt }) =>
      testEnv.CATALOGUE_DB.prepare(
        `INSERT INTO curated_revisions (
           id, game, target_key, target_kind, effective_from, effective_to,
           proposal_json, content_digest, reviewed_source_digest,
           schema_binding_json, author, created_at, status, event_version
         ) VALUES (
           ?, 'one-piece', ?, 'field', NULL, NULL, ?, ?, ?, ?, 'owner', ?,
           'active', 1
         )`,
      ).bind(
        id,
        JSON.stringify(target),
        JSON.stringify({ target }),
        digest,
        "d".repeat(64),
        JSON.stringify({ catalogue_revision_id: "catrev_products" }),
        createdAt,
      )
    ),
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE revision_products SET document_json = ?
       WHERE catalogue_revision_id = 'catrev_products'
         AND product_id = 'product_st15'`,
    ).bind(JSON.stringify(envelope)),
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE operation_state SET active_ingestion_run_id = 'run_products'
       WHERE singleton = 1`,
    ),
  ]);

  try {
    const base = await api("/v1/products/product_st15");
    expect(base.status).toBe(200);
    await expect(base.json()).resolves.not.toHaveProperty("included");

    const response = await api(
      "/v1/products/product_st15?include=evidence",
    );
    expect(response.status).toBe(200);
    const document = await response.json();
    expectSchema("ProductDocument", document);
    expect(document).toMatchObject({
      included: [
        { id: "srcobs_product_name" },
        { id: "srcobs_release_status" },
        {
          type: "curated_revision",
          id: "currev_product_name",
          captured_at: "2026-01-02T00:00:00.000Z",
          source: "owner",
        },
        {
          type: "curated_revision",
          id: "currev_release_status",
          captured_at: "2026-01-03T00:00:00.000Z",
          source: "owner",
        },
      ],
      provenance: {
        "/data/name": ["currev_product_name"],
        "/data/releases/0/status": ["currev_release_status"],
      },
    });
  } finally {
    await testEnv.CATALOGUE_DB.prepare(
      `UPDATE revision_products SET document_json = ?
       WHERE catalogue_revision_id = 'catrev_products'
         AND product_id = 'product_st15'`,
    ).bind(stored!.document_json).run();
  }
});

test("an explicitly unknown Release region is readable and schema-valid", async () => {
  const product = {
    type: "product",
    id: "product_unknown_region",
    game: "digimon",
    official_code: "BT-UNKNOWN",
    name: "Unknown-region Product",
    releases: [
      {
        id: "release_unknown_region",
        event_key: "unknown-announcement",
        region: "unknown",
        date: { precision: "unknown", value: null },
        status: "announced",
      },
    ],
    lifecycle: {
      first_revision_id: "catrev_products",
      last_observed_revision_id: "catrev_products",
      withdrawn: false,
    },
    links: { self: "/v1/products/product_unknown_region" },
  };
  await testEnv.CATALOGUE_DB.prepare(
    `INSERT INTO revision_products (
       catalogue_revision_id, product_id, supported_game, official_code,
       name, search_text, release_regions_json, document_json
     ) VALUES (
       'catrev_products', 'product_unknown_region', 'digimon',
       'BT-UNKNOWN', 'Unknown-region Product',
       'bt-unknown unknown-region product', '["unknown"]', ?
     )`,
  )
    .bind(
      JSON.stringify({
        data: product,
        included: [],
        provenance: {},
        disagreements: [],
      }),
    )
    .run();

  try {
    const detail = await api("/v1/products/product_unknown_region");
    expect(detail.status).toBe(200);
    expectSchema("ProductDocument", await detail.json());
    const filtered = await api(
      "/v1/products?game=digimon&release_region=unknown",
    );
    expect(filtered.status).toBe(200);
    expectSchema("ProductCollection", await filtered.json());
  } finally {
    await testEnv.CATALOGUE_DB.prepare(
      `DELETE FROM revision_products
       WHERE catalogue_revision_id = 'catrev_products'
         AND product_id = 'product_unknown_region'`,
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
  await testEnv.CATALOGUE_DB.prepare(
    `UPDATE catalogue_state
     SET current_revision_id = 'catrev_spine_000'
     WHERE singleton = 1`,
  ).run();
  const second = await api(
    `/v1/products?game=one-piece&release_region=EN-OCEANIA&limit=1&after=${encodeURIComponent(first.page.next_cursor)}`,
  );
  expect(second.status).toBe(200);
  await expect(second.json()).resolves.toMatchObject({
    data: [{ id: "product_st15" }],
    meta: { catalogue_revision_id: "catrev_products" },
  });

  await testEnv.CATALOGUE_DB.prepare(
    `UPDATE catalogue_query_revisions SET state = 'archived'
     WHERE catalogue_revision_id = 'catrev_products'`,
  ).run();
  const archived = await api(
    `/v1/products?game=one-piece&release_region=EN-OCEANIA&limit=1&after=${encodeURIComponent(first.page.next_cursor)}`,
  );
  expect(archived.status).toBe(409);
  await expect(archived.json()).resolves.toMatchObject({
    code: "cursor_revision_unavailable",
    links: { collection: "/v1/products" },
  });
  await testEnv.CATALOGUE_DB.prepare(
    `UPDATE catalogue_query_revisions SET state = 'available'
     WHERE catalogue_revision_id = 'catrev_products'`,
  ).run();

  const forged = decodeCursor(first.page.next_cursor);
  const unavailableRevision = encodeCursor({
    ...forged,
    revision: "catrev_unavailable",
  });
  const unavailable = await api(
    `/v1/products?game=one-piece&release_region=EN-OCEANIA&limit=1&after=${encodeURIComponent(unavailableRevision)}`,
  );
  expect(unavailable.status).toBe(409);
  await expect(unavailable.json()).resolves.toMatchObject({
    code: "cursor_revision_unavailable",
    links: { collection: "/v1/products" },
  });
  const wrongRoute = encodeCursor({ ...forged, route: "/v1/cards" });
  const rejected = await api(
    `/v1/products?game=one-piece&release_region=EN-OCEANIA&limit=1&after=${encodeURIComponent(wrongRoute)}`,
  );
  expect(rejected.status).toBe(400);
  await expect(rejected.json()).resolves.toMatchObject({
    code: "invalid_cursor",
  });
  await testEnv.CATALOGUE_DB.prepare(
    `UPDATE catalogue_state
     SET current_revision_id = 'catrev_products'
     WHERE singleton = 1`,
  ).run();
});

test("Printing collection binds every normalized filter to one card-ordered revision-pinned keyset", async () => {
  const secondPrinting = {
    type: "printing",
    id: "printing_zzz_us",
    card_id: "card_aaa_us",
    rarity: { normalized: "rare", raw: "R" },
    printed_rules_text: null,
    game_data: null,
    printing_images: [],
    distribution_contexts: [],
    relationship_evidence: [],
    locator_evidence: { current: [], historical: [] },
    lifecycle: {
      first_revision_id: "catrev_products",
      last_observed_revision_id: "catrev_products",
      withdrawn: false,
    },
    links: { self: "/v1/printings/printing_zzz_us" },
  };
  const secondCard = {
    type: "card",
    id: secondPrinting.card_id,
    game: "one-piece",
    official_identity: { kind: "card_number", value: "ST-US-001" },
    name: "US Product Card",
    effective_rules_text: null,
    game_data: {
      profile: "one-piece@1",
      attributes: {
        card_type: "character",
        colours: ["red"],
        cost: 1,
        life: null,
        battle_attributes: ["strike"],
        power: 1000,
        counter: 1000,
        traits: ["Test"],
        block_icons: [],
        effect_text: null,
        trigger_text: null,
      },
    },
    printing_ids: [secondPrinting.id],
    lifecycle: secondPrinting.lifecycle,
    links: { self: `/v1/cards/${secondPrinting.card_id}` },
  };
  const usProduct = {
    type: "product",
    id: "product_us",
    game: "one-piece",
    official_code: "ST-US",
    name: "US Product",
    releases: [{
      id: "release_us",
      region: "EN-US",
      date: { precision: "day", value: "2026-01-01" },
      status: "released",
    }],
    lifecycle: secondPrinting.lifecycle,
    links: { self: "/v1/products/product_us" },
  };
  await testEnv.CATALOGUE_DB.batch([
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO revision_cards (
         catalogue_revision_id, card_id, document_json
       ) VALUES ('catrev_products', ?, ?)`,
    ).bind(secondCard.id, JSON.stringify(secondCard)),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO revision_printings (
         catalogue_revision_id, printing_id, card_id, document_json
       ) VALUES ('catrev_products', ?, ?, ?)`,
    ).bind(
      secondPrinting.id,
      secondPrinting.card_id,
      JSON.stringify(secondPrinting),
    ),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO revision_products (
         catalogue_revision_id, product_id, supported_game, official_code,
         name, search_text, release_regions_json, document_json
       ) VALUES (
         'catrev_products', 'product_us', 'one-piece', 'ST-US',
         'US Product', 'st-us us product', '["EN-US"]', ?
       )`,
    ).bind(JSON.stringify({
      data: usProduct,
      included: [],
      provenance: {},
      disagreements: [],
    })),
    ...[
      ["relationship_st15", "printing_st15_event", "product_st15"],
      ["relationship_us", "printing_zzz_us", "product_us"],
    ].map(([id, printingId, productId]) =>
      testEnv.CATALOGUE_DB.prepare(
        `INSERT INTO revision_product_relationships (
           catalogue_revision_id, relationship_id, document_json
         ) VALUES ('catrev_products', ?, ?)`,
      ).bind(id, JSON.stringify({
        type: "relationship",
        id,
        kind: "printing-product",
        from: { type: "printing", id: printingId },
        to: { type: "product", id: productId },
        evidence_category: "explicit",
        source_lineage: "one-piece-en",
        source_observation_ids: ["srcobs_printing_filter"],
        relationship_value: productId,
        lifecycle: {
          first_revision_id: "catrev_products",
          last_observed_revision_id: "catrev_products",
          current: true,
          last_missing_revision_id: null,
        },
      })),
    ),
  ]);

  const firstResponse = await api(
    "/v1/printings?product_id=product_st15&release_region=EN-OCEANIA&limit=1",
  );
  expect(firstResponse.status).toBe(200);
  const first = await firstResponse.json<{
    data: { id: string }[];
    page: { next_cursor: string | null };
    meta: { catalogue_revision_id: string };
  }>();
  expect(first.data.map(({ id }) => id)).toEqual([
    "printing_st15_event",
  ]);
  expect(first.meta.catalogue_revision_id).toBe("catrev_products");

  const mismatched = await api(
    "/v1/printings?product_id=product_st15&release_region=EN-US",
  );
  expect(mismatched.status).toBe(200);
  await expect(mismatched.json()).resolves.toMatchObject({ data: [] });

  for (const [query, expectedIds] of [
    ["card_id=card_st15_event", ["printing_st15_event"]],
    ["game=one-piece", ["printing_zzz_us", "printing_st15_event"]],
    ["rarity=leader", ["printing_st15_event"]],
    ["rarity=rare", ["printing_zzz_us"]],
    [
      "card_id=card_st15_event&game=one-piece&rarity=leader&product_id=product_st15&release_region=EN-OCEANIA",
      ["printing_st15_event"],
    ],
    [
      "card_id=card_st15_event&game=one-piece&rarity=rare&product_id=product_st15&release_region=EN-OCEANIA",
      [],
    ],
  ] as const) {
    const filtered = await api(`/v1/printings?${query}`);
    expect(filtered.status).toBe(200);
    await expect(filtered.json()).resolves.toMatchObject({
      data: expectedIds.map((id) => ({ id })),
    });
  }

  const firstPage = await api(
    "/v1/printings?game=one-piece&limit=1",
  );
  const firstPageBody = await firstPage.json<{
    data: { id: string; card_id: string }[];
    page: { next_cursor: string };
  }>();
  expect(firstPageBody.data).toMatchObject([
    { id: "printing_zzz_us", card_id: "card_aaa_us" },
  ]);
  const cursor = firstPageBody.page.next_cursor;
  await testEnv.CATALOGUE_DB.prepare(
    `UPDATE catalogue_state
     SET current_revision_id = 'catrev_spine_000'
     WHERE singleton = 1`,
  ).run();
  const retained = await api(
    `/v1/printings?game=one-piece&limit=1&after=${encodeURIComponent(cursor)}`,
  );
  expect(retained.status).toBe(200);
  await expect(retained.json()).resolves.toMatchObject({
    data: [{ id: "printing_st15_event", card_id: "card_st15_event" }],
    meta: { catalogue_revision_id: "catrev_products" },
  });

  for (const path of [
    "/v1/printings?release_region=not-a-region",
    "/v1/printings?game=not-a-game",
    "/v1/printings?rarity=",
    "/v1/printings?card_id=",
    "/v1/printings?game=one-piece&game=one-piece",
    "/v1/printings?limit=0",
  ]) {
    const response = await api(path);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_parameter",
    });
  }
  const invalidCursor = await api(
    `/v1/printings?limit=1&after=${encodeURIComponent(encodeCursor({
      route: "/v1/products",
    }))}`,
  );
  expect(invalidCursor.status).toBe(400);
  await expect(invalidCursor.json()).resolves.toMatchObject({
    code: "invalid_cursor",
  });
  const decoded = decodeCursor(cursor);
  const filters = decoded.filters as Record<string, unknown>;
  const forgedFilter = encodeCursor({
    ...decoded,
    filters: { ...filters, rarity: "leader" },
  });
  const forged = await api(
    `/v1/printings?game=one-piece&limit=1&after=${encodeURIComponent(forgedFilter)}`,
  );
  expect(forged.status).toBe(400);
  await expect(forged.json()).resolves.toMatchObject({
    code: "invalid_cursor",
  });

  const canonical = await api(
    "/v1/printings?game=one-piece&rarity=leader&card_id=card_st15_event",
  );
  const reordered = await api(
    "/v1/printings?card_id=card_st15_event&rarity=leader&game=one-piece",
  );
  expect(canonical.headers.get("etag")).toBe(reordered.headers.get("etag"));
  expect(await canonical.text()).toBe(await reordered.text());
  await testEnv.CATALOGUE_DB.prepare(
    `UPDATE catalogue_state
     SET current_revision_id = 'catrev_products'
     WHERE singleton = 1`,
  ).run();
});

function api(
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://card-keepr.invalid${path}`, {
      method,
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
