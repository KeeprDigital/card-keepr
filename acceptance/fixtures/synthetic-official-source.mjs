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
