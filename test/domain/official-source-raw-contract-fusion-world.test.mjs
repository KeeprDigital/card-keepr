import { test } from "vitest";
import assert from "node:assert/strict";
import {
  adapterReconciliationAreas,
  assertAdapterBinding,
  installedSourceAdapterRegistrations,
  requiredActiveSourceAdapter,
  requiredSourceAdapter,
  sourceAdapterRegistrations,
} from "../../src/catalogue/adapters/source-adapters.ts";
import syntheticOfficialSource, {
  officialBandaiNavigationHeader,
  officialDiscoveryDefinitions,
  officialDiscoveryDocument,
  officialPublisherPayloadScript,
  officialRawSurfacePayload,
} from "../../acceptance/fixtures/synthetic-official-source.mjs";
import { productionOfficialStageResponse } from "../../apps/ingestion/test/production-source-fixture-routing.ts";
import {
  registeredProductionAdapters,
  retainedOfficialSourceFixture,
  retainedLegalityRules,
  restructuredStageDigest,
  retainedRestructuredParse,
  retainedRestructuredRequests,
  exactMessage,
  fusionLiveShapeAdapter,
  fusionProductListingFixtures,
  fusionErrataDetailFixtures,
  fusionLegalityHistoryUrl,
  retainedProductDetail,
} from "./official-source-raw-contract-shared.mjs";

test("retained live Fusion World policy bytes retain every target without inventing a day", () => {
  const adapter = requiredSourceAdapter("fusion-world-en@9");
  const rules = retainedLegalityRules(adapter, "detail", "fusion-world-en-policy-detail", {
    requestId: `fusion-world-en:detail:${"a".repeat(64)}`,
  });
  assert.deepEqual(
    rules.map((rule) => rule.card_numbers[0]),
    ["FB01-056", "FB01-005", "FB02-031", "FB04-085", "FB04-094", "FB04-095", "SB01-011", "SB01-015"],
  );
  assert.ok(
    rules.every(
      (rule) =>
        rule.effective_from === null &&
        rule.unresolved_scope.dimensions.join(",") === "effective_interval" &&
        rule.effect.type === "unresolved" &&
        rule.effect.reason === `Effective interval for ${rule.card_numbers[0]} is not stated.`,
    ),
  );
});

test("retained Fusion and exact Digimon Rules stages close current and history identities", () => {
  const fusion = requiredSourceAdapter("fusion-world-en@9");
  const fusionFixture = retainedOfficialSourceFixture("fusion-world-en-policy-live");
  const fusionRecords = fusion.parseBytes(fusionFixture.bytes, {
    mediaType: fusionFixture.metadata.content_type,
    url: fusionFixture.metadata.source_url,
    requestId: `fusion-world-en:listing:rules:${"a".repeat(64)}`,
  })[0].records;
  assert.deepEqual(
    fusionRecords
      .filter(({ surface }) => surface === "legality-current" || surface === "legality-history")
      .map(({ surface, url }) => ({ surface, url })),
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
    digimonRecords
      .filter(({ surface }) => surface === "restrictions-current" || surface === "restrictions-history")
      .map(({ surface, url }) => ({ surface, url })),
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

test("retained Fusion policy rejects unconsumed event and expiry prose", () => {
  const adapter = requiredSourceAdapter("fusion-world-en@9");
  const fixture = retainedOfficialSourceFixture("fusion-world-en-policy-detail");
  for (const prose of [
    "This restriction applies at championship events.",
    "This restriction remains active through June 30, 2026.",
  ]) {
    const mutated = Buffer.from(
      fixture.bytes.toString("utf8").replace("<h4>Restricted Cards</h4>", `<p>${prose}</p><h4>Restricted Cards</h4>`),
    );
    assert.throws(
      () =>
        adapter.parseBytes(mutated, {
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
  const fixture = retainedOfficialSourceFixture("fusion-world-en-policy-detail");
  const framed = Buffer.from(
    fixture.bytes
      .toString("utf8")
      .replace('<article class="articleCol">', '<article class="articleCol"><div class="publisher-frame"></div>')
      .replace("</article>", '<div class="publisher-frame-end"></div></article>'),
  );
  const observations = adapter.parseBytes(framed, {
    mediaType: fixture.metadata.content_type,
    url: fixture.metadata.source_url,
    requestId: `fusion-world-en:detail:${"e".repeat(64)}`,
  });
  assert.equal(
    observations.find(({ observation_type }) => observation_type === "legality_rules")?.legality_rules.length,
    8,
  );
});

test("the exact Fusion listing fixture dispatch closes its staged surfaces", async () => {
  const adapter = requiredSourceAdapter("fusion-world-en@9");
  const url = "https://www.dbs-cardgame.com/fw/en/news/01_31.html";
  const response = productionOfficialStageResponse(
    "fusion-world-en",
    new Request(url, {
      headers: {
        accept: "text/html",
        "user-agent": "card-keepr-representable-legality-v3; request-role=listing",
      },
    }),
    officialBandaiNavigationHeader("fusion-world-en"),
  );
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  const observations = adapter.parseBytes(new Uint8Array(await response.arrayBuffer()), {
    mediaType: response.headers.get("content-type"),
    url,
    requestId: "fusion-world-en:listing:rules:ef7d6c9e469758959c58e79b0c21594afc89769eaf8264187e80c71d14c12b76",
  });
  assert.deepEqual(
    observations.flatMap(({ records }) => records ?? []).map(({ surface }) => surface),
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
  const planned = adapter
    .parseBytes(new Uint8Array(await listingResponse.arrayBuffer()), {
      mediaType: listingResponse.headers.get("content-type"),
      url: listingUrl,
      requestId: `fusion-world-en:listing:rules:${"e".repeat(64)}`,
    })[0]
    .records.filter(({ surface }) => surface === "legality-current" || surface === "legality-history");
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

  const current = retainedOfficialSourceFixture("fusion-world-en-policy-detail");
  const historyResponse = productionOfficialStageResponse(
    "fusion-world-en",
    new Request(planned[1].url, {
      headers: {
        accept: "text/html",
        "user-agent": "card-keepr-official-source/1; request-role=surface; request-surface=legality-history",
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
    const legality = observations.find(({ observation_type }) => observation_type === "legality_rules");
    assert.equal(legality.legality_rules.length, expectedCount, request.surface);
    assert.deepEqual(
      legality.completeness,
      {
        structurally_complete: true,
        required_surfaces_complete: true,
        partitions_complete: true,
        declared_record_count: expectedCount,
        parsed_record_count: expectedCount,
      },
      request.surface,
    );
    assert.equal(legality.source_sidecar.raw.official_surfaces[0].surface, request.surface, request.surface);
  }
});

test("Fusion staged policy discovery rejects keyword-matched sibling news pages", () => {
  const adapter = requiredSourceAdapter("fusion-world-en@9");
  for (const [label, href] of [
    ["Banned cards", "/fw/en/news/01_998.html"],
    ["Previous history", "/fw/en/news/01_999.html"],
  ]) {
    assert.throws(
      () =>
        adapter.parseBytes(
          new TextEncoder().encode(`<html>
        <title>BANDAI DRAGON BALL CARD RULES</title>
        <a href="${href}">${label}</a>
      </html>`),
          {
            mediaType: "text/html",
            url: "https://www.dbs-cardgame.com/fw/en/news/01_31.html",
            requestId: `fusion-world-en:listing:rules:${"a".repeat(64)}`,
          },
        ),
      /exact|sibling|policy|discovery/iu,
      label,
    );
  }
});

test("Fusion final policy parsing rejects a sibling news URL", () => {
  const adapter = requiredSourceAdapter("fusion-world-en@9");
  const payload = officialRawSurfacePayload("/fusion-world-en/legality-current");
  assert.throws(
    () =>
      adapter.parseBytes(
        new TextEncoder().encode(`<html>
      <title>BANDAI DRAGON BALL CARD RULE RESTRICTION</title>
      ${officialPublisherPayloadScript("fusion-world-en", "legality-current", payload)}
    </html>`),
        {
          mediaType: "text/html",
          url: "https://www.dbs-cardgame.com/fw/en/news/01_999.html",
          requestId: "fusion-world-en:legality-current",
        },
      ),
    /exact|identity|URL contract/iu,
  );
});

test("Fusion leaf and Product surfaces keep their discovery roles separate", () => {
  const adapter = registeredProductionAdapters().find(({ sourceLineage }) => sourceLineage === "fusion-world-en");
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
  assert.deepEqual(requests.map(({ role }) => role).sort(), ["detail", "image", "listing", "product_detail"]);
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

test("the restructured Fusion World card search closes its category leaf and schedules every detail", () => {
  const adapter = requiredSourceAdapter("fusion-world-en@9");
  const url = adapter.requestUrlForSurface("card-search");
  const { fixture, observations } = retainedRestructuredParse(adapter, "fusion-world-en-restructured-card-search", {
    url,
    requestId: "fusion-world-en:card-search",
  });
  assert.equal(fixture.metadata.source_url, url);
  assert.equal(observations.length, 172);
  assert.equal(observations[0].listing_identity_evidence.locator, "E-148");
  assert.equal(
    new Set(observations.map(({ listing_identity_evidence }) => listing_identity_evidence.locator)).size,
    172,
  );

  const staged = retainedRestructuredRequests(adapter, "fusion-world-en-restructured-card-search", {
    url,
    requestId: "fusion-world-en:card-search",
  });
  const listings = staged.filter(({ role }) => role === "listing");
  const details = staged.filter(({ role }) => role === "detail");
  assert.equal(listings.length, 26);
  assert.equal(details.length, 172);
  assert.equal(listings[0].url, "https://www.dbs-cardgame.com/fw/en/cardlist/?search=true&category%5B0%5D=583010");
  assert.ok(
    listings.every(({ url: listingUrl }) => new URL(listingUrl).searchParams.get("category[0]") !== "583301"),
    "the requested category is already served by this leaf",
  );
  assert.equal(details[0].url, "https://www.dbs-cardgame.com/fw/en/cardlist/detail.php?card_no=E-148");
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
    leader.card.game_data.attributes.leader_faces.map(({ role, name, power }) => ({ role, name, power })),
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
        source_url: "https://www.dbs-cardgame.com/fw/images/cards/card/en/ST01-001_f.webp",
      },
      {
        role: "back",
        source_url: "https://www.dbs-cardgame.com/fw/images/cards/card/en/ST01-001_b.webp",
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
  assert.equal(variant.card.official_identity.value, leader.card.official_identity.value);
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
  assert.deepEqual(battle.card.game_data.attributes.specified_cost, [{ colour: "red", count: 1 }]);
  assert.deepEqual(
    battle.appearance_evidence.images.map(({ role }) => role),
    ["front"],
  );
  assert.deepEqual(battle.memberships.source_buckets, ["card-set:STORY BOOSTER 01 [ST01]"]);
});

// The exact failure of production run run_967677 on snapshot E-148: the live
// Energy Marker detail publishes no rarity block at all, which the
// pre-optional-card-field generation read as a broken page instead of an
// absent optional field.
const fusionEnergyMarkerUrl = "https://www.dbs-cardgame.com/fw/en/cardlist/detail.php?card_no=E-148";

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

  const marker = detail("fusion-world-en-card-detail-energy-marker", fusionEnergyMarkerUrl);
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

  const variant = detail("fusion-world-en-card-detail-energy-marker-p1", `${fusionEnergyMarkerUrl}&p=_p1`);
  assert.equal(variant.identity_evidence.locator, "E-148_p1");
  assert.equal(variant.identity_evidence.variant_key, "_p1");
  assert.equal(variant.card.official_identity.value, marker.card.official_identity.value);
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
  assert.deepEqual(promo.memberships.source_buckets, ["card-set:Promotion Pack vol.1"]);
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
    mutatedDetail("fusion-world-en-card-detail-promo", '<div class="rarity">PR</div>', ""),
    exactMessage("Fusion World Card detail is missing its rarity."),
    "a Battle Card without a rarity block is still a broken page",
  );
  assert.throws(
    mutatedDetail(
      "fusion-world-en-card-detail-energy-marker",
      '<div class="cardNo">E-148</div>',
      '<div class="cardNo">E-148</div><div class="rarity">C</div>',
    ),
    exactMessage("Fusion World Energy Marker detail must not publish a rarity."),
    "an Energy Marker that publishes a rarity is an unmodelled page",
  );
});

test("the live Fusion World product listing parses its anchored status sections", () => {
  const adapter = fusionLiveShapeAdapter();
  for (const { slug, url, requestId } of fusionProductListingFixtures) {
    const { fixture, observations } = retainedRestructuredParse(adapter, slug, { url, requestId });
    assert.equal(fixture.metadata.source_url, url);
    const products = observations.flatMap((observation) => observation.product_release_catalogue?.products ?? []);
    const accessories = observations.flatMap(
      (observation) => observation.product_release_catalogue?.distribution_contexts ?? [],
    );
    assert.ok(products.length > 0, `${slug} yields Product observations`);
    assert.ok(
      accessories.every(({ kind, label }) => kind === "other" && label === "accessory"),
      `${slug} retains accessory listings as explicit non-card contexts`,
    );
    assert.ok(
      products.every(({ releases }) => releases.length === 1 && releases[0].date !== undefined),
      `${slug} retains exactly one published Release per Product`,
    );
  }

  const hub = retainedRestructuredParse(adapter, "fusion-world-en-products-hub", fusionProductListingFixtures[0]);
  const hubProducts = hub.observations.flatMap((observation) => observation.product_release_catalogue?.products ?? []);
  const winter = hubProducts.find(({ official_code }) => official_code === "FB12");
  assert.deepEqual(winter.releases[0], {
    event_key: "product-release:FB12",
    region: "unknown",
    date: { precision: "season", value: "2026-winter" },
    status: "announced",
  });
  const released = hubProducts.find(({ official_code }) => official_code === "FB10");
  assert.deepEqual(released.releases[0], {
    event_key: "product-release:FB10",
    region: "unknown",
    date: { precision: "day", value: "2026-06-12" },
    status: "released",
  });
});

function retainedFusionErrataDetail(slug, url) {
  const { fixture, observations } = retainedRestructuredParse(fusionLiveShapeAdapter(), slug, {
    url,
    requestId: `fusion-world-en:detail:${restructuredStageDigest}`,
  });
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
  assert.deepEqual(battle.source_sidecar.raw.official_surfaces[0].document.errata_applied, [
    {
      cell: "Skills",
      face: "front",
      notice_url: "https://www.dbs-cardgame.com/fw/en/news/02_22.html",
    },
  ]);

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
  const backFace = leader.card.game_data.attributes.leader_faces.find(({ role }) => role === "back");
  assert.ok(backFace.skills.length > 0);
  assert.ok(!backFace.skills.includes("Errata Notice"));
  assert.deepEqual(leader.source_sidecar.raw.official_surfaces[0].document.errata_applied, [
    {
      cell: "Skills",
      face: "back",
      notice_url: "https://www.dbs-cardgame.com/fw/en/news/02_22.html",
    },
  ]);

  const variant = retainedFusionErrataDetail(
    "fusion-world-en-card-detail-errata-leader-p1",
    fusionErrataDetailFixtures[2].url,
  );
  assert.equal(variant.identity_evidence.locator, "FS10-01_p1");
  assert.equal(variant.identity_evidence.variant_key, "_p1");
  assert.equal(variant.card.official_identity.value, leader.card.official_identity.value);

  const traits = retainedFusionErrataDetail(
    "fusion-world-en-card-detail-errata-traits",
    fusionErrataDetailFixtures[3].url,
  );
  assert.equal(traits.identity_evidence.locator, "FP-088");
  assert.deepEqual(traits.card.game_data.attributes.traits, ["Saiyan", "Earthling", "Master's Teachings"]);
  // The annotation names Special Traits only, so the exact printed Skills
  // claim is retained.
  assert.ok(traits.printing.printed_rules_text.length > 0);
  assert.deepEqual(traits.source_sidecar.raw.official_surfaces[0].document.errata_applied, [
    {
      cell: "Special Traits",
      face: "front",
      notice_url: "https://www.dbs-cardgame.com/fw/en/news/02_22.html",
    },
  ]);
});

const fusionWinterProductUrl = "https://www.dbs-cardgame.com/fw/en/products/01_477.html";

test("the live Fusion World product detail retains its season-precision Release", () => {
  const adapter = fusionLiveShapeAdapter();
  const { fixture, observations } = retainedRestructuredParse(adapter, "fusion-world-en-product-winter-booster", {
    url: fusionWinterProductUrl,
    requestId: `fusion-world-en:product_detail:${restructuredStageDigest}`,
  });
  assert.equal(fixture.metadata.source_url, fusionWinterProductUrl);
  assert.equal(observations.length, 1);
  const [product] = observations[0].product_release_catalogue.products;
  assert.equal(product.official_code, "FB12");
  assert.equal(product.name, "BOOSTER PACK -REACH THE GOD- [FB12]");
  assert.deepEqual(product.releases, [
    {
      event_key: "product-release:FB12",
      region: "unknown",
      date: { precision: "season", value: "2026-winter" },
      status: null,
    },
  ]);
});

test("the live Fusion World legality history parses its exact restriction lift", () => {
  const adapter = fusionLiveShapeAdapter();
  assert.equal(adapter.requestUrlForSurface("legality-history"), fusionLegalityHistoryUrl);
  const { fixture, observations } = retainedRestructuredParse(adapter, "fusion-world-en-legality-history-news", {
    url: fusionLegalityHistoryUrl,
    requestId: "fusion-world-en:legality-history",
  });
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

test("retained live Fusion World product pages promote their coded Products", () => {
  for (const [slug, code, name, date] of [
    ["fusion-world-en-product-story-booster", "ST01", "STORY BOOSTER 01 [ST01]", "2026-08-21"],
    ["fusion-world-en-product-starter-deck", "FS11", "STARTER DECK EX THE PHASE OF EVOLUTION [FS11]", "2026-03-13"],
  ]) {
    const { catalogue } = retainedProductDetail("fusion-world-en", slug);
    assert.deepEqual(
      catalogue.products,
      [
        {
          reference: { kind: "official_code", value: code },
          official_code: code,
          name,
          releases: [
            {
              event_key: `product-release:${code}`,
              region: "unknown",
              date: { precision: "day", value: date },
              status: null,
            },
          ],
        },
      ],
      slug,
    );
  }
});
