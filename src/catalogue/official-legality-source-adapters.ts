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
  unresolvedScope: string;
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
    unresolvedScope: "unresolved_scope",
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
    unresolvedScope: "unresolved_scope",
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
    unresolvedScope: "unresolved_scope",
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
    unresolvedScope: "unresolved_scope",
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
    "Unresolved Scope": "unresolvedScope",
    "Restriction Code": "directive", "Maximum Copies": "maximumCopies",
    "Related Cards": "companionCards", "Membership Attribute": "membershipAttribute",
    "Membership Values": "membershipValues", "Eligible Blocks": "eligibleBlocks",
    "Legal From": "legalFrom", "Unresolved Reason": "unresolvedReason",
  },
  "fusion-world": {
    "Rule Ref": "id", Notice: "wording", Market: "region",
    "Play Format": "format", Tier: "tier", "Active On": "effectiveFrom",
    "Expires On": "effectiveUntil", Cards: "cards", Directive: "directive",
    "Unresolved Scope": "unresolvedScope",
    Cap: "maximumCopies", "Paired Cards": "companionCards",
    "Filter Field": "membershipAttribute", "Filter Values": "membershipValues",
    Blocks: "eligibleBlocks", "Tournament Legal Date": "legalFrom",
    Ambiguity: "unresolvedReason",
  },
  digimon: {
    "Restriction ID": "id", Body: "wording", "Language Scope": "region",
    Ruleset: "format", "Tournament Level": "tier", "Applies From": "effectiveFrom",
    "Applies Until": "effectiveUntil", "Card IDs": "cards", "Status Code": "directive",
    "Unresolved Scope": "unresolvedScope",
    "Deck Limit": "maximumCopies", "Prohibited With": "companionCards",
    "Membership Field": "membershipAttribute", "Membership Terms": "membershipValues",
    "Permitted Blocks": "eligibleBlocks", "Sale Eligible On": "legalFrom",
    Clarification: "unresolvedReason",
  },
  gundam: {
    "News ID": "id", Text: "wording", Region: "region", Format: "format",
    "Event Tier": "tier", "Effective Date": "effectiveFrom", "End Date": "effectiveUntil",
    "Unresolved Scope": "unresolvedScope",
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
  const declaredRecordCount = rawDocument.declared_record_count === undefined
    ? entries.length
    : requiredNonNegativeInteger(
      rawDocument.declared_record_count,
      "Official Source Legality declared record count",
    );
  if (declaredRecordCount !== entries.length) {
    throw new Error(
      `Official Source Legality declares ${declaredRecordCount} records but exactly ${entries.length} were parsed.`,
    );
  }
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
      declared_record_count: declaredRecordCount,
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
      entry[rawField] = field === "unresolvedScope"
        ? value === "-" ? null : { dimensions: value.split(",").map((item) => item.trim()) }
        : field === "cards" ||
          field === "companionCards" || field === "membershipValues" ||
          field === "eligibleBlocks"
        ? value === "-" ? [] : value.split(",").map((item) => item.trim())
        : field === "maximumCopies"
          ? Number(value)
          : field === "tier" || field === "effectiveFrom" ||
              field === "effectiveUntil"
            ? value === "-" ? null : value
            : value;
    }
    const residual = pairs.reduce(
      (content, pair) => content.replace(pair[0]!, ""),
      article[2]!,
    ).replace(/<\/?dl\b[^>]*>/giu, "");
    if (htmlText(residual).length > 0) {
      throw new Error(
        `Official Legality HTML entry ${articleIndex} contains residual semantic content.`,
      );
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
    .replace(
      /<br\s*\/?\s*>|<\/(?:address|article|aside|blockquote|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|li|main|nav|ol|p|section|table|tbody|td|tfoot|th|thead|tr|ul)>/giu,
      "\n",
    )
    .replace(/<[^>]+>/gu, "")
    .replace(
      /&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]+);/giu,
      (entity, reference: string) => decodedHtmlEntity(entity, reference),
    )
    .replace(/[ \t]*\n[ \t]*/gu, "\n")
    .replace(/\n{2,}/gu, "\n")
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
  assertDirectiveSpecificOperands(entry, fields, directive);
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
  const effectiveFrom = nullableDate(
    entry[fields.effectiveFrom],
    "Official Legality effective date",
  );
  const effectiveUntil = nullableDate(
    entry[fields.effectiveUntil],
    "Official Legality end date",
  );
  const unresolvedScope = exactUnresolvedScope(entry[fields.unresolvedScope]);
  const eventTier = nullableText(
    entry[fields.tier],
    "Official Legality event tier",
  );
  const cardNumbers = requiredTextArray(
    entry[fields.cards],
    "Official Legality Card numbers",
    true,
  );
  if (
    (effectiveFrom === null &&
      (unresolvedScope === null ||
        !unresolvedScope.dimensions.includes("effective_interval"))) ||
    (effectiveFrom !== null && effectiveUntil !== null &&
      effectiveUntil <= effectiveFrom) ||
    (unresolvedScope !== null &&
      (effect.type !== "unresolved" || cardNumbers.length === 0 ||
        (unresolvedScope.dimensions.includes("effective_interval")
          ? effectiveFrom !== null || effectiveUntil !== null
          : effectiveFrom === null) ||
        (unresolvedScope.dimensions.includes("event_tier") &&
          eventTier !== null)))
  ) {
    throw new Error("Official Legality unresolved scope conflicts with its exact context.");
  }
  return {
    id: requiredText(entry[fields.id], "Official Legality identity"),
    game,
    region,
    format: requiredText(entry[fields.format], "Official Legality format"),
    event_tier: eventTier,
    effective_from: effectiveFrom,
    effective_until: effectiveUntil,
    unresolved_scope: unresolvedScope,
    card_numbers: cardNumbers,
    official_wording: wording,
    effect,
    representable: true,
  };
}

function exactUnresolvedScope(
  value: unknown,
): { dimensions: ("effective_interval" | "event_tier")[] } | null {
  if (value === undefined || value === null) return null;
  const scope = requiredRecord(value, "Official Legality unresolved scope");
  const unknown = Object.keys(scope).find((field) => field !== "dimensions");
  if (unknown !== undefined || !Array.isArray(scope.dimensions)) {
    throw new Error("Official Legality unresolved scope is invalid.");
  }
  const dimensions = scope.dimensions.map((dimension) => {
    if (dimension !== "effective_interval" && dimension !== "event_tier") {
      throw new Error("Official Legality unresolved scope dimension is invalid.");
    }
    return dimension;
  });
  if (
    dimensions.length === 0 || new Set(dimensions).size !== dimensions.length ||
    dimensions.join(",") !== [...dimensions].sort().join(",")
  ) {
    throw new Error("Official Legality unresolved scope dimensions are invalid.");
  }
  return { dimensions };
}

function exactEffect(
  entry: Record<string, unknown>,
  fields: FieldMap,
  directive: string,
  wording: string,
): Record<string, unknown> {
  switch (directive) {
    case "eligible":
      assertNoAdditionalStructuredSemantics("eligible", wording, [
        copyLimitSemantics,
        combinationSemantics,
        membershipSemantics,
        rotationSemantics,
        releaseTimingSemantics,
      ]);
      assertWording(directive, wording, /\b(?:eligible|legal)\b/iu);
      assertNoContradiction(
        directive,
        wording,
        /\bbanned?\b|may not be included/iu,
      );
      assertNoNegatedLegalityPredicate(directive, wording);
      assertDirectiveWordingGrammar(directive, wording);
      return { type: "eligible" };
    case "ban":
    case "banned":
      assertNoAdditionalStructuredSemantics("ban", wording, [
        copyLimitSemantics,
        combinationSemantics,
        membershipSemantics,
        rotationSemantics,
        releaseTimingSemantics,
      ]);
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
      assertDirectiveWordingGrammar(directive, wording);
      return { type: "ban" };
    case "copy_limit":
    case "limited":
      {
        assertNoAdditionalStructuredSemantics("copy limit", wording, [
          banSemantics,
          combinationSemantics,
          membershipSemantics,
          rotationSemantics,
          releaseTimingSemantics,
          /\b(?:eligible|legal|permitted)\b/iu,
        ]);
        const maximumCopies = requiredPositiveInteger(
          entry[fields.maximumCopies],
          "Official Legality copy limit",
        );
        assertExactCopyLimitWording(wording, maximumCopies);
        assertDirectiveWordingGrammar(directive, wording);
        return {
          type: "copy_limit",
          maximum_copies: maximumCopies,
        };
      }
    case "combination":
    case "prohibited_combination": {
      assertNoAdditionalStructuredSemantics("prohibited combination", wording, [
        banSemantics,
        copyLimitSemantics,
        membershipSemantics,
        rotationSemantics,
        releaseTimingSemantics,
        /\b(?:eligible|legal|permitted)\b/iu,
      ]);
      const directCards = requiredTextArray(
        entry[fields.cards],
        "Official Legality Card numbers",
        false,
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
      assertDirectiveWordingGrammar(directive, wording);
      return {
        type: "prohibited_combination",
        with_card_numbers: companionCards,
      };
    }
    case "membership": {
      assertNoAdditionalStructuredSemantics("membership", wording, [
        banSemantics,
        copyLimitSemantics,
        combinationSemantics,
        rotationSemantics,
        releaseTimingSemantics,
      ]);
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
      assertDirectiveWordingGrammar(directive, wording);
      return {
        type: "membership",
        attribute,
        includes_any: values,
      };
    }
    case "rotation": {
      assertNoAdditionalStructuredSemantics("rotation", wording, [
        banSemantics,
        copyLimitSemantics,
        combinationSemantics,
        membershipSemantics,
        releaseTimingSemantics,
      ]);
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
      assertDirectiveWordingGrammar(directive, wording);
      return {
        type: "rotation",
        eligible_blocks: blocks,
      };
    }
    case "release":
    case "release_timing": {
      assertNoAdditionalStructuredSemantics("release timing", wording, [
        banSemantics,
        copyLimitSemantics,
        combinationSemantics,
        membershipSemantics,
        rotationSemantics,
      ]);
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
      assertDirectiveWordingGrammar(directive, wording);
      return {
        type: "release_timing",
        legal_from: legalFrom,
      };
    }
    case "unresolved": {
      const reason = requiredText(
        entry[fields.unresolvedReason],
        "Official Legality unresolved reason",
      );
      assertNoAdditionalStructuredSemantics("unresolved", wording, [
        banSemantics,
        copyLimitSemantics,
        combinationSemantics,
        membershipSemantics,
        rotationSemantics,
        releaseTimingSemantics,
        /\b(?:eligible|legal|permitted)\b/iu,
      ]);
      assertWording(
        directive,
        wording,
        /\b(?:unresolved|unclear|unknown|cannot be determined|awaiting (?:publisher )?clarification)\b/iu,
      );
      assertWordingOperands(directive, wording, [reason]);
      assertDirectiveWordingGrammar(directive, wording);
      return {
        type: "unresolved",
        reason,
      };
    }
    default:
      throw new Error(
        `Official Legality directive ${directive} is not representable by this Source Adapter Version.`,
      );
  }
}

function assertDirectiveWordingGrammar(
  directive: string,
  wording: string,
): void {
  const normalized = normalizedDirective(directive);
  const grammars = directiveWordingGrammars[normalized];
  if (grammars === undefined || !grammars.some((grammar) => grammar.test(wording))) {
    throw new Error(
      "Official Legality wording contains a conditional, qualifier, or residual clause this Source Adapter Version cannot represent.",
    );
  }
}

const directiveWordingGrammars: Readonly<Record<string, readonly RegExp[]>> = {
  eligible: [
    /^[^\n.!?]+\b(?:is|are)\s+(?:eligible|legal)(?:\s+for\s+(?:Standard play|Standard events in the [A-Z-]+ region|this event|rotation))?(?:\s+under\s+the\s+published\s+[^\n.!?]+\s+rule)?(?:\s+'as printed'\s+–\s+publisher–confirmed\s+&#39;literal&#39;)?\.(?:\nPublisher notice:\nEffective immediately\.)?$/iu,
    /^Cards satisfying the published [^\n.!?]+ eligibility rules may be used\.$/iu,
  ],
  ban: [
    /^[^\n.!?]+\b(?:is|are|was|were)\s+banned(?:\s+from\s+(?:standard\s+)?(?:tournament\s+)?decks)?\.$/iu,
    /^[^\n.!?]+\bmay not be included(?:\s+in\s+(?:a|the|same)\s+deck)?\.$/iu,
    /^[^\n.!?]+\b(?:was|were)\s+(?:banned\s+and\s+)?(?:may not be included|not legal)\s+before\s+[^\n.!?]+\.$/iu,
  ],
  copy_limit: [
    /^[^\n.!?]+\b(?:is|are)\s+limited\s+to\s+\d+\s+cop(?:y|ies)(?:\s+in\s+(?:standard\s+)?decks)?\.$/iu,
    /^(?:For [^\n,.!?]+ events,\s+)?decks may contain (?:no more than\s+)?(?:only\s+)?(?:\d+|one|two|three|four)\s+cop(?:y|ies) of [^\n.!?]+\.$/iu,
  ],
  prohibited_combination: [
    /^[^\n.!?]+\b(?:may|must)\s+not\s+be\s+(?:used|included|played)(?:\s+together)?\s+in\s+the\s+same\s+deck\.$/iu,
    /^[^\n.!?]+\b(?:may|must)\s+not\s+be\s+(?:used|included|played)\s+together(?:\s+in\s+the\s+same\s+deck)?\.$/iu,
    /^[^\n.!?]+\b(?:is|are)\s+a\s+prohibited\s+combination\.$/iu,
  ],
  membership: [
    /^(?:Only\s+)?cards\s+(?:whose\s+|with\s+)[^\n.!?]+\b(?:includes?|with|has|have)\b[^\n.!?]+\b(?:is|are)\s+eligible(?:\s+for\s+this\s+event)?\.$/iu,
  ],
  rotation: [
    /^Only cards bearing Block [^\n.!?]+ are eligible\.$/iu,
    /^Blocks? [^\n.!?]+ (?:is|are) eligible for rotation\.$/iu,
  ],
  release_timing: [
    /^[^\n.!?]+\b(?:becomes?|is|will be)\s+(?:standard\s+|tournament\s+)*legal(?:\s+for\s+(?:standard\s+)?tournament\s+play)?\s+on\s+(?:\d{4}-\d{2}-\d{2}|\d{1,2}\s+[\p{L}]+\s+\d{4})\.$/iu,
    /^[^\n.!?]+\blegal\s+for\s+tournament\s+play\s+on\s+(?:\d{4}-\d{2}-\d{2}|\d{1,2}\s+[\p{L}]+\s+\d{4})\.$/iu,
  ],
  unresolved: [
    /^[^\n.!?]+\b(?:is|are|remains?)\s+(?:unresolved|unclear|unknown)\.$/iu,
    /^The official notice does not identify whether [^\n.!?]+\.$/iu,
    /^[^\n.!?]+\b(?:cannot be determined|is not stated|awaiting (?:publisher )?clarification)\.$/iu,
  ],
};

function normalizedDirective(directive: string): string {
  return directive === "banned" ? "ban"
    : directive === "limited" ? "copy_limit"
    : directive === "combination" ? "prohibited_combination"
    : directive === "release" ? "release_timing"
    : directive;
}

const operandFieldNames = [
  "maximumCopies",
  "companionCards",
  "membershipAttribute",
  "membershipValues",
  "eligibleBlocks",
  "legalFrom",
  "unresolvedReason",
] as const;

function assertDirectiveSpecificOperands(
  entry: Record<string, unknown>,
  fields: FieldMap,
  directive: string,
): void {
  const normalized = normalizedDirective(directive);
  const owned = new Set<keyof FieldMap>(
    normalized === "copy_limit" ? ["maximumCopies"]
      : normalized === "prohibited_combination" ? ["companionCards"]
      : normalized === "membership"
        ? ["membershipAttribute", "membershipValues"]
      : normalized === "rotation" ? ["eligibleBlocks"]
      : normalized === "release_timing" ? ["legalFrom"]
      : normalized === "unresolved" ? ["unresolvedReason"]
      : [],
  );
  for (const fieldName of operandFieldNames) {
    const value = entry[fields[fieldName]];
    const meaningful =
      value !== undefined &&
      value !== null &&
      (!Array.isArray(value) || value.length > 0);
    if (meaningful && !owned.has(fieldName)) {
      throw new Error(
        `Official Legality directive ${directive} contains foreign operand ${fields[fieldName]}.`,
      );
    }
  }
}

const banSemantics =
  /\b(?:banned?|not\s+(?:currently\s+|tournament\s+)*legal)\b|may not be included/iu;
const copyLimitSemantics =
  /\b(?:limit(?:ed)?\s+(?:of|to)|maximum(?:\s+of)?|up\s+to)\s+(?:a\s+maximum\s+of\s+)?\d+\s+cop(?:y|ies)\b/iu;
const combinationSemantics =
  /\b(?:(?:may|must)\s+not|cannot|can't)\b[\s\S]*\b(?:together|same deck)\b|\bprohibited\s+combination\b/iu;
const membershipSemantics =
  /\b(?:membership|traits?|attributes?)\b[\s\S]*\b(?:includes?|with|has|have|required|requires?)\b/iu;
const rotationSemantics = /\b(?:rotation|blocks?)\b/iu;
const releaseTimingSemantics =
  /\b(?:becomes?|is|will be)\s+(?:standard\s+|tournament\s+)*legal\b[\s\S]*\b\d{4}-\d{2}-\d{2}\b|\blegal\s+for\s+tournament\b[\s\S]*\b\d{4}-\d{2}-\d{2}\b/iu;

function assertNoAdditionalStructuredSemantics(
  directive: string,
  wording: string,
  patterns: readonly RegExp[],
): void {
  if (patterns.some((pattern) => pattern.test(wording))) {
    throw new Error(
      `Official Legality directive ${directive} contains additional structured semantics.`,
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

function requiredNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${name} is invalid.`);
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
