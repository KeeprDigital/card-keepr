export default {
  fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/success") {
      return new Response(
        '{"cards":[{"card_number":"OP01-001","name":"Synthetic Card"}]}',
        {
          headers: {
            "content-type": "application/json",
            etag: '"synthetic-success-v1"',
          },
        },
      );
    }
    if (pathname === "/product-only") {
      return Response.json(
        {
          product_surfaces: [
            {
              completeness: {
                structurally_complete: true,
                required_surfaces_complete: true,
                partitions_complete: true,
                declared_record_count: 1,
                parsed_record_count: 1,
              },
              product_release_catalogue: {
                products: [
                  {
                    reference: {
                      kind: "official_code",
                      value: "BT-PRODUCT-ONLY",
                    },
                    official_code: "BT-PRODUCT-ONLY",
                    name: "Product-only announced release",
                    releases: [
                      {
                        region: "unknown",
                        date: { precision: "unknown", value: null },
                        status: "announced",
                      },
                    ],
                  },
                ],
                distribution_contexts: [
                  {
                    key: "product-only-promotion",
                    kind: "promotion",
                    label: "Product-only promotion",
                    product_reference: {
                      kind: "official_code",
                      value: "BT-PRODUCT-ONLY",
                    },
                    evidence_category: "explicit",
                  },
                ],
                relationships: [
                  {
                    kind: "distribution-context-product",
                    context_key: "product-only-promotion",
                    product_reference: {
                      kind: "official_code",
                      value: "BT-PRODUCT-ONLY",
                    },
                    evidence_category: "explicit",
                    resolution: "explicit",
                  },
                ],
              },
            },
          ],
        },
        { headers: { etag: '"synthetic-product-only-v1"' } },
      );
    }
    if (pathname === "/catalogue-discovery") {
      const complete = {
        structurally_complete: true,
        required_surfaces_complete: true,
        partitions_complete: true,
        declared_record_count: 1,
        parsed_record_count: 1,
      };
      return Response.json(
        {
          official_records: [
            {
              record_type: "product_announcement",
              completeness: complete,
              catalogue: {
                products: [
                  {
                    reference: {
                      kind: "official_code",
                      value: "BT-PRODUCT-ONLY",
                    },
                    official_code: "BT-PRODUCT-ONLY",
                    name: "Product-only announced release",
                    releases: [
                      {
                        region: "unknown",
                        date: { precision: "unknown", value: null },
                        status: "announced",
                      },
                    ],
                  },
                ],
                distribution_contexts: [
                  {
                    key: "product-only-promotion",
                    kind: "promotion",
                    label: "Product-only promotion",
                    product_reference: {
                      kind: "official_code",
                      value: "BT-PRODUCT-ONLY",
                    },
                    evidence_category: "explicit",
                  },
                ],
                relationships: [
                  {
                    kind: "distribution-context-product",
                    context_key: "product-only-promotion",
                    product_reference: {
                      kind: "official_code",
                      value: "BT-PRODUCT-ONLY",
                    },
                    evidence_category: "explicit",
                    resolution: "explicit",
                  },
                ],
              },
            },
            {
              record_type: "card_product_listing",
              completeness: complete,
              card: {
                game: "digimon",
                official_identity: {
                  kind: "card_number",
                  value: "BT99-001",
                },
                name: "Discovery Card",
                effective_rules_text: "Official effective rules",
                game_data: {
                  profile: "digimon@1",
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
                },
              },
              catalogue: {
                products: [
                  {
                    reference: {
                      kind: "official_code",
                      value: "BT-CARD-BEARING",
                    },
                    official_code: "BT-CARD-BEARING",
                    name: "Card-bearing product",
                    releases: [],
                  },
                ],
                distribution_contexts: [],
                relationships: [
                  {
                    kind: "product-card",
                    product_reference: {
                      kind: "official_code",
                      value: "BT-CARD-BEARING",
                    },
                    card_reference: { kind: "current_card" },
                    evidence_category: "explicit",
                    resolution: "explicit",
                  },
                ],
              },
              memberships: {
                products: [],
                distribution_contexts: [],
                source_buckets: [],
              },
            },
          ],
        },
        { headers: { etag: '"synthetic-catalogue-discovery-v1"' } },
      );
    }
    if (
      [
        "/raw-one-piece-products",
        "/raw-fusion-world-products",
        "/raw-gundam-asia-products",
        "/raw-gundam-us-products",
      ].includes(pathname)
    ) {
      return rawProductResponse(pathname);
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

function rawProductResponse(pathname) {
  const definitions = {
    "/raw-one-piece-products": {
      wrapper: "official_card_results",
      game: "one-piece",
      profile: "one-piece@1",
      cardNumber: "OP99-001",
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
    },
    "/raw-fusion-world-products": {
      wrapper: "card_items",
      game: "fusion-world",
      profile: "fusion-world@1",
      cardNumber: "FB99-001",
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
    },
    "/raw-gundam-asia-products": {
      wrapper: "search_results",
      game: "gundam",
      profile: "gundam@1",
      cardNumber: "GD99-001",
      productCode: "GD-RAW-01",
      productName: "Gundam Cross-region Raw Product",
      region: "EN-ASIA",
      attributes: gundamAttributes(),
    },
    "/raw-gundam-us-products": {
      wrapper: "search_results",
      game: "gundam",
      profile: "gundam@1",
      cardNumber: "GD99-001",
      productCode: "GD-RAW-01",
      productName: "Gundam Cross-region Raw Product",
      region: "EN-US",
      attributes: gundamAttributes(),
    },
  };
  const definition = definitions[pathname];
  const contextCode = `${definition.productCode}-distribution`;
  const rawRecord = {
    completeness: {
      structurally_complete: true,
      required_surfaces_complete: true,
      partitions_complete: true,
      declared_record_count: 1,
      parsed_record_count: 1,
    },
    card_record: {
      number: definition.cardNumber,
      name: `${definition.productName} Card`,
      rules_text: "Official effective rules",
      profile: definition.profile,
      attributes: definition.attributes,
    },
    product_record: {
      code: definition.productCode,
      name: definition.productName,
      release_region: definition.region,
      release_date_precision: "day",
      release_date: "2026-12-01",
      release_status: "released",
    },
    distribution_record: {
      code: contextCode,
      kind: "product",
      label: `${definition.productName} distribution`,
    },
    source_bucket: `${definition.productCode}-official-list`,
  };
  return Response.json(
    { [definition.wrapper]: [rawRecord] },
    { headers: { etag: `"${definition.productCode}-${definition.region}"` } },
  );
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
