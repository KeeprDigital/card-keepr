import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { requiredSourceAdapter } from "../../../src/catalogue/source-adapters";
import {
  officialSourceDiscoveryRequests,
} from "../../../src/catalogue/product-release-source-adapters";
import {
  validateGundamListingCollectionGraph,
} from "../../../src/catalogue/reconciliation-evidence";
import {
  productionSourceFixtureMarker,
} from "./production-source-fixture-routing";
import {
  administrationRequest,
  type CollectionDocument,
  installRuntimeSuite,
  waitForEvidenceRun,
} from "./runtime-helpers";

installRuntimeSuite();

test("synthetic Bandai-shaped paginated Gundam observations close as one collection graph", async () => {
  const adapter = requiredSourceAdapter("gundam-en-asia@5");
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
      adapterVersion: "gundam-en-asia@5",
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
      adapter_version: "gundam-en-asia@5",
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
    "https://www.gundam-gcg.com/asia-en/cards/?package=619102",
    "https://www.gundam-gcg.com/asia-en/cards/?package=619102&page=2",
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
    "https://www.gundam-gcg.com/asia-en/cards/?package=619102",
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
  const discoveryUrl = requiredSourceAdapter("gundam-en-asia@5")
    .requestUrlForDiscovery?.();
  if (discoveryUrl === undefined) {
    throw new Error("Gundam discovery URL is unavailable.");
  }
  const listingUrl =
    "https://www.gundam-gcg.com/asia-en/cards/?package=619102";
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
