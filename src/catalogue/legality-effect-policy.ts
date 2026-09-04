import { isIsoCalendarDate, compareUtf8, type LegalityRuleEffect } from "./shared";
// The Legality Rule effect shape lives in the leaf module
// `catalogue-candidate-types`; it stays importable from here.
export type { LegalityRuleEffect } from "./shared";

export type ParsedLegalityRuleEffect =
  | Exclude<LegalityRuleEffect, { type: "prohibited_combination" }>
  | { type: "prohibited_combination"; with_card_numbers: readonly string[] };

export type LegalityEvaluation = "legal" | "restricted" | "not_legal" | "indeterminate";

export type LegalityExportKind =
  | "eligible"
  | "restricted"
  | "not_legal"
  | "combination"
  | "conditional"
  | "rotation"
  | "release"
  | "indeterminate";

type LegalityEffectStrategy = Readonly<{
  exportKind: LegalityExportKind;
  parse: (record: Record<string, unknown>) => ParsedLegalityRuleEffect;
  evaluate: (
    effect: LegalityRuleEffect,
    attributes: Readonly<Record<string, unknown>>,
    on: string,
  ) => LegalityEvaluation;
}>;

const strategies = {
  eligible: strategy(
    "eligible",
    ["type"],
    () => ({ type: "eligible" }),
    (effect) => (effect.type === "eligible" ? "legal" : mismatch()),
  ),
  ban: strategy(
    "not_legal",
    ["type"],
    () => ({ type: "ban" }),
    (effect) => (effect.type === "ban" ? "not_legal" : mismatch()),
  ),
  copy_limit: strategy(
    "restricted",
    ["type", "maximum_copies"],
    (effect) => {
      if (!Number.isInteger(effect.maximum_copies) || Number(effect.maximum_copies) < 1) {
        throw new Error("A copy-limit rule requires a positive integer.");
      }
      return { type: "copy_limit", maximum_copies: Number(effect.maximum_copies) };
    },
    (effect) => (effect.type === "copy_limit" ? "restricted" : mismatch()),
  ),
  prohibited_combination: strategy(
    "combination",
    ["type", "with_card_numbers"],
    (effect) => ({
      type: "prohibited_combination",
      with_card_numbers: requiredStrings(effect.with_card_numbers, "prohibited combination card numbers", false),
    }),
    (effect) => (effect.type === "prohibited_combination" ? "restricted" : mismatch()),
  ),
  membership: strategy(
    "conditional",
    ["type", "attribute", "includes_any"],
    (effect) => ({
      type: "membership",
      attribute: requiredString(effect.attribute, "membership attribute"),
      includes_any: requiredStrings(effect.includes_any, "membership values", false),
    }),
    (effect, attributes) => {
      if (effect.type !== "membership") return mismatch();
      const raw = attributes[effect.attribute];
      if (raw === null || raw === undefined) return "indeterminate";
      const values = Array.isArray(raw) ? raw : [raw];
      return values.some(
        (value) =>
          typeof value === "string" &&
          effect.includes_any.some((member) => member.toUpperCase() === value.toUpperCase()),
      )
        ? "legal"
        : "not_legal";
    },
  ),
  rotation: strategy(
    "rotation",
    ["type", "eligible_blocks"],
    (effect) => ({
      type: "rotation",
      eligible_blocks: requiredStrings(effect.eligible_blocks, "rotation blocks", false),
    }),
    (effect, attributes) => {
      if (effect.type !== "rotation") return mismatch();
      const raw = attributes.block_icons ?? attributes.block_icon;
      if (raw === null || raw === undefined) return "indeterminate";
      const blocks = Array.isArray(raw) ? raw : [raw];
      return blocks.some(
        (block) =>
          typeof block === "string" &&
          effect.eligible_blocks.some((eligible) => eligible.toUpperCase() === block.toUpperCase()),
      )
        ? "legal"
        : "not_legal";
    },
  ),
  release_timing: strategy(
    "release",
    ["type", "legal_from"],
    (effect) => ({
      type: "release_timing",
      legal_from: requiredDate(effect.legal_from, "release timing legal_from"),
    }),
    (effect, _attributes, on) =>
      effect.type === "release_timing" ? (on >= effect.legal_from ? "legal" : "not_legal") : mismatch(),
  ),
  unresolved: strategy(
    "indeterminate",
    ["type", "reason"],
    (effect) => ({
      type: "unresolved",
      reason: requiredString(effect.reason, "unresolved scope reason"),
    }),
    (effect) => (effect.type === "unresolved" ? "indeterminate" : mismatch()),
  ),
} satisfies Record<LegalityRuleEffect["type"], LegalityEffectStrategy>;

function strategy(
  exportKind: LegalityExportKind,
  fields: readonly string[],
  parse: (record: Record<string, unknown>) => ParsedLegalityRuleEffect,
  evaluate: LegalityEffectStrategy["evaluate"],
): LegalityEffectStrategy {
  return {
    exportKind,
    parse: (record) => {
      assertOnlyFields(record, fields);
      return parse(record);
    },
    evaluate,
  };
}

export function parseLegalityRuleEffect(value: unknown): ParsedLegalityRuleEffect {
  const effect = requiredRecord(value, "legality rule effect");
  if (typeof effect.type !== "string" || !(effect.type in strategies)) {
    throw new Error("Legality Rule wording uses an effect the installed adapter cannot represent.");
  }
  return strategies[effect.type as LegalityRuleEffect["type"]].parse(effect);
}

export function parseStoredLegalityRuleEffect(value: unknown): LegalityRuleEffect {
  const effect = requiredRecord(value, "stored Legality Rule effect");
  if (effect.type === "prohibited_combination") {
    assertOnlyFields(effect, ["type", "with_card_ids"]);
    return {
      type: "prohibited_combination",
      with_card_ids: requiredStrings(effect.with_card_ids, "stored prohibited combination Card ids", false),
    };
  }
  const parsed = parseLegalityRuleEffect(effect);
  if (parsed.type === "prohibited_combination") {
    return mismatch();
  }
  return parsed;
}

export function legalityExportKind(effect: LegalityRuleEffect): LegalityExportKind {
  return strategies[effect.type].exportKind;
}

export function evaluateLegalityRuleEffect(
  effect: LegalityRuleEffect,
  attributes: Readonly<Record<string, unknown>>,
  on: string,
): LegalityEvaluation {
  return strategies[effect.type].evaluate(effect, attributes, on);
}

export function canonicalLegalityRuleEffect(effect: LegalityRuleEffect): LegalityRuleEffect {
  switch (effect.type) {
    case "prohibited_combination":
      return {
        ...effect,
        with_card_ids: canonicalStringSet(effect.with_card_ids),
      };
    case "membership":
      return {
        ...effect,
        includes_any: canonicalStringSet(effect.includes_any),
      };
    case "rotation":
      return {
        ...effect,
        eligible_blocks: canonicalStringSet(effect.eligible_blocks),
      };
    default:
      return effect;
  }
}

function mismatch(): never {
  throw new Error("A Legality effect was dispatched to the wrong strategy.");
}

function requiredDate(value: unknown, name: string): string {
  const date = requiredString(value, name);
  if (!isIsoCalendarDate(date)) throw new Error(`${name} must be an exact ISO date.`);
  return date;
}

function requiredStrings(value: unknown, name: string, emptyAllowed: boolean): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
  const values = value.map((item) => requiredString(item, name));
  if (!emptyAllowed && values.length === 0) throw new Error(`${name} must not be empty.`);
  return canonicalStringSet(values);
}

function canonicalStringSet(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.normalize("NFC")))].sort(compareUtf8);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error(`${name} must be non-empty text.`);
  }
  return value;
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyFields(record: Record<string, unknown>, fields: readonly string[]): void {
  const allowed = new Set(fields);
  const unexpected = Object.keys(record).find((field) => !allowed.has(field));
  if (unexpected !== undefined) {
    throw new Error(`Legality Rule field ${unexpected} cannot be represented by the installed adapter.`);
  }
}
