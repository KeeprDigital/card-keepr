import {
  onePieceCompleteOfficialSourceResponse,
} from "../../../acceptance/fixtures/one-piece-complete-official-source.mjs";
import {
  contextualLegalityFixtureDocument,
} from "../../../apps/ingestion/test/contextual-legality-fixture.ts";
import { transportOutcomeForPath } from "./failure-injection.ts";
import { isSyntheticOfficialSourceHost } from "./hostnames.ts";
import {
  officialBandaiNavigationHeader,
  officialDiscoveryDefinitions,
  officialDiscoveryDocument,
  officialPublisherPayloadScript,
  officialRawSurfacePayload,
} from "./official-source-fixtures.mjs";
import {
  productionOfficialStageResponse,
  productionRepresentableFusionLegalityResponse,
  productionSourceFixtureMarker,
  productionSourceFixtureRole,
} from "./production-source-fixture-routing.ts";
import { reconciliationSourceDocument } from "./reconciliation-documents.ts";
import { retainedOfficialDiscoveryResponse } from "./retained-bytes.ts";
import type { PublisherScenario } from "./scenario.ts";

// The scenario catalogue behind the ingestion workers-pool suites
// (apps/ingestion/test). Official Source hostnames answer with marker-selected
// publications over the retained discovery roots and the generic production
// stage; synthetic *.official-source.invalid hostnames answer with raw
// surfaces, reconciliation documents, and path-selected transport outcomes.

function rewrittenOnePieceCompleteResponse(
  request: Request,
  markerPattern: RegExp,
): Response | null {
  const headers = new Headers(request.headers);
  headers.set(
    "user-agent",
    (headers.get("user-agent") ?? "").replace(
      markerPattern,
      "card-keepr-one-piece-complete-v1",
    ),
  );
  return onePieceCompleteOfficialSourceResponse(
    new Request(request.url, {
      method: request.method,
      headers,
    }),
  );
}

function paginatedGundamCollectionResponse(
  request: Request,
  officialNavigation: string,
): Response | null {
  const url = new URL(request.url);
  const markedScenario = productionSourceFixtureMarker(request.headers) ===
    "card-keepr-gundam-pagination-v4";
  if (
    !markedScenario ||
    (
      !url.pathname.startsWith("/asia-en/") &&
      !url.pathname.startsWith("/jp/images/cards/card/")
    )
  ) return null;
  if (/^\/jp\/images\/cards\/card\/GD02-00[1-4]\.png$/u.test(url.pathname)) {
    return new Response(new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    ]), { headers: { "content-type": "image/png" } });
  }
  if (url.pathname === "/asia-en/rules/") {
    // Issue #58: the rules hub is a discovery stage that links the current
    // banned/restricted publication captured directly as the legality
    // surface.
    return new Response(`<html><title>RULES | GUNDAM CARD GAME</title>
      <main><a href="/asia-en/news/01_279.html">Current List of Banned / Restricted Cards</a></main></html>`, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (url.pathname === "/asia-en/news/01_279.html") {
    return new Response(`<html><title>BANDAI gundam CARD PRODUCT RELEASE RULE ERRATA RESTRICTION</title>
      <main><h1>Restriction Rules</h1><p>0 records</p>
      <article data-publication-empty="true">No restrictions are currently published.</article>
      </main></html>`, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (url.pathname === "/asia-en/cards/") {
    const selectedPackage = url.searchParams.get("package");
    const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
    if (selectedPackage === null) {
      // The restructured packages root renders the publisher's empty search
      // state and enumerates every package from it.
      return new Response(`<html><title>CARDS | GUNDAM CARD GAME</title>
        ${officialNavigation}<main>
        <section class="errorCol">
          <h4 class="errorTit">Please specify your search criteria.</h4>
        </section>
        <a class="js-selectBtn-package" data-val="619102" href="javascript:void(0);">Dual Impact [GD02]</a>
        </main></html>`, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    const locators = page === 1
      ? ["GD02-001", "GD02-002"]
      : ["GD02-002", "GD02-003", "GD02-004"];
    const pageIdentity = page === 1
      ? ""
      : `<input type="hidden" name="page" value="${page}">`;
    const pager = page === 1
      ? '<div class="pager"><a href="?package=619102&amp;page=2">2</a></div>'
      : '<div class="pager"></div>';
    return new Response(`<html><title>CARDS | GUNDAM CARD GAME</title>
      ${officialNavigation}<main><section>
      <input type="hidden" name="package" value="619102">${pageIdentity}
      <div class="resultTxt"><span class="num">4</span>cards found.</div>
      <ul>${locators.map((locator) =>
        `<li class="cardItem"><a data-src="detail.php?detailSearch=${locator}">Card</a></li>`
      ).join("")}</ul>${pager}</section></main></html>`, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (url.pathname === "/asia-en/cards/detail.php") {
    const locator = url.searchParams.get("detailSearch");
    if (locator === null || !/^GD02-00[1-4]$/u.test(locator)) return null;
    return new Response(`<html><main><article class="article cardDetailPageCol">
      <div class="cardNo">${locator}</div><div class="rarity">C</div><div class="blockIcon">-</div>
      <h1 class="cardName">Paginated ${locator}</h1>
      <div class="cardImage"><img src="../../jp/images/cards/card/${locator}.png"></div>
      <dl><dt>Lv.</dt><dd>1</dd></dl><dl><dt>COST</dt><dd>1</dd></dl>
      <dl><dt>COLOR</dt><dd>Blue</dd></dl><dl><dt>TYPE</dt><dd>UNIT</dd></dl>
      <div class="cardDataRow overview"><div class="dataTxt isRegular">Official effect.</div></div>
      <dl><dt>Zone</dt><dd>-</dd></dl><dl><dt>Trait</dt><dd>Test</dd></dl>
      <dl><dt>Link</dt><dd>-</dd></dl><dl><dt>AP</dt><dd>1</dd></dl><dl><dt>HP</dt><dd>1</dd></dl>
      <dl><dt>Source Title</dt><dd>Pagination Test</dd></dl>
      <dl><dt>Where to get it</dt><dd>Dual Impact [GD02]</dd></dl>
      </article></main></html>`, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  return null;
}

type DigimonArtworkVariant =
  | "base"
  | "base-reencoded"
  | "no-artwork-id"
  | "alternate"
  | "alternate-two";

// The artwork-digest scenario selects its variant through the marker the
// listing request carries; every derived detail and image request repeats
// that marker, so the variant is read per request instead of remembered.
function digimonArtworkVariantForMarker(
  marker: string | null,
): DigimonArtworkVariant {
  if (marker === null) return "base";
  return marker.endsWith("base-reencoded")
    ? "base-reencoded"
    : marker.endsWith("no-artwork-id")
      ? "no-artwork-id"
      : marker.endsWith("alternate-two")
        ? "alternate-two"
        : marker.endsWith("alternate")
          ? "alternate"
          : "base";
}

export const workersPoolOfficialSourceScenario: PublisherScenario = (
  context,
) => {
  if (context.lineage === null) return null;
  const { request, url } = context;
  const officialLineage = context.lineage;
  const artworkMarker = context.marker;
  const fixtureSurface = context.surface;
  const officialNavigation = officialBandaiNavigationHeader(
    officialLineage,
    {
      omitLast:
        artworkMarker === "card-keepr-incomplete-discovery-v3",
    },
  );
  const retainedDiscovery = retainedOfficialDiscoveryResponse(
    officialLineage,
    request,
    {
      marker: artworkMarker,
      etag: `"${officialLineage}-retained-discovery"`,
    },
  );
  if (retainedDiscovery !== null) return retainedDiscovery;
  const paginatedGundam = paginatedGundamCollectionResponse(
    request,
    officialNavigation,
  );
  if (paginatedGundam !== null) return paginatedGundam;
  const representableFusionLegality =
    productionRepresentableFusionLegalityResponse(request);
  if (representableFusionLegality !== null) {
    return representableFusionLegality;
  }
  if (officialLineage === "one-piece-en") {
    const completeChildResponse =
      onePieceCompleteOfficialSourceResponse(request);
    if (completeChildResponse !== null) {
      return completeChildResponse;
    }
    if (
      artworkMarker === "card-keepr-official-source/1" &&
      url.pathname.startsWith("/images/cardlist/card/OP31-")
    ) {
      const completeImageResponse =
        rewrittenOnePieceCompleteResponse(
          request,
          /^card-keepr-official-source\/1/u,
        );
      if (completeImageResponse !== null) {
        return completeImageResponse;
      }
    }
  }
  if (
    artworkMarker?.startsWith("card-keepr-runtime-parser/") &&
    officialLineage === "one-piece-en" &&
    url.pathname === "/cardlist/"
  ) {
    if (
      productionSourceFixtureRole(request.headers) === "surface"
    ) {
      const failure = artworkMarker.slice(
        "card-keepr-runtime-parser/".length,
      ).split("-", 1)[0];
      const rawSurface = officialRawSurfacePayload(
        "/one-piece-en/card-list",
      )!;
      const pageInfo = rawSurface.page_info as Record<
        string,
        unknown
      >;
      if (failure === "cap") {
        pageInfo.cap_signal = "Too many search results";
      } else {
        const page = (
          pageInfo.partitions as Array<Record<string, unknown>>
        )[0]!;
        page.pages = 2;
        page.has_next = true;
      }
      return new Response(
        `<html><title>BANDAI ONE PIECE CARD LIST</title>${
          officialPublisherPayloadScript(
            "one-piece-en",
            "card-list",
            rawSurface,
          )
        }</html>`,
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
            etag: `"runtime-parser-${failure}"`,
          },
        },
      );
    }
  }
  if (
    artworkMarker?.startsWith("card-keepr-runtime-parser/") &&
    officialLineage === "one-piece-en"
  ) {
    const completeResponse = rewrittenOnePieceCompleteResponse(
      request,
      /^card-keepr-runtime-parser\/[^;]+/u,
    );
    if (completeResponse !== null) return completeResponse;
  }
  if (
    (
      artworkMarker === "card-keepr-one-piece-release-timing-v2" ||
      artworkMarker === "card-keepr-one-piece-unrecognized-release-v2"
    ) &&
    officialLineage === "one-piece-en" &&
    url.pathname !== "/products/"
  ) {
    const completeResponse = rewrittenOnePieceCompleteResponse(
      request,
      /^card-keepr-one-piece-(?:release-timing|unrecognized-release)-v2/u,
    );
    if (completeResponse !== null) return completeResponse;
  }
  if (
    artworkMarker === "card-keepr-staged-discovery-gap-v3" &&
    officialLineage === "fusion-world-en" &&
    url.pathname === "/fw/en/cardlist/"
  ) {
    return new Response(
      `<html><title>Publisher stage unavailable</title><main>Publisher stage unavailable.</main></html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          etag: '"staged-discovery-gap"',
        },
      },
    );
  }
  if (
    (
      artworkMarker === "card-keepr-one-piece-release-timing-v2" ||
      artworkMarker === "card-keepr-one-piece-unrecognized-release-v2" ||
      url.searchParams.get("recording") === "1"
    ) &&
    url.hostname === "en.onepiece-cardgame.com" &&
    url.pathname === "/cardlist/"
  ) {
    const isLeaf = url.searchParams.get("recording") === "1";
    return new Response(
      `<html>
        <title>BANDAI ONE PIECE CARD LIST</title>
        ${officialNavigation}
        <select id="recording">
          <option value="1">All recordings</option>
        </select>
        <div class="countCol">${isLeaf ? 1 : 0} results</div>
        ${isLeaf ? `<dl class="modalCol" id="OP01-001" data-artwork-id="op01-001-base">
          <div class="infoCol"><span>OP01-001</span> | <span>L</span> | <span>Leader</span></div>
          <div class="cardName">Monkey.D.Luffy</div>
          <div class="frontCol"><img data-src="/images/cardlist/card/OP01-001.png"></div>
          <dt>Color</dt><dd>Red</dd>
          <dt>Cost</dt><dd>-</dd>
          <dt>Life</dt><dd>5</dd>
          <dt>Attribute</dt><dd>Strike</dd>
          <dt>Power</dt><dd>5000</dd>
          <dt>Counter</dt><dd>-</dd>
          <dt>Type</dt><dd>Straw Hat Crew</dd>
          <dt>Block icon</dt><dd>1</dd>
          <dt>Effect</dt><dd>Official effective rules</dd>
          <dt>Card Set(s)</dt><dd>Test Card List</dd>
        </dl>` : ""}
      </html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          etag: '"card-keepr-one-piece-card-list-v2"',
        },
      },
    );
  }
  if (
    url.hostname === "en.onepiece-cardgame.com" &&
    url.pathname === "/images/cardlist/card/OP01-001.png"
  ) {
    return new Response(
      new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      ]),
      {
        headers: {
          "content-type": "image/png",
          etag: '"card-keepr-one-piece-card-image-v2"',
        },
      },
    );
  }
  if (
    artworkMarker === "card-keepr-one-piece-release-timing-v2" &&
    url.hostname === "en.onepiece-cardgame.com" &&
    url.pathname === "/products/"
  ) {
    if (fixtureSurface === null) {
      return new Response(
        `<html><title>BANDAI ONE PIECE CARD PRODUCTS</title>
          <main><p>0 records</p><article data-publication-empty="true">No published entries.</article></main>
        </html>`,
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
          etag: '"card-keepr-one-piece-products-stage"',
          },
        },
      );
    }
    const releases = officialRawSurfacePayload(
      "/one-piece-en/releases",
    )! as Record<string, unknown>;
    releases.release_timing_entries = [{
      notice_no: "OP-RELEASE-2026-001",
      published_text:
        "OP01-001 becomes legal for standard tournament play on 2026-09-04.",
      territory: "EN-OCEANIA",
      format_name: "standard",
      event_class: null,
      start_date: "2026-08-01",
      end_date: null,
      card_numbers: ["OP01-001"],
      restriction_code: "release_timing",
      legal_from: "2026-09-04",
    }];
    return new Response(
      `<html>
        <title>BANDAI ONE PIECE CARD RELEASE publication</title>
        ${officialPublisherPayloadScript(
          "one-piece-en",
          fixtureSurface,
          fixtureSurface === "products"
            ? officialRawSurfacePayload("/one-piece-en/products")!
            : releases,
        )}
      </html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
        etag:
          `"card-keepr-one-piece-release-timing-v2-${fixtureSurface}"`,
        },
      },
    );
  }
  if (
    artworkMarker === "card-keepr-one-piece-unrecognized-release-v2" &&
    url.hostname === "en.onepiece-cardgame.com" &&
    url.pathname === "/products/"
  ) {
    if (fixtureSurface === null) {
      return new Response(
        `<html><title>BANDAI ONE PIECE CARD PRODUCTS</title>
          <main><p>0 records</p><article data-publication-empty="true">No published entries.</article></main>
        </html>`,
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
            etag: '"card-keepr-one-piece-products-stage"',
          },
        },
      );
    }
    return new Response(
      `<html>
        <title>BANDAI ONE PIECE CARD RELEASE publication</title>
        ${officialPublisherPayloadScript(
          "one-piece-en",
          fixtureSurface,
          fixtureSurface === "products" ? {
              page: "product-list",
              series_options: [],
              result: {
                cap_signal: null,
                partitions: [{
                  bucket: "recording",
                  page: 1,
                  pages: 1,
                  total: 0,
                  has_next: false,
                  entries: [],
                }],
              },
            } : {
              publication: "release-schedule",
              events: {
                cap_signal: null,
                partitions: [{
                  bucket: "all-releases",
                  page: 1,
                  pages: 1,
                  total: 1,
                  has_next: false,
                  entries: [{
                    product: {
                      product_code: "OP-RAW-01",
                      product_name: "One Piece Raw Product",
                    },
                    release: {
                      product_code: "OP-RAW-01",
                      announcement_id:
                        "OP-RAW-01-EN-OCEANIA-CHANGED",
                      region: "EN-OCEANIA",
                      precision: "day",
                      date: "2026-12-02",
                      status: "released",
                    },
                  }],
                }],
              },
              release_timing_entries: [],
            },
        )}
      </html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          etag: '"card-keepr-one-piece-unrecognized-release-v2"',
        },
      },
    );
  }
  if (
    url.hostname === "en.onepiece-cardgame.com" &&
    url.pathname === "/products/"
  ) {
    return new Response(
      `<html><title>BANDAI ONE PIECE CARD PRODUCTS</title>
        <main><p>0 records</p><article data-publication-empty="true">No published entries.</article></main>
      </html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          etag: '"one-piece-products-and-releases-empty"',
        },
      },
    );
  }
  if (
    artworkMarker === "card-keepr-notice-link-only-legality-v3" &&
    url.hostname === "www.dbs-cardgame.com" &&
    url.pathname === "/fw/en/news/01_305.html"
  ) {
    return new Response(
      `<html>
        <title>BANDAI DRAGON BALL CARD RULE RESTRICTION</title>
        <a href="./new-legality-notice.html">
          New tournament eligibility wording effective immediately
        </a>
      </html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          etag: '"notice-link-only-legality"',
        },
      },
    );
  }
  if (
    artworkMarker === "card-keepr-nonempty-legality-sidecar" &&
    url.hostname === "www.dbs-cardgame.com" &&
    url.pathname === "/fw/en/news/01_305.html"
  ) {
    return new Response(
      `<html>
        <title>BANDAI DRAGON BALL CARD RULE RESTRICTION</title>
        <article>FB30-001 is eligible for Standard play.</article>
      </html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          etag: '"nonempty-legality-sidecar"',
        },
      },
    );
  }
  if (
    artworkMarker === "card-keepr-representable-legality-v3" &&
    request.headers.get("accept-language") ===
      "card-keepr-conflicting-shared-legality-v3" &&
    url.hostname === "www.dbs-cardgame.com" &&
    url.pathname === "/fw/en/news/01_399.html"
  ) {
    const publication = (surface: string, directive: string) => ({
      publication: `fusion-world-${surface}`,
      revision: "2026-08",
      declared_record_count: 1,
      partition: {
        page: 1,
        pages: 1,
        total: 1,
        has_next: false,
      },
      entries: [{
        rule_ref: "fw_production_eligible",
        notice: directive === "eligible"
          ? "FB01-001 is eligible for Standard play."
          : "FB01-001 is banned from Standard decks.",
        market: "EN-OCEANIA",
        play_format: "standard",
        tier: null,
        active_on: "2026-01-01",
        expires_on: null,
        cards: ["FB01-001"],
        directive,
      }],
    });
    return new Response(
      `<html><title>BANDAI DRAGON BALL CARD RULE RESTRICTION</title>
        ${officialPublisherPayloadScript(
          "fusion-world-en",
          "legality-history",
          publication("legality-history", "ban"),
        )}</html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          etag: '"card-keepr-conflicting-shared-legality-v3"',
        },
      },
    );
  }
  if (
    [
      "card-keepr-representable-legality-v3",
      "card-keepr-mixed-modeled-unmodeled-legality-v3",
      "card-keepr-residual-paragraph-legality-v3",
      "card-keepr-residual-div-legality-v3",
      "card-keepr-residual-synonym-legality-v3",
      "card-keepr-unrepresentable-legality-v3",
      "card-keepr-mixed-effect-legality-v3",
      "card-keepr-residual-semantics-legality-v3",
      "card-keepr-definitive-unresolved-legality-v3",
      "card-keepr-missing-combination-side-v3",
      "card-keepr-mismatched-legality-total-v3",
      "card-keepr-truncated-legality-partition-v3",
      "card-keepr-conflicting-shared-legality-v3",
      "card-keepr-conditional-legality-v3",
      "card-keepr-conditional-when-legality-v3",
      "card-keepr-conditional-if-legality-v3",
      "card-keepr-conditional-during-legality-v3",
      "card-keepr-conditional-only-legality-v3",
      "card-keepr-wording-target-omitted-v3",
      "card-keepr-wording-target-mismatch-v3",
      "card-keepr-wording-global-targeted-v3",
      "card-keepr-wording-region-mismatch-v3",
      "card-keepr-wording-region-prefix-mismatch-v3",
      "card-keepr-wording-format-mismatch-v3",
      "card-keepr-wording-tier-omitted-v3",
      "card-keepr-wording-tier-mismatch-v3",
      "card-keepr-multiple-date-release-v3",
      "card-keepr-large-legality-workflow-v3",
    ].includes(artworkMarker ?? "") &&
    url.hostname === "www.dbs-cardgame.com" &&
    (
      url.pathname === "/fw/en/news/01_305.html" ||
      url.pathname === "/fw/en/news/01_399.html"
    )
  ) {
    if (url.pathname === "/fw/en/news/01_399.html") {
      return new Response(
        `<html><title>BANDAI DRAGON BALL CARD RULE RESTRICTION HISTORY</title>
          <main><p>0 records</p><article data-publication-empty="true">No published entries.</article></main>
        </html>`,
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
            etag: `"${artworkMarker}-history"`,
          },
        },
      );
    }
    if (
      artworkMarker === "card-keepr-mismatched-legality-total-v3" ||
      artworkMarker === "card-keepr-truncated-legality-partition-v3"
    ) {
      const truncated = artworkMarker ===
        "card-keepr-truncated-legality-partition-v3";
      return new Response(
        `<html><title>BANDAI DRAGON BALL CARD RULE RESTRICTION</title>
          ${officialPublisherPayloadScript(
            "fusion-world-en",
            "legality-current",
            {
                publication: "fusion-world-legality-current",
                revision: "2026-08",
                declared_record_count: 1,
                partition: {
                  page: 1,
                  pages: truncated ? 2 : 1,
                  total: 1,
                  has_next: truncated,
                },
                entries: [],
              },
          )}</html>`,
        { headers: { "content-type": "text/html; charset=utf-8", etag: `"${artworkMarker}"` } },
      );
    }
    const officialWording = artworkMarker ===
          "card-keepr-representable-legality-v3" ||
        artworkMarker ===
          "card-keepr-mixed-modeled-unmodeled-legality-v3" ||
        artworkMarker ===
          "card-keepr-residual-paragraph-legality-v3" ||
        artworkMarker === "card-keepr-residual-div-legality-v3" ||
        artworkMarker ===
          "card-keepr-residual-synonym-legality-v3"
      ? "FB01-001 is eligible &#39;as printed&#39; &#x2013; publisher&ndash;confirmed &amp;#39;literal&amp;#39;."
      : artworkMarker === "card-keepr-conflicting-shared-legality-v3"
        ? "FB01-001 is banned from Standard decks."
      : artworkMarker === "card-keepr-conditional-legality-v3"
        ? "FB01-001 is banned from Standard decks unless it has the Earth Federation trait."
      : artworkMarker === "card-keepr-conditional-when-legality-v3"
        ? "FB01-001 is banned when your Leader is FB01-999."
      : artworkMarker === "card-keepr-conditional-if-legality-v3"
        ? "FB01-001 is banned if your Leader is FB01-999."
      : artworkMarker === "card-keepr-conditional-during-legality-v3"
        ? "FB01-001 is banned during Championship events."
      : artworkMarker === "card-keepr-conditional-only-legality-v3"
        ? "FB01-001 is banned only at Championship events."
      : artworkMarker === "card-keepr-wording-target-omitted-v3" ||
          artworkMarker === "card-keepr-wording-target-mismatch-v3" ||
          artworkMarker === "card-keepr-wording-format-mismatch-v3"
        ? "FB01-001 is eligible for Standard play."
      : artworkMarker === "card-keepr-wording-global-targeted-v3"
        ? "Cards satisfying the published Standard eligibility rules may be used."
      : artworkMarker === "card-keepr-wording-region-mismatch-v3"
        ? "FB01-001 is eligible for Standard events in the EN-US region."
      : artworkMarker === "card-keepr-wording-region-prefix-mismatch-v3"
        ? "For EN-US, FB01-001 is eligible for Standard play."
      : artworkMarker === "card-keepr-wording-tier-omitted-v3" ||
          artworkMarker === "card-keepr-wording-tier-mismatch-v3"
        ? "For Championship events, decks may contain no more than 1 copy of FB01-001."
      : artworkMarker === "card-keepr-multiple-date-release-v3"
        ? "Starting 2026-01-01, FB01-001 becomes legal for tournament play on 2026-02-01."
      : artworkMarker === "card-keepr-mixed-effect-legality-v3"
        ? "FB01-001 is legal for Standard play, but decks are limited to 1 copy."
        : artworkMarker === "card-keepr-definitive-unresolved-legality-v3"
          ? "FB01-001 is banned from Standard decks."
          : artworkMarker === "card-keepr-missing-combination-side-v3"
            ? "FB01-001 and FB01-002 are a prohibited combination."
        : "FB01-001 is not currently eligible for Standard play.";
    const unresolved = artworkMarker ===
      "card-keepr-definitive-unresolved-legality-v3";
    const missingCombination = artworkMarker ===
      "card-keepr-missing-combination-side-v3";
    const conflictingShared = artworkMarker ===
      "card-keepr-conflicting-shared-legality-v3";
    const largeWorkflow = artworkMarker ===
      "card-keepr-large-legality-workflow-v3";
    const wordingTier = artworkMarker ===
        "card-keepr-wording-tier-omitted-v3" ||
      artworkMarker === "card-keepr-wording-tier-mismatch-v3";
    const wordingTargetOmitted = artworkMarker ===
      "card-keepr-wording-target-omitted-v3";
    const wordingTargetMismatch = artworkMarker ===
      "card-keepr-wording-target-mismatch-v3";
    const multipleDateRelease = artworkMarker ===
      "card-keepr-multiple-date-release-v3";
    const legalityArticles = largeWorkflow
      ? Array.from({ length: 4_000 }, (_, index) => {
        const ordinal = String(index + 1).padStart(4, "0");
        return `<article class="restriction-card">
          <dl>
            <dt>Rule Ref</dt><dd>fw_large_workflow_${ordinal}</dd>
            <dt>Notice</dt><dd>Cards satisfying the published Standard eligibility rules may be used.</dd>
            <dt>Market</dt><dd>EN-OCEANIA</dd>
            <dt>Play Format</dt><dd>standard</dd>
            <dt>Tier</dt><dd>-</dd>
            <dt>Active On</dt><dd>2026-01-01</dd>
            <dt>Expires On</dt><dd>-</dd>
            <dt>Cards</dt><dd>-</dd>
            <dt>Directive</dt><dd>eligible</dd>
          </dl>
        </article>`;
      }).join("")
      : `<article class="restriction-card">
            <dl>
              <dt>Rule Ref</dt><dd>fw_production_eligible</dd>
              <dt>Notice</dt><dd>${officialWording}</dd>
              <dt>Market</dt><dd>EN-OCEANIA</dd>
              <dt>Play Format</dt><dd>${
                artworkMarker === "card-keepr-wording-format-mismatch-v3"
                  ? "unlimited"
                  : "standard"
              }</dd>
              <dt>Tier</dt><dd>${
                artworkMarker === "card-keepr-wording-tier-mismatch-v3"
                  ? "regional"
                  : "-"
              }</dd>
              <dt>Active On</dt><dd>2026-01-01</dd>
              <dt>Expires On</dt><dd>-</dd>
              <dt>Cards</dt><dd>${
                missingCombination || wordingTargetOmitted
                  ? "-"
                  : wordingTargetMismatch ? "FB01-002" : "FB01-001"
              }</dd>
              <dt>Directive</dt><dd>${unresolved ? "unresolved" : missingCombination ? "prohibited_combination" : conflictingShared ? "ban" : wordingTier ? "copy_limit" : multipleDateRelease ? "release_timing" : "eligible"}</dd>
              ${artworkMarker === "card-keepr-mixed-effect-legality-v3"
                ? "<dt>Cap</dt><dd>1</dd>"
                : wordingTier
                  ? "<dt>Cap</dt><dd>1</dd>"
                : multipleDateRelease
                  ? "<dt>Legal From</dt><dd>2026-01-01</dd>"
                : unresolved
                  ? "<dt>Ambiguity</dt><dd>Publisher scope is unknown</dd>"
                  : missingCombination
                    ? "<dt>Paired Cards</dt><dd>FB01-002</dd>"
                    : ""}
            </dl>
            ${artworkMarker === "card-keepr-residual-semantics-legality-v3"
              ? "<p>Except at championship events, where it is banned.</p>"
              : ""}
          </article>
          ${artworkMarker ===
              "card-keepr-mixed-modeled-unmodeled-legality-v3"
            ? `<select aria-label="New restriction notice">
                <option value="FB01-099">
                  FB01-099 may no longer be used in Standard tournament decks.
                </option>
              </select>`
            : ""}`;
    const residualPublication =
      artworkMarker === "card-keepr-residual-paragraph-legality-v3"
        ? "<p>FB01-099 is unavailable for decks.</p>"
        : artworkMarker === "card-keepr-residual-div-legality-v3"
          ? "<div>FB01-099 is unavailable for decks.</div>"
          : artworkMarker === "card-keepr-residual-synonym-legality-v3"
            ? "<p>FB01-099 is unavailable for decks.</p>"
            : "";
    return new Response(
      `<html>
        <title>BANDAI DRAGON BALL CARD RULE RESTRICTION</title>
        <main>
          <p>${largeWorkflow ? 4_000 : 1} records</p>
          ${legalityArticles}
          ${residualPublication}
        </main>
      </html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          etag: `"${artworkMarker}"`,
        },
      },
    );
  }
  if (
    url.hostname === "www.dbs-cardgame.com" &&
    url.pathname === "/fw/en/products/" &&
    artworkMarker === "card-keepr-product-authority"
  ) {
    // The fusion-world-en@9 live listing shape: anchored status
    // sections whose entries carry bracketed identities and one
    // published RELEASE row.
    return new Response(
      `<html>
        <title>BANDAI DRAGON BALL CARD PRODUCTS RELEASE</title>
        <div class="contentsHead">
          <ul class="ankerList">
            <li class="ankerListItem"><a href="#available">AVAILABLE NOW</a></li>
            <li class="ankerListItem"><a href="#comingsoon">COMING SOON</a></li>
          </ul>
        </div>
        <section class="contentsColInner availableCol" id="available">
          <h2 class="listTit">AVAILABLE NOW</h2>
          <ul class="prpductList">
            <li class="prpductListItem cardCol">
              <a href="/fw/en/products/booster/fb-authority/" class="cardLink">
                <h3 class="cardText">Conflicting Product Listing [FB-AUTHORITY]</h3>
                <dl class="cardInfoBox">
                  <dt class="cardInfoTit">RELEASE</dt>
                  <dd class="cardInfoTxt">June 12, 2026</dd>
                </dl>
              </a>
            </li>
          </ul>
        </section>
        <section class="contentsColInner comingsoonCol" id="comingsoon">
          <h2 class="listTit">COMING SOON</h2>
          <ul class="prpductList"></ul>
        </section>
      </html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          etag: '"product-authority-listing"',
        },
      },
    );
  }
  if (
    url.hostname === "world.digimoncard.com" &&
    url.pathname === "/products/" &&
    artworkMarker?.startsWith("card-keepr-product-identity-")
  ) {
    const state = artworkMarker.slice(
      "card-keepr-product-identity-".length,
    );
    const code = state === "codeless"
      ? ""
      : "FB-STABLE";
    return new Response(
      `<html>
        <title>BANDAI DIGIMON CARD PRODUCTS RELEASE</title>
        <article class="booster">
          <a ${code === "" ? "" : `data-product-code="${code}"`}
             href="/products/booster/fb-stable-${state}/">
            Stable Product Identity
          </a>
        </article>
      </html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          etag: `"product-identity-${state}-listing"`,
        },
      },
    );
  }
  if (
    url.hostname === "www.dbs-cardgame.com" &&
    url.pathname === "/fw/en/products/booster/fb-authority/"
  ) {
    return new Response(
      `<html>
        <title>Authoritative Product Detail [FB-AUTHORITY] | Dragon Ball Super Card Game Fusion World - Official Web Site</title>
        <h1>DRAGON BALL SUPER CARD GAME FUSION WORLD</h1>
      </html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          etag: '"product-authority-detail"',
        },
      },
    );
  }
  if (
    url.hostname === "world.digimoncard.com" &&
    url.pathname.startsWith(
      "/products/booster/fb-stable-",
    )
  ) {
    const state = url.pathname.match(
      /fb-stable-(coded|codeless)/u,
    )?.[1];
    // The linked detail page publishes its own bracketed identity,
    // so the listing entry stays the only evidence for FB-STABLE and
    // the code-less refresh matches exactly one published Product.
    return new Response(
      `<html>
        <title>Linked Detail Publication [FB-DETAIL] | Digimon Card Game</title>
        <h1>DIGIMON CARD GAME</h1>
      </html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          etag: `"product-identity-${state}-detail"`,
        },
      },
    );
  }
  if (
    url.hostname === "world.digimoncard.com" &&
    url.pathname === "/cards/index.php" &&
    artworkMarker === "card-keepr-product-fuzzy-warning"
  ) {
    return new Response(
      `<html><title>BANDAI DIGIMON CARD publication</title>
        ${officialNavigation}
        <main><article>
          <a href="/cards/detail.php?card=BT99-999">
            Fuzzy Product Link Test
          </a>
        </article></main></html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          etag: '"digimon-product-fuzzy-list"',
        },
      },
    );
  }
  if (
    url.hostname === "world.digimoncard.com" &&
    url.pathname === "/cards/detail.php" &&
    url.searchParams.get("card") === "BT99-999"
  ) {
    return new Response(
      `<html data-card-id="BT99-999">
        <h1>Fuzzy Product Link Test</h1>
        <dl><dt>Card Number</dt><dd>BT99-999</dd></dl>
        <dl><dt>Card Type</dt><dd>Digimon</dd></dl>
        <dl><dt>Color</dt><dd>Blue</dd></dl>
        <dl><dt>Level</dt><dd>4</dd></dl>
        <dl><dt>Play Cost</dt><dd>5</dd></dl>
        <dl><dt>DP</dt><dd>6,000</dd></dl>
        <dl><dt>Effect</dt><dd>Fuzzy link test effect</dd></dl>
        <dl><dt>Alternative Art</dt><dd>No</dd></dl>
        <a class="product-link"
           href="/products/possible-booster/">
          Possible Booster Product
        </a>
        <img class="card-image"
          src="https://world.digimoncard.com/images/cardlist/card/BT99-999-fuzzy.png">
      </html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          etag: '"digimon-product-fuzzy-detail"',
        },
      },
    );
  }
  if (
    url.hostname === "world.digimoncard.com" &&
    url.pathname === "/images/cardlist/card/BT99-999-fuzzy.png"
  ) {
    return new Response(
      new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00,
      ]),
      {
        headers: {
          "content-type": "image/png",
          etag: '"digimon-product-fuzzy-image"',
        },
      },
    );
  }
  if (
    url.hostname === "world.digimoncard.com" &&
    url.pathname === "/cards/index.php" &&
    artworkMarker?.startsWith("card-keepr-artwork-digest-")
  ) {
    const digimonArtworkVariant = digimonArtworkVariantForMarker(
      artworkMarker,
    );
    return new Response(
      `<html><title>BANDAI DIGIMON CARD publication</title>
        ${officialNavigation}
        <main><article>
          <a href="/cards/detail.php?card=BT99-900">
            Test Digimon detail
          </a>
        </article></main></html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          etag: `"digimon-artwork-list-${digimonArtworkVariant}"`,
        },
      },
    );
  }
  if (
    url.hostname === "world.digimoncard.com" &&
    url.pathname === "/cards/detail.php" &&
    url.searchParams.get("card") === "BT99-900"
  ) {
    const digimonArtworkVariant = digimonArtworkVariantForMarker(
      artworkMarker,
    );
    const locator =
      digimonArtworkVariant === "alternate"
        ? "BT99-900_alt"
        : digimonArtworkVariant === "alternate-two"
          ? "BT99-900_alt_two"
          : digimonArtworkVariant === "no-artwork-id"
            ? "BT99-900_locator"
            : "BT99-900";
    const artworkId =
      digimonArtworkVariant === "alternate"
          ? ' data-artwork-id="digimon-bt99-900-alt-one"'
          : digimonArtworkVariant === "alternate-two"
            ? ' data-artwork-id="digimon-bt99-900-alt-two"'
            : "";
    return new Response(
      `<html data-card-id="${locator}"${artworkId}>
        <h1>Digest Test Digimon</h1>
        <dl><dt>Card Number</dt><dd>BT99-900</dd></dl>
        <dl><dt>Card Type</dt><dd>Digimon</dd></dl>
        <dl><dt>Color</dt><dd>Blue</dd></dl>
        <dl><dt>Level</dt><dd>4</dd></dl>
        <dl><dt>Play Cost</dt><dd>5</dd></dl>
        <dl><dt>DP</dt><dd>6,000</dd></dl>
        <dl><dt>Effect</dt><dd>Digest test effect</dd></dl>
        <dl><dt>Alternative Art</dt><dd>${
          digimonArtworkVariant === "alternate" ||
            digimonArtworkVariant === "alternate-two"
            ? "Yes"
            : "No"
        }</dd></dl>
        <img class="card-image"
          src="https://world.digimoncard.com/images/cardlist/card/BT99-900.png">
      </html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          etag: `"digimon-artwork-detail-${digimonArtworkVariant}"`,
        },
      },
    );
  }
  if (
    url.hostname === "world.digimoncard.com" &&
    url.pathname === "/images/cardlist/card/BT99-900.png"
  ) {
    const digimonArtworkVariant = digimonArtworkVariantForMarker(
      artworkMarker,
    );
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00,
      digimonArtworkVariant === "base-reencoded" ? 0x02 : 0x01,
      0x00, 0x00, 0x00,
      digimonArtworkVariant === "base-reencoded" ? 0x02 : 0x01,
      digimonArtworkVariant === "alternate"
        ? 0x02
        : digimonArtworkVariant === "alternate-two"
          ? 0x04
          : digimonArtworkVariant === "no-artwork-id"
            ? 0x03
            : 0x01,
    ]);
    return new Response(bytes, {
      headers: {
        "content-type": "image/png",
        etag: `"digimon-artwork-image-${digimonArtworkVariant}"`,
      },
    });
  }
  return productionOfficialStageResponse(
    officialLineage,
    request,
    officialNavigation,
  );
};

export const workersPoolSyntheticHostScenario: PublisherScenario = async (
  context,
) => {
  const { request, url } = context;
  if (!isSyntheticOfficialSourceHost(url)) {
    return new Response("unknown synthetic Official Source", {
      status: 404,
    });
  }
  if (url.pathname === "/cards") {
    return new Response(
      '{"cards":[{"card_number":"OP01-001","name":"Roronoa Zoro"}]}',
      {
        headers: {
          "content-type": "application/json; charset=utf-8",
          etag: '"cards-v1"',
        },
      },
    );
  }
  if (url.pathname === "/raw-one-piece-products") {
    return Response.json(
      officialDiscoveryDocument(
        officialDiscoveryDefinitions["/raw-one-piece-products"],
      ),
    );
  }
  const rawSurface = officialRawSurfacePayload(url.pathname);
  if (rawSurface !== null) {
    const surface = url.pathname.slice(
      url.pathname.lastIndexOf("/") + 1,
    );
    if (
      url.searchParams.get("failure") === "cap" &&
      surface === "card-list"
    ) {
      (
        rawSurface.page_info as Record<string, unknown>
      ).cap_signal = "Too many search results";
    }
    if (
      url.searchParams.get("failure") === "pagination" &&
      surface === "card-list"
    ) {
      const page =
        (
          (rawSurface.page_info as Record<string, unknown>)
            .partitions as Array<Record<string, unknown>>
        )[0]!;
      page.pages = 2;
      page.has_next = true;
    }
    const html = [
      "card-list",
      "card-search",
      "packages",
      "products",
    ].includes(surface);
    return new Response(
      html
        ? `<script type="application/json" data-keepr-official-payload>${
          JSON.stringify(rawSurface)
        }</script>`
        : JSON.stringify(rawSurface),
      {
        headers: {
          "content-type": html ? "text/html" : "application/json",
        },
      },
    );
  }
  if (
    url.pathname ===
    "/reconciliation/production-profile-fusion-world"
  ) {
    const document = officialDiscoveryDocument(
      officialDiscoveryDefinitions["/raw-fusion-world-products"],
    ) as { detail_pages: Array<Record<string, unknown>> };
    Object.assign(document.detail_pages[0]!, {
      printing: {
        rarity: "C",
        normalizedRarity: "common",
        attributes: {},
      },
      printed_rules: "Official printed rules",
      variant: "base",
      artwork_fingerprint: `sha256:${"a".repeat(64)}`,
      printed_fields_digest: `sha256:${"b".repeat(64)}`,
      image:
        "https://official-source.invalid/images/FB99-001.png",
    });
    return Response.json(
      document,
    );
  }
  const reconciliationAt =
    url.pathname.indexOf("/reconciliation/");
  if (reconciliationAt !== -1) {
    const scenario = url.pathname.slice(
      reconciliationAt + "/reconciliation/".length,
    );
    if (scenario === "contextual-legality-byte-identity") {
      const document = contextualLegalityFixtureDocument(
        "EN-ASIA",
        "current",
      );
      return new Response(JSON.stringify(
        document,
        null,
        request.headers.get("accept-language") === "en-US" ? 2 : 0,
      ), {
        headers: { "content-type": "application/json" },
      });
    }
    if (scenario === "contextual-legality-byte-disjoint") {
      const document = contextualLegalityFixtureDocument(
        "EN-ASIA",
        "current",
      ) as {
        legality_rules: unknown[];
        legality_completeness: Record<string, unknown>;
      };
      const pretty = request.headers.get("accept-language") === "en-US";
      document.legality_rules = [document.legality_rules[pretty ? 1 : 0]!];
      document.legality_completeness.declared_record_count = 1;
      document.legality_completeness.parsed_record_count = 1;
      return new Response(JSON.stringify(document, null, pretty ? 2 : 0), {
        headers: { "content-type": "application/json" },
      });
    }
    if (scenario === "contextual-legality-byte-empty") {
      const document = contextualLegalityFixtureDocument(
        "EN-ASIA",
        "empty",
      );
      return new Response(JSON.stringify(
        document,
        null,
        request.headers.get("accept-language") === "en-US" ? 2 : 0,
      ), {
        headers: { "content-type": "application/json" },
      });
    }
    return Response.json(
      reconciliationSourceDocument(
        scenario,
        url.searchParams.get("surface") ?? "discovery",
        url.href,
      ),
    );
  }
  const transportOutcome = transportOutcomeForPath(context, url.pathname, {
    redirectLocation: "https://official-source.invalid/cards",
  });
  if (transportOutcome !== null) return transportOutcome;
  return new Response("not found", { status: 404 });
};

export const workersPoolScenarios: readonly PublisherScenario[] = [
  workersPoolOfficialSourceScenario,
  workersPoolSyntheticHostScenario,
];
