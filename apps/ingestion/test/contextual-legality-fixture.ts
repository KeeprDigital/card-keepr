type Region = "EN-ASIA" | "EN-US";

export function contextualLegalitySourceDocument(
  region: Region,
  surface: string,
  requestUrl: string,
) {
  const cardNumbers =
    region === "EN-ASIA"
      ? ["GD30-001", "GD30-002", "GD30-003", "GD30-004"]
      : ["GD30-001"];
  const cards = cardNumbers.map(gundamObservation);
  const rules = legalityRules(region);
  const records =
    surface === "discovery"
      ? discoveredSurfaces(requestUrl)
      : surface === "legality_card_details"
        ? cards.map((card) => rawGundamCard(card, requestUrl))
        : surface === "legality_rules"
          ? rules
              .filter((rule) => rule.effective_until === null)
              .map((rule) => rawGundamNotice(rule, requestUrl))
          : surface === "legality_history"
            ? rules
                .filter((rule) => rule.effective_until !== null)
                .map((rule) => rawGundamNotice(rule, requestUrl))
            : [];
  return {
    gundam: {
      endpoint: surface,
      locale: region,
      hits: records.length,
      results: records,
    },
  };
}

export function contextualLegalityFixtureDocument(
  region: Region,
  rulesVariant:
    | "current"
    | "omitted"
    | "empty"
    | "omit-event-tier"
    | "omit-effective-until" = "current",
) {
  const cardNumbers =
    region === "EN-ASIA"
      ? ["GD30-001", "GD30-002", "GD30-003", "GD30-004"]
      : ["GD30-001"];
  const cards = cardNumbers.map(gundamObservation);
  if (rulesVariant === "omitted") return { cards };
  const retainedRules = rulesVariant === "empty"
    ? []
    : legalityRules(region).map((rule, index) => {
        if (index !== 0) return rule;
        if (rulesVariant === "omit-event-tier") {
          const { event_tier: _eventTier, ...withoutEventTier } = rule;
          return withoutEventTier;
        }
        if (rulesVariant === "omit-effective-until") {
          const {
            effective_until: _effectiveUntil,
            ...withoutEffectiveUntil
          } = rule;
          return withoutEffectiveUntil;
        }
        return rule;
      });
  return {
    cards,
    legality_rules: retainedRules,
    legality_completeness: completeEvidence(),
  };
}

const requiredSurfaces = [
  "discovery",
  "legality_card_details",
  "legality_rules",
  "legality_history",
];

export function onePiecePolicySourceDocument(
  surface: string,
  requestUrl: string,
) {
  const surfaces = [
    "discovery",
    "legality_card_details",
    "legality_rules",
    "legality_history",
    "block_policy",
    "release_timing",
    "don_rules",
  ];
  const records = surface === "discovery"
    ? surfaces
        .filter((name) => name !== "discovery")
        .map((name) => ({
          key: name,
          area: name,
          href: officialSurfaceUrl(requestUrl, name),
        }))
    : surface === "legality_card_details"
      ? [rawOnePieceCard(requestUrl)]
      : [rawOnePiecePolicyNotice(surface, requestUrl)];
  return {
    one_piece: {
      area: surface,
      locale: "EN-OCEANIA",
      total: records.length,
      entries: records,
    },
  };
}

function rawOnePieceCard(requestUrl: string) {
  return {
    source_record_id: "OP30-001-base",
    source_url: requestUrl,
    card_number: "OP30-001",
    name: "Policy Boundary Card",
    Category: "Character",
    Color: ["Red"],
    Cost: "3",
    Life: null,
    Attribute: ["Strike"],
    Power: "5000",
    Counter: "1000",
    Type: ["Policy Test"],
    "Block icon": ["4"],
    Effect: "Official card effect.",
    Trigger: null,
    Rarity: "R",
    Illustration: ["Original"],
    image_url: `${new URL(requestUrl).origin}/images/OP30-001.png`,
  };
}

function rawOnePiecePolicyNotice(surface: string, requestUrl: string) {
  const policy: Record<string, {
    code: string;
    id: string;
    wording: string;
    effectiveUntil?: string;
    eligibleBlocks?: string[];
    legalFrom?: string;
    membershipAttribute?: string;
    membershipValues?: string[];
  }> = {
    legality_rules: {
      code: "eligible",
      id: "op_current_eligible",
      wording: "OP30-001 is eligible for Standard play.",
    },
    legality_history: {
      code: "ban",
      id: "op_history_ban",
      wording: "OP30-001 was banned and may not be included in a deck.",
      effectiveUntil: "2025-06-01",
    },
    block_policy: {
      code: "rotation",
      id: "op_block_rotation",
      wording: "Only cards bearing Block 4 are eligible after rotation.",
      eligibleBlocks: ["4"],
    },
    release_timing: {
      code: "release",
      id: "op_release_timing",
      wording: "OP30-001 becomes legal for tournament play on 1 August 2026.",
      legalFrom: "2026-08-01",
    },
    don_rules: {
      code: "membership",
      id: "op_don_membership",
      wording: "Cards with the Policy Test trait are eligible under the DON!! membership rule.",
      membershipAttribute: "traits",
      membershipValues: ["Policy Test"],
    },
  };
  const selected = policy[surface];
  if (selected === undefined) {
    throw new Error(`No One Piece policy fixture exists for ${surface}.`);
  }
  return {
    notice_no: selected.id,
    source_url: requestUrl,
    published_text: selected.wording,
    territory: "EN-OCEANIA",
    format_name: "standard",
    event_class: null,
    start_date: "2025-01-01",
    end_date: selected.effectiveUntil ?? null,
    card_numbers: ["OP30-001"],
    restriction_code: selected.code,
    maximum_copies: null,
    related_cards: [],
    membership_attribute: selected.membershipAttribute ?? null,
    membership_values: selected.membershipValues ?? [],
    eligible_blocks: selected.eligibleBlocks ?? [],
    legal_from: selected.legalFrom ?? null,
    unresolved_reason: null,
  };
}

function officialSurfaceUrl(requestUrl: string, surface: string): string {
  const url = new URL(requestUrl);
  url.searchParams.set("surface", surface);
  return url.href;
}

function discoveredSurfaces(requestUrl: string) {
  const seed = new URL(requestUrl);
  seed.searchParams.delete("surface");
  return requiredSurfaces
    .filter((surface) => surface !== "discovery")
    .map((surface) => {
      const url = new URL(seed);
      url.searchParams.set("surface", surface);
      return { request_key: surface, endpoint: surface, href: url.href };
    });
}

function rawGundamCard(
  observation: ReturnType<typeof gundamObservation>,
  requestUrl: string,
) {
  const sourceUrl = new URL(requestUrl);
  const imageUrl = new URL(
    `images/${observation.card.official_identity.value}.png`,
    `${sourceUrl.origin}${sourceUrl.pathname.startsWith("/asia-en/") ? "/asia-en/" : "/en/"}`,
  );
  const card = observation.card.game_data.attributes;
  return {
    detailSearch: observation.card.official_identity.value,
    source_url: requestUrl,
    card_number: observation.card.official_identity.value,
    name: observation.card.name,
    type: card.card_type,
    Color: card.colours,
    Level: card.level,
    Cost: card.cost,
    Block: card.block_icon,
    Effect: card.effect_text,
    Zone: card.zone,
    Trait: card.traits,
    Link: card.link_condition,
    AP: card.ap,
    HP: card.hp,
    Title: card.series_titles,
    Rarity: observation.printing.rarity.raw,
    alternate_art: "no",
    image_url: imageUrl.href,
  };
}

function rawGundamNotice(
  rule: ReturnType<typeof legalityRules>[number],
  requestUrl: string,
) {
  const effect = rule.effect;
  return {
    news_id: rule.id,
    url: requestUrl,
    text: rule.official_wording,
    region: rule.region,
    format: rule.format,
    event_tier: rule.event_tier,
    effective_date: rule.effective_from,
    end_date: rule.effective_until,
    card_numbers: rule.card_numbers,
    ruling:
      effect.type === "prohibited_combination"
        ? "combination"
        : effect.type === "release_timing"
          ? "release"
          : effect.type,
    copy_limit: "maximum_copies" in effect ? effect.maximum_copies : null,
    companion_cards:
      "with_card_numbers" in effect ? effect.with_card_numbers : [],
    attribute: "attribute" in effect ? effect.attribute : null,
    values: "includes_any" in effect ? effect.includes_any : [],
    legal_blocks: "eligible_blocks" in effect ? effect.eligible_blocks : [],
    legal_from: "legal_from" in effect ? effect.legal_from : null,
    reason: "reason" in effect ? effect.reason : null,
  };
}

function legalityRules(region: Region) {
  const base = {
    game: "gundam",
    region,
    format: "standard",
    event_tier: null,
    effective_from: "2026-01-01",
    effective_until: null,
    representable: true,
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
        "Cards satisfying the published Standard eligibility rules may be used.",
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
  ];
}

function gundamObservation(cardNumber: string) {
  const numeric = cardNumber.replace(/[^0-9]/g, "");
  const artworkFingerprint = `sha256:${numeric.padEnd(64, "0").slice(0, 64)}`;
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
      artwork_fingerprint: artworkFingerprint,
      printed_fields_digest: `sha256:${numeric
        .padEnd(64, "1")
        .slice(0, 64)}`,
      treatment: "standard",
      demonstrably_novel: true,
      novelty_basis: {
        kind: "official_printing_image",
        source_url: `https://www.gundam-gcg.com/asia-en/images/${cardNumber}.png`,
        artwork_fingerprint: artworkFingerprint,
      },
    },
    appearance_evidence: {
      images: [
        {
          role: "front",
          source_url: `https://www.gundam-gcg.com/asia-en/images/${cardNumber}.png`,
          artwork_fingerprint: artworkFingerprint,
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
