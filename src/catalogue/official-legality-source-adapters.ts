import { isIsoCalendarDate } from "./calendar-date.mjs";
import { requiredOfficialSourceScope } from "./official-source-scope.mjs";

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

// This allow-list is deliberately narrow: these fields describe the publisher's
// publication, not the rule's applicability or effect. They remain in the raw
// Source Observation sidecar and become review warnings there. Every other
// unknown entry field is treated as potentially semantic and fails closed.
const optionalSourceMetadataFields = new Set(["publisher_note"]);

const htmlLabelsByGame: Readonly<
  Record<OfficialLegalityGame, Readonly<Record<string, keyof FieldMap>>>
> = {
  "one-piece": {
    "Notice No": "id", "Published Text": "wording", Territory: "region",
    "Format Name": "format", "Event Class": "tier", "Start Date": "effectiveFrom",
    "End Date": "effectiveUntil", "Card Numbers": "cards",
    "Restriction Code": "directive", "Maximum Copies": "maximumCopies",
    "Related Cards": "companionCards", "Membership Attribute": "membershipAttribute",
    "Membership Values": "membershipValues", "Eligible Blocks": "eligibleBlocks",
    "Legal From": "legalFrom", "Unresolved Reason": "unresolvedReason",
  },
  "fusion-world": {
    "Rule Ref": "id", Notice: "wording", Market: "region",
    "Play Format": "format", Tier: "tier", "Active On": "effectiveFrom",
    "Expires On": "effectiveUntil", Cards: "cards", Directive: "directive",
    Cap: "maximumCopies", "Paired Cards": "companionCards",
    "Filter Field": "membershipAttribute", "Filter Values": "membershipValues",
    Blocks: "eligibleBlocks", "Tournament Legal Date": "legalFrom",
    Ambiguity: "unresolvedReason",
  },
  digimon: {
    "Restriction ID": "id", Body: "wording", "Language Scope": "region",
    Ruleset: "format", "Tournament Level": "tier", "Applies From": "effectiveFrom",
    "Applies Until": "effectiveUntil", "Card IDs": "cards", "Status Code": "directive",
    "Deck Limit": "maximumCopies", "Prohibited With": "companionCards",
    "Membership Field": "membershipAttribute", "Membership Terms": "membershipValues",
    "Permitted Blocks": "eligibleBlocks", "Sale Eligible On": "legalFrom",
    Clarification: "unresolvedReason",
  },
  gundam: {
    "News ID": "id", Text: "wording", Region: "region", Format: "format",
    "Event Tier": "tier", "Effective Date": "effectiveFrom", "End Date": "effectiveUntil",
    "Card Numbers": "cards", Ruling: "directive", "Copy Limit": "maximumCopies",
    "Companion Cards": "companionCards", Attribute: "membershipAttribute",
    Values: "membershipValues", "Legal Blocks": "eligibleBlocks",
    "Legal From": "legalFrom", Reason: "unresolvedReason",
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
      declared_record_count: entries.length,
      parsed_record_count: entries.length,
    },
  };
}

/** Parses only the semantic HTML contract owned by the current adapter version. */
export function officialLegalityRulesHtmlObservation(
  game: OfficialLegalityGame,
  sourceLineage: string,
  html: string,
): Record<string, unknown> | null {
  const declaredRecordCount = publisherDeclaredRecordCount(html);
  const articles = [...html.matchAll(
    /<article\b([^>]*)>([\s\S]*?)<\/article>/giu,
  )].filter((match) =>
    /(?:^|\s)restriction-card(?:\s|$)/u.test(
      htmlAttribute(match[1]!, "class") ?? "",
    )
  );
  if (articles.length === 0) {
    return declaredRecordCount === 0
      ? officialLegalityRulesObservation(game, sourceLineage, { entries: [] })
      : null;
  }
  if (declaredRecordCount === null) {
    throw new Error(
      "Official Legality HTML has no exact publisher-declared record total.",
    );
  }

  const fields = fieldsByGame[game];
  const labels = htmlLabelsByGame[game];
  const entries = articles.map((article, articleIndex) => {
    const pairs = [...article[2]!.matchAll(
      /<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/giu,
    )];
    if (pairs.length === 0) {
      throw new Error(
        `Official Legality HTML entry ${articleIndex} has no exact label/value fields.`,
      );
    }
    const entry: Record<string, unknown> = {};
    for (const pair of pairs) {
      const label = htmlText(pair[1]!);
      const field = labels[label];
      if (field === undefined) {
        throw new Error(
          `Official Legality HTML label ${label} is not recognized by this Source Adapter Version.`,
        );
      }
      const rawField = fields[field];
      if (rawField in entry) {
        throw new Error(`Official Legality HTML label ${label} is duplicated.`);
      }
      const value = htmlText(pair[2]!);
      entry[rawField] = field === "cards" ||
          field === "companionCards" || field === "membershipValues" ||
          field === "eligibleBlocks"
        ? value === "-" ? [] : value.split(",").map((item) => item.trim())
        : field === "maximumCopies"
          ? Number(value)
          : field === "tier" || field === "effectiveUntil"
            ? value === "-" ? null : value
            : value;
    }
    return entry;
  });
  if (declaredRecordCount !== entries.length) {
    throw new Error(
      `Official Legality HTML declares ${declaredRecordCount} records but exactly ${entries.length} were parsed.`,
    );
  }
  return officialLegalityRulesObservation(game, sourceLineage, { entries });
}

function publisherDeclaredRecordCount(html: string): number | null {
  const declarations = [...html.matchAll(
    />\s*(\d+)\s+(?:records?|results?|items?)\s*</giu,
  )].map((match) => Number.parseInt(match[1]!, 10));
  if (declarations.length === 0) return null;
  if (declarations.length !== 1 || !Number.isSafeInteger(declarations[0])) {
    throw new Error(
      "Official Legality HTML must contain one exact publisher-declared record total.",
    );
  }
  return declarations[0]!;
}

function htmlAttribute(attributes: string, name: string): string | null {
  return attributes.match(
    new RegExp(`\\b${name}=["']([^"']*)["']`, "iu"),
  )?.[1] ?? null;
}

function htmlText(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/giu, "\n")
    .replace(/<[^>]+>/gu, "")
    .replace(
      /&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]+);/giu,
      (entity, reference: string) => decodedHtmlEntity(entity, reference),
    )
    .trim();
}

const namedHtmlEntities: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  bull: "•",
  copy: "©",
  gt: ">",
  hellip: "…",
  ldquo: "“",
  lsquo: "‘",
  lt: "<",
  mdash: "—",
  middot: "·",
  nbsp: " ",
  ndash: "–",
  quot: '"',
  rdquo: "”",
  reg: "®",
  rsquo: "’",
  trade: "™",
};

function decodedHtmlEntity(entity: string, reference: string): string {
  if (reference.startsWith("#")) {
    const hexadecimal = reference[1]?.toLowerCase() === "x";
    const digits = reference.slice(hexadecimal ? 2 : 1);
    const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
    if (
      !Number.isSafeInteger(codePoint) ||
      codePoint <= 0 ||
      codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      throw new Error(`Official Legality HTML entity ${entity} is invalid.`);
    }
    return String.fromCodePoint(codePoint);
  }
  const decoded = namedHtmlEntities[reference.toLowerCase()];
  if (decoded === undefined) {
    throw new Error(
      `Official Legality HTML entity ${entity} is not recognized by this Source Adapter Version.`,
    );
  }
  return decoded;
}

function exactLegalityRule(
  game: OfficialLegalityGame,
  sourceLineage: string,
  fields: FieldMap,
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const allowedFields = new Set(Object.values(fields));
  const unknownField = Object.keys(entry).find((field) =>
    !allowedFields.has(field) && !optionalSourceMetadataFields.has(field)
  );
  if (unknownField !== undefined) {
    throw new Error(
      `Official Legality entry contains unknown field ${unknownField}.`,
    );
  }
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
        /\bbanned?\b|may not be included/iu,
      );
      assertNoNegatedLegalityPredicate(directive, wording);
      return { type: "eligible" };
    case "ban":
    case "banned":
      assertWording(
        directive,
        wording,
        /\b(?:banned?|not legal)\b|may not be included/iu,
      );
      assertNoContradiction(
        directive,
        wording,
        /\b(?:not|never)\s+banned?\b|\bno longer banned?\b|\bban (?:is )?(?:lifted|removed)\b/iu,
      );
      return { type: "ban" };
    case "copy_limit":
    case "limited":
      {
        const maximumCopies = requiredPositiveInteger(
          entry[fields.maximumCopies],
          "Official Legality copy limit",
        );
        assertExactCopyLimitWording(wording, maximumCopies);
        return {
          type: "copy_limit",
          maximum_copies: maximumCopies,
        };
      }
    case "combination":
    case "prohibited_combination": {
      const directCards = requiredTextArray(
        entry[fields.cards],
        "Official Legality Card numbers",
        true,
      );
      const companionCards = requiredTextArray(
        entry[fields.companionCards],
        "Official Legality companion Cards",
        false,
      );
      assertWording(
        "prohibited combination",
        wording,
        /\b(?:(?:may|must)\s+not|cannot|can't)\b[\s\S]*\b(?:together|same deck)\b|\bprohibited\s+combination\b/iu,
      );
      assertNoContradiction(
        "prohibited combination",
        wording,
        /\b(?:may|can)\s+be\s+(?:used|included|played)\s+together\b|\bcombination\s+is\s+(?:allowed|legal|permitted)\b/iu,
      );
      assertWordingOperands(
        "prohibited combination",
        wording,
        [...directCards, ...companionCards],
      );
      return {
        type: "prohibited_combination",
        with_card_numbers: companionCards,
      };
    }
    case "membership": {
      const attribute = requiredText(
        entry[fields.membershipAttribute],
        "Official Legality membership attribute",
      );
      const values = requiredTextArray(
        entry[fields.membershipValues],
        "Official Legality membership values",
        false,
      );
      assertWording(
        directive,
        wording,
        /\b(?:membership|traits?|attributes?)\b/iu,
      );
      assertNoContradiction(
        directive,
        wording,
        /\b(?:does\s+not|do\s+not|need\s+not)\s+(?:require|include|have)\b|\bnot\s+required\b|\bwithout\s+(?:the\s+)?(?:membership|traits?|attributes?)\b/iu,
      );
      assertNoNegatedLegalityPredicate(directive, wording);
      assertWording(
        directive,
        wording,
        /\bonly\b[\s\S]*\b(?:includes?|with|has|have)\b|\b(?:must|requires?)\b[\s\S]*\b(?:membership|traits?|attributes?)\b/iu,
      );
      assertWordingOperands(directive, wording, [attribute, ...values]);
      return {
        type: "membership",
        attribute,
        includes_any: values,
      };
    }
    case "rotation": {
      const blocks = requiredTextArray(
        entry[fields.eligibleBlocks],
        "Official Legality rotation blocks",
        false,
      );
      assertWording(directive, wording, /\b(?:rotation|block)\b/iu);
      assertNoContradiction(
        directive,
        wording,
        /\b(?:not\s+(?:eligible|legal|permitted)|ineligible|illegal|excluded)\b/iu,
      );
      assertNoNegatedLegalityPredicate(directive, wording);
      assertWording(
        directive,
        wording,
        /\b(?:eligible|legal|permitted)\b/iu,
      );
      assertWordingOperands(directive, wording, blocks);
      return {
        type: "rotation",
        eligible_blocks: blocks,
      };
    }
    case "release":
    case "release_timing": {
      const legalFrom = requiredDate(
        entry[fields.legalFrom],
        "Official Legality tournament date",
      );
      assertNoContradiction(
        "release timing",
        wording,
        /\b(?:not|never)\s+(?:be\s+|become\s+)?legal\b|\b(?:illegal|ineligible)\b|\bdelayed\s+(?:past|beyond|until after)\b/iu,
      );
      assertNoNegatedLegalityPredicate("release timing", wording);
      assertWording(
        directive,
        wording,
        /\b(?:becomes?|is|will be)\s+(?:tournament\s+)?legal\b|\blegal\s+for\s+tournament\b/iu,
      );
      assertWordingOperands("release timing", wording, [legalFrom]);
      return {
        type: "release_timing",
        legal_from: legalFrom,
      };
    }
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

function assertWordingOperands(
  directive: string,
  wording: string,
  operands: readonly string[],
): void {
  for (const operand of operands) {
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegExp(operand)}(?![\\p{L}\\p{N}])`,
      "iu",
    );
    if (!pattern.test(wording)) {
      throw new Error(
        `Official Legality wording does not exactly support ${directive} operand ${operand}.`,
      );
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function assertExactCopyLimitWording(
  wording: string,
  maximumCopies: number,
): void {
  const statedCopyCounts = [...wording.matchAll(
    /\b(\d+)\s+cop(?:y|ies)\b/giu,
  )].map((match) => Number.parseInt(match[1]!, 10));
  const statesExactLimit = new RegExp(
    `\\b(?:limit(?:ed)?\\s+(?:of|to)|maximum(?:\\s+of)?|up\\s+to)\\s+(?:a\\s+maximum\\s+of\\s+)?${maximumCopies}\\s+cop(?:y|ies)\\b`,
    "iu",
  ).test(wording);
  if (
    !statesExactLimit ||
    statedCopyCounts.length === 0 ||
    statedCopyCounts.some((count) => count !== maximumCopies)
  ) {
    throw new Error(
      `Official Legality wording does not exactly support copy limit ${maximumCopies}.`,
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

function assertNoNegatedLegalityPredicate(
  directive: string,
  wording: string,
): void {
  assertNoContradiction(
    directive,
    wording,
    /\b(?:not|never)\b(?:\s+[\p{L}\p{N}'-]+){0,4}\s+(?:eligible|legal|permitted|required|included?|requires?|includes?|has|have)\b/iu,
  );
}

function regionForLineage(sourceLineage: string): string {
  return requiredOfficialSourceScope(sourceLineage).legalityRegion;
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
  if (!isIsoCalendarDate(date)) {
    throw new Error(`${name} must be an exact ISO date.`);
  }
  return date;
}

function nullableDate(value: unknown, name: string): string | null {
  return value === null ? null : requiredDate(value, name);
}
