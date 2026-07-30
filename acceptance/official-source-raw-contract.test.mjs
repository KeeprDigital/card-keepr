import assert from "node:assert/strict";
import test from "node:test";
import {
  officialRawAdapterContracts,
  officialSourceDiscoveryRequests,
} from "../src/catalogue/product-release-source-adapters.ts";
import {
  officialDiscoveryDefinitions,
  officialDiscoveryDocument,
  officialRawSurfacePayload,
} from "./fixtures/synthetic-official-source.mjs";

const expectedSurfaces = {
  "one-piece-en": [
    "card-list",
    "products",
    "releases",
    "restrictions",
    "block-policy",
    "errata",
    "don-rules",
  ],
  "fusion-world-en": [
    "card-search",
    "products",
    "releases",
    "legality-current",
    "legality-history",
    "errata",
  ],
  "digimon-en": [
    "card-list",
    "products",
    "releases",
    "restrictions-current",
    "restrictions-history",
    "errata",
  ],
  "gundam-en-asia": [
    "packages",
    "products",
    "releases",
    "legality",
    "errata",
  ],
  "gundam-en-us": [
    "packages",
    "products",
    "releases",
    "legality",
    "errata",
  ],
};

test("every production lineage owns an exact raw decoder and discovery plan", () => {
  const production = officialRawAdapterContracts;
  assert.deepEqual(
    production.map(({ sourceLineage }) => sourceLineage).sort(),
    Object.keys(expectedSurfaces).sort(),
  );
  for (const adapter of production) {
    assert.equal(typeof adapter.parseBytes, "function");
    assert.deepEqual(
      adapter.requiredSurfaces,
      expectedSurfaces[adapter.sourceLineage],
    );
    const requests = officialSourceDiscoveryRequests(
      adapter.sourceLineage,
      `https://${adapter.sourceLineage}.official.invalid`,
    );
    assert.deepEqual(
      requests.map(({ id }) => id),
      adapter.requiredSurfaces.map(
        (surface) => `${adapter.sourceLineage}:${surface}`,
      ),
    );
  }
});

test("the aggregate JSON adapter is fixture-only and cannot claim official coverage", () => {
  assert.equal(
    officialRawAdapterContracts.some(
      ({ adapterVersion }) =>
        adapterVersion === "one-piece-json-document@1",
    ),
    false,
  );
});

const lineageFixtures = {
  "one-piece-en": "/raw-one-piece-products",
  "fusion-world-en": "/raw-fusion-world-products",
  "digimon-en": "/catalogue-discovery",
  "gundam-en-asia": "/raw-gundam-asia-products",
  "gundam-en-us": "/raw-gundam-us-products",
};

const discoveryKeys = {
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

test("all five raw decoders accept only their exact retained surface bytes", () => {
  for (const contract of officialRawAdapterContracts) {
    for (const surface of contract.requiredSurfaces) {
      const payload = rawSurfacePayload(contract.sourceLineage, surface);
      assert.equal(
        Object.hasOwn(payload, "contract"),
        false,
        "fixture must retain an upstream-shaped document, not a Keepr envelope",
      );
      const html = isHtmlSurface(surface);
      const bytes = new TextEncoder().encode(
        html
          ? `<main><script type="application/json" data-keepr-official-payload>${
            JSON.stringify(payload)
          }</script></main>`
          : JSON.stringify(payload),
      );
      const observations = contract.parseBytes(bytes, {
        mediaType: html ? "text/html; charset=utf-8" : "application/json",
        url: `https://official.invalid/${contract.sourceLineage}/${surface}`,
      });
      assert.ok(observations.length >= 1);
      if (
        surface === "card-list" ||
        surface === "card-search" ||
        surface === "packages"
      ) {
        const sidecar = observations[0].source_sidecar;
        assert.equal(
          sidecar.raw.official_surfaces[0].document.vendor_extension
            .future_field,
          true,
        );
        assert.ok(
          sidecar.unmapped_optional_fields.some(
            ({ path }) => path.endsWith(".vendor_extension"),
          ),
        );
        assert.ok(observations[0].memberships.source_buckets.length > 0);
        if (contract.sourceLineage === "fusion-world-en") {
          assert.deepEqual(
            observations[0].appearance_evidence.images.map(
              ({ role }) => role,
            ),
            ["front", "back"],
          );
          assert.equal(observations[0].printing.rarity.raw, null);
          assert.equal(observations[0].printing.rarity.normalized, null);
        }
      }
    }
  }
});

test("the raw discovery decoder fails closed on caps, unfinished pages, and surface mismatch", () => {
  const adapter = officialRawAdapterContracts.find(
    ({ sourceLineage }) => sourceLineage === "one-piece-en",
  );
  const capped = rawSurfacePayload("one-piece-en", "card-list");
  capped.page_info.cap_signal = "Too many search results";
  assert.throws(
    () => parseHtml(adapter, "card-list", capped),
    /result-cap evidence does not prove complete coverage/u,
  );

  const unfinished = rawSurfacePayload("one-piece-en", "card-list");
  unfinished.page_info.partitions[0].pages = 2;
  unfinished.page_info.partitions[0].has_next = true;
  assert.throws(
    () => parseHtml(adapter, "card-list", unfinished),
    /pagination evidence does not prove complete partitions/u,
  );

  const wrongPartition = rawSurfacePayload("one-piece-en", "card-list");
  wrongPartition.page_info.partitions[0].bucket = "unplanned-series";
  assert.throws(
    () => parseHtml(adapter, "card-list", wrongPartition),
    /discovered partition closure/u,
  );

  const mismatched = rawSurfacePayload("one-piece-en", "card-list");
  mismatched.page = "product-list";
  assert.throws(
    () => parseHtml(adapter, "card-list", mismatched),
    /card-list page identity/u,
  );
});

function rawSurfacePayload(lineage, surface) {
  return structuredClone(
    officialRawSurfacePayload(`/${lineage}/${surface}`),
  );
}

function isHtmlSurface(surface) {
  return ["card-list", "card-search", "packages", "products"].includes(surface);
}

function parseHtml(adapter, surface, payload) {
  return adapter.parseBytes(
    new TextEncoder().encode(
      `<script type="application/json" data-keepr-official-payload>${
        JSON.stringify(payload)
      }</script>`,
    ),
    {
      mediaType: "text/html",
      url: `https://official.invalid/one-piece-en/${surface}`,
    },
  );
}
