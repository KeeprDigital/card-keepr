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
