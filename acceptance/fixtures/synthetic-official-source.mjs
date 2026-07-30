export default {
  fetch(request) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const transportOutcome = request.headers.get("user-agent");
    if (
      transportOutcome ===
      "card-keepr-acceptance-transport/redirect"
    ) {
      return new Response(null, {
        status: 302,
        headers: {
          location: "https://synthetic-source.invalid/success",
        },
      });
    }
    if (
      transportOutcome ===
      "card-keepr-acceptance-transport/unavailable"
    ) {
      return new Response("temporarily unavailable", {
        status: 503,
        headers: { "retry-after": "0" },
      });
    }
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
      const surface = pathname.slice(pathname.lastIndexOf("/") + 1);
      if (
        url.searchParams.get("failure") === "cap" &&
        surface === "card-list"
      ) {
        raw.page_info.cap_signal = "Too many search results";
      }
      if (
        url.searchParams.get("failure") === "pagination" &&
        surface === "card-list"
      ) {
        raw.page_info.partitions[0].pages = 2;
        raw.page_info.partitions[0].has_next = true;
      }
      const body = isHtmlSurface(surface)
        ? `<main><script type="application/json" data-keepr-official-payload>${
          JSON.stringify(raw)
        }</script></main>`
        : JSON.stringify(raw);
      return new Response(body, {
        headers: {
          "content-type": isHtmlSurface(surface)
            ? "text/html; charset=utf-8"
            : "application/json; charset=utf-8",
          etag: `"${pathname.slice(1).replaceAll("/", "-")}-v1"`,
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
      }],
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
        result,
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
      return { publication: "release-schedule", events };
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
  const shared = {
    profile: detail.profile,
    product_codes: detail.product_codes,
    distribution: detail.distribution,
    ...(detail.printing === undefined
      ? {}
      : {
          printing: {
            rarity: detail.printing.rarity ?? null,
            normalized_rarity:
              detail.printing.normalizedRarity ?? null,
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
      image_url: detail.image,
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
            { role: "front", url: detail.image },
            {
              role: "back",
              url: detail.image.replace(".png", "-back.png"),
            },
          ]
        : [{ role: "front", url: detail.image }],
      ...shared,
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
      image_url: detail.image,
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
    image_url: detail.image,
    ...shared,
  };
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
    image:
      `https://synthetic-source.invalid/images/${input.number}.png`,
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
