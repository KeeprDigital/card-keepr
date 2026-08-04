import syntheticOfficialSource, {
  officialPublisherPayloadScript,
} from "./synthetic-official-source.mjs";
import {
  productionSourceFixtureMarker,
  productionSourceFixtureSurface,
} from "../../apps/ingestion/test/production-source-fixture-routing.ts";

const fixtureMarker = "card-keepr-acceptance-fusion-world-issue-32";
let activeScenarioMarker = fixtureMarker;

export default {
  async fetch(request) {
    const response = await syntheticOfficialSource.fetch(request);
    const marker = productionSourceFixtureMarker(request.headers);
    if (marker?.startsWith(fixtureMarker)) activeScenarioMarker = marker;
    const scenarioMarker = marker?.startsWith(fixtureMarker)
      ? marker
      : activeScenarioMarker;
    const surface = productionSourceFixtureSurface(request.headers);
    const requestRole = request.headers.get("user-agent")?.match(
      /(?:^|;\s*)request-role=(surface|listing|detail|product_detail|image)(?:;|$)/u,
    )?.[1] ?? null;
    const requestUrl = new URL(request.url);
    if (
      requestUrl.pathname === "/fw/en/cardlist/" &&
      (surface === "card-search" || requestRole === "listing")
    ) {
      return htmlResponse(
        response,
        fusionWorldCardSearchPage(requestUrl, scenarioMarker),
      );
    }
    if (
      requestUrl.pathname === "/fw/en/cardlist/detail.php" &&
      requestRole === "detail"
    ) {
      return htmlResponse(response, fusionWorldCardDetailPage(scenarioMarker));
    }
    if (
      !marker?.startsWith(fixtureMarker) ||
      ![
        "card-search",
        "products",
        "releases",
        "legality-current",
        "legality-history",
        "errata",
      ].includes(surface) ||
      (surface === "errata" && marker !== `${fixtureMarker}-errata`) ||
      !response.headers.get("content-type")?.startsWith("text/html")
    ) {
      return response;
    }

    const html = await response.text();
    if (surface === "errata" && marker === `${fixtureMarker}-errata`) {
      return htmlResponse(
        response,
        `<html><title>BANDAI DRAGON BALL CARD ERRATA</title><main>
          <article class="erratum" data-erratum-id="fusion-world-erratum-fb99-001">
            <dl>
              <dt>Card Number</dt><dd>FB99-001</dd>
              <dt>Published On</dt><dd>2026-07-15</dd>
              <dt>Effective From</dt><dd>2026-07-15</dd>
              <dt>Before</dt><dd>Official printed rules</dd>
              <dt>After</dt><dd>Official corrected rules</dd>
              <dt>Note</dt><dd>The corrected wording applies from the published date.</dd>
            </dl>
            <img src="https://www.dbs-cardgame.com/fw/images/FB99-001-errata.png">
          </article>
        </main></html>`,
      );
    }
    const script = html.match(new RegExp(
      `<script type="application/json" id="fusion-world-card-game-${surface}-data">([\\s\\S]*?)</script>`,
      "u",
    ));
    if (script === null) return response;

    const payload = JSON.parse(script[1]);
    if (surface === "card-search") {
      completeCardSearchPayload(payload, marker);
    } else if (surface === "products") {
      payload.result.partitions
        .find(({ bucket }) => bucket === "coming-soon")
        .entries.push(comingSoonProduct());
      payload.result.partitions
        .find(({ bucket }) => bucket === "coming-soon").total = 1;
    } else if (surface === "releases") {
      payload.events.partitions[0].entries.push({
        product: comingSoonProduct(),
        release: {
          productCode: "FB-COMING-02",
          releaseId: "fusion-world-coming-02-announcement",
          region: "EN-US",
          precision: "unknown",
          date: null,
          status: "announced",
        },
      });
      payload.events.partitions[0].total += 1;
    } else if (
      surface === "legality-current" || surface === "legality-history"
    ) {
      payload.declared_record_count = 1;
      payload.partition.total = 1;
      payload.entries = [fusionWorldLegalityRule(surface)];
    }

    const replacement = officialPublisherPayloadScript(
      "fusion-world-en",
      surface,
      payload,
    );
    return htmlResponse(response, html.replace(script[0], replacement));
  },
};

function completeCardSearchPayload(payload, marker) {
  const detail = payload.detail_pages[0];
  const locator = `${detail.card_number}_p2`;
  detail.detail_path = locator;
  detail.variant = "_p2";
  payload.result.partitions[0].entries[0].detail = locator;

  const repeated = structuredClone(payload.result.partitions[0].entries[0]);
  payload.result.partitions[1].entries = [repeated];
  payload.result.partitions[1].total = 1;

  if (marker === `${fixtureMarker}-capped-leaf`) {
    payload.result.partitions[0].result_cap = "Too many search results";
  } else if (marker === `${fixtureMarker}-mismatched-detail`) {
    detail.card_number = "FB99-999";
  } else if (marker === `${fixtureMarker}-missing-leader-face`) {
    detail.image_urls = detail.image_urls.filter(({ role }) => role !== "back");
  } else if (marker === `${fixtureMarker}-conflicting-locator`) {
    const conflicting = structuredClone(
      payload.result.partitions[0].entries[0],
    );
    conflicting.number = "FB99-999";
    payload.result.partitions[0].entries.push(conflicting);
    payload.result.partitions[0].total = 2;
  }
}

function fusionWorldCardSearchPage(url, marker) {
  const facets = `<section class="searchColSet">
    <input type="checkbox" name="card_type[]" value="Leader">
    <input type="checkbox" name="color[]" value="Red">
    <input type="checkbox" name="cost[]" value="1">
  </section>`;
  const completeLeaf =
    url.searchParams.getAll("card_type[]").length === 1 &&
    url.searchParams.getAll("color[]").length === 1 &&
    url.searchParams.getAll("cost[]").length === 1;
  if (!completeLeaf) {
    return `<html><title>BANDAI DRAGON BALL CARD search</title>
      ${facets}<main><article>Official card search filters.</article></main>
    </html>`;
  }
  const entry = (number, label) => `<li class="cardItem">
    <a href="javascript:void(0);" data-card-number="${number}"
       data-src="detail.php?card_no=FB99-001&amp;p=_p2">
      <img src="../../images/cards/card/noimage.webp"
           data-src="../../images/cards/card/en/FB99-001_p2.webp"
           alt="${number} ${label}">
    </a>
  </li>`;
  const conflicting = marker === `${fixtureMarker}-conflicting-locator`
    ? entry("FB99-999", "Conflicting Leader")
    : "";
  const cap = marker === `${fixtureMarker}-capped-leaf`
    ? "<p>More than 1,000 results were capped</p>"
    : "";
  return `<html><title>BANDAI DRAGON BALL CARD search</title>${facets}
    <main>${cap}<div class="resultTxt">Result<span class="num">1</span>cards</div>
      <ul>${entry("FB99-001", "Fusion Leader")}${conflicting}</ul>
    </main>
  </html>`;
}

function fusionWorldCardDetailPage(marker) {
  const cardNumber = marker === `${fixtureMarker}-mismatched-detail`
    ? "FB99-999"
    : "FB99-001";
  const back = marker === `${fixtureMarker}-missing-leader-face`
    ? ""
    : `<section class="card-face" data-face="back">
        <img src="/fw/images/cards/FB99-001_p2-back.png">
        <dl><dt>Name</dt><dd>Fusion Leader Back</dd></dl>
        <dl><dt>Power</dt><dd>15000</dd></dl>
        <dl><dt>Special Trait</dt><dd>Test</dd></dl>
        <dl><dt>Skill</dt><dd>Official back skill</dd></dl>
      </section>`;
  return `<html><main data-card-id="FB99-001_p2">
    <h1>Fusion Leader</h1>
    <dl><dt>Card Number</dt><dd>${cardNumber}</dd></dl>
    <dl><dt>Card Type</dt><dd>Leader</dd></dl>
    <dl><dt>Color</dt><dd>Red</dd></dl>
    <dl><dt>Cost</dt><dd>1</dd></dl>
    <dl><dt>Specified Cost</dt><dd>Red 1</dd></dl>
    <dl><dt>Power</dt><dd>10000</dd></dl>
    <dl><dt>Combo Power</dt><dd>5000</dd></dl>
    <dl><dt>Special Trait</dt><dd>Test</dd></dl>
    <dl><dt>Effect</dt><dd>Official printed rules</dd></dl>
    <a href="/fw/en/products/" data-product-code="FB-RAW-01">
      Fusion World Raw Product
    </a>
    <section class="card-face" data-face="front">
      <img src="/fw/images/cards/FB99-001_p2-front.png">
      <dl><dt>Name</dt><dd>Fusion Leader Front</dd></dl>
      <dl><dt>Power</dt><dd>10000</dd></dl>
      <dl><dt>Special Trait</dt><dd>Test</dd></dl>
      <dl><dt>Skill</dt><dd>Official front skill</dd></dl>
    </section>
    ${back}
  </main></html>`;
}

function comingSoonProduct() {
  return {
    productCode: "FB-COMING-02",
    productName: "Fusion World Coming Soon Product",
    distribution: {
      code: "FB-COMING-02-distribution",
      kind: "product",
      label: "Fusion World Coming Soon Product distribution",
      product_reference: {
        kind: "official_code",
        value: "FB-COMING-02",
      },
    },
  };
}

function fusionWorldLegalityRule(surface) {
  const historical = surface === "legality-history";
  return {
    rule_ref: historical
      ? "fusion-world-history-fb99-001"
      : "fusion-world-current-fb99-001",
    notice:
      "FB99-001 is eligible for Standard events in the EN-OCEANIA region.",
    market: "EN-OCEANIA",
    play_format: "standard",
    tier: null,
    active_on: historical ? "2025-01-01" : "2026-01-01",
    expires_on: historical ? "2025-12-31" : null,
    cards: ["FB99-001"],
    directive: "eligible",
  };
}

function htmlResponse(response, body) {
  return new Response(body, {
      status: response.status,
      headers: response.headers,
  });
}
