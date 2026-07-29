import type {
  FixtureCard,
  FixturePrinting,
  SupportedGame,
} from "./fixture";
import { canonicalJson } from "./serialization";
import {
  canonicalProfileAttributes,
  requiredProfileContract,
  sourceFieldWarning,
  type ProfileWarning,
} from "./reconciliation-profile";

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

export type ReconciliationWarning = ProfileWarning;

export type ParsedReconciliationObservation = Readonly<{
  sourceObservationId: string;
  candidateWithoutIdentities: {
    card: Omit<FixtureCard, "id">;
    printing: Omit<FixturePrinting, "id" | "card_id"> | null;
  };
  locator: string | null;
  variantKey: string | null;
  artworkFingerprint: string | null;
  printedFieldsDigest: string | null;
  treatment: string | null;
  demonstrablyNovel: boolean;
  noveltyProofComplete: boolean;
  memberships: Memberships;
  withdrawal: Withdrawal | null;
  sourceWarnings: readonly ReconciliationWarning[];
}>;

export type Withdrawal = Readonly<{
  entity: "card" | "printing" | "card_and_printing";
  evidence: string;
}>;

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
  "variant_key",
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
  const contract = requiredProfileContract(profile);
  if (rawCard.game !== contract.game) {
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
  const canonicalCardAttributes = canonicalProfileAttributes(
    sourceObservationId,
    profile,
    "card",
    rawCardAttributes,
    warnings,
  );
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
  if (
    don &&
    (profile !== "one-piece@1" ||
      canonicalCardAttributes.card_type !== "don")
  ) {
    throw new Error(
      "The functional DON!! identity requires the one-piece@1 don Card shape.",
    );
  }
  if (record.printing === undefined) {
    return {
      sourceObservationId,
      candidateWithoutIdentities: { card, printing: null },
      locator: null,
      variantKey: null,
      artworkFingerprint: null,
      printedFieldsDigest: null,
      treatment: null,
      demonstrablyNovel: false,
      noveltyProofComplete: true,
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
  const canonicalPrintingAttributes = canonicalProfileAttributes(
    sourceObservationId,
    profile,
    "printing",
    rawPrintingAttributes,
    warnings,
  );
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
  const variantKey = nullableString(
    identityEvidence.variant_key,
    "identity_evidence.variant_key",
  );
  if (profile === "gundam@1" && variantKey === null) {
    throw new Error(
      "Gundam Printing evidence requires an exact variant key or suffix.",
    );
  }
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
    variantKey,
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
        sourceFieldWarning(
          sourceObservationId,
          profile,
          prefix === "" ? field : `${prefix}.${field}`,
          raw,
        ),
      );
    }
  }
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
