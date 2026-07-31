import type {
  CatalogueCandidate,
  CatalogueCard,
  SupportedGame,
} from "./catalogue-candidate";
import { validateMembershipPredicate } from "./reconciliation-profile";
import {
  canonicalJson,
  compareUtf8,
  sha256Text,
} from "./serialization";

export type LegalityRegion = "EN-OCEANIA" | "EN-ASIA" | "EN-US";

export type LegalityRuleEffect =
  | { type: "eligible" }
  | { type: "ban" }
  | { type: "copy_limit"; maximum_copies: number }
  | { type: "prohibited_combination"; with_card_ids: readonly string[] }
  | {
      type: "membership";
      attribute: string;
      includes_any: readonly string[];
    }
  | { type: "rotation"; eligible_blocks: readonly string[] }
  | { type: "release_timing"; legal_from: string }
  | { type: "unresolved"; reason: string };

export type LegalityRule = {
  id: string;
  official_id: string;
  game: SupportedGame;
  region: LegalityRegion;
  format: string;
  event_tier: string | null;
  effective_from: string;
  effective_until: string | null;
  card_ids: readonly string[];
  official_wording: string;
  effect: LegalityRuleEffect;
  source_lineage: string;
  source_snapshot_id: string;
  source_observation_set_id: string;
  source_observation_id: string;
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
  effect:
    | Exclude<LegalityRuleEffect, { type: "prohibited_combination" }>
    | {
        type: "prohibited_combination";
        with_card_numbers: readonly string[];
      };
};

export function parseRetainedLegalityRules(
  value: unknown,
  provenance: {
    game: SupportedGame;
    sourceLineage: string;
    sourceSnapshotId: string;
    sourceObservationSetId: string;
    sourceObservationId: string;
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
  const cardsByNumber = new Map(
    cards.flatMap((card) =>
      card.official_identity.kind === "card_number"
        ? [[`${card.game}:${card.official_identity.value}`, card.id] as const]
        : [],
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
    const cardIds = rule.card_numbers.map((number) =>
      requiredCardId(cardsByNumber, rule.game, number),
    );
    const effect =
      rule.effect.type === "prohibited_combination"
        ? {
            type: "prohibited_combination" as const,
            with_card_ids: rule.effect.with_card_numbers.map((number) =>
              requiredCardId(cardsByNumber, rule.game, number),
            ),
          }
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

export function legalityRulesForCandidate(
  prior: CatalogueCandidate | null,
  sourceLineage: string,
  incoming: readonly LegalityRule[],
): LegalityRule[] {
  assertUniqueRuleIds(prior?.legality_rules ?? []);
  assertUniqueRuleIds(incoming);
  const priorById = new Map(
    (prior?.legality_rules ?? []).map((rule) => [rule.id, rule]),
  );
  const observed = incoming.map((rule) => {
    const {
      last_observed_revision_id: _incomingLastObservedRevisionId,
      ...freshRule
    } = rule;
    const priorRule = priorById.get(rule.id);
    if (
      priorRule !== undefined &&
      canonicalJson(identityBoundSemantics(priorRule)) !==
        canonicalJson(identityBoundSemantics(rule))
    ) {
      throw new Error(
        `Legality Rule official identity ${rule.official_id} has changed semantics; the Official Source must publish a new official identity.`,
      );
    }
    const firstRevisionId =
      rule.first_revision_id ?? priorRule?.first_revision_id;
    return {
      ...freshRule,
      ...(firstRevisionId === undefined
        ? {}
        : { first_revision_id: firstRevisionId }),
      current: true,
      last_missing_revision_id:
        priorRule?.last_missing_revision_id ?? null,
    };
  });
  return [
    ...(prior?.legality_rules ?? []).flatMap((rule) => {
      if (rule.source_lineage !== sourceLineage) return [rule];
      if (incoming.some((incomingRule) => incomingRule.id === rule.id)) {
        return [];
      }
      return [
        {
          ...rule,
          current: false,
          last_missing_revision_id:
            rule.last_missing_revision_id ?? null,
        },
      ];
    }),
    ...observed,
  ].sort((left, right) => compareUtf8(left.id, right.id));
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

export function legalityExportKind(
  effect: LegalityRuleEffect,
):
  | "eligible"
  | "restricted"
  | "not_legal"
  | "combination"
  | "conditional"
  | "rotation"
  | "release"
  | "indeterminate" {
  switch (effect.type) {
    case "eligible":
      return "eligible";
    case "membership":
      return "conditional";
    case "release_timing":
      return "release";
    case "unresolved":
      return "indeterminate";
    case "copy_limit":
      return "restricted";
    case "ban":
      return "not_legal";
    case "prohibited_combination":
      return "combination";
    case "rotation":
      return "rotation";
  }
}

export function legalityRuleCardIds(rule: LegalityRule): string[] {
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
  const effect = parseEffect(record.effect);
  const effectiveFrom = requiredDate(
    record.effective_from,
    "legality rule effective_from",
  );
  const effectiveUntil =
    record.effective_until === undefined ||
    record.effective_until === null
      ? null
      : requiredDate(
          record.effective_until,
          "legality rule effective_until",
        );
  if (effectiveUntil !== null && effectiveUntil <= effectiveFrom) {
    throw new Error(
      "A Legality Rule effective interval must end after it starts.",
    );
  }
  return {
    official_id: requiredOpaqueId(
      record.id,
      "official legality rule id",
    ),
    game: provenance.game,
    region,
    format: requiredString(record.format, "legality rule format"),
    event_tier:
      record.event_tier === undefined || record.event_tier === null
        ? null
        : requiredString(record.event_tier, "legality rule event tier"),
    effective_from: effectiveFrom,
    effective_until: effectiveUntil,
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
  };
}

function identityBoundSemantics(rule: LegalityRule): unknown {
  return {
    official_id: rule.official_id,
    game: rule.game,
    region: rule.region,
    format: rule.format,
    event_tier: rule.event_tier,
    effective_from: rule.effective_from,
    effective_until: rule.effective_until,
    card_ids: [...rule.card_ids].sort(compareUtf8),
    official_wording: rule.official_wording,
    effect: rule.effect,
    source_lineage: rule.source_lineage,
  };
}

function assertUniqueRuleIds(rules: readonly LegalityRule[]): void {
  const identities = new Set<string>();
  for (const rule of rules) {
    if (identities.has(rule.id)) {
      throw new Error(`Duplicate Legality Rule identity ${rule.id}.`);
    }
    identities.add(rule.id);
  }
}

function parseEffect(value: unknown): RetainedLegalityRule["effect"] {
  const effect = requiredRecord(value, "legality rule effect");
  switch (effect.type) {
    case "eligible":
    case "ban":
      assertOnlyFields(effect, ["type"]);
      return { type: effect.type };
    case "copy_limit": {
      assertOnlyFields(effect, ["type", "maximum_copies"]);
      const maximum = effect.maximum_copies;
      if (!Number.isInteger(maximum) || Number(maximum) < 1) {
        throw new Error("A copy-limit rule requires a positive integer.");
      }
      return { type: "copy_limit", maximum_copies: Number(maximum) };
    }
    case "prohibited_combination":
      assertOnlyFields(effect, ["type", "with_card_numbers"]);
      return {
        type: "prohibited_combination",
        with_card_numbers: requiredCardNumbers(
          effect.with_card_numbers,
          "prohibited combination card numbers",
          false,
        ),
      };
    case "membership":
      assertOnlyFields(effect, ["type", "attribute", "includes_any"]);
      return {
        type: "membership",
        attribute: requiredString(
          effect.attribute,
          "membership attribute",
        ),
        includes_any: requiredStrings(
          effect.includes_any,
          "membership values",
          false,
        ),
      };
    case "rotation":
      assertOnlyFields(effect, ["type", "eligible_blocks"]);
      return {
        type: "rotation",
        eligible_blocks: requiredStrings(
          effect.eligible_blocks,
          "rotation blocks",
          false,
        ),
      };
    case "release_timing":
      assertOnlyFields(effect, ["type", "legal_from"]);
      return {
        type: "release_timing",
        legal_from: requiredDate(
          effect.legal_from,
          "release timing legal_from",
        ),
      };
    case "unresolved":
      assertOnlyFields(effect, ["type", "reason"]);
      return {
        type: "unresolved",
        reason: requiredString(effect.reason, "unresolved scope reason"),
      };
    default:
      throw new Error(
        "Legality Rule wording uses an effect the installed adapter cannot represent.",
      );
  }
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

function regionForLineage(lineage: string): LegalityRegion {
  if (lineage === "gundam-en-asia") return "EN-ASIA";
  if (lineage === "gundam-en-us") return "EN-US";
  if (
    lineage === "one-piece-en" ||
    lineage === "fusion-world-en" ||
    lineage === "digimon-en"
  ) {
    return "EN-OCEANIA";
  }
  throw new Error("Legality Rule source lineage is unsupported.");
}

function requiredDate(value: unknown, name: string): string {
  const text = requiredString(value, name);
  const date = new Date(`${text}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(text) ||
    Number.isNaN(date.valueOf()) ||
    !date.toISOString().startsWith(text)
  ) {
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
