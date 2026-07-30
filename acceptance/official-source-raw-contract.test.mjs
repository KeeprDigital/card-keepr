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
    const requests = officialSourceDiscoveryRequests(adapter.sourceLineage);
    assert.deepEqual(
      requests.map(({ id }) => id),
      adapter.requiredSurfaces.map(
        (surface) => `${adapter.sourceLineage}:${surface}`,
      ),
    );
    assert.ok(
      requests.every(({ url }) =>
        new URL(url).hostname.endsWith("bandai.com") ||
        new URL(url).hostname.endsWith("cardgame.com") ||
        new URL(url).hostname.endsWith("digimoncard.com") ||
        new URL(url).hostname.endsWith("gundam-gcg.com")
      ),
      `${adapter.sourceLineage} must be bound to Bandai-owned hosts`,
    );
    assert.ok(
      requests.every(({ url }) =>
        !new URL(url).pathname.includes(adapter.sourceLineage)
      ),
      `${adapter.sourceLineage} must use upstream paths, not Keepr paths`,
    );
  }
});

test("production decoders accept real Bandai-shaped HTML without a Keepr payload wrapper", () => {
  const adapter = officialRawAdapterContracts.find(
    ({ sourceLineage }) => sourceLineage === "one-piece-en",
  );
  const observations = adapter.parseBytes(
    new TextEncoder().encode(`
      <select id="series">
        <option value="569114">BOOSTER PACK -TEST- [OP99]</option>
      </select>
      <div class="countCol">1 results</div>
      <div class="resultCol">
        <a class="modalOpen" data-src="#OP99-001">
          <img data-src="../images/cardlist/card/OP99-001.png" alt="Test Leader">
        </a>
        <dl class="modalCol" id="OP99-001">
          <dt>
            <div class="infoCol"><span>OP99-001</span> | <span>L</span> | <span>LEADER</span></div>
            <div class="cardName">Test Leader</div>
          </dt>
          <dd><div class="frontCol"><img data-src="../images/cardlist/card/OP99-001.png"></div>
          <div class="backCol">
            <div class="cost"><h3>Life</h3>5</div>
            <div class="attribute"><h3>Attribute</h3><i>Strike</i></div>
            <div class="power"><h3>Power</h3>5000</div>
            <div class="counter"><h3>Counter</h3>-</div>
            <div class="color"><h3>Color</h3>Red</div>
            <div class="block"><h3>Block icon</h3>1</div>
            <div class="feature"><h3>Type</h3>Test</div>
            <div class="text"><h3>Effect</h3>Official effect</div>
            <div class="getInfo"><h3>Card Set(s)</h3>Test Set [OP99]</div>
          </div></dd>
        </dl>
      </div>
    `),
    {
      mediaType: "text/html; charset=utf-8",
      url: "https://en.onepiece-cardgame.com/cardlist/",
    },
  );
  assert.equal(observations.length, 1);
  assert.equal(observations[0].card.official_identity.value, "OP99-001");
  assert.equal(
    observations[0].appearance_evidence.images[0].source_url,
    "https://en.onepiece-cardgame.com/images/cardlist/card/OP99-001.png",
  );
});

test("every production lineage parses its exact real HTML policy surfaces", () => {
  for (const adapter of officialRawAdapterContracts) {
    const surface = adapter.requiredSurfaces.find(
      (candidate) => candidate !== "card-list",
    );
    assert.ok(surface);
    const observations = adapter.parseBytes(
      new TextEncoder().encode(`
        <html>
          <title>BANDAI ${adapter.supportedGame} CARD PRODUCT RELEASE RULE ERRATA RESTRICTION</title>
          <select><option value="official">Official partition</option></select>
          <a href="/products/example">Official product entry</a>
        </html>
      `),
      {
        mediaType: "text/html; charset=utf-8",
        url: adapter.requestUrlForSurface(surface),
        requestId: `${adapter.sourceLineage}:${surface}`,
      },
    );
    assert.equal(observations.length, 1);
    const retained =
      observations[0].source_sidecar.raw.official_surfaces[0].document;
    assert.deepEqual(retained.discovered_options, [
      { value: "official", label: "Official partition" },
    ]);
    assert.equal(retained.publication_links.length, 1);
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
  const adapter = officialRawAdapterContracts.find(
    ({ sourceLineage }) => sourceLineage === "fusion-world-en",
  );
  const surface = "products";
  assert.throws(
    () =>
      adapter.parseBytes(
        new TextEncoder().encode(
          '<script data-keepr-official-payload type="application/json">{"brand":"BANDAI","publication":"CARD PRODUCT"}</script>',
        ),
        {
          mediaType: "text/html",
          url: adapter.requestUrlForSurface(surface),
          requestId: `${adapter.sourceLineage}:${surface}`,
        },
      ),
    /does not accept synthetic Keepr payload wrappers/iu,
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
      const observations = contract.parseFixtureBytes(bytes, {
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
    /discovered vocabulary.*exact leaf partitions/iu,
  );

  const mismatched = rawSurfacePayload("one-piece-en", "card-list");
  mismatched.page = "product-list";
  assert.throws(
    () => parseHtml(adapter, "card-list", mismatched),
    /card-list page identity/u,
  );
});

test("discovered Fusion facets require disjoint exact split-order leaves", () => {
  const adapter = officialRawAdapterContracts.find(
    ({ sourceLineage }) => sourceLineage === "fusion-world-en",
  );
  const incomplete = rawSurfacePayload("fusion-world-en", "card-search");
  incomplete.result.partitions.pop();
  assert.throws(
    () => parseFixtureHtml(adapter, "card-search", incomplete),
    /discovered vocabulary.*exact leaf partitions/iu,
  );
  incomplete.result.partitions.push({
    bucket: "card_type=battle&colour=red&cost=1",
    page: 1,
    pages: 1,
    total: 0,
    has_next: false,
    entries: [],
  });
  assert.doesNotThrow(
    () => parseFixtureHtml(adapter, "card-search", incomplete),
  );

  const overlapping = rawSurfacePayload(
    "fusion-world-en",
    "card-search",
  );
  overlapping.result.partitions[1].entries.push(
    structuredClone(overlapping.result.partitions[0].entries[0]),
  );
  overlapping.result.partitions[1].total = 1;
  assert.throws(
    () => parseFixtureHtml(adapter, "card-search", overlapping),
    /leaf partitions overlap/iu,
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
  return adapter.parseFixtureBytes(
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

function parseFixtureHtml(adapter, surface, payload) {
  return adapter.parseFixtureBytes(
    new TextEncoder().encode(
      `<script type="application/json" data-keepr-official-payload>${
        JSON.stringify(payload)
      }</script>`,
    ),
    {
      mediaType: "text/html",
      url: `https://fixture.invalid/${adapter.sourceLineage}/${surface}`,
    },
  );
}
