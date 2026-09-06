import syntheticOfficialSource, {
  officialPublisherPayloadScript,
} from "./synthetic-official-source.mjs";
import {
  productionSourceFixtureMarker,
  productionSourceFixtureSurface,
} from "../../apps/ingestion/test/production-source-fixture-routing.ts";

const fixtureMarker = "card-keepr-acceptance-fusion-world-issue-32";
// The live Fusion World adapter (fusion-world-en@9) partitions the
// card search by publisher category
// ("Filter by series") instead of card_type/colour/cost checkboxes.
const selectedCategory = "583301";
const siblingCategory = "583302";
// Energy Markers are the one Fusion World family whose detail page publishes
// no rarity block, and they carry a single unvariant locator.
const energyMarkerNumber = "E-99";
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
      return htmlResponse(
        response,
        fusionWorldCardDetailPage(requestUrl, scenarioMarker),
      );
    }
    if (
      !marker?.startsWith(fixtureMarker) ||
      ![
        "products",
        "releases",
        "legality-current",
        "legality-history",
      ].includes(surface) ||
      !response.headers.get("content-type")?.startsWith("text/html")
    ) {
      return response;
    }

    const html = await response.text();
    const script = html.match(new RegExp(
      `<script type="application/json" id="fusion-world-card-game-${surface}-data">([\\s\\S]*?)</script>`,
      "u",
    ));
    if (script === null) return response;

    const payload = JSON.parse(script[1]);
    if (surface === "products") {
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
    } else {
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

function fusionWorldCardSearchPage(url, marker) {
  const category = url.searchParams.get("category[0]");
  const completeLeaf = url.searchParams.get("search") === "true" &&
    category !== null;
  if (!completeLeaf) {
    return `<html><title>BANDAI DRAGON BALL CARD search</title>
      ${categoryFacet([selectedCategory, siblingCategory], null)}
      <main><article>Official card search filters.</article></main>
    </html>`;
  }
  const capped = marker === `${fixtureMarker}-capped-leaf` &&
    category === siblingCategory;
  const conflicting = marker === `${fixtureMarker}-conflicting-locator` &&
    category === selectedCategory;
  const entries = [
    listingEntry("FB99-001", "", "Fusion Leader"),
    listingEntry("FB99-001", "_p2", "Fusion Leader"),
    unvariantListingEntry(energyMarkerNumber, "Energy Marker"),
    ...(conflicting
      // The same full locator claimed by a second, disagreeing Card number.
      ? [listingEntry("FB99-001", "_p2", "Conflicting Leader", "FB99-999")]
      : []),
  ];
  // A capped leaf still offers no further category to descend into, so its
  // result cap can never be resolved by another request.
  const categories = capped ? [siblingCategory] : [
    selectedCategory,
    siblingCategory,
  ];
  return `<html><title>BANDAI DRAGON BALL CARD search</title>
    ${categoryFacet(categories, category)}
    <main>
      ${capped ? "<p>More than 1,000 results were capped</p>" : ""}
      <div class="resultCol" id="cardResult">
        <div class="resultTxt">Result<span class="num">3</span>cards</div>
        <div class="cardCol"><ul>${entries.join("")}</ul></div>
      </div>
    </main>
  </html>`;
}

function categoryFacet(categories, active) {
  const labels = {
    [selectedCategory]: "STORY BOOSTER 99 [FB99]",
    [siblingCategory]: "MANGA BOOSTER 99 [SB99]",
  };
  const option = (value) =>
    `<li><a href="javascript:void(0);" data-val="${value}" class="${
      value === active ? "is-active" : ""
    }">${labels[value]}</a></li>`;
  return `<section class="searchColSet searchColSet-product">
      <h5>Filter by series</h5>
      <div class="filterList"><ul class="filterListItems">
        <li><a href="javascript:void(0);" data-val="" class="">ALL</a></li>
        ${categories.map(option).join("")}
      </ul></div>
    </section>`;
}

function listingEntry(cardNumber, variant, name, altCardNumber = cardNumber) {
  return `<li class="cardItem"><a href="javascript:void(0);" data-fancybox="cards" data-type="iframe" data-src="detail.php?card_no=${cardNumber}${variant ? `&amp;p=${variant}` : ""}" class="cardStr"><img class="lazy" src="../../images/cards/card/noimage.webp" data-src="../../images/cards/card/en/${cardNumber}_f${variant}.webp" alt="${altCardNumber} ${name}"></a></li>`;
}

function unvariantListingEntry(cardNumber, name) {
  return `<li class="cardItem"><a href="javascript:void(0);" data-fancybox="cards" data-type="iframe" data-src="detail.php?card_no=${cardNumber}" class="cardStr"><img class="lazy" src="../../images/cards/card/noimage.webp" data-src="../../images/cards/card/en/${cardNumber}.webp" alt="${cardNumber} ${name}"></a></li>`;
}

function fusionWorldEnergyMarkerDetailPage(marker) {
  // The publisher leaves every gameplay cell as "-" on an Energy Marker and
  // omits the rarity block entirely; the scenario marker restores a rarity to
  // prove the adapter refuses an Energy Marker that publishes one.
  const rarity = marker === `${fixtureMarker}-energy-marker-rarity`
    ? `<div class="rarity">C</div>`
    : "";
  return `<html><title>BANDAI DRAGON BALL CARD detail</title>
  <main class="mainCol"><article class="article cardDetailPageCol">
    <div class="cardDetailPageContent">
      <div class="cardNoCol">
        <div class="cardNo">${energyMarkerNumber}</div>
        ${rarity}
      </div>
      <div class="nameCol">
        <h1 class="cardName">Energy Marker</h1>
      </div>
      <div class="cardCol"><div class="cardColInner"><div class="cardColBox">
        <div class="cardImage">
          <img src="../../images/cards/card/en/${energyMarkerNumber}.webp" alt="${energyMarkerNumber} Energy Marker">
        </div>
      </div></div></div>
      <div class="cardDataCol"><div class="cardData">
        <div class="cardDataRow">
          <div class="cardDataCell">
            <h6>Card type</h6>
            <div class="data">ENERGY MARKER</div>
          </div>
          <div class="cardDataCell">
            <h6>Color</h6>
            <div class="data color-"><div class="colValue" data-color="no-color">-</div></div>
          </div>
          <div class="cardDataCell">
            <h6>Cost</h6>
            <div class="data">-</div>
          </div>
          <div class="cardDataCell">
            <h6>Specified cost</h6>
            <div class="data costIconCol">-</div>
          </div>
          <div class="cardDataCell">
            <h6>Power</h6>
            <div class="data">-</div>
          </div>
          <div class="cardDataCell">
            <h6>Combo power</h6>
            <div class="data">-</div>
          </div>
        </div>
        <div class="cardDataRow">
          <div class="cardDataCell isTraits">
            <h6>Special Traits</h6>
            <div class="data is-nomal">-</div>
          </div>
        </div>
        <div class="cardDataRow">
          <div class="cardDataCell isSkills">
            <h6>Skills</h6>
            <div class="data dataSmall">At the start of the game, the player who goes second places 1 Energy Marker in their Energy Area.</div>
          </div>
        </div>
        <div class="cardDataRow">
          <div class="cardDataCell">
            <h6>Where to get it</h6>
            <div class="data dataSmall">Fusion World Raw Product</div>
          </div>
        </div>
      </div></div>
      <div class="informationCol">
        <h4>Products</h4>
        <div class="productsCol"><div class="productName">Fusion World Raw Product</div></div>
      </div>
    </div>
  </article></main></html>`;
}

function fusionWorldCardDetailPage(url, marker) {
  const requested = url.searchParams.get("card_no") ?? "FB99-001";
  if (requested === energyMarkerNumber) {
    return fusionWorldEnergyMarkerDetailPage(marker);
  }
  const cardNumber = marker === `${fixtureMarker}-mismatched-detail`
    ? "FB99-999"
    : requested;
  const variant = url.searchParams.get("p") ?? "";
  const backImage = marker === `${fixtureMarker}-missing-leader-face`
    ? ""
    : `<div class="cardImageImg img-back">
                  <img src="../../images/cards/card/en/FB99-001_b${variant}.webp" alt="FB99-001 Fusion Leader">
                </div>`;
  return `<html><title>BANDAI DRAGON BALL CARD detail</title>
  <main class="mainCol"><article class="article cardDetailPageCol">
    <div class="cardDetailPageContent">
      <div class="cardNoCol">
        <div class="cardNo">${cardNumber}</div>
        <div class="rarity">L</div>
        <div class="frontBack">FRONT</div>
      </div>
      <div class="nameCol">
        <h1 class="cardName is-back">Fusion Leader Back</h1>
        <h1 class="cardName is-front">Fusion Leader Front</h1>
      </div>
      <div class="cardCol"><div class="cardColInner"><div class="cardColBox">
        <div class="cardImage mode-front">
          <div class="cardImageImg img-front">
            <img src="../../images/cards/card/en/FB99-001_f${variant}.webp" alt="FB99-001 Fusion Leader">
          </div>
          ${backImage}
        </div>
      </div></div></div>
      <div class="cardDataCol"><div class="cardData">
        <div class="cardDataRow">
          <div class="cardDataCell">
            <h6>Card type</h6>
            <div class="data">LEADER</div>
          </div>
          <div class="cardDataCell">
            <h6>Color</h6>
            <div class="data color-red"><div class="colValue" data-color="Red">Red</div></div>
          </div>
          <div class="cardDataCell">
            <h6>Cost</h6>
            <div class="data">1</div>
          </div>
          <div class="cardDataCell">
            <h6>Specified cost</h6>
            <div class="data costIconCol"><span class="costIcon costIcon-red">R</span></div>
          </div>
          <div class="cardDataCell">
            <h6>Power</h6>
            <div class="data is-front">10000</div>
            <div class="data is-back">15000</div>
          </div>
          <div class="cardDataCell">
            <h6>Combo power</h6>
            <div class="data">5000</div>
          </div>
        </div>
        <div class="cardDataRow">
          <div class="cardDataCell isTraits">
            <h6>Special Traits</h6>
            <div class="data is-front">Test</div>
            <div class="data is-back">Test</div>
          </div>
        </div>
        <div class="cardDataRow">
          <div class="cardDataCell isSkills">
            <h6>Skills</h6>
            <div class="data dataSmall is-front dataEffect">Official front skill</div>
            <div class="data dataSmall is-back dataEffect">Official back skill</div>
          </div>
        </div>
        <div class="cardDataRow">
          <div class="cardDataCell">
            <h6>Where to get it</h6>
            <div class="data dataSmall">Fusion World Raw Product</div>
          </div>
        </div>
      </div></div>
      <div class="informationCol">
        <h4>Products</h4>
        <div class="productsCol"><div class="productName">Fusion World Raw Product</div></div>
      </div>
    </div>
  </article></main></html>`;
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
