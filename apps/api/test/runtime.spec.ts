import { publishCardSearchChunksStatement } from "../../../src/catalogue/ingestion/publication-commit-repository";
import { catalogueStore } from "../../../src/catalogue/shared";
import { inspectCardCollectionQuery } from "../../ingestion/test/query-helpers/collection-query-plans";
import * as publishedCatalogueQueries from "../../ingestion/test/query-helpers/published-catalogue";
import * as ingestionQueries from "../../ingestion/test/query-helpers/ingestion";
import * as catalogueExportQueries from "../../ingestion/test/query-helpers/catalogue-export";
import * as legalityQueries from "../../ingestion/test/query-helpers/legality";
import * as cardSearchQueries from "../../ingestion/test/query-helpers/card-search";
import { exports } from "cloudflare:workers";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { expect, test, vi } from "vitest";
import apiSchema from "../../../prototype/formalize-implementation-contracts/schemas/api.schema.json";
import exportManifestSchemaV5 from "../../../prototype/formalize-implementation-contracts/schemas/catalogue-export-manifest-v5.schema.json";
import exportRecordSchemaV5 from "../../../prototype/formalize-implementation-contracts/schemas/catalogue-export-record-v5.schema.json";
import {
  prepareCardSearchForD1Export,
  reconstructCardSearchAfterD1Restore,
  withCardSearchPreparedForD1Export,
} from "../../../src/catalogue/backup-recovery";
import { canonicalJson, deterministicGzip, sha256, sha256Text, utf8 } from "../../../src/catalogue/shared";
import apiWorker from "../src/index";
import {
  apiCard,
  apiHeaders,
  apiPublicBase,
  canonicalLegalityRuleStatements,
  cardSearchStatements,
  installApiSuite,
  legalityRuleFieldPointers,
  legalitySourceStatements,
  publishedCardEnvelope,
  revisionLegalityRuleStatements,
  seedApiRevision,
  testEnv,
} from "./api-fixtures";

installApiSuite();

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

test("API requests emit useful structured diagnostics without leaking failures", async () => {
  const records: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, "info").mockImplementation((value) => {
    records.push(String(value));
  });
  vi.spyOn(console, "error").mockImplementation((value) => {
    errors.push(String(value));
  });

  const response = await apiWorker.fetch(
    new Request("https://card-keepr.invalid/v1/catalogue?proposal=source-payload", {
      headers: {
        authorization: "Bearer vitest-api-key",
        "x-secret-diagnostic-test": "credential-material",
      },
    }),
    testEnv,
  );
  expect(response.status).toBe(200);

  const record = JSON.parse(records.at(-1) ?? "null") as Record<string, unknown>;
  expect(record).toMatchObject({
    contract: "card-keepr-operational-log@1",
    event: "request.completed",
    runtime: "api",
    request: {
      method: "GET",
      route: "/v1/catalogue",
    },
    status: 200,
    cache: { status: "unknown" },
    retry: { count: 0, classification: "not_applicable" },
    d1: { prepared_statements: expect.any(Number) },
  });
  expect(record).toHaveProperty("request.id");
  expect(record).toHaveProperty("duration_ms");
  expect(record).toHaveProperty("workflow.step", null);
  expect(JSON.stringify(record)).not.toContain("source-payload");
  expect(JSON.stringify(record)).not.toContain("credential-material");

  await apiWorker.fetch(
    new Request("https://card-keepr.invalid/source-payload-path-secret", {
      headers: { authorization: "Bearer vitest-api-key" },
    }),
    testEnv,
  );
  expect(records.at(-1)).toContain('"route":"/:ref"');
  expect(records.at(-1)).not.toContain("source-payload-path-secret");

  // Liveness (issue #144) is polled by monitors: it is not logged, and its
  // body carries nothing an anonymous caller could learn from.
  const loggedBefore = records.length;
  const liveness = await apiWorker.fetch(
    new Request("https://card-keepr.invalid/healthz?probe=source-payload", {
      headers: { "x-secret-diagnostic-test": "credential-material" },
    }),
    testEnv,
  );
  expect(liveness.status).toBe(200);
  expect(await liveness.text()).toBe('{"status":"ok","runtime":"api"}');
  expect(records).toHaveLength(loggedBefore);

  const secret = "credential-and-source-payload-must-not-leak";
  const failingEnv = new Proxy(testEnv, {
    get(target, property, receiver) {
      if (property === "CATALOGUE_DB") {
        return new Proxy(target.CATALOGUE_DB, {
          get(database, databaseProperty, databaseReceiver) {
            if (databaseProperty === "prepare") {
              return () => {
                throw new Error(secret);
              };
            }
            return Reflect.get(database, databaseProperty, databaseReceiver);
          },
        });
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const failed = await apiWorker.fetch(
    new Request("https://card-keepr.invalid/v1/catalogue", {
      headers: { authorization: "Bearer vitest-api-key" },
    }),
    failingEnv,
  );
  expect(failed.status).toBe(500);
  expect([...records, ...errors].join("\n")).not.toContain(secret);
  expect([...records, ...errors].join("\n")).not.toContain("vitest-api-key");
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
  await publishedCatalogueQueries.setCatalogueQueryRevisionsState(testEnv.CATALOGUE_DB).run();
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

test("a supplied cursor for an unavailable current revision returns the cursor restart problem", async () => {
  await seedApiRevision({
    revisionId: "catrev_current_cursor_unavailable",
    runId: "run_current_cursor_unavailable",
    cards: [
      apiCard({
        id: "card_current_cursor_unavailable",
        cardNumber: "OP29-504",
        name: "Unavailable Cursor Projection",
      }),
    ],
  });
  await publishedCatalogueQueries
    .setCatalogueQueryRevisionsStateForSuppliedCursorUnavailableCurrentRevisionReturnsCursorRestartProblem(
      testEnv.CATALOGUE_DB,
    )
    .run();
  const cursor = encodeTestCardCursor({
    revisionId: "catrev_current_cursor_unavailable",
    route: "/v1/cards",
    order: "game,official_identity.kind,official_identity.value,id",
    q: "unavailable",
    limit: 1,
    after: {
      game: "one-piece",
      identityKind: "card_number",
      identityValue: "OP29-504",
      id: "card_current_cursor_unavailable",
    },
  });
  const response = await exports.default.fetch(
    new Request(`https://card-keepr.invalid/v1/cards?q=unavailable&limit=1&after=${encodeURIComponent(cursor)}`, {
      headers: apiHeaders("203.0.113.104"),
    }),
  );

  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toMatchObject({
    code: "cursor_revision_unavailable",
    links: { collection: `${apiPublicBase}/v1/cards` },
  });
});

test("authenticated Catalogue Export reads preserve the retained D1/R2 artifact bytes", async () => {
  const revisionId = "catrev_retained_export";
  const publishedAt = "2025-01-01T00:00:00.000Z";
  const candidateDigest = "a".repeat(64);
  const sourcePointer = "/observations/0/value/legality_rules/0";
  const legalityRule = {
    type: "legality_rule",
    id: "legality_rule_retained_export",
    official_id: "RULE-RETAINED-EXPORT",
    game: "gundam",
    region: "EN-ASIA",
    format: "standard",
    event_tier: null,
    effective_from: "2025-01-01",
    effective_until: null,
    unresolved_scope: null,
    kind: "restricted",
    effect: { type: "copy_limit", maximum_copies: 1 },
    card_ids: ["card_retained_export"],
    official_wording: "Retained decks may contain one copy.",
    source_lineage: "gundam-en-asia",
    source_observation_ids: ["srcobs_retained_export"],
    source_observation_pointer: sourcePointer,
    source_field_pointers: Object.fromEntries(
      [
        "official_wording",
        "effective_from",
        "effective_until",
        "unresolved_scope",
        "region",
        "format",
        "event_tier",
        "card_numbers",
        "effect",
      ].map((field) => [field, `${sourcePointer}/${field}`]),
    ),
    lifecycle: {
      first_revision_id: revisionId,
      last_observed_revision_id: revisionId,
      current: true,
      last_missing_revision_id: null,
    },
  };
  const legalityBytes = utf8(`${canonicalJson(legalityRule)}\n`);
  const compressedLegalityBytes = deterministicGzip(legalityBytes);
  const emptyBytes = new Uint8Array();
  const compressedEmptyBytes = deterministicGzip(emptyBytes);
  const [legalityDigest, compressedLegalityDigest, emptyDigest, compressedEmptyDigest] = await Promise.all([
    sha256(legalityBytes),
    sha256(compressedLegalityBytes),
    sha256(emptyBytes),
    sha256(compressedEmptyBytes),
  ]);
  const componentDefinitions = [
    ["supported-games", "SupportedGameRecord", "id:utf8"],
    ["game-profiles", "GameProfileRecord", "profile:utf8"],
    ["cards", "CardRecord", "id:utf8"],
    ["printings", "PrintingRecord", "id:utf8"],
    ["printing-images", "PrintingImageRecord", "id:utf8"],
    ["products", "ProductRecord", "id:utf8"],
    ["releases", "ReleaseRecord", "id:utf8"],
    ["distribution-contexts", "DistributionContextRecord", "id:utf8"],
    ["errata", "ErratumRecord", "id:utf8"],
    ["legality-rules", "LegalityRuleRecord", "id:utf8"],
    ["relationships", "RelationshipRecord", "id:utf8"],
  ] as const;
  const components = componentDefinitions.map(([name, schemaDefinition, order]) => {
    const containsLegality = name === "legality-rules";
    return {
      name,
      media_type: "application/x-ndjson",
      compression: "gzip",
      record_schema: `https://card-keepr.invalid/schemas/catalogue-export-record@5#/$defs/${schemaDefinition}`,
      order,
      records: containsLegality ? 1 : 0,
      uncompressed_bytes: containsLegality ? legalityBytes.byteLength : 0,
      content_sha256: containsLegality ? legalityDigest : emptyDigest,
      compressed_bytes: containsLegality ? compressedLegalityBytes.byteLength : compressedEmptyBytes.byteLength,
      compressed_sha256: containsLegality ? compressedLegalityDigest : compressedEmptyDigest,
    };
  });
  const manifestWithPlaceholder = {
    format: "card-keepr-catalogue-export-manifest@5",
    serialization_profile: "card-keepr-ndjson-gzip@1",
    export_schema_major: 5,
    catalogue_revision: {
      id: revisionId,
      content_sha256: candidateDigest,
    },
    published_at: publishedAt,
    export_created_at: publishedAt,
    supported_games: ["gundam"],
    source_freshness: [
      {
        game: "gundam",
        area: "legality-rules",
        source_lineage: "gundam-en-asia",
        region: "EN-ASIA",
        checked_at: publishedAt,
      },
    ],
    components,
    manifest_sha256: "0".repeat(64),
  };
  const manifestDigest = await sha256Text(`${canonicalJson(manifestWithPlaceholder)}\n`);
  const manifest = {
    ...manifestWithPlaceholder,
    manifest_sha256: manifestDigest,
  };
  const manifestBytes = utf8(`${canonicalJson(manifest)}\n`);
  const manifestKey = `catalogue-exports/${revisionId}/manifest.json`;
  const componentKey = `catalogue-exports/${revisionId}/components/` + `${compressedLegalityDigest}.ndjson.gz`;

  await testEnv.CATALOGUE_EXPORTS.put(manifestKey, manifestBytes, {
    httpMetadata: { contentType: "application/json" },
  });
  await testEnv.CATALOGUE_EXPORTS.put(componentKey, compressedLegalityBytes, {
    httpMetadata: {
      contentType: "application/x-ndjson",
      contentEncoding: "gzip",
    },
  });
  await catalogueStore(testEnv.CATALOGUE_DB).batch([
    ingestionQueries
      .insertIngestionRunsForAuthenticatedCatalogueExportReadsPreserveRetainedD1R2Artifact(testEnv.CATALOGUE_DB)
      .bind(
        publishedAt,
        candidateDigest,
        publishedAt,
        JSON.stringify({
          action: "approved",
          candidate_digest: candidateDigest,
          expected_current_revision_id: "catrev_spine_000",
          approved_at: publishedAt,
        }),
      ),
    ingestionQueries.setOperationStateActiveIngestionRunIdForAuthenticatedCatalogueExportReadsPreserveRetainedD1R2Artifact(
      testEnv.CATALOGUE_DB,
    ),
    ingestionQueries
      .insertCatalogueRevisionsForAuthenticatedCatalogueExportReadsPreserveRetainedD1R2Artifact(testEnv.CATALOGUE_DB)
      .bind(revisionId, publishedAt, candidateDigest, candidateDigest),
    catalogueExportQueries.insertCatalogueExports(testEnv.CATALOGUE_DB).bind(revisionId, manifestKey, manifestDigest),
  ]);

  const authenticatedRequest = (path: string) =>
    new Request(`https://card-keepr.invalid${path}`, {
      headers: {
        authorization: "Bearer vitest-api-key",
        "cf-connecting-ip": "203.0.113.31",
      },
    });
  const manifestPath = `/v1/catalogue-exports/${revisionId}`;
  const firstManifestResponse = await exports.default.fetch(authenticatedRequest(manifestPath));
  const secondManifestResponse = await exports.default.fetch(authenticatedRequest(manifestPath));
  expect(firstManifestResponse.status).toBe(200);
  expect(secondManifestResponse.status).toBe(200);
  const firstManifestDocument = await firstManifestResponse.json<{
    data: unknown;
  }>();
  const secondManifestDocument = await secondManifestResponse.json<{
    data: unknown;
  }>();
  expect(firstManifestDocument.data).toEqual(manifest);
  expect(secondManifestDocument.data).toEqual(manifest);

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validateManifest = ajv.compile(exportManifestSchemaV5);
  expect(validateManifest(firstManifestDocument.data), JSON.stringify(validateManifest.errors)).toBe(true);
  ajv.addSchema(exportRecordSchemaV5);
  const validateLegalityRule = ajv.getSchema(`${exportRecordSchemaV5.$id}#/$defs/LegalityRuleRecord`);
  expect(validateLegalityRule).toBeDefined();
  expect(validateLegalityRule!(legalityRule), JSON.stringify(validateLegalityRule!.errors)).toBe(true);

  const componentPath = `${manifestPath}/components/legality-rules`;
  const firstComponentResponse = await exports.default.fetch(authenticatedRequest(componentPath));
  const secondComponentResponse = await exports.default.fetch(authenticatedRequest(componentPath));
  expect(firstComponentResponse.status).toBe(200);
  expect(secondComponentResponse.status).toBe(200);
  const firstComponentBytes = new Uint8Array(await firstComponentResponse.arrayBuffer());
  const secondComponentBytes = new Uint8Array(await secondComponentResponse.arrayBuffer());
  expect(firstComponentBytes).toEqual(compressedLegalityBytes);
  expect(secondComponentBytes).toEqual(compressedLegalityBytes);
  const decompressed = new Response(firstComponentBytes).body!.pipeThrough(new DecompressionStream("gzip"));
  await expect(new Response(decompressed).text()).resolves.toBe(`${canonicalJson(legalityRule)}\n`);

  const componentEtag = `"${compressedLegalityDigest}"`;
  const headResponse = await exports.default.fetch(
    new Request(`https://card-keepr.invalid${componentPath}`, {
      method: "HEAD",
      headers: {
        ...apiHeaders("203.0.113.32"),
        range: "bytes=0-9",
      },
    }),
  );
  expect(headResponse.status).toBe(200);
  expect(await headResponse.text()).toBe("");
  expect(headResponse.headers.get("content-length")).toBe(String(compressedLegalityBytes.byteLength));
  expect(headResponse.headers.get("content-disposition")).toBe('attachment; filename="legality-rules.ndjson.gz"');
  expect(headResponse.headers.get("accept-ranges")).toBe("bytes");
  expect(headResponse.headers.get("etag")).toBe(componentEtag);
  expect(headResponse.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");

  const notModified = await exports.default.fetch(
    new Request(`https://card-keepr.invalid${componentPath}`, {
      headers: {
        ...apiHeaders("203.0.113.33"),
        "if-none-match": componentEtag,
      },
    }),
  );
  expect(notModified.status).toBe(304);
  expect(await notModified.text()).toBe("");

  const partial = await exports.default.fetch(
    new Request(`https://card-keepr.invalid${componentPath}`, {
      headers: {
        ...apiHeaders("203.0.113.34"),
        range: "bytes=3-11",
      },
    }),
  );
  expect(partial.status).toBe(206);
  expect(new Uint8Array(await partial.arrayBuffer())).toEqual(compressedLegalityBytes.slice(3, 12));
  expect(partial.headers.get("content-range")).toBe(`bytes 3-11/${compressedLegalityBytes.byteLength}`);
  expect(partial.headers.get("content-length")).toBe("9");
  expect(partial.headers.get("etag")).toBe(componentEtag);

  await testEnv.CATALOGUE_EXPORTS.put(componentKey, compressedLegalityBytes, { sha256: compressedLegalityDigest });
  const replacedBodyBucket = proxyR2Bucket(testEnv.CATALOGUE_EXPORTS, {
    async get(...arguments_) {
      const object = await testEnv.CATALOGUE_EXPORTS.get(...arguments_);
      if (arguments_[0] !== componentKey || object === null) return object;
      return new Proxy(object, {
        get(target, property) {
          if (property === "etag") return `${target.etag}-replacement`;
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  });
  const raced = await apiWorker.fetch(
    new Request(`https://card-keepr.invalid${componentPath}`, {
      headers: apiHeaders("203.0.113.38"),
    }),
    { ...testEnv, CATALOGUE_EXPORTS: replacedBodyBucket },
  );
  expect(raced.status).toBe(404);
  await expect(raced.json()).resolves.toMatchObject({ code: "not_found" });

  const unsatisfiable = await exports.default.fetch(
    new Request(`https://card-keepr.invalid${componentPath}`, {
      headers: {
        ...apiHeaders("203.0.113.35"),
        range: `bytes=${compressedLegalityBytes.byteLength}-`,
      },
    }),
  );
  expect(unsatisfiable.status).toBe(416);
  expect(unsatisfiable.headers.get("content-range")).toBe(`bytes */${compressedLegalityBytes.byteLength}`);
  await expect(unsatisfiable.json()).resolves.toMatchObject({
    code: "range_not_satisfiable",
  });

  await testEnv.CATALOGUE_EXPORTS.delete(componentKey);
  const missing = await exports.default.fetch(
    new Request(`https://card-keepr.invalid${componentPath}`, {
      headers: {
        ...apiHeaders("203.0.113.36"),
        "if-none-match": componentEtag,
      },
    }),
  );
  expect(missing.status).toBe(404);
  expect(missing.headers.get("content-type")).toContain("application/problem+json");
  const missingProblem = await missing.json();
  expect(missingProblem).toMatchObject({ code: "not_found" });
  const problemAjv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(problemAjv);
  problemAjv.addSchema(apiSchema);
  const validateProblem = problemAjv.getSchema(`${apiSchema.$id}#/$defs/Problem`)!;
  expect(validateProblem(missingProblem), JSON.stringify(validateProblem.errors)).toBe(true);

  const tamperedBytes = compressedLegalityBytes.slice();
  const tamperedIndex = tamperedBytes.length - 1;
  tamperedBytes[tamperedIndex] = tamperedBytes[tamperedIndex]! ^ 0xff;
  await testEnv.CATALOGUE_EXPORTS.put(componentKey, tamperedBytes);
  const tampered = await exports.default.fetch(
    new Request(`https://card-keepr.invalid${componentPath}`, {
      headers: {
        ...apiHeaders("203.0.113.37"),
        "if-none-match": componentEtag,
      },
    }),
  );
  expect(tampered.status).toBe(404);
  const tamperedProblem = await tampered.json();
  expect(tamperedProblem).toMatchObject({ code: "not_found" });
  expect(validateProblem(tamperedProblem), JSON.stringify(validateProblem.errors)).toBe(true);

  await testEnv.CATALOGUE_EXPORTS.put(
    manifestKey,
    `${canonicalJson({
      ...manifest,
      supported_games: ["one-piece"],
    })}\n`,
  );
  const changedManifest = await exports.default.fetch(authenticatedRequest(manifestPath));
  expect(changedManifest.status).toBe(500);
  await expect(changedManifest.json()).resolves.toMatchObject({
    code: "internal_error",
  });
});

test("Catalogue Export listing is ordered, bounded, and revision-pinned across pages", async () => {
  await seedCatalogueExportSummary("catrev_export_list_oldest", "run_export_list_oldest", "2026-07-18T00:00:00.000Z");
  await seedCatalogueExportSummary("catrev_export_list_middle", "run_export_list_middle", "2026-07-19T00:00:00.000Z");

  const first = await exports.default.fetch(
    new Request("https://card-keepr.invalid/v1/catalogue-exports?limit=1", { headers: apiHeaders("203.0.113.105") }),
  );
  expect(first.status).toBe(200);
  const firstDocument = await first.json<{
    data: { catalogue_revision_id: string }[];
    page: { limit: number; next_cursor: string | null };
    meta: { catalogue_revision_id: string };
  }>();
  expect(firstDocument.data.map(({ catalogue_revision_id }) => catalogue_revision_id)).toEqual([
    "catrev_export_list_middle",
  ]);
  expect(firstDocument.page).toEqual({
    limit: 1,
    next_cursor: expect.any(String),
  });
  expect(firstDocument.meta.catalogue_revision_id).toBe("catrev_export_list_middle");
  const collectionAjv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(collectionAjv);
  collectionAjv.addSchema(apiSchema);
  const validateCollection = collectionAjv.getSchema(`${apiSchema.$id}#/$defs/CatalogueExportCollection`)!;
  expect(validateCollection(firstDocument), JSON.stringify(validateCollection.errors)).toBe(true);

  await seedCatalogueExportSummary("catrev_export_list_newest", "run_export_list_newest", "2026-07-20T00:00:00.000Z");
  const second = await exports.default.fetch(
    new Request(
      "https://card-keepr.invalid/v1/catalogue-exports?limit=1&after=" +
        encodeURIComponent(firstDocument.page.next_cursor!),
      { headers: apiHeaders("203.0.113.106") },
    ),
  );
  expect(second.status).toBe(200);
  const secondDocument = await second.json<{
    data: { catalogue_revision_id: string }[];
    page: { next_cursor: string | null };
    meta: { catalogue_revision_id: string };
  }>();
  expect(secondDocument.data.map(({ catalogue_revision_id }) => catalogue_revision_id)).toEqual([
    "catrev_export_list_oldest",
  ]);
  expect(secondDocument.page.next_cursor).toBeNull();
  expect(secondDocument.meta.catalogue_revision_id).toBe("catrev_export_list_middle");
});

test("Catalogue Export JSON routes validate requests and support conditional reads", async () => {
  await seedCatalogueExportSummary("catrev_export_http_old", "run_export_http_old", "2026-07-18T00:00:00.000Z");
  await seedCatalogueExportSummary("catrev_export_http_current", "run_export_http_current", "2026-07-19T00:00:00.000Z");
  const request = (path: string, headers: Record<string, string> = {}) =>
    exports.default.fetch(
      new Request(`https://card-keepr.invalid${path}`, {
        headers: { ...apiHeaders("203.0.113.107"), ...headers },
      }),
    );

  const list = await request("/v1/catalogue-exports?limit=1");
  expect(list.status).toBe(200);
  const listEtag = list.headers.get("etag");
  expect(listEtag).toEqual(expect.any(String));
  const listNotModified = await request("/v1/catalogue-exports?limit=1", { "if-none-match": listEtag! });
  expect(listNotModified.status).toBe(304);
  expect(await listNotModified.text()).toBe("");
  expect(listNotModified.headers.get("x-catalogue-revision")).toBe("catrev_export_http_current");

  const defaultList = await request("/v1/catalogue-exports");
  expect(defaultList.status).toBe(200);
  const defaultListEtag = defaultList.headers.get("etag");
  await expect(defaultList.json()).resolves.toMatchObject({
    links: { self: `${apiPublicBase}/v1/catalogue-exports` },
  });
  const explicitDefault = await request("/v1/catalogue-exports?limit=50", { "if-none-match": defaultListEtag! });
  expect(explicitDefault.status).toBe(304);
  expect(explicitDefault.headers.get("etag")).toBe(defaultListEtag);
  expect(await explicitDefault.text()).toBe("");

  const firstDocument = await list.json<{
    page: { next_cursor: string };
  }>();
  for (const [query, code] of [
    ["limit=0", "invalid_parameter"],
    ["limit=101", "invalid_parameter"],
    ["limit=1.5", "invalid_parameter"],
    ["limit=1&limit=1", "invalid_parameter"],
    ["unknown=value", "invalid_parameter"],
    ["after=not-a-cursor", "invalid_cursor"],
    [`limit=2&after=${encodeURIComponent(firstDocument.page.next_cursor)}`, "invalid_cursor"],
  ]) {
    const invalid = await request(`/v1/catalogue-exports?${query}`);
    expect(invalid.status, query).toBe(400);
    await expect(invalid.json(), query).resolves.toMatchObject({ code });
  }
  const unavailableCursor = JSON.parse(Buffer.from(firstDocument.page.next_cursor, "base64url").toString("utf8"));
  unavailableCursor.revision_id = "catrev_export_cursor_unavailable";
  const unavailable = await request(
    `/v1/catalogue-exports?limit=1&after=${Buffer.from(JSON.stringify(unavailableCursor)).toString("base64url")}`,
  );
  expect(unavailable.status).toBe(409);
  await expect(unavailable.json()).resolves.toMatchObject({
    code: "cursor_revision_unavailable",
    links: { collection: `${apiPublicBase}/v1/catalogue-exports` },
  });

  const manifestPath = "/v1/catalogue-exports/catrev_export_http_current";
  const manifest = await request(manifestPath);
  expect(manifest.status).toBe(200);
  const manifestEtag = manifest.headers.get("etag");
  const manifestNotModified = await request(manifestPath, {
    "if-none-match": manifestEtag!,
  });
  expect(manifestNotModified.status).toBe(304);
  expect(await manifestNotModified.text()).toBe("");
});

test("Catalogue Export listing ETags change when a retained package disappears", async () => {
  await seedCatalogueExportSummary("catrev_export_etag_old", "run_export_etag_old", "2026-07-18T00:00:00.000Z");
  await seedCatalogueExportSummary("catrev_export_etag_current", "run_export_etag_current", "2026-07-19T00:00:00.000Z");
  const path = "/v1/catalogue-exports?limit=1";
  const first = await exports.default.fetch(
    new Request(`https://card-keepr.invalid${path}`, { headers: apiHeaders("203.0.113.108") }),
  );
  expect(first.status).toBe(200);
  const firstEtag = first.headers.get("etag");
  expect(firstEtag).toEqual(expect.any(String));
  await expect(first.json()).resolves.toMatchObject({
    page: { next_cursor: expect.any(String) },
  });

  await catalogueExportQueries.deleteCatalogueExports(testEnv.CATALOGUE_DB).bind("catrev_export_etag_old").run();
  const changed = await exports.default.fetch(
    new Request(`https://card-keepr.invalid${path}`, {
      headers: {
        ...apiHeaders("203.0.113.109"),
        "if-none-match": firstEtag!,
      },
    }),
  );
  expect(changed.status).toBe(200);
  expect(changed.headers.get("etag")).not.toBe(firstEtag);
  await expect(changed.json()).resolves.toMatchObject({
    data: [{ catalogue_revision_id: "catrev_export_etag_current" }],
    page: { limit: 1, next_cursor: null },
  });
});

test("a known deleting or deleted Catalogue Export is immediately 410 while an unknown revision remains 404", async () => {
  await seedCatalogueExportSummary("catrev_export_deleted_old", "run_export_deleted_old", "2026-07-18T00:00:00.000Z");
  await seedCatalogueExportSummary(
    "catrev_export_deleted_current",
    "run_export_deleted_current",
    "2026-07-19T00:00:00.000Z",
  );
  const oldExport = await catalogueExportQueries
    .readCatalogueExportsManifestKeyManifestDigest(testEnv.CATALOGUE_DB)
    .first<{ manifest_key: string; manifest_digest: string }>();
  if (oldExport === null) throw new Error("missing API deletion fixture");
  const planId = "export-deletion-api-plan";
  const deletionId = "export-deletion-api-test";
  const idempotencyKey = "export-deletion-api-key";
  const planDigest = "c".repeat(64);
  const objectSetDigest = "d".repeat(64);
  const requestJson = canonicalJson({
    plan_id: planId,
    plan_digest: planDigest,
    catalogue_revision_id: "catrev_export_deleted_old",
    manifest_digest: oldExport.manifest_digest,
    expected_current_revision_id: "catrev_export_deleted_current",
    confirmation_revision_id: "catrev_export_deleted_old",
    deletion_id: deletionId,
    idempotency_key: idempotencyKey,
  });
  await catalogueExportQueries
    .insertCatalogueExportDeletionPlans(testEnv.CATALOGUE_DB)
    .bind(planId, oldExport.manifest_digest, canonicalJson([oldExport.manifest_key]), objectSetDigest, planDigest)
    .run();
  await catalogueStore(testEnv.CATALOGUE_DB).batch([
    catalogueExportQueries
      .insertCatalogueExportDeletions(testEnv.CATALOGUE_DB)
      .bind(deletionId, planId, oldExport.manifest_digest, objectSetDigest, idempotencyKey, requestJson),
    catalogueExportQueries
      .setCatalogueExportsMaintenanceStateDeletionOperationId(testEnv.CATALOGUE_DB)
      .bind(deletionId),
  ]);

  const request = (path: string) =>
    exports.default.fetch(new Request(`https://card-keepr.invalid${path}`, { headers: apiHeaders("203.0.113.111") }));
  for (const path of [
    "/v1/catalogue-exports/catrev_export_deleted_old",
    "/v1/catalogue-exports/catrev_export_deleted_old/components/cards",
  ]) {
    const deleted = await request(path);
    expect(deleted.status, path).toBe(410);
    await expect(deleted.json(), path).resolves.toMatchObject({
      status: 410,
      code: "catalogue_export_deleted",
    });
  }
  const neverKnownComponent = await request("/v1/catalogue-exports/catrev_export_deleted_old/components/never-known");
  expect(neverKnownComponent.status).toBe(404);
  await expect(neverKnownComponent.json()).resolves.toMatchObject({
    status: 404,
    code: "not_found",
  });
  const unknown = await request("/v1/catalogue-exports/catrev_export_never_known");
  expect(unknown.status).toBe(404);
  await expect(unknown.json()).resolves.toMatchObject({ code: "not_found" });

  const listed = await request("/v1/catalogue-exports");
  expect(listed.status).toBe(200);
  const document = await listed.json<{ data: { catalogue_revision_id: string }[] }>();
  expect(document.data.map(({ catalogue_revision_id }) => catalogue_revision_id)).not.toContain(
    "catrev_export_deleted_old",
  );
});

test("Legality Status rejects a malformed Card identity before lookup", async () => {
  for (const cardId of ["card id with spaces", `card_${"x".repeat(196)}`]) {
    const response = await exports.default.fetch(
      new Request(
        `https://card-keepr.invalid/v1/legality-status?card_id=${encodeURIComponent(cardId)}&on=2026-07-30&format=standard&region=EN-ASIA`,
        {
          headers: {
            authorization: "Bearer vitest-api-key",
            "cf-connecting-ip": "203.0.113.20",
          },
        },
      ),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_parameter",
      invalid_params: [
        {
          name: "card_id",
          reason: "card_id must be an opaque identity of at most 200 characters.",
        },
      ],
    });
  }
});

test("Legality Status rejects unknown, repeated, and duplicated evidence includes", async () => {
  for (const [query, reason] of [
    ["include=unknown", "include must be exactly evidence when supplied."],
    ["include=evidence,evidence", "include must be exactly evidence when supplied."],
    ["include=evidence&include=evidence", "include must be supplied exactly once."],
  ]) {
    const response = await exports.default.fetch(
      new Request(
        `https://card-keepr.invalid/v1/legality-status?${query}&card_id=card_any&on=2026-07-30&format=standard&region=EN-ASIA`,
        {
          headers: {
            authorization: "Bearer vitest-api-key",
            "cf-connecting-ip": "203.0.113.21",
          },
        },
      ),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_parameter",
      invalid_params: [{ name: "include", reason }],
    });
  }
});

test("Legality Status reports the exact invalid query parameter", async () => {
  const cases = [
    ["on=2026-07-30&format=standard", "card_id", "card_id is required."],
    ["card_id=card_any&format=standard", "on", "on is required."],
    ["card_id=card_any&on=2026-07-30", "format", "format is required."],
    ["card_id=card_any&on=2026-02-30&format=standard", "on", "on must be a valid ISO date."],
    ["card_id=card_any&on=2026-07-30&format=", "format", "format must contain at least one character."],
    [
      "card_id=card_any&on=2026-07-30&format=standard&event_tier=",
      "event_tier",
      "event_tier must contain at least one character.",
    ],
    [
      "card_id=card_any&on=2026-07-30&format=standard&region=OCEANIA",
      "region",
      "region must be EN-OCEANIA, EN-ASIA, or EN-US.",
    ],
    ["card_id=card_any&on=2026-07-30&format=standard&unexpected=true", "unexpected", "unexpected is not accepted."],
    [
      "card_id=card_any&card_id=card_other&on=2026-07-30&format=standard",
      "card_id",
      "card_id must be supplied exactly once.",
    ],
  ] as const;
  let address = 110;
  for (const [query, name, reason] of cases) {
    const response = await exports.default.fetch(
      new Request(`https://card-keepr.invalid/v1/legality-status?${query}`, {
        headers: apiHeaders(`203.0.113.${address++}`),
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_parameter",
      invalid_params: [{ name, reason }],
    });
  }
});

test("Legality Status reports an unnamed query key as a schema-valid Problem", async () => {
  const response = await exports.default.fetch(
    new Request("https://card-keepr.invalid/v1/legality-status?=true", { headers: apiHeaders("203.0.113.119") }),
  );
  expect(response.status).toBe(400);
  const problem = await response.json();
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(apiSchema);
  const validateProblem = ajv.getSchema(`${apiSchema.$id}#/$defs/Problem`)!;
  expect(validateProblem(problem), JSON.stringify(validateProblem.errors)).toBe(true);
  expect(problem).toMatchObject({
    code: "invalid_parameter",
    invalid_params: [
      {
        name: "query",
        reason: "query parameter names must be non-empty.",
      },
    ],
  });
});

test("authenticated Legality Status reads only indexed Card and regional applicability at high cardinality", async () => {
  const revisionId = "catrev_api_legality_applicability";
  const runId = "run_api_legality_applicability";
  const targetCardId = "card_api_legality_applicability";
  await seedApiRevision({
    revisionId,
    runId,
    cards: [
      apiCard({
        id: targetCardId,
        cardNumber: "OP30-777",
        name: "Applicability Target",
      }),
    ],
  });
  await catalogueStore(testEnv.CATALOGUE_DB).batch(
    legalitySourceStatements({
      runId,
      key: "api_legality_applicability",
      game: "one-piece",
      profile: "one-piece@1",
      lineage: "one-piece-en",
      adapter: "fixture-one-piece-json@3",
      snapshotId: "srcsnap_api_legality_applicability",
      observationSetId: "srcobsset_api_legality_applicability",
    }),
  );
  const baseRule = {
    game: "one-piece",
    format: "standard",
    event_tier: null,
    effective_from: "2026-01-01",
    effective_until: null,
    source_lineage: "one-piece-en",
    source_snapshot_id: "srcsnap_api_legality_applicability",
    source_observation_set_id: "srcobsset_api_legality_applicability",
    source_observation_id: "srcobs_api_legality_applicability",
  };
  const targetRule = {
    ...baseRule,
    id: "legality_rule_api_applicability_target",
    official_id: "api-applicability-target",
    region: "EN-OCEANIA",
    card_ids: [targetCardId],
    official_wording: "This Card is not legal in the standard format.",
    effect: { type: "ban" },
  };
  const unrelatedCardRules = Array.from({ length: 256 }, (_, index) => ({
    ...baseRule,
    id: `legality_rule_api_applicability_card_${index}`,
    official_id: `api-applicability-card-${index}`,
    region: "EN-OCEANIA",
    card_ids: [`card_api_unrelated_${index}`],
    official_wording: `Unrelated Card rule ${index}.`,
    effect: { type: "eligible" },
  }));
  const unrelatedRegionGlobals = Array.from({ length: 256 }, (_, index) => ({
    ...baseRule,
    id: `legality_rule_api_applicability_region_${index}`,
    official_id: `api-applicability-region-${index}`,
    region: "EN-US",
    card_ids: [],
    official_wording: `Unrelated regional rule ${index}.`,
    effect: { type: "eligible" },
  }));
  const rules = [targetRule, ...unrelatedCardRules, ...unrelatedRegionGlobals];
  for (let offset = 0; offset < rules.length; offset += 64) {
    await catalogueStore(testEnv.CATALOGUE_DB).batch(
      canonicalLegalityRuleStatements(revisionId, rules.slice(offset, offset + 64)),
    );
  }
  for (let offset = 0; offset < rules.length; offset += 64) {
    await catalogueStore(testEnv.CATALOGUE_DB).batch(
      revisionLegalityRuleStatements(revisionId, rules.slice(offset, offset + 64)),
    );
  }
  await legalityQueries.dropRevisionLegalityRulesImmutableUpdate(testEnv.CATALOGUE_DB).run();
  await legalityQueries
    .setRevisionLegalityRulesDocumentJson(testEnv.CATALOGUE_DB)
    .bind(revisionId, targetRule.id)
    .run();

  const response = await exports.default.fetch(
    new Request(
      "https://card-keepr.invalid/v1/legality-status" +
        `?card_id=${targetCardId}` +
        "&on=2026-07-30&format=standard&region=EN-OCEANIA",
      { headers: apiHeaders("203.0.113.22") },
    ),
  );
  await legalityQueries.createRevisionLegalityRulesImmutableUpdate(testEnv.CATALOGUE_DB).run();
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    data: [
      {
        card_id: targetCardId,
        region: "EN-OCEANIA",
        status: "not_legal",
        rule_ids: [targetRule.id],
      },
    ],
  });
});

test("authenticated Legality Status gives definitive exclusions precedence while auditing unresolved rules", async () => {
  const revisionId = "catrev_api_legality_precedence";
  const runId = "run_api_legality_precedence";
  const publishedAt = "2026-07-30T00:00:00.000Z";
  const digest = "c".repeat(64);
  const cases = [
    {
      cardId: "card_precedence_ban",
      attributes: {},
      effect: { type: "ban" },
    },
    {
      cardId: "card_precedence_membership",
      attributes: { traits: ["Principality of Zeon"] },
      effect: {
        type: "membership",
        attribute: "traits",
        includes_any: ["Earth Federation"],
      },
    },
    {
      cardId: "card_precedence_rotation",
      attributes: { block_icon: "2" },
      effect: { type: "rotation", eligible_blocks: ["1"] },
    },
    {
      cardId: "card_precedence_release",
      attributes: {},
      effect: {
        type: "release_timing",
        legal_from: "2026-08-01",
      },
    },
  ] as const;
  const cards = cases.map((testCase) => ({
    type: "card",
    id: testCase.cardId,
    game: "gundam",
    official_identity: {
      kind: "card_number",
      value: `GD-PRECEDENCE-${testCase.cardId}`,
    },
    name: `Precedence ${testCase.cardId}`,
    effective_rules_text: null,
    game_data: {
      profile: "gundam@1",
      attributes: {
        card_type: "unit",
        colours: [],
        level: null,
        cost: null,
        block_icon: null,
        effect_text: null,
        zone: null,
        traits: [],
        link_condition: null,
        ap: null,
        hp: null,
        series_titles: [],
        ...testCase.attributes,
      },
    },
    printing_ids: [],
    source_lineages: ["gundam-en-asia"],
    lifecycle: {
      first_revision_id: revisionId,
      last_observed_revision_id: revisionId,
      withdrawn: false,
    },
    links: { self: `/v1/cards/${testCase.cardId}` },
  }));
  const rules = cases.flatMap((testCase, index) => [
    {
      id: `legality_rule_precedence_${index}_definitive`,
      official_id: `precedence-${index}-definitive`,
      game: "gundam",
      region: "EN-ASIA",
      format: "standard",
      event_tier: null,
      effective_from: "2026-01-01",
      effective_until: null,
      card_ids: [testCase.cardId],
      official_wording: `Definitive exclusion ${index}.`,
      effect: testCase.effect,
      source_lineage: "gundam-en-asia",
      source_snapshot_id: "srcsnap_api_precedence",
      source_observation_set_id: "srcset_api_precedence",
      source_observation_id: "srcobs_api_precedence",
    },
    {
      id: `legality_rule_precedence_${index}_unresolved`,
      official_id: `precedence-${index}-unresolved`,
      game: "gundam",
      region: "EN-ASIA",
      format: "standard",
      event_tier: null,
      effective_from: null,
      effective_until: null,
      unresolved_scope: {
        dimensions: ["effective_interval", "event_tier"] as const,
      },
      card_ids: [testCase.cardId],
      official_wording: `Unresolved qualifier ${index}.`,
      effect: {
        type: "unresolved",
        reason: "A separate qualifier is not machine-readable.",
      },
      source_lineage: "gundam-en-asia",
      source_snapshot_id: "srcsnap_api_precedence",
      source_observation_set_id: "srcset_api_precedence",
      source_observation_id: "srcobs_api_precedence",
    },
    {
      id: `legality_rule_precedence_${index}_future_tier_uncertainty`,
      official_id: `precedence-${index}-future-tier-uncertainty`,
      game: "gundam",
      region: "EN-ASIA",
      format: "standard",
      event_tier: null,
      effective_from: "2026-08-01",
      effective_until: null,
      unresolved_scope: { dimensions: ["event_tier"] as const },
      card_ids: [testCase.cardId],
      official_wording: `Future event-tier uncertainty ${index}.`,
      effect: {
        type: "unresolved",
        reason: "The future rule does not identify an event tier.",
      },
      source_lineage: "gundam-en-asia",
      source_snapshot_id: "srcsnap_api_precedence",
      source_observation_set_id: "srcset_api_precedence",
      source_observation_id: "srcobs_api_precedence",
    },
  ]);
  await catalogueStore(testEnv.CATALOGUE_DB).batch([
    ingestionQueries
      .insertIngestionRunsForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
        testEnv.CATALOGUE_DB,
      )
      .bind(
        runId,
        publishedAt,
        digest,
        publishedAt,
        JSON.stringify({
          action: "approved",
          candidate_digest: digest,
          expected_current_revision_id: "catrev_spine_000",
          approved_at: publishedAt,
        }),
      ),
    ingestionQueries
      .setOperationStateActiveIngestionRunIdForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
        testEnv.CATALOGUE_DB,
      )
      .bind(runId),
    ...legalitySourceStatements({
      runId,
      key: "api_precedence",
      game: "gundam",
      profile: "gundam@1",
      lineage: "gundam-en-asia",
      adapter: "fixture-gundam-en-asia-json@2",
      snapshotId: "srcsnap_api_precedence",
      observationSetId: "srcset_api_precedence",
    }),
    ingestionQueries
      .insertCatalogueRevisionsForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
        testEnv.CATALOGUE_DB,
      )
      .bind(revisionId, runId, publishedAt, digest, digest),
    ...canonicalLegalityRuleStatements(revisionId, rules),
    ...cards.map((card) =>
      publishedCatalogueQueries
        .insertRevisionCardsForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
          testEnv.CATALOGUE_DB,
        )
        .bind(revisionId, card.id, JSON.stringify(publishedCardEnvelope(card))),
    ),
    ...revisionLegalityRuleStatements(revisionId, rules),
    publishedCatalogueQueries
      .setCatalogueStateCurrentRevisionIdPublishedAt(testEnv.CATALOGUE_DB)
      .bind(revisionId, publishedAt),
  ]);

  const legalityAjv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(legalityAjv);
  legalityAjv.addSchema(apiSchema);
  const validateLegalityStatus = legalityAjv.getSchema(`${apiSchema.$id}#/$defs/LegalityStatusDocument`)!;

  for (const [index, testCase] of cases.entries()) {
    const response = await exports.default.fetch(
      new Request(
        "https://card-keepr.invalid/v1/legality-status" +
          `?card_id=${testCase.cardId}` +
          "&on=2026-07-30&format=standard&region=EN-ASIA",
        {
          headers: {
            authorization: "Bearer vitest-api-key",
            "cf-connecting-ip": `203.0.113.${40 + index}`,
          },
        },
      ),
    );
    expect(response.status).toBe(200);
    const body = await response.json<{
      data: Array<{
        status: string;
        rule_ids: string[];
        unresolved_scope_rule_ids: string[];
        derivation: string;
      }>;
      included?: unknown[];
      provenance?: Record<string, string[]>;
    }>();
    expect(body).not.toHaveProperty("included");
    expect(body).not.toHaveProperty("provenance");
    expect(validateLegalityStatus(body), JSON.stringify(validateLegalityStatus.errors)).toBe(true);
    expect(body.data[0]).toMatchObject({
      status: "not_legal",
      rule_ids: [`legality_rule_precedence_${index}_definitive`],
      unresolved_scope_rule_ids: [`legality_rule_precedence_${index}_unresolved`],
    });
    expect(body.data[0]!.derivation).toContain("evaluated not_legal");
    expect(body.data[0]!.derivation).toContain("evaluated indeterminate");
    if (index === 0) {
      const evidenceResponse = await exports.default.fetch(
        new Request(
          "https://card-keepr.invalid/v1/legality-status" +
            `?card_id=${testCase.cardId}` +
            "&on=2026-07-30&format=standard&region=EN-ASIA&include=evidence",
          {
            headers: {
              authorization: "Bearer vitest-api-key",
              "cf-connecting-ip": "203.0.113.79",
            },
          },
        ),
      );
      expect(evidenceResponse.status).toBe(200);
      const evidenceBody = await evidenceResponse.json();
      expect(validateLegalityStatus(evidenceBody), JSON.stringify(validateLegalityStatus.errors)).toBe(true);
      expect(evidenceBody).toMatchObject({
        included: [
          {
            type: "source_observation",
            id: "srcobs_api_precedence",
            captured_at: "2026-07-30T00:00:01.000Z",
            source: "gundam-en-asia",
          },
        ],
        provenance: {
          "/data/0/status": ["srcobs_api_precedence"],
          "/data/0/rule_ids/0": ["srcobs_api_precedence"],
          "/data/0/unresolved_scope_rule_ids/0": ["srcobs_api_precedence"],
        },
      });
      const etag = response.headers.get("etag");
      expect(etag).not.toBeNull();
      const url =
        "https://card-keepr.invalid/v1/legality-status" +
        `?card_id=${testCase.cardId}` +
        "&on=2026-07-30&format=standard&region=EN-ASIA";
      const validators = [etag!, `W/${etag}`, `"unrelated", W/${etag}`, "*"];
      const conditional = await Promise.all(
        validators.map((validator, validatorIndex) =>
          exports.default.fetch(
            new Request(url, {
              headers: {
                authorization: "Bearer vitest-api-key",
                "cf-connecting-ip": `203.0.113.${80 + validatorIndex}`,
                "if-none-match": validator,
              },
            }),
          ),
        ),
      );
      expect(conditional.map(({ status }) => status)).toEqual([304, 304, 304, 304]);
      for (const matched of conditional) {
        expect(await matched.text()).toBe("");
        expect(matched.headers.get("etag")).toBe(etag);
        expect(matched.headers.get("x-catalogue-revision")).toBe(revisionId);
      }
      const nonmatch = await exports.default.fetch(
        new Request(url, {
          headers: {
            authorization: "Bearer vitest-api-key",
            "cf-connecting-ip": "203.0.113.84",
            "if-none-match": '"unrelated"',
          },
        }),
      );
      expect(nonmatch.status).toBe(200);
      expect(nonmatch.headers.get("etag")).toBe(etag);
    }
  }

  const statusUrl =
    "https://card-keepr.invalid/v1/legality-status" +
    `?card_id=${cases[0].cardId}` +
    "&on=2026-07-30&format=standard&region=EN-ASIA";
  const expectInvalidStoredDocument = async () => {
    const response = await exports.default.fetch(
      new Request(statusUrl, {
        headers: {
          authorization: "Bearer vitest-api-key",
          "cf-connecting-ip": "203.0.113.99",
        },
      }),
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      code: "internal_error",
    });
  };
  const originalCard = cards[0]!;
  const malformedCards = [
    { id: originalCard.id, game: originalCard.game, game_data: originalCard.game_data },
    {
      ...originalCard,
      game_data: {
        ...originalCard.game_data,
        attributes: { ...originalCard.game_data.attributes, traits: {} },
      },
    },
    {
      ...originalCard,
      official_identity: { kind: "functional_designation", value: "DON!!" },
    },
    {
      ...originalCard,
      lifecycle: {
        ...originalCard.lifecycle,
        withdrawn: true,
      },
    },
  ];
  for (const malformed of malformedCards) {
    await publishedCatalogueQueries
      .setRevisionCardsDocumentJsonForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
        testEnv.CATALOGUE_DB,
      )
      .bind(JSON.stringify(publishedCardEnvelope(malformed)), revisionId, originalCard.id)
      .run();
    await expectInvalidStoredDocument();
  }
  await publishedCatalogueQueries
    .setRevisionCardsDocumentJsonForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
      testEnv.CATALOGUE_DB,
    )
    .bind(JSON.stringify(publishedCardEnvelope(originalCard)), revisionId, originalCard.id)
    .run();

  const pointer = "/observations/0/value/legality_rules/0";
  const originalRule = {
    ...rules[0]!,
    source_observation_pointer: pointer,
    source_field_pointers: legalityRuleFieldPointers(pointer),
    first_revision_id: revisionId,
    last_observed_revision_id: revisionId,
    current: true,
    last_missing_revision_id: null,
  };
  await legalityQueries.dropRevisionLegalityRulesImmutableUpdate(testEnv.CATALOGUE_DB).run();
  const malformedRules = [
    {
      ...originalRule,
      source_field_pointers: {
        official_wording: `${pointer}/official_wording`,
      },
    },
    { ...originalRule, game: "one-piece" },
    { ...originalRule, current: false, last_missing_revision_id: null },
    { ...originalRule, effect: { type: "publisher_extension" } },
    {
      ...originalRule,
      effect: { ...originalRule.effect, publisher_extension: true },
    },
    {
      ...originalRule,
      effect: {
        type: "prohibited_combination",
        with_card_numbers: ["OP01-999"],
      },
    },
  ];
  for (const malformed of malformedRules) {
    await legalityQueries
      .setRevisionLegalityRulesDocumentJsonForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
        testEnv.CATALOGUE_DB,
      )
      .bind(JSON.stringify(malformed), revisionId, originalRule.id)
      .run();
    await expectInvalidStoredDocument();
  }
});

test("Legality Status evidence reports the captured_at the publication projected", async () => {
  // The evidence sidecar reads source_retrieved_at from the revision row
  // (migration 0004), not source_snapshots: the projected instant here
  // deliberately differs from the seeded snapshot's retrieved_at
  // (issue #98).
  const revisionId = "catrev_api_projected_evidence";
  const runId = "run_api_projected_evidence";
  const publishedAt = "2026-07-30T00:00:00.000Z";
  const digest = "f".repeat(64);
  const projectedCapturedAt = "2026-07-29T23:59:59.000Z";
  const card = {
    type: "card",
    id: "card_projected_evidence",
    game: "gundam",
    official_identity: { kind: "card_number", value: "GD-PROJ-001" },
    name: "Projected evidence",
    effective_rules_text: null,
    game_data: {
      profile: "gundam@1",
      attributes: {
        card_type: "unit",
        colours: [],
        level: null,
        cost: null,
        block_icon: null,
        effect_text: null,
        zone: null,
        traits: [],
        link_condition: null,
        ap: null,
        hp: null,
        series_titles: [],
      },
    },
    printing_ids: [],
    source_lineages: ["gundam-en-asia"],
    lifecycle: {
      first_revision_id: revisionId,
      last_observed_revision_id: revisionId,
      withdrawn: false,
    },
    links: { self: "/v1/cards/card_projected_evidence" },
  };
  const rules = [
    {
      id: "legality_rule_projected_evidence",
      official_id: "projected-evidence-ban",
      game: "gundam",
      region: "EN-ASIA",
      format: "standard",
      event_tier: null,
      effective_from: "2026-01-01",
      effective_until: null,
      card_ids: [card.id],
      official_wording: "Banned with projected evidence.",
      effect: { type: "ban" },
      source_lineage: "gundam-en-asia",
      source_snapshot_id: "srcsnap_api_projected_evidence",
      source_observation_set_id: "srcset_api_projected_evidence",
      source_observation_id: "srcobs_api_projected_evidence",
      source_retrieved_at: projectedCapturedAt,
    },
  ];
  await catalogueStore(testEnv.CATALOGUE_DB).batch([
    ingestionQueries
      .insertIngestionRunsForLegalityStatusEvidenceReportsCapturedAtPublicationProjected(testEnv.CATALOGUE_DB)
      .bind(
        runId,
        publishedAt,
        digest,
        publishedAt,
        JSON.stringify({
          action: "approved",
          candidate_digest: digest,
          expected_current_revision_id: "catrev_spine_000",
          approved_at: publishedAt,
        }),
      ),
    ingestionQueries
      .setOperationStateActiveIngestionRunIdForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
        testEnv.CATALOGUE_DB,
      )
      .bind(runId),
    ...legalitySourceStatements({
      runId,
      key: "api_projected_evidence",
      game: "gundam",
      profile: "gundam@1",
      lineage: "gundam-en-asia",
      adapter: "fixture-gundam-en-asia-json@2",
      snapshotId: "srcsnap_api_projected_evidence",
      observationSetId: "srcset_api_projected_evidence",
    }),
    ingestionQueries
      .insertCatalogueRevisionsForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
        testEnv.CATALOGUE_DB,
      )
      .bind(revisionId, runId, publishedAt, digest, digest),
    ...canonicalLegalityRuleStatements(revisionId, rules),
    publishedCatalogueQueries
      .insertRevisionCardsForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
        testEnv.CATALOGUE_DB,
      )
      .bind(revisionId, card.id, JSON.stringify(publishedCardEnvelope(card))),
    ...revisionLegalityRuleStatements(revisionId, rules),
    publishedCatalogueQueries
      .setCatalogueStateCurrentRevisionIdPublishedAt(testEnv.CATALOGUE_DB)
      .bind(revisionId, publishedAt),
  ]);

  const response = await exports.default.fetch(
    new Request(
      "https://card-keepr.invalid/v1/legality-status" +
        `?card_id=${card.id}&on=2026-07-30&format=standard&region=EN-ASIA&include=evidence`,
      {
        headers: {
          authorization: "Bearer vitest-api-key",
          "cf-connecting-ip": "203.0.113.90",
        },
      },
    ),
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    data: [{ status: "not_legal", rule_ids: ["legality_rule_projected_evidence"] }],
    included: [
      {
        type: "source_observation",
        id: "srcobs_api_projected_evidence",
        captured_at: projectedCapturedAt,
        source: "gundam-en-asia",
      },
    ],
  });
});

test("an unresolved target-scope rule answers explicitly indeterminate for every overlapping query", async () => {
  const revisionId = "catrev_api_target_scope";
  const runId = "run_api_target_scope";
  const publishedAt = "2026-07-30T00:00:00.000Z";
  const digest = "e".repeat(64);
  const cardIds = ["card_scope_enumerated", "card_scope_open", "card_scope_banned"] as const;
  const cards = cardIds.map((cardId) => ({
    type: "card",
    id: cardId,
    game: "gundam",
    official_identity: {
      kind: "card_number",
      value: `GD-SCOPE-${cardId}`,
    },
    name: `Target scope ${cardId}`,
    effective_rules_text: null,
    game_data: {
      profile: "gundam@1",
      attributes: {
        card_type: "unit",
        colours: [],
        level: null,
        cost: null,
        block_icon: null,
        effect_text: null,
        zone: null,
        traits: [],
        link_condition: null,
        ap: null,
        hp: null,
        series_titles: [],
      },
    },
    printing_ids: [],
    source_lineages: ["gundam-en-asia"],
    lifecycle: {
      first_revision_id: revisionId,
      last_observed_revision_id: revisionId,
      withdrawn: false,
    },
    links: { self: `/v1/cards/${cardId}` },
  }));
  const provenance = {
    source_lineage: "gundam-en-asia",
    source_snapshot_id: "srcsnap_api_target_scope",
    source_observation_set_id: "srcset_api_target_scope",
    source_observation_id: "srcobs_api_target_scope",
  } as const;
  const rules = [
    {
      id: "legality_rule_open_predicate",
      official_id: "target-scope-open-predicate",
      game: "gundam",
      region: "EN-ASIA",
      format: "standard",
      event_tier: null,
      effective_from: null,
      effective_until: null,
      unresolved_scope: {
        dimensions: ["effective_interval", "target_scope"] as const,
      },
      card_ids: ["card_scope_enumerated"],
      official_wording: "Every current and future card matching the published description is restricted.",
      effect: {
        type: "unresolved",
        reason: "The published description includes future printings; its complete matching-card scope is not stated.",
      },
      ...provenance,
    },
    {
      id: "legality_rule_scope_definitive_ban",
      official_id: "target-scope-definitive-ban",
      game: "gundam",
      region: "EN-ASIA",
      format: "standard",
      event_tier: null,
      effective_from: "2026-01-01",
      effective_until: null,
      card_ids: ["card_scope_banned"],
      official_wording: "Definitive ban alongside the open predicate.",
      effect: { type: "ban" },
      ...provenance,
    },
  ];
  await catalogueStore(testEnv.CATALOGUE_DB).batch([
    ingestionQueries
      .insertIngestionRunsForUnresolvedTargetScopeRuleAnswersExplicitlyIndeterminateEveryOverlapping(
        testEnv.CATALOGUE_DB,
      )
      .bind(
        runId,
        publishedAt,
        digest,
        publishedAt,
        JSON.stringify({
          action: "approved",
          candidate_digest: digest,
          expected_current_revision_id: "catrev_spine_000",
          approved_at: publishedAt,
        }),
      ),
    ingestionQueries
      .setOperationStateActiveIngestionRunIdForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
        testEnv.CATALOGUE_DB,
      )
      .bind(runId),
    ...legalitySourceStatements({
      runId,
      key: "api_target_scope",
      game: "gundam",
      profile: "gundam@1",
      lineage: "gundam-en-asia",
      adapter: "fixture-gundam-en-asia-json@2",
      snapshotId: "srcsnap_api_target_scope",
      observationSetId: "srcset_api_target_scope",
    }),
    ingestionQueries
      .insertCatalogueRevisionsForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
        testEnv.CATALOGUE_DB,
      )
      .bind(revisionId, runId, publishedAt, digest, digest),
    ...canonicalLegalityRuleStatements(revisionId, rules),
    ...cards.map((card) =>
      publishedCatalogueQueries
        .insertRevisionCardsForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
          testEnv.CATALOGUE_DB,
        )
        .bind(revisionId, card.id, JSON.stringify(publishedCardEnvelope(card))),
    ),
    ...revisionLegalityRuleStatements(revisionId, rules),
    publishedCatalogueQueries
      .setCatalogueStateCurrentRevisionIdPublishedAt(testEnv.CATALOGUE_DB)
      .bind(revisionId, publishedAt),
  ]);

  // The target-scope rule materializes one explicit all_cards row alongside
  // its enumerated Card row.
  const applicability = await legalityQueries
    .readRevisionLegalityRuleApplicabilityApplicabilityKindCardId(testEnv.CATALOGUE_DB)
    .bind(revisionId, "legality_rule_open_predicate")
    .all();
  expect(applicability.results).toEqual([
    { applicability_kind: "all_cards", card_id: "" },
    { applicability_kind: "card", card_id: "card_scope_enumerated" },
  ]);

  const status = async (cardId: string, query: string, ip: string) => {
    const response = await exports.default.fetch(
      new Request(`https://card-keepr.invalid/v1/legality-status?card_id=${cardId}&on=2026-07-30&${query}`, {
        headers: {
          authorization: "Bearer vitest-api-key",
          "cf-connecting-ip": ip,
        },
      }),
    );
    expect(response.status).toBe(200);
    return (
      await response.json<{
        data: Array<{
          status: string;
          rule_ids: string[];
          unresolved_scope_rule_ids: string[];
          derivation: string;
        }>;
      }>()
    ).data[0]!;
  };

  // A query for a Card outside the enumerated matches overlaps the open
  // predicate and answers explicitly indeterminate.
  const open = await status("card_scope_open", "format=standard&region=EN-ASIA", "203.0.113.110");
  expect(open).toMatchObject({
    status: "indeterminate",
    rule_ids: [],
    unresolved_scope_rule_ids: ["legality_rule_open_predicate"],
  });
  expect(open.derivation).toContain("unresolved scope");

  // The enumerated Card answers the same explicit uncertainty.
  const enumerated = await status("card_scope_enumerated", "format=standard&region=EN-ASIA", "203.0.113.111");
  expect(enumerated).toMatchObject({
    status: "indeterminate",
    unresolved_scope_rule_ids: ["legality_rule_open_predicate"],
  });

  // A definitive exclusion still decides its Card while the uncertainty
  // remains in the audit.
  const banned = await status("card_scope_banned", "format=standard&region=EN-ASIA", "203.0.113.112");
  expect(banned).toMatchObject({
    status: "not_legal",
    rule_ids: ["legality_rule_scope_definitive_ban"],
    unresolved_scope_rule_ids: ["legality_rule_open_predicate"],
  });
  expect(banned.derivation).toContain("evaluated not_legal");

  // A non-overlapping context (different format) answers normally without
  // the target-scope rule.
  const otherFormat = await status("card_scope_open", "format=unlimited&region=EN-ASIA", "203.0.113.113");
  expect(otherFormat).toMatchObject({
    status: "indeterminate",
    rule_ids: [],
    unresolved_scope_rule_ids: [],
  });
  expect(otherFormat.derivation).toContain("no effective published Legality Rule");

  // The other lineage's region carries no such rule and answers normally.
  const otherRegion = await status("card_scope_open", "format=standard&region=EN-US", "203.0.113.114");
  expect(otherRegion).toMatchObject({
    status: "indeterminate",
    rule_ids: [],
    unresolved_scope_rule_ids: [],
  });
});

test("authenticated Legality Status targets the functional DON!! Card and audits unresolved rules", async () => {
  const revisionId = "catrev_api_don_legality";
  const runId = "run_api_don_legality";
  const publishedAt = "2026-07-30T00:00:00.000Z";
  const digest = "d".repeat(64);
  const donId = "card_api_functional_don";
  const companionId = "card_api_don_companion";
  const cards = [
    {
      type: "card",
      id: donId,
      game: "one-piece",
      official_identity: {
        kind: "functional_designation",
        value: "DON!!",
      },
      game_data: {
        profile: "one-piece@1",
        attributes: {
          card_type: "don",
          colours: [],
          cost: null,
          life: null,
          battle_attributes: [],
          power: null,
          counter: null,
          traits: [],
          block_icons: [],
          effect_text: null,
          trigger_text: null,
        },
      },
      name: "DON!!",
      effective_rules_text: null,
      printing_ids: [],
      source_lineages: ["one-piece-en"],
      lifecycle: {
        first_revision_id: revisionId,
        last_observed_revision_id: revisionId,
        withdrawn: false,
      },
      links: { self: `/v1/cards/${donId}` },
    },
    {
      type: "card",
      id: companionId,
      game: "one-piece",
      official_identity: { kind: "card_number", value: "OP30-001" },
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
          effect_text: null,
          trigger_text: null,
        },
      },
      name: "DON companion",
      effective_rules_text: null,
      printing_ids: [],
      source_lineages: ["one-piece-en"],
      lifecycle: {
        first_revision_id: revisionId,
        last_observed_revision_id: revisionId,
        withdrawn: false,
      },
      links: { self: `/v1/cards/${companionId}` },
    },
  ];
  const baseRule = {
    game: "one-piece",
    region: "EN-OCEANIA",
    format: "standard",
    event_tier: null,
    effective_from: "2026-01-01",
    effective_until: null,
    card_ids: [donId],
    source_lineage: "one-piece-en",
    source_snapshot_id: "srcsnap_api_don",
    source_observation_set_id: "srcobsset_api_don",
    source_observation_id: "srcobs_api_don",
  };
  const rules = [
    {
      ...baseRule,
      id: "legality_rule_api_don_ban",
      official_id: "api-don-ban",
      official_wording: "DON!! may not be included in this deck.",
      effect: { type: "ban" },
    },
    {
      ...baseRule,
      id: "legality_rule_api_don_copy",
      official_id: "api-don-copy",
      official_wording: "Decks may contain one copy of DON!!.",
      effect: { type: "copy_limit", maximum_copies: 1 },
    },
    {
      ...baseRule,
      id: "legality_rule_api_don_combination",
      official_id: "api-don-combination",
      official_wording: "DON!! and OP30-001 may not be combined.",
      effect: {
        type: "prohibited_combination",
        with_card_ids: [companionId],
      },
    },
    {
      ...baseRule,
      id: "legality_rule_api_don_unresolved",
      official_id: "api-don-unresolved",
      official_wording: "The side-event scope is not stated.",
      effect: {
        type: "unresolved",
        reason: "The Official Source omitted the side-event scope.",
      },
    },
  ];
  await catalogueStore(testEnv.CATALOGUE_DB).batch([
    ingestionQueries
      .insertIngestionRunsForAuthenticatedLegalityStatusTargetsFunctionalDONCardAuditsUnresolved(testEnv.CATALOGUE_DB)
      .bind(
        runId,
        publishedAt,
        digest,
        publishedAt,
        JSON.stringify({
          action: "approved",
          candidate_digest: digest,
          expected_current_revision_id: "catrev_spine_000",
          approved_at: publishedAt,
        }),
      ),
    ingestionQueries
      .setOperationStateActiveIngestionRunIdForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
        testEnv.CATALOGUE_DB,
      )
      .bind(runId),
    ...legalitySourceStatements({
      runId,
      key: "api_don",
      game: "one-piece",
      profile: "one-piece@1",
      lineage: "one-piece-en",
      adapter: "fixture-one-piece-json@3",
      snapshotId: "srcsnap_api_don",
      observationSetId: "srcobsset_api_don",
    }),
    ingestionQueries
      .insertCatalogueRevisionsForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
        testEnv.CATALOGUE_DB,
      )
      .bind(revisionId, runId, publishedAt, digest, digest),
    ...canonicalLegalityRuleStatements(revisionId, rules),
    ...cards.map((card) =>
      publishedCatalogueQueries
        .insertRevisionCardsForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
          testEnv.CATALOGUE_DB,
        )
        .bind(revisionId, card.id, JSON.stringify(publishedCardEnvelope(card))),
    ),
    ...revisionLegalityRuleStatements(revisionId, rules),
    publishedCatalogueQueries
      .setCatalogueStateCurrentRevisionIdPublishedAt(testEnv.CATALOGUE_DB)
      .bind(revisionId, publishedAt),
  ]);

  const response = await exports.default.fetch(
    new Request(
      `https://card-keepr.invalid/v1/legality-status?card_id=${donId}&on=2026-07-30&format=standard&region=EN-OCEANIA`,
      {
        headers: {
          authorization: "Bearer vitest-api-key",
          "cf-connecting-ip": "203.0.113.60",
        },
      },
    ),
  );
  expect(response.status).toBe(200);
  const body = await response.json<{
    data: Array<{ status: string; rule_ids: string[]; derivation: string }>;
  }>();
  expect(body.data[0]).toMatchObject({
    status: "not_legal",
    rule_ids: [
      "legality_rule_api_don_ban",
      "legality_rule_api_don_combination",
      "legality_rule_api_don_copy",
      "legality_rule_api_don_unresolved",
    ],
  });
  expect(body.data[0]!.derivation).toContain("legality_rule_api_don_unresolved (unresolved) evaluated indeterminate");
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
  const previousRevisionId = await publishedCatalogueQueries
    .readCatalogueStateCurrentRevisionId(testEnv.CATALOGUE_DB)
    .first<string>("current_revision_id");
  if (previousRevisionId === null) {
    throw new Error("The API test catalogue state is unavailable.");
  }
  await catalogueStore(testEnv.CATALOGUE_DB).batch([
    ingestionQueries
      .insertIngestionRunsForPublicPrintingResponseValidatesFullDistributionContextObjects(testEnv.CATALOGUE_DB)
      .bind(
        previousRevisionId,
        "a".repeat(64),
        JSON.stringify({
          candidate_digest: "a".repeat(64),
          expected_current_revision_id: previousRevisionId,
          approved_at: "2026-01-01T00:00:00.000Z",
        }),
      ),
    ingestionQueries.setOperationStateActiveIngestionRunIdForPublicPrintingResponseValidatesFullDistributionContextObjects(
      testEnv.CATALOGUE_DB,
    ),
    ingestionQueries
      .insertCatalogueRevisionsForPublicPrintingResponseValidatesFullDistributionContextObjects(testEnv.CATALOGUE_DB)
      .bind("a".repeat(64), previousRevisionId, "a".repeat(64)),
    publishedCatalogueQueries
      .insertRevisionPrintingsForPublicPrintingResponseValidatesFullDistributionContextObjects(testEnv.CATALOGUE_DB)
      .bind("catrev_api_context", document.id, document.card_id, JSON.stringify(document)),
    publishedCatalogueQueries.setCatalogueStateCurrentRevisionIdPublishedAtForPublicPrintingResponseValidatesFullDistributionContextObjects(
      testEnv.CATALOGUE_DB,
    ),
  ]);
  const response = await exports.default.fetch(
    new Request("https://card-keepr.invalid/v1/printings/printing_api_context", {
      headers: {
        authorization: "Bearer vitest-api-key",
        "cf-connecting-ip": "203.0.113.10",
      },
    }),
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(exportManifestSchemaV5);
  ajv.addSchema(apiSchema);
  const validate = ajv.getSchema(`${apiSchema.$id}#/$defs/PrintingDocument`);
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
  await catalogueStore(testEnv.CATALOGUE_DB).batch([
    ingestionQueries.setIngestionRunsStatePublishedRevisionId(testEnv.CATALOGUE_DB),
    ingestionQueries.setOperationStateActiveIngestionRunIdForPublicPrintingResponseValidatesFullDistributionContextObjectsWithRunApiContext(
      testEnv.CATALOGUE_DB,
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
    effective_rules_text: "[On Play] Draw 2 cards, then discard 1 card.",
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
  const previousRevisionId = await publishedCatalogueQueries
    .readCatalogueStateCurrentRevisionId(testEnv.CATALOGUE_DB)
    .first<string>("current_revision_id");
  if (previousRevisionId === null) {
    throw new Error("The API test catalogue state is unavailable.");
  }
  await catalogueStore(testEnv.CATALOGUE_DB).batch([
    ingestionQueries
      .insertIngestionRunsForAuthenticatedCardPrintingReadsExposeEffectivePrintedRulesText(testEnv.CATALOGUE_DB)
      .bind(
        previousRevisionId,
        "b".repeat(64),
        JSON.stringify({
          candidate_digest: "b".repeat(64),
          expected_current_revision_id: previousRevisionId,
          approved_at: "2026-07-01T00:00:00.000Z",
        }),
      ),
    ingestionQueries.setOperationStateActiveIngestionRunIdForAuthenticatedCardPrintingReadsExposeEffectivePrintedRulesText(
      testEnv.CATALOGUE_DB,
    ),
    ingestionQueries
      .insertCatalogueRevisionsForAuthenticatedCardPrintingReadsExposeEffectivePrintedRulesText(testEnv.CATALOGUE_DB)
      .bind("b".repeat(64), previousRevisionId, "b".repeat(64)),
    publishedCatalogueQueries
      .insertRevisionCardsForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
        testEnv.CATALOGUE_DB,
      )
      .bind("catrev_errata_read", card.id, JSON.stringify(card)),
    ...cardSearchStatements("catrev_errata_read", card),
    publishedCatalogueQueries.insertCatalogueQueryRevisionsForAuthenticatedCardPrintingReadsExposeEffectivePrintedRulesText(
      testEnv.CATALOGUE_DB,
    ),
    publishedCatalogueQueries
      .insertRevisionPrintingsForPublicPrintingResponseValidatesFullDistributionContextObjects(testEnv.CATALOGUE_DB)
      .bind("catrev_errata_read", printing.id, printing.card_id, JSON.stringify(printing)),
    publishedCatalogueQueries.setCatalogueStateCurrentRevisionIdPublishedAtForAuthenticatedCardPrintingReadsExposeEffectivePrintedRulesText(
      testEnv.CATALOGUE_DB,
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
    exports.default.fetch(new Request("https://card-keepr.invalid/v1/printings/printing_errata_read", { headers })),
    exports.default.fetch(new Request("https://card-keepr.invalid/v1/cards?q=discard%201%20card", { headers })),
  ]);
  expect(cardResponse.status).toBe(200);
  expect(printingResponse.status).toBe(200);
  expect(searchResponse.status).toBe(200);
  await expect(cardResponse.json()).resolves.toMatchObject({
    data: {
      effective_rules_text: "[On Play] Draw 2 cards, then discard 1 card.",
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
  await publishedCatalogueQueries
    .insertRevisionCardsForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
      testEnv.CATALOGUE_DB,
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
    [etag!, `W/${etag}`, `"unrelated", W/${etag}`, "*"].map((ifNoneMatch) =>
      exports.default.fetch(
        new Request("https://card-keepr.invalid/v1/cards?q=discard%201%20card", {
          headers: {
            ...headers,
            "if-none-match": ifNoneMatch,
          },
        }),
      ),
    ),
  );
  expect(conditionalResponses.map((response) => response.status)).toEqual([304, 304, 304, 304]);
  for (const response of conditionalResponses) {
    expect(response.headers.get("x-catalogue-revision")).toBe("catrev_errata_read");
  }
  await catalogueStore(testEnv.CATALOGUE_DB).batch([
    ingestionQueries.setIngestionRunsStatePublishedRevisionIdForAuthenticatedCardPrintingReadsExposeEffectivePrintedRulesText(
      testEnv.CATALOGUE_DB,
    ),
    ingestionQueries.setOperationStateActiveIngestionRunIdForAuthenticatedCardPrintingReadsExposeEffectivePrintedRulesTextWithRunErrataRead(
      testEnv.CATALOGUE_DB,
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
    new Request("https://card-keepr.invalid/v1/cards?q=bounded&limit=1", { headers: apiHeaders("203.0.113.30") }),
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

test("authenticated Card collection rejects present empty game and card_number filters", async () => {
  await seedApiRevision({
    revisionId: "catrev_empty_filters",
    runId: "run_empty_filters",
    cards: [
      apiCard({
        id: "card_empty_filters",
        cardNumber: "OP29-400",
        name: "Must not be returned unfiltered",
      }),
    ],
  });
  let sequence = 70;
  for (const [name, value] of [
    ["game", ""],
    ["game", " \t "],
    ["card_number", ""],
    ["card_number", " \t "],
  ] as const) {
    const response = await exports.default.fetch(
      new Request(`https://card-keepr.invalid/v1/cards?${name}=${encodeURIComponent(value)}`, {
        headers: apiHeaders(`203.0.113.${sequence++}`),
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_parameter",
      invalid_params: [
        {
          name,
          reason: `${name} must contain at least one character.`,
        },
      ],
    });
  }
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
    new Request("https://card-keepr.invalid/v1/cards?q=E%CC%81CLAIR%20lüffy", { headers: apiHeaders("203.0.113.34") }),
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    data: [{ id: "card_unicode_search" }],
  });
});

test("Card search uses literal short queries beside FTS", async () => {
  const ordinaryCards = Array.from({ length: 200 }, (_, index) =>
    apiCard({
      id: `card_selectivity_${String(index).padStart(3, "0")}`,
      cardNumber: `OP31-${String(index).padStart(3, "0")}`,
      name: `Ordinary leader number ${index}`,
      effectiveRulesText: "Activate Main Once Per Turn: draw one card from your deck.",
    }),
  );
  const selected = apiCard({
    id: "card_selectivity_quartz",
    cardNumber: "OP31-999",
    name: "Quartz Vanguard",
    effectiveRulesText: "Activate Main: reveal the quartz marker from your deck.",
  });
  await seedApiRevision({
    revisionId: "catrev_selective_trigrams",
    runId: "run_selective_trigrams",
    cards: [...ordinaryCards, selected],
  });

  const matched = await exports.default.fetch(
    new Request("https://card-keepr.invalid/v1/cards?q=qu", {
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
});

test("authenticated Card search validates raw and normalized q at 1 through 500 characters", async () => {
  const token = (length: number) => "x".repeat(length);
  await seedApiRevision({
    revisionId: "catrev_query_boundaries",
    runId: "run_query_boundaries",
    cards: [
      apiCard({
        id: "card_query_boundaries",
        cardNumber: "OP29-500",
        name: [token(1), token(128), token(129), token(500)].join(" "),
      }),
    ],
  });
  let sequence = 40;
  for (const query of [token(1), token(128), token(129), token(500), "ﬀ".repeat(250), "---", '"quoted"']) {
    const response = await exports.default.fetch(
      new Request(`https://card-keepr.invalid/v1/cards?q=${encodeURIComponent(query)}`, {
        headers: apiHeaders(`203.0.113.${sequence++}`),
      }),
    );
    expect(response.status, `${query.length}: ${await response.clone().text()}`).toBe(200);
  }
  for (const [query, reason] of [
    [token(501), "q must contain at most 500 characters."],
    ["ﬀ".repeat(251), "q must contain at most 500 characters."],
  ] as const) {
    const response = await exports.default.fetch(
      new Request(`https://card-keepr.invalid/v1/cards?q=${encodeURIComponent(query)}`, {
        headers: apiHeaders(`203.0.113.${sequence++}`),
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_parameter",
      invalid_params: [{ name: "q", reason }],
    });
  }
});

test("a normal 100-Card page uses one page read after revision lookup", async () => {
  await seedApiRevision({
    revisionId: "catrev_page_reads",
    runId: "run_page_reads",
    cards: Array.from({ length: 101 }, (_, index) =>
      apiCard({
        id: `card_page_reads_${String(index).padStart(3, "0")}`,
        cardNumber: `OP29-${String(100 + index)}`,
        name: `Measured Card ${index}`,
      }),
    ),
  });
  const records: string[] = [];
  vi.spyOn(console, "info").mockImplementation((value) => records.push(String(value)));
  const response = await apiWorker.fetch(
    new Request("https://card-keepr.invalid/v1/cards?limit=100", {
      headers: apiHeaders("203.0.113.57"),
    }),
    testEnv,
  );
  expect(response.status).toBe(200);
  const document = await response.json<{ data: unknown[]; page: { next_cursor: string | null } }>();
  expect(document.data).toHaveLength(100);
  expect(document.page.next_cursor).toEqual(expect.any(String));
  const record = JSON.parse(records.at(-1)!);
  expect(record.d1.prepared_statements).toBeLessThanOrEqual(2);
});

test.each(["", "&q=La"])(
  "authenticated Card collection pages remain byte-bounded for large valid records %s",
  async (query) => {
    const cards = Array.from({ length: 18 }, (_, index) =>
      apiCard({
        id: `card_large_page_${String(index).padStart(3, "0")}`,
        cardNumber: `OP29-${String(600 + index)}`,
        name: `Large Card ${String(index).padStart(3, "0")} ${"x".repeat(259_000)}`,
      }),
    );
    await seedApiRevision({
      revisionId: `catrev_large_page_${query === "" ? "all" : "short"}`,
      runId: `run_large_page_${query === "" ? "all" : "short"}`,
      cards,
    });
    const response = await exports.default.fetch(
      new Request(`https://card-keepr.invalid/v1/cards?limit=100${query}`, {
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
    // Link expansion can exceed the database envelope allowance. Follow every
    // cursor through that fallback and prove no Card is skipped or repeated.
    const mount = `/${"m".repeat(8_000)}`;
    const mountedBase = `https://card-keepr.invalid${mount}`;
    const found: string[] = [];
    let after: string | null = null;
    do {
      const url = new URL(`${mountedBase}/v1/cards?limit=100${query}`);
      if (after !== null) url.searchParams.set("after", after);
      const mounted = await apiWorker.fetch(
        new Request(url, {
          headers: apiHeaders("203.0.113.59"),
        }),
        { ...testEnv, PUBLIC_BASE_URL: mountedBase },
      );
      expect(mounted.status).toBe(200);
      expect((await mounted.clone().arrayBuffer()).byteLength).toBeLessThanOrEqual(4 * 1024 * 1024);
      const page = await mounted.json<{ data: { id: string }[]; page: { next_cursor: string | null } }>();
      if (after === null) expect(page.data.length).toBeLessThan(document.data.length);
      expect(page.data.length).toBeGreaterThan(0);
      found.push(...page.data.map((card) => card.id));
      after = page.page.next_cursor;
    } while (after !== null);
    expect(found).toEqual(cards.map((card) => card.id));
  },
  15_000,
);

test("Card cursors reject route, ordering, and structural misuse", async () => {
  await seedApiRevision({
    revisionId: "catrev_cursor_binding",
    runId: "run_cursor_binding",
    cards: [
      apiCard({
        id: "card_cursor_binding_001",
        cardNumber: "OP29-701",
        name: "Cursor Binding Alpha",
      }),
      apiCard({
        id: "card_cursor_binding_002",
        cardNumber: "OP29-702",
        name: "Cursor Binding Beta",
      }),
    ],
  });
  const cursors = [
    encodeTestCardCursor({
      revisionId: "catrev_cursor_binding",
      route: "/v1/printings",
      order: "game,official_identity.kind,official_identity.value,id",
      q: "cursor binding",
      limit: 1,
      after: {
        game: "one-piece",
        identityKind: "card_number",
        identityValue: "OP29-701",
        id: "card_cursor_binding_001",
      },
    }),
    encodeTestCardCursor({
      revisionId: "catrev_cursor_binding",
      route: "/v1/cards",
      order: "name,id",
      q: "cursor binding",
      limit: 1,
      after: {
        game: "one-piece",
        identityKind: "card_number",
        identityValue: "OP29-701",
        id: "card_cursor_binding_001",
      },
    }),
    encodeTestCardCursor({
      revisionId: "",
      route: "/v1/cards",
      order: "game,official_identity.kind,official_identity.value,id",
      q: "cursor binding",
      limit: 1,
      after: {
        game: "one-piece",
        identityKind: "card_number",
        identityValue: "OP29-701",
        id: "card_cursor_binding_001",
      },
    }),
    encodeTestCardCursor({
      revisionId: "catrev_cursor_binding",
      route: "/v1/cards",
      order: "game,official_identity.kind,official_identity.value,id",
      q: "cursor binding",
      limit: 1,
      after: {
        game: "one-piece",
        identityKind: "card_number",
        identityValue: "OP29-701",
        id: "",
      },
    }),
  ];
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(apiSchema);
  const validateProblem = ajv.getSchema(`${apiSchema.$id}#/$defs/Problem`)!;

  for (const [index, cursor] of cursors.entries()) {
    const response = await exports.default.fetch(
      new Request(
        `https://card-keepr.invalid/v1/cards?q=cursor%20binding&limit=1&after=${encodeURIComponent(cursor)}`,
        { headers: apiHeaders(`203.0.113.${90 + index}`) },
      ),
    );
    expect(response.status).toBe(400);
    const problem = await response.json();
    expect(validateProblem(problem), JSON.stringify(validateProblem.errors)).toBe(true);
    expect(problem).toMatchObject({
      code: "invalid_cursor",
    });
  }
});

test("Card search uses a revision-scoped D1 FTS5 index", async () => {
  const virtualTables = await publishedCatalogueQueries
    .readSqliteSchemaName(testEnv.CATALOGUE_DB)
    .all<{ name: string }>();
  expect(virtualTables.results).toEqual([{ name: "revision_card_search_fts" }]);

  await seedApiRevision({
    revisionId: "catrev_fts_search_old",
    runId: "run_fts_search_old",
    cards: [
      apiCard({
        id: "card_fts_search_old",
        cardNumber: "OP29-700",
        name: "Quartz Vanguard",
      }),
    ],
  });
  await seedApiRevision({
    revisionId: "catrev_fts_search",
    runId: "run_fts_search",
    cards: [
      apiCard({
        id: "card_fts_search",
        cardNumber: "OP29-702",
        name: "Quartz Vanguard",
        effectiveRulesText: 'Say "Quartz" now.',
      }),
    ],
  });
  const productionQuery = inspectCardCollectionQuery(
    testEnv.CATALOGUE_DB,
    "catrev_fts_search",
    { q: "quartz", game: null, cardNumber: null, productId: null, rarity: null, attributes: {}, limit: 50 },
    null,
  );
  const plan = await productionQuery.plan().all<{ detail: string }>();
  const planDetails = plan.results.map(({ detail }) => detail);
  expect(planDetails).toEqual([
    "MATERIALIZE search_matches",
    "SCAN search VIRTUAL TABLE INDEX 0:M6",
    "SEARCH filtered USING INDEX " +
      "sqlite_autoindex_revision_card_query_documents_1 " +
      "(catalogue_revision_id=? AND card_id=?)",
    "USE TEMP B-TREE FOR GROUP BY",
    "USE TEMP B-TREE FOR ORDER BY",
    "SCAN search_matches",
  ]);
  const filteredCursorQuery = inspectCardCollectionQuery(
    testEnv.CATALOGUE_DB,
    "catrev_fts_search",
    {
      q: "quartz",
      game: "one-piece",
      cardNumber: "OP29-702",
      productId: null,
      rarity: null,
      attributes: {},
      limit: 7,
    },
    {
      game: "one-piece",
      identity_kind: "card_number",
      identity_value: "OP29-701",
      id: "card_fts_search_before",
    },
  );
  const materialization = filteredCursorQuery.sql.slice(
    0,
    filteredCursorQuery.sql.indexOf("\n       )\n       SELECT"),
  );
  expect(materialization).toContain("filtered.sort_game = ?");
  expect(materialization).toContain("filtered.sort_identity_value = ?");
  expect(materialization).toContain("(filtered.sort_game, filtered.sort_identity_kind,");
  expect(materialization).toContain("LIMIT ?");
  const filteredPlan = await filteredCursorQuery.plan().all<{ detail: string }>();
  expect(filteredPlan.results.map(({ detail }) => detail)).toEqual([
    "MATERIALIZE search_matches",
    "SCAN search VIRTUAL TABLE INDEX 0:M6",
    "SEARCH filtered USING INDEX " +
      "sqlite_autoindex_revision_card_query_documents_1 " +
      "(catalogue_revision_id=? AND card_id=?)",
    "USE TEMP B-TREE FOR GROUP BY",
    "USE TEMP B-TREE FOR ORDER BY",
    "SCAN search_matches",
  ]);
  const filteredRows = await filteredCursorQuery.rows().all<{ summary_json: string }>();
  expect(filteredRows.results.map(({ summary_json }) => JSON.parse(summary_json).id)).toEqual(["card_fts_search"]);
  const matchedRevisions = await cardSearchQueries
    .readRevisionCardSearchFts(testEnv.CATALOGUE_DB)
    .bind(productionQuery.bindings[0])
    .all<{
      catalogue_revision_id: string;
    }>();
  expect(matchedRevisions.results).toEqual([{ catalogue_revision_id: "catrev_fts_search" }]);
  await cardSearchQueries.dropObsoleteCardSearchTerms(testEnv.CATALOGUE_DB).run();

  const response = await exports.default.fetch(
    new Request("https://card-keepr.invalid/v1/cards?q=quartz", { headers: apiHeaders("203.0.113.100") }),
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    data: [{ id: "card_fts_search" }],
  });
  const quoted = await exports.default.fetch(
    new Request("https://card-keepr.invalid/v1/cards?q=%22quartz%22", { headers: apiHeaders("203.0.113.103") }),
  );
  expect(quoted.status).toBe(200);
  await expect(quoted.json()).resolves.toMatchObject({
    data: [{ id: "card_fts_search" }],
  });
});

test("Card search FTS is reconstructible across the D1 export and restore boundary", async () => {
  await seedApiRevision({
    revisionId: "catrev_fts_restore",
    runId: "run_fts_restore",
    cards: [
      apiCard({
        id: "card_fts_restore",
        cardNumber: "OP29-704",
        name: "Reconstructible Quartz",
      }),
    ],
  });
  const retainedChunks = await cardSearchQueries
    .readRevisionCardSearchChunksCatalogueRevisionIdCardId(testEnv.CATALOGUE_DB)
    .bind("catrev_fts_restore")
    .all();
  expect(retainedChunks.results.length).toBeGreaterThan(0);

  await withCardSearchPreparedForD1Export(
    catalogueStore(testEnv.CATALOGUE_DB),
    {
      ownerToken: "backup-owner-primary",
      observedAt: "2026-08-05T00:00:00.000Z",
      leaseExpiresAt: "2026-08-05T00:15:00.000Z",
    },
    async () => {
      const exportBoundary = await cardSearchQueries
        .readCardSearchFtsState(testEnv.CATALOGUE_DB)
        .bind("catrev_fts_restore")
        .first();
      expect(exportBoundary).toEqual({
        state: "reconstructing",
        virtual_tables: 0,
        retained_chunks: retainedChunks.results.length,
      });
      await expect(
        prepareCardSearchForD1Export(catalogueStore(testEnv.CATALOGUE_DB), {
          ownerToken: "backup-owner-concurrent",
          observedAt: "2026-08-05T00:01:00.000Z",
          leaseExpiresAt: "2026-08-05T00:16:00.000Z",
        }),
      ).rejects.toThrow("Card search FTS export lease is unavailable.");
      await expect(
        reconstructCardSearchAfterD1Restore(catalogueStore(testEnv.CATALOGUE_DB), "backup-owner-concurrent"),
      ).rejects.toThrow("Card search FTS export lease owner changed.");
      const unavailable = await exports.default.fetch(
        new Request("https://card-keepr.invalid/v1/cards?q=quartz", { headers: apiHeaders("203.0.113.105") }),
      );
      expect(unavailable.status).toBe(503);
    },
  );

  const reconstructed = await cardSearchQueries
    .readCardSearchFtsStateForCardSearchFTSReconstructibleAcrossD1ExportRestoreBoundary(testEnv.CATALOGUE_DB)
    .bind("catrev_fts_restore")
    .first();
  expect(reconstructed).toEqual({
    state: "ready",
    indexed_chunks: retainedChunks.results.length,
    maintenance_triggers: 0,
  });
  const restored = await exports.default.fetch(
    new Request("https://card-keepr.invalid/v1/cards?q=quartz", { headers: apiHeaders("203.0.113.106") }),
  );
  expect(restored.status).toBe(200);
  await expect(restored.json()).resolves.toMatchObject({
    data: [{ id: "card_fts_restore" }],
  });
  await publishCardSearchChunksStatement(catalogueStore(testEnv.CATALOGUE_DB), {
    revisionId: "catrev_fts_restore",
    chunksJson: JSON.stringify([
      { card_id: "card_fts_restore", field_ordinal: 1, chunk_ordinal: 1, search_text: "materialized-restored-quartz" },
    ]),
  }).run();
  const materialized = await exports.default.fetch(
    new Request("https://card-keepr.invalid/v1/cards?q=materialized-restored-quartz", {
      headers: apiHeaders("203.0.113.107"),
    }),
  );
  expect(materialized.status).toBe(200);
  await expect(materialized.json()).resolves.toMatchObject({
    data: [{ id: "card_fts_restore" }],
  });
  await expect(
    withCardSearchPreparedForD1Export(
      catalogueStore(testEnv.CATALOGUE_DB),
      {
        ownerToken: "backup-owner-failure",
        observedAt: "2026-08-05T01:00:00.000Z",
        leaseExpiresAt: "2026-08-05T01:15:00.000Z",
      },
      async () => {
        throw new Error("simulated D1 export failure");
      },
    ),
  ).rejects.toThrow("simulated D1 export failure");
  await expect(cardSearchQueries.readCardSearchFtsStateState(testEnv.CATALOGUE_DB).first()).resolves.toEqual({
    state: "ready",
  });
  await cardSearchQueries
    .setCardSearchFtsStateStateOwnerToken(testEnv.CATALOGUE_DB)
    .bind("backup-owner-abandoned", "2026-08-05T02:00:00.000Z")
    .run();
  await withCardSearchPreparedForD1Export(
    catalogueStore(testEnv.CATALOGUE_DB),
    {
      ownerToken: "backup-owner-takeover",
      observedAt: "2026-08-05T02:01:00.000Z",
      leaseExpiresAt: "2026-08-05T02:16:00.000Z",
    },
    async () => undefined,
  );
  await expect(cardSearchQueries.readCardSearchFtsStateStateOwnerToken(testEnv.CATALOGUE_DB).first()).resolves.toEqual({
    state: "ready",
    owner_token: null,
  });
}, 15_000);

test("Card detail includes revision-pinned Printings, provenance, and disagreements", async () => {
  const card = apiCard({
    id: "card_detail_projection",
    cardNumber: "OP29-703",
    name: "Conflicted Vanguard",
  });
  card.effective_rules_text = null;
  card.printing_ids = ["printing_detail_projection"];
  await seedApiRevision({
    revisionId: "catrev_detail_projection",
    runId: "run_detail_projection",
    cards: [card],
  });
  const evidence = {
    type: "source_observation",
    id: "srcobs_detail_projection",
    captured_at: "2026-07-20T00:00:00.000Z",
    source: "one-piece-en",
  };
  const otherEvidence = {
    ...evidence,
    id: "srcobs_detail_other",
  };
  const printing = {
    type: "printing",
    id: "printing_detail_projection",
    card_id: card.id,
    rarity: { normalized: "leader", raw: "L" },
    printed_rules_text: "Printed text",
    game_data: {
      profile: "one-piece@1",
      attributes: { illustration_types: [] },
    },
    printing_images: [],
    distribution_contexts: [],
    relationship_evidence: [],
    locator_evidence: { current: [], historical: [] },
    lifecycle: card.lifecycle,
    links: { self: "/v1/printings/printing_detail_projection" },
  };
  await catalogueStore(testEnv.CATALOGUE_DB).batch([
    publishedCatalogueQueries
      .setRevisionCardsDocumentJsonForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
        testEnv.CATALOGUE_DB,
      )
      .bind(
        JSON.stringify({
          data: card,
          included: [evidence, otherEvidence],
          provenance: {
            "/data/effective_rules_text": [evidence.id],
          },
          disagreements: [
            {
              path: "/data/effective_rules_text",
              status: "unresolved",
              candidates: [
                { value: "Candidate A", observation_id: evidence.id },
                { value: "Candidate B", observation_id: otherEvidence.id },
              ],
            },
          ],
        }),
        "catrev_detail_projection",
        card.id,
      ),
    publishedCatalogueQueries
      .insertRevisionPrintingsForPublicPrintingResponseValidatesFullDistributionContextObjects(testEnv.CATALOGUE_DB)
      .bind("catrev_detail_projection", printing.id, card.id, JSON.stringify(printing)),
  ]);

  const url =
    "https://card-keepr.invalid/v1/cards/card_detail_projection" + "?include=printings,evidence,disagreements";
  const response = await exports.default.fetch(
    new Request(url, {
      headers: apiHeaders("203.0.113.101"),
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("x-catalogue-revision")).toBe("catrev_detail_projection");
  const body = await response.json<Record<string, unknown>>();
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(apiSchema);
  const validate = ajv.getSchema(`${apiSchema.$id}#/$defs/CardDocument`)!;
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  expect(body).toMatchObject({
    data: { effective_rules_text: null },
    included: [
      { id: printing.id, type: "printing" },
      { id: evidence.id, type: "source_observation" },
      { id: otherEvidence.id, type: "source_observation" },
    ],
    provenance: {
      "/data/effective_rules_text": [evidence.id],
    },
    disagreements: [
      {
        path: "/data/effective_rules_text",
        status: "unresolved",
      },
    ],
    meta: { catalogue_revision_id: "catrev_detail_projection" },
  });
  expect((body.data as Record<string, unknown>).effective_rules_text).toBeNull();
  const includedIds = new Set((body.included as Array<{ id: string }>).map(({ id }) => id));
  for (const [pointer, observationIds] of Object.entries(body.provenance as Record<string, string[]>)) {
    const pointedValue = jsonPointerValue(body, pointer);
    expect(pointedValue).toBeDefined();
    expect(observationIds.every((id) => includedIds.has(id))).toBe(true);
  }
  for (const disagreement of body.disagreements as Array<{
    path: string;
    status: string;
  }>) {
    if (disagreement.status !== "unresolved") continue;
    expect(jsonPointerValue(body, disagreement.path)).toBeNull();
  }

  const etag = response.headers.get("etag");
  expect(etag).not.toBeNull();
  const notModified = await exports.default.fetch(
    new Request(url, {
      headers: {
        ...apiHeaders("203.0.113.102"),
        "if-none-match": etag!,
      },
    }),
  );
  expect(notModified.status).toBe(304);
  expect(notModified.headers.get("x-catalogue-revision")).toBe("catrev_detail_projection");
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
    new Request("https://card-keepr.invalid/v1/cards?q=cursor&limit=1", { headers: apiHeaders("203.0.113.31") }),
  );
  expect(firstPage.status).toBe(200);
  expect(firstPage.headers.get("x-catalogue-revision")).toBe("catrev_cursor_old");
  const firstPageDocument = await firstPage.json<
    Record<string, unknown> & {
      page: { next_cursor: string };
    }
  >();
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(apiSchema);
  const validateCollection = ajv.getSchema(`${apiSchema.$id}#/$defs/CardCollection`)!;
  const validateProblem = ajv.getSchema(`${apiSchema.$id}#/$defs/Problem`)!;
  expect(validateCollection(firstPageDocument), JSON.stringify(validateCollection.errors)).toBe(true);
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
  expect(available.headers.get("x-catalogue-revision")).toBe("catrev_cursor_old");
  await expect(available.json()).resolves.toMatchObject({
    data: [{ id: "card_cursor_002" }],
    meta: { catalogue_revision_id: "catrev_cursor_old" },
  });

  await catalogueExportQueries
    .insertCatalogueExportsForCardCursorsContinueOnAvailablePinnedRevisionConflictOnly(testEnv.CATALOGUE_DB)
    .bind("e".repeat(64))
    .run();
  await catalogueStore(testEnv.CATALOGUE_DB).batch([
    publishedCatalogueQueries.archiveFixtureQueryRevision(testEnv.CATALOGUE_DB, "catrev_cursor_old"),
    publishedCatalogueQueries.deleteRevisionCardQueryDocuments(testEnv.CATALOGUE_DB),
  ]);
  await expect(catalogueExportQueries.readCatalogueRevisions(testEnv.CATALOGUE_DB).first()).resolves.toMatchObject({
    revision_retained: 1,
    export_retained: 1,
  });
  const unavailable = await exports.default.fetch(
    new Request(pinnedUrl, {
      headers: apiHeaders("203.0.113.33"),
    }),
  );
  expect(unavailable.status).toBe(409);
  const problem = await unavailable.json();
  expect(validateProblem(problem), JSON.stringify(validateProblem.errors)).toBe(true);
  expect(problem).toMatchObject({
    code: "cursor_revision_unavailable",
    links: { collection: `${apiPublicBase}/v1/cards` },
  });
});

test("the normative Printing schema excludes SourceBucket from canonical relationship evidence", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(exportManifestSchemaV5);
  ajv.addSchema(apiSchema);
  const validate = ajv.getSchema(`${apiSchema.$id}#/$defs/RelationshipEvidence`);
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
  expect(validate!(relationship), JSON.stringify(validate!.errors)).toBe(true);
  expect(
    validate!({
      ...relationship,
      relationship_kind: "source_bucket",
      relationship_value: "primary-card-list",
    }),
  ).toBe(false);
});

function jsonPointerValue(document: unknown, pointer: string): unknown {
  return pointer
    .slice(1)
    .split("/")
    .reduce<unknown>(
      (value, segment) => (value as Record<string, unknown>)[segment.replaceAll("~1", "/").replaceAll("~0", "~")],
      document,
    );
}

function encodeTestCardCursor(input: {
  revisionId: string;
  route: string;
  order: string;
  q: string | null;
  limit: number;
  after: {
    game: string;
    identityKind: string;
    identityValue: string;
    id: string;
  };
}): string {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      contract: "card-keepr-card-cursor@1",
      revision_id: input.revisionId,
      route: input.route,
      order: input.order,
      filters: {
        q: input.q,
        game: null,
        cardNumber: null,
        productId: null,
        rarity: null,
        attributes: {},
        limit: input.limit,
      },
      after: {
        game: input.after.game,
        identity_kind: input.after.identityKind,
        identity_value: input.after.identityValue,
        id: input.after.id,
      },
    }),
  );
  return btoa(String.fromCharCode(...bytes));
}

async function seedCatalogueExportSummary(revisionId: string, runId: string, publishedAt: string): Promise<void> {
  await seedApiRevision({ revisionId, runId, cards: [] });
  await publishedCatalogueQueries
    .setCatalogueRevisionsPublishedAt(testEnv.CATALOGUE_DB)
    .bind(publishedAt, revisionId)
    .run();
  await publishedCatalogueQueries
    .setCatalogueStatePublishedAt(testEnv.CATALOGUE_DB)
    .bind(publishedAt, revisionId)
    .run();
  const manifestWithPlaceholder = {
    export_schema_major: 5,
    catalogue_revision: {
      id: revisionId,
      content_sha256: "b".repeat(64),
    },
    manifest_sha256: "0".repeat(64),
    components: [],
  };
  const manifestDigest = await sha256Text(`${canonicalJson(manifestWithPlaceholder)}\n`);
  const manifest = {
    ...manifestWithPlaceholder,
    manifest_sha256: manifestDigest,
  };
  const manifestKey = `catalogue-exports/${revisionId}/manifest.json`;
  await testEnv.CATALOGUE_EXPORTS.put(manifestKey, `${canonicalJson(manifest)}\n`);
  await catalogueExportQueries
    .insertCatalogueExports(testEnv.CATALOGUE_DB)
    .bind(revisionId, manifestKey, manifestDigest)
    .run();
}

function proxyR2Bucket(
  bucket: R2Bucket,
  overrides: {
    get?: (...arguments_: Parameters<R2Bucket["get"]>) => ReturnType<R2Bucket["get"]>;
  },
): R2Bucket {
  return new Proxy(bucket, {
    get(target, property) {
      const override = property === "get" ? overrides.get : undefined;
      if (override !== undefined) return override;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
