export function contextualLegalityDocument(
  region,
  representable = true,
  membershipVariant = null,
  {
    copyLimit = null,
    rules: rulesVariant = null,
    semantics = null,
    surface = "discovery",
    requestUrl =
      "https://www.gundam-gcg.com/asia-en/contextual-legality",
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
    legalityRules.length = 0;
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
  return officialSurfaceDocument(
    region,
    surface,
    requestUrl,
    cards,
    legalityRules,
  );
}

const requiredSurfaces = [
  "discovery",
  "legality_card_details",
  "legality_rules",
  "legality_history",
];

function officialSurfaceDocument(
  region,
  surface,
  requestUrl,
  cards,
  legalityRules,
) {
  const records =
    surface === "discovery"
      ? discoveredSurfaces(requestUrl)
      : surface === "legality_card_details"
        ? cards.map((card) => officialLegalityCardDetail(card, requestUrl))
        : surface === "legality_rules"
          ? legalityRules.map((rule) => officialLegalityNotice(rule, requestUrl))
          : [
              {
                source_id: `${surface}-representative`,
                source_url: requestUrl,
                retained_label:
                  `Representative live ${surface.replaceAll("_", " ")} record`,
              },
            ];
  return {
    surface: completeSurface(region, surface, records),
  };
}

function discoveredSurfaces(requestUrl) {
  const seed = new URL(requestUrl);
  seed.searchParams.delete("surface");
  return requiredSurfaces
    .filter((surface) => surface !== "discovery")
    .map((surface) => {
      const url = new URL(seed);
      url.searchParams.set("surface", surface);
      return { request_id: surface, surface, url: url.href };
    });
}

function officialLegalityCardDetail(observation, requestUrl) {
  const sourceUrl = new URL(requestUrl);
  const imageUrl = new URL(
    `images/${observation.card.official_identity.value}.png`,
    `${sourceUrl.origin}${sourceUrl.pathname.startsWith("/asia-en/") ? "/asia-en/" : "/en/"}`,
  );
  if (sourceUrl.searchParams.get("image-authority") === "foreign") {
    imageUrl.hostname = "attacker.example";
  }
  return {
    source_id: observation.card.official_identity.value,
    source_url: requestUrl,
    card_number: observation.card.official_identity.value,
    title: observation.card.name,
    rules_text: observation.card.effective_rules_text,
    detail: observation.card.game_data.attributes,
    printing: {
      rarity_raw: observation.printing.rarity.raw,
      rarity_normalized: observation.printing.rarity.normalized,
      printed_text: observation.printing.printed_rules_text,
      detail: observation.printing.game_data.attributes,
      locator: observation.identity_evidence.locator,
      variant_key: observation.identity_evidence.variant_key,
      artwork_fingerprint: observation.identity_evidence.artwork_fingerprint,
      printed_fields_digest:
        observation.identity_evidence.printed_fields_digest,
      treatment: observation.identity_evidence.treatment,
      image_url: imageUrl.href,
    },
  };
}

function officialLegalityNotice(rule, requestUrl) {
  return {
    source_id: rule.id,
    source_url: requestUrl,
    notice_id: rule.id,
    official_text: rule.official_wording,
    scope: {
      region: rule.region,
      format: rule.format,
      event_tier: rule.event_tier,
      effective_from: rule.effective_from,
      effective_until: rule.effective_until,
    },
    affected_card_numbers: rule.card_numbers,
    action: rule.effect,
    representable: rule.representable,
  };
}

function completeSurface(partition, name, records) {
  return {
    name,
    partition,
    declared_record_count: records.length,
    pages:
      records.length === 0
        ? []
        : [
            {
              number: 1,
              total_pages: 1,
              declared_record_count: records.length,
              records,
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
    ];
  }
  return [
    {
      ...base,
      id: "legality_rule_asia_eligible",
      card_numbers: [],
      official_wording:
        `Cafe\u0301 serialization golden ${serializationNoise(24_000)}`,
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
      official_wording: `${id} is an ordering fixture rule.`,
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

function completeEvidence() {
  return {
    structurally_complete: true,
    required_surfaces_complete: true,
    partitions_complete: true,
    declared_record_count: 1,
    parsed_record_count: 1,
  };
}
