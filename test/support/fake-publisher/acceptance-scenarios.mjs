import { onePieceCompleteOfficialSourceResponse } from "../../../acceptance/fixtures/one-piece-complete-official-source.mjs";
import { transportOutcomeForPath, transportOutcomeForUserAgent } from "./failure-injection.ts";
import {
  digimonPartitionResponse,
  gundamAccessoryDetailResponse,
  isHtmlSurface,
  officialBandaiDataset,
  officialDiscoveryDefinitions,
  officialDiscoveryDocument,
  officialRawSurfacePayload,
  onePieceBandaiCardList,
  onePixelPng,
} from "./official-source-fixtures.mjs";
import { productionSourceFixtureMarker, productionSourceFixtureSurface } from "./production-source-fixture-routing.ts";
import { retainedOfficialDiscoveryResponse } from "./retained-bytes.ts";

// The scenario catalogue behind the acceptance suites: the synthetic Official
// Source wrangler worker serves it to the real ingestion Worker over the
// OFFICIAL_SOURCE_TRANSPORT service binding. Official Source hostnames answer
// with the synthetic Bandai dataset pages; every other hostname (the worker's
// own local origin) answers with discovery documents and raw surfaces
// addressed by path.

const acceptanceRedirectLocation = "https://synthetic-source.invalid/success";

/** @type {import("./scenario.ts").PublisherScenario} */
export function acceptanceOfficialSourceScenario(context) {
  const { request, url } = context;
  const pathname = url.pathname.replace(/^\/asia-en/, "").replace(/^\/en/, "");
  const transportOutcome = transportOutcomeForUserAgent(context, {
    redirectLocation: acceptanceRedirectLocation,
  });
  if (transportOutcome !== null) return transportOutcome;
  if (pathname === "/success") {
    return Response.json(
      { cards: [{ card_number: "OP01-001", name: "Synthetic Card" }] },
      { headers: { etag: '"synthetic-success-v1"' } },
    );
  }
  if (pathname.startsWith("/raw-one-piece-failure-")) {
    const document = officialDiscoveryDocument(officialDiscoveryDefinitions["/raw-one-piece-products"]);
    if (pathname.endsWith("missing-surface")) {
      delete document.correction_notices;
    } else if (pathname.endsWith("result-cap")) {
      document.card_list.result_cap = 1;
    } else if (pathname.endsWith("pagination")) {
      document.card_list.pages = 2;
      document.card_list.has_next = true;
    }
    return Response.json(document, {
      headers: { etag: `"${pathname.slice(1)}"` },
    });
  }
  const officialLineage = context.lineage;
  if (officialLineage !== null) {
    const onePieceComplete = onePieceCompleteOfficialSourceResponse(request);
    if (onePieceComplete !== null) return onePieceComplete;
    const requestScenarioMarker =
      request.headers.get("accept")?.match(/(?:^|;)\s*card-keepr-digimon-scenario=([^;]+)/u)?.[1] ??
      productionSourceFixtureMarker(request.headers);
    const meaningfulScenarioMarker =
      requestScenarioMarker === "card-keepr-official-source/1" ? null : requestScenarioMarker;
    const officialScenarioMarker = meaningfulScenarioMarker;
    if (url.pathname.includes("/images/")) {
      return new Response(onePixelPng(), {
        headers: {
          "content-type": "image/png",
          etag: `"${officialLineage}-image-v1"`,
        },
      });
    }
    const accessoryDetail = gundamAccessoryDetailResponse(officialLineage, url);
    if (accessoryDetail !== null) return accessoryDetail;
    const digimonPartition = digimonPartitionResponse(url, officialScenarioMarker);
    if (digimonPartition !== null) return digimonPartition;
    const retainedDiscovery = retainedOfficialDiscoveryResponse(officialLineage, request, {
      etag: `"${officialLineage}-retained-discovery-v1"`,
    });
    if (retainedDiscovery !== null) return retainedDiscovery;
    return new Response(
      officialBandaiDataset(
        officialLineage,
        officialScenarioMarker,
        officialLineage === "one-piece-en" && officialScenarioMarker === "card-keepr-acceptance-product/codeless",
        url,
        productionSourceFixtureSurface(request.headers),
      ),
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          etag: `"${officialLineage}-dataset-v1"`,
        },
      },
    );
  }
  if (pathname === "/cardlist/") {
    const parserFailure = request.headers.get("user-agent");
    return new Response(
      onePieceBandaiCardList(
        parserFailure === "card-keepr-acceptance-parser/cap" ||
          parserFailure === "card-keepr-acceptance-parser/pagination"
          ? 2
          : 1,
      ),
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          etag: '"one-piece-card-list-v1"',
        },
      },
    );
  }
  if (pathname === "/products/" || pathname.startsWith("/rules/")) {
    return new Response(
      "<html><title>ONE PIECE CARD GAME PRODUCT RELEASE RULE ERRATA RESTRICTION</title><main>Official Bandai publication surface.</main></html>",
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          etag: `"one-piece-${pathname.replaceAll("/", "-")}-v1"`,
        },
      },
    );
  }
  const raw = officialRawSurfacePayload(pathname);
  if (raw !== null) {
    const surface = pathname.slice(pathname.lastIndexOf("/") + 1);
    if (url.searchParams.get("failure") === "cap" && surface === "card-list") {
      raw.page_info.cap_signal = "Too many search results";
    }
    if (url.searchParams.get("failure") === "pagination" && surface === "card-list") {
      raw.page_info.partitions[0].pages = 2;
      raw.page_info.partitions[0].has_next = true;
    }
    const body = isHtmlSurface(surface)
      ? `<main><script type="application/json" data-keepr-official-payload>${JSON.stringify(raw)}</script></main>`
      : JSON.stringify(raw);
    return new Response(body, {
      headers: {
        "content-type": isHtmlSurface(surface) ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
        etag: `"${pathname.slice(1).replaceAll("/", "-")}-v1"`,
      },
    });
  }
  const definition = officialDiscoveryDefinitions[pathname];
  if (definition !== undefined) {
    return Response.json(officialDiscoveryDocument(definition), { headers: { etag: `"${definition.etag}"` } });
  }
  const pathOutcome = transportOutcomeForPath(context, pathname, {
    redirectLocation: acceptanceRedirectLocation,
  });
  if (pathOutcome !== null) return pathOutcome;
  return null;
}

/** @type {readonly import("./scenario.ts").PublisherScenario[]} */
export const acceptanceScenarios = [acceptanceOfficialSourceScenario];
