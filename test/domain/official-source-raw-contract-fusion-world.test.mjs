import { test } from "vitest";
import assert from "node:assert/strict";
import { requiredSourceAdapter } from "../../src/catalogue/adapters/source-adapters.ts";
import {
  registeredProductionAdapters,
  retainedOfficialSourceFixture,
  restructuredStageDigest,
  retainedRestructuredParse,
  retainedRestructuredRequests,
  exactMessage,
  fusionLiveShapeAdapter,
  fusionProductListingFixtures,
  fusionErrataDetailFixtures,
  retainedProductDetail,
} from "./official-source-raw-contract-shared.mjs";

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
