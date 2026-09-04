// Official Source publication fixtures shared by every fake-publisher layer:
// discovery definitions, raw surface payloads, publisher payload scripts, and
// the synthetic Bandai dataset pages the acceptance scenarios serve.

// The live Gundam product listings link accessory publications, and the
// restructured product-detail contract fetches and classifies them from their
// retained markup instead of dropping them by URL vocabulary. The page carries
// the exact publisher-suffixed title and the single matching heading the
// contract demands.
const gundamAccessoryPath = "/products/deck-case02.html";
const gundamAccessoryTitle = "Official Card Case Set 02";

function gundamAccessoryLocale(lineage) {
  return lineage === "gundam-en-asia" ? "/asia-en" : "/en";
}

export function gundamAccessoryDetailResponse(lineage, url) {
  if (!lineage.startsWith("gundam-")) return null;
  if (
    url.pathname !== `${gundamAccessoryLocale(lineage)}${gundamAccessoryPath}`
  ) return null;
  return new Response(
    `<html><title>${gundamAccessoryTitle} | GUNDAM CARD GAME Official Website</title>${
      officialBandaiNavigationHeader(lineage)
    }<main>
      <h2 class="mvColTitle">${gundamAccessoryTitle}</h2>
      <p>A card case set that publishes no Cards.</p>
    </main></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        etag: `"${lineage}-accessory-deck-case02-v1"`,
      },
    },
  );
}

function gundamProductListingLinks(lineage, requestUrl) {
  if (
    !lineage.startsWith("gundam-") ||
    requestUrl === undefined ||
    !/\/products\/list\.php$/u.test(requestUrl.pathname)
  ) return "";
  return `<main><a href="${gundamAccessoryLocale(lineage)}${
    gundamAccessoryPath
  }">${gundamAccessoryTitle}</a></main>`;
}

export function digimonPartitionResponse(url, marker) {
  if (
    url.hostname !== "world.digimoncard.com" ||
    url.pathname !== "/cards/index.php" ||
    !url.searchParams.has("category")
  ) return null;
  if (!marker?.startsWith("card-keepr-acceptance-digimon/complete")) {
    return null;
  }
  if (
    url.searchParams.get("category") === "booster" &&
    url.searchParams.get("cardcategory") === "digimon" &&
    url.searchParams.get("colour") === "blue" &&
    marker?.startsWith("card-keepr-acceptance-digimon/complete")
  ) {
    const leafMarker = marker?.startsWith(
        "card-keepr-acceptance-digimon/complete"
      )
      ? marker
      : "card-keepr-acceptance-digimon/complete";
    return new Response(
      officialBandaiDataset(
        "digimon-en",
        leafMarker,
        false,
        url,
        "card-list",
      ),
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          etag: `"digimon-complete-leaf-${url.searchParams.toString()}"`,
        },
      },
    );
  }
  return new Response(
    `<html><title>BANDAI DIGIMON CARD LIST</title>
      <main><p>1 record</p><article data-publication-empty="true">No additional card records.</article></main>
    </html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        etag: `"digimon-partition-${url.searchParams.toString()}"`,
      },
    },
  );
}


const officialLineageNavigationLinks = {
  "one-piece-en": [
    ["FIND CARDS", "/cardlist/"],
    ["ALL PRODUCTS", "/products/"],
    ["RULES", "/rules/"],
  ],
  "fusion-world-en": [
    ["CARDS", "/fw/en/cardlist/"],
    ["ALL PRODUCTS", "/fw/en/products/"],
    ["RULES", "/fw/en/news/01_31.html"],
  ],
  "digimon-en": [
    ["CARD LIST", "/cardlist/"],
    ["PRODUCTS", "/products/"],
    ["RULES", "/rule/"],
  ],
  "gundam-en-asia": [
    ["FIND CARDS", "/asia-en/cards/"],
    ["PRODUCT LIST", "/asia-en/products/list.php"],
    ["RULES", "/asia-en/rules/"],
    ["NEWS", "/asia-en/news/"],
  ],
  "gundam-en-us": [
    ["FIND CARDS", "/en/cards/"],
    ["PRODUCT LIST", "/en/products/list.php"],
    ["RULES", "/en/rules/"],
    ["NEWS", "/en/news/"],
  ],
};

export function officialBandaiNavigationHeader(
  lineage,
  { omitLast = false } = {},
) {
  const links = omitLast
    ? officialLineageNavigationLinks[lineage].slice(0, -1)
    : officialLineageNavigationLinks[lineage];
  return `<header><nav>${links.map(([label, href]) =>
    `<a href="${href}">${label}</a>`
  ).join("")}</nav></header>`;
}

export function officialBandaiDataset(
  lineage,
  parserSignal,
  codeLessProduct = false,
  requestUrl,
  requestSurface = null,
) {
  // The live Digimon adapter (digimon-en@7) pins its current and
  // historical restriction publications to one live URL, so that page must
  // retain identical bytes whichever surface asked for it — it therefore
  // publishes no surface-specific payload. The ?view=history variant is
  // retained as a distinct publication for tests that need separate bytes.
  const sharedRestrictionPage = lineage === "digimon-en" &&
    requestUrl?.pathname === "/rule/restriction_card/" &&
    !requestUrl.searchParams.has("view");
  const surface = sharedRestrictionPage
    ? null
    : officialFixtureSurface(lineage, requestUrl, requestSurface);
  const publication = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    publisher: { "@type": "Organization", name: "Bandai" },
    hasPart: surface === null ? [] : [surface].map((surface) => {
      const payload = officialRawSurfacePayload(`/${lineage}/${surface}`);
      if (lineage === "one-piece-en" && surface === "card-list") {
        payload.card_pages.forEach((card) => {
          delete card.artwork_fingerprint;
          delete card.printed_fields_digest;
        });
      }
      if (lineage === "one-piece-en" && surface === "don-rules") {
        payload.don_card = {
          functional_designation: "DON!!",
          name: "DON!! Card",
          Category: "DON!! Card",
          Effect: "A rules-level resource Card.",
        };
      }
      applyDigimonCompleteFixture(
        payload,
        lineage,
        surface,
        parserSignal,
        requestUrl,
      );
      applyGundamCompleteFixture(
        payload,
        lineage,
        surface,
        requestUrl,
      );
      if (
        lineage === "one-piece-en" &&
        codeLessProduct
      ) {
        makeOnePieceProductCodeLess(surface, payload);
      }
      if (surface === "card-list") {
        if (parserSignal?.endsWith("/cap")) {
          payload.page_info.cap_signal = "Too many search results";
        }
        if (parserSignal?.endsWith("/pagination")) {
          payload.page_info.partitions[0].pages = 2;
          payload.page_info.partitions[0].has_next = true;
        }
        if (parserSignal?.endsWith("/nullability")) {
          payload.card_pages[0].Cost = "1";
        }
      }
      return {
        "@type": "Dataset",
        identifier: `${lineage}:${surface}`,
        payload,
      };
    }),
  };
  const supportedGame = lineage === "one-piece-en"
    ? "one-piece"
    : lineage === "fusion-world-en"
      ? "fusion-world"
      : lineage === "digimon-en"
        ? "digimon"
        : "gundam";
  return `<html><title>BANDAI ${supportedGame} CARD PRODUCT RELEASE RULE ERRATA RESTRICTION</title>${
    officialBandaiNavigationHeader(lineage)
  }${officialBandaiStageNavigation(lineage, requestUrl)}${
    gundamProductListingLinks(lineage, requestUrl)
  }${
    digimonCompleteDiscoveryFacets(lineage, surface, parserSignal)
  }${
    gundamCompleteDiscoveryFacets(lineage, surface, requestUrl)
  }${
    publication.hasPart.map((part) => officialPublisherPayloadScript(
      lineage,
      part.identifier.slice(`${lineage}:`.length),
      part.payload,
    )).join("")
  }${
    sharedRestrictionPage
      ? `<main><p>0 records</p><article data-publication-empty="true">No published entries.</article></main>`
      : ""
  }</html>`;
}

function applyGundamCompleteFixture(
  payload,
  lineage,
  surface,
  requestUrl,
) {
  if (!lineage.startsWith("gundam-") || surface !== "packages") return;
  payload.package_options = [{ value: "all", label: "All packages" }];
  if (!requestUrl.searchParams.has("package")) {
    payload.result = {
      cap_signal: null,
      partitions: [{
        bucket: "package=all",
        page: 1,
        pages: 1,
        total: 0,
        has_next: false,
        entries: [],
      }],
    };
    payload.card_details = [];
    payload.products = [];
    payload.releases = [];
    return;
  }
  for (const detail of payload.card_details ?? []) {
    delete detail.artwork_fingerprint;
    delete detail.printed_fields_digest;
    if (detail.printing !== null && typeof detail.printing === "object") {
      delete detail.printing.normalized_rarity;
    }
  }
}

function gundamCompleteDiscoveryFacets(lineage, surface, requestUrl) {
  if (!lineage.startsWith("gundam-") || surface !== "packages") return "";
  const selected = requestUrl.searchParams.has("package") ? " selected" : "";
  return `<form aria-label="Gundam Card package filter">
    <select name="package">
      <option value="all"${selected}>All packages</option>
    </select>
  </form>`;
}

function applyDigimonCompleteFixture(
  payload,
  lineage,
  surface,
  marker,
  requestUrl,
) {
  if (lineage !== "digimon-en") return;
  if (surface === "card-list") {
    for (const detail of payload.card_popups ?? []) {
      delete detail.artwork_fingerprint;
      delete detail.printed_fields_digest;
      if (detail.printing !== null && typeof detail.printing === "object") {
        delete detail.printing.normalized_rarity;
      }
    }
  }
  const exactLeaf = requestUrl.searchParams.has("category") &&
    requestUrl.searchParams.has("cardcategory") &&
    requestUrl.searchParams.has("colour");
  if (!marker?.startsWith("card-keepr-acceptance-digimon/complete")) {
    if (surface === "card-list" && !exactLeaf) {
      payload.result = {
        cap_signal: null,
        partitions: [{
          bucket: "category=all&cardcategory=digimon&colour=blue",
          page: 1,
          pages: 1,
          total: 0,
          has_next: false,
          entries: [],
        }],
      };
      payload.card_popups = [];
      payload.products = [];
      payload.release_calendar = [];
    }
    return;
  }
  if (
    surface === "restrictions-current" &&
    marker.endsWith("-unrepresentable-rules")
  ) {
    payload.future_rule_semantics = {
      directive: "A player chooses a future publisher-defined action.",
    };
    return;
  }
  if (surface === "errata") {
    if (marker.endsWith("-no-errata")) return;
    payload.declared_record_count = 1;
    payload.partition.total = 1;
    payload.entries = [{
      card_number: "BT99-001",
      published_on: "2026-07-01",
      effective_from: "2026-07-01",
      observed_printed_rules_text: "Synthetic main effect.",
      corrected_rules_text: null,
      official_wording: "Remove the printed effect from this Card.",
      applies_to_parallel_printings: true,
      source_fragment: "#BT99-001",
      display_name: "BT99-001 Erratum",
      image_url:
        "https://world.digimoncard.com/images/BT99-001-standard.png",
    }];
    return;
  }
  if (surface !== "card-list") return;
  if (!exactLeaf) {
    if (marker.endsWith("-malicious-root")) return;
    payload.version_options = [{ value: "booster", label: "Booster" }];
    payload.filters = {
      category: marker.endsWith("-missing-category")
        ? ["booster", "starter"]
        : ["booster"],
      cardcategory: ["digimon"],
      colour: ["blue"],
    };
    payload.result = {
      cap_signal: null,
      partitions: [{
        bucket: "category=booster&cardcategory=digimon&colour=blue",
        page: 1,
        pages: 1,
        total: 0,
        has_next: false,
        entries: [],
      }],
    };
    payload.card_popups = [];
    payload.products = [];
    payload.release_calendar = [];
    return;
  }
  const base = structuredClone(payload.card_popups[0]);
  Object.assign(base, {
    popup_id: "/cards/BT99-001",
    card_number: "BT99-001",
    name: "Synthetic Base Digimon",
    cardcategory: "digimon",
    Color: ["blue", "red"],
    Lv: 6,
    "Play Cost": 11,
    "Use Cost": null,
    DP: 12000,
    Form: "Mega",
    Attribute: "Vaccine",
    Type: ["Synthetic Dragon"],
    "Digivolution Cost": [{
      index: 1,
      from_level: 5,
      colours: ["blue"],
      cost: 4,
      raw_condition: "Blue Lv.5: 4",
    }],
    text_sections: [
      { kind: "effect", text: "Synthetic main effect." },
      {
        kind: "inherited_effect",
        text: "Synthetic inherited effect.",
      },
      { kind: "security_effect", text: "Synthetic security effect." },
      { kind: "dual_effect", text: "Synthetic dual effect." },
      { kind: "dual_rule", text: "Synthetic dual rule." },
      { kind: "link_condition", text: "Synthetic link condition." },
      { kind: "link_effect", text: "Synthetic link effect." },
      {
        kind: "special_digivolution_condition",
        text: "Synthetic special digivolution condition.",
      },
    ],
    "DUAL Color": ["blue", "red"],
    "DUAL Cost": 7,
    "Link DP": 3000,
    Effect: "Synthetic main effect.",
    printed_rules: "Synthetic printed rules.",
    variant: "base",
    image_url:
      "https://world.digimoncard.com/images/BT99-001-standard.png",
    fuzzy_product_labels: ["Possible future Product name"],
    "[Synthetic Future Mechanic]":
      "Retain this future mechanic verbatim",
  });
  base.printing = {
    rarity: "R",
    attributes: { alternative_art: false },
  };
  const alternate = structuredClone(base);
  Object.assign(alternate, {
    popup_id: "/cards/BT99-001_p1",
    name: "Synthetic Alternate-art Presentation",
    variant: "alternate-art-1",
    image_url:
      "https://world.digimoncard.com/images/BT99-001-alternate-1.png",
  });
  alternate.Effect = "Corrected synthetic main effect.";
  alternate.text_sections[0] = {
    kind: "effect",
    text: "Corrected synthetic main effect.",
  };
  alternate.printing.attributes.alternative_art = true;
  if (marker.endsWith("-canonical-conflict")) alternate.DP = 11000;
  payload.version_options = [{ value: "booster", label: "Booster" }];
  payload.filters = {
    category: marker.endsWith("-missing-category")
      ? ["booster", "starter"]
      : ["booster"],
    cardcategory: ["digimon"],
    colour: ["blue"],
  };
  payload.result = {
    cap_signal: null,
    partitions: [{
      bucket: "category=booster&cardcategory=digimon&colour=blue",
      page: 1,
      pages: 1,
      total: 2,
      has_next: false,
      entries: [
        { number: "BT99-001", detail: "/cards/BT99-001" },
        { number: "BT99-001", detail: "/cards/BT99-001_p1" },
      ],
    }],
  };
  payload.card_popups = [base, alternate];
}

function digimonCompleteDiscoveryFacets(lineage, surface, marker) {
  if (
    lineage !== "digimon-en" ||
    surface !== "card-list" ||
    marker === null
  ) return "";
  const category = marker.startsWith(
      "card-keepr-acceptance-digimon/complete"
    )
    ? "booster"
    : "all";
  return `<form aria-label="Digimon Card List filters">
    <select name="category"><option value="${category}">${category}</option></select>
    <select name="cardcategory"><option value="digimon">Digimon</option></select>
    <select name="colour"><option value="blue">Blue</option></select>
  </form><nav aria-label="Complete Digimon leaf partitions">
    <a href="/cards/index.php?search=true&amp;category=${category}&amp;cardcategory=digimon">Digimon type leaf</a>
    <a href="/cards/index.php?search=true&amp;category=${category}&amp;cardcategory=digimon&amp;colour=blue">Blue Digimon leaf</a>
  </nav>`;
}

function officialFixtureSurface(lineage, requestUrl, requestSurface) {
  if (requestSurface !== null) return requestSurface;
  const path = `${requestUrl.pathname}${requestUrl.search}`;
  if (
    (lineage === "one-piece-en" && requestUrl.pathname === "/products/") ||
    (lineage === "fusion-world-en" && requestUrl.pathname === "/fw/en/products/") ||
    (lineage === "digimon-en" && requestUrl.pathname === "/products/") ||
    (lineage.startsWith("gundam-") && /\/products\/list\.php$/u.test(requestUrl.pathname))
  ) {
    return null;
  }
  if (lineage === "one-piece-en") {
    if (requestUrl.pathname === "/cardlist/") return "card-list";
    if (requestUrl.pathname === "/rules/restriction/") return "restrictions";
    if (requestUrl.pathname === "/news/restriction.html") return "restrictions";
    if (requestUrl.pathname === "/rules/block_icon/") return "block-policy";
    if (requestUrl.pathname === "/topics/013.php") return "block-policy";
    if (requestUrl.pathname === "/rules/errata_card/") return "errata";
    if (requestUrl.pathname === "/rules/") return "don-rules";
  } else if (lineage === "fusion-world-en") {
    if (requestUrl.pathname === "/fw/en/cardlist/") return "card-search";
    if (requestUrl.pathname === "/fw/en/rules/banned-limited-cards/") {
      return requestUrl.searchParams.get("view") === "history"
        ? "legality-history"
        : "legality-current";
    }
    if (requestUrl.pathname === "/fw/en/rules/errata-card/") return "errata";
  } else if (lineage === "digimon-en") {
    if (requestUrl.pathname === "/cards/index.php") return "card-list";
    if (requestUrl.pathname === "/rule/restriction_card/") {
      return requestUrl.searchParams.get("view") === "history"
        ? "restrictions-history"
        : "restrictions-current";
    }
    if (requestUrl.pathname === "/rule/errata_card/") return "errata";
  } else if (lineage.startsWith("gundam-")) {
    if (/\/cards\/index\.php$/u.test(requestUrl.pathname)) return "packages";
    if (/\/rules\/$/u.test(requestUrl.pathname)) return "legality";
    // Issue #58: the @7 generation captures the linked current
    // banned/restricted publication directly as its legality surface.
    if (/\/news\/01_279\.html$/u.test(requestUrl.pathname)) return "legality";
    if (
      /\/news\/$/u.test(requestUrl.pathname) &&
      (requestUrl.searchParams.get("subcategory") === "rules" ||
        requestUrl.searchParams.get("subcategory") === "news")
    ) return "errata";
  }
  return null;
}

export function officialPublisherPayloadScript(lineage, surface, payload) {
  const prefix = lineage === "one-piece-en"
    ? "one-piece-card-game"
    : lineage === "fusion-world-en"
      ? "fusion-world-card-game"
      : lineage === "digimon-en"
        ? "digimon-card-game"
        : lineage === "gundam-en-asia"
          ? "gundam-card-game-asia"
          : "gundam-card-game-us";
  return `<script type="application/json" id="${prefix}-${surface}-data">${
    JSON.stringify(payload).replaceAll("<", "\\u003c")
  }</script>`;
}

function officialBandaiStageNavigation(lineage, requestUrl) {
  if (requestUrl === undefined) return "";
  const path = `${requestUrl.pathname}${requestUrl.search}`;
  if (lineage === "one-piece-en" && path === "/rules/") {
    return `<main>
      <a href="/news/restriction.html">Restriction Cards</a>
      <a href="/topics/013.php">Block Policy</a>
      <a href="/rules/errata_card/">Errata Cards</a>
    </main>`;
  }
  if (lineage === "fusion-world-en" && path === "/fw/en/news/01_31.html") {
    return `<main>
      <a href="/fw/en/news/01_305.html">Current banned and limited cards</a>
      <a href="/fw/en/news/01_399.html">Previous restriction history</a>
    </main>`;
  }
  if (lineage === "digimon-en" && path === "/cardlist/") {
    return `<main><a href="/cards/index.php?search=true">Card List</a></main>`;
  }
  if (lineage === "digimon-en" && path === "/rule/") {
    return `<main>
      <a href="/rule/restriction_card/">Current restriction cards</a>
      <a href="/rule/restriction_card/?view=history">Previous restriction history</a>
      <a href="/rule/errata_card/">Errata Cards</a>
    </main>`;
  }
  if (lineage.startsWith("gundam-") && /\/cards\/$/u.test(path)) {
    return `<main><a href="index.php">Find Cards</a></main>`;
  }
  if (lineage.startsWith("gundam-") && /\/rules\/$/u.test(path)) {
    // Issue #58: the rules hub proves the linked current banned/restricted
    // publication that the @7 plan captures directly.
    return `<main><a href="../news/01_279.html">Current List of Banned / Restricted Cards</a></main>`;
  }
  if (lineage.startsWith("gundam-") && /\/news\/$/u.test(path)) {
    return `<main><a href="?subcategory=news&amp;tag=all&amp;page=1">NEWS</a></main>`;
  }
  return "";
}

function makeOnePieceProductCodeLess(surface, payload) {
  if (surface === "card-list") {
    payload.card_pages.forEach((detail) => {
      detail.product_codes = [];
      detail.product_names = [payload.products[0].product_name];
      detail.distribution.product_reference = {
        kind: "name",
        value: payload.products[0].product_name,
      };
    });
    payload.products.forEach((product) => {
      makeOnePieceProductCodeLessRecord(product);
    });
    payload.release_schedule.forEach((release) => {
      release.product_code = null;
      release.product_name = payload.products[0].product_name;
    });
    return;
  }
  if (surface === "products") {
    payload.result.partitions.forEach((partition) => {
      partition.entries.forEach((product) => {
        makeOnePieceProductCodeLessRecord(product);
      });
    });
    return;
  }
  if (surface === "releases") {
    payload.events.partitions.forEach((partition) => {
      partition.entries.forEach(({ product, release }) => {
        makeOnePieceProductCodeLessRecord(product);
        release.product_code = null;
      });
    });
  }
}

function makeOnePieceProductCodeLessRecord(product) {
  const productName = product.product_name;
  product.product_code = null;
  product.distribution = {
    code: "OP-RAW-01-distribution",
    kind: "product",
    label: `${productName} distribution`,
    product_reference: { kind: "name", value: productName },
  };
}

export function onePieceBandaiCardList(declaredCount) {
  return `
    <html><title>ONE PIECE CARD LIST</title>
    <select id="series">
      <option value="synthetic-op99">Synthetic Set [OP99]</option>
    </select>
    <div class="countCol">${declaredCount} results</div>
    <dl class="modalCol" id="OP99-001">
      <dt>
        <div class="infoCol"><span>OP99-001</span> | <span>L</span> | <span>LEADER</span></div>
        <div class="cardName">Synthetic Leader</div>
      </dt>
      <dd>
        <div class="frontCol"><img data-src="../images/OP99-001.png"></div>
        <div class="backCol">
          <div class="cost"><h3>Life</h3>5</div>
          <div class="attribute"><h3>Attribute</h3>Strike</div>
          <div class="power"><h3>Power</h3>5000</div>
          <div class="counter"><h3>Counter</h3>-</div>
          <div class="color"><h3>Color</h3>Red</div>
          <div class="block"><h3>Block icon</h3>1</div>
          <div class="feature"><h3>Type</h3>Test</div>
          <div class="text"><h3>Effect</h3>Official effect</div>
          <div class="getInfo"><h3>Card Set(s)</h3>Synthetic Set [OP99]</div>
        </div>
      </dd>
    </dl></html>`;
}

export const officialDiscoveryDefinitions = {
  "/catalogue-discovery": digimonDefinition(),
  "/raw-one-piece-products": definition({
    format: "one-piece",
    etag: "one-piece-official-v1",
    game: "one-piece",
    profile: "one-piece@1",
    number: "OP99-001",
    productCode: "OP-RAW-01",
    productName: "One Piece Raw Product",
    region: "EN-OCEANIA",
    artworkId: null,
    printing: {
      rarity: "L",
      normalizedRarity: "leader",
      attributes: { illustration_types: [] },
    },
    attributes: {
      card_type: "leader",
      colours: ["red"],
      cost: null,
      life: 5,
      battle_attributes: ["strike"],
      power: 5000,
      counter: null,
      traits: ["Test"],
      block_icons: ["1"],
      effect_text: "Official effect",
      trigger_text: null,
    },
  }),
  "/raw-fusion-world-products": definition({
    format: "fusion-world",
    etag: "fusion-world-official-v1",
    game: "fusion-world",
    profile: "fusion-world@1",
    number: "FB99-001",
    productCode: "FB-RAW-01",
    productName: "Fusion World Raw Product",
    region: "EN-US",
    printing: {
      rarity: null,
      normalizedRarity: null,
      attributes: {},
    },
    attributes: {
      card_type: "leader",
      colours: ["red"],
      cost: 1,
      specified_cost: [{ colour: "red", count: 1 }],
      power: 10000,
      combo_power: 5000,
      traits: ["Test"],
      skills: [{ kind: "ordinary", text: "Official skill" }],
      leader_faces: [
        {
          role: "front",
          name: "Fusion Leader Front",
          power: 10000,
          traits: ["Test"],
          skills: "Official front skill",
        },
        {
          role: "back",
          name: "Fusion Leader Back",
          power: 15000,
          traits: ["Test"],
          skills: "Official back skill",
        },
      ],
    },
  }),
  "/raw-gundam-asia-products": definition({
    format: "gundam-asia",
    etag: "gundam-asia-official-v1",
    game: "gundam",
    profile: "gundam@1",
    number: "GD99-001",
    productCode: "GD-RAW-01",
    productName: "Gundam Cross-region Raw Product",
    region: "EN-ASIA",
    printing: {
      rarity: "R",
      normalizedRarity: "rare",
      attributes: { alternate_art: false },
    },
    attributes: gundamAttributes(),
  }),
  "/raw-gundam-us-products": definition({
    format: "gundam-us",
    etag: "gundam-us-official-v1",
    game: "gundam",
    profile: "gundam@1",
    number: "GD99-001",
    productCode: "GD-RAW-01",
    productName: "Gundam Cross-region Raw Product",
    region: "EN-US",
    printing: {
      rarity: "R",
      normalizedRarity: "rare",
      attributes: { alternate_art: false },
    },
    attributes: gundamAttributes(),
  }),
};

function digimonDefinition() {
  return definition({
    format: "digimon",
    etag: "digimon-official-v1",
    game: "digimon",
    profile: "digimon@1",
    number: "BT99-001",
    productCode: "BT-CARD-BEARING",
    productName: "Card-bearing product",
    region: null,
    printing: {
      rarity: "R",
      normalizedRarity: "rare",
      attributes: { alternative_art: false },
    },
    attributes: {
      card_type: "digimon",
      colours: ["blue"],
      level: 4,
      play_cost: 5,
      use_cost: null,
      dp: 6000,
      form: "Champion",
      attribute: "Data",
      traits: ["Test"],
      digivolution_requirements: [],
      text_sections: [],
      dual_colours: [],
      dual_cost: null,
      link_dp: null,
    },
    extraProducts: [
      {
        code: "BT-PRODUCT-ONLY",
        title: "Product-only announced release",
        distribution: {
          code: "product-only-promotion",
          kind: "promotion",
          label: "Product-only promotion",
        },
        release: {
          region: "unknown",
          precision: "unknown",
          date: null,
          status: "announced",
        },
      },
    ],
  });
}

const rawLineageDefinitions = {
  "one-piece-en": "/raw-one-piece-products",
  "fusion-world-en": "/raw-fusion-world-products",
  "digimon-en": "/catalogue-discovery",
  "gundam-en-asia": "/raw-gundam-asia-products",
  "gundam-en-us": "/raw-gundam-us-products",
};

const rawDiscoveryKeys = {
  "one-piece-en": {
    listing: "card_list",
    details: "card_pages",
    products: "product_catalog",
    releases: "release_schedule",
  },
  "fusion-world-en": {
    listing: "search",
    details: "detail_pages",
    products: "products",
    releases: "releases",
  },
  "digimon-en": {
    listing: "card_index",
    details: "card_details",
    products: "product_index",
    releases: "release_calendar",
  },
  "gundam-en-asia": {
    listing: "card_search",
    details: "card_details",
    products: "product_list",
    releases: "release_list",
  },
  "gundam-en-us": {
    listing: "card_search",
    details: "card_details",
    products: "product_list",
    releases: "release_list",
  },
};

export function officialRawSurfacePayload(pathname) {
  const match = pathname.match(
    /^\/(one-piece-en|fusion-world-en|digimon-en|gundam-en-asia|gundam-en-us)\/([^/]+)$/u,
  );
  if (match === null) return null;
  const [, lineage, surface] = match;
  const definitionPath = rawLineageDefinitions[lineage];
  const keys = rawDiscoveryKeys[lineage];
  const document = officialDiscoveryDocument(
    officialDiscoveryDefinitions[definitionPath],
  );
  const products = document[keys.products].map((product) =>
    upstreamProduct(lineage, product)
  );
  const releases = document[keys.releases].map((release, index) =>
    upstreamRelease(lineage, release, index)
  );
  if (["card-list", "card-search", "packages"].includes(surface)) {
    const discoveryBucket =
      lineage === "one-piece-en"
        ? "recording"
        : lineage === "fusion-world-en"
          ? "card_type=leader&colour=red&cost=1"
          : lineage === "digimon-en"
            ? "category=all&cardcategory=digimon&colour=blue"
            : "package=all";
    const partitionResult = {
      cap_signal: null,
      partitions: [{
        bucket: discoveryBucket,
        page: 1,
        pages: 1,
        total: document[keys.listing].entries.length,
        has_next: false,
        entries: document[keys.listing].entries,
      }, ...(lineage === "fusion-world-en"
        ? [{
            bucket: "card_type=battle&colour=red&cost=1",
            page: 1,
            pages: 1,
            total: 0,
            has_next: false,
            entries: [],
          }]
        : [])],
    };
    const details = document[keys.details].map((detail) =>
      upstreamDetail(lineage, detail)
    );
    if (lineage === "one-piece-en") {
      return {
        page: "card-list",
        series_options: [{ value: "recording", label: "All recordings" }],
        page_info: partitionResult,
        card_pages: details,
        products,
        release_schedule: releases,
        vendor_extension: { future_field: true },
      };
    }
    if (lineage === "fusion-world-en") {
      return {
        view: "card-search",
        facets: {
          card_type: ["leader", "battle"],
          colour: ["red"],
          cost: ["1"],
        },
        result: partitionResult,
        detail_pages: details,
        products,
        releases,
        vendor_extension: { future_field: true },
      };
    }
    if (lineage === "digimon-en") {
      return {
        view: "card-list",
        version_options: [{ value: "en", label: "English" }],
        filters: {
          category: ["all"],
          cardcategory: ["digimon"],
          colour: ["blue"],
        },
        result: partitionResult,
        card_popups: details,
        products,
        release_calendar: releases,
        vendor_extension: { future_field: true },
      };
    }
    return {
      view: "card-search",
      locale: lineage === "gundam-en-asia" ? "EN-ASIA" : "EN-US",
      package_options: [{ value: "all", label: "All packages" }],
      result: partitionResult,
      card_details: details,
      products,
      releases,
      vendor_extension: { future_field: true },
    };
  }
  if (surface === "products") {
    const result = {
      cap_signal: null,
      partitions: [{
        bucket: "all-products",
        page: 1,
        pages: 1,
        total: document[keys.products].length,
        has_next: false,
        entries: products,
      }],
    };
    if (lineage === "one-piece-en") {
      return {
        page: "product-list",
        series_options: ["all"],
        result,
      };
    }
    if (lineage === "fusion-world-en") {
      return {
        view: "products",
        status_tabs: ["available", "coming-soon"],
        result: {
          ...result,
          partitions: [
            { ...result.partitions[0], bucket: "available" },
            {
              bucket: "coming-soon",
              page: 1,
              pages: 1,
              total: 0,
              has_next: false,
              entries: [],
            },
          ],
        },
      };
    }
    if (lineage === "digimon-en") {
      return {
        view: "product-index",
        tile_categories: ["card-sets", "starter-decks"],
        result,
      };
    }
    return {
      view: "product-list",
      locale: lineage === "gundam-en-asia" ? "EN-ASIA" : "EN-US",
      result,
    };
  }
  if (surface === "releases") {
    const products = new Map(
      document[keys.products].map((product) => [
        product.code,
        upstreamProduct(lineage, product),
      ]),
    );
    const entries = document[keys.releases].map((release, index) => ({
      product: products.get(release.code),
      release: upstreamRelease(lineage, release, index),
    }));
    const events = {
      cap_signal: null,
      partitions: [{
        bucket: "all-releases",
        page: 1,
        pages: 1,
        total: entries.length,
        has_next: false,
        entries,
      }],
    };
    if (lineage === "one-piece-en") {
      return {
        publication: "release-schedule",
        events,
        release_timing_entries: [],
      };
    }
    if (lineage === "fusion-world-en") {
      return { publication: "product-release-dates", events };
    }
    if (lineage === "digimon-en") {
      return { publication: "product-release-calendar", events };
    }
    return {
      publication: "locale-product-release-dates",
      locale: lineage === "gundam-en-asia" ? "EN-ASIA" : "EN-US",
      events,
    };
  }
  return {
    publication: policyPublication(lineage, surface),
    ...(lineage.startsWith("gundam-")
      ? { locale: lineage === "gundam-en-asia" ? "EN-ASIA" : "EN-US" }
      : {}),
    revision: "2026-07",
    declared_record_count: 0,
    partition: { page: 1, pages: 1, total: 0, has_next: false },
    entries: [],
  };
}

function upstreamProduct(lineage, product) {
  const rest = {
    ...(product.campaign_note === undefined
      ? {}
      : { campaign_note: product.campaign_note }),
    ...(product.distribution === undefined
      ? {}
      : { distribution: product.distribution }),
    ...(product.vendor_metadata === undefined
      ? {}
      : { vendor_metadata: product.vendor_metadata }),
  };
  if (lineage === "one-piece-en") {
    return {
      product_code: product.code,
      product_name: product.title,
      ...rest,
    };
  }
  if (lineage === "fusion-world-en") {
    return {
      productCode: product.code,
      productName: product.title,
      ...rest,
    };
  }
  if (lineage === "digimon-en") {
    return {
      productId: product.code,
      productTitle: product.title,
      ...rest,
    };
  }
  return {
    productCode: product.code,
    productName: product.title,
    ...rest,
  };
}

function upstreamRelease(lineage, release, index) {
  const eventId =
    release.event_key ?? `${release.code}-${release.region}-${index + 1}`;
  const rest = {
    region: release.region,
    precision: release.precision,
    date: release.date,
    status: release.status,
  };
  if (lineage === "one-piece-en") {
    return {
      product_code: release.code,
      announcement_id: eventId,
      ...rest,
    };
  }
  if (lineage === "fusion-world-en") {
    return { productCode: release.code, releaseId: eventId, ...rest };
  }
  if (lineage === "digimon-en") {
    return {
      productId: release.code,
      calendarEntryId: eventId,
      ...rest,
    };
  }
  return {
    productCode: release.code,
    releaseEventId: eventId,
    ...rest,
  };
}

function upstreamDetail(lineage, detail) {
  const image = officialImageUrl(lineage, detail.image);
  const shared = {
    profile: detail.profile,
    product_codes: detail.product_codes,
    ...(detail.product_names === undefined
      ? {}
      : { product_names: detail.product_names }),
    distribution: detail.distribution,
    ...(detail.printing === undefined
      ? {}
      : {
          printing: {
            rarity: detail.printing.rarity ?? null,
            ...(lineage === "one-piece-en"
              ? {}
              : {
                  normalized_rarity:
                    detail.printing.normalizedRarity ?? null,
                }),
            attributes: detail.printing.attributes,
          },
          printed_rules: detail.printed_rules,
          variant: detail.variant,
          artwork_fingerprint: detail.artwork_fingerprint,
          printed_fields_digest: detail.printed_fields_digest,
        }),
  };
  const attributes = detail.attributes;
  if (lineage === "one-piece-en") {
    return {
      source_record_id: detail.path,
      card_number: detail.number,
      name: detail.title,
      Category: attributes.card_type,
      Color: attributes.colours,
      Cost: attributes.cost,
      Life: attributes.life,
      Attribute: attributes.battle_attributes,
      Power: attributes.power,
      Counter: attributes.counter,
      Type: attributes.traits,
      "Block icon": attributes.block_icons,
      Effect: detail.rules,
      Trigger: attributes.trigger_text,
      image_url: image,
      ...shared,
    };
  }
  if (lineage === "fusion-world-en") {
    const leader = attributes.card_type === "leader";
    return {
      detail_path: detail.path,
      card_number: detail.number,
      name: detail.title,
      card_type: attributes.card_type,
      color: attributes.colours,
      cost: attributes.cost,
      specified_cost: attributes.specified_cost,
      power: attributes.power,
      combo_power: attributes.combo_power,
      special_traits: attributes.traits,
      skills: attributes.skills,
      skills_text: detail.rules,
      ...(attributes.leader_faces === undefined
        ? {}
        : { leader_faces: attributes.leader_faces }),
      image_urls: leader
        ? [
            { role: "front", url: image },
            {
              role: "back",
              url: image.replace(".png", "-back.png"),
            },
          ]
        : [{ role: "front", url: image }],
      product_codes: detail.product_codes,
      ...(detail.product_names === undefined
        ? {}
        : { product_names: detail.product_names }),
      distribution: detail.distribution,
      ...(detail.printing === undefined
        ? {}
        : {
            printing: {
              rarity: detail.printing.rarity ?? null,
              attributes: detail.printing.attributes,
            },
            printed_rules: detail.printed_rules,
            variant: detail.variant,
          }),
    };
  }
  if (lineage === "digimon-en") {
    return {
      popup_id: detail.path,
      card_number: detail.number,
      name: detail.title,
      cardcategory: attributes.card_type,
      Color: attributes.colours,
      Lv: attributes.level,
      "Play Cost": attributes.play_cost,
      "Use Cost": attributes.use_cost,
      DP: attributes.dp,
      Form: attributes.form,
      Attribute: attributes.attribute,
      Type: attributes.traits,
      "Digivolution Cost": attributes.digivolution_requirements,
      text_sections: attributes.text_sections,
      "DUAL Color": attributes.dual_colours,
      "DUAL Cost": attributes.dual_cost,
      "Link DP": attributes.link_dp,
      Effect: detail.rules,
      image_url: image,
      ...shared,
    };
  }
  return {
    detailSearch: detail.path,
    card_number: detail.number,
    name: detail.title,
    Type: attributes.card_type,
    Color: attributes.colours,
    Level: attributes.level,
    Cost: attributes.cost,
    Block: attributes.block_icon,
    Effect: detail.rules,
    Zone: attributes.zone,
    Trait: attributes.traits,
    Link: attributes.link_condition,
    AP: attributes.ap,
    HP: attributes.hp,
    Title: attributes.series_titles,
    image_url: image,
    ...shared,
  };
}

function officialImageUrl(lineage, original) {
  const name = new URL(original).pathname.split("/").pop();
  if (lineage === "one-piece-en") {
    return `https://en.onepiece-cardgame.com/images/${name}`;
  }
  if (lineage === "fusion-world-en") {
    return `https://www.dbs-cardgame.com/fw/images/${name}`;
  }
  if (lineage === "digimon-en") {
    return `https://world.digimoncard.com/images/${name}`;
  }
  const locale = lineage === "gundam-en-asia" ? "asia-en" : "en";
  return `https://www.gundam-gcg.com/${locale}/images/${name}`;
}

export function onePixelPng() {
  const binary = atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function policyPublication(lineage, surface) {
  const prefix =
    lineage === "one-piece-en"
      ? "one-piece"
      : lineage === "fusion-world-en"
        ? "fusion-world"
        : lineage === "digimon-en"
          ? "digimon"
          : "gundam";
  return `${prefix}-${surface}`;
}

export function isHtmlSurface(surface) {
  return ["card-list", "card-search", "packages", "products"].includes(surface);
}

function definition(value) {
  return { extraProducts: [], printing: null, ...value };
}

export function officialDiscoveryDocument(input) {
  const product = {
    code: input.productCode,
    title: input.productName,
    campaign_note: "Optional Official Source marketing copy",
    vendor_metadata: {
      merchandising: {
        channel_code: "official-web",
      },
    },
  };
  const products = [product, ...input.extraProducts];
  const releases = [
    ...(input.region === null
      ? []
      : [{
          code: input.productCode,
          region: input.region,
          precision: "day",
          date: "2026-12-01",
          status: "released",
        }]),
    ...input.extraProducts.flatMap((item) =>
      item.release === undefined ? [] : [{ code: item.code, ...item.release }]
    ),
  ];
  const detail = {
    path: `/cards/${input.number}`,
    number: input.number,
    title: `${input.productName} Card`,
    rules: "Official effective rules",
    profile: input.profile,
    attributes: input.attributes,
    product_codes: [input.productCode],
    distribution: {
      code: `${input.productCode}-distribution`,
      kind: input.format === "digimon" ? "tournament_pack" : "product",
      label: `${input.productName} distribution`,
      product_reference: {
        kind: "official_code",
        value: input.productCode,
      },
    },
    image:
      `https://synthetic-source.invalid/images/${input.number}.png`,
    ...(input.printing === null
      ? {}
      : {
          printing: input.printing,
          printed_rules: "Official printed rules",
          variant: "base",
          artwork_fingerprint: `official-artwork:${
            JSON.stringify({
              official_card_identity:
                input.number.normalize("NFC").trim().toUpperCase(),
              roles:
                input.format === "fusion-world" &&
                  input.attributes.card_type === "leader"
                  ? ["back", "front"]
                  : ["front"],
              artwork_id:
                input.artworkId === undefined
                  ? `${input.game}-${input.number}-standard`
                    .normalize("NFC")
                    .toLocaleLowerCase()
                  : input.artworkId,
            })
          }`,
          printed_fields_digest:
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        }),
  };
  const listing = {
    page: 1,
    pages: 1,
    total: 1,
    has_next: false,
    entries: [{ number: input.number, detail: detail.path }],
  };
  const shared = {
    lineage: input.format,
    listing,
    details: [detail],
    products,
    releases,
    legality: { revision: "2026-07", entries: [] },
    errata: { revision: "2026-07", entries: [] },
  };
  if (input.format === "one-piece") {
    return {
      source: "one-piece-cardlist",
      card_list: listing,
      card_pages: [detail],
      product_catalog: products,
      release_schedule: releases,
      rules_restrictions: shared.legality,
      correction_notices: shared.errata,
    };
  }
  if (input.format === "fusion-world") {
    return {
      source: "fusion-world-card-search",
      search: listing,
      detail_pages: [detail],
      products,
      releases,
      banned_limited: shared.legality,
      errata_notices: shared.errata,
    };
  }
  if (input.format === "digimon") {
    return {
      source: "digimon-card-database",
      card_index: listing,
      card_details: [detail],
      product_index: products,
      release_calendar: releases,
      restricted_cards: shared.legality,
      errata_notices: shared.errata,
    };
  }
  return {
    source: input.format,
    card_search: listing,
    card_details: [detail],
    product_list: products,
    release_list: releases,
    regulation: shared.legality,
    errata: shared.errata,
  };
}

function gundamAttributes() {
  return {
    card_type: "unit",
    colours: ["blue"],
    level: 4,
    cost: 3,
    block_icon: "1",
    effect_text: "Official effect",
    zone: "space",
    traits: ["Earth Federation"],
    link_condition: null,
    ap: 3,
    hp: 4,
    series_titles: ["Mobile Suit Gundam"],
  };
}
