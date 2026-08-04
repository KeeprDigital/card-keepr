import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  officialSourceDiscoveryRequests,
} from "../src/catalogue/product-release-source-adapters.ts";
import {
  officialLegalityRulesObservation,
} from "../src/catalogue/official-legality-source-adapters.ts";
import {
  assertAdapterBinding,
  requiredSourceAdapter,
  sourceAdapterRegistrations,
} from "../src/catalogue/source-adapters.ts";
import syntheticOfficialSource, {
  officialBandaiNavigationHeader,
  officialDiscoveryDefinitions,
  officialDiscoveryDocument,
  officialPublisherPayloadScript,
  officialRawSurfacePayload,
} from "./fixtures/synthetic-official-source.mjs";
import {
  productionOfficialStageResponse,
} from "../apps/ingestion/test/production-source-fixture-routing.ts";

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

const expectedSurfaceUrls = {
  "one-piece-en": {
    "card-list": "https://en.onepiece-cardgame.com/cardlist/",
    products: "https://en.onepiece-cardgame.com/products/",
    releases: "https://en.onepiece-cardgame.com/products/",
    restrictions: "https://en.onepiece-cardgame.com/rules/restriction/",
    "block-policy": "https://en.onepiece-cardgame.com/rules/block_icon/",
    errata: "https://en.onepiece-cardgame.com/rules/errata_card/",
    "don-rules": "https://en.onepiece-cardgame.com/rules/",
  },
  "fusion-world-en": {
    "card-search": "https://www.dbs-cardgame.com/fw/en/cardlist/",
    products: "https://www.dbs-cardgame.com/fw/en/products/",
    releases: "https://www.dbs-cardgame.com/fw/en/products/",
    "legality-current":
      "https://www.dbs-cardgame.com/fw/en/rules/banned-limited-cards/",
    "legality-history":
      "https://www.dbs-cardgame.com/fw/en/rules/banned-limited-cards/",
    errata: "https://www.dbs-cardgame.com/fw/en/rules/errata-card/",
  },
  "digimon-en": {
    "card-list": "https://world.digimoncard.com/cards/index.php?search=true",
    products: "https://world.digimoncard.com/products/",
    releases: "https://world.digimoncard.com/products/",
    "restrictions-current":
      "https://world.digimoncard.com/rule/restriction_card/",
    "restrictions-history":
      "https://world.digimoncard.com/rule/restriction_card/",
    errata: "https://world.digimoncard.com/rule/errata_card/",
  },
  "gundam-en-asia": {
    packages: "https://www.gundam-gcg.com/asia-en/cards/index.php",
    products: "https://www.gundam-gcg.com/asia-en/products/list.php",
    releases: "https://www.gundam-gcg.com/asia-en/products/list.php",
    legality: "https://www.gundam-gcg.com/asia-en/rules/",
    errata: "https://www.gundam-gcg.com/asia-en/news/?subcategory=rules",
  },
  "gundam-en-us": {
    packages: "https://www.gundam-gcg.com/en/cards/index.php",
    products: "https://www.gundam-gcg.com/en/products/list.php",
    releases: "https://www.gundam-gcg.com/en/products/list.php",
    legality: "https://www.gundam-gcg.com/en/rules/",
    errata: "https://www.gundam-gcg.com/en/news/?subcategory=rules",
  },
};

const expectedDiscoveryLinks = {
  "one-piece-en": [
    ["FIND CARDS", "/cardlist/"],
    ["ALL PRODUCTS", "/products/"],
    ["RULES", "/rules/"],
  ],
  "fusion-world-en": [
    ["CARDS", "/fw/en/cardlist/"],
    ["ALL PRODUCTS", "/fw/en/products/"],
    ["RULES", "/fw/en/news/01_31.html"],
  ],
  "digimon-en": [
    ["CARD LIST", "/cardlist/"],
    ["PRODUCTS", "/products/"],
    ["RULES", "/rule/"],
  ],
  "gundam-en-asia": [
    ["FIND CARDS", "/asia-en/cards/"],
    ["PRODUCT LIST", "/asia-en/products/list.php"],
    ["RULES", "/asia-en/rules/"],
    ["NEWS", "/asia-en/news/"],
  ],
  "gundam-en-us": [
    ["FIND CARDS", "/en/cards/"],
    ["PRODUCT LIST", "/en/products/list.php"],
    ["RULES", "/en/rules/"],
    ["NEWS", "/en/news/"],
  ],
};

const expectedDiscoveryKeys = {
  "one-piece-en": ["cards", "products", "rules"],
  "fusion-world-en": ["cards", "products", "rules"],
  "digimon-en": ["cards", "products", "rules"],
  "gundam-en-asia": ["cards", "products", "rules", "news"],
  "gundam-en-us": ["cards", "products", "rules", "news"],
};

function discoveryHtml(sourceLineage, mutate = (entries) => entries) {
  const entries = expectedDiscoveryLinks[sourceLineage].map(
    ([label, url]) => ({ label, url }),
  );
  return `<!doctype html><html><head><title>Bandai Official Source</title>
    </head><body><header><nav>${mutate(structuredClone(entries)).map(
      ({ label, url }) => `<a href="${url}">${label}</a>`,
    ).join("")}</nav></header></body></html>`;
}

const productionAdapterVersions = sourceAdapterRegistrations
  .filter(({ origin, reconciliationCapability, parseBytes }) =>
    origin === "production" &&
    reconciliationCapability === "catalogue" &&
    typeof parseBytes === "function"
  )
  .map(({ adapterVersion }) => adapterVersion);

const expectedProductionAdapterVersions = [
  "digimon-en@4",
  "fusion-world-en@3",
  "gundam-en-asia@3",
  "gundam-en-us@3",
  "one-piece-en@2",
];

test("Digimon V4 alone accepts complete dynamic leaves and rejects catalogue facts above a leaf", () => {
  const current = requiredSourceAdapter("digimon-en@4");
  const retained = requiredSourceAdapter("digimon-en@3");
  const payload = officialRawSurfacePayload("/digimon-en/card-list");
  const document = (value) => Buffer.from(
    `<html>${officialPublisherPayloadScript("digimon-en", "card-list", value)}</html>`,
  );
  const requestId = `digimon-en:listing:${"a".repeat(64)}`;
  const exactLeaf =
    "https://world.digimoncard.com/cards/index.php?search=true&category=all&cardcategory=digimon&colour=blue";
  const intermediate =
    "https://world.digimoncard.com/cards/index.php?search=true&category=all";

  assert.throws(
    () => retained.parseBytes(document(payload), {
      mediaType: "text/html",
      url: exactLeaf,
      requestId,
    }),
    /listing|surface|publication|publisher|identity|contract/iu,
    "V3 must preserve its original dynamic-listing decoder behavior",
  );
  assert.ok(current.parseBytes(document(payload), {
    mediaType: "text/html",
    url: exactLeaf,
    requestId,
  }).length > 0);
  assert.throws(
    () => current.parseBytes(document(payload), {
      mediaType: "text/html",
      url: intermediate,
      requestId,
    }),
    /complete Digimon leaf/iu,
  );
  assert.throws(
    () => current.parseBytes(document(payload), {
      mediaType: "text/html",
      url: current.requestUrlForDiscovery(),
      requestId: "digimon-en:discovery",
    }),
    /complete Digimon leaf/iu,
  );
});

test("Digimon V4 normalizes exact standalone Official Errata", () => {
  const adapter = requiredSourceAdapter("digimon-en@4");
  const payload = officialRawSurfacePayload("/digimon-en/errata");
  payload.declared_record_count = 1;
  payload.partition.total = 1;
  payload.entries = [{
    card_number: "BT99-001",
    published_on: "2026-07-01",
    effective_from: "2026-07-01",
    observed_printed_rules_text: "Printed effect before correction.",
    corrected_rules_text: "Corrected official effect.",
    official_wording:
      'Replace "Printed effect before correction." with "Corrected official effect."',
    applies_to_parallel_printings: true,
    source_fragment: "#BT99-001",
    display_name: "BT99-001 Erratum",
    image_url: "https://world.digimoncard.com/images/cardlist/card/BT99-001.png",
  }];
  const observations = adapter.parseBytes(
    Buffer.from(`<html>${officialPublisherPayloadScript("digimon-en", "errata", payload)}</html>`),
    {
      mediaType: "text/html",
      url: adapter.requestUrlForSurface("errata"),
      requestId: "digimon-en:errata",
    },
  );
  assert.deepEqual(
    observations.filter(({ kind }) => kind === "official_erratum"),
    [{
      kind: "official_erratum",
      game: "digimon",
      target: {
        type: "card",
        official_identity: { kind: "card_number", value: "BT99-001" },
      },
      published_on: "2026-07-01",
      effective_from: "2026-07-01",
      observed_printed_rules_text: "Printed effect before correction.",
      corrected_rules_text: "Corrected official effect.",
      official_wording:
        'Replace "Printed effect before correction." with "Corrected official effect."',
      applies_to_parallel_printings: true,
      source: {
        fragment: "#BT99-001",
        display_name: "BT99-001 Erratum",
        image_url: "https://world.digimoncard.com/images/cardlist/card/BT99-001.png",
      },
      completeness: {
        structurally_complete: true,
        required_surfaces_complete: true,
        partitions_complete: true,
        declared_record_count: 1,
        parsed_record_count: 1,
      },
    }],
  );
});

function registeredProductionAdapters() {
  return productionAdapterVersions.map((adapterVersion) =>
    requiredSourceAdapter(adapterVersion)
  );
}

function retainedOfficialSourceFixture(slug) {
  const metadata = JSON.parse(readFileSync(
    new URL(
      `./fixtures/retained-official-source/${slug}.json`,
      import.meta.url,
    ),
    "utf8",
  ));
  const bytes = Buffer.from(metadata.body_base64, "base64");
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    metadata.body_sha256,
    `${slug} retained bytes changed`,
  );
  assert.equal(
    bytes.length,
    metadata.range_end_exclusive - metadata.range_start,
    `${slug} retained byte range changed`,
  );
  assert.match(metadata.full_body_sha256, /^[0-9a-f]{64}$/u);
  assert.match(metadata.retrieved_at, /^2026-08-0[23]T/u);
  return { bytes, metadata };
}

const retainedDiscoveryFixtures = {
  "one-piece-en": "one-piece-en-discovery",
  "fusion-world-en": "fusion-world-en-discovery",
  "digimon-en": "digimon-en-discovery",
  "gundam-en-asia": "gundam-en-asia-discovery",
  "gundam-en-us": "gundam-en-us-discovery",
};

function retainedLegalityRules(adapter, surface, slug, context = {}) {
  const fixture = retainedOfficialSourceFixture(slug);
  const observations = adapter.parseBytes(fixture.bytes, {
    mediaType: fixture.metadata.content_type,
    url: fixture.metadata.source_url,
    requestId: context.requestId ?? `${adapter.sourceLineage}:${surface}`,
  });
  return observations.find(
    (observation) => observation.observation_type === "legality_rules",
  )?.legality_rules;
}

test("retained live One Piece policy bytes publish the complete current active list", () => {
  const adapter = requiredSourceAdapter("one-piece-en@2");
  const rules = retainedLegalityRules(
    adapter,
    "restrictions",
    "one-piece-en-policy",
  );
  assert.deepEqual(
    rules.map((rule) => ({
      cards: rule.card_numbers,
      effect: rule.effect,
      effective_from: rule.effective_from,
    })),
    [
      { cards: ["OP06-047"], effect: { type: "ban" }, effective_from: "2026-04-10" },
      { cards: ["OP03-040"], effect: { type: "ban" }, effective_from: "2026-04-10" },
      { cards: ["OP06-086"], effect: { type: "ban" }, effective_from: "2026-04-10" },
      { cards: ["ST10-001"], effect: { type: "ban" }, effective_from: "2026-04-10" },
      { cards: ["OP06-116"], effect: { type: "ban" }, effective_from: "2026-04-10" },
      {
        cards: ["OP07-115"],
        effect: { type: "prohibited_combination", with_card_numbers: ["EB04-058"] },
        effective_from: "2026-04-10",
      },
      {
        cards: ["OP11-040"],
        effect: { type: "prohibited_combination", with_card_numbers: ["OP11-067"] },
        effective_from: "2026-04-10",
      },
      {
        cards: ["OP11-040"],
        effect: { type: "prohibited_combination", with_card_numbers: ["OP08-069"] },
        effective_from: "2026-04-10",
      },
    ],
  );
});

test("retained live Fusion World policy bytes retain every target without inventing a day", () => {
  const adapter = requiredSourceAdapter("fusion-world-en@3");
  const rules = retainedLegalityRules(
    adapter,
    "detail",
    "fusion-world-en-policy-detail",
    { requestId: `fusion-world-en:detail:${"a".repeat(64)}` },
  );
  assert.deepEqual(
    rules.map((rule) => rule.card_numbers[0]),
    [
      "FB01-056", "FB01-005", "FB02-031", "FB04-085",
      "FB04-094", "FB04-095", "SB01-011", "SB01-015",
    ],
  );
  assert.ok(rules.every((rule) =>
    rule.effective_from === null &&
    rule.unresolved_scope.dimensions.join(",") === "effective_interval" &&
    rule.effect.type === "unresolved" &&
    rule.effect.reason ===
      `Effective interval for ${rule.card_numbers[0]} is not stated.`
  ));
});

test("retained live Digimon policy bytes retain the complete current affected list", () => {
  const adapter = requiredSourceAdapter("digimon-en@3");
  const rules = retainedLegalityRules(
    adapter,
    "restrictions-current",
    "digimon-en-policy",
  );
  assert.equal(rules.length, 55);
  assert.deepEqual(rules.slice(0, 2).map((rule) => rule.card_numbers), [
    ["EX2-007", "EX7-064"],
    ["BT20-037", "BT17-035", "EX8-037"],
  ]);
  assert.deepEqual(
    rules.slice(2, 5).map((rule) => rule.card_numbers[0]),
    ["BT5-109", "BT2-090", "EX5-065"],
  );
  assert.deepEqual(
    rules.slice(-3).map((rule) => rule.card_numbers[0]),
    ["BT6-100", "EX1-068", "BT7-072"],
  );
  assert.ok(rules.every((rule) =>
    rule.effective_from === null &&
    rule.unresolved_scope.dimensions.join(",") === "effective_interval" &&
    rule.effect.type === "unresolved"
  ));
});

test("retained live Gundam locale policy bytes fail closed on their compound effect", () => {
  for (const descriptor of [
    { adapter: "gundam-en-asia@3", slug: "gundam-en-asia-policy-detail", region: "EN-ASIA" },
    { adapter: "gundam-en-us@3", slug: "gundam-en-us-policy-detail", region: "EN-US" },
  ]) {
    const adapter = requiredSourceAdapter(descriptor.adapter);
    const fixture = retainedOfficialSourceFixture(descriptor.slug);
    assert.throws(
      () => adapter.parseBytes(fixture.bytes, {
        mediaType: fixture.metadata.content_type,
        url: fixture.metadata.source_url,
        requestId: `${adapter.sourceLineage}:detail:${"b".repeat(64)}`,
      }),
      /compound.*combination.*copy.limit.*not exactly representable/iu,
      descriptor.adapter,
    );
  }
});

test("retained live policy roots schedule the exact current detail publications", () => {
  const fusion = requiredSourceAdapter("fusion-world-en@3");
  const fusionRoot = retainedOfficialSourceFixture("fusion-world-en-policy-live");
  const fusionEvidence = fusion.parseBytes(fusionRoot.bytes, {
    mediaType: fusionRoot.metadata.content_type,
    url: fusionRoot.metadata.source_url,
    requestId: `fusion-world-en:listing:rules:${"c".repeat(64)}`,
  });
  assert.equal(
    fusionEvidence[0].records.find(
      (record) => record.surface === "legality-current",
    )?.url,
    "https://www.dbs-cardgame.com/fw/en/news/01_305.html",
  );

  for (const descriptor of [
    { adapter: "gundam-en-asia@3", slug: "gundam-en-asia-policy", locale: "asia-en" },
    { adapter: "gundam-en-us@3", slug: "gundam-en-us-policy", locale: "en" },
  ]) {
    const adapter = requiredSourceAdapter(descriptor.adapter);
    const fixture = retainedOfficialSourceFixture(descriptor.slug);
    const requests = adapter.discoverRequests(fixture.bytes, {
      mediaType: fixture.metadata.content_type,
      url: fixture.metadata.source_url,
      requestId: `${adapter.sourceLineage}:legality`,
    });
    assert.deepEqual(
      requests.filter((request) => request.role !== "image"),
      [{
        role: "detail",
        url: `https://www.gundam-gcg.com/${descriptor.locale}/news/01_279.html`,
        headers: {
          accept: "text/html",
          "user-agent":
            "card-keepr-official-source/1; request-role=detail",
        },
      }],
    );
    assert.deepEqual(
      requests.filter((request) =>
        request.url ===
          `https://www.gundam-gcg.com/${descriptor.locale}/news/01_279.html`
      ),
      [{
        role: "detail",
        url: `https://www.gundam-gcg.com/${descriptor.locale}/news/01_279.html`,
        headers: {
          accept: "text/html",
          "user-agent":
            "card-keepr-official-source/1; request-role=detail",
        },
      }],
    );
  }
});

test("retained Fusion and exact Digimon Rules stages close current and history identities", () => {
  const fusion = requiredSourceAdapter("fusion-world-en@3");
  const fusionFixture = retainedOfficialSourceFixture(
    "fusion-world-en-policy-live",
  );
  const fusionRecords = fusion.parseBytes(fusionFixture.bytes, {
    mediaType: fusionFixture.metadata.content_type,
    url: fusionFixture.metadata.source_url,
    requestId: `fusion-world-en:listing:rules:${"a".repeat(64)}`,
  })[0].records;
  assert.deepEqual(
    fusionRecords.filter(({ surface }) =>
      surface === "legality-current" || surface === "legality-history"
    ).map(({ surface, url }) => ({ surface, url })),
    [
      {
        surface: "legality-current",
        url: "https://www.dbs-cardgame.com/fw/en/news/01_305.html",
      },
      {
        surface: "legality-history",
        url: "https://www.dbs-cardgame.com/fw/en/news/01_399.html",
      },
    ],
  );

  const digimon = requiredSourceAdapter("digimon-en@3");
  const digimonRules = Buffer.from(`
    <html><title>DIGIMON CARD GAME RULES</title><main>
      <a href="/rule/restriction_card/">Banned and Restricted Cards</a>
      <a href="/rule/errata_card/">Errata Cards</a>
    </main></html>
  `);
  const digimonRecords = digimon.parseBytes(digimonRules, {
    mediaType: "text/html; charset=utf-8",
    url: "https://world.digimoncard.com/rule/",
    requestId: `digimon-en:listing:rules:${"b".repeat(64)}`,
  })[0].records;
  assert.deepEqual(
    digimonRecords.filter(({ surface }) =>
      surface === "restrictions-current" ||
      surface === "restrictions-history"
    ).map(({ surface, url }) => ({ surface, url })),
    [
      {
        surface: "restrictions-current",
        url: "https://world.digimoncard.com/rule/restriction_card/",
      },
      {
        surface: "restrictions-history",
        url: "https://world.digimoncard.com/rule/restriction_card/",
      },
    ],
  );
});

test("retained historical Fusion policy 404 cannot establish a successful surface", () => {
  const adapter = requiredSourceAdapter("fusion-world-en@3");
  const fixture = retainedOfficialSourceFixture(
    "fusion-world-en-policy-historical-404",
  );
  assert.equal(fixture.metadata.http_status, 404);
  assert.throws(
    () => adapter.parseBytes(fixture.bytes, {
      mediaType: fixture.metadata.content_type,
      url: fixture.metadata.source_url,
      requestId: "fusion-world-en:legality-history",
    }),
    /unavailable|unparsed|exact|coverage|publication|publisher|surface|identity|contract/iu,
  );
});

test("retained live policy parsers reject tag-agnostic residual conditions", () => {
  const cases = [
    {
      adapter: "one-piece-en@2",
      slug: "one-piece-en-policy",
      surface: "restrictions",
      requestId: "one-piece-en:restrictions",
      wording: "The following card(s) cannot be included in any deck.",
    },
    {
      adapter: "fusion-world-en@3",
      slug: "fusion-world-en-policy-detail",
      surface: "detail",
      requestId: `fusion-world-en:detail:${"d".repeat(64)}`,
      wording: "No copies of the card are permitted in the deck.",
    },
    {
      adapter: "digimon-en@3",
      slug: "digimon-en-policy",
      surface: "restrictions-current",
      requestId: "digimon-en:restrictions-current",
      wording: "Restricted Cards (1) - Decks can only include one copy of these cards.",
    },
    {
      adapter: "gundam-en-us@3",
      slug: "gundam-en-us-policy-detail",
      surface: "detail",
      requestId: `gundam-en-us:detail:${"e".repeat(64)}`,
      wording: "No copies of the card are permitted in the deck.",
    },
  ];
  for (const descriptor of cases) {
    const adapter = requiredSourceAdapter(descriptor.adapter);
    const fixture = retainedOfficialSourceFixture(descriptor.slug);
    const mutated = Buffer.from(
      fixture.bytes.toString("utf8").replaceAll(
        descriptor.wording,
        `${descriptor.wording} Unless the publisher grants an exception.`,
      ),
    );
    assert.throws(
      () => adapter.parseBytes(mutated, {
        mediaType: fixture.metadata.content_type,
        url: fixture.metadata.source_url,
        requestId: descriptor.requestId,
      }),
      /exact|incomplete|unavailable|unparsed|semantics|structure/iu,
      descriptor.adapter,
    );
  }
});

test("retained live policy parsers reject separate unconsumed conditions", () => {
  const cases = [
    {
      adapter: "one-piece-en@2",
      slug: "one-piece-en-policy",
      requestId: "one-piece-en:restrictions",
      anchor: "The following card(s) cannot be included in any deck.",
    },
    {
      adapter: "fusion-world-en@3",
      slug: "fusion-world-en-policy-detail",
      requestId: `fusion-world-en:detail:${"c".repeat(64)}`,
      anchor: "No copies of the card are permitted in the deck.",
    },
    {
      adapter: "digimon-en@3",
      slug: "digimon-en-policy",
      requestId: "digimon-en:restrictions-current",
      anchor:
        "Restricted Cards (1) - Decks can only include one copy of these cards.",
    },
    {
      adapter: "gundam-en-us@3",
      slug: "gundam-en-us-policy-detail",
      requestId: `gundam-en-us:detail:${"d".repeat(64)}`,
      anchor: "No copies of the card are permitted in the deck.",
    },
  ];
  for (const descriptor of cases) {
    const adapter = requiredSourceAdapter(descriptor.adapter);
    const fixture = retainedOfficialSourceFixture(descriptor.slug);
    const mutated = Buffer.from(
      fixture.bytes.toString("utf8").replaceAll(
        descriptor.anchor,
        `${descriptor.anchor}</p><p>Except when the publisher grants an exception.`,
      ),
    );
    assert.throws(
      () => adapter.parseBytes(mutated, {
        mediaType: fixture.metadata.content_type,
        url: fixture.metadata.source_url,
        requestId: descriptor.requestId,
      }),
      /condition|exact|incomplete|unparsed|semantics|structure/iu,
      descriptor.adapter,
    );
  }
});

test("retained Fusion policy rejects unconsumed event and expiry prose", () => {
  const adapter = requiredSourceAdapter("fusion-world-en@3");
  const fixture = retainedOfficialSourceFixture(
    "fusion-world-en-policy-detail",
  );
  for (const prose of [
    "This restriction applies at championship events.",
    "This restriction remains active through June 30, 2026.",
  ]) {
    const mutated = Buffer.from(
      fixture.bytes.toString("utf8").replace(
        "<h4>Restricted Cards</h4>",
        `<p>${prose}</p><h4>Restricted Cards</h4>`,
      ),
    );
    assert.throws(
      () => adapter.parseBytes(mutated, {
        mediaType: fixture.metadata.content_type,
        url: fixture.metadata.source_url,
        requestId: `fusion-world-en:detail:${"f".repeat(64)}`,
      }),
      /exact|residual|unconsumed|structure/iu,
      prose,
    );
  }
});

test("retained Fusion policy permits text-free publisher framing at article boundaries", () => {
  const adapter = requiredSourceAdapter("fusion-world-en@3");
  const fixture = retainedOfficialSourceFixture(
    "fusion-world-en-policy-detail",
  );
  const framed = Buffer.from(
    fixture.bytes.toString("utf8")
      .replace(
        '<article class="articleCol">',
        '<article class="articleCol"><div class="publisher-frame"></div>',
      )
      .replace(
        "</article>",
        '<div class="publisher-frame-end"></div></article>',
      ),
  );
  const observations = adapter.parseBytes(framed, {
    mediaType: fixture.metadata.content_type,
    url: fixture.metadata.source_url,
    requestId: `fusion-world-en:detail:${"e".repeat(64)}`,
  });
  assert.equal(
    observations.find(({ observation_type }) =>
      observation_type === "legality_rules"
    )?.legality_rules.length,
    8,
  );
});

test("retained One Piece and Digimon policies reject unconsumed event scope while allowing text-free framing", () => {
  const cases = [
    {
      adapter: "one-piece-en@2",
      slug: "one-piece-en-policy",
      requestId: "one-piece-en:restrictions",
      anchor: "<h4>Banned Cards</h4>",
    },
    {
      adapter: "digimon-en@3",
      slug: "digimon-en-policy",
      requestId: "digimon-en:restrictions-current",
      anchor:
        '<h4 class="subTit txtNormal">List of Currently Affected Cards</h4>',
    },
  ];
  for (const descriptor of cases) {
    const adapter = requiredSourceAdapter(descriptor.adapter);
    const fixture = retainedOfficialSourceFixture(descriptor.slug);
    const source = fixture.bytes.toString("utf8");
    const parse = (html) => adapter.parseBytes(Buffer.from(html), {
      mediaType: fixture.metadata.content_type,
      url: fixture.metadata.source_url,
      requestId: descriptor.requestId,
    });
    assert.throws(
      () => parse(source.replace(
        descriptor.anchor,
        `${descriptor.anchor}<p>These restrictions apply at Championship events.</p>`,
      )),
      /unconsumed|exact|semantics|structure/iu,
      descriptor.adapter,
    );
    assert.doesNotThrow(() => parse(source.replace(
      descriptor.anchor,
      `<div class="publisher-frame"></div>${descriptor.anchor}`,
    )));
  }
});

test("retained live discovery bytes derive every production surface family", () => {
  for (const adapter of registeredProductionAdapters()) {
    const request = officialSourceDiscoveryRequests(adapter.sourceLineage)[0];
    const fixture = retainedOfficialSourceFixture(
      retainedDiscoveryFixtures[adapter.sourceLineage],
    );
    assert.equal(fixture.metadata.http_status, 200);
    assert.equal(fixture.metadata.source_url, request.url);
    const records = adapter.parseBytes(fixture.bytes, {
      mediaType: fixture.metadata.content_type,
      url: request.url,
      requestId: request.id,
    }).flatMap((observation) => observation.records ?? []);
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
    assert.ok(staged.every(({ headers }) =>
      headers["user-agent"] ===
        "card-keepr-official-source/1; request-role=listing"
    ));
  }
});

test("the exact Fusion listing fixture dispatch closes its staged surfaces", async () => {
  const adapter = requiredSourceAdapter("fusion-world-en@3");
  const url = "https://www.dbs-cardgame.com/fw/en/news/01_31.html";
  const response = productionOfficialStageResponse(
    "fusion-world-en",
    new Request(url, {
      headers: {
        accept: "text/html",
        "user-agent":
          "card-keepr-representable-legality-v3; request-role=listing",
      },
    }),
    officialBandaiNavigationHeader("fusion-world-en"),
  );
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  const observations = adapter.parseBytes(
    new Uint8Array(await response.arrayBuffer()),
    {
      mediaType: response.headers.get("content-type"),
      url,
      requestId:
        "fusion-world-en:listing:rules:ef7d6c9e469758959c58e79b0c21594afc89769eaf8264187e80c71d14c12b76",
    },
  );
  assert.deepEqual(
    observations.flatMap(({ records }) => records ?? []).map(({ surface }) =>
      surface
    ),
    ["legality-current", "legality-history", "errata"],
  );
});

test("registered Fusion policy collection identities parse their retained current and history bytes", async () => {
  const adapter = requiredSourceAdapter("fusion-world-en@3");
  const listingUrl = "https://www.dbs-cardgame.com/fw/en/news/01_31.html";
  const listingResponse = productionOfficialStageResponse(
    "fusion-world-en",
    new Request(listingUrl, {
      headers: {
        accept: "text/html",
        "user-agent": "card-keepr-official-source/1; request-role=listing",
      },
    }),
    officialBandaiNavigationHeader("fusion-world-en"),
  );
  const planned = adapter.parseBytes(
    new Uint8Array(await listingResponse.arrayBuffer()),
    {
      mediaType: listingResponse.headers.get("content-type"),
      url: listingUrl,
      requestId: `fusion-world-en:listing:rules:${"e".repeat(64)}`,
    },
  )[0].records.filter(({ surface }) =>
    surface === "legality-current" || surface === "legality-history"
  );
  assert.deepEqual(
    planned.map(({ id, surface, url }) => ({ id, surface, url })),
    [
      {
        id: "fusion-world-en:legality-current",
        surface: "legality-current",
        url: adapter.requestUrlForSurface("legality-current"),
      },
      {
        id: "fusion-world-en:legality-history",
        surface: "legality-history",
        url: adapter.requestUrlForSurface("legality-history"),
      },
    ],
  );

  const current = retainedOfficialSourceFixture(
    "fusion-world-en-policy-detail",
  );
  const historyResponse = productionOfficialStageResponse(
    "fusion-world-en",
    new Request(planned[1].url, {
      headers: {
        accept: "text/html",
        "user-agent":
          "card-keepr-official-source/1; request-role=surface; request-surface=legality-history",
      },
    }),
    officialBandaiNavigationHeader("fusion-world-en"),
  );
  const history = {
    bytes: new Uint8Array(await historyResponse.arrayBuffer()),
    mediaType: historyResponse.headers.get("content-type"),
  };
  for (const [request, retained, expectedCount] of [
    [planned[0], { bytes: current.bytes, mediaType: current.metadata.content_type }, 8],
    [planned[1], history, 0],
  ]) {
    const observations = adapter.parseBytes(retained.bytes, {
      mediaType: retained.mediaType,
      url: request.url,
      requestId: request.id,
    });
    const legality = observations.find(
      ({ observation_type }) => observation_type === "legality_rules",
    );
    assert.equal(legality.legality_rules.length, expectedCount, request.surface);
    assert.deepEqual(legality.completeness, {
      structurally_complete: true,
      required_surfaces_complete: true,
      partitions_complete: true,
      declared_record_count: expectedCount,
      parsed_record_count: expectedCount,
    }, request.surface);
    assert.equal(
      legality.source_sidecar.raw.official_surfaces[0].surface,
      request.surface,
      request.surface,
    );
  }
});

test("One Piece parser-failure markers survive retained discovery, staged listing, and final surface transport", async () => {
  const adapter = requiredSourceAdapter("one-piece-en@2");
  const url = "https://en.onepiece-cardgame.com/cardlist/";
  for (const failure of ["cap", "pagination"]) {
    const marker = `card-keepr-acceptance-parser/${failure}`;
    const responseForRole = (role) => syntheticOfficialSource.fetch(
      new Request(url, {
        headers: {
          "user-agent": role === null
            ? marker
            : `${marker}; request-role=${role}`,
        },
      }),
    );
    const rootBytes = new Uint8Array(
      await (await responseForRole(null)).arrayBuffer(),
    );
    const listingResponse = await responseForRole("listing");
    const listingBytes = new Uint8Array(await listingResponse.arrayBuffer());
    assert.notDeepEqual(
      listingBytes,
      rootBytes,
      "the listing request must not be routed back to retained root bytes",
    );
    assert.deepEqual(
      adapter.parseBytes(listingBytes, {
        mediaType: listingResponse.headers.get("content-type"),
        url,
        requestId: `one-piece-en:listing:cards:${"a".repeat(64)}`,
      }).flatMap(({ records }) => records ?? []).map(({ surface }) => surface),
      ["card-list"],
    );
    const surfaceResponse = await responseForRole("surface");
    const surfaceBytes = new Uint8Array(await surfaceResponse.arrayBuffer());
    assert.throws(
      () => adapter.parseBytes(surfaceBytes, {
        mediaType: surfaceResponse.headers.get("content-type"),
        url,
        requestId: "one-piece-en:card-list",
      }),
      failure === "cap"
        ? /result-cap evidence does not prove complete coverage/iu
        : /pagination evidence does not prove complete partitions/iu,
    );
  }
});

test("Product and Release fixture bytes are invariant under retries and reordering", async () => {
  const url = "https://en.onepiece-cardgame.com/products/";
  const responseBytes = async (surface) => new Uint8Array(
    await (await syntheticOfficialSource.fetch(new Request(url, {
      headers: {
        "user-agent":
          `card-keepr-product-routing-golden; request-role=surface; request-surface=${surface}`,
      },
    }))).arrayBuffer(),
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

test("Digimon explicit surfaces deterministically disambiguate shared Product, Release, and policy URLs", async () => {
  const adapter = requiredSourceAdapter("digimon-en@3");
  const cases = [
    ["products", "https://world.digimoncard.com/products/"],
    ["releases", "https://world.digimoncard.com/products/"],
    [
      "restrictions-current",
      "https://world.digimoncard.com/rule/restriction_card/",
    ],
    [
      "restrictions-history",
      "https://world.digimoncard.com/rule/restriction_card/?view=history",
    ],
  ];
  const captured = new Map();
  for (const [surface, url] of [...cases, ...cases.toReversed()]) {
    const response = await syntheticOfficialSource.fetch(new Request(url, {
      headers: {
        "user-agent":
          `card-keepr-digimon-routing; request-role=surface; request-surface=${surface}`,
      },
    }));
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (captured.has(surface)) {
      assert.deepEqual(bytes, captured.get(surface), surface);
    } else {
      captured.set(surface, bytes);
    }
    assert.doesNotThrow(() => adapter.parseBytes(bytes, {
      mediaType: response.headers.get("content-type"),
      url,
      requestId: `digimon-en:${surface}`,
    }), surface);
  }
  assert.notDeepEqual(
    captured.get("products"),
    captured.get("releases"),
  );
  assert.notDeepEqual(
    captured.get("restrictions-current"),
    captured.get("restrictions-history"),
  );
});

test("Fusion staged policy discovery rejects keyword-matched sibling news pages", () => {
  const adapter = requiredSourceAdapter("fusion-world-en@3");
  for (const [label, href] of [
    ["Banned cards", "/fw/en/news/01_998.html"],
    ["Previous history", "/fw/en/news/01_999.html"],
  ]) {
    assert.throws(
      () => adapter.parseBytes(new TextEncoder().encode(`<html>
        <title>BANDAI DRAGON BALL CARD RULES</title>
        <a href="${href}">${label}</a>
      </html>`), {
        mediaType: "text/html",
        url: "https://www.dbs-cardgame.com/fw/en/news/01_31.html",
        requestId: `fusion-world-en:listing:rules:${"a".repeat(64)}`,
      }),
      /exact|sibling|policy|discovery/iu,
      label,
    );
  }
});

test("Fusion final policy parsing rejects a sibling news URL", () => {
  const adapter = requiredSourceAdapter("fusion-world-en@3");
  const payload = officialRawSurfacePayload(
    "/fusion-world-en/legality-current",
  );
  assert.throws(
    () => adapter.parseBytes(new TextEncoder().encode(`<html>
      <title>BANDAI DRAGON BALL CARD RULE RESTRICTION</title>
      ${officialPublisherPayloadScript(
        "fusion-world-en",
        "legality-current",
        payload,
      )}
    </html>`), {
      mediaType: "text/html",
      url: "https://www.dbs-cardgame.com/fw/en/news/01_999.html",
      requestId: "fusion-world-en:legality-current",
    }),
    /exact|identity|URL contract/iu,
  );
});

test("active Fusion policy identities reject retired rule URLs retained only by V2", () => {
  const current = requiredSourceAdapter("fusion-world-en@3");
  const historical = requiredSourceAdapter("fusion-world-en@2");
  const stale = {
    "legality-current":
      "https://www.dbs-cardgame.com/fw/en/rules/banned-limited-cards/",
    "legality-history":
      "https://www.dbs-cardgame.com/fw/en/rules/banned-limited-cards/?view=history",
  };
  assert.equal(
    current.requestUrlForSurface("legality-current"),
    "https://www.dbs-cardgame.com/fw/en/news/01_305.html",
  );
  assert.equal(
    current.requestUrlForSurface("legality-history"),
    "https://www.dbs-cardgame.com/fw/en/news/01_399.html",
  );
  for (const [surface, url] of Object.entries(stale)) {
    const payload = officialRawSurfacePayload(`/fusion-world-en/${surface}`);
    assert.throws(
      () => current.parseBytes(Buffer.from(`<html>
        <title>BANDAI DRAGON BALL CARD RULE RESTRICTION</title>
        ${officialPublisherPayloadScript("fusion-world-en", surface, payload)}
      </html>`), {
        mediaType: "text/html",
        url,
        requestId: `fusion-world-en:${surface}`,
      }),
      /exact|identity|URL contract/iu,
    );
  }
  assert.equal(
    historical.requestUrlForSurface("legality-current"),
    stale["legality-current"],
  );
  assert.equal(
    historical.requestUrlForSurface("legality-history"),
    stale["legality-current"],
  );
});

test("every production lineage owns an exact raw decoder and discovery plan", () => {
  const production = registeredProductionAdapters();
  assert.deepEqual(
    production.map(({ sourceLineage }) => sourceLineage).sort(),
    Object.keys(expectedSurfaces).sort(),
  );
  assert.deepEqual(
    production.map(({ adapterVersion }) => adapterVersion).sort(),
    expectedProductionAdapterVersions,
  );
  for (const adapter of production) {
    assert.doesNotThrow(() =>
      assertAdapterBinding(adapter, {
        sourceLineage: adapter.sourceLineage,
        supportedGame: adapter.supportedGame,
        gameProfileVersion: adapter.gameProfileVersion,
      })
    );
    assert.equal(adapter.origin, "production");
    assert.equal(adapter.reconciliationCapability, "catalogue");
    assert.equal(
      adapter.gameProfileVersion,
      `${adapter.supportedGame}@1`,
    );
    assert.match(
      adapter.parserContract,
      adapter.adapterVersion === "digimon-en@4"
        ? /-raw-surfaces-complete-catalogue@3$/u
        : /-raw-surfaces-with-legality@2$/u,
    );
    assert.equal(typeof adapter.parseBytes, "function");
    assert.deepEqual(
      adapter.requiredSurfaces,
      expectedSurfaces[adapter.sourceLineage],
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

    const retainedDiscovery = retainedOfficialSourceFixture(
      retainedDiscoveryFixtures[adapter.sourceLineage],
    );
    const retainedHtml = retainedDiscovery.bytes.toString("utf8");
    const discovery = adapter.parseBytes(
      retainedDiscovery.bytes,
      {
        mediaType: retainedDiscovery.metadata.content_type,
        url: requests[0].url,
        requestId: requests[0].id,
      },
    );
    const discoveryRecords = discovery.flatMap(
      (observation) => observation.records ?? [],
    );
    assert.ok(
      discoveryRecords.every(({ discovered_from }) =>
        retainedHtml.includes(
          discovered_from.resolution,
        )
      ),
      `${adapter.sourceLineage} discovery may only emit URLs literally retained in the source bytes`,
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
      assert.deepEqual(
        Object.keys(record.discovered_from).sort(),
        ["kind", "label", "resolution", "url"],
      );
      assert.equal(record.discovered_from.kind, "publisher_navigation");
      assert.ok(
        expectedDiscoveryLinks[adapter.sourceLineage].some(
          ([label, href]) =>
            label.toLowerCase() === record.discovered_from.label &&
            href === record.discovered_from.resolution &&
            record.discovered_from.url === requests[0].url,
        ),
      );
      assert.equal(
        new URL(
          record.discovered_from.resolution,
          record.discovered_from.url,
        ).href,
        record.url,
      );
    }
  }
});

test("production registrations and dynamic discovery enforce exact lineage URL authority", () => {
  for (const adapter of registeredProductionAdapters()) {
    assert.ok(adapter.officialSourceContract);
    const root = new URL(adapter.requestUrlForDiscovery());
    assert.equal(adapter.officialSourceContract.origin, root.origin);
    assert.ok(adapter.officialSourceContract.documentPathnamePrefixes.some(
      (prefix) => root.pathname.startsWith(prefix),
    ));

    const validDetailUrl = new URL(root);
    validDetailUrl.searchParams.set("detailSearch", "CK30");
    const validDetail = validDetailUrl.href;
    const hostileOrigin = new URL(validDetail);
    hostileOrigin.hostname = `assets.${root.hostname}`;
    const hostilePath = new URL(validDetail);
    hostilePath.pathname = adapter.sourceLineage === "gundam-en-asia"
      ? hostilePath.pathname.replace("/asia-en/", "/en/")
      : adapter.sourceLineage === "gundam-en-us"
        ? hostilePath.pathname.replace("/en/", "/asia-en/")
        : `/outside-lineage${hostilePath.pathname}`;
    const requests = adapter.discoverRequests(
      new TextEncoder().encode(`
        <a href="${validDetail}">Card detail</a>
        <a href="${hostileOrigin.href}">Wrong subdomain</a>
        <a href="${hostilePath.href}">Wrong locale path</a>
      `),
      {
        mediaType: "text/html; charset=utf-8",
        url: adapter.requestUrlForSurface(adapter.requiredSurfaces[0]),
        requestId: `${adapter.sourceLineage}:${adapter.requiredSurfaces[0]}`,
      },
    );
    assert.ok(requests.some(({ url }) => url === validDetail));
    assert.equal(requests.some(({ url }) => url === hostileOrigin.href), false);
    assert.equal(requests.some(({ url }) => url === hostilePath.href), false);
  }
});

test("notice-link-only legality publications fail closed at the raw Official Source boundary", () => {
  for (const adapter of registeredProductionAdapters()) {
    const surface = adapter.requiredSurfaces.find((candidate) =>
      /(?:legality|restriction|block-policy|don-rules)/u.test(candidate) ||
      (adapter.sourceLineage === "one-piece-en" && candidate === "releases")
    );
    assert.ok(surface);
    for (const declaredEmpty of [false, true]) {
      assert.throws(
        () => adapter.parseBytes(
          new TextEncoder().encode(`
            <html><title>BANDAI CARD PRODUCT RELEASE RULE RESTRICTION publication</title>
              ${declaredEmpty ? "<p>0 records</p>" : ""}
              <a href="./new-legality-notice.html">
                New tournament eligibility wording effective immediately
              </a>
            </html>
          `),
          {
            mediaType: "text/html; charset=utf-8",
            url: adapter.requestUrlForSurface(surface),
            requestId: `${adapter.sourceLineage}:${surface}`,
          },
        ),
        /non-empty Legality data without an exact, complete Legality Rule parser/iu,
      );
    }
  }
});

test("One Piece release publications fail closed on unmodelled conditional legality wording", () => {
  const adapter = requiredSourceAdapter("one-piece-en@2");
  for (const publication of [
    "<article>OP01-001 may not be included unless your Leader is OP01-999.</article>",
    `<article>Official product entry</article>
     <span>OP01-001 may not be included unless your Leader is OP01-999.</span>`,
  ]) {
    assert.throws(
      () => adapter.parseBytes(
        new TextEncoder().encode(`
          <html><title>BANDAI ONE PIECE CARD PRODUCT RELEASE publication</title>
            ${publication}
          </html>
        `),
        {
          mediaType: "text/html; charset=utf-8",
          url: adapter.requestUrlForSurface("releases"),
          requestId: "one-piece-en:releases",
        },
      ),
      /non-empty Legality data without an exact, complete Legality Rule parser/iu,
    );
  }
});

test("production discovery is proven by complete exact retained navigation", () => {
  for (const adapter of registeredProductionAdapters()) {
    const request = officialSourceDiscoveryRequests(adapter.sourceLineage)[0];
    const parse = (html) => adapter.parseBytes(new TextEncoder().encode(html), {
      mediaType: "text/html; charset=utf-8",
      url: request.url,
      requestId: request.id,
    });
    const mutations = {
      blank: () => "<!doctype html><html><body></body></html>",
      missing: () =>
        discoveryHtml(adapter.sourceLineage, (entries) => entries.slice(1)),
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
      duplicate: () =>
        discoveryHtml(adapter.sourceLineage, (entries) => [
          entries[0],
          entries[0],
          ...entries.slice(2),
        ]),
      "mismatched semantic link": () =>
        discoveryHtml(adapter.sourceLineage, (entries) => {
          entries[0].label = entries[1].label;
          return entries;
        }),
      "undemonstrated anchor attributes": () =>
        discoveryHtml(adapter.sourceLineage).replace(
          "<a href=",
          '<a class="unexpected" href=',
        ),
      "undemonstrated anchor nesting": () =>
        discoveryHtml(adapter.sourceLineage)
          .replace("<a href=", "<div><a href=")
          .replace("</a>", "</a></div>"),
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

test("historical production adapter identities remain exact lookup-only contracts", () => {
  const historical = [
    ["one-piece-en@1", "one-piece-en"],
    ["fusion-world-en@2", "fusion-world-en"],
    ["digimon-en@2", "digimon-en"],
    ["gundam-en-asia@2", "gundam-en-asia"],
    ["gundam-en-us@2", "gundam-en-us"],
  ];
  for (const [adapterVersion, sourceLineage] of historical) {
    const adapter = requiredSourceAdapter(adapterVersion);
    assert.equal(adapter.sourceLineage, sourceLineage);
    assert.match(adapter.parserContract, /-raw-surfaces@1$/u);
    assert.equal(typeof adapter.parseBytes, "function");
    assert.ok(!productionAdapterVersions.includes(adapterVersion));
  }
});

test("Digimon V3 remains installed with its immutable parser digest for retained reparses", () => {
  const adapter = requiredSourceAdapter("digimon-en@3");
  assert.equal(adapter.parserContract, "digimon-en-raw-surfaces-with-legality@2");
  assert.ok(!productionAdapterVersions.includes(adapter.adapterVersion));
  const surface = "products";
  const observations = adapter.parseBytes(
    Buffer.from(
      `<html>${officialPublisherPayloadScript(
        "digimon-en",
        surface,
        officialRawSurfacePayload(`/digimon-en/${surface}`),
      )}</html>`,
    ),
    {
      mediaType: "text/html",
      url: adapter.requestUrlForSurface(surface),
      requestId: `digimon-en:${surface}`,
    },
  );
  assert.equal(
    createHash("sha256").update(JSON.stringify(observations)).digest("hex"),
    "a57968449b6be5a130d46424893680d38b1066eaa326d9ed82a51b422aefbee2",
  );
});

test("historical production identities preserve their original JSON-LD observation bytes", () => {
  const golden = [
    ["one-piece-en@1", "one-piece-en", "b19ee89d92a3d519f3e4fb740720a063f716c0805f2a3a5b65197bd3d23b0299"],
    ["fusion-world-en@2", "fusion-world-en", "9c93da95648fe1b1c6a1e2428224224144a950d27559c14681d48112c39ecf8e"],
    ["digimon-en@2", "digimon-en", "a57968449b6be5a130d46424893680d38b1066eaa326d9ed82a51b422aefbee2"],
    ["gundam-en-asia@2", "gundam-en-asia", "441a8045e5e19c26927a9071c1e767577136f7a1713f682106bc0b8a7252afaf"],
    ["gundam-en-us@2", "gundam-en-us", "e2e7bdd65f96886ca4d3573252f6bc51cc8c380e130bcf6e0cb533984703a2ee"],
  ];
  for (const [adapterVersion, sourceLineage, digest] of golden) {
    const adapter = requiredSourceAdapter(adapterVersion);
    const surface = "products";
    const publication = {
      "@context": "https://schema.org",
      "@type": "Dataset",
      publisher: { "@type": "Organization", name: "Bandai" },
      hasPart: [{
        "@type": "Dataset",
        identifier: `${sourceLineage}:${surface}`,
        payload: officialRawSurfacePayload(`/${sourceLineage}/${surface}`),
      }],
    };
    const bytes = Buffer.from(
      `<html><script type="application/ld+json">${
        JSON.stringify(publication)
      }</script></html>`,
    );
    const observations = adapter.parseBytes(bytes, {
      mediaType: "text/html",
      url: adapter.requestUrlForSurface(surface),
      requestId: `${sourceLineage}:${surface}`,
    });
    assert.equal(
      createHash("sha256").update(JSON.stringify(observations)).digest("hex"),
      digest,
      adapterVersion,
    );
  }
});

test("historical V1 coverage retains its original Showing-count grammar", () => {
  const adapter = requiredSourceAdapter("one-piece-en@1");
  const observations = adapter.parseBytes(Buffer.from(`
    <html><title>BANDAI ONE PIECE RULE RESTRICTION</title>
      <p>Showing 2 results</p><li>one</li>
    </html>
  `), {
    mediaType: "text/html",
    url: adapter.requestUrlForSurface("restrictions"),
    requestId: "one-piece-en:restrictions",
  });
  assert.deepEqual(observations[0].completeness, {
    structurally_complete: true,
    required_surfaces_complete: true,
    partitions_complete: true,
    declared_record_count: 2,
    parsed_record_count: 1,
  });
});

test("historical V1 discovery stays frozen while decoder authority diverges from current adapters", () => {
  const historical = requiredSourceAdapter("one-piece-en@1");
  const current = requiredSourceAdapter("one-piece-en@2");
  const listing = Buffer.from(`
    <html><body>
      <a href="/cardlist/?detailSearch=OP99-001">Legacy Leader</a>
    </body></html>
  `);
  const historicalDetail = historical.discoverRequests(listing, {
    mediaType: "text/html",
    url: historical.requestUrlForSurface("card-list"),
    requestId: "one-piece-en:card-list",
  }).find(({ role }) => role === "detail");
  const currentDetail = current.discoverRequests(listing, {
    mediaType: "text/html",
    url: current.requestUrlForSurface("card-list"),
    requestId: "one-piece-en:card-list",
  }).find(({ role }) => role === "detail");

  const frozenDetailHeaders = {
    accept: "text/html",
    "user-agent": "card-keepr-official-source/1; request-role=detail",
  };
  assert.deepEqual(historicalDetail?.headers, frozenDetailHeaders);
  assert.deepEqual(currentDetail?.headers, frozenDetailHeaders);

  const legacyDetail = Buffer.from(`
    <h1>Legacy Leader</h1>
    <dl><dt>Card Number</dt><dd>OP99-001</dd></dl>
    <dl><dt>Card Type</dt><dd>Leader</dd></dl>
    <dl><dt>Color</dt><dd>Red</dd></dl>
    <img class="card-image" src="/legacy-media/OP99-001.png">
  `);
  const context = {
    mediaType: "text/html",
    url: "https://en.onepiece-cardgame.com/cardlist/?detailSearch=OP99-001",
    requestId: `one-piece-en:detail:${"3".repeat(64)}`,
  };
  assert.equal(historical.parseBytes(legacyDetail, context).length, 1);
  assert.throws(
    () => current.parseBytes(legacyDetail, context),
    /Printing Image URL/u,
  );
});

test("historical Fusion V1 accepts only its frozen policy URL identities", () => {
  const historical = requiredSourceAdapter("fusion-world-en@2");
  const retainedEmptyPolicy = new TextEncoder().encode(`
    <html><title>BANDAI DRAGON BALL CARD RULE RESTRICTION</title>
      <main><p>0 records</p>
        <article data-publication-empty="true">No published entries.</article>
      </main>
    </html>
  `);
  const frozenUrl =
    "https://www.dbs-cardgame.com/fw/en/rules/banned-limited-cards/";
  for (const [surface, url] of [
    [
      "legality-current",
      "https://www.dbs-cardgame.com/fw/en/news/01_305.html",
    ],
    [
      "legality-history",
      "https://www.dbs-cardgame.com/fw/en/news/01_399.html",
    ],
  ]) {
    const observations = historical.parseBytes(retainedEmptyPolicy, {
      mediaType: "text/html; charset=utf-8",
      url: frozenUrl,
      requestId: `fusion-world-en:${surface}`,
    });
    assert.equal(observations.length, 1, surface);
    assert.throws(
      () => historical.parseBytes(retainedEmptyPolicy, {
        mediaType: "text/html; charset=utf-8",
        url,
        requestId: `fusion-world-en:${surface}`,
      }),
      /identity.*URL contract/iu,
      surface,
    );
  }
});

test("historical production identities freeze every original decoder path", () => {
  const digest = (observations) =>
    createHash("sha256").update(JSON.stringify(observations)).digest("hex");
  const legacyPublication = (lineage, surface, payload) => Buffer.from(
    `<html><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Dataset",
      publisher: { "@type": "Organization", name: "Bandai" },
      hasPart: [{
        "@type": "Dataset",
        identifier: `${lineage}:${surface}`,
        payload,
      }],
    })}</script></html>`,
  );
  const actual = {};

  const fusion = requiredSourceAdapter("fusion-world-en@2");
  const legacyPolicy = structuredClone(
    officialRawSurfacePayload("/fusion-world-en/legality-current"),
  );
  delete legacyPolicy.declared_record_count;
  delete legacyPolicy.partition;
  actual.policy = digest(fusion.parseBytes(
    legacyPublication("fusion-world-en", "legality-current", legacyPolicy),
    {
      mediaType: "text/html",
      url: fusion.requestUrlForSurface("legality-current"),
      requestId: "fusion-world-en:legality-current",
    },
  ));

  const onePiece = requiredSourceAdapter("one-piece-en@1");
  const legacyReleases = structuredClone(
    officialRawSurfacePayload("/one-piece-en/releases"),
  );
  delete legacyReleases.release_timing_entries;
  actual.releases = digest(onePiece.parseBytes(
    legacyPublication("one-piece-en", "releases", legacyReleases),
    {
      mediaType: "text/html",
      url: onePiece.requestUrlForSurface("releases"),
      requestId: "one-piece-en:releases",
    },
  ));

  actual.cardDetail = digest(onePiece.parseBytes(Buffer.from(`
    <h1>Legacy Leader</h1>
    <dl><dt>Card Number</dt><dd>OP99-001</dd></dl>
    <dl><dt>Card Type</dt><dd>Leader</dd></dl>
    <dl><dt>Color</dt><dd>Red</dd></dl>
    <dl><dt>Life</dt><dd>5</dd></dl>
    <dl><dt>Power</dt><dd>5000</dd></dl>
    <img class="card-image" src="/legacy-media/OP99-001.png">
  `), {
    mediaType: "text/html",
    url: "https://en.onepiece-cardgame.com/legacy/card/OP99-001",
    requestId: `one-piece-en:detail:${"1".repeat(64)}`,
  }));

  const gundam = requiredSourceAdapter("gundam-en-us@2");
  actual.productDetail = digest(gundam.parseBytes(Buffer.from(`
    <h1>Legacy Booster</h1>
    <dl><dt>Product Code</dt><dd>GD-LEGACY</dd></dl>
    <dl><dt>Release Date</dt><dd>August 3, 2026</dd></dl>
    <dl><dt>Status</dt><dd>Available</dd></dl>
  `), {
    mediaType: "text/html",
    url: "https://www.gundam-gcg.com/en/legacy/product/",
    requestId: `gundam-en-us:product_detail:${"2".repeat(64)}`,
  }));

  actual.coverage = digest(fusion.parseBytes(Buffer.from(`
    <html><title>BANDAI Fusion World ERRATA publication</title>
      <main><p>1 result</p><ul><li>Official errata correction entry</li></ul></main>
    </html>
  `), {
    mediaType: "text/html",
    url: fusion.requestUrlForSurface("errata"),
    requestId: "fusion-world-en:errata",
  }));

  actual.onePieceList = digest(onePiece.parseBytes(Buffer.from(`
    <select id="recording"><option value="1">Legacy Set</option></select>
    <div class="countCol">1 result</div>
    <dl class="modalCol" id="OP99-002" data-artwork-id="legacy-art">
      <dt><div class="infoCol"><span>OP99-002</span> | <span>L</span> | <span>LEADER</span></div>
        <div class="cardName">Legacy Modal Leader</div></dt>
      <dd><div class="frontCol"><img data-src="../images/cardlist/card/OP99-002.png"></div>
        <div class="backCol"><div class="cost"><h3>Life</h3>5</div>
        <div class="attribute"><h3>Attribute</h3>Strike</div>
        <div class="power"><h3>Power</h3>5000</div>
        <div class="counter"><h3>Counter</h3>-</div>
        <div class="color"><h3>Color</h3>Red</div>
        <div class="block"><h3>Block icon</h3>1</div>
        <div class="feature"><h3>Type</h3>Legacy</div>
        <div class="text"><h3>Effect</h3>Legacy effect</div>
        <div class="getInfo"><h3>Card Set(s)</h3>Legacy Set</div></div></dd>
    </dl>
  `), {
    mediaType: "text/html",
    url: onePiece.requestUrlForSurface("card-list"),
    requestId: "one-piece-en:card-list",
  }));

  assert.deepEqual(actual, {
    policy: "c37d7541af19d570b0b5b51750ca23d3ce297cb2857e67a7fbd62bdc62c4d529",
    releases: "6a10d3ad46f520462e6fc35f78bf8c128c6248503ecce38df7ab7ceab4dd2a16",
    cardDetail: "c26cb476250e5a7265d866531db155f16ac17ffcb54400b73abd13b7fea10163",
    productDetail: "7159d4d9472dc669a1f6eb68e016da9759f446308e5049544c544cc64092999e",
    coverage: "03f630a79aef27c067d8e0db573d57022a42d2f035abc935e2503a5efe83f55e",
    onePieceList: "7f69bd4a4042c8957321595614fac21b8a96b69761205bb34da245011e501184",
  });
});

function fusionLegalityContext(adapter) {
  return {
    mediaType: "text/html; charset=utf-8",
    url: adapter.requestUrlForSurface("legality-current"),
    requestId: "fusion-world-en:legality-current",
  };
}

const exactFusionLegalityHtml = `
  <!doctype html><html><head><title>Bandai Dragon Ball Super Card Game Fusion World Restriction Rules</title></head>
  <body><h1>Restriction Rules</h1><p>2 records</p>
    <article class="restriction-card"><dl>
      <dt>Rule Ref</dt><dd>FW-2026-001</dd>
      <dt>Notice</dt><dd>FB01-001 is banned from standard tournament decks.</dd>
      <dt>Market</dt><dd>EN-OCEANIA</dd>
      <dt>Play Format</dt><dd>standard</dd>
      <dt>Tier</dt><dd>championship</dd>
      <dt>Active On</dt><dd>2026-07-01</dd>
      <dt>Expires On</dt><dd>-</dd>
      <dt>Cards</dt><dd>FB01-001</dd>
      <dt>Directive</dt><dd>ban</dd>
    </dl></article>
    <article class="restriction-card"><dl>
      <dt>Rule Ref</dt><dd>FW-2026-002</dd>
      <dt>Notice</dt><dd>FB01-002 is limited to 1 copy in standard decks.</dd>
      <dt>Market</dt><dd>EN-OCEANIA</dd>
      <dt>Play Format</dt><dd>standard</dd>
      <dt>Tier</dt><dd>-</dd>
      <dt>Active On</dt><dd>2026-07-01</dd>
      <dt>Expires On</dt><dd>2026-12-01</dd>
      <dt>Cards</dt><dd>FB01-002</dd>
      <dt>Directive</dt><dd>copy_limit</dd>
      <dt>Cap</dt><dd>1</dd>
    </dl></article>
  </body></html>`;

function fusionLegalityRuleHtml({
  id,
  wording,
  cards,
  directive,
  effectFields = "",
}) {
  return `<article class="restriction-card"><dl>
    <dt>Rule Ref</dt><dd>${id}</dd>
    <dt>Notice</dt><dd>${wording}</dd>
    <dt>Market</dt><dd>EN-OCEANIA</dd>
    <dt>Play Format</dt><dd>standard</dd>
    <dt>Tier</dt><dd>-</dd>
    <dt>Active On</dt><dd>2026-07-01</dd>
    <dt>Expires On</dt><dd>-</dd>
    <dt>Cards</dt><dd>${cards.length === 0 ? "-" : cards.join(", ")}</dd>
    <dt>Directive</dt><dd>${directive}</dd>
    ${effectFields}
  </dl></article>`;
}

function fusionLegalityPage(...rules) {
  return `<!doctype html><html><head>
    <title>Bandai Dragon Ball Super Card Game Fusion World Restriction Rules</title>
    </head><body><h1>Restriction Rules</h1><p>${rules.length} records</p>
    ${rules.join("\n")}</body></html>`;
}

test("current production legality parser retains exact ordinary HTML rules and truthful multi-record completeness", () => {
  const current = requiredSourceAdapter("fusion-world-en@3");
  const observations = current.parseBytes(
    new TextEncoder().encode(exactFusionLegalityHtml),
    fusionLegalityContext(current),
  );
  const legality = observations.find(
    ({ observation_type }) => observation_type === "legality_rules",
  );
  assert.deepEqual(legality.completeness, {
    structurally_complete: true,
    required_surfaces_complete: true,
    partitions_complete: true,
    declared_record_count: 2,
    parsed_record_count: 2,
  });
  assert.equal(legality.legality_rules.length, 2);
  assert.equal(
    legality.legality_rules[0].official_wording,
    "FB01-001 is banned from standard tournament decks.",
  );
  assert.deepEqual(legality.legality_rules[1].effect, {
    type: "copy_limit",
    maximum_copies: 1,
  });
});

test("current production legality parser blocks unmodeled notices beside an exact rule", () => {
  const current = requiredSourceAdapter("fusion-world-en@3");
  const unmodeledNotices = [
    `<article class="policy-notice">
      FB01-099 may no longer be used in standard tournament decks.
    </article>`,
    `<select aria-label="New restriction notice">
      <option value="FB01-099">FB01-099 may no longer be used</option>
    </select>`,
    `<p>FB01-099 is unavailable for decks.</p>`,
    `<div>FB01-099 is unavailable for decks.</div>`,
    ...["section", "aside", "span", "strong", "em", "blockquote", "h2", "table", "header"]
      .map((tag) => `<${tag}>FB01-099 is unavailable for decks.</${tag}>`),
    `<header><nav><a href="/fw/en/cardlist/">CARDS</a></nav>
      <p>FB01-099 is unavailable for decks.</p></header>`,
  ];

  for (const notice of unmodeledNotices) {
    const html = exactFusionLegalityHtml.replace(
      "</body>",
      `${notice}</body>`,
    );
    assert.throws(
      () => current.parseBytes(
        new TextEncoder().encode(html),
        fusionLegalityContext(current),
      ),
      /exact, complete Legality Rule parser/iu,
    );
  }
});

test("structured legality publisher data cannot hide unmodeled sibling HTML", () => {
  const current = requiredSourceAdapter("fusion-world-en@3");
  const nonempty = rawSurfacePayload("fusion-world-en", "legality-current");
  nonempty.entries = [{
    rule_ref: "FW-2026-SCRIPT-SIBLING",
    notice: "FB30-001 is banned from standard tournament decks.",
    market: "EN-OCEANIA",
    play_format: "standard",
    tier: null,
    active_on: "2026-07-01",
    expires_on: null,
    cards: ["FB30-001"],
    directive: "ban",
  }];
  nonempty.declared_record_count = 1;
  nonempty.partition.total = 1;
  const eligible = structuredClone(nonempty);
  eligible.entries[0].notice =
    "FB30-001 is legal for Standard play.";
  eligible.entries[0].directive = "eligible";
  const empty = rawSurfacePayload("fusion-world-en", "legality-current");
  const eligibleArticle = fusionLegalityRuleHtml({
    id: "FW-2026-SCRIPT-SIBLING",
    wording: "FB30-001 is legal for Standard play.",
    cards: ["FB30-001"],
    directive: "eligible",
  });
  const conflictingArticle = fusionLegalityRuleHtml({
    id: "FW-2026-SCRIPT-SIBLING",
    wording: "FB30-001 is banned from standard tournament decks.",
    cards: ["FB30-001"],
    directive: "ban",
  });
  const extraArticle = fusionLegalityRuleHtml({
    id: "FW-2026-EXTRA",
    wording: "FB30-002 is legal for Standard play.",
    cards: ["FB30-002"],
    directive: "eligible",
  });

  for (const [name, payload, sibling] of [
    [
      "zero-rule article",
      empty,
      "<article>FB01-099 is unavailable for decks.</article>",
    ],
    [
      "zero-rule strong",
      empty,
      "<strong>FB01-099 is unavailable for decks.</strong>",
    ],
    [
      "nonzero unknown sibling",
      nonempty,
      "<em>Additional tournament restriction applies.</em>",
    ],
    [
      "structured eligible plus conflicting visible ban",
      eligible,
      `<p>1 record</p>${conflictingArticle}`,
    ],
    [
      "structured eligible plus extra visible rule",
      eligible,
      `<p>2 records</p>${eligibleArticle}${extraArticle}`,
    ],
    [
      "structured eligible missing its visible rule",
      eligible,
      "<p>1 record</p>",
    ],
  ]) {
    assert.throws(
      () => current.parseBytes(
        new TextEncoder().encode(
          `<html><title>BANDAI Official publication</title>
           ${officialPublisherPayloadScript(
             "fusion-world-en",
             "legality-current",
             payload,
           )}${sibling}</html>`,
        ),
        fusionLegalityContext(current),
      ),
      /exact, complete Legality Rule parser/iu,
      name,
    );
  }
});

test("structured legality reconciles an exact visible publication", () => {
  const current = requiredSourceAdapter("fusion-world-en@3");
  const payload = rawSurfacePayload("fusion-world-en", "legality-current");
  payload.entries = [{
    rule_ref: "FW-2026-STRUCTURED-VISIBLE",
    notice: "FB30-001 is legal for Standard play.",
    market: "EN-OCEANIA",
    play_format: "standard",
    tier: null,
    active_on: "2026-07-01",
    expires_on: null,
    cards: ["FB30-001"],
    directive: "eligible",
  }];
  payload.declared_record_count = 1;
  payload.partition.total = 1;
  const article = fusionLegalityRuleHtml({
    id: "FW-2026-STRUCTURED-VISIBLE",
    wording: "FB30-001 is legal for Standard play.",
    cards: ["FB30-001"],
    directive: "eligible",
  });
  const observations = current.parseBytes(
    new TextEncoder().encode(
      `<html><title>BANDAI Official publication</title>
       ${officialPublisherPayloadScript(
         "fusion-world-en",
         "legality-current",
         payload,
       )}<main><p>1 record</p>${article}</main></html>`,
    ),
    fusionLegalityContext(current),
  );
  const legality = observations.find(
    ({ observation_type }) => observation_type === "legality_rules",
  );
  assert.equal(legality.legality_rules[0].id, "FW-2026-STRUCTURED-VISIBLE");
  assert.deepEqual(legality.legality_rules[0].effect, { type: "eligible" });
});

test("structured legality consumes only the exact lineage and surface publisher script", () => {
  const current = requiredSourceAdapter("fusion-world-en@3");
  const currentEmpty = rawSurfacePayload("fusion-world-en", "legality-current");
  const currentNonempty = structuredClone(currentEmpty);
  currentNonempty.entries = [{
    rule_ref: "FW-2026-EXACT-SCRIPT",
    notice: "FB30-001 is banned from standard tournament decks.",
    market: "EN-OCEANIA",
    play_format: "standard",
    tier: null,
    active_on: "2026-07-01",
    expires_on: null,
    cards: ["FB30-001"],
    directive: "ban",
  }];
  currentNonempty.declared_record_count = 1;
  currentNonempty.partition.total = 1;
  for (const [name, payload, siblingSurface] of [
    ["zero current plus history", currentEmpty, "legality-history"],
    ["nonzero current plus policy", currentNonempty, "block-policy"],
    ["nonzero current plus unknown", currentNonempty, "unknown-policy"],
  ]) {
    assert.throws(
      () => current.parseBytes(
        new TextEncoder().encode(
          `<html><title>BANDAI DRAGON BALL CARD RULE RESTRICTION</title>
           ${officialPublisherPayloadScript(
             "fusion-world-en",
             "legality-current",
             payload,
           )}
           ${officialPublisherPayloadScript(
             "fusion-world-en",
             siblingSurface,
             currentEmpty,
           )}</html>`,
        ),
        fusionLegalityContext(current),
      ),
      /exact, complete Legality Rule parser|unmatched.*publisher/iu,
      name,
    );
  }
  for (const siblingScript of [
    "<script></script>",
    "<script>   </script>",
    '<script id="publisher-extension"></script>',
  ]) {
    assert.throws(
      () => current.parseBytes(
        new TextEncoder().encode(
          `<html><title>BANDAI DRAGON BALL CARD RULE RESTRICTION</title>
           ${officialPublisherPayloadScript(
             "fusion-world-en",
             "legality-current",
             currentEmpty,
           )}
           ${siblingScript}</html>`,
        ),
        fusionLegalityContext(current),
      ),
      /exact, complete Legality Rule parser|unmatched.*script/iu,
    );
  }
});

test("production legality rejects generic Dataset title framing around an owned script", () => {
  const current = requiredSourceAdapter("fusion-world-en@3");
  assert.throws(
    () => current.parseBytes(
      new TextEncoder().encode(
        `<html><title>BANDAI Official CARD PRODUCT RELEASE RULE ERRATA RESTRICTION Dataset</title>
         ${officialPublisherPayloadScript(
           "fusion-world-en",
           "legality-current",
           rawSurfacePayload("fusion-world-en", "legality-current"),
         )}</html>`,
      ),
      fusionLegalityContext(current),
    ),
    /exact, complete Legality Rule parser|title/iu,
  );
});

test("known navigation labels cannot hide an unrecognized publisher URL", () => {
  const current = requiredSourceAdapter("fusion-world-en@3");
  const html = exactFusionLegalityHtml.replace(
    "</body>",
    `<main><a href="/new-restriction/">Rules</a></main></body>`,
  );
  assert.throws(
    () => current.parseBytes(
      new TextEncoder().encode(html),
      fusionLegalityContext(current),
    ),
    /exact, complete Legality Rule parser|navigation/iu,
  );
});

test("current production legality parser accepts a complete multi-rule publication with only bounded publisher framing", () => {
  const current = requiredSourceAdapter("fusion-world-en@3");
  const legality = current.parseBytes(
    new TextEncoder().encode(exactFusionLegalityHtml),
    fusionLegalityContext(current),
  ).find(({ observation_type }) => observation_type === "legality_rules");
  assert.equal(legality.legality_rules.length, 2);
  assert.equal(legality.completeness.parsed_record_count, 2);
});

test("current production legality parser retains a truthful empty publication", () => {
  const current = requiredSourceAdapter("fusion-world-en@3");
  const observations = current.parseBytes(
    new TextEncoder().encode(`
      <html><head><title>Bandai Dragon Ball Fusion World Restriction Rules</title></head>
      <body><h1>Restriction Rules</h1><p>0 records</p>
        <article data-publication-empty="true">No restrictions are currently published.</article>
      </body></html>`),
    fusionLegalityContext(current),
  );
  const legality = observations.find(
    ({ observation_type }) => observation_type === "legality_rules",
  );
  assert.deepEqual(legality.legality_rules, []);
  assert.equal(legality.completeness.declared_record_count, 0);
  assert.equal(legality.completeness.parsed_record_count, 0);
});

test("current production legality parser accepts an ordinary publisher-declared zero without a Keepr marker", () => {
  const current = requiredSourceAdapter("fusion-world-en@3");
  const observations = current.parseBytes(
    new TextEncoder().encode(`
      <html><head><title>Bandai Dragon Ball Fusion World Restriction Rules</title></head>
      <body><h1>Restriction Rules</h1><p>0 records</p></body></html>`),
    fusionLegalityContext(current),
  );
  const legality = observations.find(
    ({ observation_type }) => observation_type === "legality_rules",
  );
  assert.deepEqual(legality.legality_rules, []);
  assert.equal(legality.completeness.declared_record_count, 0);
  assert.equal(legality.completeness.parsed_record_count, 0);
});

test("current production legality parser blocks a publisher total that disagrees with exact articles", () => {
  const current = requiredSourceAdapter("fusion-world-en@3");
  assert.throws(
    () => current.parseBytes(
      new TextEncoder().encode(
        exactFusionLegalityHtml.replace("2 records", "3 records"),
      ),
      fusionLegalityContext(current),
    ),
    /declares 3 records but exactly 2 were parsed/u,
  );
});

test("current production legality parser rejects negated bans and copy limits whose wording disagrees with the declared cap", () => {
  const current = requiredSourceAdapter("fusion-world-en@3");
  assert.throws(
    () => current.parseBytes(
      new TextEncoder().encode(
        exactFusionLegalityHtml.replace(
          "FB01-001 is banned from standard tournament decks.",
          "FB01-001 is not banned from standard tournament decks.",
        ),
      ),
      fusionLegalityContext(current),
    ),
    /wording contradicts directive ban/u,
  );
  assert.throws(
    () => current.parseBytes(
      new TextEncoder().encode(
        exactFusionLegalityHtml.replace(
          "FB01-002 is limited to 1 copy in standard decks.",
          "FB01-002 is limited to 2 copies in standard decks.",
        ),
      ),
      fusionLegalityContext(current),
    ),
    /wording does not exactly support copy limit 1/u,
  );
});

test("current production legality parser requires exact positive wording for every structured effect operand", () => {
  const current = requiredSourceAdapter("fusion-world-en@3");
  const valid = fusionLegalityPage(
    fusionLegalityRuleHtml({
      id: "FW-2026-COMBINATION",
      wording: "FB01-010 and FB01-011 may not be used together in the same deck.",
      cards: ["FB01-010"],
      directive: "prohibited_combination",
      effectFields: "<dt>Paired Cards</dt><dd>FB01-011</dd>",
    }),
    fusionLegalityRuleHtml({
      id: "FW-2026-MEMBERSHIP",
      wording: "Only cards whose trait includes Saiyan or Earthling are eligible.",
      cards: [],
      directive: "membership",
      effectFields: `
        <dt>Filter Field</dt><dd>trait</dd>
        <dt>Filter Values</dt><dd>Saiyan, Earthling</dd>`,
    }),
    fusionLegalityRuleHtml({
      id: "FW-2026-ROTATION",
      wording: "Blocks 05 and 06 are eligible for rotation.",
      cards: [],
      directive: "rotation",
      effectFields: "<dt>Blocks</dt><dd>05, 06</dd>",
    }),
    fusionLegalityRuleHtml({
      id: "FW-2026-RELEASE",
      wording: "FB01-012 becomes legal for tournament play on 2026-09-04.",
      cards: ["FB01-012"],
      directive: "release_timing",
      effectFields:
        "<dt>Tournament Legal Date</dt><dd>2026-09-04</dd>",
    }),
  );
  const observations = current.parseBytes(
    new TextEncoder().encode(valid),
    fusionLegalityContext(current),
  );
  const legality = observations.find(
    ({ observation_type }) => observation_type === "legality_rules",
  );
  assert.deepEqual(
    legality.legality_rules.map(({ effect }) => effect),
    [
      {
        type: "prohibited_combination",
        with_card_numbers: ["FB01-011"],
      },
      {
        type: "membership",
        attribute: "trait",
        includes_any: ["Saiyan", "Earthling"],
      },
      { type: "rotation", eligible_blocks: ["05", "06"] },
      { type: "release_timing", legal_from: "2026-09-04" },
    ],
  );

  for (const [original, wording, mismatch] of [
    [
      "FB01-010 and FB01-011 may not be used together in the same deck.",
      "FB01-010 and FB01-011 may be used together in the same deck.",
      /prohibited combination/u,
    ],
    [
      "FB01-010 and FB01-011 may not be used together in the same deck.",
      "FB01-010 and FB01-099 may not be used together in the same deck.",
      /operand FB01-011/u,
    ],
    [
      "Only cards whose trait includes Saiyan or Earthling are eligible.",
      "Cards do not require a trait that includes Saiyan or Earthling.",
      /membership/u,
    ],
    [
      "Only cards whose trait includes Saiyan or Earthling are eligible.",
      "Only cards whose trait does not currently include Saiyan or Earthling are eligible.",
      /membership/u,
    ],
    [
      "Only cards whose trait includes Saiyan or Earthling are eligible.",
      "Only cards whose trait includes Saiyan or Namekian are eligible.",
      /operand Earthling/u,
    ],
    [
      "Blocks 05 and 06 are eligible for rotation.",
      "Blocks 05 and 06 are not eligible for rotation.",
      /rotation/u,
    ],
    [
      "Blocks 05 and 06 are eligible for rotation.",
      "Blocks 05 and 06 are not currently eligible for rotation.",
      /rotation/u,
    ],
    [
      "Blocks 05 and 06 are eligible for rotation.",
      "Blocks 05 and 07 are eligible for rotation.",
      /operand 06/u,
    ],
    [
      "FB01-012 becomes legal for tournament play on 2026-09-04.",
      "FB01-012 is not legal for tournament play on 2026-09-04.",
      /release timing/u,
    ],
    [
      "FB01-012 becomes legal for tournament play on 2026-09-04.",
      "FB01-012 is not currently tournament legal on 2026-09-04.",
      /release timing/u,
    ],
    [
      "FB01-012 becomes legal for tournament play on 2026-09-04.",
      "FB01-012 becomes legal for tournament play on 2026-09-05.",
      /operand 2026-09-04/u,
    ],
    [
      "FB01-012 becomes legal for tournament play on 2026-09-04.",
      "Starting 2026-09-04, FB01-012 becomes legal for tournament play on 2026-09-05.",
      /release date|residual|qualifier/iu,
    ],
  ]) {
    assert.throws(
      () => current.parseBytes(
        new TextEncoder().encode(
          valid.replace(original, wording),
        ),
        fusionLegalityContext(current),
      ),
      mismatch,
    );
  }

  for (const [structured, mismatch] of [
    [
      valid.replace(
        "<dt>Filter Values</dt><dd>Saiyan, Earthling</dd>",
        "<dt>Filter Values</dt><dd>Saiyan</dd>",
      ),
      /wording membership values/iu,
    ],
    [
      valid.replace(
        "<dt>Blocks</dt><dd>05, 06</dd>",
        "<dt>Blocks</dt><dd>05</dd>",
      ),
      /wording rotation blocks/iu,
    ],
    [
      valid.replace(
        "FB01-010 and FB01-011 may not be used together in the same deck.",
        "FB01-010, FB01-011 and FB01-012 may not be used together in the same deck.",
      ),
      /wording target and companion Cards/iu,
    ],
  ]) {
    assert.throws(
      () => current.parseBytes(
        new TextEncoder().encode(structured),
        fusionLegalityContext(current),
      ),
      mismatch,
    );
  }
});

test("current production legality parser rejects modifier-scoped eligible negation", () => {
  const current = requiredSourceAdapter("fusion-world-en@3");
  const html = fusionLegalityPage(fusionLegalityRuleHtml({
    id: "FW-2026-NEGATED-ELIGIBLE",
    wording: "FB01-030 is not tournament legal for Standard play.",
    cards: ["FB01-030"],
    directive: "eligible",
  }));
  assert.throws(
    () => current.parseBytes(
      new TextEncoder().encode(html),
      fusionLegalityContext(current),
    ),
    /wording contradicts directive eligible/u,
  );
});

test("current production legality parser rejects mixed directives and foreign operands", () => {
  const current = requiredSourceAdapter("fusion-world-en@3");
  const mixed = fusionLegalityPage(fusionLegalityRuleHtml({
    id: "FW-2026-MIXED-ELIGIBLE",
    wording:
      "FB01-030 is legal for Standard play, but decks are limited to 1 copy.",
    cards: ["FB01-030"],
    directive: "eligible",
    effectFields: "<dt>Cap</dt><dd>1</dd>",
  }));
  assert.throws(
    () => current.parseBytes(
      new TextEncoder().encode(mixed),
      fusionLegalityContext(current),
    ),
    /foreign operand|additional structured semantics/u,
  );
});

test("current production legality parser rejects every unmodelled conditional clause inside recognized wording", () => {
  const current = requiredSourceAdapter("fusion-world-en@3");
  for (const [name, wording] of [
    ["when", "FB01-030 is banned when your Leader is FB01-999."],
    ["if", "FB01-030 is banned if your Leader is FB01-999."],
    ["during", "FB01-030 is banned during Championship events."],
    ["tier-scoped only", "FB01-030 is banned only at Championship events."],
    ["unless", "FB01-030 is banned unless your Leader is FB01-999."],
    ["exception", "FB01-030 is banned, except at Championship events."],
    ["qualifier", "FB01-030 is banned subject to the event policy."],
  ]) {
    const html = fusionLegalityPage(fusionLegalityRuleHtml({
      id: `FW-2026-CONDITIONAL-BAN-${name}`,
      wording,
      cards: ["FB01-030"],
      directive: "ban",
    }));
    assert.throws(
      () => current.parseBytes(
        new TextEncoder().encode(html),
        fusionLegalityContext(current),
      ),
      /conditional|qualifier|cannot represent/u,
      name,
    );
  }
});

test("every active production legality adapter requires exact wording targets and play scope", () => {
  const cases = [
    {
      adapter: "one-piece-en@2",
      lineage: "one-piece-en",
      surface: "restrictions",
      card: "OP30-001",
      otherCard: "OP99-999",
      region: "EN-OCEANIA",
      otherRegion: "EN-US",
      fields: {
        id: "notice_no", wording: "published_text", region: "territory",
        format: "format_name", tier: "event_class", from: "start_date",
        until: "end_date", cards: "card_numbers", directive: "restriction_code",
        maximum: "maximum_copies",
      },
    },
    {
      adapter: "fusion-world-en@3",
      lineage: "fusion-world-en",
      surface: "legality-current",
      card: "FB30-001",
      otherCard: "FB99-999",
      region: "EN-OCEANIA",
      otherRegion: "EN-US",
      fields: {
        id: "rule_ref", wording: "notice", region: "market",
        format: "play_format", tier: "tier", from: "active_on",
        until: "expires_on", cards: "cards", directive: "directive",
        maximum: "cap",
      },
    },
    {
      adapter: "digimon-en@3",
      lineage: "digimon-en",
      surface: "restrictions-current",
      card: "BT30-001",
      otherCard: "BT99-999",
      region: "EN-OCEANIA",
      otherRegion: "EN-US",
      fields: {
        id: "restriction_id", wording: "body", region: "language_scope",
        format: "ruleset", tier: "tournament_level", from: "applies_from",
        until: "applies_until", cards: "card_ids", directive: "status_code",
        maximum: "deck_limit",
      },
    },
    ...[
      ["gundam-en-asia@3", "gundam-en-asia", "GD30-001", "EN-ASIA", "EN-US"],
      ["gundam-en-us@3", "gundam-en-us", "GD30-001", "EN-US", "EN-ASIA"],
    ].map(([adapter, lineage, card, region, otherRegion]) => ({
      adapter,
      lineage,
      surface: "legality",
      card,
      otherCard: "GD99-999",
      region,
      otherRegion,
      fields: {
        id: "news_id", wording: "text", region: "region",
        format: "format", tier: "event_tier", from: "effective_date",
        until: "end_date", cards: "card_numbers", directive: "ruling",
        maximum: "copy_limit",
      },
    })),
  ];

  for (const descriptor of cases) {
    const adapter = requiredSourceAdapter(descriptor.adapter);
    const payload = rawSurfacePayload(descriptor.lineage, descriptor.surface);
    const eligible = {
      [descriptor.fields.id]: `${descriptor.lineage}-exact-scope`,
      [descriptor.fields.wording]:
        `${descriptor.card} is eligible for Standard events in the ${descriptor.region} region.`,
      [descriptor.fields.region]: descriptor.region,
      [descriptor.fields.format]: "standard",
      [descriptor.fields.tier]: null,
      [descriptor.fields.from]: "2026-01-01",
      [descriptor.fields.until]: null,
      [descriptor.fields.cards]: [descriptor.card],
      [descriptor.fields.directive]: "eligible",
    };
    payload.entries = [eligible];
    payload.declared_record_count = 1;
    payload.partition.total = 1;
    assert.doesNotThrow(
      () => parseRegisteredSurface(adapter, descriptor.surface, payload),
      descriptor.adapter,
    );

    for (const [name, changed] of [
      [
        "unknown structured region",
        { [descriptor.fields.region]: "EUROPE" },
      ],
      [
        "unknown wording region",
        {
          [descriptor.fields.wording]:
            `${descriptor.card} is eligible for Standard events in the EUROPE region.`,
        },
      ],
      [
        "known inconsistent region alias",
        {
          [descriptor.fields.wording]:
            `${descriptor.card} is eligible for Standard events in the ${
              descriptor.region === "EN-US" ? "Asia" : "North America"
            } region.`,
        },
      ],
      [
        "conditional leading prose",
        {
          [descriptor.fields.wording]:
            `If your Leader is red, ${descriptor.card} is eligible for Standard play.`,
        },
      ],
      [
        "event-scoped leading prose",
        {
          [descriptor.fields.wording]:
            `During regional events, ${descriptor.card} is eligible for Standard play.`,
        },
      ],
      [
        "unknown regional leading prose",
        {
          [descriptor.fields.wording]:
            `In Europe, ${descriptor.card} is eligible for Standard play.`,
        },
      ],
    ]) {
      const mismatch = structuredClone(payload);
      mismatch.entries[0] = { ...eligible, ...changed };
      assert.throws(
        () => parseRegisteredSurface(adapter, descriptor.surface, mismatch),
        /wording.*region|structured.*region|region.*(?:unknown|invalid|match)|conditional|qualifier|scope/iu,
        `${descriptor.adapter}: ${name}`,
      );
    }

    for (const [name, changed] of [
      ["omitted target", { [descriptor.fields.cards]: [] }],
      ["wrong target", { [descriptor.fields.cards]: [descriptor.otherCard] }],
      [
        "wrong wording region",
        {
          [descriptor.fields.wording]:
            `${descriptor.card} is eligible for Standard events in the ${descriptor.otherRegion} region.`,
        },
      ],
      [
        "foreign regional prefix",
        {
          [descriptor.fields.wording]:
            `For ${descriptor.otherRegion}, ${descriptor.card} is eligible for Standard play.`,
        },
      ],
      ["wrong structured format", { [descriptor.fields.format]: "unlimited" }],
      [
        "foreign regional wording",
        {
          [descriptor.fields.wording]:
            `In ${descriptor.region === "EN-US" ? "Asia" : "North America"}, ${descriptor.card} is eligible for Standard play.`,
        },
      ],
    ]) {
      const mismatch = structuredClone(payload);
      mismatch.entries[0] = { ...eligible, ...changed };
      assert.throws(
        () => parseRegisteredSurface(adapter, descriptor.surface, mismatch),
        /wording.*(?:target|region|format|scope)|does not exactly support/iu,
        `${descriptor.adapter}: ${name}`,
      );
    }

    const global = structuredClone(payload);
    global.entries[0] = {
      ...eligible,
      [descriptor.fields.wording]:
        "Cards satisfying the published Standard eligibility rules may be used.",
    };
    assert.throws(
      () => parseRegisteredSurface(adapter, descriptor.surface, global),
      /wording.*target/iu,
      `${descriptor.adapter}: global wording with structured target`,
    );

    const tiered = structuredClone(payload);
    tiered.entries[0] = {
      ...eligible,
      [descriptor.fields.wording]:
        `For Championship events, decks may contain no more than 1 copy of ${descriptor.card}.`,
      [descriptor.fields.tier]: "championship",
      [descriptor.fields.directive]: "copy_limit",
      [descriptor.fields.maximum]: 1,
    };
    assert.doesNotThrow(
      () => parseRegisteredSurface(adapter, descriptor.surface, tiered),
      `${descriptor.adapter}: exact tier`,
    );
    for (const tier of [null, "regional"]) {
      const mismatch = structuredClone(tiered);
      mismatch.entries[0][descriptor.fields.tier] = tier;
      assert.throws(
        () => parseRegisteredSurface(adapter, descriptor.surface, mismatch),
        /wording.*(?:tier|scope)/iu,
        `${descriptor.adapter}: ${String(tier)} tier`,
      );
    }

    const knownTierScope = structuredClone(payload);
    knownTierScope.entries[0] = {
      ...eligible,
      [descriptor.fields.wording]:
        `${descriptor.card} is eligible under the published Championship-only rule.`,
      [descriptor.fields.tier]: "championship",
    };
    assert.doesNotThrow(
      () => parseRegisteredSurface(adapter, descriptor.surface, knownTierScope),
      `${descriptor.adapter}: exact closed tier scope`,
    );
    for (const tier of [null, "regional"]) {
      const mismatch = structuredClone(knownTierScope);
      mismatch.entries[0][descriptor.fields.tier] = tier;
      assert.throws(
        () => parseRegisteredSurface(adapter, descriptor.surface, mismatch),
        /wording.*(?:tier|scope)/iu,
        `${descriptor.adapter}: closed tier scope conflicts with ${String(tier)}`,
      );
    }
  }
});

test("current production legality parser preserves paragraph and list boundaries", () => {
  const current = requiredSourceAdapter("fusion-world-en@3");
  const html = fusionLegalityPage(fusionLegalityRuleHtml({
    id: "FW-2026-BLOCK-TEXT",
    wording:
      "<p>FB01-030 is legal for Standard play.</p><ul><li>Publisher notice:</li><li>Effective immediately.</li></ul>",
    cards: ["FB01-030"],
    directive: "eligible",
  }));
  const legality = current.parseBytes(
    new TextEncoder().encode(html),
    fusionLegalityContext(current),
  ).find(({ observation_type }) => observation_type === "legality_rules");
  assert.equal(
    legality.legality_rules[0].official_wording,
    "FB01-030 is legal for Standard play.\nPublisher notice:\nEffective immediately.",
  );
});

test("current production legality parser rejects residual semantic article markup", () => {
  const current = requiredSourceAdapter("fusion-world-en@3");
  const html = fusionLegalityPage(
    fusionLegalityRuleHtml({
      id: "FW-2026-RESIDUAL",
      wording: "FB01-030 is legal for Standard play.",
      cards: ["FB01-030"],
      directive: "eligible",
    }).replace(
      "</article>",
      "<p>Except at championship events, where it is banned.</p></article>",
    ),
  );
  assert.throws(
    () => current.parseBytes(
      new TextEncoder().encode(html),
      fusionLegalityContext(current),
    ),
    /residual semantic content/u,
  );
});

test("current production legality parser rejects definitive unresolved wording and missing combination sides", () => {
  const current = requiredSourceAdapter("fusion-world-en@3");
  for (const html of [
    fusionLegalityPage(fusionLegalityRuleHtml({
      id: "FW-2026-UNRESOLVED-CONTRADICTION",
      wording: "FB01-030 is banned from Standard decks.",
      cards: ["FB01-030"],
      directive: "unresolved",
      effectFields: "<dt>Ambiguity</dt><dd>Publisher scope is unknown</dd>",
    })),
    fusionLegalityPage(fusionLegalityRuleHtml({
      id: "FW-2026-COMBINATION-MISSING-DIRECT",
      wording: "FB01-031 and FB01-032 are a prohibited combination.",
      cards: [],
      directive: "prohibited_combination",
      effectFields: "<dt>Paired Cards</dt><dd>FB01-032</dd>",
    })),
  ]) {
    assert.throws(
      () => current.parseBytes(
        new TextEncoder().encode(html),
        fusionLegalityContext(current),
      ),
      /unresolved|Card numbers|additional structured semantics/u,
    );
  }
  assert.throws(
    () => officialLegalityRulesObservation(
      "fusion-world",
      "fusion-world-en",
      {
        entries: [{
          rule_ref: "FW-UNTRUSTED-LIVE-SHAPE",
          notice: "No copies of the card are permitted in the deck.\nFB01-030 Example",
          market: "EN-OCEANIA",
          play_format: "standard",
          tier: null,
          active_on: null,
          expires_on: null,
          unresolved_scope: { dimensions: ["effective_interval"] },
          cards: ["FB01-030"],
          directive: "unresolved",
          ambiguity: "Effective interval for FB01-030 is not stated.",
        }],
      },
    ),
    /unresolved|additional structured semantics/iu,
  );
});

test("current machine legality surfaces require independent exact totals and partitions", () => {
  const current = requiredSourceAdapter("fusion-world-en@3");
  const mismatch = rawSurfacePayload("fusion-world-en", "legality-current");
  mismatch.declared_record_count = 99;
  assert.throws(
    () => parseRegisteredSurface(current, "legality-current", mismatch),
    /declares 99 records|declared total/u,
  );
  const truncated = rawSurfacePayload("fusion-world-en", "legality-current");
  truncated.partition.has_next = true;
  assert.throws(
    () => parseRegisteredSurface(current, "legality-current", truncated),
    /partition/u,
  );
  const unknown = rawSurfacePayload("fusion-world-en", "legality-current");
  unknown.future_scope = "championship-only";
  assert.throws(
    () => parseRegisteredSurface(current, "legality-current", unknown),
    /unknown field future_scope/u,
  );
});

test("current production legality HTML decodes entities exactly once", () => {
  const current = requiredSourceAdapter("fusion-world-en@3");
  const html = fusionLegalityPage(fusionLegalityRuleHtml({
    id: "FW-2026-ENTITIES",
    wording:
      "FB01-030 is legal &#39;as printed&#39; &#x2013; publisher&ndash;confirmed &amp;#39;literal&amp;#39;.",
    cards: ["FB01-030"],
    directive: "eligible",
  }));
  const observations = current.parseBytes(
    new TextEncoder().encode(html),
    fusionLegalityContext(current),
  );
  const legality = observations.find(
    ({ observation_type }) => observation_type === "legality_rules",
  );
  assert.equal(
    legality.legality_rules[0].official_wording,
    "FB01-030 is legal 'as printed' – publisher–confirmed &#39;literal&#39;.",
  );
});

test("official legality entries reject publisher notes and unknown semantic fields", () => {
  const entry = {
    rule_ref: "FW-2026-003",
    notice: "FB01-003 is banned from standard tournament decks.",
    market: "EN-OCEANIA",
    play_format: "standard",
    tier: null,
    active_on: "2026-07-01",
    expires_on: null,
    cards: ["FB01-003"],
    directive: "ban",
  };
  for (const publisherNote of [
    "",
    "This publisher note is retained only as source metadata.",
    "Only during Championship events.",
    "Unless your Leader is red.",
  ]) {
    assert.throws(
      () => officialLegalityRulesObservation(
        "fusion-world",
        "fusion-world-en",
        { entries: [{ ...entry, publisher_note: publisherNote }] },
      ),
      /unknown field publisher_note/iu,
    );
  }
  assert.throws(
    () => officialLegalityRulesObservation(
      "fusion-world",
      "fusion-world-en",
      {
        entries: [{ ...entry, future_scope: "championship-only" }],
      },
    ),
    /unknown field future_scope/u,
  );
});

test("the versioned One Piece release surface emits its exact release-timing rule beside Release evidence", () => {
  const current = requiredSourceAdapter("one-piece-en@2");
  const payload = rawSurfacePayload("one-piece-en", "releases");
  payload.release_timing_entries = [{
    notice_no: "OP-RELEASE-2026-001",
    published_text:
      "OP99-001 becomes legal for standard tournament play on 2026-09-04.",
    territory: "EN-OCEANIA",
    format_name: "standard",
    event_class: null,
    start_date: "2026-08-01",
    end_date: null,
    card_numbers: ["OP99-001"],
    restriction_code: "release_timing",
    legal_from: "2026-09-04",
  }];
  const observations = parseRegisteredSurface(current, "releases", payload);
  assert.ok(observations.some(({ product_release_catalogue }) =>
    product_release_catalogue?.products?.some(({ releases }) =>
      releases.length > 0
    )
  ));
  const legality = observations.find(
    ({ observation_type }) => observation_type === "legality_rules",
  );
  assert.deepEqual(legality.legality_rules, [{
    id: "OP-RELEASE-2026-001",
    game: "one-piece",
    region: "EN-OCEANIA",
    format: "standard",
    event_tier: null,
    effective_from: "2026-08-01",
    effective_until: null,
    unresolved_scope: null,
    card_numbers: ["OP99-001"],
    official_wording:
      "OP99-001 becomes legal for standard tournament play on 2026-09-04.",
    effect: { type: "release_timing", legal_from: "2026-09-04" },
    representable: true,
  }]);
});

test("one identical ordinary One Piece Product document is valid for Product and Release roles", () => {
  const adapter = requiredSourceAdapter("one-piece-en@2");
  const bytes = Buffer.from(
    `<html><title>BANDAI ONE PIECE CARD PRODUCTS</title>
      <main><p>0 records</p><article data-publication-empty="true">No published entries.</article></main>
    </html>`,
    "utf8",
  );
  for (const surface of ["products", "releases"]) {
    const observations = adapter.parseBytes(bytes, {
      mediaType: "text/html; charset=utf-8",
      url: "https://en.onepiece-cardgame.com/products/",
      requestId: `one-piece-en:${surface}`,
    });
    assert.ok(observations.length >= 1, surface);
  }
});

test("historical and current production registrations keep byte-identical legality decoder behavior isolated", () => {
  const historical = requiredSourceAdapter("fusion-world-en@2");
  const current = requiredSourceAdapter("fusion-world-en@3");
  const bytes = new TextEncoder().encode(exactFusionLegalityHtml);
  const oldObservations = historical.parseBytes(
    bytes,
    fusionLegalityContext(historical),
  );
  const newObservations = current.parseBytes(
    bytes,
    fusionLegalityContext(current),
  );
  assert.equal(
    oldObservations.some(({ observation_type }) =>
      observation_type === "legality_rules"
    ),
    false,
  );
  assert.equal(
    newObservations.some(({ observation_type }) =>
      observation_type === "legality_rules"
    ),
    true,
  );
  const emptyBytes = new TextEncoder().encode(`
    <html><head><title>Bandai Dragon Ball Fusion World Restriction Rules</title></head>
    <body><h1>Restriction Rules</h1><p>0 records</p>
      <article data-publication-empty="true">No restrictions are currently published.</article>
    </body></html>`);
  const oldEmpty = historical.parseBytes(
    emptyBytes,
    fusionLegalityContext(historical),
  );
  const newEmpty = current.parseBytes(
    emptyBytes,
    fusionLegalityContext(current),
  );
  assert.equal(oldEmpty.length, 1);
  assert.deepEqual(
    oldEmpty[0].source_sidecar.raw.official_surfaces[0].document
      .publication_entries,
    [
    "No restrictions are currently published.",
    ],
  );
  assert.equal(newEmpty.length, 2);
  assert.deepEqual(newEmpty[1].legality_rules, []);
});

test("current production legality parser fails closed for loose unknown rule markup", () => {
  const current = requiredSourceAdapter("fusion-world-en@3");
  assert.throws(
    () => current.parseBytes(
      new TextEncoder().encode(`
        <html><head><title>Bandai Dragon Ball Fusion World Restriction Rules</title></head>
        <body><h1>Restriction Rules</h1>
          <article class="unversioned-rule">FB01-001 might be restricted someday.</article>
        </body></html>`),
      fusionLegalityContext(current),
    ),
    /non-empty Legality data without an exact, complete Legality Rule parser/iu,
  );
});

test("production decoders accept real Bandai-shaped HTML without a Keepr payload wrapper", () => {
  const adapter = registeredProductionAdapters().find(
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
    /https?:|OP99-001\.png|#OP99-001|content_sha|sha256|image\//u,
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
  const unfamiliarTreatment = adapter.parseBytes(
    new TextEncoder().encode(
      html.replace(
        '<div class="getInfo"><h3>Card Set(s)</h3>',
        '<div class="treatment"><h3>Treatment</h3>Textured Foil</div>' +
          '<div class="getInfo"><h3>Card Set(s)</h3>',
      ),
    ),
    {
      mediaType: "text/html; charset=utf-8",
      url: "https://en.onepiece-cardgame.com/cardlist/",
    },
  )[0];
  assert.equal(unfamiliarTreatment.identity_evidence.treatment, null);
  assert.ok(
    unfamiliarTreatment.source_sidecar.unmapped_optional_fields.some(
      ({ value }) => value === "Textured Foil",
    ),
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

test("generic Schema.org Dataset payloads cannot enter production adapters", () => {
  const adapter = requiredSourceAdapter("one-piece-en@2");
  const payload = officialRawSurfacePayload("/one-piece-en/card-list");
  assert.throws(
    () => adapter.parseBytes(
      new TextEncoder().encode(
        `<html><script type="application/ld+json">${JSON.stringify({
          "@context": "https://schema.org",
          "@type": "Dataset",
          publisher: { "@type": "Organization", name: "Bandai" },
          hasPart: [{
            "@type": "Dataset",
            identifier: "one-piece-en:card-list",
            payload,
          }],
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

test("One Piece publisher data retains an explicit first Printing identity", () => {
  const adapter = registeredProductionAdapters().find(
    ({ sourceLineage }) => sourceLineage === "one-piece-en",
  );
  const payload = officialRawSurfacePayload("/one-piece-en/card-list");
  const observations = adapter.parseBytes(
    new TextEncoder().encode(
      `<html>${officialPublisherPayloadScript(
        "one-piece-en",
        "card-list",
        payload,
      )}</html>`,
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
    'official-artwork:{"official_card_identity":"OP99-001","roles":["front"],"artwork_id":null}',
  );
  assert.equal(observation.identity_evidence.locator, "/cards/OP99-001");
  assert.equal(observation.identity_evidence.treatment, null);
});

test("live split discovery follows each lineage's bounded staged hierarchy", () => {
  const byLineage = (lineage) =>
    registeredProductionAdapters().find(
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

test("Digimon staged discovery ignores only the known global header and retains one literal local Card List link", () => {
  const adapter = requiredSourceAdapter("digimon-en@3");
  const stageUrl = "https://world.digimoncard.com/cardlist/";
  const stageLink = '<a href="/cards/index.php?search=true">Card List</a>';
  const stageHtml = (links) => `<html>
    <title>BANDAI DIGIMON CARD LIST</title>
    ${officialBandaiNavigationHeader("digimon-en")}
    <main>${links}</main>
  </html>`;
  const context = {
    mediaType: "text/html; charset=utf-8",
    url: stageUrl,
    requestId: `digimon-en:listing:cards:${"a".repeat(64)}`,
  };
  const observations = adapter.parseBytes(
    new TextEncoder().encode(stageHtml(stageLink)),
    context,
  );
  const stage = observations.find(
    ({ observation_type }) => observation_type === "official_surface_evidence",
  );
  assert.deepEqual(stage.records, [{
    id: "digimon-en:card-list",
    surface: "card-list",
    method: "GET",
    url: "https://world.digimoncard.com/cards/index.php?search=true",
    headers: {
      accept: "text/html",
    },
    discovered_from: {
      kind: "publisher_navigation",
      label: "card list",
      url: stageUrl,
      resolution: "/cards/index.php?search=true",
    },
  }]);
  assert.deepEqual(
    adapter.discoverRequests(
      new TextEncoder().encode(stageHtml(stageLink)),
      context,
    ),
    [],
    "a literal final-surface link is plan closure, not a synthetic detail request",
  );
  assert.throws(
    () => adapter.parseBytes(
      new TextEncoder().encode(stageHtml(`${stageLink}${stageLink}`)),
      context,
    ),
    /duplicates the card-list surface link/iu,
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
    const adapter = registeredProductionAdapters().find(
      ({ sourceLineage }) => sourceLineage === fixture.lineage,
    );
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
    const observations = adapter.parseBytes(
      new TextEncoder().encode(html),
      stageContext,
    );
    assert.ok(
      observations.every(
        ({ observation_type }) =>
          observation_type === "official_surface_evidence",
      ),
      `${fixture.lineage} stage emitted a catalogue observation`,
    );
    assert.deepEqual(
      adapter.discoverRequests(
        new TextEncoder().encode(html),
        stageContext,
      ),
      [],
      `${fixture.lineage} stage scheduled a catalogue-bearing request`,
    );
  }
});

test("known publisher navigation cannot manufacture catalogue detail requests", () => {
  for (const adapter of registeredProductionAdapters()) {
    const surface = adapter.requiredSurfaces[0];
    assert.ok(surface);
    const requests = adapter.discoverRequests(
      new TextEncoder().encode(
        `<html><title>BANDAI Official Card List</title>${
          officialBandaiNavigationHeader(adapter.sourceLineage)
        }</html>`,
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

test("Fusion leaders require explicit role-owned faces and images", () => {
  const adapter = registeredProductionAdapters().find(
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
  const adapter = registeredProductionAdapters().find(
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
  const adapter = registeredProductionAdapters().find(
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
  const adapter = registeredProductionAdapters().find(
    ({ sourceLineage }) => sourceLineage === "one-piece-en",
  );
  const document = rawSurfacePayload("one-piece-en", "card-list");
  document.card_pages[0].future_nested = {
    vendor_rule: "retain this nested leaf",
  };
  const observation = parseRegisteredSurface(
    adapter,
    "card-list",
    document,
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
  const adapter = registeredProductionAdapters().find(
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
        resolution === "fuzzy" &&
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
    registeredProductionAdapters().find(
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

test("every production lineage preserves its synthetic publisher-contract examples", () => {
  for (const adapter of registeredProductionAdapters()) {
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
  const adapter = registeredProductionAdapters().find(
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
  const adapter = registeredProductionAdapters().find(
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
  const adapter = registeredProductionAdapters().find(
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

test("accessory detail traversal retains non-card evidence without publishing a Product", () => {
  const adapter = registeredProductionAdapters().find(
    ({ sourceLineage }) => sourceLineage === "fusion-world-en",
  );
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
  const discovered = adapter.discoverRequests(
    new TextEncoder().encode(index),
    {
      mediaType: "text/html",
      url: adapter.requestUrlForSurface("products"),
      requestId: "fusion-world-en:products",
    },
  );
  assert.ok(
    discovered.some(({ url }) => url.includes("/booster/fb-booster-01/")),
  );
  assert.equal(
    discovered.some(({ url }) => url.includes("/accessory/fb-box-01/")),
    false,
  );
  const observation = adapter.parseBytes(
    new TextEncoder().encode(`
      <h1>Storage Box</h1>
      <dl><dt>Product Code</dt><dd>FB-BOX-01</dd></dl>
    `),
    {
      mediaType: "text/html",
      url:
        "https://www.dbs-cardgame.com/fw/en/products/accessory/fb-box-01/",
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
  const adapter = registeredProductionAdapters().find(
    ({ sourceLineage }) => sourceLineage === "fusion-world-en",
  );
  const accessory = {
    productCode: "FB-SLEEVE-01",
    productName: "Official Storage Sleeves",
  };
  for (const surface of ["products", "card-search"]) {
    const payload = structuredClone(
      officialRawSurfacePayload(`/fusion-world-en/${surface}`),
    );
    if (surface === "products") {
      payload.result.partitions[0].entries = [accessory];
      payload.result.partitions[0].total = 1;
    } else {
      payload.products.push(accessory);
    }
    const observations = adapter.parseBytes(
      new TextEncoder().encode(
        `<html>${officialPublisherPayloadScript(
          "fusion-world-en",
          surface,
          payload,
        )}</html>`,
      ),
      {
        mediaType: "text/html; charset=utf-8",
        url: adapter.requestUrlForSurface(surface),
        requestId: `fusion-world-en:${surface}`,
      },
    );
    assert.equal(
      observations.flatMap(
        ({ product_release_catalogue }) =>
          product_release_catalogue.products,
      ).some(({ official_code }) => official_code === "FB-SLEEVE-01"),
      false,
    );
    assert.ok(
      observations.flatMap(
        ({ product_release_catalogue }) =>
          product_release_catalogue.distribution_contexts,
      ).some(
        ({ kind, label }) => kind === "other" && label === "accessory",
      ),
    );
  }
});

test("code-less structured Products and Releases retain name identity with valid event keys", () => {
  const adapter = registeredProductionAdapters().find(
    ({ sourceLineage }) => sourceLineage === "fusion-world-en",
  );
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
    const payload = structuredClone(
      officialRawSurfacePayload(`/fusion-world-en/${surface}`),
    );
    const partition = (surface === "products"
      ? payload.result
      : payload.events).partitions[0];
    partition.entries = surface === "products"
      ? [product]
      : [{ product, release }];
    partition.total = 1;
    const observations = adapter.parseBytes(
      new TextEncoder().encode(
        `<html>${officialPublisherPayloadScript(
          "fusion-world-en",
          surface,
          payload,
        )}</html>`,
      ),
      {
        mediaType: "text/html; charset=utf-8",
        url: adapter.requestUrlForSurface(surface),
        requestId: `fusion-world-en:${surface}`,
      },
    );
    const observed = observations.flatMap(
      ({ product_release_catalogue }) =>
        product_release_catalogue.products,
    );
    assert.deepEqual(
      observed.map(({ reference, official_code, name }) => ({
        reference,
        official_code,
        name,
      })),
      [{
        reference: {
          kind: "name",
          value: "Announced Product Without Code",
        },
        official_code: null,
        name: "Announced Product Without Code",
      }],
    );
    for (const { event_key } of observed.flatMap(({ releases }) => releases)) {
      assert.match(event_key, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u);
    }
  }
});

test("code-less named Products and Releases survive registered discovery surfaces", () => {
  const adapter = requiredSourceAdapter("fusion-world-en@3");
  const payload = structuredClone(
    officialRawSurfacePayload("/fusion-world-en/card-search"),
  );
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
  payload.detail_pages[0].product_names = [
    "Discovery Product Without Code",
  ];

  const observations = parseRegisteredSurface(
    adapter,
    "card-search",
    payload,
  );
  const product = observations
    .flatMap(({ product_release_catalogue }) =>
      product_release_catalogue.products
    )
    .find(({ name }) => name === "Discovery Product Without Code");

  assert.deepEqual(product, {
    reference: {
      kind: "name",
      value: "Discovery Product Without Code",
    },
    official_code: null,
    name: "Discovery Product Without Code",
    releases: [{
      event_key: "discovery-product-without-code",
      region: "EN-US",
      date: { precision: "unknown", value: null },
      status: "announced",
    }],
  });
});

test("code-less HTML Product announcements derive stable opaque event identities", () => {
  const adapter = registeredProductionAdapters().find(
    ({ sourceLineage }) => sourceLineage === "gundam-en-us",
  );
  const parse = () =>
    adapter.parseBytes(
      new TextEncoder().encode(`
        <h1>Future Product Without Code</h1>
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
  assert.match(
    first.releases[0].event_key,
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u,
  );
  assert.equal(first.releases[0].event_key.includes("Future Product"), false);
});

test("unavailable Product release vocabulary normalizes to reviewable unknown values", () => {
  const adapter = registeredProductionAdapters().find(
    ({ sourceLineage }) => sourceLineage === "gundam-en-us",
  );
  for (const dateToken of ["-", "TBA", ""]) {
    const observation = adapter.parseBytes(
      new TextEncoder().encode(`
        <h1>Future Booster</h1>
        <dl><dt>Product Code</dt><dd>GD-FUTURE</dd></dl>
        <dl><dt>Release Date</dt><dd>${dateToken}</dd></dl>
        <dl><dt>Status</dt><dd>TBA</dd></dl>
      `),
      {
        mediaType: "text/html",
        url: "https://www.gundam-gcg.com/en/products/future-booster/",
        requestId: `gundam-en-us:product_detail:${"b".repeat(64)}`,
      },
    )[0];
    assert.deepEqual(
      observation.product_release_catalogue.products[0].releases,
      [{
        event_key: "product-release:GD-FUTURE",
        region: "EN-US",
        date: { precision: "unknown", value: null },
        status: "announced",
      }],
    );
    assert.ok(
      observation.source_sidecar.unmapped_optional_fields.some(
        ({ path, value }) =>
          path.endsWith(".Release Date") && value === dateToken,
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
  const adapter = registeredProductionAdapters().find(
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
    registeredProductionAdapters().some(
      ({ adapterVersion }) =>
        adapterVersion === "one-piece-json-document@1",
    ),
    false,
  );
  const adapter = registeredProductionAdapters().find(
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
  for (const contract of registeredProductionAdapters()) {
    for (const surface of contract.requiredSurfaces) {
      const payload = rawSurfacePayload(contract.sourceLineage, surface);
      assert.equal(
        Object.hasOwn(payload, "contract"),
        false,
        "fixture must retain an upstream-shaped document, not a Keepr envelope",
      );
      const observations = parseRegisteredSurface(
        contract,
        surface,
        payload,
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
  const adapter = registeredProductionAdapters().find(
    ({ sourceLineage }) => sourceLineage === "one-piece-en",
  );
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
  assert.throws(
    () => parseRegisteredSurface(adapter, "card-list", mismatched),
    /card-list page identity/u,
  );
});

test("discovered Fusion facets require disjoint exact split-order leaves", () => {
  const adapter = registeredProductionAdapters().find(
    ({ sourceLineage }) => sourceLineage === "fusion-world-en",
  );
  const incomplete = rawSurfacePayload("fusion-world-en", "card-search");
  incomplete.result.partitions.pop();
  assert.throws(
    () => parseRegisteredSurface(adapter, "card-search", incomplete),
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
    () => parseRegisteredSurface(adapter, "card-search", incomplete),
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
    () => parseRegisteredSurface(adapter, "card-search", overlapping),
    /leaf partitions overlap/iu,
  );
});

function rawSurfacePayload(lineage, surface) {
  return structuredClone(
    officialRawSurfacePayload(`/${lineage}/${surface}`),
  );
}

function parseRegisteredSurface(adapter, surface, payload) {
  const completeDigimonLeaf =
    adapter.adapterVersion === "digimon-en@4" && surface === "card-list";
  return adapter.parseBytes(
    new TextEncoder().encode(
      `<html><title>BANDAI ${adapter.supportedGame} CARD PRODUCT RELEASE RULE ERRATA RESTRICTION</title>
       ${officialPublisherPayloadScript(
        adapter.sourceLineage,
        surface,
        payload,
      )}`,
    ),
    {
      mediaType: "text/html; charset=utf-8",
      url: completeDigimonLeaf
        ? `${adapter.requestUrlForSurface(surface)}&category=all&cardcategory=digimon&colour=blue`
        : adapter.requestUrlForSurface(surface),
      requestId: completeDigimonLeaf
        ? `digimon-en:listing:${"f".repeat(64)}`
        : `${adapter.sourceLineage}:${surface}`,
    },
  );
}
