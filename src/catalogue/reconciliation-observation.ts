import type {
  FixtureCard,
  FixturePrinting,
  SupportedGame,
} from "./fixture";
import { canonicalJson } from "./serialization";

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

export type ReconciliationWarning = Readonly<{
  code: "unknown_source_vocabulary" | "unknown_source_field";
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
    printing: Omit<FixturePrinting, "id" | "card_id"> | null;
  };
  locator: string | null;
  artworkFingerprint: string | null;
  printedFieldsDigest: string | null;
  treatment: string | null;
  demonstrablyNovel: boolean;
  noveltyProofComplete: boolean;
  structurallyComplete: boolean;
  memberships: Memberships;
  withdrawal: Withdrawal | null;
  sourceWarnings: readonly ReconciliationWarning[];
}>;

export type Withdrawal = Readonly<{
  entity: "card" | "printing" | "card_and_printing";
  evidence: string;
}>;

type ProfileContract = {
  game: SupportedGame;
  cardFields: readonly string[];
  printingFields: readonly string[];
  controlledValues: Readonly<Record<string, readonly string[]>>;
};

const sharedColours = [
  "red",
  "green",
  "blue",
  "purple",
  "black",
  "yellow",
  "white",
  "colourless",
] as const;

const profileContracts: Readonly<Record<string, ProfileContract>> = {
  "one-piece@1": {
    game: "one-piece",
    cardFields: [
      "card_type",
      "colours",
      "cost",
      "life",
      "battle_attributes",
      "power",
      "counter",
      "traits",
      "block_icons",
      "effect_text",
      "trigger_text",
    ],
    printingFields: ["illustration_types"],
    controlledValues: {
      "card.card_type": ["leader", "character", "event", "stage", "don"],
      "card.colours": sharedColours,
      "printing.illustration_types": [
        "comic",
        "animation",
        "original",
        "other",
      ],
    },
  },
  "fusion-world@1": {
    game: "fusion-world",
    cardFields: [
      "card_type",
      "colours",
      "cost",
      "specified_cost",
      "power",
      "combo_power",
      "traits",
      "skills",
      "leader_faces",
    ],
    printingFields: [],
    controlledValues: {
      "card.card_type": ["leader", "battle", "extra", "energy_marker"],
      "card.colours": sharedColours,
      "card.skills.kind": ["ordinary", "front", "back"],
    },
  },
  "digimon@1": {
    game: "digimon",
    cardFields: [
      "card_type",
      "colours",
      "level",
      "play_cost",
      "use_cost",
      "dp",
      "form",
      "attribute",
      "traits",
      "digivolution_requirements",
      "text_sections",
      "dual_colours",
      "dual_cost",
      "link_dp",
    ],
    printingFields: ["alternative_art"],
    controlledValues: {
      "card.card_type": [
        "digi_egg",
        "digimon",
        "tamer",
        "option",
        "digimon_option",
      ],
      "card.colours": sharedColours,
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
  },
  "gundam@1": {
    game: "gundam",
    cardFields: [
      "card_type",
      "colours",
      "level",
      "cost",
      "block_icon",
      "effect_text",
      "zone",
      "traits",
      "link_condition",
      "ap",
      "hp",
      "series_titles",
    ],
    printingFields: ["alternate_art"],
    controlledValues: {
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
      "card.colours": sharedColours,
    },
  },
};

const rootFields = new Set([
  "card",
  "printing",
  "identity_evidence",
  "appearance_evidence",
  "completeness",
  "memberships",
  "withdrawal",
]);
const cardFields = new Set([
  "game",
  "official_identity",
  "name",
  "effective_rules_text",
  "game_data",
]);
const printingFields = new Set([
  "rarity",
  "printed_rules_text",
  "game_data",
]);
const gameDataFields = new Set(["profile", "attributes"]);
const identityFields = new Set(["kind", "value"]);
const rarityFields = new Set(["raw", "normalized"]);
const identityEvidenceFields = new Set([
  "locator",
  "artwork_fingerprint",
  "printed_fields_digest",
  "treatment",
  "demonstrably_novel",
  "novelty_basis",
]);
const noveltyBasisFields = new Set([
  "kind",
  "source_url",
  "artwork_fingerprint",
]);
const appearanceFields = new Set(["images"]);
const appearanceImageFields = new Set([
  "role",
  "source_url",
  "artwork_fingerprint",
]);
const completenessFields = new Set([
  "structurally_complete",
  "required_surfaces_complete",
  "partitions_complete",
  "declared_record_count",
  "parsed_record_count",
]);
const membershipFields = new Set([
  "products",
  "distribution_contexts",
  "source_buckets",
]);
const withdrawalFields = new Set(["entity", "evidence"]);

export function parseReconciliationObservation(
  sourceObservationId: string,
  value: unknown,
): ParsedReconciliationObservation {
  const record = requiredRecord(value, "Source Observation value");
  const rawCard = requiredRecord(record.card, "card");
  const gameData = requiredRecord(rawCard.game_data, "card.game_data");
  const profile = requiredString(gameData.profile, "card.game_data.profile");
  const contract = profileContracts[profile];
  if (contract === undefined || rawCard.game !== contract.game) {
    throw new Error("Retained Card evidence has an unsupported profile binding.");
  }
  const warnings: ReconciliationWarning[] = [];
  detectUnknownFields(
    sourceObservationId,
    profile,
    record,
    rootFields,
    "",
    warnings,
  );
  detectUnknownFields(
    sourceObservationId,
    profile,
    gameData,
    gameDataFields,
    "card.game_data",
    warnings,
  );
  detectUnknownFields(
    sourceObservationId,
    profile,
    requiredRecord(rawCard.official_identity, "card.official_identity"),
    identityFields,
    "card.official_identity",
    warnings,
  );
  inspectSharedObservationFields(
    sourceObservationId,
    profile,
    record,
    warnings,
  );
  detectUnknownFields(
    sourceObservationId,
    profile,
    rawCard,
    cardFields,
    "card",
    warnings,
  );
  const rawCardAttributes = requiredRecord(
    gameData.attributes,
    "card.game_data.attributes",
  );
  const canonicalCardAttributes = canonicalAttributes(
    sourceObservationId,
    profile,
    "card",
    rawCardAttributes,
    contract.cardFields,
    contract.controlledValues,
    warnings,
  );
  validateCardAttributes(profile, canonicalCardAttributes);
  const identity = parseOfficialIdentity(rawCard.official_identity, contract.game);
  const card: Omit<FixtureCard, "id"> = {
    game: contract.game,
    official_identity: identity,
    name: requiredString(rawCard.name, "card.name"),
    effective_rules_text: nullableString(
      rawCard.effective_rules_text,
      "card.effective_rules_text",
    ),
    game_data: {
      profile: profile as FixtureCard["game_data"]["profile"],
      attributes: canonicalCardAttributes,
    },
  };
  const don =
    identity.kind === "functional_designation" &&
    identity.value === "DON!!";
  if (don) {
    if (
      profile !== "one-piece@1" ||
      canonicalCardAttributes.card_type !== "don" ||
      record.printing !== undefined
    ) {
      throw new Error("The generic DON!! Card must not invent a Printing.");
    }
    return {
      sourceObservationId,
      candidateWithoutIdentities: { card, printing: null },
      locator: null,
      artworkFingerprint: null,
      printedFieldsDigest: null,
      treatment: null,
      demonstrablyNovel: false,
      noveltyProofComplete: true,
      structurallyComplete: structuralCompleteness(record.completeness),
      memberships: parseMemberships(record.memberships),
      withdrawal: parseWithdrawal(record.withdrawal, false),
      sourceWarnings: sortedWarnings(warnings),
    };
  }

  const rawPrinting = requiredRecord(record.printing, "printing");
  detectUnknownFields(
    sourceObservationId,
    profile,
    rawPrinting,
    printingFields,
    "printing",
    warnings,
  );
  const rarity = requiredRecord(rawPrinting.rarity, "printing.rarity");
  const printingGameData = requiredRecord(
    rawPrinting.game_data,
    "printing.game_data",
  );
  if (printingGameData.profile !== profile) {
    throw new Error("Card and Printing Game Profiles must agree.");
  }
  detectUnknownFields(
    sourceObservationId,
    profile,
    rarity,
    rarityFields,
    "printing.rarity",
    warnings,
  );
  detectUnknownFields(
    sourceObservationId,
    profile,
    printingGameData,
    gameDataFields,
    "printing.game_data",
    warnings,
  );
  const rawPrintingAttributes = requiredRecord(
    printingGameData.attributes,
    "printing.game_data.attributes",
  );
  const canonicalPrintingAttributes = canonicalAttributes(
    sourceObservationId,
    profile,
    "printing",
    rawPrintingAttributes,
    contract.printingFields,
    contract.controlledValues,
    warnings,
  );
  validatePrintingAttributes(profile, canonicalPrintingAttributes);
  const printing: Omit<FixturePrinting, "id" | "card_id"> = {
    rarity: {
      raw: nullableString(rarity.raw, "printing.rarity.raw"),
      normalized: nullableString(
        rarity.normalized,
        "printing.rarity.normalized",
      ),
    },
    printed_rules_text: nullableString(
      rawPrinting.printed_rules_text,
      "printing.printed_rules_text",
    ),
    game_data: {
      profile: profile as FixturePrinting["game_data"] extends null
        ? never
        : NonNullable<FixturePrinting["game_data"]>["profile"],
      attributes: canonicalPrintingAttributes,
    },
  };
  const identityEvidence = requiredRecord(
    record.identity_evidence,
    "identity_evidence",
  );
  const artworkFingerprint = requiredString(
    identityEvidence.artwork_fingerprint,
    "identity_evidence.artwork_fingerprint",
  );
  const appearanceComplete = appearanceEvidenceComplete(
    record.appearance_evidence,
    artworkFingerprint,
    profile,
    canonicalCardAttributes,
  );
  return {
    sourceObservationId,
    candidateWithoutIdentities: { card, printing },
    locator: requiredString(
      identityEvidence.locator,
      "identity_evidence.locator",
    ),
    artworkFingerprint,
    printedFieldsDigest: requiredString(
      identityEvidence.printed_fields_digest,
      "identity_evidence.printed_fields_digest",
    ),
    treatment: nullableString(
      identityEvidence.treatment,
      "identity_evidence.treatment",
    ),
    demonstrablyNovel: identityEvidence.demonstrably_novel === true,
    noveltyProofComplete:
      appearanceComplete &&
      validNoveltyBasis(
        identityEvidence.novelty_basis,
        artworkFingerprint,
      ),
    structurallyComplete:
      structuralCompleteness(record.completeness) && appearanceComplete,
    memberships: parseMemberships(record.memberships),
    withdrawal: parseWithdrawal(record.withdrawal, true),
    sourceWarnings: sortedWarnings(warnings),
  };
}

function parseOfficialIdentity(
  value: unknown,
  game: SupportedGame,
): FixtureCard["official_identity"] {
  const identity = requiredRecord(value, "card.official_identity");
  if (
    identity.kind === "functional_designation" &&
    identity.value === "DON!!" &&
    game === "one-piece"
  ) {
    return { kind: "functional_designation", value: "DON!!" };
  }
  if (
    identity.kind !== "card_number" ||
    typeof identity.value !== "string" ||
    identity.value.length === 0
  ) {
    throw new Error("Retained Card official identity is invalid.");
  }
  return { kind: "card_number", value: identity.value };
}

function canonicalAttributes(
  sourceObservationId: string,
  profile: string,
  entity: "card" | "printing",
  raw: Record<string, unknown>,
  acceptedFields: readonly string[],
  controlled: Readonly<Record<string, readonly string[]>>,
  warnings: ReconciliationWarning[],
): Record<string, unknown> {
  const canonical: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(raw)) {
    const path = `${entity}.${field}`;
    if (!acceptedFields.includes(field)) {
      warnings.push(fieldWarning(sourceObservationId, profile, path, value));
      continue;
    }
    const accepted = controlled[path];
    if (accepted !== undefined) {
      if (Array.isArray(value)) {
        canonical[field] = value.filter((item) => {
          if (typeof item === "string" && accepted.includes(item)) return true;
          warnings.push(
            vocabularyWarning(sourceObservationId, profile, path, item),
          );
          return false;
        });
      } else if (typeof value === "string" && accepted.includes(value)) {
        canonical[field] = value;
      } else {
        warnings.push(
          vocabularyWarning(sourceObservationId, profile, path, value),
        );
        canonical[field] = null;
      }
      continue;
    }
    canonical[field] = value;
  }
  canonicalizeNestedProfileValues(
    sourceObservationId,
    profile,
    canonical,
    warnings,
  );
  return canonical;
}

function canonicalizeNestedProfileValues(
  sourceObservationId: string,
  profile: string,
  attributes: Record<string, unknown>,
  warnings: ReconciliationWarning[],
): void {
  if (profile === "fusion-world@1" && Array.isArray(attributes.skills)) {
    attributes.skills = canonicalTypedTextArray(
      sourceObservationId,
      profile,
      "card.skills",
      attributes.skills,
      ["ordinary", "front", "back"],
      warnings,
    );
  }
  if (
    profile === "digimon@1" &&
    Array.isArray(attributes.text_sections)
  ) {
    attributes.text_sections = canonicalTypedTextArray(
      sourceObservationId,
      profile,
      "card.text_sections",
      attributes.text_sections,
      profileContracts[profile]!.controlledValues[
        "card.text_sections.kind"
      ]!,
      warnings,
    );
  }
}

function canonicalTypedTextArray(
  sourceObservationId: string,
  profile: string,
  path: string,
  values: unknown[],
  acceptedKinds: readonly string[],
  warnings: ReconciliationWarning[],
): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const [index, item] of values.entries()) {
    if (!isRecord(item)) {
      warnings.push(
        fieldWarning(sourceObservationId, profile, `${path}[${index}]`, item),
      );
      continue;
    }
    detectUnknownFields(
      sourceObservationId,
      profile,
      item,
      new Set(["kind", "text"]),
      `${path}[${index}]`,
      warnings,
    );
    if (
      typeof item.kind !== "string" ||
      !acceptedKinds.includes(item.kind)
    ) {
      warnings.push(
        vocabularyWarning(
          sourceObservationId,
          profile,
          `${path}.kind`,
          item.kind,
        ),
      );
      continue;
    }
    if (typeof item.text !== "string") {
      throw new Error(`${path}[${index}].text must be a string.`);
    }
    result.push({ kind: item.kind, text: item.text });
  }
  return result;
}

function inspectSharedObservationFields(
  sourceObservationId: string,
  profile: string,
  record: Record<string, unknown>,
  warnings: ReconciliationWarning[],
): void {
  inspectOptionalRecord(
    record.completeness,
    completenessFields,
    "completeness",
  );
  inspectOptionalRecord(record.memberships, membershipFields, "memberships");
  inspectOptionalRecord(record.withdrawal, withdrawalFields, "withdrawal");
  const identity = inspectOptionalRecord(
    record.identity_evidence,
    identityEvidenceFields,
    "identity_evidence",
  );
  if (identity !== null) {
    inspectOptionalRecord(
      identity.novelty_basis,
      noveltyBasisFields,
      "identity_evidence.novelty_basis",
    );
  }
  const appearance = inspectOptionalRecord(
    record.appearance_evidence,
    appearanceFields,
    "appearance_evidence",
  );
  if (appearance !== null && Array.isArray(appearance.images)) {
    for (const [index, image] of appearance.images.entries()) {
      inspectOptionalRecord(
        image,
        appearanceImageFields,
        `appearance_evidence.images[${index}]`,
      );
    }
  }

  function inspectOptionalRecord(
    value: unknown,
    fields: ReadonlySet<string>,
    path: string,
  ): Record<string, unknown> | null {
    if (value === undefined || value === null) return null;
    if (!isRecord(value)) return null;
    detectUnknownFields(
      sourceObservationId,
      profile,
      value,
      fields,
      path,
      warnings,
    );
    return value;
  }
}

function validateCardAttributes(
  profile: string,
  value: Record<string, unknown>,
): void {
  const contract = profileContracts[profile]!;
  const required =
    profile === "fusion-world@1"
      ? contract.cardFields.filter((field) => field !== "leader_faces")
      : profile === "digimon@1"
        ? contract.cardFields.filter((field) =>
            !["dual_colours", "dual_cost", "link_dp"].includes(field),
          )
        : contract.cardFields;
  if (required.some((field) => !(field in value))) {
    throw new Error(`Retained ${profile} Card evidence is incomplete.`);
  }
  if (
    !Array.isArray(value.colours) ||
    typeof value.card_type !== "string"
  ) {
    throw new Error(`Retained ${profile} Card evidence is invalid.`);
  }
  if (
    profile === "fusion-world@1" &&
    value.card_type === "leader" &&
    (!Array.isArray(value.leader_faces) ||
      value.leader_faces.length !== 2)
  ) {
    throw new Error("A Fusion World Leader requires two canonical faces.");
  }
}

function validatePrintingAttributes(
  profile: string,
  value: Record<string, unknown>,
): void {
  if (
    profile === "digimon@1" &&
    typeof value.alternative_art !== "boolean"
  ) {
    throw new Error("A Digimon Printing requires alternative_art.");
  }
  if (
    profile === "gundam@1" &&
    typeof value.alternate_art !== "boolean"
  ) {
    throw new Error("A Gundam Printing requires alternate_art.");
  }
  if (
    profile === "one-piece@1" &&
    "illustration_types" in value &&
    !Array.isArray(value.illustration_types)
  ) {
    throw new Error("One Piece illustration_types must be an array.");
  }
}

function structuralCompleteness(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    value.structurally_complete === true &&
    value.required_surfaces_complete === true &&
    value.partitions_complete === true &&
    Number.isInteger(value.declared_record_count) &&
    Number.isInteger(value.parsed_record_count) &&
    value.declared_record_count === value.parsed_record_count
  );
}

function appearanceEvidenceComplete(
  value: unknown,
  artworkFingerprint: string,
  profile: string,
  cardAttributes: Record<string, unknown>,
): boolean {
  if (!isRecord(value) || !Array.isArray(value.images)) return false;
  const roles = new Set<string>();
  for (const item of value.images) {
    if (
      !isRecord(item) ||
      (item.role !== "front" && item.role !== "back" && item.role !== "other") ||
      typeof item.source_url !== "string" ||
      !item.source_url.startsWith("https://") ||
      item.artwork_fingerprint !== artworkFingerprint
    ) {
      return false;
    }
    roles.add(item.role);
  }
  return profile === "fusion-world@1" && cardAttributes.card_type === "leader"
    ? roles.has("front") && roles.has("back")
    : roles.has("front");
}

function validNoveltyBasis(value: unknown, artworkFingerprint: string): boolean {
  return (
    isRecord(value) &&
    value.kind === "official_printing_image" &&
    typeof value.source_url === "string" &&
    value.source_url.startsWith("https://") &&
    value.artwork_fingerprint === artworkFingerprint
  );
}

function parseWithdrawal(
  value: unknown,
  hasPrinting: boolean,
): Withdrawal | null {
  if (value === undefined || value === null) return null;
  const record = requiredRecord(value, "withdrawal");
  if (
    record.entity !== "card" &&
    record.entity !== "printing" &&
    record.entity !== "card_and_printing"
  ) {
    throw new Error("withdrawal.entity is invalid.");
  }
  if (!hasPrinting && record.entity !== "card") {
    throw new Error("A Card-only observation cannot withdraw a Printing.");
  }
  return {
    entity: record.entity,
    evidence: requiredString(record.evidence, "withdrawal.evidence"),
  };
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

function detectUnknownFields(
  sourceObservationId: string,
  profile: string,
  value: Record<string, unknown>,
  accepted: ReadonlySet<string>,
  prefix: string,
  warnings: ReconciliationWarning[],
): void {
  for (const [field, raw] of Object.entries(value)) {
    if (!accepted.has(field)) {
      warnings.push(
        fieldWarning(
          sourceObservationId,
          profile,
          prefix === "" ? field : `${prefix}.${field}`,
          raw,
        ),
      );
    }
  }
}

function fieldWarning(
  sourceObservationId: string,
  profile: string,
  path: string,
  raw: unknown,
): ReconciliationWarning {
  return {
    code: "unknown_source_field",
    source_observation_id: sourceObservationId,
    profile,
    path,
    raw_value: rawValue(raw),
    detail:
      "The unknown Official Source field remains retained Source Observation evidence and was not added to the Game Profile.",
  };
}

function vocabularyWarning(
  sourceObservationId: string,
  profile: string,
  path: string,
  raw: unknown,
): ReconciliationWarning {
  return {
    code: "unknown_source_vocabulary",
    source_observation_id: sourceObservationId,
    profile,
    path,
    raw_value: rawValue(raw),
    detail:
      "The unknown controlled value remains retained Source Observation evidence and was not added to the Game Profile.",
  };
}

function rawValue(value: unknown): string {
  return typeof value === "string" ? value : canonicalJson(value);
}

function sortedWarnings(
  warnings: ReconciliationWarning[],
): ReconciliationWarning[] {
  return warnings.sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)),
  );
}

function requiredRecord(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} must be an object.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return requiredString(value, field);
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${field} must be a string array.`);
  }
  return [...new Set(value)].sort();
}
