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
        <dl class="modalCol" id="OP99-001"
            data-artwork-id="op99-001-standard-art">
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
  assert.equal(observations[0].identity_evidence.locator, "OP99-001");
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
  assert.equal(
    observations[0].identity_evidence.artwork_fingerprint,
    'official-artwork:{"official_card_identity":"OP99-001","roles":["front"],"artwork_id":"op99-001-standard-art"}',
  );
  assert.equal(observations[0].identity_evidence.treatment, null);
  assert.equal(
    observations[0].identity_evidence.demonstrably_novel,
    false,
    "raw parser output cannot prove an appearance is novel before its image bytes are retained and verified",
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
  const redistributed = adapter.parseBytes(
    new TextEncoder().encode(
      html
        .replaceAll(
          "OP99-001.png",
          "unrelated-distribution-filename.webp?width=2048&encoding=next",
        )
        .replace("<img data-src=", '<img width="2048" height="2856" data-src='),
    ),
    {
      mediaType: "text/html; charset=utf-8",
      url: "https://en.onepiece-cardgame.com/cardlist/",
    },
  );
  assert.equal(
    redistributed[0].identity_evidence.artwork_fingerprint,
    observations[0].identity_evidence.artwork_fingerprint,
  );
  const unidentified = adapter.parseBytes(
    new TextEncoder().encode(
      html.replace(' data-artwork-id="op99-001-standard-art"', ""),
    ),
    {
      mediaType: "text/html; charset=utf-8",
      url: "https://en.onepiece-cardgame.com/cardlist/",
    },
  );
  assert.equal(
    unidentified[0].identity_evidence.artwork_fingerprint,
    'official-artwork:{"official_card_identity":"OP99-001","roles":["front"],"artwork_id":null}',
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

test("One Piece aggregate JSON-LD retains an explicit first Printing identity", () => {
  const adapter = officialRawAdapterContracts.find(
    ({ sourceLineage }) => sourceLineage === "one-piece-en",
  );
  const payload = officialRawSurfacePayload("/one-piece-en/card-list");
  const publication = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    publisher: { "@type": "Organization", name: "Bandai" },
    hasPart: [{
      "@type": "Dataset",
      identifier: "one-piece-en:card-list",
      payload,
    }],
  };
  const observations = adapter.parseBytes(
    new TextEncoder().encode(
      `<html><script type="application/ld+json">${
        JSON.stringify(publication)
      }</script></html>`,
    ),
    {
      mediaType: "text/html; charset=utf-8",
      url: adapter.requestUrlForSurface("card-list"),
      requestId: "one-piece-en:card-list",
    },
  );
  const observation = observations.find(
    ({ card }) => card?.official_identity?.value === "OP99-001",
  );
  assert.ok(observation?.printing);
  assert.equal(
    observation.identity_evidence.artwork_fingerprint,
    'official-artwork:{"official_card_identity":"OP99-001","roles":["front"],"artwork_id":"one-piece-op99-001-standard"}',
  );
  assert.equal(observation.identity_evidence.locator, "/cards/OP99-001");
  assert.equal(observation.identity_evidence.treatment, null);
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
  const digimonCardType = digimon.discoverRequests(
    encode(`
      <select name="category"><option value="booster">Booster</option></select>
      <select name="cardcategory">
        <option value="digimon">Digimon</option>
        <option value="option">Option</option>
      </select>
      <select name="colour"><option value="blue">Blue</option></select>
    `),
    {
      mediaType: "text/html",
      url: `${digimon.requestUrlForSurface("card-list")}&category=booster`,
      requestId: `digimon-en:listing:${"9".repeat(64)}`,
    },
  ).filter(({ role }) => role === "listing");
  assert.deepEqual(
    digimonCardType.map(({ url }) =>
      new URL(url).searchParams.get("cardcategory")
    ),
    ["digimon", "option"],
  );

  const cappedIntermediate = `
    <html><title>BANDAI DRAGON BALL CARD search</title>
      <p>More than 1,000 results were capped</p>
      ${facets}
    </html>
  `;
  assert.doesNotThrow(() =>
    fusion.parseBytes(encode(cappedIntermediate), {
      mediaType: "text/html",
      url: `${fusion.requestUrlForSurface("card-search")}?card_type=leader`,
      requestId: `fusion-world-en:listing:${"8".repeat(64)}`,
    })
  );
  assert.throws(
    () =>
      fusion.parseBytes(encode(cappedIntermediate), {
        mediaType: "text/html",
        url:
          `${fusion.requestUrlForSurface("card-search")}?card_type=leader&colour=red&cost=1`,
        requestId: `fusion-world-en:listing:${"7".repeat(64)}`,
      }),
    /leaf partition still displays/iu,
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
    <dl><dt>Specified Cost</dt><dd>Red 2</dd></dl>
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
    observation.card.game_data.attributes.specified_cost,
    [{ colour: "red", count: 2 }],
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

test("live Product detail maps official display dates and fails closed on new status vocabulary", () => {
  const adapter = officialRawAdapterContracts.find(
    ({ sourceLineage }) => sourceLineage === "gundam-en-us",
  );
  const base = `
    <h1>Display Date Booster</h1>
    <dl><dt>Product Code</dt><dd>GD98</dd></dl>
    <dl><dt>Release Event ID</dt><dd>display-launch</dd></dl>
    <dl><dt>Release Date</dt><dd>September 12, 2027</dd></dl>
    <dl><dt>Region</dt><dd>North America</dd></dl>
    <dl><dt>Status</dt><dd>Coming Soon</dd></dl>
  `;
  const context = {
    mediaType: "text/html",
    url: "https://www.gundam-gcg.com/en/products/detail.php?id=display",
    requestId: `gundam-en-us:product_detail:${"e".repeat(64)}`,
  };
  const release = adapter.parseBytes(
    new TextEncoder().encode(base),
    context,
  )[0].product_release_catalogue.products[0].releases[0];
  assert.deepEqual(release.date, {
    precision: "day",
    value: "2027-09-12",
  });
  assert.equal(release.status, "announced");
  assert.throws(
    () =>
      adapter.parseBytes(
        new TextEncoder().encode(
          base.replace("Coming Soon", "Vendor Future Phase"),
        ),
        context,
      ),
    /unrecognized official Release status/iu,
  );
});

test("nested raw unknown leaves remain warnings when their container is mapped", () => {
  const document = rawSurfacePayload("one-piece-en", "card-list");
  document.card_pages[0].future_nested = {
    vendor_rule: "retain this nested leaf",
  };
  const observation = parseControlledRawSurfaceFixture(
    "one-piece-en",
    new TextEncoder().encode(
      `<main><script type="application/json" data-keepr-official-payload>${
        JSON.stringify(document)
      }</script></main>`,
    ),
    {
      mediaType: "text/html; charset=utf-8",
      url: "https://official.invalid/one-piece-en/card-list",
    },
  )[0];
  assert.ok(
    observation.source_sidecar.unmapped_optional_fields.some(
      ({ path, value }) =>
        path.endsWith(".card_pages[0].future_nested.vendor_rule") &&
        value === "retain this nested leaf",
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
      <img class="site-logo" src="/images/site-logo.png">
      <img class="card-image" src="/images/cards/BT99-001.png">
    `),
    {
      mediaType: "text/html",
      url: "https://world.digimoncard.com/cards/detail.php?card=BT99-001",
      requestId: `digimon-en:detail:${"d".repeat(64)}`,
    },
  )[0];
  assert.deepEqual(observation.memberships.products, ["BT99"]);
  assert.match(
    observation.appearance_evidence.images[0].source_url,
    /BT99-001\.png$/u,
  );
  assert.deepEqual(
    observation.card.game_data.attributes.digivolution_requirements,
    [{
      index: 1,
      from_level: 3,
      colours: ["blue"],
      cost: 2,
      raw_condition: "Blue Lv.3: 2",
    }],
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
  assert.throws(
    () =>
      adapter.parseBytes(
        new TextEncoder().encode(`
          <h1>Test Digimon</h1>
          <dl><dt>Card Number</dt><dd>BT99-001</dd></dl>
          <dl><dt>Card Type</dt><dd>Digimon</dd></dl>
          <dl><dt>Color</dt><dd>Blue</dd></dl>
          <img class="card-image" src="/images/cards/BT99-001.png">
        `),
        {
          mediaType: "text/html",
          url: "https://world.digimoncard.com/cards/detail.php?card=BT99-999",
          requestId: `digimon-en:detail:${"f".repeat(64)}`,
        },
      ),
    /requested Card identity does not match/iu,
  );
});

test("real Digimon and Gundam details close every known profile field and reject malformed numerics", () => {
  const byLineage = (lineage) =>
    officialRawAdapterContracts.find(
      ({ sourceLineage }) => sourceLineage === lineage,
    );
  const digimon = byLineage("digimon-en");
  const digimonHtml = `
    <h1>Linked Test Digimon</h1>
    <dl><dt>Card Number</dt><dd>BT99-002</dd></dl>
    <dl><dt>Card Type</dt><dd>Digimon</dd></dl>
    <dl><dt>Color</dt><dd>Red/Blue</dd></dl>
    <dl><dt>Level</dt><dd>6</dd></dl>
    <dl><dt>Play Cost</dt><dd>1,000</dd></dl>
    <dl><dt>Use Cost</dt><dd>-</dd></dl>
    <dl><dt>DP</dt><dd>12,000</dd></dl>
    <dl><dt>Form</dt><dd>Mega</dd></dl>
    <dl><dt>Attribute</dt><dd>Vaccine</dd></dl>
    <dl><dt>Type</dt><dd>Test Type</dd></dl>
    <dl><dt>Digivolution Cost</dt><dd>Blue Lv.5: 4</dd></dl>
    <dl><dt>Effect</dt><dd>Main effect</dd></dl>
    <dl><dt>Inherited Effect</dt><dd>Inherited effect</dd></dl>
    <dl><dt>Security Effect</dt><dd>Security effect</dd></dl>
    <dl><dt>DUAL Color</dt><dd>Red/Blue</dd></dl>
    <dl><dt>DUAL Cost</dt><dd>7</dd></dl>
    <dl><dt>[DUAL Effect]</dt><dd>Dual effect</dd></dl>
    <dl><dt>[DUAL Rule]</dt><dd>Dual rule</dd></dl>
    <dl><dt>[Link Condition]</dt><dd>Link condition</dd></dl>
    <dl><dt>[Link DP]</dt><dd>3,000</dd></dl>
    <dl><dt>[Link Effect]</dt><dd>Link effect</dd></dl>
    <dl><dt>[Special Digivolution Condition]</dt><dd>Special condition</dd></dl>
    <dl><dt>Alternative Art</dt><dd>Yes</dd></dl>
    <img class="card-image" src="/images/cards/BT99-002.png">
  `;
  const digimonContext = {
    mediaType: "text/html",
    url: "https://world.digimoncard.com/cards/detail.php?card=BT99-002",
    requestId: `digimon-en:detail:${"e".repeat(64)}`,
  };
  const digimonObservation = digimon.parseBytes(
    new TextEncoder().encode(digimonHtml),
    digimonContext,
  )[0];
  assert.deepEqual(digimonObservation.card.game_data.attributes, {
    card_type: "digimon",
    colours: ["red", "blue"],
    level: 6,
    play_cost: 1000,
    use_cost: null,
    dp: 12000,
    form: "Mega",
    attribute: "Vaccine",
    traits: ["Test Type"],
    digivolution_requirements: [{
      index: 1,
      from_level: 5,
      colours: ["blue"],
      cost: 4,
      raw_condition: "Blue Lv.5: 4",
    }],
    text_sections: [
      { kind: "effect", text: "Main effect" },
      { kind: "inherited_effect", text: "Inherited effect" },
      { kind: "security_effect", text: "Security effect" },
      { kind: "dual_effect", text: "Dual effect" },
      { kind: "dual_rule", text: "Dual rule" },
      { kind: "link_condition", text: "Link condition" },
      { kind: "link_effect", text: "Link effect" },
      {
        kind: "special_digivolution_condition",
        text: "Special condition",
      },
    ],
    dual_colours: ["red", "blue"],
    dual_cost: 7,
    link_dp: 3000,
  });
  assert.deepEqual(
    digimonObservation.printing.game_data.attributes,
    { alternative_art: true },
  );
  assert.throws(
    () =>
      digimon.parseBytes(
        new TextEncoder().encode(
          digimonHtml.replace("<dd>12,000</dd>", "<dd>12,00</dd>"),
        ),
        digimonContext,
      ),
    /numeric token/iu,
  );

  const gundam = byLineage("gundam-en-asia");
  const gundamObservation = gundam.parseBytes(
    new TextEncoder().encode(`
      <h1>Test Gundam Unit</h1>
      <dl><dt>Card Number</dt><dd>GD99-001</dd></dl>
      <dl><dt>Type</dt><dd>Unit</dd></dl>
      <dl><dt>Color</dt><dd>Blue</dd></dl>
      <dl><dt>Level</dt><dd>5</dd></dl>
      <dl><dt>Cost</dt><dd>1,000</dd></dl>
      <dl><dt>Effect</dt><dd>Unit effect</dd></dl>
      <dl><dt>AP</dt><dd>4,000</dd></dl>
      <dl><dt>HP</dt><dd>5,000</dd></dl>
      <dl><dt>Alternate Art</dt><dd>Yes</dd></dl>
      <img class="card-image" src="/asia-en/images/cards/GD99-001.png">
    `),
    {
      mediaType: "text/html",
      url: "https://www.gundam-gcg.com/asia-en/cards/detail.php?card=GD99-001",
      requestId: `gundam-en-asia:detail:${"e".repeat(64)}`,
    },
  )[0];
  assert.equal(gundamObservation.card.game_data.attributes.cost, 1000);
  assert.equal(gundamObservation.card.game_data.attributes.ap, 4000);
  assert.equal(gundamObservation.card.game_data.attributes.hp, 5000);
  assert.deepEqual(
    gundamObservation.printing.game_data.attributes,
    { alternate_art: true },
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

test("live Product indexes emit typed Products, classifications, and announced releases", () => {
  const adapter = officialRawAdapterContracts.find(
    ({ sourceLineage }) => sourceLineage === "fusion-world-en",
  );
  const observations = adapter.parseBytes(
    new TextEncoder().encode(`
      <html><title>BANDAI DRAGON BALL CARD PRODUCTS RELEASE</title>
        <article class="booster">
          <a data-product-code="FB-BOOST-01"
             href="/fw/en/products/booster/fb-boost-01/">Booster Set 01</a>
          <span>Coming Soon</span>
        </article>
        <article class="accessory">
          <a data-product-code="FB-SLEEVE-01"
             href="/fw/en/products/accessory/fb-sleeve-01/">Official Sleeves</a>
        </article>
        <article class="booster">
          <a href="/fw/en/products/booster/name-only/">
            Name-only Booster
          </a>
        </article>
      </html>
    `),
    {
      mediaType: "text/html",
      url: adapter.requestUrlForSurface("products"),
      requestId: "fusion-world-en:products",
    },
  );
  const catalogues = observations.map(
    ({ product_release_catalogue }) => product_release_catalogue,
  );
  assert.deepEqual(
    catalogues.flatMap(({ products }) =>
      products.map(({ official_code }) => official_code)
    ).sort(),
    ["FB-BOOST-01", null],
  );
  assert.ok(
    catalogues.flatMap(({ distribution_contexts }) => distribution_contexts)
      .some(({ kind, label }) => kind === "product" && label === "booster"),
  );
  assert.ok(
    catalogues.flatMap(({ distribution_contexts }) => distribution_contexts)
      .some(({ kind, label }) => kind === "other" && label === "accessory"),
  );
  assert.equal(
    catalogues.flatMap(({ products }) => products)
      .some(({ official_code, name }) =>
        official_code === "FB-SLEEVE-01" || name === "Official Sleeves"
      ),
    false,
  );
  assert.deepEqual(
    catalogues.flatMap(({ products }) => products)
      .find(({ name }) => name === "Name-only Booster"),
    {
      reference: { kind: "name", value: "Name-only Booster" },
      official_code: null,
      name: "Name-only Booster",
      releases: [],
    },
  );
  assert.equal(
    catalogues.flatMap(({ products }) => products)
      .find(({ official_code }) => official_code === "FB-BOOST-01")
      .releases[0].status,
    "announced",
  );
});

test("a Product URL slug cannot become a canonical official code but its authoritative name is retained", () => {
  const adapter = officialRawAdapterContracts.find(
    ({ sourceLineage }) => sourceLineage === "fusion-world-en",
  );
  const observations = adapter.parseBytes(
    new TextEncoder().encode(`
      <html><title>BANDAI DRAGON BALL CARD PRODUCTS RELEASE</title>
        <article class="booster">
          <a href="/fw/en/products/booster/presentation-only-slug/">
            Presentation-only Product
          </a>
        </article>
      </html>
    `),
    {
      mediaType: "text/html",
      url: adapter.requestUrlForSurface("products"),
      requestId: "fusion-world-en:products",
    },
  );
  const products = observations.flatMap(
    ({ product_release_catalogue }) =>
      product_release_catalogue?.products ?? [],
  );
  assert.deepEqual(products, [{
    reference: { kind: "name", value: "Presentation-only Product" },
    official_code: null,
    name: "Presentation-only Product",
    releases: [],
  }]);
});

test("Product detail ignores unrelated code-shaped prose without losing name authority", () => {
  const adapter = officialRawAdapterContracts.find(
    ({ sourceLineage }) => sourceLineage === "gundam-en-us",
  );
  const observation = adapter.parseBytes(
    new TextEncoder().encode(`
      <h1>Name-authoritative Booster</h1>
      <p>Compatible with card GD99-001.</p>
    `),
    {
      mediaType: "text/html",
      url: "https://www.gundam-gcg.com/en/products/detail.php?id=name-only",
      requestId: `gundam-en-us:product_detail:${"f".repeat(64)}`,
    },
  )[0];
  assert.deepEqual(
    observation.product_release_catalogue.products,
    [{
      reference: { kind: "name", value: "Name-authoritative Booster" },
      official_code: null,
      name: "Name-authoritative Booster",
      releases: [],
    }],
  );
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
