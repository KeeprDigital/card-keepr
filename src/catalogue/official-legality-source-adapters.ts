type OfficialLegalityGame =
  | "one-piece"
  | "fusion-world"
  | "digimon"
  | "gundam";

type FieldMap = Readonly<{
  id: string;
  wording: string;
  region: string;
  format: string;
  tier: string;
  effectiveFrom: string;
  effectiveUntil: string;
  cards: string;
  directive: string;
  maximumCopies: string;
  companionCards: string;
  membershipAttribute: string;
  membershipValues: string;
  eligibleBlocks: string;
  legalFrom: string;
  unresolvedReason: string;
}>;

const fieldsByGame: Readonly<Record<OfficialLegalityGame, FieldMap>> = {
  "one-piece": {
    id: "notice_no",
    wording: "published_text",
    region: "territory",
    format: "format_name",
    tier: "event_class",
    effectiveFrom: "start_date",
    effectiveUntil: "end_date",
    cards: "card_numbers",
    directive: "restriction_code",
    maximumCopies: "maximum_copies",
    companionCards: "related_cards",
    membershipAttribute: "membership_attribute",
    membershipValues: "membership_values",
    eligibleBlocks: "eligible_blocks",
    legalFrom: "legal_from",
    unresolvedReason: "unresolved_reason",
  },
  "fusion-world": {
    id: "rule_ref",
    wording: "notice",
    region: "market",
    format: "play_format",
    tier: "tier",
    effectiveFrom: "active_on",
    effectiveUntil: "expires_on",
    cards: "cards",
    directive: "directive",
    maximumCopies: "cap",
    companionCards: "paired_cards",
    membershipAttribute: "filter_field",
    membershipValues: "filter_values",
    eligibleBlocks: "blocks",
    legalFrom: "tournament_legal_date",
    unresolvedReason: "ambiguity",
  },
  digimon: {
    id: "restriction_id",
    wording: "body",
    region: "language_scope",
    format: "ruleset",
    tier: "tournament_level",
    effectiveFrom: "applies_from",
    effectiveUntil: "applies_until",
    cards: "card_ids",
    directive: "status_code",
    maximumCopies: "deck_limit",
    companionCards: "prohibited_with",
    membershipAttribute: "membership_field",
    membershipValues: "membership_terms",
    eligibleBlocks: "permitted_blocks",
    legalFrom: "sale_eligible_on",
    unresolvedReason: "clarification",
  },
  gundam: {
    id: "news_id",
    wording: "text",
    region: "region",
    format: "format",
    tier: "event_tier",
    effectiveFrom: "effective_date",
    effectiveUntil: "end_date",
    cards: "card_numbers",
    directive: "ruling",
    maximumCopies: "copy_limit",
    companionCards: "companion_cards",
    membershipAttribute: "attribute",
    membershipValues: "values",
    eligibleBlocks: "legal_blocks",
    legalFrom: "legal_from",
    unresolvedReason: "reason",
  },
};

export function officialLegalityRulesObservation(
  game: OfficialLegalityGame,
  sourceLineage: string,
  rawDocument: Record<string, unknown>,
): Record<string, unknown> {
  const entries = requiredArray(
    rawDocument.entries,
    "Official Source Legality entries",
  );
  return {
    observation_type: "legality_rules",
    legality_rules: entries.map((entry, index) =>
      exactLegalityRule(
        game,
        sourceLineage,
        fieldsByGame[game],
        requiredRecord(entry, `Official Source Legality entry ${index}`),
      )
    ),
    completeness: {
      structurally_complete: true,
      required_surfaces_complete: true,
      partitions_complete: true,
      declared_record_count: 1,
      parsed_record_count: 1,
    },
  };
}

function exactLegalityRule(
  game: OfficialLegalityGame,
  sourceLineage: string,
  fields: FieldMap,
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const wording = requiredText(
    entry[fields.wording],
    "Official Legality wording",
  );
  const directive = requiredText(
    entry[fields.directive],
    "Official Legality directive",
  );
  const effect = exactEffect(entry, fields, directive, wording);
  const region = requiredText(
    entry[fields.region],
    "Official Legality region",
  );
  if (region !== regionForLineage(sourceLineage)) {
    throw new Error(
      "Official Legality region conflicts with its Source Lineage.",
    );
  }
  return {
    id: requiredText(entry[fields.id], "Official Legality identity"),
    game,
    region,
    format: requiredText(entry[fields.format], "Official Legality format"),
    event_tier: nullableText(
      entry[fields.tier],
      "Official Legality event tier",
    ),
    effective_from: requiredDate(
      entry[fields.effectiveFrom],
      "Official Legality effective date",
    ),
    effective_until: nullableDate(
      entry[fields.effectiveUntil],
      "Official Legality end date",
    ),
    card_numbers: requiredTextArray(
      entry[fields.cards],
      "Official Legality Card numbers",
      true,
    ),
    official_wording: wording,
    effect,
    representable: true,
  };
}

function exactEffect(
  entry: Record<string, unknown>,
  fields: FieldMap,
  directive: string,
  wording: string,
): Record<string, unknown> {
  switch (directive) {
    case "eligible":
      assertWording(directive, wording, /\b(?:eligible|legal)\b/iu);
      assertNoContradiction(
        directive,
        wording,
        /\b(?:banned?|not legal)\b|may not be included/iu,
      );
      return { type: "eligible" };
    case "ban":
    case "banned":
      assertWording(
        directive,
        wording,
        /\b(?:banned?|not legal)\b|may not be included/iu,
      );
      return { type: "ban" };
    case "copy_limit":
    case "limited":
      assertWording(
        directive,
        wording,
        /\b(?:cop(?:y|ies)|limit(?:ed)?)\b/iu,
      );
      return {
        type: "copy_limit",
        maximum_copies: requiredPositiveInteger(
          entry[fields.maximumCopies],
          "Official Legality copy limit",
        ),
      };
    case "combination":
    case "prohibited_combination":
      assertWording(
        directive,
        wording,
        /\b(?:combination|same deck|together)\b/iu,
      );
      return {
        type: "prohibited_combination",
        with_card_numbers: requiredTextArray(
          entry[fields.companionCards],
          "Official Legality companion Cards",
          false,
        ),
      };
    case "membership":
      assertWording(
        directive,
        wording,
        /\b(?:membership|trait|attribute)\b/iu,
      );
      return {
        type: "membership",
        attribute: requiredText(
          entry[fields.membershipAttribute],
          "Official Legality membership attribute",
        ),
        includes_any: requiredTextArray(
          entry[fields.membershipValues],
          "Official Legality membership values",
          false,
        ),
      };
    case "rotation":
      assertWording(directive, wording, /\b(?:rotation|block)\b/iu);
      return {
        type: "rotation",
        eligible_blocks: requiredTextArray(
          entry[fields.eligibleBlocks],
          "Official Legality rotation blocks",
          false,
        ),
      };
    case "release":
    case "release_timing":
      assertWording(directive, wording, /\b(?:legal|tournament|release)\b/iu);
      return {
        type: "release_timing",
        legal_from: requiredDate(
          entry[fields.legalFrom],
          "Official Legality tournament date",
        ),
      };
    case "unresolved":
      return {
        type: "unresolved",
        reason: requiredText(
          entry[fields.unresolvedReason],
          "Official Legality unresolved reason",
        ),
      };
    default:
      throw new Error(
        `Official Legality directive ${directive} is not representable by this Source Adapter Version.`,
      );
  }
}

function assertWording(
  directive: string,
  wording: string,
  pattern: RegExp,
): void {
  if (!pattern.test(wording)) {
    throw new Error(
      `Official Legality wording does not exactly support directive ${directive}.`,
    );
  }
}

function assertNoContradiction(
  directive: string,
  wording: string,
  pattern: RegExp,
): void {
  if (pattern.test(wording)) {
    throw new Error(
      `Official Legality wording contradicts directive ${directive}.`,
    );
  }
}

function regionForLineage(sourceLineage: string): string {
  if (sourceLineage === "gundam-en-asia") return "EN-ASIA";
  if (sourceLineage === "gundam-en-us") return "EN-US";
  return "EN-OCEANIA";
}

function requiredRecord(
  value: unknown,
  name: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
  return value;
}

function requiredText(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new Error(`${name} must be non-empty text.`);
  }
  return value;
}

function nullableText(value: unknown, name: string): string | null {
  return value === null ? null : requiredText(value, name);
}

function requiredTextArray(
  value: unknown,
  name: string,
  emptyAllowed: boolean,
): string[] {
  const values = requiredArray(value, name).map((item) =>
    requiredText(item, name)
  );
  if (!emptyAllowed && values.length === 0) {
    throw new Error(`${name} must not be empty.`);
  }
  if (new Set(values).size !== values.length) {
    throw new Error(`${name} must not contain duplicates.`);
  }
  return values;
}

function requiredPositiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return Number(value);
}

function requiredDate(value: unknown, name: string): string {
  const date = requiredText(value, name);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) ||
    Number.isNaN(parsed.valueOf()) ||
    !parsed.toISOString().startsWith(date)) {
    throw new Error(`${name} must be an exact ISO date.`);
  }
  return date;
}

function nullableDate(value: unknown, name: string): string | null {
  return value === null ? null : requiredDate(value, name);
}
