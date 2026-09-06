import { test } from "vitest";
import assert from "node:assert/strict";
import { officialSourceDiscoveryRequests } from "../../src/catalogue/adapters/product-release-source-adapters.ts";
import { requiredSourceAdapter } from "../../src/catalogue/adapters/source-adapters.ts";
import syntheticOfficialSource, {
  officialPublisherPayloadScript,
  officialRawSurfacePayload,
} from "../../acceptance/fixtures/synthetic-official-source.mjs";
import {
  registeredProductionAdapters,
  retainedOfficialSourceFixture,
  restructuredStageDigest,
  retainedRestructuredParse,
  retainedRestructuredRequests,
  stageRecordSummaries,
  retainedProductDetail,
} from "./official-source-raw-contract-shared.mjs";

test("the live Digimon adapter normalizes exact standalone Official Errata", () => {
  const adapter = requiredSourceAdapter("digimon-en@7");
  const payload = officialRawSurfacePayload("/digimon-en/errata");
  payload.declared_record_count = 1;
  payload.partition.total = 1;
  payload.entries = [
    {
      card_number: "BT99-001",
      published_on: "2026-07-01",
      effective_from: "2026-07-01",
      observed_printed_rules_text: "Printed effect before correction.",
      corrected_rules_text: "Corrected official effect.",
      official_wording: 'Replace "Printed effect before correction." with "Corrected official effect."',
      applies_to_parallel_printings: true,
      source_fragment: "#BT99-001",
      display_name: "BT99-001 Erratum",
      image_url: "https://world.digimoncard.com/images/cardlist/card/BT99-001.png",
    },
  ];
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
    [
      {
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
        official_wording: 'Replace "Printed effect before correction." with "Corrected official effect."',
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
      },
    ],
  );

  payload.entries[0].future_target_scope = "Only alternate-art printings";
  assert.throws(
    () =>
      adapter.parseBytes(
        Buffer.from(`<html>${officialPublisherPayloadScript("digimon-en", "errata", payload)}</html>`),
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
  payload.entries = [
    {
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
    },
  ];

  const observations = adapter.parseBytes(
    Buffer.from(`<html>${officialPublisherPayloadScript("digimon-en", "errata", payload)}</html>`),
    {
      mediaType: "text/html",
      url: adapter.requestUrlForSurface("errata"),
      requestId: "digimon-en:errata",
    },
  );
  assert.deepEqual(
    observations
      .filter(({ kind }) => kind === "official_erratum")
      .map(({ corrected_rules_text }) => corrected_rules_text),
    [null],
  );
});

test("the synthetic Digimon Worker isolates sequential and concurrent request scenarios", async () => {
  const rootUrl = "https://world.digimoncard.com/cards/index.php?search=true";
  const errataUrl = "https://world.digimoncard.com/rule/errata_card/";
  const responseText = async (url, userAgent) =>
    await (
      await syntheticOfficialSource.fetch(
        new Request(url, {
          headers: { "user-agent": userAgent },
        }),
      )
    ).text();

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
    responseText(errataUrl, "card-keepr-acceptance-digimon/complete; request-role=surface; request-surface=errata"),
    responseText(
      errataUrl,
      "card-keepr-acceptance-digimon/complete-no-errata; request-role=surface; request-surface=errata",
    ),
  ]);
  assert.match(complete, /Remove the printed effect/u);
  assert.doesNotMatch(absent, /Remove the printed effect/u);
});

test("Digimon explicit surfaces deterministically disambiguate shared Product, Release, and policy URLs", async () => {
  const adapter = requiredSourceAdapter("digimon-en@7");
  const cases = [
    ["products", "https://world.digimoncard.com/products/"],
    ["releases", "https://world.digimoncard.com/products/"],
  ];
  const captured = new Map();
  for (const [surface, url] of [...cases, ...cases.toReversed()]) {
    const response = await syntheticOfficialSource.fetch(
      new Request(url, {
        headers: {
          "user-agent": `card-keepr-digimon-routing; request-role=surface; request-surface=${surface}`,
        },
      }),
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (captured.has(surface)) {
      assert.deepEqual(bytes, captured.get(surface), surface);
    } else {
      captured.set(surface, bytes);
    }
    assert.doesNotThrow(
      () =>
        adapter.parseBytes(bytes, {
          mediaType: response.headers.get("content-type"),
          url,
          requestId: `digimon-en:${surface}`,
        }),
      surface,
    );
  }
  assert.notDeepEqual(captured.get("products"), captured.get("releases"));
});

test("real Digimon and Gundam details close every known profile field and reject malformed numerics", () => {
  const byLineage = (lineage) => registeredProductionAdapters().find(({ sourceLineage }) => sourceLineage === lineage);
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
  const digimonObservation = digimon.parseBytes(new TextEncoder().encode(digimonHtml), digimonContext)[0];
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
    digivolution_requirements: [
      {
        index: 1,
        from_level: 5,
        colours: ["blue"],
        cost: 4,
        raw_condition: "Blue Lv.5: 4",
      },
    ],
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
  assert.deepEqual(digimonObservation.printing.game_data.attributes, { alternative_art: true });
  assert.throws(
    () =>
      digimon.parseBytes(
        new TextEncoder().encode(digimonHtml.replace("<dd>12,000</dd>", "<dd>12,00</dd>")),
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
  const gundamDetailUrl = "https://www.gundam-gcg.com/asia-en/cards/detail.php?detailSearch=GD99-001";
  const gundamObservation = gundam.parseBytes(new TextEncoder().encode(gundamHtml), {
    mediaType: "text/html",
    url: gundamDetailUrl,
    requestId: `gundam-en-asia:detail:${"e".repeat(64)}`,
  })[0];
  assert.equal(gundamObservation.card.game_data.attributes.cost, 1000);
  assert.deepEqual(gundamObservation.card.game_data.attributes.colours, []);
  assert.equal(gundamObservation.card.game_data.attributes.block_icon, "03");
  assert.equal(gundamObservation.card.game_data.attributes.ap, 4000);
  assert.equal(gundamObservation.card.game_data.attributes.hp, 5000);
  assert.deepEqual(gundamObservation.printing.game_data.attributes, { alternate_art: false });
  assert.deepEqual(gundamObservation.printing.rarity, {
    raw: "R★",
    normalized: "rare",
  });
  assert.throws(
    () =>
      gundam.parseBytes(new TextEncoder().encode(gundamHtml.replace("R★", "Experimental Rare")), {
        mediaType: "text/html",
        url: gundamDetailUrl,
        requestId: `gundam-en-asia:detail:${"e".repeat(64)}`,
      }),
    /Gundam rarity.*Experimental Rare/iu,
  );
});

test("the restructured Digimon card search derives one listing per publisher category", () => {
  const adapter = requiredSourceAdapter("digimon-en@7");
  const url = adapter.requestUrlForSurface("card-list");
  const request = officialSourceDiscoveryRequests("digimon-en")[0];
  assert.equal(request.url, url);
  const { fixture, observations } = retainedRestructuredParse(adapter, "digimon-en-restructured-card-search", {
    url,
    requestId: "digimon-en:card-list",
  });
  assert.equal(fixture.metadata.source_url, url);
  assert.equal(observations.length, 1);

  const listings = retainedRestructuredRequests(adapter, "digimon-en-restructured-card-search", {
    url,
    requestId: "digimon-en:card-list",
  }).filter(({ role }) => role === "listing");
  assert.equal(listings.length, 70);
  assert.ok(
    listings.every(({ url: listingUrl }) => {
      const params = new URL(listingUrl).searchParams;
      return params.get("search") === "true" && (params.get("category") ?? "").length > 0;
    }),
    "every derived Digimon listing must pin one publisher category",
  );
});

test("the restructured Digimon complete leaf retains vanilla Cards without Effective Rules Text", () => {
  const adapter = requiredSourceAdapter("digimon-en@7");
  const leafUrl =
    "https://world.digimoncard.com/cards/index.php?search=true&category=522001&cardcategory=Digimon&color=Blue";
  const { fixture, observations } = retainedRestructuredParse(adapter, "digimon-en-card-list-bt01-leaf", {
    url: leafUrl,
    requestId: `digimon-en:listing:${restructuredStageDigest}`,
  });
  assert.equal(fixture.metadata.source_url, leafUrl);
  assert.equal(observations.length, 24);
  assert.equal(new Set(observations.map(({ identity_evidence }) => identity_evidence.locator)).size, 24);
  assert.ok(
    observations.some(({ identity_evidence }) => identity_evidence.locator === "BT1-044_P1"),
    "alternate art keeps its own full locator",
  );
  const vanilla = observations.filter(({ card }) => card.effective_rules_text === null);
  assert.equal(vanilla.length, 8);
  assert.equal(vanilla[0].card.official_identity.value, "BT1-027");
  assert.equal(vanilla[0].card.game_data.attributes.card_type, "digimon");
  assert.equal(vanilla[0].card.game_data.attributes.dp, 4000);
});

// The nested Related Cards block inside a live Q&A answer truncated the whole
// popup inventory before the optional-card-field generation, so these leaves
// are the exact bytes that generation had to learn to read.
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
  return observation.source_sidecar.raw.official_surfaces[0].document.card_qa ?? [];
}

test("active Digimon leaves retain Q&A answers that nest Related Cards", () => {
  const observations = activeDigimonLeaf("digimon-en-card-list-related-qa-leaf", digimonRelatedQaLeafUrl);
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
        .map(({ number, related_cards }) => [number, related_cards]),
    ),
    [
      ["Q1606", ["BT9-109"]],
      ["Q1742", ["BT10-067"]],
      ["Q1743", ["BT4-011"]],
    ],
  );
  assert.ok(
    observations.every((observation) =>
      digimonQaEntries(observation).every(({ related_cards }) => Array.isArray(related_cards)),
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
    promo.flatMap((observation) => digimonQaEntries(observation).flatMap(({ related_cards }) => related_cards)),
    ["BT5-109", "BT3-109"],
  );
  assert.deepEqual(
    promo.find(({ identity_evidence }) => identity_evidence.locator === "P-119").card.game_data.attributes
      .digivolution_requirements,
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

test("restructured Digimon rules discovery pins its restriction and errata publications", () => {
  const adapter = requiredSourceAdapter("digimon-en@7");
  const { observations } = retainedRestructuredParse(adapter, "digimon-en-rules-hub", {
    url: "https://world.digimoncard.com/rule/",
    requestId: `digimon-en:listing:rules:${restructuredStageDigest}`,
  });
  assert.deepEqual(stageRecordSummaries(observations), [
    {
      id: "digimon-en:errata",
      surface: "errata",
      url: "https://world.digimoncard.com/rule/errata_card/",
    },
  ]);
});

test("retained live Digimon product pages map region-scoped and code-less releases", () => {
  const themeBooster = retainedProductDetail("digimon-en", "digimon-en-product-theme-booster");
  assert.deepEqual(themeBooster.catalogue.products, [
    {
      reference: { kind: "official_code", value: "EX-01" },
      official_code: "EX-01",
      name: "DIGIMON CARD GAME THEME BOOSTER CLASSIC COLLECTION [EX-01]",
      releases: [
        {
          event_key: "product-release:EX-01",
          // "Europe/Oceania: December 10, 2021 (*Asmodee UK/Blackfire Stores: …)"
          region: "EN-OCEANIA",
          date: { precision: "day", value: "2021-12-10" },
          status: null,
        },
      ],
    },
  ]);

  const giftBox = retainedProductDetail("digimon-en", "digimon-en-product-gift-box");
  const [gift] = giftBox.catalogue.products;
  assert.equal(gift.official_code, null);
  assert.equal(gift.name, "DIGIMON CARD GAME GIFT BOX");
  assert.equal(gift.releases[0].region, "EN-OCEANIA");
  assert.deepEqual(gift.releases[0].date, {
    precision: "day",
    value: "2021-12-10",
  });

  const starterDeck = retainedProductDetail("digimon-en", "digimon-en-product-starter-deck");
  assert.deepEqual(starterDeck.catalogue.products, [
    {
      reference: { kind: "official_code", value: "ST-24" },
      official_code: "ST-24",
      name: "DIGIMON CARD GAME DIGIMON DATA SQUAD [ST-24]",
      releases: [
        {
          event_key: "product-release:ST-24",
          region: "unknown",
          date: { precision: "day", value: "2026-05-15" },
          status: null,
        },
      ],
    },
  ]);
});

// Injected optional-field regression over retained real HTML; not new source evidence.
test("Digimon retains an unfamiliar optional HTML mechanic without weakening required structure", () => {
  const adapter = requiredSourceAdapter("digimon-en@7");
  const fixture = retainedOfficialSourceFixture("digimon-en-card-list-bt01-leaf");
  const html = fixture.bytes.toString("utf8");
  const changed = html.replace(
    '<div class="cardInfoCol">',
    '<div class="cardInfoCol"><dl><dt>Future Mechanic</dt><dd>Uninterpreted mechanic</dd></dl>',
  );
  assert.notEqual(changed, html);
  const context = {
    mediaType: "text/html",
    url: fixture.metadata.source_url,
    requestId: `digimon-en:listing:${restructuredStageDigest}`,
  };
  const observations = adapter.parseBytes(Buffer.from(changed), context);
  assert.equal(observations.length, 24);
  assert.equal(observations[0].card.game_data.attributes["Future Mechanic"], "Uninterpreted mechanic");
  assert.throws(
    () => adapter.parseBytes(Buffer.from(changed.replace("cardTitleList", "missingTitleList")), context),
    /title|structur/iu,
  );
});
