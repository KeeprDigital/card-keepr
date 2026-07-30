export default {
  fetch(request) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    if (pathname === "/success") {
      return Response.json(
        { cards: [{ card_number: "OP01-001", name: "Synthetic Card" }] },
        { headers: { etag: '"synthetic-success-v1"' } },
      );
    }
    if (pathname.startsWith("/raw-one-piece-failure-")) {
      const document = officialDiscoveryDocument(
        officialDiscoveryDefinitions["/raw-one-piece-products"],
      );
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
    const raw = officialRawSurfacePayload(pathname);
    if (raw !== null) {
      if (
        url.searchParams.get("failure") === "cap" &&
        raw.surface === "card-list"
      ) {
        raw.partitions[0].result_cap = 1;
      }
      if (
        url.searchParams.get("failure") === "pagination" &&
        raw.surface === "card-list"
      ) {
        raw.partitions[0].pages = 2;
        raw.partitions[0].has_next = true;
      }
      const body = isHtmlSurface(raw.surface)
        ? `<main><script type="application/json" data-keepr-official-payload>${
          JSON.stringify(raw)
        }</script></main>`
        : JSON.stringify(raw);
      return new Response(body, {
        headers: {
          "content-type": isHtmlSurface(raw.surface)
            ? "text/html; charset=utf-8"
            : "application/json; charset=utf-8",
          etag: `"${raw.lineage}-${raw.surface}-v1"`,
        },
      });
    }
    const definition = officialDiscoveryDefinitions[pathname];
    if (definition !== undefined) {
      return Response.json(
        officialDiscoveryDocument(definition),
        { headers: { etag: `"${definition.etag}"` } },
      );
    }
    if (pathname === "/redirect") {
      return new Response(null, {
        status: 302,
        headers: { location: "https://synthetic-source.invalid/success" },
      });
    }
    if (pathname === "/unavailable") {
      return new Response("temporarily unavailable", {
        status: 503,
        headers: { "retry-after": "0" },
      });
    }
    return new Response("not found", { status: 404 });
  },
};

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
    attributes: {
      card_type: "battle",
      colours: ["red"],
      cost: 1,
      specified_cost: [{ colour: "red", count: 1 }],
      power: 10000,
      combo_power: 5000,
      traits: ["Test"],
      skills: [{ kind: "ordinary", text: "Official skill" }],
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
  const base = {
    contract: "card-keepr-official-source-surface@1",
    lineage,
    surface,
  };
  if (["card-list", "card-search", "packages"].includes(surface)) {
    return {
      ...base,
      source_buckets: ["all-cards"],
      facets: [{ name: "product", exhaustive: true }],
      partitions: [{
        bucket: "all-cards",
        page: 1,
        pages: 1,
        total: document[keys.listing].entries.length,
        has_next: false,
        entries: document[keys.listing].entries,
      }],
      details: document[keys.details],
      products: document[keys.products],
      releases: document[keys.releases],
      retained_unknown: { synthetic_contract_probe: true },
    };
  }
  if (surface === "products") {
    return {
      ...base,
      partitions: [{
        bucket: "all-products",
        page: 1,
        pages: 1,
        total: document[keys.products].length,
        has_next: false,
        entries: document[keys.products],
      }],
    };
  }
  if (surface === "releases") {
    const products = new Map(
      document[keys.products].map((product) => [product.code, product]),
    );
    const entries = document[keys.releases].map((release) => ({
      product: products.get(release.code),
      release,
    }));
    return {
      ...base,
      partitions: [{
        bucket: "all-releases",
        page: 1,
        pages: 1,
        total: entries.length,
        has_next: false,
        entries,
      }],
    };
  }
  return {
    ...base,
    revision: "2026-07",
    entries: [],
  };
}

function isHtmlSurface(surface) {
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
    ...(input.printing === null
      ? {}
      : {
          printing: input.printing,
          printed_rules: "Official printed rules",
          variant: "base",
          artwork_fingerprint:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          printed_fields_digest:
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          image:
            `https://synthetic-source.invalid/images/${input.number}.png`,
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
