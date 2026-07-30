import assert from "node:assert/strict";
import test from "node:test";
import {
  officialRawAdapterContracts,
  officialSourceDiscoveryRequests,
} from "../src/catalogue/product-release-source-adapters.ts";
import {
  officialDiscoveryDefinitions,
  officialDiscoveryDocument,
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
    }
  }
});

test("the raw discovery decoder fails closed on caps, unfinished pages, and surface mismatch", () => {
  const adapter = officialRawAdapterContracts.find(
    ({ sourceLineage }) => sourceLineage === "one-piece-en",
  );
  const capped = rawSurfacePayload("one-piece-en", "card-list");
  capped.partitions[0].result_cap = 1;
  assert.throws(
    () => parseHtml(adapter, "card-list", capped),
    /result-cap evidence does not prove complete coverage/u,
  );

  const unfinished = rawSurfacePayload("one-piece-en", "card-list");
  unfinished.partitions[0].pages = 2;
  unfinished.partitions[0].has_next = true;
  assert.throws(
    () => parseHtml(adapter, "card-list", unfinished),
    /pagination evidence does not prove complete partitions/u,
  );

  const mismatched = rawSurfacePayload("one-piece-en", "card-list");
  mismatched.surface = "products";
  assert.throws(
    () => parseHtml(adapter, "card-list", mismatched),
    /surface binding/u,
  );
});

function rawSurfacePayload(lineage, surface) {
  const document = officialDiscoveryDocument(
    structuredClone(
      officialDiscoveryDefinitions[lineageFixtures[lineage]],
    ),
  );
  const keys = discoveryKeys[lineage];
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
      retained_unknown: { preserved_in_snapshot: true },
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
