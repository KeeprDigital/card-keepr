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
  adapterReconciliationAreas,
  assertAdapterBinding,
  installedSourceAdapterRegistrations,
  requiredActiveSourceAdapter,
  requiredLiveSourceAdapter,
  requiredSourceAdapter,
  sourceAdapterRegistrations,
} from "../src/catalogue/source-adapters.ts";
import {
  retiredSourceAdapterVersions,
} from "../src/catalogue/retired-source-adapter-versions.ts";
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
  // The restructured Fusion World EN contract drops "errata": the publisher
  // retired /fw/en/rules/errata-card/ and publishes no replacement.
  "fusion-world-en": [
    "card-search",
    "products",
    "releases",
    "legality-current",
    "legality-history",
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
    "card-list": "https://en.onepiece-cardgame.com/cardlist/?series=569116",
    products: "https://en.onepiece-cardgame.com/products/",
    releases: "https://en.onepiece-cardgame.com/products/",
    restrictions: "https://en.onepiece-cardgame.com/news/restriction.html",
    "block-policy": "https://en.onepiece-cardgame.com/topics/013.php",
    errata: "https://en.onepiece-cardgame.com/rules/errata_card/",
    "don-rules": "https://en.onepiece-cardgame.com/rules/",
  },
  "fusion-world-en": {
    "card-search":
      "https://www.dbs-cardgame.com/fw/en/cardlist/?search=true&category%5B0%5D=583301",
    products: "https://www.dbs-cardgame.com/fw/en/products/",
    releases: "https://www.dbs-cardgame.com/fw/en/products/",
    "legality-current": "https://www.dbs-cardgame.com/fw/en/news/01_305.html",
    "legality-history": "https://www.dbs-cardgame.com/fw/en/news/01_399.html",
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
    // Issue #58: the plan captures the linked current banned/restricted
    // publication directly; the /rules/ hub remains a discovery stage.
    legality: "https://www.gundam-gcg.com/asia-en/news/01_279.html",
    errata:
      "https://www.gundam-gcg.com/asia-en/news/?subcategory=news&tag=all&page=1",
  },
  "gundam-en-us": {
    packages: "https://www.gundam-gcg.com/en/cards/index.php",
    products: "https://www.gundam-gcg.com/en/products/list.php",
    releases: "https://www.gundam-gcg.com/en/products/list.php",
    legality: "https://www.gundam-gcg.com/en/news/01_279.html",
    errata:
      "https://www.gundam-gcg.com/en/news/?subcategory=news&tag=all&page=1",
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
    ["RULES", "/fw/en/news/01_31.html"],
  ],
  "digimon-en": [
    ["CARD LIST", "/cards/index.php?search=true"],
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

// The active registration per lineage. The issue-58 unresolved-scope
// generation advanced One Piece and both Gundam locales, the
// optional-card-field generation advanced Digimon, and the issue-63
// request-capacity generation advanced Fusion World: fusion-world-en@9
// parses byte-for-byte like fusion-world-en@8 and differs only in its
// immutable request capacity. Each lineage keeps exactly one parseable
// predecessor (ADR 0004).
const expectedProductionAdapterVersions = [
  "digimon-en@7",
  "fusion-world-en@9",
  "gundam-en-asia@7",
  "gundam-en-us@7",
  "one-piece-en@6",
];

test("the live Gundam adapters close package leaves by full locator", () => {
  for (const lineage of ["gundam-en-asia", "gundam-en-us"]) {
    const current = requiredSourceAdapter(`${lineage}@7`);
    const payload = rawSurfacePayload(lineage, "packages");

    const complete = structuredClone(payload);
    const detail = complete.card_details[0];
    delete detail.artwork_fingerprint;
    delete detail.printed_fields_digest;
    delete detail.printing.normalized_rarity;
    complete.package_options = [
      { value: "gd01", label: "GD01" },
      { value: "starter", label: "Starter decks" },
    ];
    const entry = complete.result.partitions[0].entries[0];
    complete.result.partitions = ["gd01", "starter"].map((name) => ({
      bucket: `package=${name}`,
      page: 1,
      pages: 1,
      total: 1,
      has_next: false,
      entries: [structuredClone(entry)],
    }));

    const observations = parseRegisteredSurface(current, "packages", complete);
    assert.equal(
      observations.filter(({ card }) => card !== undefined).length,
      1,
      "the same full locator is deterministically deduplicated across packages",
    );
    assert.equal(observations[0].printing.rarity.raw, "R");
    assert.equal(observations[0].printing.rarity.normalized, "rare");
    assert.match(
      observations[0].identity_evidence.artwork_fingerprint,
      /^official-artwork:/u,
    );
    assert.match(
      observations[0].identity_evidence.printed_fields_digest,
      /^printed-material:/u,
    );
    assert.throws(
      () => current.parseBytes(
        new TextEncoder().encode(
          `<html>${officialPublisherPayloadScript(
            lineage,
            "packages",
            complete,
          )}</html>`,
        ),
        {
          mediaType: "text/html",
          url: current.requestUrlForSurface("packages"),
          requestId: `${lineage}:packages`,
        },
      ),
      /Gundam catalogue facts require an exact package leaf/iu,
    );

    const conflicting = structuredClone(complete);
    conflicting.result.partitions[1].entries[0].number = "GD99-999";
    assert.throws(
      () => parseRegisteredSurface(current, "packages", conflicting),
      /full locator.*conflict/iu,
    );
    const unknownRarity = structuredClone(complete);
    unknownRarity.card_details[0].printing.rarity = "Experimental Rare";
    assert.throws(
      () => parseRegisteredSurface(current, "packages", unknownRarity),
      /Gundam rarity.*Experimental Rare/iu,
    );
  }
});

test("the live Digimon adapter normalizes exact standalone Official Errata", () => {
  const adapter = requiredSourceAdapter("digimon-en@7");
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

  payload.entries[0].future_target_scope = "Only alternate-art printings";
  assert.throws(
    () => adapter.parseBytes(
      Buffer.from(
        `<html>${officialPublisherPayloadScript("digimon-en", "errata", payload)}</html>`,
      ),
      {
        mediaType: "text/html",
        url: adapter.requestUrlForSurface("errata"),
        requestId: "digimon-en:errata",
      },
    ),
    /Digimon Official Erratum.*unknown field future_target_scope/iu,
  );
});

test("the live Digimon adapter preserves a standalone Official Erratum that explicitly removes Effective Rules Text", () => {
  const adapter = requiredSourceAdapter("digimon-en@7");
  const payload = officialRawSurfacePayload("/digimon-en/errata");
  payload.declared_record_count = 1;
  payload.partition.total = 1;
  payload.entries = [{
    card_number: "BT99-001",
    published_on: "2026-07-01",
    effective_from: "2026-07-01",
    observed_printed_rules_text: "Printed effect before removal.",
    corrected_rules_text: null,
    official_wording: "Remove the printed effect from this Card.",
    applies_to_parallel_printings: true,
    source_fragment: "#BT99-001",
    display_name: "BT99-001 Erratum",
    image_url: "https://world.digimoncard.com/images/cardlist/card/BT99-001.png",
  }];

  const observations = adapter.parseBytes(
    Buffer.from(
      `<html>${officialPublisherPayloadScript("digimon-en", "errata", payload)}</html>`,
    ),
    {
      mediaType: "text/html",
      url: adapter.requestUrlForSurface("errata"),
      requestId: "digimon-en:errata",
    },
  );
  assert.deepEqual(
    observations.filter(({ kind }) => kind === "official_erratum")
      .map(({ corrected_rules_text }) => corrected_rules_text),
    [null],
  );
});

test("the synthetic Digimon Worker isolates sequential and concurrent request scenarios", async () => {
  const rootUrl =
    "https://world.digimoncard.com/cards/index.php?search=true";
  const errataUrl = "https://world.digimoncard.com/rule/errata_card/";
  const responseText = async (url, userAgent) =>
    await (await syntheticOfficialSource.fetch(new Request(url, {
      headers: { "user-agent": userAgent },
    }))).text();

  await responseText(
    rootUrl,
    "card-keepr-acceptance-digimon/complete; request-role=surface; request-surface=card-list",
  );
  const unmarked = await responseText(
    errataUrl,
    "card-keepr-official-source/1; request-role=surface; request-surface=errata",
  );
  assert.doesNotMatch(
    unmarked,
    /Remove the printed effect/u,
    "an unmarked request must not inherit an earlier request scenario",
  );

  const [complete, absent] = await Promise.all([
    responseText(
      errataUrl,
      "card-keepr-acceptance-digimon/complete; request-role=surface; request-surface=errata",
    ),
    responseText(
      errataUrl,
      "card-keepr-acceptance-digimon/complete-no-errata; request-role=surface; request-surface=errata",
    ),
  ]);
  assert.match(complete, /Remove the printed effect/u);
  assert.doesNotMatch(absent, /Remove the printed effect/u);
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
  // 08-02 to 08-07 captured the restructured generation; 08-11 captured the
  // optional-card-field pages (Fusion Energy Markers, Digimon nested Q&A);
  // 08-12 captured the fusion live-shape pages (anchored product status
  // sections, errata-annotated details, the season Release, and the
  // legality-history restriction lift).
  assert.match(metadata.retrieved_at, /^2026-08-(?:0[2-7]|1[12])T/u);
  return { bytes, metadata };
}

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
  const adapter = requiredSourceAdapter("one-piece-en@6");
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
  const adapter = requiredSourceAdapter("fusion-world-en@9");
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
  const adapter = requiredSourceAdapter("digimon-en@7");
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

test("issue-58 Gundam adapters parse the retained compound policy into explicit unresolved rules", () => {
  const openPredicateReason =
    'The published description "a Unit card that is Lv.2 with cost 1, 2 AP, and 2 HP, and without effects" includes future printings; its complete matching-card scope and effective interval are not stated.';
  for (const descriptor of [
    {
      adapter: "gundam-en-asia@7",
      slug: "gundam-en-asia-policy-detail",
      lineage: "gundam-en-asia",
      region: "EN-ASIA",
    },
    {
      adapter: "gundam-en-us@7",
      slug: "gundam-en-us-policy-detail",
      lineage: "gundam-en-us",
      region: "EN-US",
    },
  ]) {
    const adapter = requiredSourceAdapter(descriptor.adapter);
    assert.equal(
      adapter.requestUrlForSurface("legality"),
      retainedOfficialSourceFixture(descriptor.slug).metadata.source_url,
    );
    const rules = retainedLegalityRules(
      adapter,
      "legality",
      descriptor.slug,
      { requestId: `${descriptor.lineage}:legality` },
    );
    assert.equal(rules.length, 5);
    assert.ok(rules.every((rule) =>
      rule.region === descriptor.region &&
      rule.effective_from === null &&
      rule.effect.type === "unresolved" &&
      rule.unresolved_scope.dimensions.includes("effective_interval")
    ));
    assert.deepEqual(
      rules.slice(0, 4).map((rule) => rule.card_numbers),
      [
        ["GD01-020"],
        ["ST02-016"],
        ["ST01-010", "ST05-010"],
        ["GD01-008", "GD05-015"],
      ],
    );
    const openPredicate = rules[4];
    assert.equal(openPredicate.id, "01_279-current-open-predicate");
    assert.deepEqual(openPredicate.unresolved_scope, {
      dimensions: ["effective_interval", "target_scope"],
    });
    assert.equal(openPredicate.card_numbers.length, 20);
    assert.equal(openPredicate.card_numbers[0], "GD01-035");
    assert.equal(openPredicate.card_numbers.at(-1), "ST10-005");
    assert.equal(openPredicate.effect.reason, openPredicateReason);
    assert.match(
      openPredicate.official_wording,
      /^All combinations of cards that match the above description/u,
    );
  }
});

test("the issue-58 One Piece don-rules contract retains the live hub as coverage without DON payload", () => {
  const adapter = requiredSourceAdapter("one-piece-en@6");
  const fixture = retainedOfficialSourceFixture("one-piece-en-don-rules-hub");
  const observations = adapter.parseBytes(fixture.bytes, {
    mediaType: fixture.metadata.content_type,
    url: fixture.metadata.source_url,
    requestId: "one-piece-en:don-rules",
  });
  assert.equal(observations.length, 2);
  const [coverage, legality] = observations;
  assert.deepEqual(coverage.completeness, {
    structurally_complete: true,
    required_surfaces_complete: true,
    partitions_complete: true,
    declared_record_count: 76,
    parsed_record_count: 76,
  });
  const retained = coverage.source_sidecar.raw.official_surfaces[0].document;
  assert.equal(
    retained.document_title,
    "RULES｜ONE PIECE CARD GAME - Official Web Site",
  );
  for (const pinned of [
    "https://en.onepiece-cardgame.com/news/restriction.html",
    "https://en.onepiece-cardgame.com/topics/013.php",
    "https://en.onepiece-cardgame.com/rules/errata_card/",
  ]) {
    assert.ok(
      retained.navigation_links.some(({ url }) => url === pinned),
      `retained hub evidence keeps ${pinned}`,
    );
  }
  assert.equal(legality.observation_type, "legality_rules");
  assert.deepEqual(legality.legality_rules, []);
  assert.equal(legality.completeness.declared_record_count, 0);

  // The earlier generation keeps its frozen fail-closed contract.
  assert.throws(
    () =>
      requiredSourceAdapter("one-piece-en@5").parseBytes(fixture.bytes, {
        mediaType: fixture.metadata.content_type,
        url: fixture.metadata.source_url,
        requestId: "one-piece-en:don-rules",
      }),
    /DON!! Card facts require explicit snapshot evidence/u,
  );
});

test("retained live policy roots schedule the exact current detail publications", () => {
  const fusion = requiredSourceAdapter("fusion-world-en@9");
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
    { adapter: "gundam-en-asia@7", slug: "gundam-en-asia-policy", locale: "asia-en" },
    { adapter: "gundam-en-us@7", slug: "gundam-en-us-policy", locale: "en" },
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
  const fusion = requiredSourceAdapter("fusion-world-en@9");
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

  const digimon = requiredSourceAdapter("digimon-en@7");
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

test("retained live policy parsers reject tag-agnostic residual conditions", () => {
  const cases = [
    {
      adapter: "one-piece-en@6",
      slug: "one-piece-en-policy",
      surface: "restrictions",
      requestId: "one-piece-en:restrictions",
      wording: "The following card(s) cannot be included in any deck.",
    },
    {
      adapter: "fusion-world-en@9",
      slug: "fusion-world-en-policy-detail",
      surface: "detail",
      requestId: `fusion-world-en:detail:${"d".repeat(64)}`,
      wording: "No copies of the card are permitted in the deck.",
    },
    {
      adapter: "digimon-en@7",
      slug: "digimon-en-policy",
      surface: "restrictions-current",
      requestId: "digimon-en:restrictions-current",
      wording: "Restricted Cards (1) - Decks can only include one copy of these cards.",
    },
    {
      adapter: "gundam-en-us@7",
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
      adapter: "one-piece-en@6",
      slug: "one-piece-en-policy",
      requestId: "one-piece-en:restrictions",
      anchor: "The following card(s) cannot be included in any deck.",
    },
    {
      adapter: "fusion-world-en@9",
      slug: "fusion-world-en-policy-detail",
      requestId: `fusion-world-en:detail:${"c".repeat(64)}`,
      anchor: "No copies of the card are permitted in the deck.",
    },
    {
      adapter: "digimon-en@7",
      slug: "digimon-en-policy",
      requestId: "digimon-en:restrictions-current",
      anchor:
        "Restricted Cards (1) - Decks can only include one copy of these cards.",
    },
    {
      adapter: "gundam-en-us@7",
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
  const adapter = requiredSourceAdapter("fusion-world-en@9");
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
  const adapter = requiredSourceAdapter("fusion-world-en@9");
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
      adapter: "one-piece-en@6",
      slug: "one-piece-en-policy",
      requestId: "one-piece-en:restrictions",
      anchor: "<h4>Banned Cards</h4>",
    },
    {
      adapter: "digimon-en@7",
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
  const adapter = requiredSourceAdapter("fusion-world-en@9");
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
    // The publisher retired the Fusion World errata surface, so the rules
    // stage now closes on its two legality publications alone.
    ["legality-current", "legality-history"],
  );
});

test("registered Fusion policy collection identities parse their retained current and history bytes", async () => {
  const adapter = requiredSourceAdapter("fusion-world-en@9");
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
  const adapter = requiredSourceAdapter("one-piece-en@6");
  const url = "https://en.onepiece-cardgame.com/cardlist/";
  // The retained discovery root now lives behind the publisher's series
  // redirect; staged listing requests must never be answered with it.
  const rootUrl = "https://en.onepiece-cardgame.com/cardlist/?series=569116";
  for (const failure of ["cap", "pagination"]) {
    const marker = `card-keepr-acceptance-parser/${failure}`;
    const responseForRole = (role) => syntheticOfficialSource.fetch(
      new Request(role === null ? rootUrl : url, {
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
  const adapter = requiredSourceAdapter("digimon-en@7");
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
  const adapter = requiredSourceAdapter("fusion-world-en@9");
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
  const adapter = requiredSourceAdapter("fusion-world-en@9");
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
    assert.deepEqual(
      adapter.reconciliationAreas,
      // Fusion World's restructured contract owns no errata surface, so it
      // reconciles catalogue evidence alone.
      adapter.adapterVersion === "fusion-world-en@9"
        ? ["catalogue"]
        : ["catalogue", "errata"],
    );
    assert.equal(
      adapter.gameProfileVersion,
      `${adapter.supportedGame}@1`,
    );
    // After the issue-58 and optional-card-field generations, every active
    // lineage declares the @6 parser contract; the fusion live-shape
    // generation advances its lineage to @7.
    assert.equal(
      adapter.parserContract,
      adapter.sourceLineage === "fusion-world-en"
        ? "fusion-world-en-restructured-complete-catalogue@7"
        : `${adapter.sourceLineage}-restructured-complete-catalogue@6`,
    );
    assert.match(
      adapter.parserContract,
      /-restructured-complete-catalogue@[67]$/u,
    );
    assert.equal(typeof adapter.parseBytes, "function");
    assert.deepEqual(
      adapter.requiredSurfaces,
      expectedSurfaces[adapter.sourceLineage],
    );
    assert.deepEqual(
      Object.fromEntries(adapter.requiredSurfaces.map((surface) => [
        surface,
        adapter.requestUrlForSurface(surface),
      ])),
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
      discoveryRecords.every(({ url, discovered_from }) =>
        retainedHtml.includes(discovered_from.resolution) ||
        url === requests[0].url
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
    validDetailUrl.searchParams.set(
      "detailSearch",
      adapter.sourceLineage === "fusion-world-en" ? "FB99-001_p2" : "CK30",
    );
    const validDetail = validDetailUrl.href;
    const hostileOrigin = new URL(validDetail);
    hostileOrigin.hostname = `assets.${root.hostname}`;
    const hostilePath = new URL(validDetail);
    hostilePath.pathname = adapter.sourceLineage === "gundam-en-asia"
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
        requestId: fusionLeaf || gundamLeaf
          ? `${adapter.sourceLineage}:listing:${"6".repeat(64)}`
          : `${adapter.sourceLineage}:${adapter.requiredSurfaces[0]}`,
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
  const adapter = requiredSourceAdapter("one-piece-en@6");
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

// ADR 0004: superseded parser code is retired. Every retired Source Adapter
// Version keeps its registration identity, lineage, and immutable parser
// contract so retained evidence stays attributable, but carries no parser
// and can neither capture nor parse.
const expectedRetiredParserContracts = {
  "one-piece-en@1": "one-piece-en-raw-surfaces@1",
  "one-piece-en@2": "one-piece-en-raw-surfaces-with-legality@2",
  "one-piece-en@3": "one-piece-en-complete-catalogue@3",
  "one-piece-en@4": "one-piece-en-restructured-complete-catalogue@4",
  "fusion-world-en@2": "fusion-world-en-raw-surfaces@1",
  "fusion-world-en@3": "fusion-world-en-raw-surfaces-with-legality@2",
  "fusion-world-en@4":
    "fusion-world-en-raw-surfaces-with-legality-and-catalogue@3",
  "fusion-world-en@5": "fusion-world-en-restructured-complete-catalogue@4",
  "fusion-world-en@6": "fusion-world-en-restructured-complete-catalogue@5",
  "fusion-world-en@7": "fusion-world-en-restructured-complete-catalogue@6",
  "digimon-en@2": "digimon-en-raw-surfaces@1",
  "digimon-en@3": "digimon-en-raw-surfaces-with-legality@2",
  "digimon-en@4": "digimon-en-raw-surfaces-complete-catalogue@3",
  "digimon-en@5": "digimon-en-restructured-complete-catalogue@4",
  "gundam-en-asia@2": "gundam-en-asia-raw-surfaces@1",
  "gundam-en-asia@3": "gundam-en-asia-raw-surfaces-with-legality@2",
  "gundam-en-asia@4": "gundam-en-asia-raw-surfaces-complete-catalogue@3",
  "gundam-en-asia@5": "gundam-en-asia-restructured-complete-catalogue@4",
  "gundam-en-us@2": "gundam-en-us-raw-surfaces@1",
  "gundam-en-us@3": "gundam-en-us-raw-surfaces-with-legality@2",
  "gundam-en-us@4": "gundam-en-us-raw-surfaces-complete-catalogue@3",
  "gundam-en-us@5": "gundam-en-us-restructured-complete-catalogue@4",
};

const expectedRetiredLegalityRegions = {
  "one-piece-en": "EN-OCEANIA",
  "fusion-world-en": "EN-OCEANIA",
  "digimon-en": "EN-OCEANIA",
  "gundam-en-asia": "EN-ASIA",
  "gundam-en-us": "EN-US",
};

const expectedErrataCoveredRetiredVersions = [
  "one-piece-en@3",
  "one-piece-en@4",
  "fusion-world-en@4",
  "digimon-en@4",
  "digimon-en@5",
  "gundam-en-asia@4",
  "gundam-en-asia@5",
  "gundam-en-us@4",
  "gundam-en-us@5",
];

const expectedHeaderInheritingRetiredVersions = [
  "digimon-en@4",
  "digimon-en@5",
  "gundam-en-asia@4",
  "gundam-en-asia@5",
  "gundam-en-us@4",
  "gundam-en-us@5",
];

function isAdministrationProblem(code) {
  return (error) => error.status === 422 && error.code === code;
}

test("retired production adapter versions stay registered without a parser", () => {
  assert.deepEqual(
    retiredSourceAdapterVersions.map(({ adapterVersion }) => adapterVersion)
      .sort(),
    Object.keys(expectedRetiredParserContracts).sort(),
  );
  for (
    const [adapterVersion, parserContract] of Object.entries(
      expectedRetiredParserContracts,
    )
  ) {
    const adapter = requiredSourceAdapter(adapterVersion);
    assert.equal(adapter.retired, true, adapterVersion);
    assert.equal(adapter.adapterVersion, adapterVersion);
    assert.equal(adapter.parserContract, parserContract);
    assert.equal(adapter.sourceLineage, adapterVersion.replace(/@\d+$/u, ""));
    assert.equal(adapter.gameProfileVersion, `${adapter.supportedGame}@1`);
    assert.equal(adapter.origin, "production");
    assert.deepEqual(adapter.requestSurface, { kind: "credential-free-https" });
    assert.equal(adapter.reconciliationCapability, "catalogue");
    assert.equal(
      adapter.legalityRegion,
      expectedRetiredLegalityRegions[adapter.sourceLineage],
    );
    assert.ok(Number.isSafeInteger(adapter.requestCapacity));
    assert.ok(Number.isSafeInteger(adapter.maximumSnapshotBytes));
    for (
      const retiredMember of [
        "parse",
        "parseBytes",
        "discoverRequests",
        "requiredSurfaces",
        "requestUrlForDiscovery",
        "requestUrlForSurface",
        "officialSourceContract",
      ]
    ) {
      assert.equal(adapter[retiredMember], undefined, `${adapterVersion} ${retiredMember}`);
    }
    assert.deepEqual(
      adapterReconciliationAreas(adapter),
      expectedErrataCoveredRetiredVersions.includes(adapterVersion)
        ? ["catalogue", "errata"]
        : ["catalogue"],
      adapterVersion,
    );
    assert.equal(
      adapter.inheritDiscoveryRequestHeaders,
      expectedHeaderInheritingRetiredVersions.includes(adapterVersion),
      adapterVersion,
    );
    assert.ok(installedSourceAdapterRegistrations.includes(adapter));
    assert.ok(!sourceAdapterRegistrations.includes(adapter));
    assert.ok(!productionAdapterVersions.includes(adapterVersion));
    assert.throws(
      () => requiredActiveSourceAdapter(adapterVersion),
      isAdministrationProblem("adapter_version_retired"),
      adapterVersion,
    );
    assert.throws(
      () => requiredLiveSourceAdapter(adapterVersion),
      isAdministrationProblem("adapter_version_retired"),
      adapterVersion,
    );
  }
  for (const adapter of installedSourceAdapterRegistrations) {
    if (adapter.retired === true) {
      assert.ok(
        Object.hasOwn(expectedRetiredParserContracts, adapter.adapterVersion),
        `${adapter.adapterVersion} is retired but not expected to be`,
      );
      continue;
    }
    assert.equal(adapter.retired, undefined);
    assert.equal(requiredLiveSourceAdapter(adapter.adapterVersion), adapter);
    assert.equal(
      typeof adapter.parseBytes === "function" ||
        typeof adapter.parse === "function",
      true,
      adapter.adapterVersion,
    );
  }
  assert.throws(
    () => requiredActiveSourceAdapter("one-piece-en@999"),
    isAdministrationProblem("adapter_not_supported"),
  );
  assert.throws(
    () => requiredLiveSourceAdapter("one-piece-en@999"),
    isAdministrationProblem("adapter_not_supported"),
  );
});

test("one-piece-en@4 resolves as a retired registration and is refused for new collection", () => {
  const adapter = requiredSourceAdapter("one-piece-en@4");
  assert.equal(
    adapter.parserContract,
    "one-piece-en-restructured-complete-catalogue@4",
  );
  assert.equal(adapter.retired, true);
  assert.equal(adapter.parseBytes, undefined);
  assert.throws(
    () => requiredActiveSourceAdapter("one-piece-en@4"),
    (error) =>
      error.status === 422 &&
      error.code === "adapter_version_retired" &&
      /one-piece-en@4/u.test(error.message) &&
      /ADR 0004/u.test(error.message),
  );
});

test("the retired-adapter pre-merge query names exactly the retired versions", () => {
  const sql = readFileSync(
    new URL("../scripts/retired-adapter-runs.sql", import.meta.url),
    "utf8",
  );
  const quoted = [...sql.matchAll(/'([a-z0-9-]+@\d+)'/gu)].map(
    ([, adapterVersion]) => adapterVersion,
  );
  assert.deepEqual(
    quoted,
    retiredSourceAdapterVersions.map(({ adapterVersion }) => adapterVersion),
  );
  assert.match(sql, /run\.state NOT IN \('published', 'rejected', 'expired', 'failed'\)/u);
  assert.match(sql, /FROM ingestion_evidence_plans AS plan/u);
  assert.match(sql, /JOIN ingestion_runs AS run ON run\.id = plan\.ingestion_run_id/u);
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
  const current = requiredSourceAdapter("fusion-world-en@9");
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
  const current = requiredSourceAdapter("fusion-world-en@9");
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
  const current = requiredSourceAdapter("fusion-world-en@9");
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
  const current = requiredSourceAdapter("fusion-world-en@9");
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
  const current = requiredSourceAdapter("fusion-world-en@9");
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
  const current = requiredSourceAdapter("fusion-world-en@9");
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
  const current = requiredSourceAdapter("fusion-world-en@9");
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
  const current = requiredSourceAdapter("fusion-world-en@9");
  const legality = current.parseBytes(
    new TextEncoder().encode(exactFusionLegalityHtml),
    fusionLegalityContext(current),
  ).find(({ observation_type }) => observation_type === "legality_rules");
  assert.equal(legality.legality_rules.length, 2);
  assert.equal(legality.completeness.parsed_record_count, 2);
});

test("current production legality parser retains a truthful empty publication", () => {
  const current = requiredSourceAdapter("fusion-world-en@9");
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
  const current = requiredSourceAdapter("fusion-world-en@9");
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
  const current = requiredSourceAdapter("fusion-world-en@9");
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
  const current = requiredSourceAdapter("fusion-world-en@9");
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
  const current = requiredSourceAdapter("fusion-world-en@9");
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
  const current = requiredSourceAdapter("fusion-world-en@9");
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
  const current = requiredSourceAdapter("fusion-world-en@9");
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
  const current = requiredSourceAdapter("fusion-world-en@9");
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
      adapter: "one-piece-en@6",
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
      adapter: "fusion-world-en@9",
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
      adapter: "digimon-en@7",
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
      ["gundam-en-asia@7", "gundam-en-asia", "GD30-001", "EN-ASIA", "EN-US"],
      ["gundam-en-us@7", "gundam-en-us", "GD30-001", "EN-US", "EN-ASIA"],
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
  const current = requiredSourceAdapter("fusion-world-en@9");
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
  const current = requiredSourceAdapter("fusion-world-en@9");
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
  const current = requiredSourceAdapter("fusion-world-en@9");
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
  const current = requiredSourceAdapter("fusion-world-en@9");
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
  const current = requiredSourceAdapter("fusion-world-en@9");
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
  const current = requiredSourceAdapter("one-piece-en@6");
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
  const adapter = requiredSourceAdapter("one-piece-en@6");
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

test("current production legality parser fails closed for loose unknown rule markup", () => {
  const current = requiredSourceAdapter("fusion-world-en@9");
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
  const observations = adapter.parseBytes(
    bytes,
    {
      mediaType: "text/html; charset=utf-8",
      url: adapter.requestUrlForSurface("card-list"),
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
  // A pinned Recording leaf owns its membership: the bucket follows the
  // requested series rather than the printed Card Set label.
  assert.deepEqual(
    observations[0].memberships.source_buckets,
    ["recording:569116"],
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
    Object.hasOwn(
      observations[0].printing.game_data.attributes,
      "illustration_types",
    ),
    false,
  );
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
        .replaceAll(
          "OP99-001.png",
          "unrelated-distribution-filename.webp?width=2048&encoding=next",
        )
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
    new TextEncoder().encode(
      html.replace(' data-artwork-id="op99-001-standard-art"', ""),
    ),
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
        '<div class="treatment"><h3>Treatment</h3>Textured Foil</div>' +
          '<div class="getInfo"><h3>Card Set(s)</h3>',
      ),
    ),
    {
      mediaType: "text/html; charset=utf-8",
      url: cardListUrl,
    },
  )[0];
  assert.equal(unfamiliarTreatment.identity_evidence.treatment, null);
  assert.ok(
    unfamiliarTreatment.source_sidecar.unmapped_optional_fields.some(
      ({ value }) => value === "Textured Foil",
    ),
  );
  const unfamiliarLabel = adapter.parseBytes(
    new TextEncoder().encode(
      html.replace(
        '<div class="getInfo"><h3>Card Set(s)</h3>',
        '<div><h3>New Optional Label</h3>Preserve me</div>' +
          '<div class="getInfo"><h3>Card Set(s)</h3>',
      ),
    ),
    {
      mediaType: "text/html; charset=utf-8",
      url: cardListUrl,
    },
  )[0];
  assert.ok(
    unfamiliarLabel.source_sidecar.raw.official_surfaces[0].document
      .raw_label_pairs.some(({ label, value }) =>
        label === "New Optional Label" && value === "Preserve me"
      ),
  );
  assert.ok(unfamiliarLabel.source_sidecar.unmapped_optional_fields.some(
    ({ value }) => value === "Preserve me"
  ));
  assert.throws(
    () => adapter.parseBytes(
      new TextEncoder().encode(
        html.replace(
          "| <span>L</span> |",
          "| <span>Experimental Rare</span> |",
        ),
      ),
      {
        mediaType: "text/html; charset=utf-8",
        url: cardListUrl,
      },
    ),
    /One Piece rarity.*Experimental Rare|Experimental Rare.*rarity/iu,
  );
  assert.throws(
    () => adapter.parseBytes(
      new TextEncoder().encode(
        html.replace(
          '<div class="cost"><h3>Life</h3>5</div>',
          '<div class="cost"><h3>Life</h3>5</div>' +
            '<div><h3>Cost</h3>1</div>',
        ),
      ),
      {
        mediaType: "text/html; charset=utf-8",
        url: cardListUrl,
      },
    ),
    /Leader.*cost.*null/iu,
  );
  const recordingLeaf = requiredSourceAdapter("one-piece-en@6")
    .parseBytes(bytes, {
      mediaType: "text/html; charset=utf-8",
      url: "https://en.onepiece-cardgame.com/cardlist/?recording=569114",
      requestId: "one-piece-en:card-list",
    });
  assert.deepEqual(recordingLeaf[0].memberships.source_buckets, [
    "card-set:Test Set [OP99]",
  ]);
  const expandedRecording = adapter.parseBytes(bytes, {
    mediaType: "text/html; charset=utf-8",
    url: "https://en.onepiece-cardgame.com/cardlist/?series=569114",
    requestId: `one-piece-en:listing:${"b".repeat(64)}`,
  });
  assert.deepEqual(expandedRecording[0].memberships.source_buckets, [
    "recording:569114",
  ]);
  assert.ok(
    adapter.discoverRequests(bytes, {
      mediaType: "text/html; charset=utf-8",
      url: cardListUrl,
      requestId: "one-piece-en:card-list",
    }).some(({ role, url }) =>
      role === "listing" &&
      new URL(url).searchParams.get("series") === "569114"
    ),
  );
});

test("generic Schema.org Dataset payloads cannot enter production adapters", () => {
  const adapter = requiredSourceAdapter("one-piece-en@6");
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
  payload.card_pages.forEach((card) => {
    delete card.artwork_fingerprint;
    delete card.printed_fields_digest;
  });
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
  assert.match(
    observation.identity_evidence.printed_fields_digest,
    /printed-material:.*OP99-001/u,
  );
});

test("the expanded One Piece adapter emits exact typed Errata and rejects unrepresentable entries", () => {
  const adapter = requiredSourceAdapter("one-piece-en@6");
  const payload = officialRawSurfacePayload("/one-piece-en/errata");
  payload.declared_record_count = 1;
  payload.partition.total = 1;
  payload.entries = [{
    notice_id: "errata-op31-001",
    card_number: "OP31-001",
    card_name: "Complete One Piece Leader",
    published_on: "2026-08-01",
    effective_from: null,
    before_text: "Give up to 1 rested DON!! card to this Leader.",
    after_text: "Give up to 2 rested DON!! cards to this Leader.",
    note: "This correction applies in every game format.",
    applies_to_parallel_printings: true,
    image_url:
      "https://en.onepiece-cardgame.com/images/cardlist/card/OP31-001.png",
  }];
  const observations = adapter.parseBytes(
    new TextEncoder().encode(`<html>${officialPublisherPayloadScript(
      "one-piece-en",
      "errata",
      payload,
    )}</html>`),
    {
      mediaType: "text/html; charset=utf-8",
      url: adapter.requestUrlForSurface("errata"),
      requestId: "one-piece-en:errata",
    },
  );
  const erratum = observations.find(({ kind }) => kind === "official_erratum");
  assert.deepEqual(erratum, {
    kind: "official_erratum",
    game: "one-piece",
    target: {
      type: "card",
      official_identity: { kind: "card_number", value: "OP31-001" },
    },
    published_on: "2026-08-01",
    effective_from: null,
    observed_printed_rules_text:
      "Give up to 1 rested DON!! card to this Leader.",
    corrected_rules_text:
      "Give up to 2 rested DON!! cards to this Leader.",
    official_wording:
      "Note: This correction applies in every game format.\n" +
      "Before: Give up to 1 rested DON!! card to this Leader.\n" +
      "After: Give up to 2 rested DON!! cards to this Leader.",
    applies_to_parallel_printings: true,
    source: {
      fragment: "#errata-op31-001",
      display_name: "OP31-001 Complete One Piece Leader",
      image_url:
        "https://en.onepiece-cardgame.com/images/cardlist/card/OP31-001.png",
    },
    completeness: {
      structurally_complete: true,
      required_surfaces_complete: true,
      partitions_complete: true,
      declared_record_count: 1,
      parsed_record_count: 1,
    },
  });

  const arbitrary = structuredClone(payload);
  arbitrary.entries = [{ publisher_note: "Apply an unknown correction." }];
  assert.throws(
    () => adapter.parseBytes(
      new TextEncoder().encode(`<html>${officialPublisherPayloadScript(
        "one-piece-en",
        "errata",
        arbitrary,
      )}</html>`),
      {
        mediaType: "text/html; charset=utf-8",
        url: adapter.requestUrlForSurface("errata"),
        requestId: "one-piece-en:errata",
      },
    ),
    /Erratum.*undeclared field|Erratum.*publisher_note/iu,
  );
});

test("the expanded One Piece adapter rejects identity digests nested under Printing", () => {
  const adapter = requiredSourceAdapter("one-piece-en@6");
  for (const field of ["artwork_fingerprint", "printed_fields_digest"]) {
    const payload = officialRawSurfacePayload("/one-piece-en/card-list");
    for (const card of payload.card_pages) {
      delete card.artwork_fingerprint;
      delete card.printed_fields_digest;
    }
    payload.card_pages[0].printing[field] = `publisher-supplied-${field}`;
    assert.throws(
      () => adapter.parseBytes(
        new TextEncoder().encode(`<html>${officialPublisherPayloadScript(
          "one-piece-en",
          "card-list",
          payload,
        )}</html>`),
        {
          mediaType: "text/html; charset=utf-8",
          url: adapter.requestUrlForSurface("card-list"),
          requestId: "one-piece-en:card-list",
        },
      ),
      new RegExp(`identity digest|${field}`, "iu"),
    );
  }
});

test("the expanded One Piece adapter closes the nested DON Card policy schema", () => {
  const adapter = requiredSourceAdapter("one-piece-en@6");
  const payload = officialRawSurfacePayload("/one-piece-en/don-rules");
  payload.don_card = {
    functional_designation: "DON!!",
    name: "DON!! Card",
    Category: "DON!! Card",
    Effect: "A rules-level resource Card.",
    publisher_note: "Apply an unknown DON rule.",
  };
  assert.throws(
    () => adapter.parseBytes(
      new TextEncoder().encode(`<html>${officialPublisherPayloadScript(
        "one-piece-en",
        "don-rules",
        payload,
      )}</html>`),
      {
        mediaType: "text/html; charset=utf-8",
        url: adapter.requestUrlForSurface("don-rules"),
        requestId: "one-piece-en:don-rules",
      },
    ),
    /DON.*undeclared field|DON.*publisher_note/iu,
  );
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
  const fusionRoot = fusion.discoverRequests(
    encode(fusionCategories("583301", "583302", "583303")),
    {
      mediaType: "text/html",
      url: fusion.requestUrlForSurface("card-search"),
      requestId: "fusion-world-en:card-search",
    },
  ).filter(({ role }) => role === "listing");
  assert.deepEqual(
    fusionRoot.map(({ url }) => new URL(url).searchParams.toString()),
    [
      "search=true&category%5B0%5D=583302",
      "search=true&category%5B0%5D=583303",
    ],
  );
  const fusionSibling = fusion.discoverRequests(
    encode(fusionCategories("583301", "583302", "583303")),
    {
      mediaType: "text/html",
      url:
        "https://www.dbs-cardgame.com/fw/en/cardlist/?search=true&category%5B0%5D=583302",
      requestId: `fusion-world-en:listing:${"a".repeat(64)}`,
    },
  ).filter(({ role }) => role === "listing");
  assert.deepEqual(
    fusionSibling.map(({ url }) => new URL(url).searchParams.toString()),
    [
      "search=true&category%5B0%5D=583301",
      "search=true&category%5B0%5D=583303",
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
    })
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

test("retained Gundam package snapshots close publisher totals and dedupe full locators across the request plan", () => {
  for (const { lineage, packageValue } of [
    { lineage: "gundam-en-asia", packageValue: "619102" },
    { lineage: "gundam-en-us", packageValue: "616102" },
  ]) {
    const adapter = requiredSourceAdapter(`${lineage}@7`);
    const rootUrl = adapter.requestUrlForSurface("packages");
    const fixturePrefix = `./fixtures/retained-official-source/${lineage}-card-list`;
    const rootBytes = readFileSync(new URL(
      `${fixturePrefix}-root-live-fragment.html`,
      import.meta.url,
    ));
    const packageBytes = readFileSync(new URL(
      `${fixturePrefix}-package-live-fragment.html`,
      import.meta.url,
    ));
    const rootContext = {
      mediaType: "text/html; charset=UTF-8",
      url: rootUrl,
      requestId: `${lineage}:packages`,
    };
    const packageContext = {
      mediaType: "text/html; charset=UTF-8",
      url: `${rootUrl}?package=${packageValue}`,
      requestId: `${lineage}:listing:${"b".repeat(64)}`,
    };

    const rootRequests = adapter.discoverRequests(rootBytes, rootContext);
    assert.deepEqual(
      rootRequests.filter(({ role }) => role === "listing")
        .map(({ url }) => new URL(url).searchParams.get("package")),
      lineage === "gundam-en-asia"
        ? ["619101", "619102"]
        : ["616101", "616102"],
    );
    const packageRequests = adapter.discoverRequests(
      packageBytes,
      packageContext,
    );
    const allDetailUrls = [...rootRequests, ...packageRequests]
      .filter(({ role }) => role === "detail")
      .map(({ url }) => url);
    assert.equal(allDetailUrls.length, 4);
    assert.equal(new Set(allDetailUrls).size, 2);

    for (const [bytes, context] of [
      [rootBytes, rootContext],
      [packageBytes, packageContext],
    ]) {
      const [coverage] = adapter.parseBytes(bytes, context);
      assert.deepEqual(coverage.completeness, {
        declared_record_count: 2,
        parsed_record_count: 2,
        required_surfaces_complete: true,
        partitions_complete: true,
        structurally_complete: true,
      });
    }

    const packageHtml = packageBytes.toString("utf8");
    const nonterminalHtml = packageHtml
      .replace('<span class="num">2</span>', '<span class="num">4</span>')
      .replace(
        '<div class="pager"></div>',
        `<div class="pager"><a href="?package=${packageValue}&amp;page=2">2</a></div>`,
      );
    const [nonterminalCoverage] = adapter.parseBytes(
      new TextEncoder().encode(nonterminalHtml),
      packageContext,
    );
    assert.deepEqual(nonterminalCoverage.completeness, {
      declared_record_count: 4,
      parsed_record_count: 2,
      required_surfaces_complete: false,
      partitions_complete: false,
      structurally_complete: true,
    });
    const nonterminalRequests = adapter.discoverRequests(
      new TextEncoder().encode(nonterminalHtml),
      packageContext,
    );
    assert.deepEqual(
      nonterminalRequests
        .filter(({ role }) => role === "detail")
        .map(({ url }) => url),
      [
        `${new URL("detail.php", rootUrl)}?detailSearch=GD02-001`,
        `${new URL("detail.php", rootUrl)}?detailSearch=GD02-001_p1`,
      ],
    );
    assert.equal(
      nonterminalRequests.some(({ role, url }) =>
        role === "listing" &&
        url === `${rootUrl}?package=${packageValue}&page=2`
      ),
      true,
    );
    assert.throws(
      () => adapter.parseBytes(
        new TextEncoder().encode(
          packageHtml.replace('value="' + packageValue + '"', 'value="wrong"'),
        ),
        packageContext,
      ),
      /selected package.*request/iu,
    );
    assert.throws(
      () => adapter.parseBytes(
        new TextEncoder().encode(
          packageHtml.replace('<span class="num">2</span>', '<span class="num">3</span>'),
        ),
        packageContext,
      ),
      /publisher total.*full locators/iu,
    );
    const pagedBytes = new TextEncoder().encode(packageHtml.replace(
      "</section>", '<input type="hidden" name="page" value="2"></section>',
    ));
    assert.doesNotThrow(
      () => adapter.parseBytes(pagedBytes, {
        ...packageContext,
        url: `${packageContext.url}&page=2`,
      }),
    );
    assert.throws(
      () => adapter.parseBytes(pagedBytes, {
        ...packageContext,
        url: `${packageContext.url}&page=3`,
      }),
      /selected page.*request/iu,
    );
    const partialTerminalBytes = new TextEncoder().encode(
      packageHtml
        .replace('<span class="num">2</span>', '<span class="num">4</span>')
        .replace(
          "</section>",
          '<input type="hidden" name="page" value="2"></section>',
        ),
    );
    const [partialTerminalCoverage] = adapter.parseBytes(
      partialTerminalBytes,
      { ...packageContext, url: `${packageContext.url}&page=2` },
    );
    assert.equal(
      partialTerminalCoverage.completeness.required_surfaces_complete,
      false,
    );
  }
});

test("digest-verified unchanged Gundam publisher listing bytes close their exact result", () => {
  const fixture = retainedOfficialSourceFixture(
    "gundam-en-asia-card-list-complete-live",
  );
  const adapter = requiredSourceAdapter("gundam-en-asia@7");
  const context = {
    mediaType: fixture.metadata.content_type,
    url: fixture.metadata.source_url,
    requestId: `gundam-en-asia:listing:${"d".repeat(64)}`,
  };
  const [coverage] = adapter.parseBytes(fixture.bytes, context);
  assert.deepEqual(coverage.completeness, {
    declared_record_count: 187,
    parsed_record_count: 187,
    required_surfaces_complete: true,
    partitions_complete: true,
    structurally_complete: true,
  });
  assert.equal(
    adapter.discoverRequests(fixture.bytes, context)
      .filter(({ role }) => role === "detail").length,
    187,
  );
});

test("retained Gundam detail snapshots bind base and alternate art to full locators", () => {
  for (const { lineage, locale } of [
    { lineage: "gundam-en-asia", locale: "asia-en" },
    { lineage: "gundam-en-us", locale: "en" },
  ]) {
    const adapter = requiredSourceAdapter(`${lineage}@7`);
    const observations = ["base", "p2"].map((variant) => {
      const suffix = variant === "base" ? "" : "_p2";
      const bytes = readFileSync(new URL(
        `./fixtures/retained-official-source/${lineage}-card-detail-${variant}-live-fragment.html`,
        import.meta.url,
      ));
      const detailContext = {
        mediaType: "text/html; charset=UTF-8",
        url:
          `https://www.gundam-gcg.com/${locale}/cards/detail.php?detailSearch=GD02-038${suffix}`,
        requestId:
          `${lineage}:detail:${(variant === "base" ? "1" : "2").repeat(64)}`,
      };
      assert.equal(
        adapter.discoverRequests(bytes, detailContext)
          .filter(({ role }) => role === "image").length,
        1,
      );
      return adapter.parseBytes(bytes, detailContext)[0];
    });
    assert.deepEqual(
      observations.map((observation) => ({
        card_number: observation.card.official_identity.value,
        locator: observation.identity_evidence.locator,
        variant: observation.identity_evidence.variant_key,
        treatment: observation.identity_evidence.treatment,
        rarity: observation.printing.rarity,
        alternate_art:
          observation.printing.game_data.attributes.alternate_art,
      })),
      [
        {
          card_number: "GD02-038",
          locator: "GD02-038",
          variant: "base",
          treatment: "standard",
          rarity: { raw: "LR", normalized: "legend-rare" },
          alternate_art: false,
        },
        {
          card_number: "GD02-038",
          locator: "GD02-038_p2",
          variant: "_p2",
          treatment: "alternate",
          rarity: { raw: "LR ++", normalized: "legend-rare" },
          alternate_art: true,
        },
      ],
    );
    assert.notEqual(
      observations[0].identity_evidence.artwork_fingerprint,
      observations[1].identity_evidence.artwork_fingerprint,
    );
    assert.deepEqual(observations[1].card.game_data.attributes, {
      card_type: "unit",
      colours: ["red"],
      level: 7,
      cost: 5,
      block_icon: "1",
      effect_text: "【Deploy】Official alternate effect.",
      zone: "Space Earth",
      traits: ["(Clan)"],
      link_condition: "[Amate Yuzuriha (Machu)]",
      ap: 5,
      hp: 4,
      series_titles: ["Mobile Suit Gundam GQuuuuuuX"],
    });
  }
});

test("digest-verified unchanged Gundam publisher dash remains raw and normalizes", () => {
  const fixture = retainedOfficialSourceFixture(
    "gundam-en-asia-card-detail-dash-live",
  );
  const adapter = requiredSourceAdapter("gundam-en-asia@7");
  const [observation] = adapter.parseBytes(fixture.bytes, {
    mediaType: fixture.metadata.content_type,
    url: fixture.metadata.source_url,
    requestId: `gundam-en-asia:detail:${"4".repeat(64)}`,
  });
  assert.equal(
    observation.card.game_data.attributes.link_condition,
    null,
  );
  assert.equal(
    observation.source_sidecar.raw.official_surfaces[0].document.Link,
    "-",
  );
});

test("synthetic Gundam dash-glyph variants normalize without changing raw evidence", () => {
  for (const { lineage, locale } of [
    { lineage: "gundam-en-asia", locale: "asia-en" },
    { lineage: "gundam-en-us", locale: "en" },
  ]) {
    const adapter = requiredSourceAdapter(`${lineage}@7`);
    const syntheticPlaceholderBytes = new TextEncoder().encode(
      readFileSync(new URL(
        `./fixtures/retained-official-source/${lineage}-card-detail-base-live-fragment.html`,
        import.meta.url,
      )).toString("utf8")
        .replace('<div class="blockIcon">1</div>', '<div class="blockIcon">-</div>')
        .replace('<dt>Zone</dt><dd>Space Earth</dd>', '<dt>Zone</dt><dd>—</dd>')
        .replace(
          '<dt>Link</dt><dd>[Amate Yuzuriha (Machu)]</dd>',
          '<dt>Link</dt><dd>–</dd>',
        ),
    );
    const [placeholderObservation] = adapter.parseBytes(
      syntheticPlaceholderBytes,
      {
      mediaType: "text/html; charset=UTF-8",
      url:
        `https://www.gundam-gcg.com/${locale}/cards/detail.php?detailSearch=GD02-038`,
      requestId: `${lineage}:detail:${"3".repeat(64)}`,
      },
    );
    assert.deepEqual(
      {
        block_icon: placeholderObservation.card.game_data.attributes.block_icon,
        zone: placeholderObservation.card.game_data.attributes.zone,
        link_condition:
          placeholderObservation.card.game_data.attributes.link_condition,
      },
      { block_icon: null, zone: null, link_condition: null },
    );
    const [syntheticRawSurface] =
      placeholderObservation.source_sidecar.raw.official_surfaces;
    assert.deepEqual(
      {
        block_icon: syntheticRawSurface.document["Block icon"],
        zone: syntheticRawSurface.document.Zone,
        link_condition: syntheticRawSurface.document.Link,
      },
      { block_icon: "-", zone: "—", link_condition: "–" },
    );
  }
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
    // Fusion World's restructured leaf must still enumerate its own
    // category; only the currently served one proves no further partition.
    const publisherFacets = adapter.sourceLineage === "fusion-world-en"
      ? '<section class="searchColSet-product"><a data-val="583301">Series</a></section>'
      : "";
    const requests = adapter.discoverRequests(
      new TextEncoder().encode(
        `<html><title>BANDAI Official Card List</title>${
          officialBandaiNavigationHeader(adapter.sourceLineage)
        }${publisherFacets}</html>`,
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
  const adapter = registeredProductionAdapters().find(
    ({ sourceLineage }) => sourceLineage === "gundam-en-us",
  );
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
  const release =
    observation.product_release_catalogue.products[0].releases[0];
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
      ({ path, value }) =>
        path.endsWith(".Release Event ID") && value === "launch-wave",
    ),
  );
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
  const gundamHtml = `
      <div class="cardNo">GD99-001</div>
      <div class="rarity">R★</div>
      <div class="blockIcon">03</div>
      <h1 class="cardName">Test Gundam Unit</h1>
      <div class="cardImage"><img src= "../../jp/images/cards/card/GD99-001.webp"></div>
      <dl><dt>TYPE</dt><dd>Unit</dd></dl>
      <dl><dt>COLOR</dt><dd>-</dd></dl>
      <dl><dt>Lv.</dt><dd>5</dd></dl>
      <dl><dt>COST</dt><dd>1,000</dd></dl>
      <div class="cardDataRow overview"><div class="dataTxt">Unit effect</div></div>
      <dl><dt>AP</dt><dd>4,000</dd></dl>
      <dl><dt>HP</dt><dd>5,000</dd></dl>
      <dl><dt>Zone</dt><dd>-</dd></dl>
      <dl><dt>Trait</dt><dd>-</dd></dl>
      <dl><dt>Link</dt><dd>-</dd></dl>
      <dl><dt>Source Title</dt><dd>Test Series</dd></dl>
    `;
  const gundamDetailUrl =
    "https://www.gundam-gcg.com/asia-en/cards/detail.php?detailSearch=GD99-001";
  const gundamObservation = gundam.parseBytes(
    new TextEncoder().encode(gundamHtml),
    {
      mediaType: "text/html",
      url: gundamDetailUrl,
      requestId: `gundam-en-asia:detail:${"e".repeat(64)}`,
    },
  )[0];
  assert.equal(gundamObservation.card.game_data.attributes.cost, 1000);
  assert.deepEqual(gundamObservation.card.game_data.attributes.colours, []);
  assert.equal(gundamObservation.card.game_data.attributes.block_icon, "03");
  assert.equal(gundamObservation.card.game_data.attributes.ap, 4000);
  assert.equal(gundamObservation.card.game_data.attributes.hp, 5000);
  assert.deepEqual(
    gundamObservation.printing.game_data.attributes,
    { alternate_art: false },
  );
  assert.deepEqual(gundamObservation.printing.rarity, {
    raw: "R★",
    normalized: "rare",
  });
  assert.throws(
    () => gundam.parseBytes(
      new TextEncoder().encode(gundamHtml.replace("R★", "Experimental Rare")),
      {
        mediaType: "text/html",
        url: gundamDetailUrl,
        requestId: `gundam-en-asia:detail:${"e".repeat(64)}`,
      },
    ),
    /Gundam rarity.*Experimental Rare/iu,
  );
});

test("every production lineage preserves its synthetic publisher-contract examples", () => {
  for (const adapter of registeredProductionAdapters()) {
    // A publication surface that carries no catalogue or legality parser of
    // its own; Fusion World publishes no errata surface any more.
    const surface = adapter.requiredSurfaces.includes("errata")
      ? "errata"
      : "releases";
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
    const retained =
      observations[0].source_sidecar.raw.official_surfaces[0].document;
    assert.deepEqual(retained.discovered_options, [
      { value: "official", label: "Official partition" },
    ]);
    assert.equal(retained.publication_links.length, 1);
  }
});

test("Product detail ignores unrelated code-shaped prose without losing name authority", () => {
  const adapter = registeredProductionAdapters().find(
    ({ sourceLineage }) => sourceLineage === "gundam-en-us",
  );
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
  // The live-product generation fetches accessory pages instead of dropping
  // them by URL vocabulary: the classification is proven from retained markup.
  assert.ok(
    discovered.some(({ url }) => url.includes("/accessory/fb-box-01/")),
  );
  const observation = adapter.parseBytes(
    new TextEncoder().encode(`
      <title>Storage Box | Dragon Ball Super Card Game Fusion World - Official Web Site</title>
      <h1>Dragon Ball Super Card Game Fusion World</h1>
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
  const adapter = requiredSourceAdapter("fusion-world-en@9");
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

test("Fusion leaf and Product surfaces keep their discovery roles separate", () => {
  const adapter = registeredProductionAdapters().find(
    ({ sourceLineage }) => sourceLineage === "fusion-world-en",
  );
  assert.ok(adapter);
  const leafRequests = adapter.discoverRequests(
    new TextEncoder().encode(`
      <section class="searchColSet-product">
        <a data-val="583301">Filter by series</a>
      </section>
      <a href="javascript:void(0);"
         data-src="detail.php?card_no=FB01-001">Card detail</a>
    `),
    {
      mediaType: "text/html; charset=utf-8",
      url: adapter.requestUrlForSurface("card-search"),
      requestId: `fusion-world-en:listing:${"5".repeat(64)}`,
    },
  );
  const productRequests = adapter.discoverRequests(
    new TextEncoder().encode(`
      <a href="/fw/en/products/?page=2">Next</a>
      <a href="/fw/en/products/booster/fb01/">Product detail</a>
      <img src="/fw/images/products/FB01-box.png">
    `),
    {
      mediaType: "text/html; charset=utf-8",
      url: adapter.requestUrlForSurface("products"),
      requestId: "fusion-world-en:products",
    },
  );
  const requests = [...leafRequests, ...productRequests];
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

const restructuredStageDigest = "0".repeat(64);

function retainedRestructuredParse(adapter, slug, context) {
  const fixture = retainedOfficialSourceFixture(slug);
  return {
    fixture,
    observations: adapter.parseBytes(fixture.bytes, {
      mediaType: fixture.metadata.content_type,
      ...context,
    }),
  };
}

function retainedRestructuredRequests(adapter, slug, context) {
  const fixture = retainedOfficialSourceFixture(slug);
  return adapter.discoverRequests(fixture.bytes, {
    mediaType: fixture.metadata.content_type,
    ...context,
  });
}

function stageRecordSummaries(observations) {
  return observations.flatMap(({ records }) => records ?? []).map((
    { id, surface, url },
  ) => ({ id, surface, url }));
}

test("the restructured One Piece discovery root repeats every publisher navigation link", () => {
  const adapter = requiredSourceAdapter("one-piece-en@6");
  const request = officialSourceDiscoveryRequests("one-piece-en")[0];
  const fixture = retainedOfficialSourceFixture(
    "one-piece-en-restructured-discovery",
  );
  assert.equal(fixture.metadata.source_url, request.url);
  const html = fixture.bytes.toString("utf8");
  const navigationAnchor = (label) =>
    `<span class="menuColListLinkTit">${label}</span>`;
  for (const label of ["FIND CARDS", "ALL PRODUCTS", "RULES"]) {
    assert.equal(
      html.split(navigationAnchor(label)).length - 1,
      2,
      `${label} must be retained in both the header and the footer`,
    );
  }
  const records = stageRecordSummaries(
    adapter.parseBytes(fixture.bytes, {
      mediaType: fixture.metadata.content_type,
      url: request.url,
      requestId: request.id,
    }),
  );
  assert.deepEqual(records, [
    {
      id: "one-piece-en:discovery-seed:cards",
      surface: "@seed:cards",
      url: "https://en.onepiece-cardgame.com/cardlist/?series=569116",
    },
    {
      id: "one-piece-en:discovery-seed:products",
      surface: "@seed:products",
      url: "https://en.onepiece-cardgame.com/products/",
    },
    {
      id: "one-piece-en:discovery-seed:rules",
      surface: "@seed:rules",
      url: "https://en.onepiece-cardgame.com/rules/",
    },
  ]);

  const footer = html.lastIndexOf(navigationAnchor("FIND CARDS"));
  const singleCopy = `${html.slice(0, footer)}${
    navigationAnchor("FIND CARD")
  }${html.slice(footer + navigationAnchor("FIND CARDS").length)}`;
  assert.throws(
    () =>
      adapter.parseBytes(new TextEncoder().encode(singleCopy), {
        mediaType: fixture.metadata.content_type,
        url: request.url,
        requestId: request.id,
      }),
    /discovery/iu,
    "a single navigation copy is not the retained live discovery root",
  );
});

test("the restructured One Piece Card List leaf retains every live Card and its printed dash cost", () => {
  const adapter = requiredSourceAdapter("one-piece-en@6");
  const { fixture, observations } = retainedRestructuredParse(
    adapter,
    "one-piece-en-restructured-discovery",
    {
      url: adapter.requestUrlForSurface("card-list"),
      requestId: "one-piece-en:card-list",
    },
  );
  assert.equal(fixture.metadata.http_status, 200);
  assert.equal(observations.length, 155);
  const document =
    observations[0].source_sidecar.raw.official_surfaces[0].document;
  assert.equal(document.page, "card-list");
  assert.equal(document.declared_record_count, 155);
  assert.equal(document.recording_options.length, 59);
  assert.deepEqual(
    [...new Set(observations.flatMap(
      ({ memberships }) => memberships.source_buckets,
    ))],
    ["recording:569116"],
  );

  // The live Event Card prints an explicit "-" cost, which is retained as a
  // Card without a cost rather than as a missing field.
  const event = observations.find(
    ({ card }) => card.official_identity.value === "OP16-020",
  );
  assert.ok(event);
  assert.equal(event.card.game_data.attributes.card_type, "event");
  assert.equal(event.card.game_data.attributes.cost, null);

  const special = observations.filter(
    ({ printing }) => printing.rarity.normalized === "special",
  );
  assert.equal(special.length, 6);
  assert.deepEqual(
    [...new Set(special.map(({ printing }) => printing.rarity.raw))],
    ["SP CARD"],
  );
});

test("restructured One Piece rules discovery pins every published policy surface", () => {
  const adapter = requiredSourceAdapter("one-piece-en@6");
  const { observations } = retainedRestructuredParse(
    adapter,
    "one-piece-en-rules-hub",
    {
      url: "https://en.onepiece-cardgame.com/rules/",
      requestId: `one-piece-en:listing:rules:${restructuredStageDigest}`,
    },
  );
  assert.deepEqual(stageRecordSummaries(observations), [
    {
      id: "one-piece-en:restrictions",
      surface: "restrictions",
      url: "https://en.onepiece-cardgame.com/news/restriction.html",
    },
    {
      id: "one-piece-en:block-policy",
      surface: "block-policy",
      url: "https://en.onepiece-cardgame.com/topics/013.php",
    },
    {
      id: "one-piece-en:errata",
      surface: "errata",
      url: "https://en.onepiece-cardgame.com/rules/errata_card/",
    },
    {
      id: "one-piece-en:don-rules",
      surface: "don-rules",
      url: "https://en.onepiece-cardgame.com/rules/",
    },
  ]);
  for (const surface of ["restrictions", "block-policy", "errata"]) {
    assert.equal(
      stageRecordSummaries(observations).find(
        (record) => record.surface === surface,
      ).url,
      adapter.requestUrlForSurface(surface),
    );
  }
});

test("the restructured Fusion World card search closes its category leaf and schedules every detail", () => {
  const adapter = requiredSourceAdapter("fusion-world-en@9");
  const url = adapter.requestUrlForSurface("card-search");
  const { fixture, observations } = retainedRestructuredParse(
    adapter,
    "fusion-world-en-restructured-card-search",
    { url, requestId: "fusion-world-en:card-search" },
  );
  assert.equal(fixture.metadata.source_url, url);
  assert.equal(observations.length, 172);
  assert.equal(observations[0].listing_identity_evidence.locator, "E-148");
  assert.equal(
    new Set(observations.map(
      ({ listing_identity_evidence }) => listing_identity_evidence.locator,
    )).size,
    172,
  );

  const staged = retainedRestructuredRequests(
    adapter,
    "fusion-world-en-restructured-card-search",
    { url, requestId: "fusion-world-en:card-search" },
  );
  const listings = staged.filter(({ role }) => role === "listing");
  const details = staged.filter(({ role }) => role === "detail");
  assert.equal(listings.length, 26);
  assert.equal(details.length, 172);
  assert.equal(
    listings[0].url,
    "https://www.dbs-cardgame.com/fw/en/cardlist/?search=true&category%5B0%5D=583010",
  );
  assert.ok(
    listings.every(({ url: listingUrl }) =>
      new URL(listingUrl).searchParams.get("category[0]") !== "583301"
    ),
    "the requested category is already served by this leaf",
  );
  assert.equal(
    details[0].url,
    "https://www.dbs-cardgame.com/fw/en/cardlist/detail.php?card_no=E-148",
  );
});

test("restructured Fusion World details retain Leader faces, variants, and Battle Card facts", () => {
  const adapter = requiredSourceAdapter("fusion-world-en@9");
  const detail = (slug, url) =>
    retainedRestructuredParse(adapter, slug, {
      url,
      requestId: `fusion-world-en:detail:${restructuredStageDigest}`,
    }).observations[0];

  const leader = detail(
    "fusion-world-en-card-detail-leader",
    "https://www.dbs-cardgame.com/fw/en/cardlist/detail.php?card_no=ST01-001",
  );
  assert.equal(leader.identity_evidence.locator, "ST01-001");
  assert.equal(leader.identity_evidence.variant_key, "base");
  assert.equal(leader.card.game_data.attributes.card_type, "leader");
  assert.deepEqual(
    leader.card.game_data.attributes.leader_faces.map(
      ({ role, name, power }) => ({ role, name, power }),
    ),
    [
      { role: "front", name: "Son Goten", power: 15000 },
      { role: "back", name: "Son Goten", power: 20000 },
    ],
  );
  assert.deepEqual(
    leader.appearance_evidence.images.map(({ role, source_url }) => ({
      role,
      source_url,
    })),
    [
      {
        role: "front",
        source_url:
          "https://www.dbs-cardgame.com/fw/images/cards/card/en/ST01-001_f.webp",
      },
      {
        role: "back",
        source_url:
          "https://www.dbs-cardgame.com/fw/images/cards/card/en/ST01-001_b.webp",
      },
    ],
  );
  assert.deepEqual(leader.printing.rarity, { raw: "L", normalized: "l" });

  const variant = detail(
    "fusion-world-en-card-detail-leader-p1",
    "https://www.dbs-cardgame.com/fw/en/cardlist/detail.php?card_no=ST01-001&p=_p1",
  );
  assert.equal(variant.identity_evidence.locator, "ST01-001_p1");
  assert.equal(variant.identity_evidence.variant_key, "_p1");
  assert.equal(
    variant.card.official_identity.value,
    leader.card.official_identity.value,
  );
  assert.deepEqual(
    variant.appearance_evidence.images.map(({ source_url }) => source_url),
    [
      "https://www.dbs-cardgame.com/fw/images/cards/card/en/ST01-001_f_p1.webp",
      "https://www.dbs-cardgame.com/fw/images/cards/card/en/ST01-001_b_p1.webp",
    ],
  );

  const battle = detail(
    "fusion-world-en-card-detail-battle",
    "https://www.dbs-cardgame.com/fw/en/cardlist/detail.php?card_no=ST01-002",
  );
  assert.equal(battle.identity_evidence.locator, "ST01-002");
  assert.equal(battle.card.name, "Krillin");
  assert.equal(battle.card.game_data.attributes.card_type, "battle");
  assert.equal(battle.card.game_data.attributes.cost, 1);
  assert.equal(battle.card.game_data.attributes.power, 5000);
  assert.equal(battle.card.game_data.attributes.combo_power, 10000);
  assert.deepEqual(battle.card.game_data.attributes.specified_cost, [
    { colour: "red", count: 1 },
  ]);
  assert.deepEqual(
    battle.appearance_evidence.images.map(({ role }) => role),
    ["front"],
  );
  assert.deepEqual(battle.memberships.source_buckets, [
    "card-set:STORY BOOSTER 01 [ST01]",
  ]);
});

// The exact failure of production run run_967677 on snapshot E-148: the live
// Energy Marker detail publishes no rarity block at all, which the
// pre-optional-card-field generation read as a broken page instead of an
// absent optional field.
const fusionEnergyMarkerUrl =
  "https://www.dbs-cardgame.com/fw/en/cardlist/detail.php?card_no=E-148";

function exactMessage(message) {
  return (error) => {
    assert.equal(error.message, message);
    return true;
  };
}

test("active Fusion World details retain Energy Markers without a rarity", () => {
  const adapter = requiredSourceAdapter("fusion-world-en@9");
  const detail = (slug, url) => {
    const { fixture, observations } = retainedRestructuredParse(adapter, slug, {
      url,
      requestId: `fusion-world-en:detail:${restructuredStageDigest}`,
    });
    assert.equal(fixture.metadata.source_url, url);
    assert.equal(observations.length, 1, slug);
    return observations[0];
  };

  const marker = detail(
    "fusion-world-en-card-detail-energy-marker",
    fusionEnergyMarkerUrl,
  );
  assert.equal(marker.identity_evidence.locator, "E-148");
  assert.equal(marker.identity_evidence.variant_key, "base");
  assert.equal(marker.card.name, "Energy Marker");
  assert.equal(marker.card.game_data.attributes.card_type, "energy_marker");
  // Every printed cell but the skill and the set is a dash, and the dashed
  // colour cell stays colourless rather than becoming an unknown colour.
  assert.deepEqual(marker.card.game_data.attributes.colours, ["no-color"]);
  assert.equal(marker.card.game_data.attributes.cost, null);
  assert.equal(marker.card.game_data.attributes.power, null);
  assert.equal(marker.card.game_data.attributes.combo_power, null);
  assert.deepEqual(marker.card.game_data.attributes.specified_cost, []);
  assert.deepEqual(marker.card.game_data.attributes.traits, []);
  assert.deepEqual(marker.printing.rarity, { raw: null, normalized: null });
  assert.deepEqual(
    marker.appearance_evidence.images.map(({ role }) => role),
    ["front"],
  );

  const variant = detail(
    "fusion-world-en-card-detail-energy-marker-p1",
    `${fusionEnergyMarkerUrl}&p=_p1`,
  );
  assert.equal(variant.identity_evidence.locator, "E-148_p1");
  assert.equal(variant.identity_evidence.variant_key, "_p1");
  assert.equal(
    variant.card.official_identity.value,
    marker.card.official_identity.value,
  );
  assert.deepEqual(variant.printing.rarity, { raw: null, normalized: null });
  assert.deepEqual(
    variant.appearance_evidence.images.map(({ source_url }) => source_url),
    ["https://www.dbs-cardgame.com/fw/images/cards/card/en/E-148_p1.webp"],
  );

  const promo = detail(
    "fusion-world-en-card-detail-promo",
    "https://www.dbs-cardgame.com/fw/en/cardlist/detail.php?card_no=FP-001",
  );
  assert.equal(promo.identity_evidence.locator, "FP-001");
  assert.equal(promo.card.name, "Son Goku");
  assert.equal(promo.card.game_data.attributes.card_type, "battle");
  assert.deepEqual(promo.printing.rarity, { raw: "PR", normalized: "pr" });
  assert.deepEqual(promo.memberships.source_buckets, [
    "card-set:Promotion Pack vol.1",
  ]);
});

test("Fusion World rarity remains required for every family but Energy Markers", () => {
  const adapter = requiredSourceAdapter("fusion-world-en@9");
  const mutatedDetail = (slug, from, to) => {
    const fixture = retainedOfficialSourceFixture(slug);
    const html = fixture.bytes.toString("utf8");
    assert.ok(html.includes(from), `${slug} must retain ${from}`);
    return () =>
      adapter.parseBytes(new TextEncoder().encode(html.replace(from, to)), {
        mediaType: fixture.metadata.content_type,
        url: fixture.metadata.source_url,
        requestId: `fusion-world-en:detail:${restructuredStageDigest}`,
      });
  };

  assert.throws(
    mutatedDetail(
      "fusion-world-en-card-detail-promo",
      '<div class="rarity">PR</div>',
      "",
    ),
    exactMessage("Fusion World Card detail is missing its rarity."),
    "a Battle Card without a rarity block is still a broken page",
  );
  assert.throws(
    mutatedDetail(
      "fusion-world-en-card-detail-energy-marker",
      '<div class="cardNo">E-148</div>',
      '<div class="cardNo">E-148</div><div class="rarity">C</div>',
    ),
    exactMessage(
      "Fusion World Energy Marker detail must not publish a rarity.",
    ),
    "an Energy Marker that publishes a rarity is an unmodelled page",
  );
});

// The five exact live shapes retained by the 2026-08-12 full-scale Fusion
// World run. Every fixture below carries the exact live bytes that the
// pre-live-shape generation failed on in production; the live adapters
// parse them.
const fusionLiveShapeAdapter = () => requiredSourceAdapter("fusion-world-en@9");
// The issue-63 request-capacity generation changed no parsing: the retained
// fusion-world-en@8 registration must keep replaying live-shape bytes exactly
// like the active fusion-world-en@9 registration.
const fusionRetainedLiveShapeAdapter = () =>
  requiredSourceAdapter("fusion-world-en@8");

test("the retained fusion-world-en@8 registration replays live-shape bytes exactly like fusion-world-en@9", () => {
  const active = fusionLiveShapeAdapter();
  const retained = fusionRetainedLiveShapeAdapter();
  assert.equal(retained.parserContract, active.parserContract);
  for (const { slug, url, requestId } of fusionProductListingFixtures) {
    const fixture = retainedOfficialSourceFixture(slug);
    const context = {
      mediaType: fixture.metadata.content_type,
      url,
      requestId,
    };
    assert.deepEqual(
      retained.parseBytes(fixture.bytes, context),
      active.parseBytes(fixture.bytes, context),
      `${slug} must parse identically on the retained registration`,
    );
  }
});

const fusionProductListingFixtures = [
  {
    slug: "fusion-world-en-products-hub",
    url: "https://www.dbs-cardgame.com/fw/en/products/",
    requestId: "fusion-world-en:products",
  },
  {
    slug: "fusion-world-en-products-page2",
    url: "https://www.dbs-cardgame.com/fw/en/products/?page=2",
    requestId: `fusion-world-en:listing:${restructuredStageDigest}`,
  },
  {
    slug: "fusion-world-en-products-starter-tag",
    url: "https://www.dbs-cardgame.com/fw/en/products/?tags=StarterDecks&page=1",
    requestId: `fusion-world-en:listing:${restructuredStageDigest}`,
  },
];

test("the live Fusion World product listing parses its anchored status sections", () => {
  const adapter = fusionLiveShapeAdapter();
  for (const { slug, url, requestId } of fusionProductListingFixtures) {
    const { fixture, observations } = retainedRestructuredParse(
      adapter,
      slug,
      { url, requestId },
    );
    assert.equal(fixture.metadata.source_url, url);
    const products = observations.flatMap(
      (observation) => observation.product_release_catalogue?.products ?? [],
    );
    const accessories = observations.flatMap((observation) =>
      observation.product_release_catalogue?.distribution_contexts ?? []
    );
    assert.ok(products.length > 0, `${slug} yields Product observations`);
    assert.ok(
      accessories.every(({ kind, label }) =>
        kind === "other" && label === "accessory"
      ),
      `${slug} retains accessory listings as explicit non-card contexts`,
    );
    assert.ok(
      products.every(({ releases }) =>
        releases.length === 1 && releases[0].date !== undefined
      ),
      `${slug} retains exactly one published Release per Product`,
    );
  }

  const hub = retainedRestructuredParse(
    adapter,
    "fusion-world-en-products-hub",
    fusionProductListingFixtures[0],
  );
  const hubProducts = hub.observations.flatMap(
    (observation) => observation.product_release_catalogue?.products ?? [],
  );
  const winter = hubProducts.find(
    ({ official_code }) => official_code === "FB12",
  );
  assert.deepEqual(winter.releases[0], {
    event_key: "product-release:FB12",
    region: "unknown",
    date: { precision: "season", value: "2026-winter" },
    status: "announced",
  });
  const released = hubProducts.find(
    ({ official_code }) => official_code === "FB10",
  );
  assert.deepEqual(released.releases[0], {
    event_key: "product-release:FB10",
    region: "unknown",
    date: { precision: "day", value: "2026-06-12" },
    status: "released",
  });
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
        new TextEncoder().encode(html.replace(
          from,
          '<section class="contentsColInner retiredCol" id="retired">',
        )),
        {
          mediaType: fixture.metadata.content_type,
          url: fixture.metadata.source_url,
          requestId: "fusion-world-en:products",
        },
      ),
    exactMessage(
      "Fusion World Product status sections are incomplete; missing: comingsoon; unexpected: retired.",
    ),
  );
});

const fusionErrataDetailFixtures = [
  {
    slug: "fusion-world-en-card-detail-errata-skills",
    url: "https://www.dbs-cardgame.com/fw/en/cardlist/detail.php?card_no=SB01-039",
  },
  {
    slug: "fusion-world-en-card-detail-errata-leader",
    url: "https://www.dbs-cardgame.com/fw/en/cardlist/detail.php?card_no=FS10-01",
  },
  {
    slug: "fusion-world-en-card-detail-errata-leader-p1",
    url: "https://www.dbs-cardgame.com/fw/en/cardlist/detail.php?card_no=FS10-01&p=_p1",
  },
  {
    slug: "fusion-world-en-card-detail-errata-traits",
    url: "https://www.dbs-cardgame.com/fw/en/cardlist/detail.php?card_no=FP-088",
  },
];

function retainedFusionErrataDetail(slug, url) {
  const { fixture, observations } = retainedRestructuredParse(
    fusionLiveShapeAdapter(),
    slug,
    { url, requestId: `fusion-world-en:detail:${restructuredStageDigest}` },
  );
  assert.equal(fixture.metadata.source_url, url);
  assert.equal(observations.length, 1, slug);
  return observations[0];
}

test("live Fusion World details retain the publisher's Errata Applied annotations", () => {
  const battle = retainedFusionErrataDetail(
    "fusion-world-en-card-detail-errata-skills",
    fusionErrataDetailFixtures[0].url,
  );
  assert.equal(battle.identity_evidence.locator, "SB01-039");
  assert.equal(battle.card.game_data.attributes.card_type, "battle");
  // The displayed Skills text is the effective post-erratum publication, so
  // the printed-rules claim is withheld exactly where the publisher
  // declares the applied erratum.
  assert.ok(battle.card.effective_rules_text.length > 0);
  assert.equal(battle.printing.printed_rules_text, null);
  assert.deepEqual(
    battle.source_sidecar.raw.official_surfaces[0].document.errata_applied,
    [{
      cell: "Skills",
      face: "front",
      notice_url: "https://www.dbs-cardgame.com/fw/en/news/02_22.html",
    }],
  );

  const leader = retainedFusionErrataDetail(
    "fusion-world-en-card-detail-errata-leader",
    fusionErrataDetailFixtures[1].url,
  );
  assert.equal(leader.identity_evidence.locator, "FS10-01");
  assert.equal(leader.card.game_data.attributes.card_type, "leader");
  // Only the back face is annotated: the front-face printed claim stands,
  // the back face publishes its effective text, and the pinned Errata
  // Notice navigation never leaks into the rules text.
  assert.ok(leader.printing.printed_rules_text.length > 0);
  const backFace = leader.card.game_data.attributes.leader_faces.find(
    ({ role }) => role === "back",
  );
  assert.ok(backFace.skills.length > 0);
  assert.ok(!backFace.skills.includes("Errata Notice"));
  assert.deepEqual(
    leader.source_sidecar.raw.official_surfaces[0].document.errata_applied,
    [{
      cell: "Skills",
      face: "back",
      notice_url: "https://www.dbs-cardgame.com/fw/en/news/02_22.html",
    }],
  );

  const variant = retainedFusionErrataDetail(
    "fusion-world-en-card-detail-errata-leader-p1",
    fusionErrataDetailFixtures[2].url,
  );
  assert.equal(variant.identity_evidence.locator, "FS10-01_p1");
  assert.equal(variant.identity_evidence.variant_key, "_p1");
  assert.equal(
    variant.card.official_identity.value,
    leader.card.official_identity.value,
  );

  const traits = retainedFusionErrataDetail(
    "fusion-world-en-card-detail-errata-traits",
    fusionErrataDetailFixtures[3].url,
  );
  assert.equal(traits.identity_evidence.locator, "FP-088");
  assert.deepEqual(traits.card.game_data.attributes.traits, [
    "Saiyan",
    "Earthling",
    "Master's Teachings",
  ]);
  // The annotation names Special Traits only, so the exact printed Skills
  // claim is retained.
  assert.ok(traits.printing.printed_rules_text.length > 0);
  assert.deepEqual(
    traits.source_sidecar.raw.official_surfaces[0].document.errata_applied,
    [{
      cell: "Special Traits",
      face: "front",
      notice_url: "https://www.dbs-cardgame.com/fw/en/news/02_22.html",
    }],
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
    exactMessage(
      "Fusion World Card detail publishes an Errata Applied annotation on an unmodelled cell.",
    ),
    "an annotation on a numeric cell is an unmodelled page",
  );
  assert.throws(
    mutatedDetail(
      "fusion-world-en-card-detail-errata-skills",
      fusionErrataDetailFixtures[0].url,
      '<span class="is-front"> (Errata Applied)</span>',
      '<span class="is-back"> (Errata Applied)</span>',
    ),
    exactMessage(
      "Fusion World Errata Applied annotation and its Errata Notice link do not match.",
    ),
    "a single-faced Card annotated on a face without a notice link fails closed",
  );
  assert.throws(
    mutatedDetail(
      "fusion-world-en-card-detail-errata-skills",
      fusionErrataDetailFixtures[0].url,
      '<div class="cardNotesBtnCol"><a class="cardNotesBtn" href=https://www.dbs-cardgame.com/fw/en/news/02_22.html target="_blank" rel="noopener noreferrer">Errata Notice</a></div>',
      "",
    ),
    exactMessage(
      "Fusion World Errata Applied annotation and its Errata Notice link do not match.",
    ),
    "an annotation without its pinned Errata Notice link fails closed",
  );
});

const fusionWinterProductUrl =
  "https://www.dbs-cardgame.com/fw/en/products/01_477.html";

test("the live Fusion World product detail retains its season-precision Release", () => {
  const adapter = fusionLiveShapeAdapter();
  const { fixture, observations } = retainedRestructuredParse(
    adapter,
    "fusion-world-en-product-winter-booster",
    {
      url: fusionWinterProductUrl,
      requestId: `fusion-world-en:product_detail:${restructuredStageDigest}`,
    },
  );
  assert.equal(fixture.metadata.source_url, fusionWinterProductUrl);
  assert.equal(observations.length, 1);
  const [product] = observations[0].product_release_catalogue.products;
  assert.equal(product.official_code, "FB12");
  assert.equal(product.name, "BOOSTER PACK -REACH THE GOD- [FB12]");
  assert.deepEqual(product.releases, [{
    event_key: "product-release:FB12",
    region: "unknown",
    date: { precision: "season", value: "2026-winter" },
    status: null,
  }]);
});

const fusionLegalityHistoryUrl =
  "https://www.dbs-cardgame.com/fw/en/news/01_399.html";

test("the live Fusion World legality history parses its exact restriction lift", () => {
  const adapter = fusionLiveShapeAdapter();
  assert.equal(
    adapter.requestUrlForSurface("legality-history"),
    fusionLegalityHistoryUrl,
  );
  const { fixture, observations } = retainedRestructuredParse(
    adapter,
    "fusion-world-en-legality-history-news",
    {
      url: fusionLegalityHistoryUrl,
      requestId: "fusion-world-en:legality-history",
    },
  );
  assert.equal(fixture.metadata.source_url, fusionLegalityHistoryUrl);
  assert.equal(observations.length, 1);
  const [rule] = observations[0].legality_rules;
  assert.deepEqual(rule, {
    id: "01_399-FB02-013",
    game: "fusion-world",
    region: "EN-OCEANIA",
    format: "standard",
    event_tier: null,
    effective_from: "2026-03-14",
    effective_until: null,
    unresolved_scope: null,
    card_numbers: ["FB02-013"],
    official_wording:
      "Card Removed from the Restricted List\nFB02-013 Kefla\nTherefore, its Restricted status will be lifted.",
    effect: { type: "eligible" },
    representable: true,
  });
});

test("the legality-history lift remains fail-closed on any drifted prose", () => {
  const adapter = fusionLiveShapeAdapter();
  const fixture = retainedOfficialSourceFixture(
    "fusion-world-en-legality-history-news",
  );
  const html = fixture.bytes.toString("utf8");
  const from = "please refer to the Rules page.";
  assert.ok(html.includes(from));
  assert.throws(
    () =>
      adapter.parseBytes(
        new TextEncoder().encode(html.replace(
          from,
          "please refer to the Rules page. Further cards may be restricted.",
        )),
        {
          mediaType: fixture.metadata.content_type,
          url: fusionLegalityHistoryUrl,
          requestId: "fusion-world-en:legality-history",
        },
      ),
    exactMessage(
      "Fusion World history policy contains unconsumed prose or structure.",
    ),
  );
});

test("the restructured Digimon card search derives one listing per publisher category", () => {
  const adapter = requiredSourceAdapter("digimon-en@7");
  const url = adapter.requestUrlForSurface("card-list");
  const request = officialSourceDiscoveryRequests("digimon-en")[0];
  assert.equal(request.url, url);
  const { fixture, observations } = retainedRestructuredParse(
    adapter,
    "digimon-en-restructured-card-search",
    { url, requestId: "digimon-en:card-list" },
  );
  assert.equal(fixture.metadata.source_url, url);
  assert.equal(observations.length, 1);

  const listings = retainedRestructuredRequests(
    adapter,
    "digimon-en-restructured-card-search",
    { url, requestId: "digimon-en:card-list" },
  ).filter(({ role }) => role === "listing");
  assert.equal(listings.length, 70);
  assert.ok(
    listings.every(({ url: listingUrl }) => {
      const params = new URL(listingUrl).searchParams;
      return params.get("search") === "true" &&
        (params.get("category") ?? "").length > 0;
    }),
    "every derived Digimon listing must pin one publisher category",
  );
});

test("the restructured Digimon complete leaf retains vanilla Cards without Effective Rules Text", () => {
  const adapter = requiredSourceAdapter("digimon-en@7");
  const leafUrl =
    "https://world.digimoncard.com/cards/index.php?search=true&category=522001&cardcategory=Digimon&color=Blue";
  const { fixture, observations } = retainedRestructuredParse(
    adapter,
    "digimon-en-card-list-bt01-leaf",
    {
      url: leafUrl,
      requestId: `digimon-en:listing:${restructuredStageDigest}`,
    },
  );
  assert.equal(fixture.metadata.source_url, leafUrl);
  assert.equal(observations.length, 24);
  assert.equal(
    new Set(observations.map(
      ({ identity_evidence }) => identity_evidence.locator,
    )).size,
    24,
  );
  assert.ok(
    observations.some(
      ({ identity_evidence }) => identity_evidence.locator === "BT1-044_P1",
    ),
    "alternate art keeps its own full locator",
  );
  const vanilla = observations.filter(
    ({ card }) => card.effective_rules_text === null,
  );
  assert.equal(vanilla.length, 8);
  assert.equal(vanilla[0].card.official_identity.value, "BT1-027");
  assert.equal(vanilla[0].card.game_data.attributes.card_type, "digimon");
  assert.equal(vanilla[0].card.game_data.attributes.dp, 4000);
});

// The nested Related Cards block inside a live Q&A answer truncated the whole
// popup inventory for the digimon-en@6 parser, so these leaves are the exact
// bytes that the optional-card-field generation had to learn to read.
const digimonRelatedQaLeafUrl =
  "https://world.digimoncard.com/cards/index.php?search=true&category=522035&cardcategory=Digimon&color=Black";

function activeDigimonLeaf(slug, leafUrl) {
  const adapter = requiredSourceAdapter("digimon-en@7");
  const { fixture, observations } = retainedRestructuredParse(adapter, slug, {
    url: leafUrl,
    requestId: `digimon-en:listing:${restructuredStageDigest}`,
  });
  assert.equal(fixture.metadata.source_url, leafUrl);
  return observations;
}

function digimonQaEntries(observation) {
  return observation.source_sidecar.raw.official_surfaces[0].document
    .card_qa ?? [];
}

test("active Digimon leaves retain Q&A answers that nest Related Cards", () => {
  const observations = activeDigimonLeaf(
    "digimon-en-card-list-related-qa-leaf",
    digimonRelatedQaLeafUrl,
  );
  assert.equal(observations.length, 5);
  assert.deepEqual(
    observations.map(({ identity_evidence }) => identity_evidence.locator),
    ["BT7-056_P2", "BT7-056_P3", "BT7-058_P2", "BT8-059_P4", "ST13-08_P1"],
  );
  assert.deepEqual(
    observations.map((observation) => digimonQaEntries(observation).length),
    [4, 4, 2, 6, 4],
  );
  assert.deepEqual(
    observations.flatMap((observation) =>
      digimonQaEntries(observation)
        .filter(({ related_cards }) => related_cards.length > 0)
        .map(({ number, related_cards }) => [number, related_cards])
    ),
    [
      ["Q1606", ["BT9-109"]],
      ["Q1742", ["BT10-067"]],
      ["Q1743", ["BT4-011"]],
    ],
  );
  assert.ok(
    observations.every((observation) =>
      digimonQaEntries(observation).every(({ related_cards }) =>
        Array.isArray(related_cards)
      )
    ),
    "every retained answer must publish an explicit Related Cards array",
  );
});

test("active Digimon leaves model unconstrained and bonus-token printed vocabulary", () => {
  const [appmon] = activeDigimonLeaf(
    "digimon-en-card-list-appmon-leaf",
    "https://world.digimoncard.com/cards/index.php?search=true&category=522204&cardcategory=Digimon&color=Purple",
  );
  assert.equal(appmon.identity_evidence.locator, "BT21-071_P1");
  const attributes = appmon.card.game_data.attributes;
  assert.deepEqual(attributes.digivolution_requirements, [
    {
      index: 1,
      from_level: 3,
      colours: ["purple"],
      cost: 2,
      raw_condition: "Purple 2 from Lv.3",
    },
    // "Multicolor" constrains no colour and "Stnd." is a grade, not a level,
    // so both frozen fields stay explicitly unconstrained beside exact wording.
    {
      index: 2,
      from_level: null,
      colours: [],
      cost: 2,
      raw_condition: "Multicolor 2 from Stnd.",
    },
  ]);
  assert.equal(attributes.link_dp, 3000);

  const promo = activeDigimonLeaf(
    "digimon-en-card-list-promo-leaf",
    "https://world.digimoncard.com/cards/index.php?search=true&category=522901&cardcategory=Digimon&color=Red",
  );
  assert.equal(promo.length, 19);
  assert.deepEqual(
    promo.map(({ identity_evidence }) => identity_evidence.locator),
    [
      "P-001",
      "P-002",
      "P-009",
      "P-010",
      "P-029",
      "P-041",
      "P-049",
      "P-050",
      "P-058",
      "P-059",
      "P-065",
      "P-066",
      "P-072",
      "P-079",
      "P-088",
      "P-119",
      "P-182",
      "P-189",
      "P-213",
    ],
  );
  // The publisher pads these related-card links with a trailing ideographic
  // space, which may not leak into the retained card numbers.
  assert.deepEqual(
    promo.flatMap((observation) =>
      digimonQaEntries(observation).flatMap(({ related_cards }) =>
        related_cards
      )
    ),
    ["BT5-109", "BT3-109"],
  );
  assert.deepEqual(
    promo.find(({ identity_evidence }) => identity_evidence.locator === "P-119")
      .card.game_data.attributes.digivolution_requirements,
    [
      {
        index: 1,
        from_level: 2,
        colours: ["red", "yellow"],
        cost: 0,
        raw_condition: "Red Yellow 0 from Lv.2",
      },
    ],
  );
});

test("the predecessor Digimon adapter still truncates the nested Related Cards leaf", () => {
  const frozen = requiredSourceAdapter("digimon-en@6");
  const fixture = retainedOfficialSourceFixture(
    "digimon-en-card-list-related-qa-leaf",
  );
  assert.throws(
    () =>
      frozen.parseBytes(fixture.bytes, {
        mediaType: fixture.metadata.content_type,
        url: digimonRelatedQaLeafUrl,
        requestId: `digimon-en:listing:${restructuredStageDigest}`,
      }),
    exactMessage("Official Digimon Card Q&A answer is structurally incomplete."),
  );
});

test("restructured Digimon rules discovery pins its restriction and errata publications", () => {
  const adapter = requiredSourceAdapter("digimon-en@7");
  const { observations } = retainedRestructuredParse(
    adapter,
    "digimon-en-rules-hub",
    {
      url: "https://world.digimoncard.com/rule/",
      requestId: `digimon-en:listing:rules:${restructuredStageDigest}`,
    },
  );
  assert.deepEqual(stageRecordSummaries(observations), [
    {
      id: "digimon-en:restrictions-current",
      surface: "restrictions-current",
      url: "https://world.digimoncard.com/rule/restriction_card/",
    },
    {
      id: "digimon-en:restrictions-history",
      surface: "restrictions-history",
      url: "https://world.digimoncard.com/rule/restriction_card/",
    },
    {
      id: "digimon-en:errata",
      surface: "errata",
      url: "https://world.digimoncard.com/rule/errata_card/",
    },
  ]);
});

test("restructured Gundam card search roots retain their empty state and every package option", () => {
  for (const lineage of ["gundam-en-asia", "gundam-en-us"]) {
    const adapter = requiredSourceAdapter(`${lineage}@7`);
    const url = adapter.requestUrlForSurface("packages");
    const slug = `${lineage}-restructured-card-search`;
    const { observations } = retainedRestructuredParse(adapter, slug, {
      url,
      requestId: `${lineage}:packages`,
    });
    assert.equal(observations.length, 1, lineage);
    const document =
      observations[0].source_sidecar.raw.official_surfaces[0].document;
    assert.deepEqual(Object.keys(document).sort(), [
      "empty_search_state",
      "package_options",
      "source_lineage",
      "surface",
      "url",
    ], lineage);
    assert.equal(document.source_lineage, lineage);
    assert.equal(document.surface, "packages");
    assert.equal(document.url, url);
    assert.equal(
      document.empty_search_state,
      "Please specify your search criteria.",
      lineage,
    );
    assert.equal(document.package_options.length, 21, lineage);
    assert.deepEqual(
      document.package_options,
      [...document.package_options].sort(),
      lineage,
    );
    assert.deepEqual(observations[0].completeness, {
      structurally_complete: true,
      required_surfaces_complete: true,
      partitions_complete: true,
      declared_record_count: 21,
      parsed_record_count: 21,
    }, lineage);

    const listings = retainedRestructuredRequests(adapter, slug, {
      url,
      requestId: `${lineage}:packages`,
    }).filter(({ role }) => role === "listing");
    assert.deepEqual(
      listings.map(({ url: listingUrl }) => listingUrl),
      document.package_options.map((option) => `${url}?package=${option}`),
      lineage,
    );
  }
});

test("restructured Gundam news discovery pins the errata listing subcategory tab", () => {
  for (const lineage of ["gundam-en-asia", "gundam-en-us"]) {
    const adapter = requiredSourceAdapter(`${lineage}@7`);
    const locale = lineage === "gundam-en-asia" ? "asia-en" : "en";
    const { observations } = retainedRestructuredParse(
      adapter,
      `${lineage}-news-hub`,
      {
        url: `https://www.gundam-gcg.com/${locale}/news/`,
        requestId: `${lineage}:listing:news:${restructuredStageDigest}`,
      },
    );
    assert.deepEqual(stageRecordSummaries(observations), [
      {
        id: `${lineage}:errata`,
        surface: "errata",
        url: adapter.requestUrlForSurface("errata"),
      },
    ], lineage);
  }
});

test("the retained Gundam errata listing schedules its article and remaining pages", () => {
  const adapter = requiredSourceAdapter("gundam-en-asia@7");
  const url = adapter.requestUrlForSurface("errata");
  const { fixture } = retainedRestructuredParse(
    adapter,
    "gundam-en-asia-errata-listing",
    { url, requestId: "gundam-en-asia:errata" },
  );
  assert.equal(fixture.metadata.source_url, url);
  const staged = retainedRestructuredRequests(
    adapter,
    "gundam-en-asia-errata-listing",
    { url, requestId: "gundam-en-asia:errata" },
  );
  assert.deepEqual(
    staged.filter(({ role }) => role === "detail").map(
      ({ url: detailUrl }) => detailUrl,
    ),
    ["https://www.gundam-gcg.com/asia-en/news/01_236.html"],
  );
  assert.deepEqual(
    staged.filter(({ role }) => role === "listing").map(
      ({ url: listingUrl }) => listingUrl,
    ),
    [2, 3, 4].map((page) =>
      `https://www.gundam-gcg.com/asia-en/news/?subcategory=news&tag=all&page=${page}`
    ),
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
  for (
    const [surface, pinned] of [
      ["restrictions", "/news/restriction.html"],
      ["block-policy", "/topics/013.php"],
    ]
  ) {
    const unpinned = mutate(
      "one-piece-en-rules-hub",
      (html) => html.replaceAll(pinned, "/news/unrelated-notice.html"),
    );
    assert.throws(
      () =>
        onePiece.parseBytes(unpinned.bytes, {
          mediaType: unpinned.mediaType,
          url: "https://en.onepiece-cardgame.com/rules/",
          requestId: `one-piece-en:listing:rules:${restructuredStageDigest}`,
        }),
      new RegExp(
        `Official Source rules discovery stage did not retain the ${surface} surface link\\.`,
        "u",
      ),
    );
  }

  const gundam = requiredSourceAdapter("gundam-en-asia@7");
  const packagesUrl = gundam.requestUrlForSurface("packages");
  const withoutEmptyState = mutate(
    "gundam-en-asia-restructured-card-search",
    (html) => html.replace(/<section class="errorCol">[\s\S]*?<\/section>/u, ""),
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
  const unrecognizedEmptyState = mutate(
    "gundam-en-asia-restructured-card-search",
    (html) =>
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
  const emptyLeaf = retainedOfficialSourceFixture(
    "gundam-en-asia-restructured-card-search",
  );
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
  const withoutCategories = mutate(
    "fusion-world-en-restructured-card-search",
    (html) => html.replaceAll("searchColSet-product", "searchColSet-retired"),
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

// The live product-detail generation: every retained page below is a complete
// publisher body captured from the site that broke production run run_085d6d,
// where the leading <h1> became the site logo on every product page.
// The issue-58 generation keeps the live product-detail contracts unchanged
// for One Piece and Gundam while closing their legality walls.
const liveProductAdapterVersions = {
  "one-piece-en": "one-piece-en@6",
  "fusion-world-en": "fusion-world-en@9",
  "digimon-en": "digimon-en@7",
  "gundam-en-asia": "gundam-en-asia@7",
  "gundam-en-us": "gundam-en-us@7",
};

function activeProductionAdapter(sourceLineage) {
  const adapter = requiredSourceAdapter(
    liveProductAdapterVersions[sourceLineage],
  );
  assert.ok(
    registeredProductionAdapters().includes(adapter),
    `${sourceLineage} must resolve its live-product version as the active adapter`,
  );
  return adapter;
}

function retainedProductDetail(sourceLineage, slug, adapter) {
  const resolved = adapter ?? activeProductionAdapter(sourceLineage);
  const fixture = retainedOfficialSourceFixture(slug);
  const observations = resolved.parseBytes(fixture.bytes, {
    mediaType: "text/html",
    url: fixture.metadata.source_url,
    requestId: `${sourceLineage}:product_detail:${restructuredStageDigest}`,
  });
  assert.equal(observations.length, 1, slug);
  return {
    fixture,
    catalogue: observations[0].product_release_catalogue,
    document: observations[0].source_sidecar.raw.official_surfaces[0].document,
  };
}

function mutatedProductDetail(sourceLineage, slug, from, to, adapter) {
  const resolved = adapter ?? activeProductionAdapter(sourceLineage);
  const fixture = retainedOfficialSourceFixture(slug);
  const html = fixture.bytes.toString("utf8");
  assert.ok(html.includes(from), `${slug} must retain ${from}`);
  return () =>
    resolved.parseBytes(
      new TextEncoder().encode(html.replace(from, to)),
      {
        mediaType: "text/html",
        url: fixture.metadata.source_url,
        requestId: `${sourceLineage}:product_detail:${restructuredStageDigest}`,
      },
    );
}

function retainedAccessoryContext(sourceLineage, slug, title) {
  const { catalogue, document } = retainedProductDetail(sourceLineage, slug);
  assert.deepEqual(catalogue.products, [], slug);
  assert.deepEqual(catalogue.relationships, [], slug);
  assert.deepEqual(catalogue.distribution_contexts, [{
    key: `non-card:accessory:${title.toLocaleLowerCase()}`,
    kind: "other",
    label: "accessory",
    evidence_category: "explicit",
  }], slug);
  assert.equal(document.document_title, title, slug);
}

test("retained live Gundam product pages promote every titled Product from its heading contract", () => {
  const booster = retainedProductDetail(
    "gundam-en-asia",
    "gundam-en-asia-product-booster",
  );
  assert.deepEqual(booster.catalogue.products, [{
    reference: { kind: "official_code", value: "GD05" },
    official_code: "GD05",
    name: "Freedom Ascension [GD05]",
    releases: [{
      event_key: "product-release:GD05",
      region: "EN-ASIA",
      date: { precision: "day", value: "2026-07-25" },
      status: null,
    }],
  }]);
  assert.deepEqual(booster.catalogue.distribution_contexts, []);
  assert.equal(booster.document.document_title, "Freedom Ascension [GD05]");

  // A card-bearing box is an ordinary Product, not an accessory.
  const deckBuildBox = retainedProductDetail(
    "gundam-en-asia",
    "gundam-en-asia-product-deck-build-box",
  );
  assert.deepEqual(deckBuildBox.catalogue.products, [{
    reference: { kind: "official_code", value: "SC01" },
    official_code: "SC01",
    name: "Deck Build Box Freedom Ascension [SC01]",
    releases: [{
      event_key: "product-release:SC01",
      region: "EN-ASIA",
      date: { precision: "day", value: "2026-07-25" },
      status: null,
    }],
  }]);
  assert.deepEqual(deckBuildBox.catalogue.distribution_contexts, []);
});

test("a retained live Gundam set without a bracketed code keeps name identity and its dotted release date", () => {
  const { catalogue, fixture } = retainedProductDetail(
    "gundam-en-asia",
    "gundam-en-asia-product-anniversary-set",
  );
  // The publisher prints the shorthand "2026.7.27" on this page.
  assert.ok(fixture.bytes.toString("utf8").includes("2026.7.27"));
  const [product] = catalogue.products;
  assert.equal(catalogue.products.length, 1);
  assert.equal(product.official_code, null);
  assert.deepEqual(product.reference, {
    kind: "name",
    value: "GUNDAM CARD GAME 1st Anniversary Set",
  });
  assert.equal(product.name, "GUNDAM CARD GAME 1st Anniversary Set");
  assert.deepEqual(product.releases[0].date, {
    precision: "day",
    value: "2026-07-27",
  });
  assert.equal(product.releases[0].region, "EN-ASIA");
  assert.match(
    product.releases[0].event_key,
    /^product-release:name-[0-9a-f]+-[0-9a-f]{16}$/u,
  );
});

test("retained live Gundam accessory pages retain non-card evidence in both locales", () => {
  for (const lineage of ["gundam-en-asia", "gundam-en-us"]) {
    retainedAccessoryContext(
      lineage,
      `${lineage}-product-card-case`,
      "Official Card Case Set 02",
    );
  }
  retainedAccessoryContext(
    "gundam-en-us",
    "gundam-en-us-product-playmat",
    "Official Playmat & Card Set — Mobile Suit Gundam 00 —",
  );
});

test("retained live One Piece product pages separate coded, code-less, and accessory publications", () => {
  // The live OP-17 page is a 343-byte meta-refresh stub whose only publisher
  // fact is its titled Product identity.
  const stub = retainedProductDetail(
    "one-piece-en",
    "one-piece-en-product-booster-stub",
  );
  assert.equal(stub.fixture.bytes.length, 343);
  assert.deepEqual(stub.catalogue.products, [{
    reference: { kind: "official_code", value: "OP-17" },
    official_code: "OP-17",
    name: "BOOSTER PACK -THE WORLD’S STRONGEST WARRIORS- [OP-17]",
    releases: [],
  }]);
  assert.deepEqual(Object.keys(stub.document), ["document_title"]);

  for (
    const [slug, name] of [
      [
        "one-piece-en-product-card-collection",
        "Premium Card Collection -Ace & Sabo & Luffy-",
      ],
      [
        "one-piece-en-product-anniversary-set",
        "ONE PIECE CARD GAME English Version 3rd Anniversary Set",
      ],
    ]
  ) {
    const { catalogue } = retainedProductDetail("one-piece-en", slug);
    assert.deepEqual(catalogue.products, [{
      reference: { kind: "name", value: name },
      official_code: null,
      name,
      releases: [],
    }], slug);
    assert.deepEqual(catalogue.distribution_contexts, [], slug);
  }

  retainedAccessoryContext(
    "one-piece-en",
    "one-piece-en-product-sleeve",
    "LIMITED CARD SLEEVE PREMIUM MATTE vol.6",
  );
});

test("retained live Digimon product pages map region-scoped and code-less releases", () => {
  const themeBooster = retainedProductDetail(
    "digimon-en",
    "digimon-en-product-theme-booster",
  );
  assert.deepEqual(themeBooster.catalogue.products, [{
    reference: { kind: "official_code", value: "EX-01" },
    official_code: "EX-01",
    name: "DIGIMON CARD GAME THEME BOOSTER CLASSIC COLLECTION [EX-01]",
    releases: [{
      event_key: "product-release:EX-01",
      // "Europe/Oceania: December 10, 2021 (*Asmodee UK/Blackfire Stores: …)"
      region: "EN-OCEANIA",
      date: { precision: "day", value: "2021-12-10" },
      status: null,
    }],
  }]);

  const giftBox = retainedProductDetail(
    "digimon-en",
    "digimon-en-product-gift-box",
  );
  const [gift] = giftBox.catalogue.products;
  assert.equal(gift.official_code, null);
  assert.equal(gift.name, "DIGIMON CARD GAME GIFT BOX");
  assert.equal(gift.releases[0].region, "EN-OCEANIA");
  assert.deepEqual(gift.releases[0].date, {
    precision: "day",
    value: "2021-12-10",
  });

  const starterDeck = retainedProductDetail(
    "digimon-en",
    "digimon-en-product-starter-deck",
  );
  assert.deepEqual(starterDeck.catalogue.products, [{
    reference: { kind: "official_code", value: "ST-24" },
    official_code: "ST-24",
    name: "DIGIMON CARD GAME DIGIMON DATA SQUAD [ST-24]",
    releases: [{
      event_key: "product-release:ST-24",
      region: "unknown",
      date: { precision: "day", value: "2026-05-15" },
      status: null,
    }],
  }]);
});

test("retained live Fusion World product pages promote their coded Products", () => {
  for (
    const [slug, code, name, date] of [
      [
        "fusion-world-en-product-story-booster",
        "ST01",
        "STORY BOOSTER 01 [ST01]",
        "2026-08-21",
      ],
      [
        "fusion-world-en-product-starter-deck",
        "FS11",
        "STARTER DECK EX THE PHASE OF EVOLUTION [FS11]",
        "2026-03-13",
      ],
    ]
  ) {
    const { catalogue } = retainedProductDetail("fusion-world-en", slug);
    assert.deepEqual(catalogue.products, [{
      reference: { kind: "official_code", value: code },
      official_code: code,
      name,
      releases: [{
        event_key: `product-release:${code}`,
        region: "unknown",
        date: { precision: "day", value: date },
        status: null,
      }],
    }], slug);
  }
});

test("live Product detail fails closed without its publisher title suffix or matching Gundam heading", () => {
  assert.throws(
    mutatedProductDetail(
      "one-piece-en",
      "one-piece-en-product-card-collection",
      " | ONE PIECE CARD GAME - Official Web Site</title>",
      "</title>",
    ),
    /one-piece-en Product detail is missing its official title\./u,
  );
  assert.throws(
    mutatedProductDetail(
      "gundam-en-asia",
      "gundam-en-asia-product-booster",
      " | GUNDAM CARD GAME Official Website</title>",
      "</title>",
    ),
    /gundam-en-asia Product detail is missing its official title\./u,
  );
  assert.throws(
    mutatedProductDetail(
      "gundam-en-asia",
      "gundam-en-asia-product-booster",
      '<h2 class="mvColTitle">Freedom Ascension [GD05]</h2>',
      '<h2 class="mvColTitle">Freedom Ascension</h2>',
    ),
    /gundam-en-asia Product detail heading does not match its official title\./u,
  );
});

test("the retained One Piece restriction publication is proven at its live redirect target", () => {
  const adapter = activeProductionAdapter("one-piece-en");
  const url = adapter.requestUrlForSurface("restrictions");
  assert.equal(url, "https://en.onepiece-cardgame.com/news/restriction.html");
  const fixture = retainedOfficialSourceFixture("one-piece-en-policy");
  // The retained bytes were captured at the pre-redirect URL; the same
  // publication now answers at the live target under one contract.
  assert.equal(
    fixture.metadata.source_url,
    "https://en.onepiece-cardgame.com/rules/restriction/",
  );
  const observations = adapter.parseBytes(fixture.bytes, {
    mediaType: fixture.metadata.content_type,
    url,
    requestId: "one-piece-en:restrictions",
  });
  const legality = observations.find(
    (observation) => observation.observation_type === "legality_rules",
  );
  assert.deepEqual(
    legality.legality_rules.map(({ card_numbers, effect }) => ({
      card_numbers,
      effect,
    })),
    [
      { card_numbers: ["OP06-047"], effect: { type: "ban" } },
      { card_numbers: ["OP03-040"], effect: { type: "ban" } },
      { card_numbers: ["OP06-086"], effect: { type: "ban" } },
      { card_numbers: ["ST10-001"], effect: { type: "ban" } },
      { card_numbers: ["OP06-116"], effect: { type: "ban" } },
      {
        card_numbers: ["OP07-115"],
        effect: {
          type: "prohibited_combination",
          with_card_numbers: ["EB04-058"],
        },
      },
      {
        card_numbers: ["OP11-040"],
        effect: {
          type: "prohibited_combination",
          with_card_numbers: ["OP11-067"],
        },
      },
      {
        card_numbers: ["OP11-040"],
        effect: {
          type: "prohibited_combination",
          with_card_numbers: ["OP08-069"],
        },
      },
    ],
  );
  assert.equal(legality.completeness.declared_record_count, 8);
  assert.equal(legality.completeness.parsed_record_count, 8);
  const surface =
    observations.find((observation) => observation.observation_type === undefined)
      .source_sidecar.raw.official_surfaces[0];
  assert.equal(surface.surface, "restrictions");
  assert.equal(surface.document.url, url);
});

test("the One Piece Block Number publication is an exactly empty policy surface", () => {
  const adapter = activeProductionAdapter("one-piece-en");
  const url = adapter.requestUrlForSurface("block-policy");
  assert.equal(url, "https://en.onepiece-cardgame.com/topics/013.php");
  const fixture = retainedOfficialSourceFixture(
    "one-piece-en-block-policy-topic",
  );
  assert.equal(fixture.metadata.source_url, url);
  const observations = adapter.parseBytes(fixture.bytes, {
    mediaType: fixture.metadata.content_type,
    url,
    requestId: "one-piece-en:block-policy",
  });
  const legality = observations.find(
    (observation) => observation.observation_type === "legality_rules",
  );
  assert.deepEqual(legality.legality_rules, []);
  assert.equal(legality.completeness.declared_record_count, 0);
  assert.equal(legality.completeness.parsed_record_count, 0);
  assert.equal(legality.completeness.structurally_complete, true);
  const surface =
    observations.find((observation) => observation.observation_type === undefined)
      .source_sidecar.raw.official_surfaces[0];
  assert.equal(surface.surface, "block-policy");
  assert.equal(
    surface.document.document_title,
    "Introduction of the Block Number System − TOPICS｜ONE PIECE CARD GAME - Official Web Site",
  );
});

function rawSurfacePayload(lineage, surface) {
  const payload = structuredClone(
    officialRawSurfacePayload(`/${lineage}/${surface}`),
  );
  if (lineage === "one-piece-en" && surface === "don-rules") {
    payload.don_card = {
      functional_designation: "DON!!",
      name: "DON!! Card",
      Category: "DON!! Card",
      Effect: "A rules-level resource Card used to pay costs and increase power.",
    };
  }
  return payload;
}

function parseRegisteredSurface(adapter, surface, payload) {
  const completeDigimonLeaf = adapter.sourceLineage === "digimon-en" &&
    surface === "card-list";
  const completeGundamLeaf = adapter.sourceLineage.startsWith("gundam-") &&
    surface === "packages";
  const publisherPayload = structuredClone(payload);
  if (adapter.sourceLineage === "one-piece-en" && surface === "card-list") {
    publisherPayload.card_pages.forEach((card) => {
      delete card.artwork_fingerprint;
      delete card.printed_fields_digest;
    });
  }
  if (completeDigimonLeaf) {
    for (const detail of publisherPayload.card_popups ?? []) {
      delete detail.artwork_fingerprint;
      delete detail.printed_fields_digest;
      delete detail.printing.normalized_rarity;
    }
  }
  if (completeGundamLeaf) {
    for (const detail of publisherPayload.card_details ?? []) {
      delete detail.artwork_fingerprint;
      delete detail.printed_fields_digest;
      delete detail.printing.normalized_rarity;
    }
  }
  return adapter.parseBytes(
    new TextEncoder().encode(
      `<html><title>BANDAI ${adapter.supportedGame} CARD PRODUCT RELEASE RULE ERRATA RESTRICTION</title>
       ${officialPublisherPayloadScript(
        adapter.sourceLineage,
        surface,
        publisherPayload,
      )}`,
    ),
    {
      mediaType: "text/html; charset=utf-8",
      url: completeDigimonLeaf
        ? `${adapter.requestUrlForSurface(surface)}&category=all&cardcategory=digimon&colour=blue`
        : completeGundamLeaf
          ? `${adapter.requestUrlForSurface(surface)}?package=all`
        : adapter.requestUrlForSurface(surface),
      requestId: completeDigimonLeaf || completeGundamLeaf
        ? `${adapter.sourceLineage}:listing:${"f".repeat(64)}`
        : `${adapter.sourceLineage}:${surface}`,
    },
  );
}
