export function contextualLegalityDomainDocument(
  region,
  representable = true,
  membershipVariant = null,
  {
    copyLimit = null,
    order = null,
    rules: rulesVariant = null,
    semantics = null,
  } = {},
) {
  const numbers =
    region === "EN-ASIA"
      ? [
          "GD30-001",
          "GD30-002",
          "GD30-003",
          "GD30-004",
          "GD30-005",
        ]
      : ["GD30-001"];
  const cards = numbers.map(gundamObservation);
  const legalityRules = rules(region).map((rule) => ({
    ...rule,
    representable,
  }));
  if (membershipVariant !== null) {
    const membership = legalityRules.find(
      (rule) => rule.id === "legality_rule_asia_membership",
    );
    membership.effect =
      membershipVariant === "unknown-attribute"
        ? {
            type: "membership",
            attribute: "traitz",
            includes_any: ["Earth Federation"],
          }
        : {
            type: "membership",
            attribute: "colours",
            includes_any: ["bluue"],
          };
  }
  if (semantics === "changed") {
    const eligible = legalityRules.find(
      (rule) => rule.id === "legality_rule_asia_eligible",
    );
    eligible.official_wording =
      "Cards satisfying the changed Standard policy are not legal.";
    eligible.effect = { type: "ban" };
  }
  if (copyLimit === "zero") {
    const copyLimitRule = legalityRules.find(
      (rule) => rule.id === "legality_rule_asia_copy_limit",
    );
    copyLimitRule.effect = {
      type: "copy_limit",
      maximum_copies: 0,
    };
  }
  if (rulesVariant === "empty") {
    const retainedHistory = legalityRules.filter(
      (rule) => rule.effective_until !== null,
    );
    legalityRules.splice(0, legalityRules.length, ...retainedHistory);
  }
  if (rulesVariant === "expanded" && region === "EN-US") {
    legalityRules.push({
      game: "gundam",
      region,
      format: "standard",
      event_tier: null,
      effective_from: "2026-01-01",
      effective_until: null,
      id: "legality_rule_us_expanded",
      card_numbers: ["GD30-001"],
      official_wording:
        "GD30-001 is also eligible under the expanded EN-US notice.",
      effect: { type: "eligible" },
      representable,
    });
  }
  if (order === "reversed") legalityRules.reverse();
  return {
    cards,
    legality_rules: legalityRules,
    legality_completeness: completeEvidence(legalityRules.length),
  };
}

export function donLegalityDomainDocument() {
  const completeness = completeEvidence();
  const baseRule = {
    game: "one-piece",
    region: "EN-OCEANIA",
    format: "standard",
    event_tier: null,
    effective_from: "2026-01-01",
    effective_until: null,
    card_numbers: ["DON!!"],
    representable: true,
  };
  return {
    legality_completeness: completeEvidence(4),
    cards: [
      {
        card: {
          game: "one-piece",
          official_identity: {
            kind: "functional_designation",
            value: "DON!!",
          },
          name: "DON!!",
          effective_rules_text: "Your turn +1000 power.",
          game_data: {
            profile: "one-piece@1",
            attributes: {
              card_type: "don",
              colours: [],
              cost: null,
              life: null,
              battle_attributes: [],
              power: null,
              counter: null,
              traits: [],
              block_icons: [],
              effect_text: "Your turn +1000 power.",
              trigger_text: null,
            },
          },
        },
        completeness,
        memberships: {
          products: [],
          distribution_contexts: [],
          source_buckets: ["don-rules"],
        },
      },
      {
        card: {
          game: "one-piece",
          official_identity: {
            kind: "card_number",
            value: "OP30-001",
          },
          name: "DON!! combination companion",
          effective_rules_text: "Official effective rules.",
          game_data: {
            profile: "one-piece@1",
            attributes: {
              card_type: "leader",
              colours: ["red"],
              cost: null,
              life: 5,
              battle_attributes: ["strike"],
              power: 5_000,
              counter: null,
              traits: ["DON!! Companion"],
              block_icons: ["1"],
              effect_text: "Official effective rules.",
              trigger_text: null,
            },
          },
        },
        completeness,
        memberships: {
          products: [],
          distribution_contexts: [],
          source_buckets: ["card-list"],
        },
      },
    ],
    legality_rules: [
      {
        ...baseRule,
        id: "don-ban",
        official_wording: "DON!! may not be included in a deck.",
        effect: { type: "ban" },
      },
      {
        ...baseRule,
        id: "don-copy-limit",
        official_wording: "Decks may contain one copy of DON!!.",
        effect: { type: "copy_limit", maximum_copies: 1 },
      },
      {
        ...baseRule,
        id: "don-combination",
        official_wording:
          "DON!! and OP30-001 may not be included in the same deck.",
        effect: {
          type: "prohibited_combination",
          with_card_numbers: ["OP30-001"],
        },
      },
      {
        ...baseRule,
        id: "don-unresolved",
        official_wording: "The secondary DON!! scope is unresolved.",
        effect: {
          type: "unresolved",
          reason: "The notice omits the secondary event scope.",
        },
      },
    ],
  };
}

function rules(region) {
  const base = {
    game: "gundam",
    region,
    format: "standard",
    event_tier: null,
    effective_from: "2026-01-01",
    effective_until: null,
  };
  if (region === "EN-US") {
    return [
      {
        ...base,
        id: "legality_rule_us_eligible",
        card_numbers: ["GD30-001"],
        official_wording:
          "GD30-001 is eligible for Standard events in the EN-US region.",
        effect: { type: "eligible" },
      },
      {
        ...base,
        id: "legality_rule_us_history",
        effective_from: "2025-01-01",
        effective_until: "2025-06-01",
        card_numbers: ["GD30-001"],
        official_wording:
          "GD30-001 was banned and may not be included before 1 June 2025.",
        effect: { type: "ban" },
      },
    ];
  }
  return [
    {
      ...base,
      id: "legality_rule_asia_eligible",
      card_numbers: [],
      official_wording:
        `Cafe\u0301 cards satisfying the published Standard eligibility rules are eligible for play. ${serializationNoise(24_000)}`,
      effect: { type: "eligible" },
    },
    {
      ...base,
      id: "legality_rule_asia_copy_limit",
      event_tier: "championship",
      card_numbers: ["GD30-002"],
      official_wording:
        "For Championship events, decks may contain no more than one copy of GD30-002.",
      effect: { type: "copy_limit", maximum_copies: 1 },
    },
    {
      ...base,
      id: "legality_rule_asia_combination",
      card_numbers: ["GD30-002"],
      official_wording:
        "GD30-002 and GD30-003 may not be included in the same deck.",
      effect: {
        type: "prohibited_combination",
        with_card_numbers: ["GD30-003"],
      },
    },
    {
      ...base,
      id: "legality_rule_asia_ban",
      card_numbers: ["GD30-003"],
      official_wording: "GD30-003 may not be included in a deck.",
      effect: { type: "ban" },
    },
    {
      ...base,
      id: "legality_rule_asia_membership",
      card_numbers: ["GD30-001"],
      official_wording:
        "Cards with the Earth Federation trait are eligible for this event.",
      effect: {
        type: "membership",
        attribute: "traits",
        includes_any: ["Earth Federation"],
      },
    },
    {
      ...base,
      id: "legality_rule_asia_rotation",
      card_numbers: ["GD30-001"],
      official_wording: "Only cards bearing Block 1 are eligible.",
      effect: { type: "rotation", eligible_blocks: ["1"] },
    },
    {
      ...base,
      id: "legality_rule_asia_release_timing",
      effective_from: "2025-01-01",
      card_numbers: ["GD30-001"],
      official_wording:
        "GD30-001 becomes legal for tournament play on 1 January 2026.",
      effect: { type: "release_timing", legal_from: "2026-01-01" },
    },
    {
      ...base,
      id: "legality_rule_asia_expired",
      effective_from: "2025-01-01",
      effective_until: "2025-06-01",
      card_numbers: ["GD30-001"],
      official_wording:
        "GD30-001 was not legal before the temporary restriction ended on 1 June 2025.",
      effect: { type: "ban" },
    },
    {
      ...base,
      id: "legality_rule_asia_unresolved_scope",
      card_numbers: ["GD30-004"],
      official_wording:
        "The official notice does not identify whether GD30-004 applies to Championship side events.",
      effect: {
        type: "unresolved",
        reason: "The event-tier scope is absent from the official notice.",
      },
    },
    {
      ...base,
      id: "legality_rule_asia_nullable_membership",
      card_numbers: ["GD30-005"],
      official_wording:
        "Cards with the published link condition are eligible for this event.",
      effect: {
        type: "membership",
        attribute: "link_condition",
        includes_any: ["Earth Federation"],
      },
    },
    ...[
      "Order-A",
      "Order.A",
      "Order:A",
      "Order_A",
      "Order_a",
    ].map((id) => ({
      ...base,
      id,
      card_numbers: ["GD30-005"],
      official_wording:
        `${id} is eligible under the published ordering rule.`,
      effect: { type: "eligible" },
    })),
  ];
}

function serializationNoise(length) {
  let state = 0x30cafe;
  let value = "";
  while (value.length < length) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    value += String.fromCharCode(33 + (state % 90));
  }
  return value;
}

function gundamObservation(cardNumber) {
  const numeric = cardNumber.replace(/[^0-9]/g, "");
  const artwork = `sha256:${numeric.padEnd(64, "0").slice(0, 64)}`;
  return {
    card: {
      game: "gundam",
      official_identity: { kind: "card_number", value: cardNumber },
      name: `Contextual legality ${cardNumber}`,
      effective_rules_text: "Official effective rules",
      game_data: {
        profile: "gundam@1",
        attributes: {
          card_type: "unit",
          colours: ["blue"],
          level: 4,
          cost: 3,
          block_icon: "1",
          effect_text: "Official effect",
          zone: "space",
          traits: ["Earth Federation"],
          link_condition: null,
          ap: 3,
          hp: 4,
          series_titles: ["Mobile Suit Gundam"],
        },
      },
    },
    printing: {
      rarity: { raw: "R", normalized: "rare" },
      printed_rules_text: "Official printed rules",
      game_data: {
        profile: "gundam@1",
        attributes: { alternate_art: false },
      },
    },
    identity_evidence: {
      locator: `/official/gundam/contextual-legality/${cardNumber}`,
      variant_key: "base",
      artwork_fingerprint: artwork,
      printed_fields_digest: `sha256:${numeric
        .padEnd(64, "1")
        .slice(0, 64)}`,
      treatment: "standard",
      demonstrably_novel: true,
      novelty_basis: {
        kind: "official_printing_image",
        source_url: `https://www.gundam-gcg.com/asia-en/images/${cardNumber}.png`,
        artwork_fingerprint: artwork,
      },
    },
    appearance_evidence: {
      images: [
        {
          role: "front",
          source_url: `https://www.gundam-gcg.com/asia-en/images/${cardNumber}.png`,
          artwork_fingerprint: artwork,
          media_type: "image/png",
          width: 1,
          height: 1,
          content_sha256:
            "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
          content_base64: "AA==",
        },
      ],
    },
    completeness: completeEvidence(),
    memberships: {
      products: ["product_gd30"],
      distribution_contexts: [],
      source_buckets: ["gundam-card-list"],
    },
  };
}

function completeEvidence(recordCount = 1) {
  return {
    structurally_complete: true,
    required_surfaces_complete: true,
    partitions_complete: true,
    declared_record_count: recordCount,
    parsed_record_count: recordCount,
  };
}
