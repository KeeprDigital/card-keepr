import { env, exports } from "cloudflare:workers";
import {
  applyD1Migrations,
  type D1Migration,
} from "cloudflare:test";
import { beforeEach, expect, test, vi } from "vitest";
import {
  captureOperationIdentity,
  capturePreparedAttempt,
  prepareCaptureAttempt,
} from "../../../src/catalogue/source-evidence-capture";
import {
  installedSourceAdapterRegistrations,
  requiredSourceAdapter,
  sourceAdapterRegistrations,
} from "../../../src/catalogue/source-adapters";
import {
  appendDiscoveredEvidenceRequests,
  pendingEvidenceRequestPage,
  pendingEvidenceRequests,
  requiredEvidenceRun,
  startEvidenceRun,
} from "../../../src/catalogue/source-evidence-repository";
import { officialSourceDiscoveryRequests } from "../../../src/catalogue/product-release-source-adapters";
import {
  officialCollectionRequestsFromDiscovery,
} from "../../../src/catalogue/source-evidence-model";
import { canonicalJson, sha256, utf8 } from "../../../src/catalogue/serialization";
import {
  validateGundamListingCollectionGraph,
} from "../../../src/catalogue/reconciliation-evidence";
import { injectFixtureEvidencePlan } from "./fixture-plan-injection";
import {
  fusionWorldProductionCollectionRequests,
} from "./production-collection-request-goldens";
import {
  productionRepresentableFusionLegalityResponse,
  productionSourceFixtureMarker,
  productionSourceFixtureRole,
  productionSourceFixtureSurface,
} from "./production-source-fixture-routing";

declare global {
  interface __BaseEnv_Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}

beforeEach(async () => {
  await applyD1Migrations(
    env.CATALOGUE_DB,
    env.TEST_MIGRATIONS,
  );
  // Workflow instances outlive a Vitest request isolate. Reset only the
  // singleton lock so each test begins with an independent administration
  // scenario; production never performs this test-only setup.
  await env.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET active_ingestion_run_id = NULL WHERE singleton = 1",
  ).run();
});

test("the administration authentication boundary runs in the Workers runtime", async () => {
  const response = await exports.default.fetch(
    new Request("https://card-keepr.invalid/health", {
      headers: { authorization: "Bearer vitest-administration-key" },
    }),
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    contract: "card-keepr-runtime-health@1",
    runtime: "ingestion",
    status: "ok",
  });
});

test("evidence run diagnostics retain safe adapter, workflow, coverage, and retry references", async () => {
  const records: string[] = [];
  vi.spyOn(console, "info").mockImplementation((value) => {
    records.push(String(value));
  });
  const response = await administrationRequest(
    "/v1/ingestion-runs/evidence",
    "POST",
    {
      supported_game: "one-piece",
      source_lineage: "one-piece-en",
      adapter_version: "one-piece-en@3",
      idempotency_key: "diagnostic-evidence-run",
      requests: officialSourceDiscoveryRequests("one-piece-en"),
    },
  );
  expect(response.status).toBe(201);
  const run = await response.json<Record<string, unknown>>();
  const requestLog = JSON.parse(records.at(-1) ?? "null") as {
    request: { id: string };
  };
  expect(run).toMatchObject({
    operational_diagnostics: {
      contract: "card-keepr-operational-diagnostics@1",
      references: {
        request_id: requestLog.request.id,
        adapter_versions: ["one-piece-en@3"],
        workflow: {
          parent_id: null,
          child_ids: [],
        },
        recovery: { status_path: "/v1/status" },
      },
      terminal_evidence: {
        failure: null,
        coverage: {
          evidence_plan_count: 1,
          source_snapshot_count: 0,
          source_observation_set_count: 0,
          fetch_attempt_count: 0,
        },
      },
      retry: null,
    },
  });
  const bundle = JSON.stringify(run.operational_diagnostics);
  expect(bundle).not.toContain("diagnostic-evidence-run");
  expect(bundle).not.toContain("authorization");
  expect(bundle).not.toContain("fixture-official-source");
});

test("terminal evidence diagnostics expose collection retry guidance without a stale candidate path", async () => {
  const records: string[] = [];
  vi.spyOn(console, "info").mockImplementation((value) => {
    records.push(String(value));
  });
  const created = await administrationRequest(
    "/v1/ingestion-runs/evidence",
    "POST",
    {
      supported_game: "one-piece",
      source_lineage: "one-piece-en",
      adapter_version: "one-piece-en@3",
      idempotency_key: "terminal-evidence-diagnostics",
      requests: officialSourceDiscoveryRequests("one-piece-en"),
    },
  );
  const run = await created.json<{ id: string }>();
  await env.CATALOGUE_DB.prepare(
    `UPDATE ingestion_runs
     SET state = 'failed', terminal_at = ?,
         failure_code = 'source_request_retries_exhausted'
     WHERE id = ?`,
  ).bind("2026-08-05T00:00:00.000Z", run.id).run();
  const shown = await administrationRequest(
    `/v1/ingestion-runs/${run.id}`,
    "GET",
  );
  expect(shown.status).toBe(200);
  const document = await shown.json<Record<string, unknown>>();
  expect(document).toMatchObject({
    operational_diagnostics: {
      retry: {
        code: "evidence_collection_retry_available",
        source_run_id: run.id,
        method: "POST",
        path: `/v1/ingestion-runs/${run.id}/collection/retry`,
      },
      diagnosis_sequence: [
        { code: "check_status", method: "GET", path: "/v1/status" },
        {
          code: "inspect_run",
          method: "GET",
          path: `/v1/ingestion-runs/${run.id}`,
        },
        {
          code: "retry_evidence_collection",
          method: "POST",
          path: `/v1/ingestion-runs/${run.id}/collection/retry`,
        },
      ],
    },
  });
  expect(JSON.stringify(document.operational_diagnostics)).not.toContain(
    `/v1/ingestion-runs/${run.id}/candidate`,
  );
  await env.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET active_ingestion_run_id = NULL WHERE singleton = 1",
  ).run();
  const retried = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/retry`,
    "POST",
    { idempotency_key: "terminal-evidence-diagnostics-retry" },
  );
  expect(retried.status).toBe(201);
  const retryDocument = await retried.json<Record<string, unknown>>();
  const retryLog = records.map((record) => JSON.parse(record)).reverse().find(
    (record: { request?: { route?: string; id?: string } }) =>
      record.request?.route ===
      "/v1/ingestion-runs/:ref/collection/retry",
  );
  expect(retryDocument).toMatchObject({
    linked_run_id: run.id,
    operational_diagnostics: {
      references: { request_id: retryLog.request.id },
    },
  });
  expect(JSON.stringify(retryDocument.operational_diagnostics)).not.toContain(
    "terminal-evidence-diagnostics-retry",
  );
});

test("published evidence diagnostics explicitly advertise no retry route", async () => {
  const created = await administrationRequest(
    "/v1/ingestion-runs/evidence",
    "POST",
    {
      supported_game: "one-piece",
      source_lineage: "one-piece-en",
      adapter_version: "one-piece-en@3",
      idempotency_key: "published-evidence-diagnostics",
      requests: officialSourceDiscoveryRequests("one-piece-en"),
    },
  );
  const source = await created.json<{ id: string }>();
  const run = { id: "run_published_evidence_diagnostics" };
  await env.CATALOGUE_DB.batch([
    env.CATALOGUE_DB.prepare(
      "UPDATE operation_state SET active_ingestion_run_id = NULL WHERE singleton = 1",
    ),
    env.CATALOGUE_DB.prepare(
      `INSERT INTO ingestion_runs (
         id, state, selected_games_json, started_at,
         expected_current_revision_id, linked_run_id, idempotency_key,
         operational_request_id, terminal_at, candidate_json
       ) VALUES (
         ?, 'published', '["one-piece"]', ?, 'catrev_spine_000', NULL, ?,
         ?, ?, '{}'
       )`,
    ).bind(
      run.id,
      "2026-08-05T00:00:00.000Z",
      "published-evidence-diagnostics-row",
      "published-evidence-request",
      "2026-08-05T00:00:00.000Z",
    ),
    env.CATALOGUE_DB.prepare(
      `INSERT INTO ingestion_evidence_plans (
         ingestion_run_id, source_lineage, supported_game,
         game_profile_version, adapter_version, request_plan_json,
         plan_origin
       )
       SELECT ?, source_lineage, supported_game, game_profile_version,
              adapter_version, request_plan_json, plan_origin
       FROM ingestion_evidence_plans WHERE ingestion_run_id = ?`,
    ).bind(run.id, source.id),
  ]);
  const shown = await administrationRequest(
    `/v1/ingestion-runs/${run.id}`,
    "GET",
  );
  expect(shown.status).toBe(200);
  const document = await shown.json<Record<string, unknown>>();
  expect(document).toMatchObject({
    operational_diagnostics: {
      retry_available: false,
      retry: null,
    },
  });
  const diagnostics = JSON.stringify(document.operational_diagnostics);
  expect(diagnostics).not.toContain("/collection/retry");
  expect(diagnostics).not.toContain(`/v1/ingestion-runs/${run.id}/retry`);
});

test("production source fixture selection is invariant under retries and reordering", () => {
  const discoveryHeaders = new Headers({
    accept: "text/html",
  });
  const surfaceHeaders = new Headers({
    accept: "text/html",
    "user-agent": "card-keepr-official-source/1; request-role=surface",
  });
  expect([
    surfaceHeaders,
    discoveryHeaders,
    discoveryHeaders,
    surfaceHeaders,
  ].map(productionSourceFixtureRole)).toEqual([
    "surface",
    "retained-discovery",
    "retained-discovery",
    "surface",
  ]);
  expect(productionSourceFixtureMarker(new Headers({
    "user-agent":
      "card-keepr-representable-legality-v3; request-role=listing",
  }))).toBe("card-keepr-representable-legality-v3");
  const products = new Headers({
    "user-agent":
      "card-keepr-products-v3; request-role=surface; request-surface=products",
  });
  const releases = new Headers({
    "user-agent":
      "card-keepr-products-v3; request-role=surface; request-surface=releases",
  });
  expect([releases, products, releases, products].map(
    productionSourceFixtureSurface,
  )).toEqual(["releases", "products", "releases", "products"]);
  expect(productionSourceFixtureMarker(products)).toBe(
    "card-keepr-products-v3",
  );
  expect(productionSourceFixtureMarker(new Headers({
    "user-agent":
      "card-keepr-representable-legality-v3; request-role=surface",
  }))).toBe("card-keepr-representable-legality-v3");
});

test("synthetic Bandai-shaped paginated Gundam observations close as one collection graph", async () => {
  const adapter = requiredSourceAdapter("gundam-en-asia@4");
  if (
    adapter.requestUrlForSurface === undefined ||
    adapter.parseBytes === undefined
  ) throw new Error("Gundam live adapter is incomplete.");
  const rootUrl = adapter.requestUrlForSurface("packages");
  const parseBytes = adapter.parseBytes;
  const page = async (
    pageNumber: number,
    terminal: boolean,
    locators: readonly string[],
    declaredTotal = 4,
  ) => {
    const url = pageNumber === 1
      ? `${rootUrl}?package=619102`
      : `${rootUrl}?package=619102&page=${pageNumber}`;
    const pageIdentity = pageNumber === 1
      ? ""
      : `<input type="hidden" name="page" value="${pageNumber}">`;
    const pager = terminal
      ? '<div class="pager"></div>'
      : `<div class="pager"><a href="?package=619102&amp;page=${pageNumber + 1}">${pageNumber + 1}</a></div>`;
    const html = `<html><main><section>
      <input type="hidden" name="package" value="619102">${pageIdentity}
      <div class="resultTxt"><span class="num">${declaredTotal}</span>cards found.</div>
      <ul>${locators.map((locator) =>
        `<li class="cardItem"><a data-src="detail.php?detailSearch=${locator}">Card</a></li>`
      ).join("")}</ul>${pager}</section></main></html>`;
    const requestId =
      `gundam-en-asia:listing:${String(pageNumber).repeat(64)}`;
    return {
      requestId,
      requestUrl: url,
      sourceLineage: "gundam-en-asia",
      adapterVersion: "gundam-en-asia@4",
      observations: await parseBytes(new TextEncoder().encode(html), {
        mediaType: "text/html; charset=UTF-8",
        url,
        requestId,
      }),
    };
  };
  const first = await page(1, false, ["GD02-001", "GD02-002"]);
  const second = await page(2, true, ["GD02-002", "GD02-003", "GD02-004"]);
  expect(validateGundamListingCollectionGraph([first, second])).toEqual({
    completeRequestIds: [first.requestId, second.requestId],
    collections: [{
      sourceLineage: "gundam-en-asia",
      package: "619102",
      declaredTotal: 4,
      terminalPage: 2,
      fullLocators: ["GD02-001", "GD02-002", "GD02-003", "GD02-004"],
    }],
  });
  const third = await page(3, true, ["GD02-002", "GD02-003", "GD02-004"]);
  expect(() => validateGundamListingCollectionGraph([
    first,
    third,
  ])).toThrow(/page continuity/iu);
  const nonterminalSecond = await page(
    2,
    false,
    ["GD02-002", "GD02-003", "GD02-004"],
  );
  expect(() => validateGundamListingCollectionGraph([
    first,
    nonterminalSecond,
  ])).toThrow(/terminal-page proof/iu);
  const inconsistentTotalSecond = await page(
    2,
    true,
    ["GD02-002", "GD02-003", "GD02-004"],
    5,
  );
  expect(() => validateGundamListingCollectionGraph([
    first,
    inconsistentTotalSecond,
  ])).toThrow(/publisher total/iu);
});

test("synthetic production transport captures Gundam pages and reconciles one complete graph", async () => {
  const sourceLineage = "gundam-en-asia";
  const created = await administrationRequest(
    "/v1/ingestion-runs/evidence",
    "POST",
    {
      supported_game: "gundam",
      source_lineage: sourceLineage,
      adapter_version: "gundam-en-asia@4",
      idempotency_key: "gundam-paginated-collection-graph-v4",
      requests: officialSourceDiscoveryRequests(sourceLineage).map(
        (request) => ({
          ...request,
          headers: {
            ...request.headers,
            "user-agent": "card-keepr-gundam-pagination-v4",
          },
        }),
      ),
    },
  );
  expect(created.status).toBe(201);
  const run = await created.json<CollectionDocument>();
  const resumed = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(resumed.status).toBe(202);
  await resumed.body?.cancel();
  const completed = await waitForEvidenceRun(
    run.id,
    "awaiting_approval",
    45_000,
  );
  if (completed.state === "failed") {
    const failures = await env.CATALOGUE_DB.prepare(
      `SELECT request_id, url, failure_code
       FROM source_requests
       WHERE ingestion_run_id = ? AND failure_code IS NOT NULL
       ORDER BY sequence_number`,
    ).bind(run.id).all();
    const terminal = await env.CATALOGUE_DB.prepare(
      `SELECT result_json FROM reconciliation_terminal_results
       WHERE ingestion_run_id = ?`,
    ).bind(run.id).first<{ result_json: string }>();
    throw new Error(JSON.stringify({
      failure_code: completed.failure_code,
      failures: failures.results,
      reconciliation: terminal === null ? null : JSON.parse(terminal.result_json),
    }));
  }
  expect(completed).toMatchObject({
    state: "awaiting_approval",
    failure_code: null,
  });
  const listingRequests = await env.CATALOGUE_DB.prepare(
    `SELECT url
     FROM source_requests
     WHERE ingestion_run_id = ? AND request_role = 'listing'
       AND url LIKE '%package=619102%'
     ORDER BY url`,
  ).bind(run.id).all<{ url: string }>();
  expect(listingRequests.results.map(({ url }) => url)).toEqual([
    "https://www.gundam-gcg.com/asia-en/cards/index.php?package=619102",
    "https://www.gundam-gcg.com/asia-en/cards/index.php?package=619102&page=2",
  ]);
  const discoveredHeaders = await env.CATALOGUE_DB.prepare(
    `SELECT request_role, request_headers_json
     FROM source_requests
     WHERE ingestion_run_id = ?
       AND request_role IN ('listing', 'detail', 'image')
       AND (
         url LIKE '%package=619102%'
         OR url LIKE '%detailSearch=GD02-00%'
         OR url LIKE '%/GD02-00%.png'
       )
     ORDER BY sequence_number`,
  ).bind(run.id).all<{
    request_role: "listing" | "detail" | "image";
    request_headers_json: string;
  }>();
  expect(discoveredHeaders.results).toHaveLength(10);
  expect(discoveredHeaders.results.every(({ request_headers_json }) =>
    productionSourceFixtureMarker(
      new Headers(JSON.parse(request_headers_json)),
    ) === "card-keepr-gundam-pagination-v4"
  )).toBe(true);
  const firstPageEvidence = await env.CATALOGUE_DB.prepare(
    `SELECT observation.content_object_key
     FROM source_requests AS request
     JOIN source_snapshots AS snapshot
       ON snapshot.id = request.source_snapshot_id
     JOIN source_observation_sets AS observation
       ON observation.source_snapshot_id = snapshot.id
     WHERE request.ingestion_run_id = ?
       AND request.url = ?`,
  ).bind(
    run.id,
    "https://www.gundam-gcg.com/asia-en/cards/index.php?package=619102",
  ).first<{ content_object_key: string }>();
  const firstPageObject = await env.EVIDENCE_OBJECTS.get(
    firstPageEvidence?.content_object_key ?? "",
  );
  expect(await firstPageObject?.json()).toMatchObject({
    evidence_summary: {
      declared_record_count: 4,
      parsed_record_count: 2,
      required_surfaces_complete: false,
      partitions_complete: false,
      structurally_complete: false,
    },
  });
  const candidate = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/candidate`,
    "GET",
  );
  expect(candidate.status).toBe(200);
  await expect(candidate.json()).resolves.toMatchObject({
    diff: {
      summary: {
        cards_added: 4,
        printings_added: 4,
      },
    },
  });
}, 60_000);

test("synthetic paginated Gundam transport requires its scenario marker", async () => {
  const discoveryUrl = requiredSourceAdapter("gundam-en-asia@4")
    .requestUrlForDiscovery?.();
  if (discoveryUrl === undefined) {
    throw new Error("Gundam discovery URL is unavailable.");
  }
  const listingUrl =
    "https://www.gundam-gcg.com/asia-en/cards/index.php?package=619102";
  const detailUrl =
    "https://www.gundam-gcg.com/asia-en/cards/detail.php?detailSearch=GD02-001";
  const imageUrl =
    "https://www.gundam-gcg.com/jp/images/cards/card/GD02-001.png";
  const activated = await env.OFFICIAL_SOURCE_TRANSPORT.fetch(discoveryUrl, {
    headers: { "user-agent": "card-keepr-gundam-pagination-v4" },
  });
  expect(activated.status).toBe(200);
  await activated.body?.cancel();
  const [unmarked, mismatchedDetail, mismatchedImage] = await Promise.all([
    env.OFFICIAL_SOURCE_TRANSPORT.fetch(listingUrl)
      .then((response) => response.text()),
    env.OFFICIAL_SOURCE_TRANSPORT.fetch(detailUrl, {
      headers: {
        "user-agent": "unrelated-scenario; request-role=detail",
      },
    }).then((response) => response.text()),
    env.OFFICIAL_SOURCE_TRANSPORT.fetch(imageUrl, {
      headers: {
        "user-agent": "unrelated-scenario; request-role=image",
      },
    }),
  ]);
  expect(unmarked).not.toContain('<span class="num">4</span>cards found.');
  expect(mismatchedDetail).not.toContain("Paginated GD02-001");
  expect(mismatchedImage.headers.get("content-type")).not.toBe("image/png");
  const [
    marked,
    markedDetail,
    markedImage,
  ] = await Promise.all([
    env.OFFICIAL_SOURCE_TRANSPORT.fetch(listingUrl, {
      headers: {
        "user-agent":
          "card-keepr-gundam-pagination-v4; request-role=listing",
      },
    }).then((response) => response.text()),
    env.OFFICIAL_SOURCE_TRANSPORT.fetch(detailUrl, {
      headers: {
        "user-agent":
          "card-keepr-gundam-pagination-v4; request-role=detail",
      },
    }).then((response) => response.text()),
    env.OFFICIAL_SOURCE_TRANSPORT.fetch(imageUrl, {
      headers: {
        "user-agent":
          "card-keepr-gundam-pagination-v4; request-role=image",
      },
    }),
  ]);
  expect(marked).toContain('<span class="num">4</span>cards found.');
  expect(markedDetail).toContain("Paginated GD02-001");
  expect(markedImage.headers.get("content-type")).toBe("image/png");
});

test("every pinned aggregate adapter retains its immutable parser contract", () => {
  const pinned = [
    "one-piece-json-document@1",
    "one-piece-json-document@2",
    "fusion-world-en@1",
    "digimon-en@1",
    "gundam-en-asia@1",
    "gundam-en-us@1",
  ];
  for (const adapterVersion of pinned) {
    const adapter = requiredSourceAdapter(adapterVersion);
    expect(adapter, adapterVersion).toBeDefined();
    expect(adapter?.maximumSnapshotBytes, adapterVersion).toBe(1024 * 1024);
    expect(adapter?.parse, adapterVersion).toBeTypeOf("function");
    expect(
      adapter?.parse?.({
        cards: [{ card: adapterVersion }],
        product_surfaces: [{
          product: "must-not-be-added-by-the-pinned-parser",
        }],
      }),
      adapterVersion,
    ).toEqual([{ card: adapterVersion }]);
  }
});

test.each([
  {
    adapter: "one-piece-json-document@1",
    fixture: "fixture-one-piece-json@1",
    game: "one-piece",
    lineage: "one-piece-en",
  },
  {
    adapter: "one-piece-json-document@2",
    fixture: "fixture-one-piece-json@1",
    game: "one-piece",
    lineage: "one-piece-en",
  },
  {
    adapter: "fusion-world-en@1",
    fixture: "fixture-fusion-world-json@1",
    game: "fusion-world",
    lineage: "fusion-world-en",
  },
  {
    adapter: "digimon-en@1",
    fixture: "fixture-digimon-json@1",
    game: "digimon",
    lineage: "digimon-en",
  },
  {
    adapter: "gundam-en-asia@1",
    fixture: "fixture-gundam-en-asia-json@1",
    game: "gundam",
    lineage: "gundam-en-asia",
  },
  {
    adapter: "gundam-en-us@1",
    fixture: "fixture-gundam-en-us-json@1",
    game: "gundam",
    lineage: "gundam-en-us",
  },
])(
  "the authenticated API rejects cross-version reparsing from $fixture to $adapter",
  async ({ adapter, fixture, game, lineage }) => {
    const created = await fixtureEvidenceRequest({
      supported_game: game,
      source_lineage: lineage,
      adapter_version: fixture,
      idempotency_key: `pinned-reparse-source-${adapter}`,
      requests: [{
        id: `source-${adapter}`,
        url: "https://official-source.invalid/cards",
      }],
    });
    expect(created.status).toBe(201);
    const run = await created.json<CollectionDocument>();
    const completed = await resumeCollection(run.id);
    const snapshot = completed.snapshots[0];
    if (snapshot === undefined) throw new Error("retained snapshot missing");

    const response = await administrationRequest(
      `/v1/source-snapshots/${snapshot.id}/observations`,
      "POST",
      {
        adapter_version: adapter,
        idempotency_key: `pinned-reparse-intent-${adapter}`,
      },
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "source_snapshot_adapter_mismatch",
    });
  },
);

test("authenticated reparse requires the exact Digimon snapshot capture version even when versions share URL authority", async () => {
  const current = requiredSourceAdapter("digimon-en@4");
  const historical = requiredSourceAdapter("digimon-en@3");
  const currentDiscoveryUrl = current.requestUrlForDiscovery?.();
  const historicalCardListUrl = historical.requestUrlForSurface?.(
    "card-list",
  );
  if (currentDiscoveryUrl === undefined || historicalCardListUrl === undefined) {
    throw new Error("Digimon versioned URL contracts are unavailable");
  }
  expect(currentDiscoveryUrl).toBe(historicalCardListUrl);
  const superseded = await administrationRequest(
    "/v1/ingestion-runs/evidence",
    "POST",
    {
      supported_game: "digimon",
      source_lineage: "digimon-en",
      adapter_version: "digimon-en@3",
      idempotency_key: "reject-superseded-digimon-v3-source",
      requests: officialSourceDiscoveryRequests("digimon-en"),
    },
  );
  expect(superseded.status).toBe(422);
  await expect(superseded.json()).resolves.toMatchObject({
    code: "adapter_not_supported",
  });
  const created = await administrationRequest(
    "/v1/ingestion-runs/evidence",
    "POST",
    {
      supported_game: "digimon",
      source_lineage: "digimon-en",
      adapter_version: "digimon-en@4",
      idempotency_key: "digimon-exact-capture-version-source",
      requests: officialSourceDiscoveryRequests("digimon-en"),
    },
  );
  expect(created.status).toBe(201);
  const run = await created.json<CollectionDocument>();
  const resumed = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(resumed.status).toBe(202);
  const accepted = await resumed.json<{ workflow: { id: string } }>();
  const parent = await env.EVIDENCE_INGESTION_WORKFLOW.get(
    accepted.workflow.id,
  );
  const completed = await waitForEvidenceCondition(
    run.id,
    (currentRun) => currentRun.snapshots.some(({ request }) =>
      request.url === currentDiscoveryUrl
    ),
    12_000,
  );
  const snapshot = completed.snapshots.find(({ request }) =>
    request.url === currentDiscoveryUrl
  );
  if (snapshot === undefined) throw new Error("retained Digimon snapshot missing");
  try {
    expect(snapshot.adapter_version).toBe("digimon-en@4");

    const mismatched = await administrationRequest(
      `/v1/source-snapshots/${snapshot.id}/observations`,
      "POST",
      {
        adapter_version: "digimon-en@3",
        idempotency_key: "digimon-mismatched-capture-version-reparse",
      },
    );
    expect(mismatched.status).toBe(422);
    await expect(mismatched.json()).resolves.toMatchObject({
      code: "source_snapshot_adapter_mismatch",
    });

    const exact = await administrationRequest(
      `/v1/source-snapshots/${snapshot.id}/observations`,
      "POST",
      {
        adapter_version: "digimon-en@4",
        idempotency_key: "digimon-exact-capture-version-reparse",
      },
    );
    expect(exact.status).toBe(201);
    await expect(exact.json()).resolves.toMatchObject({
      source_snapshot_id: snapshot.id,
      adapter_version: "digimon-en@4",
    });
  } finally {
    await waitForWorkflowStatus(
      accepted.workflow.id,
      () => parent.status(),
      "complete",
      90_000,
    );
    const candidateResponse = await administrationRequest(
      `/v1/ingestion-runs/${run.id}/candidate`,
      "GET",
    );
    expect(candidateResponse.status).toBe(200);
    const candidate = await candidateResponse.json<{
      candidate_digest: string;
    }>();
    const rejected = await administrationRequest(
      `/v1/ingestion-runs/${run.id}/rejection`,
      "POST",
      {
        candidate_digest: candidate.candidate_digest,
        idempotency_key: "digimon-exact-capture-version-cleanup",
      },
    );
    expect(rejected.status).toBe(200);
  }
}, 120_000);

test("each request uses its owning Evidence Plan adapter capture cap", async () => {
  const started = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
    idempotency_key: "source_per_plan_capture_bound_001",
    plans: [
      {
        supported_game: "fusion-world",
        source_lineage: "fusion-world-en",
        adapter_version: "fixture-fusion-world-json@1",
        requests: [{
          id: "large-cap-first-plan",
          method: "GET",
          url: "https://official-source.invalid/cards",
        }],
      },
      {
        supported_game: "one-piece",
        source_lineage: "one-piece-en",
        adapter_version: "fixture-one-piece-json-capped@1",
        requests: [{
          id: "small-cap-second-plan",
          method: "GET",
          url: "https://large-official-source.invalid/large-json",
        }],
      },
    ],
  });
  if (typeof started.id !== "string") throw new Error("run id missing");
  const failed = await resumeCollection(
    started.id,
    15_000,
  );
  expect(failed).toMatchObject({
    state: "failed",
    failure_code: "source_request_retries_exhausted",
  });
  expect(failed.snapshots.some(({ request }) =>
    request.url.endsWith("/large-json")
  )).toBe(false);
});

test("dynamic discovery rejects oversized request identities before Workflow scheduling", async () => {
  const run = await createCollection(
    "source_dynamic_identity_bound_001",
    "https://official-source.invalid/cards",
  );
  const storedRun = await requiredEvidenceRun(env.CATALOGUE_DB, run.id);
  const root = (await pendingEvidenceRequests(env.CATALOGUE_DB, run.id))[0];
  if (root === undefined) throw new Error("pending discovery root missing");
  await expect(appendDiscoveredEvidenceRequests(
    env.CATALOGUE_DB,
    storedRun,
    root,
    [{
      role: "detail",
      url: `https://official-source.invalid/cards/${"x".repeat(2_100)}`,
      headers: { accept: "text/html" },
    }],
  )).rejects.toMatchObject({ code: "source_discovery_failed" });
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM source_discovery_request_plans
     WHERE ingestion_run_id = ?`,
  ).bind(run.id).first("count")).toBe(0);
});

function fusionWorldDiscoveryRecords() {
  return fusionWorldProductionCollectionRequests.map((request) => ({
    id: request.id,
    surface: request.id.slice("fusion-world-en:".length),
    method: "GET" as const,
    url: request.url,
    headers: { accept: "text/html" },
    discovered_from: {
      kind: "publisher_navigation",
      label: request.id,
      url: request.url,
      resolution: "",
    },
  }));
}

test("final Official Source requests keep discovery evidence immutable while exposing a deterministic fixture role", async () => {
  const adapter = requiredSourceAdapter("fusion-world-en@4");
  const records = fusionWorldDiscoveryRecords();
  const requests = await officialCollectionRequestsFromDiscovery(
    adapter,
    records,
    { "user-agent": "card-keepr-representable-legality-v3" },
  );

  expect(records.every(({ headers }) =>
    canonicalJson(headers) === canonicalJson({ accept: "text/html" })
  )).toBe(true);
  expect(requests).toHaveLength(adapter.requiredSurfaces?.length ?? 0);
  expect(requests.map(({ surface, headers }) => ({
    surface,
    headers,
  }))).toEqual(requests.map(({ surface }) => ({
    surface,
    headers: {
      accept: "text/html",
      "user-agent":
        `card-keepr-representable-legality-v3; request-role=surface; request-surface=${surface}`,
    },
  })));
});

test("final Official Source requests canonicalize injected reserved routing metadata", async () => {
  const adapter = requiredSourceAdapter("fusion-world-en@4");
  const requests = await officialCollectionRequestsFromDiscovery(
    adapter,
    fusionWorldDiscoveryRecords(),
    {
      "user-agent":
        "caller-agent; request-surface=releases; request-role=detail; request-surface=products",
    },
  );

  for (const { surface, headers } of requests) {
    expect(headers["user-agent"]).toBe(
      `caller-agent; request-role=surface; request-surface=${surface}`,
    );
  }
});

test("the exact live Fusion final request selects and parses the representable legality fixture", async () => {
  const adapter = requiredSourceAdapter("fusion-world-en@4");
  const requests = await officialCollectionRequestsFromDiscovery(
    adapter,
    fusionWorldDiscoveryRecords(),
    { "user-agent": "card-keepr-representable-legality-v3" },
  );
  const current = requests.find(({ surface }) =>
    surface === "legality-current"
  );
  if (current === undefined) throw new Error("current Legality request missing");
  expect(current.url).toBe(
    "https://www.dbs-cardgame.com/fw/en/news/01_305.html",
  );
  expect(current.headers["user-agent"]).toBe(
    "card-keepr-representable-legality-v3; request-role=surface; request-surface=legality-current",
  );

  const response = productionRepresentableFusionLegalityResponse(
    new Request(current.url, { headers: current.headers }),
  );
  expect(response).not.toBeNull();
  const bytes = new Uint8Array(await response!.arrayBuffer());
  const html = new TextDecoder().decode(bytes);
  expect(html).toContain("fusion-world-card-game-legality-current-data");
  expect(html).toContain('class="restriction-card"');
  const observations = await adapter.parseBytes?.(bytes, {
    mediaType: response!.headers.get("content-type"),
    url: current.url,
    requestId: current.id,
  });
  const legality = observations?.find((observation) =>
    typeof observation === "object" && observation !== null &&
    (observation as Record<string, unknown>).observation_type ===
      "legality_rules"
  ) as Record<string, unknown> | undefined;
  expect(legality?.completeness).toEqual({
    structurally_complete: true,
    required_surfaces_complete: true,
    partitions_complete: true,
    declared_record_count: 1,
    parsed_record_count: 1,
  });
  expect(legality?.legality_rules).toEqual([
    expect.objectContaining({
      id: "fw_production_eligible",
      official_wording:
        "FB01-001 is eligible 'as printed' – publisher–confirmed &#39;literal&#39;.",
      card_numbers: ["FB01-001"],
      effect: { type: "eligible" },
    }),
  ]);

  expect(productionRepresentableFusionLegalityResponse(new Request(
    "https://www.dbs-cardgame.com/fw/en/rules/banned-limited-cards/",
    { headers: current.headers },
  ))).toBeNull();
});

test("final Official Source collection identities enforce the URL byte bound", async () => {
  const adapter = requiredSourceAdapter("fusion-world-en@4");
  const records = fusionWorldDiscoveryRecords();
  const withFirstUrl = (url: string) => records.map((record, index) =>
    index === 0
      ? {
        ...record,
        url,
        discovered_from: { ...record.discovered_from, url },
      }
      : record
  );
  const urlPrefix = "https://www.dbs-cardgame.com/fw/en/cardlist/";
  const boundedUrl = (bytes: number) =>
    `${urlPrefix}${"x".repeat(bytes - utf8(urlPrefix).byteLength)}`;

  await expect(officialCollectionRequestsFromDiscovery(
    adapter,
    withFirstUrl(boundedUrl(2_048)),
  )).resolves.toHaveLength(records.length);
  await expect(officialCollectionRequestsFromDiscovery(
    adapter,
    withFirstUrl(boundedUrl(2_049)),
  )).rejects.toMatchObject({ code: "source_discovery_failed" });
});

test("final Official Source collection identities enforce the merged-header byte bound", async () => {
  const adapter = requiredSourceAdapter("fusion-world-en@4");
  const records = fusionWorldDiscoveryRecords();
  const headerBase = utf8(canonicalJson({
    accept: "text/html",
    "user-agent":
      "card-keepr-official-source/1; request-role=surface; request-surface=legality-current",
    "x-final-bound": "",
  })).byteLength;
  await expect(officialCollectionRequestsFromDiscovery(
    adapter,
    records,
    { "x-final-bound": "x".repeat(2_048 - headerBase) },
  )).resolves.toHaveLength(records.length);
  await expect(officialCollectionRequestsFromDiscovery(
    adapter,
    records,
    { "x-final-bound": "x".repeat(2_049 - headerBase) },
  )).rejects.toMatchObject({ code: "source_discovery_failed" });
});

test("maximum admitted request pages retain a Workflow result safety margin", async () => {
  const run = await createCollection(
    "source_workflow_page_byte_bound_001",
    "https://official-source.invalid/cards",
  );
  const storedRun = await requiredEvidenceRun(env.CATALOGUE_DB, run.id);
  const root = (await pendingEvidenceRequests(env.CATALOGUE_DB, run.id))[0];
  if (root === undefined) throw new Error("pending discovery root missing");
  await appendDiscoveredEvidenceRequests(
    env.CATALOGUE_DB,
    storedRun,
    root,
    Array.from({ length: 99 }, (_, index) => ({
      role: "detail" as const,
      url: `https://official-source.invalid/cards/${String(index).padStart(2, "0")}/${"x".repeat(1_950)}`,
      headers: { "user-agent": "u".repeat(1_900) },
    })),
  );
  const page = await pendingEvidenceRequestPage(
    env.CATALOGUE_DB,
    run.id,
    -1,
    Number.MAX_SAFE_INTEGER,
    100,
  );
  expect(page).toHaveLength(100);
  expect(new TextEncoder().encode(JSON.stringify(page)).byteLength)
    .toBeLessThan(512 * 1024);
});

test("a successful Official Source response is snapshotted before parsing", async () => {
  const created = await fixtureEvidenceRequest(
    {
      supported_game: "one-piece",
      source_lineage: "one-piece-en",
      adapter_version: "fixture-one-piece-json@1",
      idempotency_key: "source_collection_success_001",
      requests: [
        {
          id: "cards",
          url: "https://official-source.invalid/cards",
        },
      ],
    },
  );
  expect(created.status).toBe(201);
  const planned = await created.json<CollectionDocument>();
  expect(planned.state).toBe("collecting");
  const lifecycle = await administrationRequest(
    `/v1/ingestion-runs/${planned.id}`,
    "GET",
  );
  expect(lifecycle.status).toBe(200);
  await expect(lifecycle.json()).resolves.toMatchObject({
    id: planned.id,
    state: "collecting",
    selected_games: ["one-piece"],
  });

  const resumed = await administrationRequest(
    `/v1/ingestion-runs/${planned.id}/collection/resume`,
    "POST",
  );
  expect(resumed.status).toBe(202);
  const accepted = await resumed.json<{
    ingestion_run_id: string;
    workflow: { id: string; status: string };
  }>();
  expect(accepted).toMatchObject({
    ingestion_run_id: planned.id,
    workflow: {
      status: expect.stringMatching(/^(queued|running|waiting|complete)$/),
    },
  });
  const replayedResume = await administrationRequest(
    `/v1/ingestion-runs/${planned.id}/collection/resume`,
    "POST",
  );
  expect(replayedResume.status).toBe(202);
  await expect(replayedResume.json()).resolves.toMatchObject({
    ingestion_run_id: planned.id,
    workflow: { id: accepted.workflow.id },
  });

  const completed = await waitForEvidenceRun(
    planned.id,
    "parsing",
  );

  expect(completed.state).toBe("parsing");
  expect(completed.snapshots).toHaveLength(1);
  const snapshot = completed.snapshots[0];
  if (snapshot === undefined) throw new Error("missing Source Snapshot");
  expect(snapshot).toMatchObject({
    request: {
      method: "GET",
      url: "https://official-source.invalid/cards",
    },
    http: {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        etag: '"cards-v1"',
      },
    },
    adapter_version: "fixture-one-piece-json@1",
    ingestion_run_id: planned.id,
  });
  expect(snapshot.content).toMatchObject({
    byte_length: 60,
  });
  expect(snapshot.content.digest).toMatch(
    /^[a-f0-9]{64}$/,
  );
  expect(snapshot.content.object_key).toMatch(
    /^source-snapshots\/srcsnap_[A-Za-z0-9-]+\.bin$/,
  );

  expect(completed.observation_sets).toHaveLength(1);
  const observationSet = completed.observation_sets[0];
  if (observationSet === undefined) {
    throw new Error("missing Source Observation set");
  }
  expect(observationSet).toMatchObject({
    source_snapshot_id: snapshot.id,
    adapter_version: "fixture-one-piece-json@1",
    observation_count: 1,
  });
  expect(observationSet.content_digest).toMatch(
    /^[a-f0-9]{64}$/,
  );
  expect(observationSet.object_key).toMatch(
    /^source-observations\/srcobsset_[A-Za-z0-9-]+\.json$/,
  );

  const snapshotContent = await administrationRequest(
    `/v1/source-snapshots/${snapshot.id}/content`,
    "GET",
  );
  expect(snapshotContent.status).toBe(200);
  expect(snapshotContent.headers.get("etag")).toBe(
    `"sha256-${snapshot.content.digest}"`,
  );
  await expect(snapshotContent.text()).resolves.toBe(
    '{"cards":[{"card_number":"OP01-001","name":"Roronoa Zoro"}]}',
  );

  const observationContent = await administrationRequest(
    `/v1/source-observation-sets/${observationSet.id}/content`,
    "GET",
  );
  expect(observationContent.status).toBe(200);
  const observationDocument = await observationContent.json<{
    source_snapshot_id: string;
    adapter_version: string;
    observations: unknown[];
  }>();
  expect(observationDocument).toMatchObject({
    source_snapshot_id: snapshot.id,
    adapter_version: "fixture-one-piece-json@1",
  });
  expect(observationDocument.observations).toHaveLength(1);

  const shown = await administrationRequest(
    `/v1/ingestion-runs/${planned.id}/evidence`,
    "GET",
  );
  expect(shown.status).toBe(200);
  await expect(shown.json()).resolves.toEqual(completed);
});

test("the authenticated parent Workflow reconciles a complete production Evidence Plan after its collection barrier", async () => {
  const created = await administrationRequest(
    "/v1/ingestion-runs/evidence",
    "POST",
    {
      supported_game: "fusion-world",
      source_lineage: "fusion-world-en",
      adapter_version: "fusion-world-en@4",
      idempotency_key: "source_parent_auto_reconcile_001",
      requests: officialSourceDiscoveryRequests("fusion-world-en"),
    },
  );
  expect(created.status).toBe(201);
  const run = await created.json<CollectionDocument>();
  const resumed = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(resumed.status).toBe(202);
  const accepted = await resumed.json<{
    workflow: { id: string };
  }>();
  await waitForWorkflowStatus(
    accepted.workflow.id,
    async () =>
      (await env.EVIDENCE_INGESTION_WORKFLOW.get(accepted.workflow.id))
        .status(),
    "complete",
    12_000,
  );
  const completed = await showCollection(run.id);
  if (completed.state === "failed") {
    const failures = await env.CATALOGUE_DB.prepare(
      `SELECT request_id, failure_code FROM source_requests
       WHERE ingestion_run_id = ? AND failure_code IS NOT NULL
       ORDER BY sequence_number`,
    ).bind(run.id).all();
    throw new Error(JSON.stringify({
      failure_code: completed.failure_code,
      source_failures: failures.results,
    }));
  }
  expect(completed).toMatchObject({
    id: run.id,
    state: "awaiting_approval",
    failure_code: null,
  });
  expect(completed.snapshots.length).toBeGreaterThan(0);
  expect(completed.observation_sets.length).toBeGreaterThan(0);
  expect(completed.official_source_collection_plans).toMatchObject([{
    source_lineage: "fusion-world-en",
    contract: "card-keepr-official-source-collection-plan@1",
    discovery_observation_set_id: expect.stringMatching(/^srcobsset_/u),
    content_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    plan: {
      source_lineage: "fusion-world-en",
      requests: fusionWorldProductionCollectionRequests.map((request) => ({
        ...request,
        surface: request.id.slice("fusion-world-en:".length),
      })),
    },
  }]);
  const discoveryPlan = completed.official_source_collection_plans[0];
  const discoveryObservation = completed.observation_sets.find(
    ({ id }) => id === discoveryPlan?.discovery_observation_set_id,
  );
  expect(discoveryObservation).toBeDefined();
  const retainedObservation = await administrationRequest(
    `/v1/source-observation-sets/${discoveryObservation!.id}/content`,
    "GET",
  );
  expect(retainedObservation.status).toBe(200);
  await expect(retainedObservation.json()).resolves.toMatchObject({
    source_snapshot_id: discoveryObservation!.source_snapshot_id,
    adapter_version: "fusion-world-en@4",
    observations: [{
      value: {
        observation_type: "official_surface_evidence",
        source_lineage: "fusion-world-en",
        surface: "discovery",
        records: ([
          ["cards", "/fw/en/cardlist/"],
          ["products", "/fw/en/products/"],
          ["rules", "/fw/en/news/01_31.html"],
        ] as const).map(([key, resolution]) => ({
          id: `fusion-world-en:discovery-seed:${key}`,
          surface: `@seed:${key}`,
          method: "GET",
          url: new URL(
            resolution,
            "https://www.dbs-cardgame.com/fw/en/cardlist/",
          ).href,
          headers: { accept: "text/html" },
          discovered_from: {
            kind: "publisher_navigation",
            label: key === "products" ? "all products" : key,
            url: "https://www.dbs-cardgame.com/fw/en/cardlist/",
            resolution,
          },
        })),
        completeness: {
          declared_record_count: 3,
          parsed_record_count: 3,
          required_surfaces_complete: true,
          partitions_complete: true,
          structurally_complete: true,
        },
      },
    }],
  });
}, 15_000);

test("incomplete retained production discovery blocks collection and publication", async () => {
  const marker = "card-keepr-incomplete-discovery-v3";
  const created = await administrationRequest(
    "/v1/ingestion-runs/evidence",
    "POST",
    {
      supported_game: "fusion-world",
      source_lineage: "fusion-world-en",
      adapter_version: "fusion-world-en@4",
      idempotency_key: "source_parent_incomplete_discovery_001",
      requests: officialSourceDiscoveryRequests("fusion-world-en").map(
        (request) => ({
          ...request,
          headers: { ...request.headers, "user-agent": marker },
        }),
      ),
    },
  );
  expect(created.status).toBe(201);
  const run = await created.json<CollectionDocument>();
  const terminal = await resumeCollection(run.id, 12_000);
  expect(terminal).toMatchObject({
    state: "failed",
    failure_code: "source_parse_failed",
  });
  expect(terminal.snapshots).toHaveLength(1);
  expect(terminal.observation_sets).toEqual([]);
  expect(terminal.official_source_collection_plans).toEqual([]);
  expect(terminal.workflow.child_ids).toHaveLength(1);
  const candidate = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/candidate`,
    "GET",
  );
  expect(candidate.status).toBe(409);
}, 15_000);

test("notice-link-only production legality evidence fails closed before stale rules can carry forward", async () => {
  const marker = "card-keepr-notice-link-only-legality-v3";
  const created = await administrationRequest(
    "/v1/ingestion-runs/evidence",
    "POST",
    {
      supported_game: "fusion-world",
      source_lineage: "fusion-world-en",
      adapter_version: "fusion-world-en@4",
      idempotency_key: "source_parent_notice_only_legality_001",
      requests: officialSourceDiscoveryRequests("fusion-world-en").map(
        (request) => ({
          ...request,
          headers: { ...request.headers, "user-agent": marker },
        }),
      ),
    },
  );
  expect(created.status).toBe(201);
  const run = await created.json<CollectionDocument>();
  const terminal = await resumeCollection(run.id, 12_000);
  expect(terminal).toMatchObject({
    state: "failed",
    failure_code: "source_parse_failed",
  });
  const candidate = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/candidate`,
    "GET",
  );
  expect(candidate.status).toBe(409);
}, 15_000);

test("the parent Workflow keeps a greater-than-1-MiB legality candidate in D1 and replays only a bounded reference", async () => {
  const marker = "card-keepr-large-legality-workflow-v3";
  const created = await administrationRequest(
    "/v1/ingestion-runs/evidence",
    "POST",
    {
      supported_game: "fusion-world",
      source_lineage: "fusion-world-en",
      adapter_version: "fusion-world-en@4",
      idempotency_key: "source_parent_large_legality_001",
      requests: officialSourceDiscoveryRequests("fusion-world-en").map(
        (request) => ({
          ...request,
          headers: { ...request.headers, "user-agent": marker },
        }),
      ),
    },
  );
  expect(created.status).toBe(201);
  const run = await created.json<CollectionDocument>();
  const resumed = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(resumed.status).toBe(202);
  const accepted = await resumed.json<{ workflow: { id: string } }>();
  const parent = await env.EVIDENCE_INGESTION_WORKFLOW.get(
    accepted.workflow.id,
  );
  await waitForWorkflowStatus(
    accepted.workflow.id,
    () => parent.status(),
    "complete",
    90_000,
  );

  const assertBoundedOutput = async (expectsReference: boolean) => {
    const status = await parent.status();
    expect(status.status).toBe("complete");
    const output = status.output as Record<string, unknown>;
    expect(new TextEncoder().encode(JSON.stringify(output)).byteLength)
      .toBeLessThan(524_288);
    expect(output).toMatchObject(expectsReference
      ? {
        ingestion_run_id: run.id,
        reconciliation: {
          contract: "card-keepr-reconciliation-workflow-result@1",
          run_id: run.id,
          candidate_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      }
      : {
        ingestion_run_id: run.id,
        state: "awaiting_approval",
      });
    expect(JSON.stringify(output)).not.toContain("legality_rules");
  };
  const candidateResponse = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/candidate`,
    "GET",
  );
  expect(candidateResponse.status).toBe(200);
  const candidate = await candidateResponse.json<Record<string, unknown>>();
  expect(candidate).toMatchObject({
    diff: {
      summary: {
        legality_rules_added: 4_000,
        legality_rules_current: 4_000,
      },
    },
  });
  const persisted = await env.CATALOGUE_DB.prepare(
    `SELECT SUM(length(CAST(content AS BLOB))) AS candidate_bytes
     FROM reconciliation_payload_chunks
     WHERE ingestion_run_id = ? AND payload_kind = 'candidate'`,
  ).bind(run.id).first<{ candidate_bytes: number }>();
  expect(persisted?.candidate_bytes).toBeGreaterThan(1_048_576);

  await assertBoundedOutput(true);

  await parent.restart();
  await waitForWorkflowStatus(
    accepted.workflow.id,
    () => parent.status(),
    "complete",
    90_000,
  );
  await assertBoundedOutput(false);
}, 120_000);

test("resuming collection reactivates an errored hostname Workflow with one persisted replacement", async () => {
  const run = await createCollection(
    "source_collection_existing_child_001",
    "https://official-source.invalid/cards",
  );
  await env.CATALOGUE_DB.prepare(
    `CREATE TRIGGER fail_initial_observation_set_insert
     BEFORE INSERT ON source_observation_sets
     BEGIN
       SELECT RAISE(FAIL, 'synthetic_initial_parse_d1_outage');
     END`,
  ).run();
  const accepted = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(accepted.status).toBe(202);
  await accepted.body?.cancel();
  const staged = await waitForParseOperation(run.id, "uploaded");
  const collecting = await showCollection(run.id);
  const childId = collecting.workflow.child_ids[0];
  if (childId === undefined) {
    throw new Error("missing hostname Workflow identity");
  }
  await waitForWorkflowStatus(
    childId,
    async () =>
      (await env.EVIDENCE_HOST_WORKFLOW.get(childId)).status(),
    "errored",
  );
  expect(staged.state).toBe("uploaded");
  await env.CATALOGUE_DB.prepare(
    "DROP TRIGGER fail_initial_observation_set_insert",
  ).run();

  const completed = await resumeCollection(run.id);

  expect(completed.state).toBe("parsing");
  expect(completed.workflow.child_ids).toEqual([
    childId,
    `${childId}-attempt-0`,
  ]);
  expect(completed.snapshots).toHaveLength(1);
  expect(completed.observation_sets).toHaveLength(1);
}, 15_000);

test("a full parent restart retains history and appends one bounded child identity", async () => {
  const created = await fixtureEvidenceRequest(
    {
      supported_game: "one-piece",
      source_lineage: "one-piece-en",
      adapter_version: "fixture-one-piece-json@1",
      idempotency_key: "source_stable_hostname_mapping_001",
      requests: [
        {
          id: "completed-host",
          url: "https://mapping-a-official-source.invalid/cards",
        },
        {
          id: "remaining-host",
          url: "https://mapping-z-official-source.invalid/retry-once",
        },
      ],
    },
  );
  expect(created.status).toBe(201);
  const run = await created.json<CollectionDocument>();
  const accepted = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(accepted.status).toBe(202);
  await accepted.body?.cancel();
  const interrupted = await waitForEvidenceCondition(
    run.id,
    (current) =>
      current.snapshots.length === 1 &&
      current.diagnostics.some(
        (diagnostic) =>
          diagnostic.request_id === "remaining-host" &&
          diagnostic.outcome === "http_failure",
      ),
  );
  expect(interrupted.workflow.child_ids).toHaveLength(2);
  const originalChildIds = interrupted.workflow.child_ids;
  const remainingChildId = originalChildIds[1];
  if (remainingChildId === undefined) {
    throw new Error("missing remaining hostname Workflow identity");
  }
  const remainingChild =
    await env.EVIDENCE_HOST_WORKFLOW.get(remainingChildId);
  await remainingChild.terminate();
  const parentId = interrupted.workflow.parent_id;
  if (parentId === null) throw new Error("missing parent Workflow identity");
  await waitForWorkflowStatus(
    parentId,
    async () =>
      (await env.EVIDENCE_INGESTION_WORKFLOW.get(parentId)).status(),
    "complete",
  );
  const parent = await env.EVIDENCE_INGESTION_WORKFLOW.get(parentId);
  await parent.restart();

  const completed = await waitForEvidenceCondition(
    run.id,
    (current) =>
      current.state === "parsing" &&
      current.workflow.child_ids.length === originalChildIds.length + 1 &&
      current.snapshots.length === 2 &&
      current.observation_sets.length === 2,
    25_000,
  );
  expect(completed.workflow.child_ids).toEqual([
    ...originalChildIds,
    `${remainingChildId}-attempt-0`,
  ].sort());
  expect(completed.snapshots).toHaveLength(2);
  expect(completed.observation_sets).toHaveLength(2);
}, 30_000);

test("redirects and terminal HTTP failures remain diagnostics without Source Snapshots", async () => {
  const redirectRun = await createCollection(
    "source_collection_redirect_001",
    "https://official-source.invalid/redirect",
  );
  const rejectedResponse = await administrationRequest(
    `/v1/ingestion-runs/${redirectRun.id}/collection/resume`,
    "POST",
  );
  expect(rejectedResponse.status).toBe(202);
  await rejectedResponse.body?.cancel();
  const rejected = await waitForEvidenceRun(
    redirectRun.id,
    "failed",
  ) as CollectionDocument;
  expect(rejected).toMatchObject({
    state: "failed",
    failure_code: "source_redirect_rejected",
    snapshots: [],
  });
  expect(rejected.diagnostics).toHaveLength(1);
  expect(rejected.diagnostics[0]).toMatchObject({
    attempt_number: 1,
    outcome: "redirect",
    http_status: 302,
  });

  const failedRun = await createCollection(
    "source_collection_failed_001",
    "https://failed-official-source.invalid/unavailable",
  );
  const failedResponse = await administrationRequest(
    `/v1/ingestion-runs/${failedRun.id}/collection/resume`,
    "POST",
  );
  expect(failedResponse.status).toBe(202);
  await failedResponse.body?.cancel();
  const failed = await waitForEvidenceRun(
    failedRun.id,
    "failed",
    12_000,
  ) as CollectionDocument;
  expect(failed).toMatchObject({
    state: "failed",
    failure_code: "source_request_retries_exhausted",
    snapshots: [],
  });
  expect(failed.diagnostics).toHaveLength(4);
  expect(
    failed.diagnostics.map((diagnostic) => ({
      attempt_number: diagnostic.attempt_number,
      outcome: diagnostic.outcome,
      status: diagnostic.http_status,
      retry_after_ms: diagnostic.retry_after_ms,
    })),
  ).toEqual([
    {
      attempt_number: 1,
      outcome: "http_failure",
      status: 503,
      retry_after_ms: 0,
    },
    {
      attempt_number: 2,
      outcome: "http_failure",
      status: 503,
      retry_after_ms: 0,
    },
    {
      attempt_number: 3,
      outcome: "http_failure",
      status: 503,
      retry_after_ms: 0,
    },
    {
      attempt_number: 4,
      outcome: "http_failure",
      status: 503,
      retry_after_ms: 0,
    },
  ]);

  const retriedResponse = await administrationRequest(
    `/v1/ingestion-runs/${failed.id}/collection/retry`,
    "POST",
    { idempotency_key: "source_collection_failed_retry_001" },
  );
  expect(retriedResponse.status).toBe(201);
  const retried = await retriedResponse.json<CollectionDocument>();
  expect(retried).toMatchObject({
    state: "collecting",
    linked_run_id: failed.id,
    snapshots: [],
    diagnostics: [],
  });
  expect(retried.id).not.toBe(failed.id);
});

test("the parent Workflow creates a persisted dynamic host child before recovery inspects it", async () => {
  const run = await createCollection(
    "source_dynamic_host_creation_gap_001",
    "https://official-source.invalid/retry-once",
  );
  const resumed = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(resumed.status).toBe(202);
  await resumed.body?.cancel();
  const collecting = await waitForEvidenceCondition(
    run.id,
    (current) => current.workflow.child_ids.length === 1,
  );
  const storedRun = await requiredEvidenceRun(env.CATALOGUE_DB, run.id);
  const parentRequest = (
    await pendingEvidenceRequests(env.CATALOGUE_DB, run.id)
  )[0];
  if (parentRequest === undefined) {
    throw new Error("pending parent request missing");
  }
  await appendDiscoveredEvidenceRequests(
    env.CATALOGUE_DB,
    storedRun,
    parentRequest,
    [{
      role: "detail",
      url: "https://dynamic-b-official-source.invalid/cards",
      headers: {},
    }],
  );
  const originalChildId = collecting.workflow.child_ids[0];
  if (originalChildId === undefined) {
    throw new Error("original host Workflow identity missing");
  }
  await (await env.EVIDENCE_HOST_WORKFLOW.get(originalChildId)).terminate();

  const completed = await waitForEvidenceCondition(
    run.id,
    (current) =>
      current.state === "parsing" &&
      current.snapshots.length === 2 &&
      current.observation_sets.length === 2,
    15_000,
  );
  expect(
    completed.snapshots.map(({ request }) => new URL(request.url).hostname)
      .sort(),
  ).toEqual([
    "dynamic-b-official-source.invalid",
    "official-source.invalid",
  ]);
});

test("the parent Workflow fails deterministically at the persisted child-attempt ceiling", async () => {
  const run = await createCollection(
    "source_child_attempt_bound_001",
    "https://official-source.invalid/cards",
  );
  const baseChildId = `evidence-host-${await sha256(utf8(canonicalJson({
    ingestion_run_id: run.id,
    hostname: "official-source.invalid",
    minimum_sequence_number: 0,
    maximum_sequence_number: 199,
  })))}`;
  const exhaustedIds = [
    baseChildId,
    `${baseChildId}-attempt-0`,
    `${baseChildId}-attempt-1`,
    `${baseChildId}-attempt-2`,
  ];
  await env.CATALOGUE_DB.prepare(
    `UPDATE ingestion_evidence_plans SET child_workflow_ids_json = ?
     WHERE ingestion_run_id = ?`,
  ).bind(canonicalJson(exhaustedIds), run.id).run();

  const resumed = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(resumed.status).toBe(202);
  await resumed.body?.cancel();
  const terminal = await waitForEvidenceCondition(
    run.id,
    (current) => current.state !== "collecting",
    15_000,
  );
  expect(terminal).toMatchObject({
    state: "failed",
    failure_code: "source_workflow_retries_exhausted",
    workflow: { child_ids: exhaustedIds },
  });
  expect(terminal.workflow.child_ids).toHaveLength(4);
});

test("dynamic discovery durably plans and replays 2,500 requests within D1 limits", async () => {
  const run = await createCollection(
    "source_dynamic_plan_d1_limit_001",
    "https://official-source.invalid/cards",
  );
  const storedRun = await requiredEvidenceRun(env.CATALOGUE_DB, run.id);
  const parentRequest = (
    await pendingEvidenceRequests(env.CATALOGUE_DB, run.id)
  )[0];
  if (parentRequest === undefined) {
    throw new Error("pending discovery parent request missing");
  }
  const discovered = Array.from({ length: 2_500 }, (_, index) => ({
    role: "detail" as const,
    url: `https://official-source.invalid/cards/${String(index + 1).padStart(4, "0")}`,
    headers: { accept: "text/html" },
  }));

  expect(await appendDiscoveredEvidenceRequests(
    env.CATALOGUE_DB,
    storedRun,
    parentRequest,
    discovered,
  )).toHaveLength(2_500);
  expect(await appendDiscoveredEvidenceRequests(
    env.CATALOGUE_DB,
    storedRun,
    parentRequest,
    discovered,
  )).toHaveLength(2_500);

  expect(await env.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM source_discovery_request_plans
     WHERE ingestion_run_id = ?`,
  ).bind(run.id).first("count")).toBe(2_500);
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM source_requests
     WHERE ingestion_run_id = ?`,
  ).bind(run.id).first("count")).toBe(2_501);
}, 60_000);

test("dynamic discovery scopes the 5,000-request bound to each owning Evidence Plan", async () => {
  const started = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
    idempotency_key: "source_dynamic_per_plan_bound_001",
    plans: [
      {
        supported_game: "fusion-world",
        source_lineage: "fusion-world-en",
        adapter_version: "fixture-fusion-world-json@1",
        requests: [{
          id: "fusion-root",
          method: "GET",
          url: "https://official-source.invalid/fusion/root",
        }],
      },
      {
        supported_game: "one-piece",
        source_lineage: "one-piece-en",
        adapter_version: "fixture-one-piece-json@1",
        requests: [{
          id: "one-piece-root",
          method: "GET",
          url: "https://official-source.invalid/one-piece/root",
        }],
      },
    ],
  });
  const runId = started.id;
  if (typeof runId !== "string") throw new Error("run id missing");
  const storedRun = await requiredEvidenceRun(env.CATALOGUE_DB, runId);
  const roots = await pendingEvidenceRequests(env.CATALOGUE_DB, runId);
  for (const [lineage, root] of [
    ["fusion-world-en", roots.find(({ request_id }) => request_id === "fusion-root")],
    ["one-piece-en", roots.find(({ request_id }) => request_id === "one-piece-root")],
  ] as const) {
    if (root === undefined) throw new Error(`${lineage} root missing`);
    await expect(appendDiscoveredEvidenceRequests(
      env.CATALOGUE_DB,
      storedRun,
      root,
      Array.from({ length: 3_000 }, (_, index) => ({
        role: "detail" as const,
        url: `https://official-source.invalid/${lineage}/${String(index).padStart(4, "0")}`,
        headers: { accept: "text/html" },
      })),
    )).resolves.toHaveLength(3_000);
  }
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM source_discovery_request_plans
     WHERE ingestion_run_id = ?`,
  ).bind(runId).first("count")).toBe(6_000);
}, 90_000);

test("dynamic discovery rejects 5,001 requests in one owning Evidence Plan", async () => {
  const run = await createCollection(
    "source_dynamic_single_plan_bound_001",
    "https://official-source.invalid/cards",
  );
  const storedRun = await requiredEvidenceRun(env.CATALOGUE_DB, run.id);
  const root = (await pendingEvidenceRequests(env.CATALOGUE_DB, run.id))[0];
  if (root === undefined) throw new Error("pending discovery root missing");
  await expect(appendDiscoveredEvidenceRequests(
    env.CATALOGUE_DB,
    storedRun,
    root,
    Array.from({ length: 5_001 }, (_, index) => ({
      role: "detail" as const,
      url: `https://official-source.invalid/cards/bound/${String(index).padStart(4, "0")}`,
      headers: { accept: "text/html" },
    })),
  )).rejects.toMatchObject({ code: "source_discovery_too_large" });
});

test("the authenticated Workflow shards a 5,000-request host plan into bounded child workloads", async () => {
  const run = await createCollection(
    "source_workflow_shard_bound_001",
    "https://official-source.invalid/cards/root",
  );
  const storedRun = await requiredEvidenceRun(env.CATALOGUE_DB, run.id);
  const root = (await pendingEvidenceRequests(env.CATALOGUE_DB, run.id))[0];
  if (root === undefined) throw new Error("pending discovery root missing");
  await appendDiscoveredEvidenceRequests(
    env.CATALOGUE_DB,
    storedRun,
    root,
    Array.from({ length: 4_999 }, (_, index) => ({
      role: "detail" as const,
      url: `https://official-source.invalid/cards/sharded/${String(index + 1).padStart(4, "0")}`,
      headers: { accept: "application/json" },
    })),
  );

  const resumed = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(resumed.status).toBe(202);
  await resumed.body?.cancel();
  let observed: CollectionDocument | undefined;
  try {
    observed = await waitForEvidenceCondition(
      run.id,
      (current) => current.workflow.child_ids.length === 25,
      8_000,
    );
  } finally {
    const current = await showCollection(run.id);
    if (current.workflow.parent_id !== null) {
      await (await env.EVIDENCE_INGESTION_WORKFLOW.get(
        current.workflow.parent_id,
      )).terminate().catch(() => undefined);
    }
    const activeChildId = `evidence-host-${await sha256(utf8(canonicalJson({
      ingestion_run_id: run.id,
      hostname: "official-source.invalid",
      minimum_sequence_number: 0,
      maximum_sequence_number: 199,
    })))}`;
    await (await env.EVIDENCE_HOST_WORKFLOW.get(activeChildId)).terminate()
      .catch(() => undefined);
  }
  expect(observed?.workflow.child_ids).toHaveLength(25);
}, 90_000);

test("a completed host shard durably releases the next same-host shard", async () => {
  const run = await createCollection(
    "source_workflow_shard_progression_001",
    "https://official-source.invalid/sequence/root",
  );
  const storedRun = await requiredEvidenceRun(env.CATALOGUE_DB, run.id);
  const root = (await pendingEvidenceRequests(env.CATALOGUE_DB, run.id))[0];
  if (root === undefined) throw new Error("pending discovery root missing");
  await appendDiscoveredEvidenceRequests(
    env.CATALOGUE_DB,
    storedRun,
    root,
    Array.from({ length: 200 }, (_, index) => ({
      role: "detail" as const,
      url: `https://official-source.invalid/sequence/shard-${String(index + 1).padStart(3, "0")}`,
      headers: { accept: "application/json" },
    })),
  );
  // Bounded test setup leaves one live request in each 200-sequence shard.
  await env.CATALOGUE_DB.prepare(
    `UPDATE source_requests SET state = 'observed'
     WHERE ingestion_run_id = ? AND sequence_number BETWEEN 1 AND 199`,
  ).bind(run.id).run();

  const resumed = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(resumed.status).toBe(202);
  await resumed.body?.cancel();
  const completed = await waitForEvidenceCondition(
    run.id,
    (current) =>
      current.state === "parsing" &&
      current.snapshots.length === 2 &&
      current.workflow.child_ids.length === 3,
    15_000,
  );
  expect(completed.snapshots.map(({ request }) => request.url).sort()).toEqual([
    "https://official-source.invalid/sequence/root",
    "https://official-source.invalid/sequence/shard-200",
  ]);
  expect(
    completed.workflow.child_ids.filter((id) => id.endsWith("-attempt-0")),
  ).toHaveLength(1);
}, 30_000);

test("dynamic discovery preserves the first edge when two parents reach one immutable request", async () => {
  const run = await createCollection(
    "source_dynamic_shared_request_001",
    "https://official-source.invalid/cards",
  );
  const storedRun = await requiredEvidenceRun(env.CATALOGUE_DB, run.id);
  const root = (await pendingEvidenceRequests(env.CATALOGUE_DB, run.id))[0];
  if (root === undefined) throw new Error("pending discovery root missing");
  const discovered = [
    {
      role: "detail" as const,
      url: "https://official-source.invalid/cards/one",
      headers: { accept: "text/html" },
    },
    {
      role: "detail" as const,
      url: "https://official-source.invalid/cards/two",
      headers: { accept: "text/html" },
    },
  ];
  const [first, second] = await appendDiscoveredEvidenceRequests(
    env.CATALOGUE_DB,
    storedRun,
    root,
    discovered,
  );
  if (first === undefined || second === undefined) {
    throw new Error("dynamic requests were not persisted");
  }

  const replayed = await appendDiscoveredEvidenceRequests(
    env.CATALOGUE_DB,
    storedRun,
    first,
    [discovered[1]!],
  );

  expect(replayed).toHaveLength(1);
  expect(replayed[0]).toMatchObject({
    request_id: second.request_id,
    discovered_from_request_id: root.request_id,
  });
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM source_requests
     WHERE ingestion_run_id = ?`,
  ).bind(run.id).first("count")).toBe(3);
});

test(
  "successful captures remain auditable when a later required response is rejected or terminally fails",
  async () => {
    for (const scenario of [
      {
        key: "retained_after_rejected_001",
        terminalUrl:
          "https://retained-redirect-official-source.invalid/redirect",
        failureCode: "source_redirect_rejected",
      },
      {
        key: "retained_after_terminal_failure_001",
        terminalUrl:
          "https://retained-failure-official-source.invalid/unavailable",
        failureCode: "source_request_retries_exhausted",
      },
    ]) {
      const response = await fixtureEvidenceRequest(
        {
          supported_game: "one-piece",
          source_lineage: "one-piece-en",
          adapter_version: "fixture-one-piece-json@1",
          idempotency_key: scenario.key,
          requests: [
            {
              id: "captured",
              url: `https://${new URL(scenario.terminalUrl).hostname}/cards`,
            },
            { id: "terminal", url: scenario.terminalUrl },
          ],
        },
      );
      expect(response.status).toBe(201);
      const run = await response.json<CollectionDocument>();
      const terminal = await resumeCollection(run.id);
      expect(terminal).toMatchObject({
        state: "failed",
        failure_code: scenario.failureCode,
      });
      expect(terminal.snapshots).toHaveLength(1);
      expect(terminal.observation_sets).toHaveLength(1);

      const retained = await showCollection(run.id);
      expect(retained.snapshots).toEqual(terminal.snapshots);
      expect(retained.observation_sets).toEqual(
        terminal.observation_sets,
      );
    }
  },
  12_000,
);

test("a successful response remains snapshotted when parsing terminally fails", async () => {
  const run = await createCollection(
    "source_collection_parse_failure_001",
    "https://parse-failure-official-source.invalid/invalid-json",
  );
  const accepted = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(accepted.status).toBe(202);
  await accepted.body?.cancel();
  const failed = await waitForEvidenceRun(run.id, "failed", 15_000);
  expect(failed).toMatchObject({
    state: "failed",
    failure_code: "source_parse_failed",
  });
  expect(failed.snapshots).toHaveLength(1);
  expect(failed.observation_sets).toEqual([]);
  expect(failed.diagnostics).toHaveLength(1);
  expect(failed.diagnostics[0]).toMatchObject({
    outcome: "success",
    http_status: 200,
  });

  const retained = await showCollection(run.id);
  expect(retained.snapshots).toEqual(failed.snapshots);
});

test("validator revalidation creates fresh fetch evidence and reuses bytes only for the same adapter version", async () => {
  const firstRun = await createCollection(
    "source_collection_cache_first_001",
    "https://official-source.invalid/conditional",
    "fixture-one-piece-json@1",
    { "accept-language": "en" },
  );
  const first = await resumeCollection(firstRun.id);
  const firstSnapshot = first.snapshots[0];
  if (firstSnapshot === undefined) throw new Error("missing first snapshot");
  await clearActiveRunForNextScenario();

  const differentRepresentationRun = await createCollection(
    "source_collection_cache_language_changed_001",
    "https://official-source.invalid/conditional",
    "fixture-one-piece-json@1",
    { "accept-language": "fr" },
  );
  const differentRepresentation = await resumeCollection(
    differentRepresentationRun.id,
  );
  expect(differentRepresentation.snapshots[0]).toMatchObject({
    http: { status: 200 },
    reused_source_snapshot_id: null,
  });
  await clearActiveRunForNextScenario();

  const revalidatedRun = await createCollection(
    "source_collection_cache_second_001",
    "https://official-source.invalid/conditional",
    "fixture-one-piece-json@1",
    { "accept-language": "en" },
  );
  const revalidated = await resumeCollection(revalidatedRun.id);
  const revalidatedSnapshot = revalidated.snapshots[0];
  if (revalidatedSnapshot === undefined) {
    throw new Error("missing revalidated snapshot");
  }
  await clearActiveRunForNextScenario();
  expect(revalidatedSnapshot).toMatchObject({
    http: { status: 304 },
    reused_source_snapshot_id: firstSnapshot.id,
    content: {
      digest: firstSnapshot.content.digest,
      object_key: firstSnapshot.content.object_key,
    },
  });
  expect(revalidated.diagnostics[0]).toMatchObject({
    outcome: "cache_revalidated",
    http_status: 304,
  });

  const changedAdapterRun = await createCollection(
    "source_collection_cache_adapter_changed_001",
    "https://official-source.invalid/conditional",
    "fixture-one-piece-json@2",
    { "accept-language": "en" },
  );
  const changedAdapter = await resumeCollection(changedAdapterRun.id);
  const changedAdapterSnapshot = changedAdapter.snapshots[0];
  if (changedAdapterSnapshot === undefined) {
    throw new Error("missing changed-adapter snapshot");
  }
  expect(changedAdapterSnapshot.http.status).toBe(200);
  expect(changedAdapterSnapshot.reused_source_snapshot_id).toBeNull();
}, 12_000);

test("Retry-After is audited without shortening the Official Source deadline", async () => {
  const run = await createCollection(
    "source_retry_after_long_001",
    "https://retry-after-official-source.invalid/retry-after-long",
  );
  const accepted = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(accepted.status).toBe(202);
  await accepted.body?.cancel();
  const waiting = await waitForEvidenceDiagnostic(run.id);
  expect(waiting).toMatchObject({
    state: "collecting",
    diagnostics: [
      {
        attempt_number: 1,
        outcome: "http_failure",
        http_status: 503,
        retry_after_ms: 120_000,
      },
    ],
  });
  const childWorkflowId = waiting.workflow.child_ids[0];
  if (childWorkflowId === undefined) {
    throw new Error("missing hostname Workflow identity");
  }
  const childWorkflow = await env.EVIDENCE_HOST_WORKFLOW.get(childWorkflowId);
  await childWorkflow.terminate();
});

test("adapter registrations stay constrained while mismatched production identities fail closed", async () => {
  const mismatched = await administrationRequest(
    "/v1/ingestion-runs/evidence",
    "POST",
    {
      supported_game: "one-piece",
      source_lineage: "unrelated-source",
      adapter_version: "one-piece-en@3",
      idempotency_key: "source_adapter_mismatch_001",
      requests: [
        {
          id: "cards",
          url: "https://official-source.invalid/cards",
        },
      ],
    },
  );
  expect(mismatched.status).toBe(422);
  await expect(mismatched.json()).resolves.toMatchObject({
    code: "adapter_binding_mismatch",
  });

  const constrained = await env.CATALOGUE_DB.prepare(
    `SELECT adapter_version, source_lineage, supported_game,
            game_profile_version, parser_contract, adapter_origin
     FROM source_adapter_versions ORDER BY adapter_version`,
  ).all<{
    adapter_version: string;
    source_lineage: string;
    supported_game: string;
    game_profile_version: string;
    parser_contract: string;
    adapter_origin: string;
  }>();
  expect(constrained.results).toEqual(
    installedSourceAdapterRegistrations
      .map((adapter) => ({
        adapter_version: adapter.adapterVersion,
        source_lineage: adapter.sourceLineage,
        supported_game: adapter.supportedGame,
        game_profile_version: adapter.gameProfileVersion,
        parser_contract: adapter.parserContract,
        adapter_origin: adapter.origin,
      }))
      .sort((left, right) =>
        left.adapter_version.localeCompare(right.adapter_version),
      ),
  );
});

test("a production plan cannot replace its discovery root with a raw surface", async () => {
  const plan = exactOnePiecePlan("source_exact_plan_omission_001");
  plan.requests[0]!.id = "one-piece-en:card-list";
  const response = await administrationRequest(
    "/v1/ingestion-runs/evidence",
    "POST",
    plan,
  );
  expect(response.status).toBe(422);
  await expect(response.json()).resolves.toMatchObject({
    code: "incomplete_source_plan",
  });
});

test.each([
  ["cap"],
  ["pagination"],
])(
  "raw discovery %s evidence fails closed after retaining the snapshot",
  async (failure) => {
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      const plan = exactOnePiecePlan(
        `source_exact_${failure}_${String(repetition).padStart(3, "0")}`,
      );
      plan.requests[0]!.headers = {
        ...plan.requests[0]!.headers,
        "user-agent": `card-keepr-runtime-parser/${failure}-${repetition}`,
      };
      const created = await administrationRequest(
        "/v1/ingestion-runs/evidence",
        "POST",
        plan,
      );
      expect(created.status).toBe(201);
      const run = await created.json<{ id: string }>();
      const terminal = await resumeCollection(run.id, 20_000);
      if (terminal.failure_code !== "source_parse_failed") {
        const failures = await env.CATALOGUE_DB.prepare(
          `SELECT request_id, state, failure_code
           FROM source_requests
           WHERE ingestion_run_id = ? AND failure_code IS NOT NULL
           ORDER BY sequence_number`,
        ).bind(run.id).all();
        throw new Error(JSON.stringify({
          failure_code: terminal.failure_code,
          source_failures: failures.results,
        }));
      }
      expect(terminal).toMatchObject({
        state: "failed",
        failure_code: "source_parse_failed",
      });
      expect(terminal.snapshots).toHaveLength(11);
      expect(terminal.observation_sets).toHaveLength(10);
      expect(
        terminal.snapshots.some((snapshot) =>
          snapshot.request.url === plan.requests[0]!.url
        ),
      ).toBe(true);
      await expect(env.CATALOGUE_DB.prepare(
        `SELECT request_id, failure_code FROM source_requests
         WHERE ingestion_run_id = ? AND state = 'failed'
         ORDER BY sequence_number`,
      ).bind(run.id).all()).resolves.toMatchObject({
        results: [{
          request_id: "one-piece-en:card-list",
          failure_code: "source_parse_failed",
        }],
      });
    }
  },
  90_000,
);

test.each([
  ["declared", "large-json"],
  ["chunked", "oversized-chunked-json"],
])(
  "%s oversized response bodies fail before an immutable snapshot is retained",
  async (shape, path) => {
    const run = await createCollection(
      `source_${shape}_capture_bound_001`,
      `https://large-official-source.invalid/${path}`,
      "fixture-one-piece-json-capped@1",
    );
    const failed = await resumeCollection(run.id, 15_000);
    expect(failed).toMatchObject({
      state: "failed",
      failure_code: "source_request_retries_exhausted",
      snapshots: [],
      observation_sets: [],
    });
    expect(failed.diagnostics.map(({ outcome }) => outcome)).toEqual([
      "body_failure",
      "body_failure",
      "body_failure",
      "body_failure",
    ]);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const identity = await captureOperationIdentity(
        run.id,
        "required-source",
        attempt,
      );
      expect(await env.EVIDENCE_OBJECTS.head(identity.objectKey)).toBeNull();
    }
  },
  30_000,
);

test("body streaming failures are durable diagnostics with bounded retries", async () => {
  const run = await createCollection(
    "source_body_failure_001",
    "https://body-failure-official-source.invalid/body-failure",
  );
  const accepted = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(accepted.status).toBe(202);
  await accepted.body?.cancel();
  const failed = await waitForEvidenceRun(run.id, "failed", 15_000);
  expect(failed).toMatchObject({
    state: "failed",
    failure_code: "source_request_retries_exhausted",
    snapshots: [],
  });
  expect(failed.diagnostics).toHaveLength(4);
  expect(
    failed.diagnostics.map((diagnostic) => ({
      attempt_number: diagnostic.attempt_number,
      outcome: diagnostic.outcome,
    })),
  ).toEqual([
    { attempt_number: 1, outcome: "body_failure" },
    { attempt_number: 2, outcome: "body_failure" },
    { attempt_number: 3, outcome: "body_failure" },
    { attempt_number: 4, outcome: "body_failure" },
  ]);
}, 15_000);

test("R2 recovery outages become durable bounded storage failures", async () => {
  const run = await createCollection(
    "source_recovery_r2_outage_001",
    "https://official-source.invalid/cards",
  );
  const identity = await captureOperationIdentity(
    run.id,
    "required-source",
    1,
  );
  const now = new Date().toISOString();
  await env.CATALOGUE_DB.prepare(
    `INSERT INTO source_capture_operations (
      attempt_id, ingestion_run_id, request_id, attempt_number,
      source_snapshot_id, content_object_key, state, requested_at,
      completed_at, request_headers_json, http_status,
      response_headers_json, response_vary_json, media_type
    ) VALUES (
      ?, ?, 'required-source', 1, ?, ?, 'response_received', ?,
      ?, '{}', 200, '{"content-type":"application/json"}', '[]',
      'application/json'
    )`,
  )
    .bind(
      identity.attemptId,
      run.id,
      identity.snapshotId,
      identity.objectKey,
      now,
      now,
    )
    .run();
  const outageBucket = new Proxy(env.EVIDENCE_OBJECTS, {
    get(target, property) {
      if (
        property === "get" ||
        property === "put" ||
        property === "createMultipartUpload"
      ) {
        return async () => {
          throw new Error("synthetic R2 outage");
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const evidenceRun = await requiredEvidenceRun(env.CATALOGUE_DB, run.id);
  const request = (
    await pendingEvidenceRequests(env.CATALOGUE_DB, run.id)
  )[0];
  if (request === undefined) throw new Error("missing evidence request");

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const prepared = await prepareCaptureAttempt(
      env.CATALOGUE_DB,
      evidenceRun,
      request,
    );
    if (prepared.kind !== "attempt") {
      throw new Error(`unexpected preparation result ${prepared.kind}`);
    }
    const result = await capturePreparedAttempt(
      env.CATALOGUE_DB,
      outageBucket,
      env.OFFICIAL_SOURCE_TRANSPORT,
      evidenceRun,
      request,
      prepared,
    );
    expect(result.kind).toBe(attempt === 4 ? "done" : "wait");
  }

  const failed = await resumeCollection(run.id);
  expect(failed).toMatchObject({
    state: "failed",
    failure_code: "source_request_retries_exhausted",
    snapshots: [],
  });
  expect(
    failed.diagnostics.map((diagnostic) => diagnostic.outcome),
  ).toEqual([
    "storage_failure",
    "storage_failure",
    "storage_failure",
    "storage_failure",
  ]);
});

test("resume recovers the deterministic object after an upload-before-D1 restart boundary", async () => {
  const run = await createCollection(
    "source_restart_boundary_001",
    "https://restart-official-source.invalid/must-not-refetch",
  );
  const identity = await captureOperationIdentity(
    run.id,
    "required-source",
    1,
  );
  const bytes = new TextEncoder().encode(
    '{"cards":[{"card_number":"OP01-001"}]}',
  );
  await env.EVIDENCE_OBJECTS.put(identity.objectKey, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" },
  });
  const now = new Date().toISOString();
  await env.CATALOGUE_DB.prepare(
    `INSERT INTO source_capture_operations (
      attempt_id, ingestion_run_id, request_id, attempt_number,
      source_snapshot_id, content_object_key, state, requested_at,
      completed_at, request_headers_json, http_status,
      response_headers_json, response_vary_json, media_type
    ) VALUES (
      ?, ?, 'required-source', 1, ?, ?, 'response_received', ?,
      ?, '{}', 200, '{"content-type":"application/json"}', '[]',
      'application/json'
    )`,
  )
    .bind(
      identity.attemptId,
      run.id,
      identity.snapshotId,
      identity.objectKey,
      now,
      now,
    )
    .run();

  const completed = await resumeCollection(run.id);
  expect(completed).toMatchObject({
    state: "parsing",
    diagnostics: [{ attempt_number: 1, outcome: "success" }],
    snapshots: [
      {
        id: identity.snapshotId,
        content: { object_key: identity.objectKey },
      },
    ],
  });
  const operation = await env.CATALOGUE_DB.prepare(
    `SELECT state, content_digest, content_byte_length
     FROM source_capture_operations WHERE attempt_id = ?`,
  )
    .bind(identity.attemptId)
    .first<{
      state: string;
      content_digest: string;
      content_byte_length: number;
    }>();
  expect(operation).toMatchObject({
    state: "finalized",
    content_byte_length: bytes.byteLength,
    content_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(await env.EVIDENCE_OBJECTS.head(identity.objectKey)).not.toBeNull();
});

test("reparse retries recover one staged immutable observation set while new intents append", async () => {
  const run = await createCollection(
    "source_collection_reparse_001",
    "https://official-source.invalid/raw-one-piece-products",
  );
  const completed = await resumeCollection(run.id);
  const snapshot = completed.snapshots[0];
  const originalSet = completed.observation_sets[0];
  if (snapshot === undefined || originalSet === undefined) {
    throw new Error("missing evidence for reparse");
  }
  const objectsBeforeReparse = new Set(
    (
      await env.EVIDENCE_OBJECTS.list({
        prefix: "source-observations/",
      })
    ).objects.map((object) => object.key),
  );

  await env.CATALOGUE_DB.prepare(
    `CREATE TRIGGER fail_observation_set_insert
     BEFORE INSERT ON source_observation_sets
     BEGIN
       SELECT RAISE(FAIL, 'synthetic_observation_d1_outage');
     END`,
  ).run();
  const interrupted = await administrationRequest(
    `/v1/source-snapshots/${snapshot.id}/observations`,
    "POST",
    {
      adapter_version: "fixture-one-piece-json@1",
      idempotency_key: "reparse_intent_001",
    },
  );
  expect(interrupted.status).toBe(500);
  const staged = await env.CATALOGUE_DB.prepare(
    `SELECT state, content_object_key FROM source_parse_operations
     WHERE source_snapshot_id = ? AND adapter_version = ?
       AND idempotency_key = ?`,
  )
    .bind(snapshot.id, "fixture-one-piece-json@1", "reparse_intent_001")
    .first<{ state: string; content_object_key: string }>();
  expect(staged?.state).toBe("uploaded");
  expect(
    await env.EVIDENCE_OBJECTS.head(staged!.content_object_key),
  ).not.toBeNull();
  await env.CATALOGUE_DB.prepare(
    "DROP TRIGGER fail_observation_set_insert",
  ).run();

  const retriedResponses = await Promise.all([
    administrationRequest(
      `/v1/source-snapshots/${snapshot.id}/observations`,
      "POST",
      {
        adapter_version: "fixture-one-piece-json@1",
        idempotency_key: "reparse_intent_001",
      },
    ),
    administrationRequest(
      `/v1/source-snapshots/${snapshot.id}/observations`,
      "POST",
      {
        adapter_version: "fixture-one-piece-json@1",
        idempotency_key: "reparse_intent_001",
      },
    ),
  ]);
  expect(retriedResponses.map((response) => response.status)).toEqual([
    201,
    201,
  ]);
  const [reparsed, replayed] = await Promise.all(
    retriedResponses.map((response) => response.json<ObservationSet>()),
  );
  if (reparsed === undefined || replayed === undefined) {
    throw new Error("missing replayed Source Observation Set");
  }
  expect(reparsed).toMatchObject({
    source_snapshot_id: snapshot.id,
    adapter_version: "fixture-one-piece-json@1",
    observation_count: 1,
  });
  expect(replayed).toEqual(reparsed);
  expect(reparsed.id).not.toBe(originalSet.id);
  expect(reparsed.object_key).not.toBe(originalSet.object_key);

  const appendedResponse = await administrationRequest(
    `/v1/source-snapshots/${snapshot.id}/observations`,
    "POST",
    {
      adapter_version: "fixture-one-piece-json@1",
      idempotency_key: "reparse_intent_002",
    },
  );
  expect(appendedResponse.status).toBe(201);
  const appended = await appendedResponse.json<ObservationSet>();
  expect(appended.id).not.toBe(reparsed.id);

  const shown = await showCollection(run.id);
  expect(shown.observation_sets).toHaveLength(3);
  expect(shown.observation_sets).toEqual([
    originalSet,
    reparsed,
    appended,
  ]);
  const objects = await env.EVIDENCE_OBJECTS.list({
    prefix: "source-observations/",
  });
  expect(
    objects.objects
      .map((object) => object.key)
      .filter((key) => !objectsBeforeReparse.has(key))
      .sort(),
  ).toEqual(
    [reparsed, appended]
      .map((set) => set.object_key)
      .sort(),
  );
});

test("collection is sequential per hostname and different hostnames progress concurrently", async () => {
  const response = await fixtureEvidenceRequest(
    {
      supported_game: "one-piece",
      source_lineage: "one-piece-en",
      adapter_version: "fixture-one-piece-json@1",
      idempotency_key: "source_collection_pacing_001",
      requests: [
        {
          id: "first-a",
          url: "https://pacing-a-official-source.invalid/sequence/1",
        },
        {
          id: "second-a",
          url: "https://pacing-a-official-source.invalid/sequence/2",
        },
        {
          id: "first-b",
          url: "https://pacing-b-official-source.invalid/sequence/1",
        },
        {
          id: "second-b",
          url: "https://pacing-b-official-source.invalid/sequence/2",
        },
      ],
    },
  );
  expect(response.status).toBe(201);
  const run = await response.json<CollectionDocument>();
  const completed = await resumeCollection(run.id);
  expect(completed.state).toBe("parsing");
  const attempts = Object.fromEntries(
    completed.diagnostics.map((attempt) => [
      attempt.request_id,
      Date.parse(attempt.requested_at),
    ]),
  );
  expect(attempts["second-a"]! - attempts["first-a"]!).toBeGreaterThanOrEqual(
    1_000,
  );
  expect(attempts["second-b"]! - attempts["first-b"]!).toBeGreaterThanOrEqual(
    1_000,
  );
  expect(
    Math.abs(attempts["first-a"]! - attempts["first-b"]!),
  ).toBeLessThan(500);
});

function administrationRequest(
  pathname: string,
  method: string,
  body?: unknown,
): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://card-keepr.invalid${pathname}`, {
      method,
      headers: {
        authorization: "Bearer vitest-administration-key",
        "cf-connecting-ip": `192.0.2.${crypto.getRandomValues(new Uint8Array(1))[0]!}`,
        ...(body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

type Snapshot = {
  id: string;
  request: { method: string; url: string };
  retrieval: { retrieved_at: string; fetch_attempt_id: string };
  http: { status: number; headers: Record<string, string> };
  content: { digest: string; object_key: string; byte_length: number };
  adapter_version: string;
  ingestion_run_id: string;
  reused_source_snapshot_id: string | null;
};

type ObservationSet = {
  id: string;
  source_snapshot_id: string;
  adapter_version: string;
  content_digest: string;
  object_key: string;
  observation_count: number;
};

type Diagnostic = {
  request_id: string;
  attempt_number: number;
  requested_at: string;
  outcome: string;
  http_status: number | null;
  retry_after_ms: number | null;
  diagnostic?: string | null;
};

type CollectionDocument = {
  id: string;
  state: string;
  linked_run_id: string | null;
  failure_code: string | null;
  snapshots: Snapshot[];
  observation_sets: ObservationSet[];
  diagnostics: Diagnostic[];
  workflow: { parent_id: string | null; child_ids: string[] };
  official_source_collection_plans: Array<{
    source_lineage: string;
    discovery_observation_set_id: string;
    contract: string;
    content_digest: string;
    created_at: string;
    plan: {
      source_lineage: string;
      requests: Array<Record<string, unknown>>;
    };
  }>;
};

async function createCollection(
  idempotencyKey: string,
  url: string,
  adapterVersion = "fixture-one-piece-json@1",
  headers: Record<string, string> = {},
): Promise<CollectionDocument> {
  const response = await fixtureEvidenceRequest(
    {
      supported_game: "one-piece",
      source_lineage: "one-piece-en",
      adapter_version: adapterVersion,
      idempotency_key: idempotencyKey,
      requests: [{ id: "required-source", url, headers }],
    },
  );
  expect(response.status).toBe(201);
  return response.json<CollectionDocument>();
}

async function injectCollectionPlan(
  idempotencyKey: string,
  requests: readonly {
    id: string;
    url: string;
    headers?: Record<string, string>;
  }[],
  adapterVersion = "fixture-one-piece-json@1",
): Promise<CollectionDocument> {
  const document = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: adapterVersion,
    idempotency_key: idempotencyKey,
    requests,
  });
  return document as CollectionDocument;
}

async function fixtureEvidenceRequest(body: {
  supported_game: string;
  source_lineage: string;
  adapter_version: string;
  idempotency_key: string;
  requests: {
    id: string;
    url: string;
    headers?: Record<string, string>;
  }[];
}): Promise<Response> {
  return Response.json(
    await startEvidenceRun(env.CATALOGUE_DB, body, "synthetic_fixture"),
    { status: 201 },
  );
}

function exactOnePiecePlan(idempotencyKey: string) {
  return {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "one-piece-en@3",
    idempotency_key: idempotencyKey,
    requests: officialSourceDiscoveryRequests("one-piece-en").map(
      (request) => ({ ...request }),
    ),
  };
}

async function waitForEvidenceDiagnostic(
  runId: string,
  timeoutMs = 2_000,
): Promise<CollectionDocument> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await showCollection(runId);
    if (current.diagnostics.length > 0) return current;
    if (Date.now() >= deadline) {
      throw new Error(`Ingestion Run ${runId} did not record a diagnostic`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForEvidenceCondition(
  runId: string,
  condition: (current: CollectionDocument) => boolean,
  timeoutMs = 8_000,
): Promise<CollectionDocument> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await showCollection(runId);
    if (condition(current)) return current;
    if (Date.now() >= deadline) {
      throw new Error(
        `Ingestion Run ${runId} did not reach test condition: ${
          JSON.stringify(current)
        }`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForWorkflowStatus(
  instanceId: string,
  readStatus: () => Promise<{ status: string }>,
  expectedStatus: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const status = await readStatus();
      if (status.status === expectedStatus) return;
    } catch {
      // The deterministic handle can exist before createBatch reaches it.
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Workflow ${instanceId} did not reach ${expectedStatus}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForParseOperation(
  runId: string,
  expectedState: string,
  timeoutMs = 8_000,
): Promise<{ state: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const operation = await env.CATALOGUE_DB.prepare(
      `SELECT state FROM source_parse_operations
       WHERE intent = 'collection' AND source_snapshot_id IN (
         SELECT source_snapshot_id FROM source_requests
         WHERE ingestion_run_id = ?
       )`,
    )
      .bind(runId)
      .first<{ state: string }>();
    if (operation?.state === expectedState) return operation;
    if (Date.now() >= deadline) {
      throw new Error(
        `Parse operation for ${runId} did not reach ${expectedState}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function resumeCollection(
  runId: string,
  timeoutMs = 8_000,
): Promise<CollectionDocument> {
  const response = await administrationRequest(
    `/v1/ingestion-runs/${runId}/collection/resume`,
    "POST",
  );
  expect(response.status).toBe(202);
  await response.body?.cancel();
  return waitForEvidenceRun(runId, null, timeoutMs);
}

async function waitForEvidenceRun(
  runId: string,
  expectedState: "parsing" | "awaiting_approval" | "failed" | null = null,
  timeoutMs = 8_000,
): Promise<CollectionDocument> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await showCollection(runId);
    if (
      expectedState === null
        ? current.state === "parsing" || current.state === "failed"
        : expectedState === "awaiting_approval"
          ? current.state === "awaiting_approval" || current.state === "failed"
        : current.state === expectedState
    ) {
      return current;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Ingestion Run ${runId} did not reach ${expectedState ?? "a terminal collection-phase state"}; current state is ${current.state}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function clearActiveRunForNextScenario(): Promise<D1Result<unknown>> {
  return env.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET active_ingestion_run_id = NULL WHERE singleton = 1",
  ).run();
}

async function showCollection(
  runId: string,
): Promise<CollectionDocument> {
  const response = await administrationRequest(
    `/v1/ingestion-runs/${runId}/evidence`,
    "GET",
  );
  expect(response.status).toBe(200);
  return response.json<CollectionDocument>();
}
