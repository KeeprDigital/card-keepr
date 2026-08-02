import type {
  CatalogueCard,
  SupportedGame,
} from "./catalogue-candidate";
import { validateMembershipPredicate } from "./reconciliation-profile";
import {
  canonicalJson,
  compareUtf8,
  sha256Text,
} from "./serialization";
import { isIsoCalendarDate } from "./calendar-date.mjs";
import {
  parseLegalityRuleEffect,
  type ParsedLegalityRuleEffect,
} from "./legality-effect-policy";
export {
  evaluateLegalityRuleEffect,
  legalityExportKind,
  type LegalityEvaluation,
  type LegalityRuleEffect,
} from "./legality-effect-policy";
import type { LegalityRuleEffect } from "./legality-effect-policy";
import { registeredLegalitySourceScope } from "./source-adapters";
export {
  legalityRulesForCandidate,
  normalizedLegalityRuleLifecycle,
  type LegalityRuleLifecycle,
} from "./legality-rule-lifecycle";

export type LegalityRegion = "EN-OCEANIA" | "EN-ASIA" | "EN-US";

export type LegalityRuleSourceFieldPointers = {
  official_wording: string;
  effective_from: string;
  effective_until: string;
  unresolved_scope: string;
  region: string;
  format: string;
  event_tier: string;
  card_numbers: string;
  effect: string;
};

export type UnresolvedLegalityScope = Readonly<{
  dimensions: readonly ("effective_interval" | "event_tier")[];
}>;

export type LegalityRule = {
  id: string;
  official_id: string;
  game: SupportedGame;
  region: LegalityRegion;
  format: string;
  event_tier: string | null;
  effective_from: string | null;
  effective_until: string | null;
  unresolved_scope: UnresolvedLegalityScope | null;
  card_ids: readonly string[];
  official_wording: string;
  effect: LegalityRuleEffect;
  source_lineage: string;
  source_snapshot_id: string;
  source_observation_set_id: string;
  source_observation_id: string;
  source_observation_pointer: string;
  source_field_pointers: LegalityRuleSourceFieldPointers;
  first_revision_id?: string;
  last_observed_revision_id?: string;
  current?: boolean;
  last_missing_revision_id?: string | null;
};

export type RetainedLegalityRule = Omit<
  LegalityRule,
  "id" | "card_ids" | "effect"
> & {
  card_numbers: readonly string[];
  effect: RetainedLegalityRuleEffect;
};

type RetainedLegalityRuleEffect = ParsedLegalityRuleEffect;

export function parseRetainedLegalityRules(
  value: unknown,
  provenance: {
    game: SupportedGame;
    sourceLineage: string;
    sourceSnapshotId: string;
    sourceObservationSetId: string;
    sourceObservationId: string;
    sourceValuePointer: string;
  },
): RetainedLegalityRule[] {
  if (!isRecord(value) || value.legality_rules === undefined) return [];
  if (!Array.isArray(value.legality_rules)) {
    throw new Error("Legality Rules must be an array.");
  }
  return value.legality_rules.map((item, index) =>
    parseRule(item, provenance, index),
  );
}

export async function resolveLegalityRuleCards(
  rules: readonly RetainedLegalityRule[],
  cards: readonly CatalogueCard[],
): Promise<LegalityRule[]> {
  const cardsByOfficialIdentity = new Map(
    cards.map((card) =>
      [`${card.game}:${card.official_identity.value}`, card.id] as const
    ),
  );
  const identities = new Set<string>();
  const resolved: LegalityRule[] = [];
  for (const rule of rules) {
    const id = await canonicalLegalityRuleId(
      rule.source_lineage,
      rule.official_id,
    );
    if (identities.has(id)) {
      throw new Error(`Duplicate Legality Rule identity ${id}.`);
    }
    identities.add(id);
    if (rule.effect.type === "membership") {
      validateMembershipPredicate(
        `${rule.game}@1`,
        rule.effect.attribute,
        rule.effect.includes_any,
      );
    }
    const cardIds = canonicalCardIds(
      rule.card_numbers.map((number) =>
        requiredCardId(cardsByOfficialIdentity, rule.game, number)
      ),
    );
    if (rule.unresolved_scope !== null && cardIds.length === 0) {
      throw new Error(
        `Legality Rule ${rule.official_id} with unresolved scope must identify at least one Card.`,
      );
    }
    const effect =
      rule.effect.type === "prohibited_combination"
        ? resolvedProhibitedCombination(
            rule,
            cardIds,
            canonicalCardIds(
              rule.effect.with_card_numbers.map((number) =>
                requiredCardId(cardsByOfficialIdentity, rule.game, number)
              ),
            ),
          )
        : rule.effect;
    const { card_numbers: _numbers, ...withoutNumbers } = rule;
    resolved.push({
      ...withoutNumbers,
      id,
      card_ids: cardIds,
      effect,
    });
  }
  return resolved;
}

function canonicalCardIds(cardIds: readonly string[]): string[] {
  return [...new Set(cardIds)].sort(compareUtf8);
}

function resolvedProhibitedCombination(
  rule: RetainedLegalityRule,
  cardIds: readonly string[],
  withCardIds: readonly string[],
): LegalityRuleEffect {
  if (cardIds.length === 0 || withCardIds.length === 0) {
    throw new Error(
      `Legality Rule ${rule.official_id} requires non-empty direct and companion prohibited-combination operands.`,
    );
  }
  const directCardIds = new Set(cardIds);
  const overlappingCardId = withCardIds.find((cardId) =>
    directCardIds.has(cardId)
  );
  if (overlappingCardId !== undefined) {
    throw new Error(
      `Legality Rule ${rule.official_id} assigns Card ${overlappingCardId} to both direct and prohibited-combination operands.`,
    );
  }
  return {
    type: "prohibited_combination",
    with_card_ids: withCardIds,
  };
}

export async function canonicalLegalityRuleId(
  sourceLineage: string,
  officialId: string,
): Promise<string> {
  return `legality_rule_${await sha256Text(
    canonicalJson({
      official_id: officialId,
      source_lineage: sourceLineage,
    }),
  )}`;
}

export function legalityRuleCardIds(
  rule: Pick<LegalityRule, "card_ids" | "effect">,
): string[] {
  return [
    ...new Set([
      ...rule.card_ids,
      ...(rule.effect.type === "prohibited_combination"
        ? rule.effect.with_card_ids
        : []),
    ]),
  ].sort(compareUtf8);
}

function parseRule(
  value: unknown,
  provenance: {
    game: SupportedGame;
    sourceLineage: string;
    sourceSnapshotId: string;
    sourceObservationSetId: string;
    sourceObservationId: string;
    sourceValuePointer: string;
  },
  index: number,
): RetainedLegalityRule {
  const record = requiredRecord(value, `legality_rules[${index}]`);
  assertOnlyFields(record, [
    "id",
    "game",
    "region",
    "format",
    "event_tier",
    "effective_from",
    "effective_until",
    "unresolved_scope",
    "card_numbers",
    "official_wording",
    "effect",
    "representable",
  ]);
  const representable = record.representable;
  if (representable !== true) {
    throw new Error(
      `Legality Rule ${requiredOpaqueId(record.id, "legality rule id")} cannot be represented without invented precision.`,
    );
  }
  const game = requiredString(record.game, "legality rule game");
  if (game !== provenance.game) {
    throw new Error("Legality Rule game conflicts with its source envelope.");
  }
  const region = requiredRegion(record.region);
  if (region !== regionForLineage(provenance.sourceLineage)) {
    throw new Error(
      "Legality Rule region conflicts with its separate source lineage.",
    );
  }
  const effect = parseLegalityRuleEffect(record.effect);
  const effectiveFrom = record.effective_from === null
    ? null
    : requiredDate(
      record.effective_from,
      "legality rule effective_from",
    );
  if (!("effective_until" in record)) {
    throw new Error(
      "Legality Rule effective_until must be explicitly retained as a date or null.",
    );
  }
  if (!("event_tier" in record)) {
    throw new Error(
      "Legality Rule event_tier must be explicitly retained as a value or null.",
    );
  }
  const effectiveUntil =
    record.effective_until === null
      ? null
      : requiredDate(
          record.effective_until,
          "legality rule effective_until",
        );
  if (
    effectiveFrom !== null && effectiveUntil !== null &&
    effectiveUntil <= effectiveFrom
  ) {
    throw new Error(
      "A Legality Rule effective interval must end after it starts.",
    );
  }
  const unresolvedScope = parsedUnresolvedScope(record.unresolved_scope);
  if (
    unresolvedScope !== null &&
    (effect.type !== "unresolved" ||
      (unresolvedScope.dimensions.includes("effective_interval")
        ? effectiveFrom !== null || effectiveUntil !== null
        : effectiveFrom === null) ||
      (unresolvedScope.dimensions.includes("event_tier") &&
        record.event_tier !== null))
  ) {
    throw new Error("Legality Rule unresolved scope conflicts with its exact context.");
  }
  if (effectiveFrom === null && unresolvedScope === null) {
    throw new Error(
      "Legality Rule without an effective interval requires explicit unresolved scope.",
    );
  }
  const sourceObservationPointer =
    `${provenance.sourceValuePointer}/legality_rules/${index}`;
  return {
    official_id: requiredOpaqueId(
      record.id,
      "official legality rule id",
    ),
    game: provenance.game,
    region,
    format: requiredString(record.format, "legality rule format"),
    event_tier:
      record.event_tier === null
        ? null
        : requiredString(record.event_tier, "legality rule event tier"),
    effective_from: effectiveFrom,
    effective_until: effectiveUntil,
    unresolved_scope: unresolvedScope,
    card_numbers: requiredCardNumbers(
      record.card_numbers,
      "legality rule card_numbers",
      true,
    ),
    official_wording: requiredString(
      record.official_wording,
      "legality rule official wording",
    ),
    effect,
    source_lineage: provenance.sourceLineage,
    source_snapshot_id: provenance.sourceSnapshotId,
    source_observation_set_id: provenance.sourceObservationSetId,
    source_observation_id: provenance.sourceObservationId,
    source_observation_pointer: sourceObservationPointer,
    source_field_pointers: {
      official_wording: `${sourceObservationPointer}/official_wording`,
      effective_from: `${sourceObservationPointer}/effective_from`,
      effective_until: `${sourceObservationPointer}/effective_until`,
      unresolved_scope: `${sourceObservationPointer}/unresolved_scope`,
      region: `${sourceObservationPointer}/region`,
      format: `${sourceObservationPointer}/format`,
      event_tier: `${sourceObservationPointer}/event_tier`,
      card_numbers: `${sourceObservationPointer}/card_numbers`,
      effect: `${sourceObservationPointer}/effect`,
    },
  };
}

function parsedUnresolvedScope(value: unknown): UnresolvedLegalityScope | null {
  if (value === null) return null;
  const scope = requiredRecord(value, "legality rule unresolved_scope");
  assertOnlyFields(scope, ["dimensions"]);
  if (!Array.isArray(scope.dimensions)) {
    throw new Error("Legality Rule unresolved_scope dimensions must be an array.");
  }
  const dimensions = scope.dimensions.map((dimension) => {
    if (dimension !== "effective_interval" && dimension !== "event_tier") {
      throw new Error("Legality Rule unresolved_scope dimension is unsupported.");
    }
    return dimension;
  });
  if (
    dimensions.length === 0 || new Set(dimensions).size !== dimensions.length ||
    dimensions.join(",") !== [...dimensions].sort().join(",")
  ) {
    throw new Error(
      "Legality Rule unresolved_scope dimensions must be non-empty, unique, and canonical.",
    );
  }
  return { dimensions };
}

function requiredCardId(
  cards: ReadonlyMap<string, string>,
  game: SupportedGame,
  number: string,
): string {
  const cardId = cards.get(`${game}:${number.toUpperCase()}`);
  if (cardId === undefined) {
    throw new Error(
      `Legality Rule references Card Number ${number} outside the selected candidate.`,
    );
  }
  return cardId;
}

function requiredRegion(value: unknown): LegalityRegion {
  if (value !== "EN-OCEANIA" && value !== "EN-ASIA" && value !== "EN-US") {
    throw new Error("Legality Rule region is unsupported.");
  }
  return value;
}

export function regionForLineage(lineage: string): LegalityRegion {
  return registeredLegalitySourceScope(lineage).region;
}

function requiredDate(value: unknown, name: string): string {
  const text = requiredString(value, name);
  if (!isIsoCalendarDate(text)) {
    throw new Error(`${name} must be an ISO date.`);
  }
  return text;
}

function requiredCardNumbers(
  value: unknown,
  name: string,
  allowEmpty: boolean,
): string[] {
  return [
    ...new Set(
      requiredStrings(value, name, allowEmpty).map((item) =>
        item.toUpperCase(),
      ),
    ),
  ].sort(compareUtf8);
}

function requiredStrings(
  value: unknown,
  name: string,
  allowEmpty: boolean,
): string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        item.length === 0 ||
        item !== item.trim(),
    )
  ) {
    throw new Error(`${name} must be an array of non-empty strings.`);
  }
  return [...new Set(value)].sort(compareUtf8);
}

function requiredOpaqueId(value: unknown, name: string): string {
  const id = requiredString(value, name);
  if (id.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) {
    throw new Error(`${name} must be an opaque identity.`);
  }
  return id;
}

function requiredString(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function requiredRecord(
  value: unknown,
  name: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${name} must be an object.`);
  return value;
}

function assertOnlyFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedFields = new Set(allowed);
  const unexpected = Object.keys(value).find(
    (field) => !allowedFields.has(field),
  );
  if (unexpected !== undefined) {
    throw new Error(
      `Legality Rule field ${unexpected} cannot be represented by the installed adapter.`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
