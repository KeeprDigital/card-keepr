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
        ? cards.map((card) => officialLegalityCardDetail(card, requestUrl))
        : surface === "legality_rules"
          ? rules.map((rule) => officialLegalityNotice(rule, requestUrl))
          : [
              {
                source_id: `${surface}-representative`,
                source_url: requestUrl,
              },
            ];
  return {
    surface: completeSurface(region, surface, records),
  };
}

const requiredSurfaces = [
  "discovery",
  "legality_card_details",
  "legality_rules",
  "legality_history",
];

function discoveredSurfaces(requestUrl: string) {
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

function officialLegalityCardDetail(
  observation: ReturnType<typeof gundamObservation>,
  requestUrl: string,
) {
  const sourceUrl = new URL(requestUrl);
  const imageUrl = new URL(
    `images/${observation.card.official_identity.value}.png`,
    `${sourceUrl.origin}${sourceUrl.pathname.startsWith("/asia-en/") ? "/asia-en/" : "/en/"}`,
  );
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

function officialLegalityNotice(
  rule: ReturnType<typeof legalityRules>[number],
  requestUrl: string,
) {
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

function completeSurface(
  partition: Region,
  name: string,
  records: readonly unknown[],
) {
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
