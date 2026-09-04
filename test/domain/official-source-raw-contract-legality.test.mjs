import { test } from "vitest";
import assert from "node:assert/strict";
import { officialLegalityRulesObservation } from "../../src/catalogue/adapters/official-legality-source-adapters.ts";
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
import {
  registeredProductionAdapters,
  retainedOfficialSourceFixture,
  fusionLegalityContext,
  exactFusionLegalityHtml,
  exactMessage,
  fusionLiveShapeAdapter,
  fusionLegalityHistoryUrl,
  rawSurfacePayload,
  parseRegisteredSurface,
} from "./official-source-raw-contract-shared.mjs";

test("notice-link-only legality publications fail closed at the raw Official Source boundary", () => {
  for (const adapter of registeredProductionAdapters()) {
    const surface = adapter.requiredSurfaces.find(
      (candidate) =>
        /(?:legality|restriction|block-policy|don-rules)/u.test(candidate) ||
        (adapter.sourceLineage === "one-piece-en" && candidate === "releases"),
    );
    assert.ok(surface);
    for (const declaredEmpty of [false, true]) {
      assert.throws(
        () =>
          adapter.parseBytes(
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

function fusionLegalityRuleHtml({ id, wording, cards, directive, effectFields = "" }) {
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
  const legality = observations.find(({ observation_type }) => observation_type === "legality_rules");
  assert.deepEqual(legality.completeness, {
    structurally_complete: true,
    required_surfaces_complete: true,
    partitions_complete: true,
    declared_record_count: 2,
    parsed_record_count: 2,
  });
  assert.equal(legality.legality_rules.length, 2);
  assert.equal(legality.legality_rules[0].official_wording, "FB01-001 is banned from standard tournament decks.");
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
    ...["section", "aside", "span", "strong", "em", "blockquote", "h2", "table", "header"].map(
      (tag) => `<${tag}>FB01-099 is unavailable for decks.</${tag}>`,
    ),
    `<header><nav><a href="/fw/en/cardlist/">CARDS</a></nav>
      <p>FB01-099 is unavailable for decks.</p></header>`,
  ];

  for (const notice of unmodeledNotices) {
    const html = exactFusionLegalityHtml.replace("</body>", `${notice}</body>`);
    assert.throws(
      () => current.parseBytes(new TextEncoder().encode(html), fusionLegalityContext(current)),
      /exact, complete Legality Rule parser/iu,
    );
  }
});

test("structured legality publisher data cannot hide unmodeled sibling HTML", () => {
  const current = requiredSourceAdapter("fusion-world-en@9");
  const nonempty = rawSurfacePayload("fusion-world-en", "legality-current");
  nonempty.entries = [
    {
      rule_ref: "FW-2026-SCRIPT-SIBLING",
      notice: "FB30-001 is banned from standard tournament decks.",
      market: "EN-OCEANIA",
      play_format: "standard",
      tier: null,
      active_on: "2026-07-01",
      expires_on: null,
      cards: ["FB30-001"],
      directive: "ban",
    },
  ];
  nonempty.declared_record_count = 1;
  nonempty.partition.total = 1;
  const eligible = structuredClone(nonempty);
  eligible.entries[0].notice = "FB30-001 is legal for Standard play.";
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
    ["zero-rule article", empty, "<article>FB01-099 is unavailable for decks.</article>"],
    ["zero-rule strong", empty, "<strong>FB01-099 is unavailable for decks.</strong>"],
    ["nonzero unknown sibling", nonempty, "<em>Additional tournament restriction applies.</em>"],
    ["structured eligible plus conflicting visible ban", eligible, `<p>1 record</p>${conflictingArticle}`],
    ["structured eligible plus extra visible rule", eligible, `<p>2 records</p>${eligibleArticle}${extraArticle}`],
    ["structured eligible missing its visible rule", eligible, "<p>1 record</p>"],
  ]) {
    assert.throws(
      () =>
        current.parseBytes(
          new TextEncoder().encode(
            `<html><title>BANDAI Official publication</title>
           ${officialPublisherPayloadScript("fusion-world-en", "legality-current", payload)}${sibling}</html>`,
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
  payload.entries = [
    {
      rule_ref: "FW-2026-STRUCTURED-VISIBLE",
      notice: "FB30-001 is legal for Standard play.",
      market: "EN-OCEANIA",
      play_format: "standard",
      tier: null,
      active_on: "2026-07-01",
      expires_on: null,
      cards: ["FB30-001"],
      directive: "eligible",
    },
  ];
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
  const legality = observations.find(({ observation_type }) => observation_type === "legality_rules");
  assert.equal(legality.legality_rules[0].id, "FW-2026-STRUCTURED-VISIBLE");
  assert.deepEqual(legality.legality_rules[0].effect, { type: "eligible" });
});

test("structured legality consumes only the exact lineage and surface publisher script", () => {
  const current = requiredSourceAdapter("fusion-world-en@9");
  const currentEmpty = rawSurfacePayload("fusion-world-en", "legality-current");
  const currentNonempty = structuredClone(currentEmpty);
  currentNonempty.entries = [
    {
      rule_ref: "FW-2026-EXACT-SCRIPT",
      notice: "FB30-001 is banned from standard tournament decks.",
      market: "EN-OCEANIA",
      play_format: "standard",
      tier: null,
      active_on: "2026-07-01",
      expires_on: null,
      cards: ["FB30-001"],
      directive: "ban",
    },
  ];
  currentNonempty.declared_record_count = 1;
  currentNonempty.partition.total = 1;
  for (const [name, payload, siblingSurface] of [
    ["zero current plus history", currentEmpty, "legality-history"],
    ["nonzero current plus policy", currentNonempty, "block-policy"],
    ["nonzero current plus unknown", currentNonempty, "unknown-policy"],
  ]) {
    assert.throws(
      () =>
        current.parseBytes(
          new TextEncoder().encode(
            `<html><title>BANDAI DRAGON BALL CARD RULE RESTRICTION</title>
           ${officialPublisherPayloadScript("fusion-world-en", "legality-current", payload)}
           ${officialPublisherPayloadScript("fusion-world-en", siblingSurface, currentEmpty)}</html>`,
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
      () =>
        current.parseBytes(
          new TextEncoder().encode(
            `<html><title>BANDAI DRAGON BALL CARD RULE RESTRICTION</title>
           ${officialPublisherPayloadScript("fusion-world-en", "legality-current", currentEmpty)}
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
    () =>
      current.parseBytes(
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

test("current production legality parser accepts a complete multi-rule publication with only bounded publisher framing", () => {
  const current = requiredSourceAdapter("fusion-world-en@9");
  const legality = current
    .parseBytes(new TextEncoder().encode(exactFusionLegalityHtml), fusionLegalityContext(current))
    .find(({ observation_type }) => observation_type === "legality_rules");
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
  const legality = observations.find(({ observation_type }) => observation_type === "legality_rules");
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
  const legality = observations.find(({ observation_type }) => observation_type === "legality_rules");
  assert.deepEqual(legality.legality_rules, []);
  assert.equal(legality.completeness.declared_record_count, 0);
  assert.equal(legality.completeness.parsed_record_count, 0);
});

test("current production legality parser blocks a publisher total that disagrees with exact articles", () => {
  const current = requiredSourceAdapter("fusion-world-en@9");
  assert.throws(
    () =>
      current.parseBytes(
        new TextEncoder().encode(exactFusionLegalityHtml.replace("2 records", "3 records")),
        fusionLegalityContext(current),
      ),
    /declares 3 records but exactly 2 were parsed/u,
  );
});

test("current production legality parser rejects negated bans and copy limits whose wording disagrees with the declared cap", () => {
  const current = requiredSourceAdapter("fusion-world-en@9");
  assert.throws(
    () =>
      current.parseBytes(
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
    () =>
      current.parseBytes(
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
      effectFields: "<dt>Tournament Legal Date</dt><dd>2026-09-04</dd>",
    }),
  );
  const observations = current.parseBytes(new TextEncoder().encode(valid), fusionLegalityContext(current));
  const legality = observations.find(({ observation_type }) => observation_type === "legality_rules");
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
    ["Blocks 05 and 06 are eligible for rotation.", "Blocks 05 and 06 are not eligible for rotation.", /rotation/u],
    [
      "Blocks 05 and 06 are eligible for rotation.",
      "Blocks 05 and 06 are not currently eligible for rotation.",
      /rotation/u,
    ],
    ["Blocks 05 and 06 are eligible for rotation.", "Blocks 05 and 07 are eligible for rotation.", /operand 06/u],
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
      () =>
        current.parseBytes(new TextEncoder().encode(valid.replace(original, wording)), fusionLegalityContext(current)),
      mismatch,
    );
  }

  for (const [structured, mismatch] of [
    [
      valid.replace("<dt>Filter Values</dt><dd>Saiyan, Earthling</dd>", "<dt>Filter Values</dt><dd>Saiyan</dd>"),
      /wording membership values/iu,
    ],
    [valid.replace("<dt>Blocks</dt><dd>05, 06</dd>", "<dt>Blocks</dt><dd>05</dd>"), /wording rotation blocks/iu],
    [
      valid.replace(
        "FB01-010 and FB01-011 may not be used together in the same deck.",
        "FB01-010, FB01-011 and FB01-012 may not be used together in the same deck.",
      ),
      /wording target and companion Cards/iu,
    ],
  ]) {
    assert.throws(
      () => current.parseBytes(new TextEncoder().encode(structured), fusionLegalityContext(current)),
      mismatch,
    );
  }
});

test("current production legality parser rejects modifier-scoped eligible negation", () => {
  const current = requiredSourceAdapter("fusion-world-en@9");
  const html = fusionLegalityPage(
    fusionLegalityRuleHtml({
      id: "FW-2026-NEGATED-ELIGIBLE",
      wording: "FB01-030 is not tournament legal for Standard play.",
      cards: ["FB01-030"],
      directive: "eligible",
    }),
  );
  assert.throws(
    () => current.parseBytes(new TextEncoder().encode(html), fusionLegalityContext(current)),
    /wording contradicts directive eligible/u,
  );
});

test("current production legality parser rejects mixed directives and foreign operands", () => {
  const current = requiredSourceAdapter("fusion-world-en@9");
  const mixed = fusionLegalityPage(
    fusionLegalityRuleHtml({
      id: "FW-2026-MIXED-ELIGIBLE",
      wording: "FB01-030 is legal for Standard play, but decks are limited to 1 copy.",
      cards: ["FB01-030"],
      directive: "eligible",
      effectFields: "<dt>Cap</dt><dd>1</dd>",
    }),
  );
  assert.throws(
    () => current.parseBytes(new TextEncoder().encode(mixed), fusionLegalityContext(current)),
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
    const html = fusionLegalityPage(
      fusionLegalityRuleHtml({
        id: `FW-2026-CONDITIONAL-BAN-${name}`,
        wording,
        cards: ["FB01-030"],
        directive: "ban",
      }),
    );
    assert.throws(
      () => current.parseBytes(new TextEncoder().encode(html), fusionLegalityContext(current)),
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
        id: "notice_no",
        wording: "published_text",
        region: "territory",
        format: "format_name",
        tier: "event_class",
        from: "start_date",
        until: "end_date",
        cards: "card_numbers",
        directive: "restriction_code",
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
        id: "rule_ref",
        wording: "notice",
        region: "market",
        format: "play_format",
        tier: "tier",
        from: "active_on",
        until: "expires_on",
        cards: "cards",
        directive: "directive",
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
        id: "restriction_id",
        wording: "body",
        region: "language_scope",
        format: "ruleset",
        tier: "tournament_level",
        from: "applies_from",
        until: "applies_until",
        cards: "card_ids",
        directive: "status_code",
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
        id: "news_id",
        wording: "text",
        region: "region",
        format: "format",
        tier: "event_tier",
        from: "effective_date",
        until: "end_date",
        cards: "card_numbers",
        directive: "ruling",
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
    assert.doesNotThrow(() => parseRegisteredSurface(adapter, descriptor.surface, payload), descriptor.adapter);

    for (const [name, changed] of [
      ["unknown structured region", { [descriptor.fields.region]: "EUROPE" }],
      [
        "unknown wording region",
        {
          [descriptor.fields.wording]: `${descriptor.card} is eligible for Standard events in the EUROPE region.`,
        },
      ],
      [
        "known inconsistent region alias",
        {
          [descriptor.fields.wording]: `${descriptor.card} is eligible for Standard events in the ${
            descriptor.region === "EN-US" ? "Asia" : "North America"
          } region.`,
        },
      ],
      [
        "conditional leading prose",
        {
          [descriptor.fields.wording]: `If your Leader is red, ${descriptor.card} is eligible for Standard play.`,
        },
      ],
      [
        "event-scoped leading prose",
        {
          [descriptor.fields.wording]: `During regional events, ${descriptor.card} is eligible for Standard play.`,
        },
      ],
      [
        "unknown regional leading prose",
        {
          [descriptor.fields.wording]: `In Europe, ${descriptor.card} is eligible for Standard play.`,
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
      [descriptor.fields.wording]: "Cards satisfying the published Standard eligibility rules may be used.",
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
      [descriptor.fields.wording]: `${descriptor.card} is eligible under the published Championship-only rule.`,
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
  const html = fusionLegalityPage(
    fusionLegalityRuleHtml({
      id: "FW-2026-BLOCK-TEXT",
      wording:
        "<p>FB01-030 is legal for Standard play.</p><ul><li>Publisher notice:</li><li>Effective immediately.</li></ul>",
      cards: ["FB01-030"],
      directive: "eligible",
    }),
  );
  const legality = current
    .parseBytes(new TextEncoder().encode(html), fusionLegalityContext(current))
    .find(({ observation_type }) => observation_type === "legality_rules");
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
    }).replace("</article>", "<p>Except at championship events, where it is banned.</p></article>"),
  );
  assert.throws(
    () => current.parseBytes(new TextEncoder().encode(html), fusionLegalityContext(current)),
    /residual semantic content/u,
  );
});

test("current production legality parser rejects definitive unresolved wording and missing combination sides", () => {
  const current = requiredSourceAdapter("fusion-world-en@9");
  for (const html of [
    fusionLegalityPage(
      fusionLegalityRuleHtml({
        id: "FW-2026-UNRESOLVED-CONTRADICTION",
        wording: "FB01-030 is banned from Standard decks.",
        cards: ["FB01-030"],
        directive: "unresolved",
        effectFields: "<dt>Ambiguity</dt><dd>Publisher scope is unknown</dd>",
      }),
    ),
    fusionLegalityPage(
      fusionLegalityRuleHtml({
        id: "FW-2026-COMBINATION-MISSING-DIRECT",
        wording: "FB01-031 and FB01-032 are a prohibited combination.",
        cards: [],
        directive: "prohibited_combination",
        effectFields: "<dt>Paired Cards</dt><dd>FB01-032</dd>",
      }),
    ),
  ]) {
    assert.throws(
      () => current.parseBytes(new TextEncoder().encode(html), fusionLegalityContext(current)),
      /unresolved|Card numbers|additional structured semantics/u,
    );
  }
  assert.throws(
    () =>
      officialLegalityRulesObservation("fusion-world", "fusion-world-en", {
        entries: [
          {
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
          },
        ],
      }),
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
  assert.throws(() => parseRegisteredSurface(current, "legality-current", truncated), /partition/u);
  const unknown = rawSurfacePayload("fusion-world-en", "legality-current");
  unknown.future_scope = "championship-only";
  assert.throws(() => parseRegisteredSurface(current, "legality-current", unknown), /unknown field future_scope/u);
});

test("current production legality HTML decodes entities exactly once", () => {
  const current = requiredSourceAdapter("fusion-world-en@9");
  const html = fusionLegalityPage(
    fusionLegalityRuleHtml({
      id: "FW-2026-ENTITIES",
      wording: "FB01-030 is legal &#39;as printed&#39; &#x2013; publisher&ndash;confirmed &amp;#39;literal&amp;#39;.",
      cards: ["FB01-030"],
      directive: "eligible",
    }),
  );
  const observations = current.parseBytes(new TextEncoder().encode(html), fusionLegalityContext(current));
  const legality = observations.find(({ observation_type }) => observation_type === "legality_rules");
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
      () =>
        officialLegalityRulesObservation("fusion-world", "fusion-world-en", {
          entries: [{ ...entry, publisher_note: publisherNote }],
        }),
      /unknown field publisher_note/iu,
    );
  }
  assert.throws(
    () =>
      officialLegalityRulesObservation("fusion-world", "fusion-world-en", {
        entries: [{ ...entry, future_scope: "championship-only" }],
      }),
    /unknown field future_scope/u,
  );
});

test("current production legality parser fails closed for loose unknown rule markup", () => {
  const current = requiredSourceAdapter("fusion-world-en@9");
  assert.throws(
    () =>
      current.parseBytes(
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

test("the legality-history lift remains fail-closed on any drifted prose", () => {
  const adapter = fusionLiveShapeAdapter();
  const fixture = retainedOfficialSourceFixture("fusion-world-en-legality-history-news");
  const html = fixture.bytes.toString("utf8");
  const from = "please refer to the Rules page.";
  assert.ok(html.includes(from));
  assert.throws(
    () =>
      adapter.parseBytes(
        new TextEncoder().encode(
          html.replace(from, "please refer to the Rules page. Further cards may be restricted."),
        ),
        {
          mediaType: fixture.metadata.content_type,
          url: fusionLegalityHistoryUrl,
          requestId: "fusion-world-en:legality-history",
        },
      ),
    exactMessage("Fusion World history policy contains unconsumed prose or structure."),
  );
});
