import { createHash } from "node:crypto";
import { AdapterParseFailure, adapterUrl, decodeAdapterUtf8 } from "./adapter-parse-failure";
import type { SourceAdapterParseContext } from "./source-adapter-registration-types";
import type { TcgdexSourceAdmissionEvidenceObservation } from "./adapter-observations";
import { qualifiedTcgdexCard } from "./tcgdex-discovery";

/** A source record and its claims are evidence, not a qualified Card or treatment. */
export function tcgdexReviewEvidence(bytes: Uint8Array, context: SourceAdapterParseContext) {
  const { card, set, membership } = qualifiedTcgdexCard(bytes, context);
  const category = text(card.category);
  text(card.name);
  validateClaims(card);
  const sourceUrl = card.image === undefined ? null : sourceImageUrl(card.image);
  const issues: {
    code: "card_identity_unresolved" | "printing_treatment_unresolved" | "category_unresolved";
    source_paths: string[];
  }[] = [
    {
      code: "card_identity_unresolved",
      source_paths: [
        "tcgdex_card.id",
        "tcgdex_card.set.id",
        "tcgdex_card.localId",
        "tcgdex_set.serie.id",
        "tcgdex_set.releaseDate",
      ],
    },
    { code: "printing_treatment_unresolved", source_paths: ["tcgdex_card.variants_detailed"] },
  ];
  if (!["Pokemon", "Trainer", "Energy"].includes(category))
    issues.push({ code: "category_unresolved", source_paths: ["tcgdex_card.category"] });
  return {
    observation_type: "source_admission_evidence" as const,
    game: "pokemon" as const,
    source_lineage: "tcgdex-pokemon-en" as const,
    locator: membership.id,
    source_membership: { set_id: set.id, local_id: membership.localId },
    target: { kind: "unresolved_record" as const },
    issues,
    appearance_evidence: {
      images:
        sourceUrl === null
          ? []
          : [
              {
                association: "source_record" as const,
                role: "front" as const,
                source_url: sourceUrl,
                // This fingerprint attributes raw image evidence only. It never names
                // a canonical design, Printing, or qualified physical treatment.
                artwork_fingerprint: `tcgdex-pokemon-en:source-record-image:${createHash("sha256")
                  .update(JSON.stringify([membership.id, "front", sourceUrl]))
                  .digest("hex")}`,
              },
            ],
    },
    source_sidecar: { source_record_json: decodeAdapterUtf8(bytes) },
    completeness: {
      structurally_complete: true as const,
      required_surfaces_complete: true as const,
      partitions_complete: true as const,
      declared_record_count: 1 as const,
      parsed_record_count: 1 as const,
    },
  } satisfies TcgdexSourceAdmissionEvidenceObservation;
}

function sourceImageUrl(value: unknown) {
  const base = text(value, 2048 - "/high.png".length);
  const url = adapterUrl(base);
  if (
    url.origin !== "https://assets.tcgdex.net" ||
    !url.pathname.startsWith("/en/") ||
    url.pathname.endsWith("/") ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    url.href !== base
  )
    throw new AdapterParseFailure("TCGdex source image is outside its exact English asset surface.");
  return `${base}/high.png`;
}

function validateClaims(card: Record<string, unknown>) {
  for (const field of ["illustrator", "rarity", "stage", "evolveFrom", "regulationMark", "trainerType", "energyType"])
    if (card[field] !== undefined) text(card[field]);
  for (const field of ["effect", "description"]) if (card[field] !== undefined) text(card[field], 16 * 1024);
  if (card.category === "Trainer") text(card.effect, 16 * 1024);
  for (const field of ["hp", "retreat"]) if (card[field] !== undefined) integer(card[field]);
  if (card.category === "Pokemon") {
    integer(card.hp);
    list(card.types).forEach((value) => text(value));
  }
  for (const field of ["types", "dexId", "cameoDexIds"])
    if (card[field] !== undefined)
      list(card[field]).forEach((value) => (field === "types" ? text(value) : integer(value)));
  for (const value of optionalList(card.abilities)) {
    const ability = record(value);
    text(ability.name);
    text(ability.effect, 16 * 1024);
    if (ability.type !== undefined) text(ability.type);
  }
  for (const value of optionalList(card.attacks)) {
    const attack = record(value);
    text(attack.name);
    list(attack.cost).forEach((cost) => text(cost));
    if (attack.effect !== undefined) text(attack.effect, 16 * 1024);
    if (attack.damage !== undefined) typeof attack.damage === "number" ? integer(attack.damage) : text(attack.damage);
  }
  for (const field of ["weaknesses", "resistances"])
    for (const value of optionalList(card[field])) {
      const relation = record(value);
      text(relation.type);
      text(relation.value);
    }
  if (card.variants !== undefined)
    for (const value of Object.values(record(card.variants)))
      if (typeof value !== "boolean") throw new AdapterParseFailure("TCGdex variant flag is malformed.");
  const variants = optionalList(card.variants_detailed, 16);
  const ids = new Set<string>();
  for (const value of variants) {
    const variant = record(value);
    const id = text(variant.variantId);
    if (ids.has(id)) throw new AdapterParseFailure("TCGdex repeats a detailed variant in one source record.");
    ids.add(id);
    text(variant.type);
    text(variant.size);
    for (const field of ["subtype", "foil"]) if (variant[field] !== undefined) text(variant[field]);
    const stamps = optionalList(variant.stamp, 16).map((stamp) => text(stamp));
    if (new Set(stamps).size !== stamps.length) throw new AdapterParseFailure("TCGdex repeats a variant stamp claim.");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new AdapterParseFailure("TCGdex source claim requires an object.");
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 256): string {
  if (typeof value !== "string" || !value.length || value.length > maximum)
    throw new AdapterParseFailure("TCGdex source text is missing or exceeds its bound.");
  return value;
}
function list(value: unknown, maximum = 64): unknown[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new AdapterParseFailure("TCGdex source list is malformed or exceeds its bound.");
  return value;
}
function optionalList(value: unknown, maximum = 64) {
  return value === undefined ? [] : list(value, maximum);
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new AdapterParseFailure("TCGdex source integer is malformed.");
  return value;
}
