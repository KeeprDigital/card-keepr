import assert from "node:assert/strict";
import test from "node:test";
import {
  officialRawAdapterContracts,
  officialSourceDiscoveryRequests,
  parseControlledRawSurfaceFixture,
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
  const html = `
      <select id="series">
        <option value="569114">BOOSTER PACK -TEST- [OP99]</option>
      </select>
      <select id="recording">
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
            <div class="text"><h3>Effect</h3>Official effect<br>Second section</div>
            <div class="trigger"><h3>Trigger</h3>Official trigger</div>
            <div class="getInfo"><h3>Card Set(s)</h3>Test Set [OP99]</div>
          </div></dd>
        </dl>
      </div>
    `;
  const bytes = new TextEncoder().encode(html);
  const observations = adapter.parseBytes(
    bytes,
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
  assert.equal(
    observations[0].card.effective_rules_text,
    "Official effect\nSecond section",
  );
  assert.equal(observations[0].card.game_data.attributes.cost, null);
  assert.equal(observations[0].card.game_data.attributes.life, 5);
  assert.equal(
    observations[0].card.game_data.attributes.trigger_text,
    "Official trigger",
  );
  assert.deepEqual(
    observations[0].memberships.source_buckets,
    ["card-set:Test Set [OP99]"],
  );
  assert.deepEqual(
    observations[0].product_release_catalogue.distribution_contexts,
    [],
  );
  assert.doesNotMatch(
    observations[0].identity_evidence.artwork_fingerprint,
    /https?:|OP99-001\.png|#OP99-001/u,
  );
  assert.match(
    observations[0].identity_evidence.printed_fields_digest,
    /Official effect\\nSecond section/u,
  );
  const relocated = adapter.parseBytes(
    new TextEncoder().encode(
      html
        .replaceAll("OP99-001.png", "OP99-001.webp?encoding=2")
        .replace('id="OP99-001"', 'id="OP99-001_p9"')
        .replace("Test Set [OP99]", "Different source bucket"),
    ),
    {
      mediaType: "text/html; charset=utf-8",
      url: "https://en.onepiece-cardgame.com/cardlist/",
    },
  );
  assert.equal(
    relocated[0].identity_evidence.artwork_fingerprint,
    observations[0].identity_evidence.artwork_fingerprint,
  );
  assert.ok(
    adapter.discoverRequests(bytes, {
      mediaType: "text/html; charset=utf-8",
      url: "https://en.onepiece-cardgame.com/cardlist/",
      requestId: "one-piece-en:card-list",
    }).some(({ role, url }) =>
      role === "listing" &&
      new URL(url).searchParams.get("recording") === "569114"
    ),
  );
});

test("live split discovery follows each lineage's bounded staged hierarchy", () => {
  const byLineage = (lineage) =>
    officialRawAdapterContracts.find(
      ({ sourceLineage }) => sourceLineage === lineage,
    );
  const encode = (value) => new TextEncoder().encode(value);

  const onePiece = byLineage("one-piece-en");
  const onePieceRequests = onePiece.discoverRequests(
    encode(`
      <select id="series">
        <option value="set-a">A</option><option value="set-b">B</option>
      </select>
      <select id="recording">
        <option value="101">A</option><option value="102">B</option>
      </select>
    `),
    {
      mediaType: "text/html",
      url: onePiece.requestUrlForSurface("card-list"),
      requestId: "one-piece-en:card-list",
    },
  ).filter(({ role }) => role === "listing");
  assert.deepEqual(
    onePieceRequests.map(({ url }) => new URL(url).searchParams.toString()),
    ["recording=101", "recording=102"],
  );

  const fusion = byLineage("fusion-world-en");
  const facets = `
    <select name="card_type">
      <option value="leader">Leader</option><option value="battle">Battle</option>
    </select>
    <select name="colour">
      <option value="red">Red</option><option value="blue">Blue</option>
    </select>
    <select name="cost">
      <option value="1">1</option><option value="2">2</option>
    </select>
  `;
  const fusionRoot = fusion.discoverRequests(encode(facets), {
    mediaType: "text/html",
    url: fusion.requestUrlForSurface("card-search"),
    requestId: "fusion-world-en:card-search",
  }).filter(({ role }) => role === "listing");
  assert.deepEqual(
    fusionRoot.map(({ url }) => new URL(url).searchParams.toString()),
    ["card_type=battle", "card_type=leader"],
  );
  const fusionColour = fusion.discoverRequests(encode(facets), {
    mediaType: "text/html",
    url: `${fusion.requestUrlForSurface("card-search")}?card_type=leader`,
    requestId: `fusion-world-en:listing:${"a".repeat(64)}`,
  }).filter(({ role }) => role === "listing");
  assert.deepEqual(
    fusionColour.map(({ url }) => new URL(url).searchParams.toString()),
    [
      "card_type=leader&colour=blue",
      "card_type=leader&colour=red",
    ],
  );

  const digimon = byLineage("digimon-en");
  const digimonRoot = digimon.discoverRequests(
    encode(`
      <select name="category">
        <option value="booster">Booster</option>
        <option value="starter">Starter</option>
      </select>
      <select name="card_type"><option value="digimon">Digimon</option></select>
      <select name="colour"><option value="blue">Blue</option></select>
    `),
    {
      mediaType: "text/html",
      url: digimon.requestUrlForSurface("card-list"),
      requestId: "digimon-en:card-list",
    },
  ).filter(({ role }) => role === "listing");
  assert.deepEqual(
    digimonRoot.map(({ url }) => new URL(url).searchParams.get("category")),
    ["booster", "starter"],
  );
});

test("Fusion leaders require explicit role-owned faces and images", () => {
  const adapter = officialRawAdapterContracts.find(
    ({ sourceLineage }) => sourceLineage === "fusion-world-en",
  );
  const html = `
    <h1>Test Leader</h1>
    <dl><dt>Card Number</dt><dd>FB99-001</dd></dl>
    <dl><dt>Card Type</dt><dd>Leader</dd></dl>
    <dl><dt>Color</dt><dd>Red</dd></dl>
    <section class="card-face" data-face="front">
      <img src="/fw/images/cards/FB99-001-front.png">
      <dl><dt>Name</dt><dd>Test Leader</dd></dl>
      <dl><dt>Power</dt><dd>15000</dd></dl>
      <dl><dt>Skill</dt><dd>Front skill</dd></dl>
    </section>
    <section class="card-face" data-face="back">
      <img src="/fw/images/cards/FB99-001-back.png">
      <dl><dt>Name</dt><dd>Awakened Leader</dd></dl>
      <dl><dt>Power</dt><dd>20000</dd></dl>
      <dl><dt>Skill</dt><dd>Back skill</dd></dl>
    </section>
  `;
  const context = {
    mediaType: "text/html",
    url: "https://www.dbs-cardgame.com/fw/en/cardlist/detail.php?cardId=FB99-001",
    requestId: `fusion-world-en:detail:${"b".repeat(64)}`,
  };
  const observation = adapter.parseBytes(
    new TextEncoder().encode(html),
    context,
  )[0];
  assert.deepEqual(
    observation.appearance_evidence.images.map(({ role }) => role),
    ["front", "back"],
  );
  assert.deepEqual(
    observation.card.game_data.attributes.leader_faces.map(
      ({ role, name, power, skills }) => ({ role, name, power, skills }),
    ),
    [
      {
        role: "front",
        name: "Test Leader",
        power: 15000,
        skills: "Front skill",
      },
      {
        role: "back",
        name: "Awakened Leader",
        power: 20000,
        skills: "Back skill",
      },
    ],
  );
  assert.throws(
    () =>
      adapter.parseBytes(
        new TextEncoder().encode(
          html.replace(
            /<section class="card-face" data-face="back">[\s\S]*?<\/section>/u,
            "",
          ),
        ),
        context,
      ),
    /explicit front and back face/iu,
  );
});

test("live Product detail normalizes stable release identity and raw vocabulary", () => {
  const adapter = officialRawAdapterContracts.find(
    ({ sourceLineage }) => sourceLineage === "gundam-en-us",
  );
  const observation = adapter.parseBytes(
    new TextEncoder().encode(`
      <h1>Test Booster</h1>
      <dl><dt>Product Code</dt><dd>GD99</dd></dl>
      <dl><dt>Release Event ID</dt><dd>launch-wave</dd></dl>
      <dl><dt>Release Date</dt><dd>Q3 2027</dd></dl>
      <dl><dt>Region</dt><dd>North America</dd></dl>
      <dl><dt>Status</dt><dd>On Sale</dd></dl>
      <dl><dt>Future Vendor Fact</dt><dd>Preserve me</dd></dl>
    `),
    {
      mediaType: "text/html",
      url: "https://www.gundam-gcg.com/en/products/detail.php?id=mutable-request",
      requestId: `gundam-en-us:product_detail:${"c".repeat(64)}`,
    },
  )[0];
  const release =
    observation.product_release_catalogue.products[0].releases[0];
  assert.deepEqual(release, {
    event_key: "launch-wave",
    region: "EN-US",
    date: { precision: "quarter", value: "2027-Q3" },
    status: "released",
  });
  assert.ok(
    observation.source_sidecar.unmapped_optional_fields.some(
      ({ path, value }) =>
        path.endsWith(".Future Vendor Fact") && value === "Preserve me",
    ),
  );
});

test("explicit Product links produce typed memberships and relationships", () => {
  const adapter = officialRawAdapterContracts.find(
    ({ sourceLineage }) => sourceLineage === "digimon-en",
  );
  const observation = adapter.parseBytes(
    new TextEncoder().encode(`
      <h1>Test Digimon</h1>
      <dl><dt>Card Number</dt><dd>BT99-001</dd></dl>
      <dl><dt>Card Type</dt><dd>Digimon</dd></dl>
      <dl><dt>Color</dt><dd>Blue</dd></dl>
      <dl><dt>Level</dt><dd>4</dd></dl>
      <dl><dt>Digivolve</dt><dd>Blue Lv.3: 2</dd></dl>
      <a class="product-link" data-product-code="BT99"
         href="/products/booster/bt99/">Test Booster [BT99]</a>
      <a class="product-link" href="/products/unknown/">Possible product</a>
      <img class="card-image" src="/images/cards/BT99-001.png">
    `),
    {
      mediaType: "text/html",
      url: "https://world.digimoncard.com/cards/detail.php?card=BT99-001",
      requestId: `digimon-en:detail:${"d".repeat(64)}`,
    },
  )[0];
  assert.deepEqual(observation.memberships.products, ["BT99"]);
  assert.deepEqual(
    observation.card.game_data.attributes.digivolution_requirements,
    ["Blue Lv.3: 2"],
  );
  assert.equal(
    observation.product_release_catalogue.relationships[0].resolution,
    "explicit",
  );
  assert.ok(
    observation.product_release_catalogue.relationships.some(
      ({ resolution, product_reference }) =>
        resolution === "warning" &&
        product_reference.value === "Possible product",
    ),
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

test("production coverage rejects keyword-only HTML without structural entries", () => {
  for (const adapter of officialRawAdapterContracts) {
    const surface = adapter.requiredSurfaces.find(
      (candidate) =>
        candidate !== "card-list" &&
        candidate !== "card-search" &&
        candidate !== "packages",
    );
    assert.ok(surface);
    assert.throws(
      () =>
        adapter.parseBytes(
          new TextEncoder().encode(
            "<html><title>BANDAI CARD PRODUCT RELEASE RULE ERRATA RESTRICTION</title><main>Official publication.</main></html>",
          ),
          {
            mediaType: "text/html; charset=utf-8",
            url: adapter.requestUrlForSurface(surface),
            requestId: `${adapter.sourceLineage}:${surface}`,
          },
        ),
      /structural publication entries/iu,
    );
  }
});

test("production adapters discover staged detail, page, product, and image requests", () => {
  const adapter = officialRawAdapterContracts.find(
    ({ sourceLineage }) => sourceLineage === "fusion-world-en",
  );
  assert.ok(adapter);
  const requests = adapter.discoverRequests(
    new TextEncoder().encode(`
      <a href="/fw/en/cardlist/detail.php?cardId=FB01-001">Card detail</a>
      <a href="/fw/en/cardlist/?card_type=leader&colour=red&cost=1&page=2">Next</a>
      <a href="/fw/en/products/booster/fb01/">Product detail</a>
      <img src="/fw/images/cards/FB01-001-front.png">
    `),
    {
      mediaType: "text/html; charset=utf-8",
      url: adapter.requestUrlForSurface("card-search"),
      requestId: "fusion-world-en:card-search",
    },
  );
  assert.deepEqual(
    requests.map(({ role }) => role).sort(),
    ["detail", "image", "listing", "product_detail"],
  );
  const image = requests.find(({ role }) => role === "image");
  assert.ok(image);
  assert.deepEqual(
    adapter.parseBytes(new Uint8Array([1]), {
      mediaType: "image/png",
      url: image.url,
      requestId: `fusion-world-en:image:${"a".repeat(64)}`,
    }),
    [],
  );
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
      const observations = parseControlledRawSurfaceFixture(
        contract.sourceLineage,
        bytes,
        {
          mediaType: html ? "text/html; charset=utf-8" : "application/json",
          url: `https://official.invalid/${contract.sourceLineage}/${surface}`,
        },
      );
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
            ({ path }) => path.endsWith(".vendor_extension.future_field"),
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
  return parseControlledRawSurfaceFixture(
    adapter.sourceLineage,
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
  return parseControlledRawSurfaceFixture(
    adapter.sourceLineage,
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
