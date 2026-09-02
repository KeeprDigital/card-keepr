import { createHash } from "node:crypto";
import type {
  CatalogueCard,
  CataloguePrintingImage,
  CataloguePrinting,
  SupportedGame,
} from "./catalogue-candidate";
import { canonicalJson } from "./serialization";
import {
  canonicalProfileAttributes,
  requiredProfileContract,
  sourceFieldWarning,
  type ProfileWarning,
} from "./reconciliation-profile";
import {
  parsedOfficialArtworkIdentity,
} from "./official-artwork-identity.ts";
import {
  parseRulesTextErrata,
  type ParsedRulesTextErratum,
} from "./errata-rules-text";

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

export type ParsedCardPrintingObservation = Readonly<{
  kind: "card_printing";
  sourceObservationId: string;
  candidateWithoutIdentities: {
    card: Omit<CatalogueCard, "id"> | null;
    printing: Omit<CataloguePrinting, "id" | "card_id"> | null;
  };
  locator: string | null;
  variantKey: string | null;
  artworkFingerprint: string | null;
  artworkIdentityExplicit: boolean;
  printedFieldsDigest: string | null;
  treatment: string | null;
  demonstrablyNovel: boolean;
  noveltyProofComplete: boolean;
  printingImages: readonly Omit<
    CataloguePrintingImage,
    "id" | "printing_id" | "object_key"
  >[];
  memberships: Memberships;
  withdrawal: Withdrawal | null;
  productReleaseValue: unknown;
  sourceWarnings: readonly ReconciliationWarning[];
  errata: readonly ParsedRulesTextErratum[];
}>;

export type ParsedOfficialErratumObservation = Readonly<{
  kind: "official_erratum";
  sourceObservationId: string;
  game: "one-piece" | "fusion-world" | "digimon" | "gundam";
  target:
    | Readonly<{
        type: "card";
        officialIdentity: CatalogueCard["official_identity"];
      }>
    | Readonly<{
        type: "printing";
        officialIdentity: CatalogueCard["official_identity"];
        locator: string;
      }>;
  publishedOn: string;
  effectiveFrom: string | null;
  observedPrintedRulesText: string;
  correctedRulesText: string | null;
  officialWording: string;
  appliesToParallelPrintings: boolean;
  sourceFragment: string;
}>;

export type ParsedReconciliationObservation =
  | ParsedCardPrintingObservation
  | ParsedOfficialErratumObservation;

export type Withdrawal = Readonly<{
  entity: "card" | "printing" | "card_and_printing";
  state: "withdrawn";
  effective_at: string;
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
  "product_release_catalogue",
  "source_sidecar",
  "errata",
  "legality_rules",
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
  "media_type",
  "width",
  "height",
  "content_sha256",
  "content_base64",
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
const withdrawalFields = new Set([
  "entity",
  "state",
  "effective_at",
  "evidence",
]);

export function parseReconciliationObservation(
  sourceObservationId: string,
  value: unknown,
): ParsedReconciliationObservation {
  const record = requiredRecord(value, "Source Observation value");
  if (record.kind === "official_erratum") {
    return parseOfficialErratumObservation(sourceObservationId, record);
  }
  if (record.card === undefined) {
    if (record.product_release_catalogue === undefined) {
      throw new Error(
        "A retained observation requires Card or Product catalogue evidence.",
      );
    }
    const warnings: ReconciliationWarning[] = [];
    detectUnknownFields(
      sourceObservationId,
      "products-and-releases@1",
      record,
      new Set([
        "completeness",
        "listing_identity_evidence",
        "product_release_catalogue",
        "source_sidecar",
      ]),
      "",
      warnings,
    );
    if (record.listing_identity_evidence !== undefined) {
      const listingIdentity = requiredRecord(
        record.listing_identity_evidence,
        "listing_identity_evidence",
      );
      if (
        Object.keys(listingIdentity).some(
          (field) => field !== "locator" && field !== "canonical",
        ) ||
        typeof listingIdentity.locator !== "string" ||
        listingIdentity.locator.length === 0 ||
        typeof listingIdentity.canonical !== "string" ||
        listingIdentity.canonical.length === 0
      ) {
        throw new Error("listing_identity_evidence is invalid.");
      }
    }
    inspectSourceSidecar(
      sourceObservationId,
      "products-and-releases@1",
      record.source_sidecar,
      warnings,
    );
    return {
      kind: "card_printing",
      sourceObservationId,
      candidateWithoutIdentities: { card: null, printing: null },
      locator: null,
      variantKey: null,
      artworkFingerprint: null,
      artworkIdentityExplicit: false,
      printedFieldsDigest: null,
      treatment: null,
      demonstrablyNovel: false,
      noveltyProofComplete: true,
      printingImages: [],
      memberships: {
        products: [],
        distribution_contexts: [],
        source_buckets: [],
      },
      withdrawal: null,
      productReleaseValue: record.product_release_catalogue,
      sourceWarnings: sortedWarnings(warnings),
      errata: [],
    };
  }
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
  inspectSourceSidecar(sourceObservationId, profile, record.source_sidecar, warnings);
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
  const card: Omit<CatalogueCard, "id"> = {
    game: contract.game,
    official_identity: identity,
    name: requiredString(rawCard.name, "card.name"),
    effective_rules_text: nullableString(
      rawCard.effective_rules_text,
      "card.effective_rules_text",
    ),
    game_data: {
      profile: profile as CatalogueCard["game_data"]["profile"],
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
  if (
    profile === "one-piece@1" &&
    canonicalCardAttributes.card_type === "don" &&
    !don
  ) {
    throw new Error(
      "The One Piece card_type don requires functional DON!! identity.",
    );
  }
  if (record.printing === undefined) {
    return {
      kind: "card_printing",
      sourceObservationId,
      candidateWithoutIdentities: { card, printing: null },
      locator: null,
      variantKey: null,
      artworkFingerprint: null,
      artworkIdentityExplicit: false,
      printedFieldsDigest: null,
      treatment: null,
      demonstrablyNovel: false,
      noveltyProofComplete: true,
      printingImages: [],
      memberships: parseMemberships(record.memberships),
      withdrawal: parseWithdrawal(record.withdrawal, false),
      productReleaseValue: record.product_release_catalogue,
      sourceWarnings: sortedWarnings(warnings),
      errata: parseRulesTextErrata(record.errata),
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
  const printing: Omit<CataloguePrinting, "id" | "card_id"> = {
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
      profile: profile as CataloguePrinting["game_data"] extends null
        ? never
        : NonNullable<CataloguePrinting["game_data"]>["profile"],
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
  const artworkIdentity =
    parsedOfficialArtworkIdentity(artworkFingerprint);
  const appearance = appearanceEvidence(
    record.appearance_evidence,
    artworkFingerprint,
    profile,
    canonicalCardAttributes,
  );
  return {
    kind: "card_printing",
    sourceObservationId,
    candidateWithoutIdentities: { card, printing },
    locator: requiredString(
      identityEvidence.locator,
      "identity_evidence.locator",
    ),
    variantKey,
    artworkFingerprint,
    artworkIdentityExplicit:
      !artworkFingerprint.startsWith("official-artwork:") ||
      typeof artworkIdentity?.artwork_id === "string",
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
      appearance.complete &&
      validNoveltyBasis(
        identityEvidence.novelty_basis,
        artworkFingerprint,
      ),
    printingImages: appearance.images,
    memberships: parseMemberships(record.memberships),
    withdrawal: parseWithdrawal(record.withdrawal, true),
    productReleaseValue: record.product_release_catalogue,
    sourceWarnings: sortedWarnings(warnings),
    errata: parseRulesTextErrata(record.errata),
  };
}

function inspectSourceSidecar(
  sourceObservationId: string,
  profile: string,
  value: unknown,
  warnings: ReconciliationWarning[],
): void {
  if (value === undefined) return;
  const sidecar = requiredRecord(value, "source_sidecar");
  const unmapped = sidecar.unmapped_optional_fields;
  if (!Array.isArray(unmapped)) {
    throw new Error("source_sidecar.unmapped_optional_fields must be an array.");
  }
  for (const item of unmapped) {
    const field = requiredRecord(item, "source_sidecar unmapped field");
    warnings.push(
      sourceFieldWarning(
        sourceObservationId,
        profile,
        requiredString(field.path, "source_sidecar unmapped field path"),
        field.value,
      ),
    );
  }
}

function parseOfficialErratumObservation(
  sourceObservationId: string,
  record: Record<string, unknown>,
): ParsedOfficialErratumObservation {
  const fields = [
    "kind",
    "game",
    "target",
    "published_on",
    "effective_from",
    "observed_printed_rules_text",
    "corrected_rules_text",
    "official_wording",
    "applies_to_parallel_printings",
    "source",
    "completeness",
  ];
  assertOnlyFields(record, fields, "Official Erratum");
  if (
    record.game !== "one-piece" &&
    record.game !== "fusion-world" &&
    record.game !== "digimon" &&
    record.game !== "gundam"
  ) {
    throw new Error("Official Erratum Supported Game is invalid.");
  }
  const game = record.game;
  const target = requiredRecord(record.target, "Official Erratum target");
  if (target.type !== "card" && target.type !== "printing") {
    throw new Error(
      "Official Erratum target type is invalid.",
    );
  }
  assertOnlyFields(
    target,
    target.type === "card"
      ? ["type", "official_identity"]
      : ["type", "official_identity", "locator"],
    "Official Erratum target",
  );
  const identity = parseOfficialIdentity(target.official_identity, game);
  const targetLocator = target.type === "printing"
    ? requiredString(target.locator, "Official Erratum target locator")
    : null;
  const source = requiredRecord(record.source, "Official Erratum source");
  assertOnlyFields(
    source,
    ["fragment", "display_name", "image_url"],
    "Official Erratum source",
  );
  requiredString(source.display_name, "Official Erratum source display_name");
  const imageUrl = requiredString(
    source.image_url,
    "Official Erratum source image_url",
  );
  const imageOrigin = game === "one-piece"
    ? "https://en.onepiece-cardgame.com/images/"
    : game === "fusion-world"
      ? "https://www.dbs-cardgame.com/fw/images/"
      : game === "digimon"
        ? "https://world.digimoncard.com/"
        : "https://www.gundam-gcg.com/gcg/bccard/";
  if (!imageUrl.startsWith(imageOrigin)) {
    throw new Error("Official Erratum image provenance is invalid.");
  }
  const fragment = requiredString(
    source.fragment,
    "Official Erratum source fragment",
  );
  if (!/^#[A-Za-z][A-Za-z0-9_-]+$/.test(fragment)) {
    throw new Error("Official Erratum source fragment is invalid.");
  }
  const completeness = requiredRecord(
    record.completeness,
    "Official Erratum completeness",
  );
  assertOnlyFields(
    completeness,
    [
      "structurally_complete",
      "required_surfaces_complete",
      "partitions_complete",
      "declared_record_count",
      "parsed_record_count",
    ],
    "Official Erratum completeness",
  );
  if (
    completeness.structurally_complete !== true ||
    completeness.required_surfaces_complete !== true ||
    completeness.partitions_complete !== true ||
    completeness.declared_record_count !== 1 ||
    completeness.parsed_record_count !== 1
  ) {
    throw new Error("Official Erratum completeness proof is invalid.");
  }
  if (typeof record.applies_to_parallel_printings !== "boolean") {
    throw new Error(
      "Official Erratum parallel Printing applicability is invalid.",
    );
  }
  return {
    kind: "official_erratum",
    sourceObservationId,
    game,
    target: targetLocator === null
      ? {
          type: "card",
          officialIdentity: identity,
        }
      : {
          type: "printing",
          officialIdentity: identity,
          locator: targetLocator,
        },
    publishedOn: exactDate(record.published_on, "published_on"),
    effectiveFrom:
      record.effective_from === null
        ? null
        : exactDate(record.effective_from, "effective_from"),
    observedPrintedRulesText: requiredString(
      record.observed_printed_rules_text,
      "Official Erratum observed_printed_rules_text",
    ),
    correctedRulesText: record.corrected_rules_text === null
      ? null
      : requiredString(
          record.corrected_rules_text,
          "Official Erratum corrected_rules_text",
        ),
    officialWording: requiredString(
      record.official_wording,
      "Official Erratum official_wording",
    ),
    appliesToParallelPrintings: record.applies_to_parallel_printings,
    sourceFragment: fragment,
  };
}

function assertOnlyFields(
  record: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const extra = Object.keys(record).filter((field) => !expected.includes(field));
  if (extra.length > 0) {
    throw new Error(
      `${name} contains undeclared fields: ${extra.sort().join(", ")}.`,
    );
  }
  const missing = expected.filter((field) => !(field in record));
  if (missing.length > 0) {
    throw new Error(
      `${name} is missing fields: ${missing.sort().join(", ")}.`,
    );
  }
}

function exactDate(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)
  ) {
    throw new Error(`Official Erratum ${name} is invalid.`);
  }
  const instant = new Date(`${value}T00:00:00.000Z`);
  if (instant.toISOString().slice(0, 10) !== value) {
    throw new Error(`Official Erratum ${name} is invalid.`);
  }
  return value;
}

function parseOfficialIdentity(
  value: unknown,
  game: SupportedGame,
): CatalogueCard["official_identity"] {
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
    identity.value.length === 0 ||
    identity.value !== identity.value.trim() ||
    /\s/.test(identity.value)
  ) {
    throw new Error("Retained Card official card number is invalid.");
  }
  const canonical = identity.value.toUpperCase();
  const acceptedNumberPatterns: Record<SupportedGame, RegExp> = {
    "one-piece": /^[A-Z]{1,5}[0-9]{0,3}-[A-Z0-9]{1,6}$/,
    "fusion-world": /^[A-Z]{1,5}[0-9]{0,3}-[A-Z0-9]{1,6}$/,
    digimon: /^[A-Z]{1,5}[0-9]{0,3}-[A-Z0-9]{1,6}$/,
    gundam: /^[A-Z]{1,5}[0-9]{0,3}-[A-Z0-9]{1,6}$/,
  };
  if (!acceptedNumberPatterns[game].test(canonical)) {
    throw new Error("Retained Card official card number is invalid.");
  }
  return { kind: "card_number", value: canonical };
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

function appearanceEvidence(
  value: unknown,
  artworkFingerprint: string,
  profile: string,
  cardAttributes: Record<string, unknown>,
): {
  complete: boolean;
  images: Omit<
    CataloguePrintingImage,
    "id" | "printing_id" | "object_key"
  >[];
} {
  if (!isRecord(value) || !Array.isArray(value.images)) {
    return { complete: false, images: [] };
  }
  const declaredRoles = new Set<string>();
  const capturedRoles = new Set<string>();
  const captured: Omit<
    CataloguePrintingImage,
    "id" | "printing_id" | "object_key"
  >[] = [];
  for (const item of value.images) {
    if (
      !isRecord(item) ||
      (item.role !== "front" && item.role !== "back" && item.role !== "other") ||
      typeof item.source_url !== "string" ||
      !item.source_url.startsWith("https://") ||
      item.artwork_fingerprint !== artworkFingerprint
    ) {
      return { complete: false, images: [] };
    }
    if (declaredRoles.has(item.role)) {
      return { complete: false, images: [] };
    }
    declaredRoles.add(item.role);
    if (
      typeof item.media_type === "string" &&
      item.media_type.startsWith("image/") &&
      Number.isInteger(item.width) &&
      Number(item.width) > 0 &&
      Number.isInteger(item.height) &&
      Number(item.height) > 0 &&
      typeof item.content_sha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(item.content_sha256) &&
      typeof item.content_base64 === "string" &&
      item.content_base64.length > 0
    ) {
      const bytes = decodeBase64(item.content_base64);
      const contentDigest = createHash("sha256").update(bytes).digest("hex");
      if (contentDigest !== item.content_sha256) {
        return { complete: false, images: [] };
      }
      captured.push({
        role: item.role,
        media_type: item.media_type as `image/${string}`,
        width: Number(item.width),
        height: Number(item.height),
        content_sha256: item.content_sha256,
        content_byte_length: bytes.byteLength,
        source_url: item.source_url,
        content_base64: item.content_base64,
      });
      capturedRoles.add(item.role);
    }
  }
  const requiredRoles =
    profile === "fusion-world@1" && cardAttributes.card_type === "leader"
      ? ["front", "back"]
      : ["front"];
  const complete =
    captured.length === value.images.length &&
    requiredRoles.every((role) => capturedRoles.has(role));
  return { complete, images: captured };
}

function decodeBase64(value: string): Uint8Array {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) =>
      character.charCodeAt(0)
    );
  } catch {
    throw new Error("Printing Image captured bytes are not valid base64.");
  }
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
  if (record.state !== "withdrawn") {
    throw new Error("withdrawal.state is invalid.");
  }
  const effectiveAt = requiredString(
    record.effective_at,
    "withdrawal.effective_at",
  );
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(effectiveAt) ||
    new Date(effectiveAt).toISOString() !== effectiveAt
  ) {
    throw new Error("withdrawal.effective_at must be an ISO instant.");
  }
  return {
    entity: record.entity,
    state: "withdrawn",
    effective_at: effectiveAt,
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
