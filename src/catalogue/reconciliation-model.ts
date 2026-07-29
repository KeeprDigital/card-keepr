import type {
  FixtureCandidate,
  FixtureCard,
  FixturePrinting,
} from "./fixture";
import { canonicalJson, sha256Text } from "./serialization";

export type PrintingCompatibility = Readonly<{
  card_id: string;
  source_lineage: string;
  artwork_fingerprint: string;
  printed_fields_digest: string;
  rarity_normalized: string | null;
  treatment: string | null;
}>;

export const compatibilityFields = [
  "card_id",
  "source_lineage",
  "artwork_fingerprint",
  "printed_fields_digest",
  "rarity_normalized",
  "treatment",
] as const;

export type Memberships = Readonly<{
  products: readonly string[];
  distribution_contexts: readonly string[];
  source_buckets: readonly string[];
}>;

export type VocabularyWarning = Readonly<{
  code: "unknown_source_vocabulary";
  source_observation_id: string;
  profile: string;
  path: string;
  raw_value: string;
  detail: string;
}>;

export type ParsedReconciliationObservation = Readonly<{
  sourceObservationId: string;
  candidateWithoutIdentities: {
    card: Omit<FixtureCard, "id">;
    printing: Omit<FixturePrinting, "id" | "card_id">;
  };
  locator: string;
  artworkFingerprint: string;
  printedFieldsDigest: string;
  treatment: string | null;
  demonstrablyNovel: boolean;
  noveltyBasis: string | null;
  memberships: Memberships;
  withdrawal: Withdrawal | null;
  vocabularyWarnings: readonly VocabularyWarning[];
}>;

export type Withdrawal = Readonly<{
  entity: "card" | "printing" | "card_and_printing";
  evidence: string;
}>;

const controlledVocabulary: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  "one-piece@1": {
    "card.card_type": ["leader", "character", "event", "stage", "don"],
    "card.colours": [
      "red",
      "green",
      "blue",
      "purple",
      "black",
      "yellow",
      "white",
      "colourless",
    ],
    "printing.illustration_types": [
      "comic",
      "animation",
      "original",
      "other",
    ],
  },
  "fusion-world@1": {
    "card.card_type": ["leader", "battle", "extra", "energy_marker"],
    "card.colours": ["red", "blue", "green", "yellow", "black"],
    "card.skills.kind": ["front", "back", "ordinary"],
  },
  "digimon@1": {
    "card.card_type": [
      "digi_egg",
      "digimon",
      "tamer",
      "option",
      "digimon_option",
    ],
    "card.colours": [
      "red",
      "green",
      "blue",
      "purple",
      "black",
      "yellow",
      "white",
      "colourless",
    ],
    "card.text_sections.kind": [
      "effect",
      "inherited_effect",
      "security_effect",
      "rule",
      "special_digivolution_condition",
      "dual_effect",
      "dual_rule",
      "link_condition",
      "link_effect",
    ],
  },
  "gundam@1": {
    "card.card_type": [
      "unit",
      "pilot",
      "command",
      "base",
      "resource",
      "ex_base",
      "ex_resource",
      "unit_token",
    ],
    "card.colours": [
      "red",
      "green",
      "blue",
      "purple",
      "black",
      "yellow",
      "white",
      "colourless",
    ],
  },
};

export async function cardIdFor(
  card: Omit<FixtureCard, "id">,
): Promise<string> {
  return `card_${(
    await sha256Text(
      canonicalJson({
        supported_game: card.game,
        official_identity: card.official_identity,
      }),
    )
  ).slice(0, 32)}`;
}

export async function printingIdFor(
  compatibility: PrintingCompatibility,
): Promise<string> {
  return `printing_${(
    await sha256Text(canonicalJson(compatibility))
  ).slice(0, 32)}`;
}

export function compatibilityFor(
  cardId: string,
  sourceLineage: string,
  observation: ParsedReconciliationObservation,
): PrintingCompatibility {
  return {
    card_id: cardId,
    source_lineage: sourceLineage,
    artwork_fingerprint: observation.artworkFingerprint,
    printed_fields_digest: observation.printedFieldsDigest,
    rarity_normalized:
      observation.candidateWithoutIdentities.printing.rarity.normalized,
    treatment: observation.treatment,
  };
}

export function isCompatible(
  left: PrintingCompatibility,
  right: PrintingCompatibility,
): boolean {
  return compatibilityFields.every((field) => left[field] === right[field]);
}

export function candidateWithIdentities(
  observation: ParsedReconciliationObservation,
  cardId: string,
  printingId: string,
): FixtureCandidate {
  return {
    fixture: "first-catalogue",
    selected_games: ["one-piece"],
    cards: [{ id: cardId, ...observation.candidateWithoutIdentities.card }],
    printings: [
      {
        id: printingId,
        card_id: cardId,
        ...observation.candidateWithoutIdentities.printing,
      },
    ],
  };
}

export function parseReconciliationObservation(
  sourceObservationId: string,
  value: unknown,
): ParsedReconciliationObservation {
  const record = requiredRecord(value, "Source Observation value");
  const card = requiredRecord(record.card, "card");
  const printing = requiredRecord(record.printing, "printing");
  const identity = requiredRecord(
    record.identity_evidence,
    "identity_evidence",
  );
  const parsedCard = parseCard(card);
  const parsedPrinting = parsePrinting(printing);
  const warnings = parseOptionalVocabulary(
    sourceObservationId,
    record.optional_vocabulary,
  );
  return {
    sourceObservationId,
    candidateWithoutIdentities: {
      card: parsedCard,
      printing: parsedPrinting,
    },
    locator: requiredString(identity.locator, "identity_evidence.locator"),
    artworkFingerprint: requiredString(
      identity.artwork_fingerprint,
      "identity_evidence.artwork_fingerprint",
    ),
    printedFieldsDigest: requiredString(
      identity.printed_fields_digest,
      "identity_evidence.printed_fields_digest",
    ),
    treatment: optionalString(
      identity.treatment,
      "identity_evidence.treatment",
    ),
    demonstrablyNovel:
      identity.demonstrably_novel === true,
    noveltyBasis: optionalString(
      identity.novelty_basis,
      "identity_evidence.novelty_basis",
    ),
    memberships: parseMemberships(record.memberships),
    withdrawal: parseWithdrawal(record.withdrawal),
    vocabularyWarnings: warnings,
  };
}

function parseWithdrawal(value: unknown): Withdrawal | null {
  if (value === undefined || value === null) return null;
  const record = requiredRecord(value, "withdrawal");
  if (
    record.entity !== "card" &&
    record.entity !== "printing" &&
    record.entity !== "card_and_printing"
  ) {
    throw new Error("withdrawal.entity is invalid.");
  }
  return {
    entity: record.entity,
    evidence: requiredString(record.evidence, "withdrawal.evidence"),
  };
}

function parseCard(value: Record<string, unknown>): Omit<FixtureCard, "id"> {
  const identity = requiredRecord(value.official_identity, "official_identity");
  const gameData = requiredRecord(value.game_data, "card.game_data");
  const attributes = requiredRecord(
    gameData.attributes,
    "card.game_data.attributes",
  );
  if (
    value.game !== "one-piece" ||
    gameData.profile !== "one-piece@1" ||
    !isOnePieceCardAttributes(attributes)
  ) {
    throw new Error("Retained Card evidence is not a valid one-piece@1 Card.");
  }
  if (
    identity.kind !== "card_number" ||
    typeof identity.value !== "string"
  ) {
    throw new Error("Retained Card official identity is invalid.");
  }
  return {
    game: "one-piece",
    official_identity: {
      kind: "card_number",
      value: identity.value,
    },
    name: requiredString(value.name, "card.name"),
    effective_rules_text: requiredString(
      value.effective_rules_text,
      "card.effective_rules_text",
    ),
    game_data: {
      profile: "one-piece@1",
      attributes,
    },
  };
}

function parsePrinting(
  value: Record<string, unknown>,
): Omit<FixturePrinting, "id" | "card_id"> {
  const rarity = requiredRecord(value.rarity, "printing.rarity");
  const gameData = requiredRecord(value.game_data, "printing.game_data");
  const attributes = requiredRecord(
    gameData.attributes,
    "printing.game_data.attributes",
  );
  if (
    gameData.profile !== "one-piece@1" ||
    !Array.isArray(attributes.illustration_types) ||
    attributes.illustration_types.length !== 0 ||
    !attributes.illustration_types.every(
      (item) =>
        typeof item === "string" &&
        controlledVocabulary["one-piece@1"]![
          "printing.illustration_types"
        ]!.includes(item),
    )
  ) {
    throw new Error("Retained Printing evidence is not a valid profile.");
  }
  return {
    rarity: {
      raw: requiredString(rarity.raw, "printing.rarity.raw"),
      normalized: requiredString(
        rarity.normalized,
        "printing.rarity.normalized",
      ),
    },
    printed_rules_text: requiredString(
      value.printed_rules_text,
      "printing.printed_rules_text",
    ),
    game_data: {
      profile: "one-piece@1",
      attributes: {
        illustration_types: [],
      },
    },
  };
}

function parseOptionalVocabulary(
  sourceObservationId: string,
  value: unknown,
): VocabularyWarning[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("optional_vocabulary must be an array.");
  }
  const warnings: VocabularyWarning[] = [];
  for (const item of value) {
    const record = requiredRecord(item, "optional_vocabulary item");
    const profile = requiredString(record.profile, "optional_vocabulary.profile");
    const path = requiredString(record.path, "optional_vocabulary.path");
    const rawValue = requiredString(
      record.raw_value,
      "optional_vocabulary.raw_value",
    );
    const accepted = controlledVocabulary[profile]?.[path];
    if (accepted === undefined || !accepted.includes(rawValue)) {
      warnings.push({
        code: "unknown_source_vocabulary",
        source_observation_id: sourceObservationId,
        profile,
        path,
        raw_value: rawValue,
        detail:
          "The unknown controlled value remains retained Source Observation evidence and was not added to the Game Profile.",
      });
    }
  }
  return warnings.sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)),
  );
}

function parseMemberships(value: unknown): Memberships {
  const record = requiredRecord(value, "memberships");
  return {
    products: stringArray(record.products, "memberships.products"),
    distribution_contexts: stringArray(
      record.distribution_contexts,
      "memberships.distribution_contexts",
    ),
    source_buckets: stringArray(
      record.source_buckets,
      "memberships.source_buckets",
    ),
  };
}

function isOnePieceCardAttributes(
  value: Record<string, unknown>,
): value is FixtureCard["game_data"]["attributes"] {
  return (
    ["leader", "character", "event", "stage", "don"].includes(
      String(value.card_type),
    ) &&
    Array.isArray(value.colours) &&
    Array.isArray(value.battle_attributes) &&
    Array.isArray(value.traits) &&
    Array.isArray(value.block_icons) &&
    (value.cost === null || Number.isInteger(value.cost)) &&
    (value.life === null || Number.isInteger(value.life)) &&
    (value.power === null || Number.isInteger(value.power)) &&
    (value.counter === null || Number.isInteger(value.counter)) &&
    (value.effect_text === null || typeof value.effect_text === "string") &&
    (value.trigger_text === null || typeof value.trigger_text === "string")
  );
}

function requiredRecord(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return requiredString(value, field);
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${field} must be a string array.`);
  }
  return [...new Set(value)].sort();
}
