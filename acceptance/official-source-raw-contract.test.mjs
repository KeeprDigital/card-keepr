import assert from "node:assert/strict";
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

const productionAdapterVersions = sourceAdapterRegistrations
  .filter(({ origin, reconciliationCapability, parseBytes }) =>
    origin === "production" &&
    reconciliationCapability === "catalogue" &&
    typeof parseBytes === "function"
  )
  .map(({ adapterVersion }) => adapterVersion);

const expectedProductionAdapterVersions = [
  "digimon-en@3",
  "fusion-world-en@3",
  "gundam-en-asia@3",
  "gundam-en-us@3",
  "one-piece-en@2",
];

function registeredProductionAdapters() {
  return productionAdapterVersions.map((adapterVersion) =>
    requiredSourceAdapter(adapterVersion)
  );
}

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
      /-raw-surfaces-with-legality@2$/u,
    );
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

test("official legality entries classify publisher notes as metadata but reject unknown semantic fields", () => {
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
    publisher_note: "This publisher note is retained only as source metadata.",
  };
  const observation = officialLegalityRulesObservation(
    "fusion-world",
    "fusion-world-en",
    { entries: [entry] },
  );
  assert.equal(observation.legality_rules[0].official_wording, entry.notice);
  assert.equal("publisher_note" in observation.legality_rules[0], false);
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
  const observations = current.parseBytes(
    new TextEncoder().encode(`
      <html><head><title>Bandai Dragon Ball Fusion World Restriction Rules</title></head>
      <body><h1>Restriction Rules</h1>
        <article class="unversioned-rule">FB01-001 might be restricted someday.</article>
      </body></html>`),
    fusionLegalityContext(current),
  );
  assert.equal(
    observations.some(({ observation_type }) =>
      observation_type === "legality_rules"
    ),
    false,
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

test("One Piece aggregate JSON-LD retains an explicit first Printing identity", () => {
  const adapter = registeredProductionAdapters().find(
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

test("every production lineage parses its exact real HTML policy surfaces", () => {
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
        `<html><script type="application/ld+json">${
          JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Dataset",
            publisher: { "@type": "Organization", name: "Bandai" },
            hasPart: [{
              "@type": "Dataset",
              identifier: `fusion-world-en:${surface}`,
              payload,
            }],
          })
        }</script></html>`,
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
        `<html><script type="application/ld+json">${
          JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Dataset",
            publisher: { "@type": "Organization", name: "Bandai" },
            hasPart: [{
              "@type": "Dataset",
              identifier: `fusion-world-en:${surface}`,
              payload,
            }],
          })
        }</script></html>`,
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
  const adapter = requiredSourceAdapter("fusion-world-en@2");
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
  const publication = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    publisher: { "@type": "Organization", name: "Bandai" },
    hasPart: [{
      "@type": "Dataset",
      identifier: `${adapter.sourceLineage}:${surface}`,
      payload,
    }],
  };
  return adapter.parseBytes(
    new TextEncoder().encode(
      `<html><title>BANDAI Official publication</title>
       <script type="application/ld+json">${
        JSON.stringify(publication).replaceAll("<", "\\u003c")
      }</script>`,
    ),
    {
      mediaType: "text/html; charset=utf-8",
      url: adapter.requestUrlForSurface(surface),
      requestId: `${adapter.sourceLineage}:${surface}`,
    },
  );
}
