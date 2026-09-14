import { createHash } from "node:crypto";
import { AdapterParseFailure, adapterUrl, decodeAdapterUtf8, withAdapterParseFailure } from "./adapter-parse-failure";
import type { SourceAdapterRegistration } from "./source-adapter-registration-types";

const origin = "https://api.tcgdex.net";
const lineage = "tcgdex-pokemon-en";
const cardIds = ["svp-051", "base1-4"];
const imageBases: Readonly<Record<string, string>> = {
  "svp-051": "https://assets.tcgdex.net/en/sv/svp/051",
  "base1-4": "https://assets.tcgdex.net/en/base/base1/4",
};
const headers = { accept: "application/json" };

function cardUrl(id: string) {
  return `${origin}/v2/en/cards/${id}`;
}

function sourceCard(bytes: Uint8Array, sourceUrl: string) {
  const url = adapterUrl(sourceUrl);
  const id = cardIds.find((candidate) => cardUrl(candidate) === url.href);
  if (!id) throw new AdapterParseFailure("TCGdex request is outside the selected English physical Card scope.");
  const card = record(withAdapterParseFailure(() => JSON.parse(decodeAdapterUtf8(bytes))));
  if (card.id !== id || card.category !== "Pokemon" || `${record(card.set).id}-${card.localId}` !== id)
    throw new AdapterParseFailure("TCGdex Card, set, collector number or physical scope changed.");
  return card;
}

function observations(bytes: Uint8Array, sourceUrl: string) {
  const card = sourceCard(bytes, sourceUrl);
  const id = text(card.id);
  const variants = list(card.variants_detailed);
  if (variants.length === 0 || variants.length > 16)
    throw new AdapterParseFailure("TCGdex detailed treatment inventory is missing or exceeds the bounded pilot.");
  const imageBase = card.image === undefined ? null : text(card.image);
  if (imageBase !== null && imageBase !== imageBases[id])
    throw new AdapterParseFailure("TCGdex image no longer matches the exact selected Card surface.");
  const image = imageBase === null ? null : `${imageBase}/high.png`;
  if (image !== null) {
    const parsed = adapterUrl(image);
    if (
      parsed.origin !== "https://assets.tcgdex.net" ||
      !parsed.pathname.startsWith("/en/") ||
      parsed.search ||
      parsed.hash ||
      parsed.username ||
      parsed.password
    )
      throw new AdapterParseFailure("TCGdex image is outside its English asset surface.");
  }
  const attributes = {
    card_type: "pokemon",
    hp: integer(card.hp),
    types: list(card.types).map(text),
    stage: optionalText(card.stage),
    evolves_from: optionalText(card.evolveFrom),
    abilities: optionalList(card.abilities).map((entry) => {
      const ability = record(entry);
      return { kind: optionalText(ability.type), name: text(ability.name), text: text(ability.effect) };
    }),
    attacks: optionalList(card.attacks).map((entry) => {
      const attack = record(entry);
      return {
        name: text(attack.name),
        cost: list(attack.cost).map(text),
        damage:
          attack.damage === undefined
            ? null
            : typeof attack.damage === "number"
              ? String(integer(attack.damage))
              : text(attack.damage),
        text: optionalText(attack.effect),
      };
    }),
    weaknesses: relations(card.weaknesses),
    resistances: relations(card.resistances),
    retreat_cost: card.retreat === undefined ? null : integer(card.retreat),
    regulation_mark: optionalText(card.regulationMark),
  };
  const seen = new Set<string>();
  return variants.map((entry) => {
    const variant = record(entry);
    const treatment = {
      finish: text(variant.type),
      edition: optionalText(variant.subtype),
      size: text(variant.size),
      stamps: optionalList(variant.stamp).map(text).sort(),
    };
    // A source variant ID and marketplace listing are attributable mappings.
    // Neither controls the persistent catalogue allocation or treatment equality.
    const key = JSON.stringify(treatment);
    if (seen.has(key)) throw new AdapterParseFailure("TCGdex repeats a detailed issued treatment.");
    seen.add(key);
    const depicted =
      treatment.finish === "holo" &&
      treatment.size === "standard" &&
      ((id === "svp-051" && treatment.edition === null && treatment.stamps.length === 0) ||
        (id === "base1-4" && treatment.edition === "shadowless" && treatment.stamps.join(",") === "1st-edition"));
    const preciseImage = depicted ? image : null;
    const fingerprint = `${lineage}:${id}:${key}`;
    const printingAttributes = {
      set_code: text(record(card.set).id),
      collector_number: text(card.localId),
      ...treatment,
      artists: card.illustrator === undefined ? [] : [text(card.illustrator)],
      reverse_face: null,
    };
    return {
      completeness: {
        structurally_complete: true,
        required_surfaces_complete: true,
        partitions_complete: true,
        declared_record_count: variants.length,
        parsed_record_count: variants.length,
      },
      card: {
        game: "pokemon",
        category: "gameplay",
        official_identity: { kind: "unknown", value: null },
        name: text(card.name),
        effective_rules_text:
          [
            ...attributes.abilities.map((ability) => `${ability.name}: ${ability.text}`),
            ...attributes.attacks.map((attack) => `${attack.name}${attack.text === null ? "" : `: ${attack.text}`}`),
          ].join("\n") || null,
        game_data: { profile: "pokemon@1", attributes },
      },
      card_identity_evidence: { source_design_key: id },
      printing: {
        rarity: { raw: optionalText(card.rarity), normalized: null },
        printed_rules_text: null,
        game_data: { profile: "pokemon@1", attributes: printingAttributes },
      },
      identity_evidence: {
        locator: `${id}:${key}`,
        variant_key: key,
        artwork_fingerprint: fingerprint,
        printed_fields_digest: createHash("sha256").update(JSON.stringify(printingAttributes)).digest("hex"),
        treatment: key,
      },
      appearance_evidence: {
        images:
          preciseImage === null
            ? []
            : [
                {
                  role: "front",
                  source_url: preciseImage,
                  artwork_fingerprint: fingerprint,
                  content_sha256:
                    id === "svp-051"
                      ? "e54bf5a3783b43fd7355bc252eb0a99723aa644dab0a01ecd9239598396be153"
                      : "b05eac72e977adb4c6004640deb48f5cf06907577e6e1a10fd783f272508880b",
                },
              ],
      },
      memberships: { products: [], distribution_contexts: [], source_buckets: [text(record(card.set).id)] },
      product_release_catalogue: { products: [], distribution_contexts: [], relationships: [] },
      source_sidecar: {
        source_record_json: JSON.stringify(card),
        variant_id: text(variant.variantId),
        shared_catalogue_image: image,
        image_limitation:
          preciseImage === null
            ? "No retained image is qualified for this exact treatment."
            : "The retained catalogue image depicts this treatment; it does not depict other variants.",
        unmapped_optional_fields: unknownFields(card),
      },
    };
  });
}

function surfaceUrl(surface: string) {
  if (!cardIds.includes(surface))
    throw new AdapterParseFailure("Unknown TCGdex pilot surface.", { category: "configuration" });
  return cardUrl(surface);
}

export const tcgdexPokemonSourceAdapterRegistration = {
  adapterVersion: "tcgdex-pokemon-en@1",
  sourceLineage: lineage,
  supportedGame: "pokemon",
  gameProfileVersion: "pokemon@1",
  parserContract: "tcgdex-pokemon-rest-card@1",
  maximumSnapshotBytes: 1024 * 1024,
  requestCapacity: 4,
  origin: "production",
  requestSurface: { kind: "credential-free-https" },
  reconciliationCapability: "catalogue",
  printingAdmission: "owner_review",
  reconciliationAreas: ["catalogue"],
  requiredSurfaces: cardIds,
  requestUrlForSurface: surfaceUrl,
  coverageContracts: {
    "snorlax-charizard-pilot": {
      description:
        "Exactly English physical svp-051 and base1-4 with their complete detailed treatment arrays. Excludes Pocket (tcgp), other Cards and full launch coverage.",
      requiredSurfaces: cardIds,
      requestUrlForSurface: surfaceUrl,
    },
  },
  parseBytes(bytes, context) {
    if (context.mediaType?.startsWith("image/")) return [];
    return observations(bytes, context.url);
  },
  discoverRequests(bytes, context) {
    if (context.mediaType?.startsWith("image/")) return [];
    const card = sourceCard(bytes, context.url);
    observations(bytes, context.url);
    return card.image === undefined
      ? []
      : [{ role: "image" as const, url: `${text(card.image)}/high.png`, headers: { ...headers, accept: "image/png" } }];
  },
} satisfies SourceAdapterRegistration;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new AdapterParseFailure("TCGdex required object is missing.");
  return value as Record<string, unknown>;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new AdapterParseFailure("TCGdex required array is missing.");
  return value;
}
function optionalList(value: unknown) {
  return value === undefined ? [] : list(value);
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0)
    throw new AdapterParseFailure("TCGdex required text is missing.");
  return value;
}
function optionalText(value: unknown) {
  return value === undefined ? null : text(value);
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new AdapterParseFailure("TCGdex required integer is invalid.");
  return value;
}
function relations(value: unknown) {
  return optionalList(value).map((entry) => {
    const relation = record(entry);
    return { type: text(relation.type), value: text(relation.value) };
  });
}

function unknownFields(card: Record<string, unknown>) {
  const known = new Set([
    "category",
    "id",
    "illustrator",
    "image",
    "localId",
    "name",
    "rarity",
    "set",
    "variants",
    "variants_detailed",
    "dexId",
    "cameoDexIds",
    "hp",
    "types",
    "evolveFrom",
    "description",
    "stage",
    "abilities",
    "attacks",
    "weaknesses",
    "resistances",
    "retreat",
    "regulationMark",
    "legal",
    "updated",
    "pricing",
  ]);
  const fields = (value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string) =>
    Object.entries(value)
      .filter(([field]) => !allowed.has(field))
      .map(([field, raw]) => ({ path: `${path}.${field}`, value: JSON.stringify(raw) }));
  const warnings = fields(card, known, "tcgdex_card");
  const mappedArrays = {
    variants_detailed: ["type", "subtype", "size", "stamp", "thirdParty", "variantId", "pricing"],
    abilities: ["type", "name", "effect"],
    attacks: ["cost", "name", "effect", "damage"],
    weaknesses: ["type", "value"],
    resistances: ["type", "value"],
  };
  for (const [key, allowed] of Object.entries(mappedArrays))
    optionalList(card[key]).forEach((entry, index) => {
      warnings.push(...fields(record(entry), new Set(allowed), `tcgdex_card.${key}[${index}]`));
    });
  warnings.push(...fields(record(card.set), new Set(["id", "name", "cardCount", "logo", "symbol"]), "tcgdex_card.set"));
  return warnings;
}
