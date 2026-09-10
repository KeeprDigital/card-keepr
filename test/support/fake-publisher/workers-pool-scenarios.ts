import { capacitySourceResponse } from "./capacity-workloads.ts";
import { onePieceCompleteOfficialSourceResponse } from "../../../acceptance/fixtures/one-piece-complete-official-source.mjs";
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

function rewrittenOnePieceCompleteResponse(request: Request, markerPattern: RegExp): Response | null {
  const headers = new Headers(request.headers);
  headers.set(
    "user-agent",
    (headers.get("user-agent") ?? "").replace(markerPattern, "card-keepr-one-piece-complete-v1"),
  );
  return onePieceCompleteOfficialSourceResponse(
    new Request(request.url, {
      method: request.method,
      headers,
    }),
  );
}

function paginatedGundamCollectionResponse(request: Request, officialNavigation: string): Response | null {
  const url = new URL(request.url);
  const marker = productionSourceFixtureMarker(request.headers);
  const bounded = marker === "card-keepr-gundam-pagination-bounded";
  const markedScenario = bounded || marker === "card-keepr-gundam-pagination-v4";
  const cardCount = bounded ? 12 : 4;
  const validLocator = (locator: string) =>
    /^GD02-\d{3}$/u.test(locator) && Number(locator.slice(5)) >= 1 && Number(locator.slice(5)) <= cardCount;
  if (!markedScenario || (!url.pathname.startsWith("/asia-en/") && !url.pathname.startsWith("/jp/images/cards/card/")))
    return null;
  if (
    url.pathname.startsWith("/jp/images/cards/card/") &&
    url.pathname.endsWith(".png") &&
    validLocator(
      url.pathname
        .split("/")
        .at(-1)!
        .replace(/\.png$/u, ""),
    )
  ) {
    return new Response(
      new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00,
        0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      ]),
      { headers: { "content-type": "image/png" } },
    );
  }
  if (url.pathname === "/asia-en/cards/") {
    const selectedPackage = url.searchParams.get("package");
    const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
    if (selectedPackage === null) {
      // The restructured packages root renders the publisher's empty search
      // state and enumerates every package from it.
      return new Response(
        `<html><title>CARDS | GUNDAM CARD GAME</title>
        ${officialNavigation}<main>
        <section class="errorCol">
          <h4 class="errorTit">Please specify your search criteria.</h4>
        </section>
        <a class="js-selectBtn-package" data-val="619102" href="javascript:void(0);">Dual Impact [GD02]</a>
        </main></html>`,
        {
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      );
    }
    const locators = bounded
      ? Array.from(
          { length: page === 1 ? 10 : 3 },
          (_, index) => `GD02-${String(index + (page === 1 ? 1 : 10)).padStart(3, "0")}`,
        )
      : page === 1
        ? ["GD02-001", "GD02-002"]
        : ["GD02-002", "GD02-003", "GD02-004"];
    const pageIdentity = page === 1 ? "" : `<input type="hidden" name="page" value="${page}">`;
    const pager =
      page === 1 ? '<div class="pager"><a href="?package=619102&amp;page=2">2</a></div>' : '<div class="pager"></div>';
    return new Response(
      `<html><title>CARDS | GUNDAM CARD GAME</title>
      ${officialNavigation}<main><section>
      <input type="hidden" name="package" value="619102">${pageIdentity}
      <div class="resultTxt"><span class="num">${cardCount}</span>cards found.</div>
      <ul>${locators
        .map((locator) => `<li class="cardItem"><a data-src="detail.php?detailSearch=${locator}">Card</a></li>`)
        .join("")}</ul>${pager}</section></main></html>`,
      {
        headers: { "content-type": "text/html; charset=utf-8" },
      },
    );
  }
  if (url.pathname === "/asia-en/cards/detail.php") {
    const locator = url.searchParams.get("detailSearch");
    if (locator === null || !validLocator(locator)) return null;
    return new Response(
      `<html><main><article class="article cardDetailPageCol">
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
      </article></main></html>`,
      {
        headers: { "content-type": "text/html; charset=utf-8" },
      },
    );
  }
  return null;
}

type DigimonArtworkVariant = "base" | "base-reencoded" | "no-artwork-id" | "alternate" | "alternate-two";

// The artwork-digest scenario selects its variant through the marker the
// listing request carries; every derived detail and image request repeats
// that marker, so the variant is read per request instead of remembered.
function digimonArtworkVariantForMarker(marker: string | null): DigimonArtworkVariant {
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

export const workersPoolOfficialSourceScenario: PublisherScenario = (context) => {
  if (context.lineage === null) return null;
  const { request, url } = context;
  const officialLineage = context.lineage;
  const artworkMarker = context.marker;
  const fixtureSurface = context.surface;
  const officialNavigation = officialBandaiNavigationHeader(officialLineage, {
    omitLast: artworkMarker === "card-keepr-incomplete-discovery-v3",
  });
  const retainedDiscovery = retainedOfficialDiscoveryResponse(officialLineage, request, {
    marker: artworkMarker,
    etag: `"${officialLineage}-retained-discovery"`,
  });
  if (retainedDiscovery !== null) return retainedDiscovery;
  const paginatedGundam = paginatedGundamCollectionResponse(request, officialNavigation);
  if (paginatedGundam !== null) return paginatedGundam;
  if (officialLineage === "one-piece-en") {
    const completeChildResponse = onePieceCompleteOfficialSourceResponse(request);
    if (completeChildResponse !== null) {
      return completeChildResponse;
    }
    if (artworkMarker === "card-keepr-official-source/1" && url.pathname.startsWith("/images/cardlist/card/OP31-")) {
      const completeImageResponse = rewrittenOnePieceCompleteResponse(request, /^card-keepr-official-source\/1/u);
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
    if (productionSourceFixtureRole(request.headers) === "surface") {
      const failure = artworkMarker.slice("card-keepr-runtime-parser/".length).split("-", 1)[0];
      const rawSurface = officialRawSurfacePayload("/one-piece-en/card-list")!;
      const pageInfo = rawSurface.page_info as Record<string, unknown>;
      if (failure === "cap") {
        pageInfo.cap_signal = "Too many search results";
      } else {
        const page = (pageInfo.partitions as Array<Record<string, unknown>>)[0]!;
        page.pages = 2;
        page.has_next = true;
      }
      return new Response(
        `<html><title>BANDAI ONE PIECE CARD LIST</title>${officialPublisherPayloadScript(
          "one-piece-en",
          "card-list",
          rawSurface,
        )}</html>`,
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
            etag: `"runtime-parser-${failure}"`,
          },
        },
      );
    }
  }
  if (artworkMarker?.startsWith("card-keepr-runtime-parser/") && officialLineage === "one-piece-en") {
    const completeResponse = rewrittenOnePieceCompleteResponse(request, /^card-keepr-runtime-parser\/[^;]+/u);
    if (completeResponse !== null) return completeResponse;
  }
  if (
    (artworkMarker === "card-keepr-one-piece-release-timing-v2" ||
      artworkMarker === "card-keepr-one-piece-unrecognized-release-v2") &&
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
    (artworkMarker === "card-keepr-one-piece-release-timing-v2" ||
      artworkMarker === "card-keepr-one-piece-unrecognized-release-v2" ||
      url.searchParams.get("recording") === "1") &&
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
        ${
          isLeaf
            ? `<dl class="modalCol" id="OP01-001" data-artwork-id="op01-001-base">
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
        </dl>`
            : ""
        }
      </html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          etag: '"card-keepr-one-piece-card-list-v2"',
        },
      },
    );
  }
  if (url.hostname === "en.onepiece-cardgame.com" && url.pathname === "/images/cardlist/card/OP01-001.png") {
    return new Response(
      new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00,
        0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
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
    const releases = officialRawSurfacePayload("/one-piece-en/releases")! as Record<string, unknown>;
    releases.release_timing_entries = [
      {
        notice_no: "OP-RELEASE-2026-001",
        published_text: "OP01-001 becomes legal for standard tournament play on 2026-09-04.",
        territory: "EN-OCEANIA",
        format_name: "standard",
        event_class: null,
        start_date: "2026-08-01",
        end_date: null,
        card_numbers: ["OP01-001"],
        restriction_code: "release_timing",
        legal_from: "2026-09-04",
      },
    ];
    return new Response(
      `<html>
        <title>BANDAI ONE PIECE CARD RELEASE publication</title>
        ${officialPublisherPayloadScript(
          "one-piece-en",
          fixtureSurface,
          fixtureSurface === "products" ? officialRawSurfacePayload("/one-piece-en/products")! : releases,
        )}
      </html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          etag: `"card-keepr-one-piece-release-timing-v2-${fixtureSurface}"`,
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
          fixtureSurface === "products"
            ? {
                page: "product-list",
                series_options: [],
                result: {
                  cap_signal: null,
                  partitions: [
                    {
                      bucket: "recording",
                      page: 1,
                      pages: 1,
                      total: 0,
                      has_next: false,
                      entries: [],
                    },
                  ],
                },
              }
            : {
                publication: "release-schedule",
                events: {
                  cap_signal: null,
                  partitions: [
                    {
                      bucket: "all-releases",
                      page: 1,
                      pages: 1,
                      total: 1,
                      has_next: false,
                      entries: [
                        {
                          product: {
                            product_code: "OP-RAW-01",
                            product_name: "One Piece Raw Product",
                          },
                          release: {
                            product_code: "OP-RAW-01",
                            announcement_id: "OP-RAW-01-EN-OCEANIA-CHANGED",
                            region: "EN-OCEANIA",
                            precision: "day",
                            date: "2026-12-02",
                            status: "released",
                          },
                        },
                      ],
                    },
                  ],
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
  if (url.hostname === "en.onepiece-cardgame.com" && url.pathname === "/products/") {
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
    const state = artworkMarker.slice("card-keepr-product-identity-".length);
    const code = state === "codeless" ? "" : "FB-STABLE";
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
  if (url.hostname === "www.dbs-cardgame.com" && url.pathname === "/fw/en/products/booster/fb-authority/") {
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
  if (url.hostname === "world.digimoncard.com" && url.pathname.startsWith("/products/booster/fb-stable-")) {
    const state = url.pathname.match(/fb-stable-(coded|codeless)/u)?.[1];
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
  if (url.hostname === "world.digimoncard.com" && url.pathname === "/images/cardlist/card/BT99-999-fuzzy.png") {
    return new Response(
      new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00,
        0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00,
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
    const digimonArtworkVariant = digimonArtworkVariantForMarker(artworkMarker);
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
    const digimonArtworkVariant = digimonArtworkVariantForMarker(artworkMarker);
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
          digimonArtworkVariant === "alternate" || digimonArtworkVariant === "alternate-two" ? "Yes" : "No"
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
  if (url.hostname === "world.digimoncard.com" && url.pathname === "/images/cardlist/card/BT99-900.png") {
    const digimonArtworkVariant = digimonArtworkVariantForMarker(artworkMarker);
    const bytes = new Uint8Array([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      0x00,
      0x00,
      0x00,
      0x0d,
      0x49,
      0x48,
      0x44,
      0x52,
      0x00,
      0x00,
      0x00,
      digimonArtworkVariant === "base-reencoded" ? 0x02 : 0x01,
      0x00,
      0x00,
      0x00,
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
  return productionOfficialStageResponse(officialLineage, request, officialNavigation);
};

export const workersPoolSyntheticHostScenario: PublisherScenario = async (context) => {
  const { request, url } = context;
  const capacity = capacitySourceResponse(url);
  if (capacity !== null) return capacity;
  if (!isSyntheticOfficialSourceHost(url)) {
    return new Response("unknown synthetic Official Source", {
      status: 404,
    });
  }
  if (url.pathname === "/source-refresh-revalidated" || url.pathname === "/source-refresh-reverted") {
    const previous = request.headers.get("if-none-match");
    if (url.pathname === "/source-refresh-revalidated" && previous === '"refresh-A"')
      return new Response(null, { status: 304, headers: { etag: '"refresh-A"' } });
    const document = reconciliationSourceDocument("base", "discovery", url.href);
    const changed = url.pathname === "/source-refresh-reverted" && previous === '"refresh-A"';
    if (changed) {
      for (const observation of document.cards ?? []) {
        if ("card" in observation && observation.card) observation.card.name = "Changed publisher name";
      }
    }
    return Response.json(document, { headers: { etag: changed ? '"refresh-B"' : '"refresh-A"' } });
  }
  if (url.pathname === "/cards") {
    return new Response('{"cards":[{"card_number":"OP01-001","name":"Roronoa Zoro"}]}', {
      headers: {
        "content-type": "application/json; charset=utf-8",
        etag: '"cards-v1"',
      },
    });
  }
  if (url.pathname === "/raw-one-piece-products") {
    return Response.json(officialDiscoveryDocument(officialDiscoveryDefinitions["/raw-one-piece-products"]));
  }
  const rawSurface = officialRawSurfacePayload(url.pathname);
  if (rawSurface !== null) {
    const surface = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
    if (url.searchParams.get("failure") === "cap" && surface === "card-list") {
      (rawSurface.page_info as Record<string, unknown>).cap_signal = "Too many search results";
    }
    if (url.searchParams.get("failure") === "pagination" && surface === "card-list") {
      const page = ((rawSurface.page_info as Record<string, unknown>).partitions as Array<Record<string, unknown>>)[0]!;
      page.pages = 2;
      page.has_next = true;
    }
    const html = ["card-list", "card-search", "packages", "products"].includes(surface);
    return new Response(
      html
        ? `<script type="application/json" data-keepr-official-payload>${JSON.stringify(rawSurface)}</script>`
        : JSON.stringify(rawSurface),
      {
        headers: {
          "content-type": html ? "text/html" : "application/json",
        },
      },
    );
  }
  if (url.pathname === "/reconciliation/production-profile-fusion-world") {
    const document = officialDiscoveryDocument(officialDiscoveryDefinitions["/raw-fusion-world-products"]) as {
      detail_pages: Array<Record<string, unknown>>;
    };
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
      image: "https://official-source.invalid/images/FB99-001.png",
    });
    return Response.json(document);
  }
  const reconciliationAt = url.pathname.indexOf("/reconciliation/");
  if (reconciliationAt !== -1) {
    const scenario = url.pathname.slice(reconciliationAt + "/reconciliation/".length);
    return Response.json(
      reconciliationSourceDocument(scenario, url.searchParams.get("surface") ?? "discovery", url.href),
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
