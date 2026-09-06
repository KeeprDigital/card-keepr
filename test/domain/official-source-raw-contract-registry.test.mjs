import { test } from "vitest";
import assert from "node:assert/strict";
import { officialSourceDiscoveryRequests } from "../../src/catalogue/adapters/product-release-source-adapters.ts";
import {
  assertAdapterBinding,
  installedSourceAdapterRegistrations,
  requiredActiveSourceAdapter,
  requiredSourceAdapter,
  sourceAdapterRegistrations,
} from "../../src/catalogue/adapters/source-adapters.ts";
import syntheticOfficialSource, {
  officialBandaiNavigationHeader,
  officialPublisherPayloadScript,
  officialRawSurfacePayload,
} from "../../acceptance/fixtures/synthetic-official-source.mjs";
import {
  productionAdapterVersions,
  registeredProductionAdapters,
  retainedOfficialSourceFixture,
  restructuredStageDigest,
  exactMessage,
  fusionLiveShapeAdapter,
  fusionErrataDetailFixtures,
  rawSurfacePayload,
  parseRegisteredSurface,
} from "./official-source-raw-contract-shared.mjs";

const expectedSurfaces = {
  "one-piece-en": ["card-list", "products", "releases", "errata"],
  // The restructured Fusion World EN contract drops "errata": the publisher
  // retired /fw/en/rules/errata-card/ and publishes no replacement.
  "fusion-world-en": ["card-search", "products", "releases"],
  "digimon-en": ["card-list", "products", "releases", "errata"],
  "gundam-en-asia": ["packages", "products", "releases", "errata"],
  "gundam-en-us": ["packages", "products", "releases", "errata"],
};

const expectedSurfaceUrls = {
  "one-piece-en": {
    "card-list": "https://en.onepiece-cardgame.com/cardlist/?series=569116",
    products: "https://en.onepiece-cardgame.com/products/",
    releases: "https://en.onepiece-cardgame.com/products/",
    errata: "https://en.onepiece-cardgame.com/rules/errata_card/",
  },
  "fusion-world-en": {
    "card-search": "https://www.dbs-cardgame.com/fw/en/cardlist/?search=true&category%5B0%5D=583301",
    products: "https://www.dbs-cardgame.com/fw/en/products/",
    releases: "https://www.dbs-cardgame.com/fw/en/products/",
  },
  "digimon-en": {
    "card-list": "https://world.digimoncard.com/cards/index.php?search=true",
    products: "https://world.digimoncard.com/products/",
    releases: "https://world.digimoncard.com/products/",
    errata: "https://world.digimoncard.com/rule/errata_card/",
  },
  "gundam-en-asia": {
    packages: "https://www.gundam-gcg.com/asia-en/cards/index.php",
    products: "https://www.gundam-gcg.com/asia-en/products/list.php",
    releases: "https://www.gundam-gcg.com/asia-en/products/list.php",
    errata: "https://www.gundam-gcg.com/asia-en/news/?subcategory=news&tag=all&page=1",
  },
  "gundam-en-us": {
    packages: "https://www.gundam-gcg.com/en/cards/index.php",
    products: "https://www.gundam-gcg.com/en/products/list.php",
    releases: "https://www.gundam-gcg.com/en/products/list.php",
    errata: "https://www.gundam-gcg.com/en/news/?subcategory=news&tag=all&page=1",
  },
};

// The restructured navigation resolves each cards seed through the
// publisher's live redirect target instead of the retired bare index.
const expectedDiscoveryLinks = {
  "one-piece-en": [
    ["FIND CARDS", "/cardlist/?series=569116"],
    ["ALL PRODUCTS", "/products/"],
    ["RULES", "/rules/"],
  ],
  "fusion-world-en": [
    ["CARDS", "/fw/en/cardlist/?search=true&category%5B0%5D=583301"],
    ["ALL PRODUCTS", "/fw/en/products/"],
  ],
  "digimon-en": [
    ["CARD LIST", "/cards/index.php?search=true"],
    ["PRODUCTS", "/products/"],
    ["RULES", "/rule/"],
  ],
  "gundam-en-asia": [
    ["FIND CARDS", "/asia-en/cards/"],
    ["PRODUCT LIST", "/asia-en/products/list.php"],
    ["NEWS", "/asia-en/news/"],
  ],
  "gundam-en-us": [
    ["FIND CARDS", "/en/cards/"],
    ["PRODUCT LIST", "/en/products/list.php"],
    ["NEWS", "/en/news/"],
  ],
};

const expectedDiscoveryKeys = {
  "one-piece-en": ["cards", "products", "rules"],
  "fusion-world-en": ["cards", "products"],
  "digimon-en": ["cards", "products", "rules"],
  "gundam-en-asia": ["cards", "products", "news"],
  "gundam-en-us": ["cards", "products", "news"],
};

function discoveryHtml(sourceLineage, mutate = (entries) => entries) {
  const entries = expectedDiscoveryLinks[sourceLineage].map(([label, url]) => ({ label, url }));
  return `<!doctype html><html><head><title>Bandai Official Source</title>
    </head><body><header><nav>${mutate(structuredClone(entries))
      .map(({ label, url }) => `<a href="${url}">${label}</a>`)
      .join("")}</nav></header></body></html>`;
}

// The single registration per lineage. Before Go-Live (ADR 0008) no
// predecessor is parseable and no retired registration exists; the
// production One Piece capacity of 2026-09-03 (#134) is edited in place.
const expectedProductionAdapterVersions = [
  "digimon-en@7",
  "fusion-world-en@9",
  "gundam-en-asia@7",
  "gundam-en-us@7",
  "one-piece-en@6",
];

// Discovery roots retained at each active adapter's discovery request URL.
// The Gundam find-cards roots kept their URL across the restructure, so their
// original captures remain the exact discovery evidence.
const retainedDiscoveryFixtures = {
  "one-piece-en": "one-piece-en-restructured-discovery",
  "fusion-world-en": "fusion-world-en-restructured-card-search",
  "digimon-en": "digimon-en-restructured-card-search",
  "gundam-en-asia": "gundam-en-asia-discovery",
  "gundam-en-us": "gundam-en-us-discovery",
};

test("retained live discovery bytes derive every production surface family", () => {
  for (const adapter of registeredProductionAdapters()) {
    const request = officialSourceDiscoveryRequests(adapter.sourceLineage)[0];
    const fixture = retainedOfficialSourceFixture(retainedDiscoveryFixtures[adapter.sourceLineage]);
    assert.equal(fixture.metadata.http_status, 200);
    assert.equal(fixture.metadata.source_url, request.url);
    const records = adapter
      .parseBytes(fixture.bytes, {
        mediaType: fixture.metadata.content_type,
        url: request.url,
        requestId: request.id,
      })
      .flatMap((observation) => observation.records ?? []);
    assert.deepEqual(
      records.map(({ surface }) => surface),
      expectedDiscoveryKeys[adapter.sourceLineage].map((key) => `@seed:${key}`),
    );
    const staged = adapter.discoverRequests(fixture.bytes, {
      mediaType: fixture.metadata.content_type,
      url: request.url,
      requestId: request.id,
    });
    assert.ok(staged.length > 0);
    assert.ok(
      staged.every(({ headers }) => headers["user-agent"] === "card-keepr-official-source/1; request-role=listing"),
    );
  }
});

test("Product and Release fixture bytes are invariant under retries and reordering", async () => {
  const url = "https://en.onepiece-cardgame.com/products/";
  const responseBytes = async (surface) =>
    new Uint8Array(
      await (
        await syntheticOfficialSource.fetch(
          new Request(url, {
            headers: {
              "user-agent": `card-keepr-product-routing-golden; request-role=surface; request-surface=${surface}`,
            },
          }),
        )
      ).arrayBuffer(),
    );
  const productA = await responseBytes("products");
  const releaseA = await responseBytes("releases");
  const productB = await responseBytes("products");
  const releaseB = await responseBytes("releases");
  const productC = await responseBytes("products");

  assert.deepEqual(productB, productA);
  assert.deepEqual(productC, productA);
  assert.deepEqual(releaseB, releaseA);
  assert.notDeepEqual(releaseA, productA);
});

test("every production lineage owns an exact raw decoder and discovery plan", () => {
  const production = registeredProductionAdapters();
  assert.deepEqual(production.map(({ sourceLineage }) => sourceLineage).sort(), Object.keys(expectedSurfaces).sort());
  assert.deepEqual(production.map(({ adapterVersion }) => adapterVersion).sort(), expectedProductionAdapterVersions);
  for (const adapter of production) {
    assert.doesNotThrow(() =>
      assertAdapterBinding(adapter, {
        sourceLineage: adapter.sourceLineage,
        supportedGame: adapter.supportedGame,
        gameProfileVersion: adapter.gameProfileVersion,
      }),
    );
    assert.equal(adapter.origin, "production");
    assert.equal(adapter.reconciliationCapability, "catalogue");
    assert.deepEqual(
      adapter.reconciliationAreas,
      // Fusion World's restructured contract owns no errata surface, so it
      // reconciles catalogue evidence alone.
      adapter.adapterVersion === "fusion-world-en@9" ? ["catalogue"] : ["catalogue", "errata"],
    );
    assert.equal(adapter.gameProfileVersion, `${adapter.supportedGame}@1`);
    // After the issue-58 and optional-card-field generations, every active
    // lineage declares the @6 parser contract; the fusion live-shape
    // generation advances its lineage to @7.
    assert.equal(
      adapter.parserContract,
      adapter.sourceLineage === "fusion-world-en"
        ? "fusion-world-en-restructured-complete-catalogue@7"
        : `${adapter.sourceLineage}-restructured-complete-catalogue@6`,
    );
    assert.match(adapter.parserContract, /-restructured-complete-catalogue@[67]$/u);
    assert.equal(typeof adapter.parseBytes, "function");
    assert.deepEqual(adapter.requiredSurfaces, expectedSurfaces[adapter.sourceLineage]);
    assert.deepEqual(
      Object.fromEntries(adapter.requiredSurfaces.map((surface) => [surface, adapter.requestUrlForSurface(surface)])),
      expectedSurfaceUrls[adapter.sourceLineage],
    );
    const requests = officialSourceDiscoveryRequests(adapter.sourceLineage);
    assert.deepEqual(
      requests.map(({ id }) => id),
      [`${adapter.sourceLineage}:discovery`],
    );
    assert.deepEqual(requests[0].headers, {
      accept: "text/html",
    });
    assert.equal(requests.length, 1);
    assert.ok(
      requests.every(
        ({ url }) =>
          new URL(url).hostname.endsWith("bandai.com") ||
          new URL(url).hostname.endsWith("cardgame.com") ||
          new URL(url).hostname.endsWith("digimoncard.com") ||
          new URL(url).hostname.endsWith("gundam-gcg.com"),
      ),
      `${adapter.sourceLineage} must be bound to Bandai-owned hosts`,
    );
    assert.ok(
      requests.every(({ url }) => !new URL(url).pathname.includes(adapter.sourceLineage)),
      `${adapter.sourceLineage} must use upstream paths, not Keepr paths`,
    );

    const retainedDiscovery = retainedOfficialSourceFixture(retainedDiscoveryFixtures[adapter.sourceLineage]);
    const retainedHtml = retainedDiscovery.bytes.toString("utf8");
    const discovery = adapter.parseBytes(retainedDiscovery.bytes, {
      mediaType: retainedDiscovery.metadata.content_type,
      url: requests[0].url,
      requestId: requests[0].id,
    });
    const discoveryRecords = discovery.flatMap((observation) => observation.records ?? []);
    assert.ok(
      discoveryRecords.every(
        ({ url, discovered_from }) => retainedHtml.includes(discovered_from.resolution) || url === requests[0].url,
      ),
      `${adapter.sourceLineage} discovery may only emit URLs literally retained in the source bytes or the retained request URL itself`,
    );
    assert.deepEqual(
      discoveryRecords.map(({ discovered_from: _derivation, ...record }) => record),
      expectedDiscoveryLinks[adapter.sourceLineage].map(([, href], index) => ({
        id: `${adapter.sourceLineage}:discovery-seed:${expectedDiscoveryKeys[adapter.sourceLineage][index]}`,
        surface: `@seed:${expectedDiscoveryKeys[adapter.sourceLineage][index]}`,
        method: "GET",
        url: new URL(href, requests[0].url).href,
        headers: { accept: "text/html" },
      })),
    );
    for (const record of discoveryRecords) {
      assert.deepEqual(Object.keys(record.discovered_from).sort(), ["kind", "label", "resolution", "url"]);
      assert.equal(record.discovered_from.kind, "publisher_navigation");
      assert.ok(
        expectedDiscoveryLinks[adapter.sourceLineage].some(
          ([label, href]) =>
            label.toLowerCase() === record.discovered_from.label &&
            href === record.discovered_from.resolution &&
            record.discovered_from.url === requests[0].url,
        ),
      );
      assert.equal(new URL(record.discovered_from.resolution, record.discovered_from.url).href, record.url);
    }
  }
});

test("production registrations and dynamic discovery enforce exact lineage URL authority", () => {
  for (const adapter of registeredProductionAdapters()) {
    assert.ok(adapter.officialSourceContract);
    const root = new URL(adapter.requestUrlForDiscovery());
    assert.equal(adapter.officialSourceContract.origin, root.origin);
    assert.ok(
      adapter.officialSourceContract.documentPathnamePrefixes.some((prefix) => root.pathname.startsWith(prefix)),
    );

    const validDetailUrl = new URL(root);
    validDetailUrl.searchParams.set(
      "detailSearch",
      adapter.sourceLineage === "fusion-world-en" ? "FB99-001_p2" : "CK30",
    );
    const validDetail = validDetailUrl.href;
    const hostileOrigin = new URL(validDetail);
    hostileOrigin.hostname = `assets.${root.hostname}`;
    const hostilePath = new URL(validDetail);
    hostilePath.pathname =
      adapter.sourceLineage === "gundam-en-asia"
        ? hostilePath.pathname.replace("/asia-en/", "/en/")
        : adapter.sourceLineage === "gundam-en-us"
          ? hostilePath.pathname.replace("/en/", "/asia-en/")
          : `/outside-lineage${hostilePath.pathname}`;
    const fusionLeaf = adapter.sourceLineage === "fusion-world-en";
    const gundamLeaf = adapter.sourceLineage.startsWith("gundam-en-");
    // The restructured Fusion World card-search URL is already a complete
    // category leaf, and every leaf must enumerate the publisher categories.
    const discoveryUrl = fusionLeaf
      ? adapter.requestUrlForSurface(adapter.requiredSurfaces[0])
      : gundamLeaf
        ? `${adapter.requestUrlForSurface(adapter.requiredSurfaces[0])}?package=GD01`
        : adapter.requestUrlForSurface(adapter.requiredSurfaces[0]);
    const publisherFacets = fusionLeaf
      ? `<section class="searchColSet-product">
           <a data-val="583301">Series 583301</a>
           <a data-val="583302">Series 583302</a>
         </section>`
      : "";
    const requests = adapter.discoverRequests(
      new TextEncoder().encode(`
        ${publisherFacets}
        <a href="${validDetail}">Card detail</a>
        <a href="${hostileOrigin.href}">Wrong subdomain</a>
        <a href="${hostilePath.href}">Wrong locale path</a>
      `),
      {
        mediaType: "text/html; charset=utf-8",
        url: discoveryUrl,
        requestId:
          fusionLeaf || gundamLeaf
            ? `${adapter.sourceLineage}:listing:${"6".repeat(64)}`
            : `${adapter.sourceLineage}:${adapter.requiredSurfaces[0]}`,
      },
    );
    assert.ok(requests.some(({ url }) => url === validDetail));
    assert.equal(
      requests.some(({ url }) => url === hostileOrigin.href),
      false,
    );
    assert.equal(
      requests.some(({ url }) => url === hostilePath.href),
      false,
    );
  }
});

test("production discovery is proven by complete exact retained navigation", () => {
  for (const adapter of registeredProductionAdapters()) {
    const request = officialSourceDiscoveryRequests(adapter.sourceLineage)[0];
    const parse = (html) =>
      adapter.parseBytes(new TextEncoder().encode(html), {
        mediaType: "text/html; charset=utf-8",
        url: request.url,
        requestId: request.id,
      });
    const mutations = {
      blank: () => "<!doctype html><html><body></body></html>",
      missing: () => discoveryHtml(adapter.sourceLineage, (entries) => entries.slice(1)),
      moved: () =>
        discoveryHtml(adapter.sourceLineage, (entries) => {
          entries[0].url = "https://example.com/moved";
          return entries;
        }),
      extra: () =>
        discoveryHtml(adapter.sourceLineage, (entries) => [
          ...entries,
          {
            label: entries[0].label,
            url: "https://example.com/unknown",
          },
        ]),
      duplicate: () => discoveryHtml(adapter.sourceLineage, (entries) => [entries[0], entries[0], ...entries.slice(2)]),
      "mismatched semantic link": () =>
        discoveryHtml(adapter.sourceLineage, (entries) => {
          entries[0].label = entries[1].label;
          return entries;
        }),
      "undemonstrated anchor attributes": () =>
        discoveryHtml(adapter.sourceLineage).replace("<a href=", '<a class="unexpected" href='),
      "undemonstrated anchor nesting": () =>
        discoveryHtml(adapter.sourceLineage).replace("<a href=", "<div><a href=").replace("</a>", "</a></div>"),
    };
    for (const [failure, html] of Object.entries(mutations)) {
      assert.throws(
        () => parse(html()),
        /discovery/iu,
        `${adapter.sourceLineage} must reject ${failure} discovery evidence`,
      );
    }
  }
});

// ADR 0008: before Go-Live every installed Source Adapter Version carries
// its parser and no registration is retired or superseded. An unknown
// version is simply not supported.
function isAdministrationProblem(code) {
  return (error) => error.status === 422 && error.code === code;
}

const expectedRequestCapacities = {
  "one-piece-en@6": 10_000,
  "fusion-world-en@9": 15_000,
  "digimon-en@7": 5_000,
  "gundam-en-asia@7": 5_000,
  "gundam-en-us@7": 5_000,
};

test("every installed adapter version carries its parser and unknown versions are not supported", () => {
  const rawProduction = installedSourceAdapterRegistrations.filter(
    (adapter) =>
      adapter.origin === "production" &&
      adapter.reconciliationCapability === "catalogue" &&
      typeof adapter.parseBytes === "function",
  );
  assert.deepEqual(rawProduction.map(({ adapterVersion }) => adapterVersion).sort(), expectedProductionAdapterVersions);
  assert.equal(
    new Set(rawProduction.map(({ sourceLineage }) => sourceLineage)).size,
    rawProduction.length,
    "each Source Lineage registers exactly one raw production version",
  );
  for (const adapter of rawProduction) {
    assert.equal(adapter.requestCapacity, expectedRequestCapacities[adapter.adapterVersion], adapter.adapterVersion);
  }
  for (const adapter of installedSourceAdapterRegistrations) {
    assert.equal(
      typeof adapter.parseBytes === "function" || typeof adapter.parse === "function",
      true,
      adapter.adapterVersion,
    );
    assert.equal(requiredSourceAdapter(adapter.adapterVersion), adapter);
    assert.ok(sourceAdapterRegistrations.includes(adapter));
  }
  for (const unknown of [
    "one-piece-en@999",
    "one-piece-en@4",
    "one-piece-en@5",
    "fusion-world-en@8",
    "digimon-en@6",
    "gundam-en-asia@6",
    "gundam-en-us@6",
  ]) {
    assert.throws(
      () => requiredActiveSourceAdapter(unknown),
      isAdministrationProblem("adapter_not_supported"),
      unknown,
    );
    assert.throws(() => requiredSourceAdapter(unknown), isAdministrationProblem("adapter_not_supported"), unknown);
    assert.ok(!productionAdapterVersions.includes(unknown));
  }
});

test("production decoders accept real Bandai-shaped HTML without a Keepr payload wrapper", () => {
  const adapter = registeredProductionAdapters().find(({ sourceLineage }) => sourceLineage === "one-piece-en");
  const cardListUrl = adapter.requestUrlForSurface("card-list");
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
  const observations = adapter.parseBytes(bytes, {
    mediaType: "text/html; charset=utf-8",
    url: adapter.requestUrlForSurface("card-list"),
  });
  assert.equal(observations.length, 1);
  assert.equal(observations[0].card.official_identity.value, "OP99-001");
  assert.equal(observations[0].identity_evidence.locator, "OP99-001");
  assert.equal(
    observations[0].appearance_evidence.images[0].source_url,
    "https://en.onepiece-cardgame.com/images/cardlist/card/OP99-001.png",
  );
  assert.equal(observations[0].card.effective_rules_text, "Official effect\nSecond section");
  assert.equal(observations[0].card.game_data.attributes.cost, null);
  assert.equal(observations[0].card.game_data.attributes.life, 5);
  assert.equal(observations[0].card.game_data.attributes.trigger_text, "Official trigger");
  // A pinned Recording leaf owns its membership: the bucket follows the
  // requested series rather than the printed Card Set label.
  assert.deepEqual(observations[0].memberships.source_buckets, ["recording:569116"]);
  assert.deepEqual(observations[0].product_release_catalogue.distribution_contexts, []);
  assert.doesNotMatch(
    observations[0].identity_evidence.artwork_fingerprint,
    /https?:|OP99-001\.png|#OP99-001|content_sha|sha256|image\//u,
  );
  assert.equal(
    observations[0].identity_evidence.artwork_fingerprint,
    'official-artwork:{"official_card_identity":"OP99-001","roles":["front"],"artwork_id":"op99-001-standard-art"}',
  );
  assert.equal(observations[0].identity_evidence.treatment, null);
  assert.equal(Object.hasOwn(observations[0].printing.game_data.attributes, "illustration_types"), false);
  assert.equal(
    observations[0].identity_evidence.demonstrably_novel,
    false,
    "raw parser output cannot prove an appearance is novel before its image bytes are retained and verified",
  );
  assert.match(observations[0].identity_evidence.printed_fields_digest, /Official effect\\nSecond section/u);
  const relocated = adapter.parseBytes(
    new TextEncoder().encode(
      html
        .replaceAll("OP99-001.png", "OP99-001.webp?encoding=2")
        .replace('id="OP99-001"', 'id="OP99-001_p9"')
        .replace("Test Set [OP99]", "Different source bucket"),
    ),
    {
      mediaType: "text/html; charset=utf-8",
      url: cardListUrl,
    },
  );
  assert.equal(
    relocated[0].identity_evidence.artwork_fingerprint,
    observations[0].identity_evidence.artwork_fingerprint,
  );
  const redistributed = adapter.parseBytes(
    new TextEncoder().encode(
      html
        .replaceAll("OP99-001.png", "unrelated-distribution-filename.webp?width=2048&encoding=next")
        .replace("<img data-src=", '<img width="2048" height="2856" data-src='),
    ),
    {
      mediaType: "text/html; charset=utf-8",
      url: cardListUrl,
    },
  );
  assert.equal(
    redistributed[0].identity_evidence.artwork_fingerprint,
    observations[0].identity_evidence.artwork_fingerprint,
  );
  const unidentified = adapter.parseBytes(
    new TextEncoder().encode(html.replace(' data-artwork-id="op99-001-standard-art"', "")),
    {
      mediaType: "text/html; charset=utf-8",
      url: cardListUrl,
    },
  );
  assert.equal(
    unidentified[0].identity_evidence.artwork_fingerprint,
    'official-artwork:{"official_card_identity":"OP99-001","roles":["front"],"artwork_id":null}',
  );
  const unfamiliarTreatment = adapter.parseBytes(
    new TextEncoder().encode(
      html.replace(
        '<div class="getInfo"><h3>Card Set(s)</h3>',
        '<div class="treatment"><h3>Treatment</h3>Textured Foil</div>' + '<div class="getInfo"><h3>Card Set(s)</h3>',
      ),
    ),
    {
      mediaType: "text/html; charset=utf-8",
      url: cardListUrl,
    },
  )[0];
  assert.equal(unfamiliarTreatment.identity_evidence.treatment, null);
  assert.ok(unfamiliarTreatment.source_sidecar.unmapped_optional_fields.some(({ value }) => value === "Textured Foil"));
  const unfamiliarLabel = adapter.parseBytes(
    new TextEncoder().encode(
      html.replace(
        '<div class="getInfo"><h3>Card Set(s)</h3>',
        "<div><h3>New Optional Label</h3>Preserve me</div>" + '<div class="getInfo"><h3>Card Set(s)</h3>',
      ),
    ),
    {
      mediaType: "text/html; charset=utf-8",
      url: cardListUrl,
    },
  )[0];
  assert.ok(
    unfamiliarLabel.source_sidecar.raw.official_surfaces[0].document.raw_label_pairs.some(
      ({ label, value }) => label === "New Optional Label" && value === "Preserve me",
    ),
  );
  assert.ok(unfamiliarLabel.source_sidecar.unmapped_optional_fields.some(({ value }) => value === "Preserve me"));
  assert.throws(
    () =>
      adapter.parseBytes(
        new TextEncoder().encode(html.replace("| <span>L</span> |", "| <span>Experimental Rare</span> |")),
        {
          mediaType: "text/html; charset=utf-8",
          url: cardListUrl,
        },
      ),
    /One Piece rarity.*Experimental Rare|Experimental Rare.*rarity/iu,
  );
  assert.throws(
    () =>
      adapter.parseBytes(
        new TextEncoder().encode(
          html.replace(
            '<div class="cost"><h3>Life</h3>5</div>',
            '<div class="cost"><h3>Life</h3>5</div>' + "<div><h3>Cost</h3>1</div>",
          ),
        ),
        {
          mediaType: "text/html; charset=utf-8",
          url: cardListUrl,
        },
      ),
    /Leader.*cost.*null/iu,
  );
  const recordingLeaf = requiredSourceAdapter("one-piece-en@6").parseBytes(bytes, {
    mediaType: "text/html; charset=utf-8",
    url: "https://en.onepiece-cardgame.com/cardlist/?recording=569114",
    requestId: "one-piece-en:card-list",
  });
  assert.deepEqual(recordingLeaf[0].memberships.source_buckets, ["card-set:Test Set [OP99]"]);
  const expandedRecording = adapter.parseBytes(bytes, {
    mediaType: "text/html; charset=utf-8",
    url: "https://en.onepiece-cardgame.com/cardlist/?series=569114",
    requestId: `one-piece-en:listing:${"b".repeat(64)}`,
  });
  assert.deepEqual(expandedRecording[0].memberships.source_buckets, ["recording:569114"]);
  assert.ok(
    adapter
      .discoverRequests(bytes, {
        mediaType: "text/html; charset=utf-8",
        url: cardListUrl,
        requestId: "one-piece-en:card-list",
      })
      .some(({ role, url }) => role === "listing" && new URL(url).searchParams.get("series") === "569114"),
  );
});

test("generic Schema.org Dataset payloads cannot enter production adapters", () => {
  const adapter = requiredSourceAdapter("one-piece-en@6");
  const payload = officialRawSurfacePayload("/one-piece-en/card-list");
  assert.throws(
    () =>
      adapter.parseBytes(
        new TextEncoder().encode(
          `<html><script type="application/ld+json">${JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Dataset",
            publisher: { "@type": "Organization", name: "Bandai" },
            hasPart: [
              {
                "@type": "Dataset",
                identifier: "one-piece-en:card-list",
                payload,
              },
            ],
          })}</script></html>`,
        ),
        {
          mediaType: "text/html; charset=utf-8",
          url: adapter.requestUrlForSurface("card-list"),
          requestId: "one-piece-en:card-list",
        },
      ),
    /Card List Recording discovery|publisher|card-list/iu,
  );
});

test("live split discovery follows each lineage's bounded staged hierarchy", () => {
  const byLineage = (lineage) => registeredProductionAdapters().find(({ sourceLineage }) => sourceLineage === lineage);
  const encode = (value) => new TextEncoder().encode(value);

  const onePiece = byLineage("one-piece-en");
  const onePieceRequests = onePiece
    .discoverRequests(
      encode(`
      <select id="series">
        <option value="101">A</option><option value="102">B</option>
      </select>
    `),
      {
        mediaType: "text/html",
        url: onePiece.requestUrlForSurface("card-list"),
        requestId: "one-piece-en:card-list",
      },
    )
    .filter(({ role }) => role === "listing");
  assert.deepEqual(
    onePieceRequests.map(({ url }) => new URL(url).searchParams.toString()),
    ["series=101", "series=102"],
  );

  // The live Fusion World card search partitions by publisher category
  // alone; every category is one complete listing leaf.
  const fusion = byLineage("fusion-world-en");
  const fusionCategories = (...values) => `
    <section class="searchColSet-product">
      ${values.map((value) => `<a data-val="${value}">Series ${value}</a>`).join("")}
    </section>
  `;
  const fusionRoot = fusion
    .discoverRequests(encode(fusionCategories("583301", "583302", "583303")), {
      mediaType: "text/html",
      url: fusion.requestUrlForSurface("card-search"),
      requestId: "fusion-world-en:card-search",
    })
    .filter(({ role }) => role === "listing");
  assert.deepEqual(
    fusionRoot.map(({ url }) => new URL(url).searchParams.toString()),
    ["search=true&category%5B0%5D=583302", "search=true&category%5B0%5D=583303"],
  );
  const fusionSibling = fusion
    .discoverRequests(encode(fusionCategories("583301", "583302", "583303")), {
      mediaType: "text/html",
      url: "https://www.dbs-cardgame.com/fw/en/cardlist/?search=true&category%5B0%5D=583302",
      requestId: `fusion-world-en:listing:${"a".repeat(64)}`,
    })
    .filter(({ role }) => role === "listing");
  assert.deepEqual(
    fusionSibling.map(({ url }) => new URL(url).searchParams.toString()),
    ["search=true&category%5B0%5D=583301", "search=true&category%5B0%5D=583303"],
  );

  const digimon = byLineage("digimon-en");
  const digimonRoot = digimon
    .discoverRequests(
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
    )
    .filter(({ role }) => role === "listing");
  assert.deepEqual(
    digimonRoot.map(({ url }) => new URL(url).searchParams.get("category")),
    ["booster", "starter"],
  );
  const digimonCardType = digimon
    .discoverRequests(
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
    )
    .filter(({ role }) => role === "listing");
  assert.deepEqual(
    digimonCardType.map(({ url }) => new URL(url).searchParams.get("cardcategory")),
    ["digimon", "option"],
  );

  const cappedListing = (...categories) => `
    <html><title>BANDAI DRAGON BALL CARD search</title>
      <p>More than 1,000 results were capped</p>
      ${fusionCategories(...categories)}
      <div class="resultTxt">Result<span class="num">0</span>cards</div>
    </html>
  `;
  assert.doesNotThrow(() =>
    fusion.parseBytes(encode(cappedListing("583301", "583302")), {
      mediaType: "text/html",
      url: fusion.requestUrlForSurface("card-search"),
      requestId: `fusion-world-en:listing:${"8".repeat(64)}`,
    }),
  );
  assert.throws(
    () =>
      fusion.parseBytes(encode(cappedListing("583301")), {
        mediaType: "text/html",
        url: fusion.requestUrlForSurface("card-search"),
        requestId: `fusion-world-en:listing:${"7".repeat(64)}`,
      }),
    /leaf partition still displays/iu,
  );
});

test("intermediate publisher discovery stages cannot emit or schedule catalogue facts", () => {
  const cases = [
    {
      lineage: "one-piece-en",
      url: "https://en.onepiece-cardgame.com/products/",
      detail: "/products/booster/op01/",
      image: "/images/products/op01.png",
    },
    {
      lineage: "fusion-world-en",
      url: "https://www.dbs-cardgame.com/fw/en/products/",
      detail: "/fw/en/products/booster/fb01/",
      image: "/fw/images/products/fb01.png",
    },
    {
      lineage: "digimon-en",
      url: "https://world.digimoncard.com/products/",
      detail: "/products/booster/bt01/",
      image: "/images/products/bt01.png",
    },
    {
      lineage: "gundam-en-asia",
      url: "https://www.gundam-gcg.com/asia-en/products/list.php",
      detail: "/asia-en/products/detail.php?id=gd01",
      image: "/asia-en/images/products/gd01.png",
    },
    {
      lineage: "gundam-en-us",
      url: "https://www.gundam-gcg.com/en/products/list.php",
      detail: "/en/products/detail.php?id=gd01",
      image: "/en/images/products/gd01.png",
    },
  ];
  for (const fixture of cases) {
    const adapter = registeredProductionAdapters().find(({ sourceLineage }) => sourceLineage === fixture.lineage);
    assert.ok(adapter);
    const html = `<html>
      <title>BANDAI Official Product List</title>
      <main><a href="${fixture.detail}">Booster detail</a></main>
      <img src="${fixture.image}">
    </html>`;
    const stageContext = {
      mediaType: "text/html; charset=utf-8",
      url: fixture.url,
      requestId: `${fixture.lineage}:listing:products:${"a".repeat(64)}`,
    };
    const observations = adapter.parseBytes(new TextEncoder().encode(html), stageContext);
    assert.ok(
      observations.every(({ observation_type }) => observation_type === "official_surface_evidence"),
      `${fixture.lineage} stage emitted a catalogue observation`,
    );
    assert.deepEqual(
      adapter.discoverRequests(new TextEncoder().encode(html), stageContext),
      [],
      `${fixture.lineage} stage scheduled a catalogue-bearing request`,
    );
  }
});

test("known publisher navigation cannot manufacture catalogue detail requests", () => {
  for (const adapter of registeredProductionAdapters()) {
    const surface = adapter.requiredSurfaces[0];
    assert.ok(surface);
    // Fusion World's restructured leaf must still enumerate its own
    // category; only the currently served one proves no further partition.
    const publisherFacets =
      adapter.sourceLineage === "fusion-world-en"
        ? '<section class="searchColSet-product"><a data-val="583301">Series</a></section>'
        : "";
    const requests = adapter.discoverRequests(
      new TextEncoder().encode(
        `<html><title>BANDAI Official Card List</title>${officialBandaiNavigationHeader(
          adapter.sourceLineage,
        )}${publisherFacets}</html>`,
      ),
      {
        mediaType: "text/html; charset=utf-8",
        url: adapter.requestUrlForSurface(surface),
        requestId: `${adapter.sourceLineage}:${surface}`,
      },
    );
    assert.deepEqual(
      requests,
      [],
      `${adapter.sourceLineage} publisher navigation scheduled catalogue detail collection`,
    );
  }
});

test("live Product detail normalizes stable release identity and raw vocabulary", () => {
  const adapter = registeredProductionAdapters().find(({ sourceLineage }) => sourceLineage === "gundam-en-us");
  const observation = adapter.parseBytes(
    new TextEncoder().encode(`
      <title>Test Booster [GD99] | GUNDAM CARD GAME Official Website</title>
      <h1>GUNDAM CARD GAME</h1>
      <h2 class="mvColTitle">Test Booster [GD99]</h2>
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
  const release = observation.product_release_catalogue.products[0].releases[0];
  // Release identity is derived from the titled Product itself; a publisher
  // "Release Event ID" is retained as raw vocabulary, never as identity.
  assert.deepEqual(release, {
    event_key: "product-release:GD99",
    region: "EN-US",
    date: { precision: "quarter", value: "2027-Q3" },
    status: "released",
  });
  assert.ok(
    observation.source_sidecar.unmapped_optional_fields.some(
      ({ path, value }) => path.endsWith(".Release Event ID") && value === "launch-wave",
    ),
  );
  assert.ok(
    observation.source_sidecar.unmapped_optional_fields.some(
      ({ path, value }) => path.endsWith(".Future Vendor Fact") && value === "Preserve me",
    ),
  );
});

test("live Product detail maps official display dates and fails closed on new status vocabulary", () => {
  const adapter = registeredProductionAdapters().find(({ sourceLineage }) => sourceLineage === "gundam-en-us");
  const base = `
    <title>Display Date Booster [GD98] | GUNDAM CARD GAME Official Website</title>
    <h1>GUNDAM CARD GAME</h1>
    <h2 class="mvColTitle">Display Date Booster [GD98]</h2>
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
  const release = adapter.parseBytes(new TextEncoder().encode(base), context)[0].product_release_catalogue.products[0]
    .releases[0];
  assert.deepEqual(release.date, {
    precision: "day",
    value: "2027-09-12",
  });
  assert.equal(release.status, "announced");
  assert.throws(
    () => adapter.parseBytes(new TextEncoder().encode(base.replace("Coming Soon", "Vendor Future Phase")), context),
    /unrecognized official Release status/iu,
  );
});

test("nested raw unknown leaves remain warnings when their container is mapped", () => {
  const adapter = registeredProductionAdapters().find(({ sourceLineage }) => sourceLineage === "one-piece-en");
  const document = rawSurfacePayload("one-piece-en", "card-list");
  document.card_pages[0].future_nested = {
    vendor_rule: "retain this nested leaf",
  };
  const observation = parseRegisteredSurface(adapter, "card-list", document)[0];
  assert.ok(
    observation.source_sidecar.unmapped_optional_fields.some(
      ({ path, value }) =>
        path.endsWith(".card_pages[0].future_nested.vendor_rule") && value === "retain this nested leaf",
    ),
  );
});

test("explicit Product links produce typed memberships and relationships", () => {
  const adapter = registeredProductionAdapters().find(({ sourceLineage }) => sourceLineage === "digimon-en");
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
  assert.match(observation.appearance_evidence.images[0].source_url, /BT99-001\.png$/u);
  assert.deepEqual(observation.card.game_data.attributes.digivolution_requirements, [
    {
      index: 1,
      from_level: 3,
      colours: ["blue"],
      cost: 2,
      raw_condition: "Blue Lv.3: 2",
    },
  ]);
  assert.equal(observation.product_release_catalogue.relationships[0].resolution, "explicit");
  assert.ok(
    observation.product_release_catalogue.relationships.some(
      ({ resolution, product_reference }) => resolution === "fuzzy" && product_reference.value === "Possible product",
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

test("every production lineage preserves its synthetic publisher-contract examples", () => {
  for (const adapter of registeredProductionAdapters()) {
    // A publication surface that carries no catalogue or legality parser of
    // its own; Fusion World publishes no errata surface any more.
    const surface = adapter.requiredSurfaces.includes("errata") ? "errata" : "releases";
    assert.ok(adapter.requiredSurfaces.includes(surface));
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
    const retained = observations[0].source_sidecar.raw.official_surfaces[0].document;
    assert.deepEqual(retained.discovered_options, [{ value: "official", label: "Official partition" }]);
    assert.equal(retained.publication_links.length, 1);
  }
});

test("Product detail ignores unrelated code-shaped prose without losing name authority", () => {
  const adapter = registeredProductionAdapters().find(({ sourceLineage }) => sourceLineage === "gundam-en-us");
  const observation = adapter.parseBytes(
    new TextEncoder().encode(`
      <title>Name-authoritative Booster | GUNDAM CARD GAME Official Website</title>
      <h1>GUNDAM CARD GAME</h1>
      <h2 class="titleColInnerHead">Name-authoritative Booster</h2>
      <p>Compatible with card GD99-001.</p>
    `),
    {
      mediaType: "text/html",
      url: "https://www.gundam-gcg.com/en/products/detail.php?id=name-only",
      requestId: `gundam-en-us:product_detail:${"f".repeat(64)}`,
    },
  )[0];
  assert.deepEqual(observation.product_release_catalogue.products, [
    {
      reference: { kind: "name", value: "Name-authoritative Booster" },
      official_code: null,
      name: "Name-authoritative Booster",
      releases: [],
    },
  ]);
});

test("accessory detail traversal retains non-card evidence without publishing a Product", () => {
  const adapter = registeredProductionAdapters().find(({ sourceLineage }) => sourceLineage === "fusion-world-en");
  const index = `
    <html><title>BANDAI DRAGON BALL CARD PRODUCTS</title>
      <article class="booster">
        <a href="/fw/en/products/booster/fb-booster-01/">Booster 01</a>
      </article>
      <article class="accessory">
        <a href="/fw/en/products/accessory/fb-box-01/">Storage Box</a>
      </article>
    </html>
  `;
  const discovered = adapter.discoverRequests(new TextEncoder().encode(index), {
    mediaType: "text/html",
    url: adapter.requestUrlForSurface("products"),
    requestId: "fusion-world-en:products",
  });
  assert.ok(discovered.some(({ url }) => url.includes("/booster/fb-booster-01/")));
  // The live-product generation fetches accessory pages instead of dropping
  // them by URL vocabulary: the classification is proven from retained markup.
  assert.ok(discovered.some(({ url }) => url.includes("/accessory/fb-box-01/")));
  const observation = adapter.parseBytes(
    new TextEncoder().encode(`
      <title>Storage Box | Dragon Ball Super Card Game Fusion World - Official Web Site</title>
      <h1>Dragon Ball Super Card Game Fusion World</h1>
    `),
    {
      mediaType: "text/html",
      url: "https://www.dbs-cardgame.com/fw/en/products/accessory/fb-box-01/",
      requestId: `fusion-world-en:product_detail:${"a".repeat(64)}`,
    },
  )[0];
  assert.deepEqual(observation.product_release_catalogue.products, []);
  assert.ok(
    observation.product_release_catalogue.distribution_contexts.some(
      ({ kind, label }) => kind === "other" && label === "accessory",
    ),
  );
});

test("structured accessory Products remain Distribution Context evidence on every Product-bearing surface", () => {
  const adapter = registeredProductionAdapters().find(({ sourceLineage }) => sourceLineage === "fusion-world-en");
  const accessory = {
    productCode: "FB-SLEEVE-01",
    productName: "Official Storage Sleeves",
  };
  for (const surface of ["products", "card-search"]) {
    const payload = structuredClone(officialRawSurfacePayload(`/fusion-world-en/${surface}`));
    if (surface === "products") {
      payload.result.partitions[0].entries = [accessory];
      payload.result.partitions[0].total = 1;
    } else {
      payload.products.push(accessory);
    }
    const observations = adapter.parseBytes(
      new TextEncoder().encode(`<html>${officialPublisherPayloadScript("fusion-world-en", surface, payload)}</html>`),
      {
        mediaType: "text/html; charset=utf-8",
        url: adapter.requestUrlForSurface(surface),
        requestId: `fusion-world-en:${surface}`,
      },
    );
    assert.equal(
      observations
        .flatMap(({ product_release_catalogue }) => product_release_catalogue.products)
        .some(({ official_code }) => official_code === "FB-SLEEVE-01"),
      false,
    );
    assert.ok(
      observations
        .flatMap(({ product_release_catalogue }) => product_release_catalogue.distribution_contexts)
        .some(({ kind, label }) => kind === "other" && label === "accessory"),
    );
  }
});

test("code-less structured Products and Releases retain name identity with valid event keys", () => {
  const adapter = registeredProductionAdapters().find(({ sourceLineage }) => sourceLineage === "fusion-world-en");
  const product = {
    productCode: null,
    productName: "Announced Product Without Code",
  };
  const release = {
    productCode: null,
    releaseId: "announced-product-without-code",
    region: "EN-US",
    precision: "unknown",
    date: null,
    status: "announced",
  };
  for (const surface of ["products", "releases"]) {
    const payload = structuredClone(officialRawSurfacePayload(`/fusion-world-en/${surface}`));
    const partition = (surface === "products" ? payload.result : payload.events).partitions[0];
    partition.entries = surface === "products" ? [product] : [{ product, release }];
    partition.total = 1;
    const observations = adapter.parseBytes(
      new TextEncoder().encode(`<html>${officialPublisherPayloadScript("fusion-world-en", surface, payload)}</html>`),
      {
        mediaType: "text/html; charset=utf-8",
        url: adapter.requestUrlForSurface(surface),
        requestId: `fusion-world-en:${surface}`,
      },
    );
    const observed = observations.flatMap(({ product_release_catalogue }) => product_release_catalogue.products);
    assert.deepEqual(
      observed.map(({ reference, official_code, name }) => ({
        reference,
        official_code,
        name,
      })),
      [
        {
          reference: {
            kind: "name",
            value: "Announced Product Without Code",
          },
          official_code: null,
          name: "Announced Product Without Code",
        },
      ],
    );
    for (const { event_key } of observed.flatMap(({ releases }) => releases)) {
      assert.match(event_key, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u);
    }
  }
});

test("code-less named Products and Releases survive registered discovery surfaces", () => {
  const adapter = requiredSourceAdapter("fusion-world-en@9");
  const payload = structuredClone(officialRawSurfacePayload("/fusion-world-en/card-search"));
  payload.products.push({
    productCode: null,
    productName: "Discovery Product Without Code",
  });
  payload.releases.push({
    productCode: null,
    productName: "Discovery Product Without Code",
    releaseId: "discovery-product-without-code",
    region: "EN-US",
    precision: "unknown",
    date: null,
    status: "announced",
  });
  payload.detail_pages[0].product_names = ["Discovery Product Without Code"];

  const observations = parseRegisteredSurface(adapter, "card-search", payload);
  const product = observations
    .flatMap(({ product_release_catalogue }) => product_release_catalogue.products)
    .find(({ name }) => name === "Discovery Product Without Code");

  assert.deepEqual(product, {
    reference: {
      kind: "name",
      value: "Discovery Product Without Code",
    },
    official_code: null,
    name: "Discovery Product Without Code",
    releases: [
      {
        event_key: "discovery-product-without-code",
        region: "EN-US",
        date: { precision: "unknown", value: null },
        status: "announced",
      },
    ],
  });
});

test("code-less HTML Product announcements derive stable opaque event identities", () => {
  const adapter = registeredProductionAdapters().find(({ sourceLineage }) => sourceLineage === "gundam-en-us");
  const parse = () =>
    adapter.parseBytes(
      new TextEncoder().encode(`
        <title>Future Product Without Code | GUNDAM CARD GAME Official Website</title>
        <h1>GUNDAM CARD GAME</h1>
        <h2 class="mvColTitle">Future Product Without Code</h2>
        <dl><dt>Release Date</dt><dd>TBA</dd></dl>
      `),
      {
        mediaType: "text/html",
        url: "https://www.gundam-gcg.com/en/products/future-product/",
        requestId: `gundam-en-us:product_detail:${"c".repeat(64)}`,
      },
    )[0].product_release_catalogue.products[0];
  const first = parse();
  const second = parse();
  assert.equal(first.official_code, null);
  assert.deepEqual(first.reference, {
    kind: "name",
    value: "Future Product Without Code",
  });
  assert.equal(first.releases[0].event_key, second.releases[0].event_key);
  assert.match(first.releases[0].event_key, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u);
  assert.equal(first.releases[0].event_key.includes("Future Product"), false);
});

test("unavailable Product release vocabulary normalizes to reviewable unknown values", () => {
  const adapter = registeredProductionAdapters().find(({ sourceLineage }) => sourceLineage === "gundam-en-us");
  for (const dateToken of ["-", "TBA", ""]) {
    const observation = adapter.parseBytes(
      new TextEncoder().encode(`
        <title>Future Booster [GD-FUTURE] | GUNDAM CARD GAME Official Website</title>
        <h1>GUNDAM CARD GAME</h1>
        <h2 class="mvColTitle">Future Booster [GD-FUTURE]</h2>
        <dl><dt>Release Date</dt><dd>${dateToken}</dd></dl>
        <dl><dt>Status</dt><dd>TBA</dd></dl>
      `),
      {
        mediaType: "text/html",
        url: "https://www.gundam-gcg.com/en/products/future-booster/",
        requestId: `gundam-en-us:product_detail:${"b".repeat(64)}`,
      },
    )[0];
    assert.deepEqual(observation.product_release_catalogue.products[0].releases, [
      {
        event_key: "product-release:GD-FUTURE",
        region: "EN-US",
        date: { precision: "unknown", value: null },
        status: "announced",
      },
    ]);
    assert.ok(
      observation.source_sidecar.unmapped_optional_fields.some(
        ({ path, value }) => path.endsWith(".Release Date") && value === dateToken,
      ),
    );
    assert.ok(
      observation.source_sidecar.unmapped_optional_fields.some(
        ({ path, value }) => path.endsWith(".Status") && value === "TBA",
      ),
    );
  }
});

test("production coverage rejects keyword-only HTML without structural entries", () => {
  for (const adapter of registeredProductionAdapters()) {
    const surface = adapter.requiredSurfaces.find(
      (candidate) => candidate !== "card-list" && candidate !== "card-search" && candidate !== "packages",
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

test("the aggregate JSON adapter is fixture-only and cannot claim official coverage", () => {
  // No production registration parses a decoded JSON document; the
  // aggregate document parser belongs to synthetic fixture adapters only.
  assert.equal(
    installedSourceAdapterRegistrations.some(
      ({ origin, parse }) => origin === "production" && typeof parse === "function",
    ),
    false,
  );
  const adapter = registeredProductionAdapters().find(({ sourceLineage }) => sourceLineage === "fusion-world-en");
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

test("all five raw decoders accept only their exact retained surface bytes", () => {
  for (const contract of registeredProductionAdapters()) {
    for (const surface of contract.requiredSurfaces) {
      const payload = rawSurfacePayload(contract.sourceLineage, surface);
      assert.equal(
        Object.hasOwn(payload, "contract"),
        false,
        "fixture must retain an upstream-shaped document, not a Keepr envelope",
      );
      const observations = parseRegisteredSurface(contract, surface, payload);
      assert.ok(observations.length >= 1);
      if (surface === "card-list" || surface === "card-search" || surface === "packages") {
        const sidecar = observations[0].source_sidecar;
        assert.equal(sidecar.raw.official_surfaces[0].document.vendor_extension.future_field, true);
        assert.ok(sidecar.unmapped_optional_fields.some(({ path }) => path.endsWith(".vendor_extension.future_field")));
        assert.ok(observations[0].memberships.source_buckets.length > 0);
        if (contract.sourceLineage === "fusion-world-en") {
          assert.deepEqual(
            observations[0].appearance_evidence.images.map(({ role }) => role),
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
  const adapter = registeredProductionAdapters().find(({ sourceLineage }) => sourceLineage === "one-piece-en");
  const capped = rawSurfacePayload("one-piece-en", "card-list");
  capped.page_info.cap_signal = "Too many search results";
  assert.throws(
    () => parseRegisteredSurface(adapter, "card-list", capped),
    /result-cap evidence does not prove complete coverage/u,
  );

  const unfinished = rawSurfacePayload("one-piece-en", "card-list");
  unfinished.page_info.partitions[0].pages = 2;
  unfinished.page_info.partitions[0].has_next = true;
  assert.throws(
    () => parseRegisteredSurface(adapter, "card-list", unfinished),
    /pagination evidence does not prove complete partitions/u,
  );

  const wrongPartition = rawSurfacePayload("one-piece-en", "card-list");
  wrongPartition.page_info.partitions[0].bucket = "unplanned-series";
  assert.throws(
    () => parseRegisteredSurface(adapter, "card-list", wrongPartition),
    /discovered vocabulary.*exact leaf partitions/iu,
  );

  const mismatched = rawSurfacePayload("one-piece-en", "card-list");
  mismatched.page = "product-list";
  assert.throws(() => parseRegisteredSurface(adapter, "card-list", mismatched), /card-list page identity/u);
});

test("the live product listing still fails closed when a status section disappears", () => {
  const adapter = fusionLiveShapeAdapter();
  const fixture = retainedOfficialSourceFixture("fusion-world-en-products-hub");
  const html = fixture.bytes.toString("utf8");
  const from = '<section class="contentsColInner comingsoonCol" id="comingsoon">';
  assert.ok(html.includes(from));
  assert.throws(
    () =>
      adapter.parseBytes(
        new TextEncoder().encode(html.replace(from, '<section class="contentsColInner retiredCol" id="retired">')),
        {
          mediaType: fixture.metadata.content_type,
          url: fixture.metadata.source_url,
          requestId: "fusion-world-en:products",
        },
      ),
    exactMessage("Fusion World Product status sections are incomplete; missing: comingsoon; unexpected: retired."),
  );
});

test("Errata Applied annotations remain fail-closed outside their proven shape", () => {
  const adapter = fusionLiveShapeAdapter();
  const mutatedDetail = (slug, url, from, to) => {
    const fixture = retainedOfficialSourceFixture(slug);
    const html = fixture.bytes.toString("utf8");
    assert.ok(html.includes(from), `${slug} must retain ${from}`);
    return () =>
      adapter.parseBytes(new TextEncoder().encode(html.replace(from, to)), {
        mediaType: fixture.metadata.content_type,
        url,
        requestId: `fusion-world-en:detail:${restructuredStageDigest}`,
      });
  };

  assert.throws(
    mutatedDetail(
      "fusion-world-en-card-detail-errata-skills",
      fusionErrataDetailFixtures[0].url,
      "<h6>Combo power</h6>",
      '<h6>Combo power<span class="is-front"> (Errata Applied)</span></h6>',
    ),
    exactMessage("Fusion World Card detail publishes an Errata Applied annotation on an unmodelled cell."),
    "an annotation on a numeric cell is an unmodelled page",
  );
  assert.throws(
    mutatedDetail(
      "fusion-world-en-card-detail-errata-skills",
      fusionErrataDetailFixtures[0].url,
      '<span class="is-front"> (Errata Applied)</span>',
      '<span class="is-back"> (Errata Applied)</span>',
    ),
    exactMessage("Fusion World Errata Applied annotation and its Errata Notice link do not match."),
    "a single-faced Card annotated on a face without a notice link fails closed",
  );
  assert.throws(
    mutatedDetail(
      "fusion-world-en-card-detail-errata-skills",
      fusionErrataDetailFixtures[0].url,
      '<div class="cardNotesBtnCol"><a class="cardNotesBtn" href=https://www.dbs-cardgame.com/fw/en/news/02_22.html target="_blank" rel="noopener noreferrer">Errata Notice</a></div>',
      "",
    ),
    exactMessage("Fusion World Errata Applied annotation and its Errata Notice link do not match."),
    "an annotation without its pinned Errata Notice link fails closed",
  );
});

test("restructured discovery stages and listing leaves fail closed on missing publisher structure", () => {
  const mutate = (slug, replace) => {
    const fixture = retainedOfficialSourceFixture(slug);
    const html = fixture.bytes.toString("utf8");
    const mutated = replace(html);
    assert.notEqual(mutated, html, `${slug} mutation changed nothing`);
    return {
      bytes: new TextEncoder().encode(mutated),
      mediaType: fixture.metadata.content_type,
    };
  };

  const onePiece = requiredSourceAdapter("one-piece-en@6");
  for (const [surface, pinned] of [["errata", "./errata_card/"]]) {
    const unpinned = mutate("one-piece-en-rules-hub", (html) => html.replaceAll(pinned, "/news/unrelated-notice.html"));
    assert.throws(
      () =>
        onePiece.parseBytes(unpinned.bytes, {
          mediaType: unpinned.mediaType,
          url: "https://en.onepiece-cardgame.com/rules/",
          requestId: `one-piece-en:listing:rules:${restructuredStageDigest}`,
        }),
      new RegExp(`Official Source rules discovery stage did not retain the ${surface} surface link\\.`, "u"),
    );
  }

  const gundam = requiredSourceAdapter("gundam-en-asia@7");
  const packagesUrl = gundam.requestUrlForSurface("packages");
  const withoutEmptyState = mutate("gundam-en-asia-restructured-card-search", (html) =>
    html.replace(/<section class="errorCol">[\s\S]*?<\/section>/u, ""),
  );
  assert.throws(
    () =>
      gundam.parseBytes(withoutEmptyState.bytes, {
        mediaType: withoutEmptyState.mediaType,
        url: packagesUrl,
        requestId: "gundam-en-asia:packages",
      }),
    /Official Source Gundam card search root did not retain its empty search state\./u,
  );
  const unrecognizedEmptyState = mutate("gundam-en-asia-restructured-card-search", (html) =>
    html.replace("Please specify your search criteria.", "Search results"),
  );
  assert.throws(
    () =>
      gundam.parseBytes(unrecognizedEmptyState.bytes, {
        mediaType: unrecognizedEmptyState.mediaType,
        url: packagesUrl,
        requestId: "gundam-en-asia:packages",
      }),
    /Official Source Gundam card search root empty state is unrecognized\./u,
  );
  const emptyLeaf = retainedOfficialSourceFixture("gundam-en-asia-restructured-card-search");
  assert.throws(
    () =>
      gundam.parseBytes(emptyLeaf.bytes, {
        mediaType: emptyLeaf.metadata.content_type,
        url: `${packagesUrl}?package=619000`,
        requestId: `gundam-en-asia:listing:${restructuredStageDigest}`,
      }),
    /Official Source Gundam package leaf did not render its card listing\./u,
  );

  const fusion = requiredSourceAdapter("fusion-world-en@9");
  const withoutCategories = mutate("fusion-world-en-restructured-card-search", (html) =>
    html.replaceAll("searchColSet-product", "searchColSet-retired"),
  );
  assert.throws(
    () =>
      fusion.parseBytes(withoutCategories.bytes, {
        mediaType: withoutCategories.mediaType,
        url: fusion.requestUrlForSurface("card-search"),
        requestId: "fusion-world-en:card-search",
      }),
    /Official Source Fusion World category discovery is unavailable\./u,
  );
});
