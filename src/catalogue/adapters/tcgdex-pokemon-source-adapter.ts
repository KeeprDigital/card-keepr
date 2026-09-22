import { createHash } from "node:crypto";
import { tcgdexCardContent } from "./tcgdex-card-content";
import { tcgdexReviewEvidence } from "./tcgdex-review-evidence";
import {
  isTcgdexInventoryUrl,
  qualifiedTcgdexCard,
  tcgdexDiscoveryRequests,
  tcgdexEnglishSetsUrl,
} from "./tcgdex-discovery";
import { AdapterParseFailure, adapterUrl, decodeAdapterUtf8, withAdapterParseFailure } from "./adapter-parse-failure";
import type {
  SourceAdapterParseContext,
  SourceAdapterRegistration,
  SourcePrintingIdentityEvidence,
} from "./source-adapter-registration-types";

const origin = "https://api.tcgdex.net";
const lineage = "tcgdex-pokemon-en";
const cardIds = ["svp-051", "base1-4"];
const headers = { accept: "application/json" };
const maximumVariants = 16;

type Treatment = { finish: string; edition: string | null; size: string; stamps: string[] };

// The inspected pilot scans (#328) bind exactly one treatment each. A record
// image depicts no other variant, so these digests never extend to them.
const pilotDepictions: Readonly<
  Record<string, { imageBase: string; contentSha256: string; depicts: (treatment: Treatment) => boolean }>
> = {
  "svp-051": {
    imageBase: "https://assets.tcgdex.net/en/sv/svp/051",
    contentSha256: "e54bf5a3783b43fd7355bc252eb0a99723aa644dab0a01ecd9239598396be153",
    depicts: (treatment) =>
      treatment.finish === "holo" &&
      treatment.size === "standard" &&
      treatment.edition === null &&
      treatment.stamps.length === 0,
  },
  "base1-4": {
    imageBase: "https://assets.tcgdex.net/en/base/base1/4",
    contentSha256: "b05eac72e977adb4c6004640deb48f5cf06907577e6e1a10fd783f272508880b",
    depicts: (treatment) =>
      treatment.finish === "holo" &&
      treatment.size === "standard" &&
      treatment.edition === "shadowless" &&
      treatment.stamps.join(",") === "1st-edition",
  },
};

function cardUrl(id: string) {
  return `${origin}/v2/en/cards/${id}`;
}

function pilotCard(bytes: Uint8Array, sourceUrl: string) {
  const url = adapterUrl(sourceUrl);
  const id = cardIds.find((candidate) => cardUrl(candidate) === url.href);
  if (!id) throw new AdapterParseFailure("TCGdex request is outside the selected English physical Card scope.");
  const card = record(withAdapterParseFailure(() => JSON.parse(decodeAdapterUtf8(bytes))));
  if (card.id !== id || card.category !== "Pokemon" || `${record(card.set).id}-${card.localId}` !== id)
    throw new AdapterParseFailure("TCGdex Card, set, collector number or physical scope changed.");
  return card;
}

/** The variant key names one detailed issued treatment. */
function treatmentKey(treatment: Readonly<Record<string, unknown>>) {
  return JSON.stringify({
    finish: treatment.finish,
    edition: treatment.edition,
    size: treatment.size,
    stamps: treatment.stamps,
  });
}

function englishImage(imageBase: string) {
  const image = `${imageBase}/high.png`;
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
  return image;
}

/**
 * One qualified Card and a Printing per detailed issued treatment. Only an
 * inspected pilot scan, or the record image of a record listing exactly one
 * treatment, is associated with a Printing; every other variant keeps an
 * explicit image gap because the shared record image does not depict it.
 */
function observations(card: Record<string, unknown>) {
  const id = text(card.id);
  const pilot = pilotDepictions[id];
  const variants = list(card.variants_detailed);
  if (variants.length === 0 || variants.length > maximumVariants)
    throw new AdapterParseFailure("TCGdex detailed treatment inventory is missing or exceeds the bounded pilot.");
  const imageBase = card.image === undefined ? null : text(card.image);
  if (pilot !== undefined && imageBase !== null && imageBase !== pilot.imageBase)
    throw new AdapterParseFailure("TCGdex image no longer matches the exact selected Card surface.");
  const image = imageBase === null ? null : englishImage(imageBase);
  const content = tcgdexCardContent(card);
  const attributes = content.attributes;
  const seen = new Set<string>();
  return variants.map((entry) => {
    const variant = record(entry);
    // A detailed foil-pattern label (e.g. galaxy, cosmos) is an unqualified
    // source claim the Game Profile does not represent; the record stays
    // unresolved rather than merging patterned and plain treatments.
    if (variant.foil !== undefined)
      throw new AdapterParseFailure("TCGdex foil-pattern treatment requires profile qualification.");
    const treatment: Treatment = {
      finish: text(variant.type),
      edition: optionalText(variant.subtype),
      size: text(variant.size),
      stamps: optionalList(variant.stamp).map(text).sort(),
    };
    // A source variant ID and marketplace listing are attributable mappings.
    // Neither controls the persistent catalogue allocation or treatment equality.
    const key = treatmentKey(treatment);
    if (seen.has(key)) throw new AdapterParseFailure("TCGdex repeats a detailed issued treatment.");
    seen.add(key);
    const depicted = pilot !== undefined ? pilot.depicts(treatment) : variants.length === 1;
    const preciseImage = depicted ? image : null;
    const fingerprint = `${lineage}:${id}:${key}`;
    const printingAttributes = {
      set_code: text(record(card.set).id),
      collector_number: text(card.localId),
      finish: treatment.finish,
      edition: treatment.edition,
      size: treatment.size,
      stamps: treatment.stamps,
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
        effective_rules_text: content.effectiveRulesText,
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
        demonstrably_novel: preciseImage !== null,
        ...(preciseImage === null
          ? {}
          : {
              novelty_basis: {
                kind: "source_printing_image",
                source_url: preciseImage,
                artwork_fingerprint: fingerprint,
              },
            }),
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
                  ...(pilot === undefined ? {} : { content_sha256: pilot.contentSha256 }),
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
            : pilot === undefined
              ? "The record lists only this treatment; its record image is associated with it and depicts no other variant."
              : "The retained catalogue image depicts this treatment; it does not depict other variants.",
        unmapped_optional_fields: unknownFields(card),
      },
    };
  });
}

/**
 * A declared-catalogue Card qualifies when its retained Set is an issued
 * physical candidate and the record maps completely onto the Game Profile with
 * a bounded, distinct detailed treatment inventory. Anything else stays one
 * unresolved source record for owner review; malformed required claims remain
 * terminal source-contract failures there.
 */
function declaredCatalogueObservations(bytes: Uint8Array, context: SourceAdapterParseContext) {
  // Bounded claim validation applies to every record before qualification.
  const review = tcgdexReviewEvidence(bytes, context);
  const { card, set } = qualifiedTcgdexCard(bytes, context);
  if (set.eligibility === "issued_set_candidate" && ["Pokemon", "Trainer", "Energy"].includes(String(card.category)))
    try {
      return observations(record(card));
    } catch (error) {
      if (!(error instanceof AdapterParseFailure)) throw error;
    }
  return [review];
}

function surfaceUrl(surface: string) {
  if (!cardIds.includes(surface))
    throw new AdapterParseFailure("Unknown TCGdex pilot surface.", { category: "configuration" });
  return cardUrl(surface);
}

function declaredCatalogueSurface(surface: string) {
  if (surface !== "english-set-inventory")
    throw new AdapterParseFailure("Unknown TCGdex inventory surface.", { category: "configuration" });
  return tcgdexEnglishSetsUrl;
}

function isPilotRequest(context: SourceAdapterParseContext) {
  return !context.parents?.length && cardIds.some((id) => cardUrl(id) === context.url);
}

function cardObservations(bytes: Uint8Array, context: SourceAdapterParseContext) {
  return isPilotRequest(context)
    ? observations(pilotCard(bytes, context.url))
    : declaredCatalogueObservations(bytes, context);
}

export const tcgdexPokemonSourceAdapterRegistration = {
  adapterVersion: "tcgdex-pokemon-en@1",
  sourceLineage: lineage,
  supportedGame: "pokemon",
  gameProfileVersion: "pokemon@1",
  parserContract: "tcgdex-pokemon-rest-card@1",
  maximumSnapshotBytes: 1024 * 1024,
  // Dated census envelope of the retained 2026-09-15 English inventory (#329):
  // two roots, 203 non-Pocket Sets and 21,068 enumerated Card records, each
  // with at most one record image (2 + 203 + 2 x 21,068 = 42,341), plus about
  // six percent for Sets and records issued before the live run. It is not
  // measured throughput; a larger discovered graph pauses for an extension.
  requestCapacity: 45_000,
  hostPacing: [
    {
      hostname: "api.tcgdex.net",
      kind: "page",
      floorMs: 1_000,
      ceilingMs: 16_000,
      maximumConcurrency: 1,
      evidence:
        "acceptance/fixtures/real-sources/2026-09-15-pokemon-scope/README.md: the retained TCGdex FAQ (2026-09-14) publishes no hard rate limit and asks for considerate use with local caching; no robots.txt is retained. One sequential request per second at the floor keeps the ~21,273-request facts graph near six hours.",
    },
    {
      hostname: "assets.tcgdex.net",
      kind: "asset",
      floorMs: 500,
      ceilingMs: 8_000,
      maximumConcurrency: 2,
      evidence:
        "acceptance/fixtures/real-sources/2026-09-15-pokemon-scope/README.md: static asset host covered by the same retained FAQ (no hard limit, considerate use); no robots.txt is retained, so concurrency stays at 2.",
    },
  ],
  retainedParentContext: { maximumDepth: 3, maximumTotalBytes: 3 * 1024 * 1024 },
  singleDiscoveryParentRoles: ["detail"],
  origin: "production",
  requestSurface: { kind: "credential-free-https" },
  reconciliationCapability: "catalogue",
  printingAdmission: "source_qualification",
  qualifiesCardDesignIdentity: qualifiesDesign,
  qualifiesPrintingIdentity(evidence) {
    const printing = evidence.observedCardAndPrinting.printing;
    const attributes = printing?.game_data?.attributes;
    return (
      qualifiesDesign(evidence) &&
      printing?.game_data?.profile === "pokemon@1" &&
      typeof attributes?.set_code === "string" &&
      typeof attributes.collector_number === "string" &&
      `${attributes.set_code}-${attributes.collector_number}` === evidence.cardDesignKey &&
      evidence.variantKey === treatmentKey(attributes) &&
      evidence.artworkFingerprint === `${lineage}:${evidence.cardDesignKey}:${evidence.variantKey}`
    );
  },
  reconciliationAreas: ["catalogue"],
  requiredSurfaces: cardIds,
  requestUrlForSurface: surfaceUrl,
  coverageContracts: {
    "english-declared-catalogue": {
      description:
        "English TCGdex Set inventory excluding declared Pocket membership, exact candidate Set/Card details, their associated record images and explicit unresolved issuance/treatment evidence. Complete capture and admission require all discovered work and owner decisions.",
      requiredSurfaces: ["english-set-inventory"],
      requestUrlForSurface: declaredCatalogueSurface,
    },
    "english-declared-catalogue-facts": {
      description:
        "The same English declared catalogue graph and Card facts without image requests: every Printing publishes with an explicit image gap until a later image acquisition.",
      acquiredDiscoveryRoles: ["listing", "detail"],
      requiredSurfaces: ["english-set-inventory"],
      requestUrlForSurface: declaredCatalogueSurface,
    },
    "snorlax-charizard-pilot": {
      description:
        "Exactly English physical svp-051 and base1-4 with their complete detailed treatment arrays. Excludes Pocket (tcgp), other Cards and full launch coverage.",
      requiredSurfaces: cardIds,
      requestUrlForSurface: surfaceUrl,
    },
  },
  parseBytes(bytes, context) {
    if (context.mediaType?.startsWith("image/")) return [];
    if (isTcgdexInventoryUrl(context.url)) {
      tcgdexDiscoveryRequests(bytes, context);
      return [];
    }
    return cardObservations(bytes, context);
  },
  discoverRequests(bytes, context) {
    if (context.mediaType?.startsWith("image/")) return [];
    if (isTcgdexInventoryUrl(context.url)) return tcgdexDiscoveryRequests(bytes, context);
    // Request only images an observation associates with a Printing or an
    // unresolved source record; an unassociated shared scan proves nothing.
    const images = new Set<string>();
    for (const observation of cardObservations(bytes, context))
      for (const image of (observation.appearance_evidence as { images: readonly { source_url: string }[] }).images)
        images.add(image.source_url);
    return [...images].map((url) => ({ role: "image" as const, url, headers: { ...headers, accept: "image/png" } }));
  },
} satisfies SourceAdapterRegistration;

/** A TCGdex record ID is the Card design key: cross-reprint equivalence is not
 * established by this source, so each record keeps its own Card. */
function qualifiesDesign(evidence: SourcePrintingIdentityEvidence) {
  return (
    evidence.observedCardAndPrinting.card?.game === "pokemon" &&
    evidence.observedCardAndPrinting.card.official_identity.kind === "unknown" &&
    typeof evidence.cardDesignKey === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9.-]*-[^\s:]+$/u.test(evidence.cardDesignKey) &&
    typeof evidence.variantKey === "string" &&
    evidence.locator === `${evidence.cardDesignKey}:${evidence.variantKey}`
  );
}

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
    "effect",
    "trainerType",
    "energyType",
  ]);
  const fields = (value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string) =>
    Object.entries(value)
      .filter(([field]) => !allowed.has(field))
      .map(([field, raw]) => ({ path: `${path}.${field}`, value: JSON.stringify(raw) }));
  const warnings = fields(card, known, "tcgdex_card");
  const mappedArrays = {
    variants_detailed: ["type", "subtype", "size", "stamp", "foil", "thirdParty", "variantId", "pricing"],
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
