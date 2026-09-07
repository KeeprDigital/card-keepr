import { decodeHTML } from "entities";
import { createHash } from "node:crypto";
import { officialArtworkFingerprint } from "./official-artwork-identity";
import { AdapterParseFailure } from "./adapter-parse-failure";
import type { SourceAdapterRegistration } from "./source-adapter-registration-types";
import { riftboundOriginsErrata, riftboundOriginsErrataUrl } from "./riftbound-errata";
import { riftboundAnnouncedProducts, riftboundProductsUrl } from "./riftbound-products";

const inventoryOrigin = "https://content.publishing.riotgames.com";
const inventoryPath = "/publishing-content/v2.0/public/channel/riftbound_website/list/riftbound_gallery_cards";

export const riftboundSourceAdapterRegistration = {
  adapterVersion: "riftbound-en@1",
  sourceLineage: "riftbound-en",
  supportedGame: "riftbound",
  gameProfileVersion: "riftbound@1",
  parserContract: "riot-riftbound-gallery@1",
  maximumSnapshotBytes: 2 * 1024 * 1024,
  requestCapacity: 5000,
  origin: "production",
  requestSurface: { kind: "credential-free-https" },
  reconciliationCapability: "catalogue",
  reconciliationAreas: ["catalogue", "errata"],
  officialSourceContract: {
    supportedGame: "riftbound",
    partition: "EN-US",
    origin: inventoryOrigin,
    documentPathnamePrefixes: [inventoryPath],
    documentAuthorities: [
      { origin: inventoryOrigin, pathnamePrefixes: [inventoryPath] },
      {
        origin: "https://playriftbound.com",
        pathnamePrefixes: [new URL(riftboundOriginsErrataUrl).pathname, new URL(riftboundProductsUrl).pathname],
      },
    ],
    imagePathnamePrefixes: ["/sanity/images/dsfx7636/game_data_live/"],
    requiredSurfaces: ["catalogue", "errata", "products"],
  },
  listingReconciliation: {
    groupsPublisherPages: false,
    strictListingIdentity: false,
    duplicateLocatorCompatibility: "never",
  },
  parseBytes(bytes, context) {
    if (context.mediaType?.startsWith("image/")) return [];
    if (context.url === riftboundOriginsErrataUrl) return riftboundOriginsErrata(bytes, context.url);
    if (context.url === riftboundProductsUrl) return riftboundAnnouncedProducts(bytes, context.url);
    const { cards, metadata } = inventory(bytes, context.url);
    const ids = new Set<string>();
    return cards.map((value) => {
      const card = record(value);
      const id = text(card.id);
      if (ids.has(id)) throw new AdapterParseFailure("Riftbound page repeats a source record identifier.");
      ids.add(id);
      return observation(card, cards.length, metadata);
    });
  },
  requiredSurfaces: ["catalogue", "errata", "products"],
  coverageContracts: {
    "public-english-inventory": {
      description:
        "All records returned by the linked public English gallery pages; upstream total discrepancy remains explicit.",
      requiredSurfaces: ["catalogue"],
      requestUrlForSurface: inventorySurfaceUrl,
    },
    "origins-errata": {
      description: "All 31 named corrections in the registered Origins Errata article.",
      requiredSurfaces: ["errata"],
      requestUrlForSurface(surface) {
        if (surface !== "errata") throw new AdapterParseFailure("Unknown Riftbound Errata surface.");
        return riftboundOriginsErrataUrl;
      },
    },
    "announced-products-2027": {
      description:
        "The nine principal Product announcements in Products and Sets into 2027, including the named Proving Grounds subsection; dates retain published precision and regions remain unknown.",
      requiredSurfaces: ["products"],
      requestUrlForSurface(surface) {
        if (surface !== "products") throw new AdapterParseFailure("Unknown Riftbound Product surface.");
        return riftboundProductsUrl;
      },
    },
  },
  requestUrlForSurface(surface) {
    if (surface === "products") return riftboundProductsUrl;
    return surface === "errata" ? riftboundOriginsErrataUrl : inventorySurfaceUrl(surface);
  },
  discoverRequests(bytes, context) {
    if (context.mediaType?.startsWith("image/")) return [];
    if (context.url === riftboundOriginsErrataUrl) {
      riftboundOriginsErrata(bytes, context.url);
      return [];
    }
    if (context.url === riftboundProductsUrl) {
      riftboundAnnouncedProducts(bytes, context.url);
      return [];
    }
    const { cards, next } = inventory(bytes, context.url);
    return [
      ...(next === null ? [] : [{ role: "listing" as const, url: next, headers: { accept: "application/json" } }]),
      ...cards.map((value) => ({
        role: "image" as const,
        url: publisherImageUrl(record(record(value).cardImage).url).href,
        headers: {},
      })),
    ];
  },
} satisfies SourceAdapterRegistration;

function inventorySurfaceUrl(surface: string) {
  if (surface !== "catalogue") throw new AdapterParseFailure("Unknown Riftbound inventory surface.");
  return `${inventoryOrigin}${inventoryPath}?locale=en_US&from=0&limit=200`;
}

function inventory(bytes: Uint8Array, sourceUrl: string) {
  const url = new URL(sourceUrl);
  if (
    url.origin !== inventoryOrigin ||
    url.pathname !== inventoryPath ||
    url.searchParams.get("locale") !== "en_US" ||
    url.searchParams.get("limit") !== "200" ||
    [...url.searchParams.keys()].sort().join(",") !== "from,limit,locale"
  )
    throw new AdapterParseFailure("Riftbound inventory must use the registered English publisher surface.");
  const from = Number(url.searchParams.get("from"));
  const document = record(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)));
  const metadata = record(document.metadata);
  const total = number(metadata.totalItems);
  const pages = number(metadata.totalPages);
  if (
    metadata.locale !== "en-us" ||
    metadata.smartListMachineName !== "riftbound_gallery_cards" ||
    metadata.channelMachineName !== "riftbound_website" ||
    metadata.limit !== 200 ||
    metadata.from !== from ||
    !Number.isSafeInteger(from) ||
    from < 0 ||
    from % 200 !== 0 ||
    from >= total ||
    pages !== Math.ceil(total / 200) ||
    pages > 100
  )
    throw new AdapterParseFailure("Riftbound inventory locale or pagination contract changed.");
  const cards = array(document.data);
  if (cards.length === 0 || cards.length > Math.min(200, total - from))
    throw new AdapterParseFailure("Riftbound page does not fit its declared pagination window.");
  const links = record(document.linkdata);
  const pageUrl = (offset: number) => `${inventoryOrigin}${inventoryPath}?locale=en_US&from=${offset}&limit=200`;
  const next = from + 200 < total ? pageUrl(from + 200) : null;
  for (const [key, expected] of Object.entries({
    self: pageUrl(from),
    first: pageUrl(0),
    last: pageUrl((pages - 1) * 200),
    next,
  })) {
    if (expected === null ? links[key] != null : new URL(text(links[key]), inventoryOrigin).href !== expected)
      throw new AdapterParseFailure("Riftbound pagination does not close over exact publisher links.");
  }
  return { cards, metadata, next };
}

function observation(card: Record<string, unknown>, count: number, metadata: Record<string, unknown>) {
  const id = text(card.id);
  const code = card.publicCode == null ? null : text(card.publicCode);
  const set = record(record(card.set).value);
  const types = record(card.cardType);
  const image = record(card.cardImage);
  const imageUrl = publisherImageUrl(image.url);
  const ability = richText(card.text);
  const effect = richText(card.effect);
  const attributes = {
    card_types: identifiers(types.type),
    supertypes: identifiers(types.superType ?? []),
    domains: identifiers(record(card.domain).values),
    energy: numericField(card.energy),
    power: numericField(card.power),
    might: numericField(card.might),
    might_bonus: numericField(card.mightBonus),
    tags: card.tags === undefined ? [] : array(record(card.tags).tags).map(text),
    ability_text: ability,
    effect_text: effect,
  };
  // Gallery text describes the current rules. It does not prove the wording
  // on the depicted Printing: the retained Kinkou Monk image is a counterexample.
  const printingAttributes = {
    public_code: code,
    collector_number: card.collectorNumber == null ? null : number(card.collectorNumber),
    set_code: text(set.id),
    orientation: card.orientation == null ? null : text(card.orientation),
    reverse_face: null,
    finish: null,
    artists: array(record(card.illustrator).values).map((v) => text(record(v).label)),
  };
  const fingerprint = officialArtworkFingerprint(code ?? id, ["front"], null);
  return {
    completeness: {
      structurally_complete: true,
      required_surfaces_complete: true,
      partitions_complete: true,
      declared_record_count: count,
      parsed_record_count: count,
    },
    card: {
      game: "riftbound",
      // Riot Core Rules 2026-07-16 §132 defines Card identity by full name.
      // Public codes distinguish source Printing records, including alternate art.
      official_identity: { kind: "publisher_name", value: text(card.name) },
      name: text(card.name),
      effective_rules_text: [ability, effect].filter((s) => s !== null).join("\n") || null,
      game_data: { profile: "riftbound@1", attributes },
    },
    printing: {
      rarity: {
        raw: text(record(record(card.rarity).value).label),
        normalized: text(record(record(card.rarity).value).id),
      },
      printed_rules_text: null,
      game_data: { profile: "riftbound@1", attributes: printingAttributes },
    },
    identity_evidence: {
      locator: id,
      variant_key: id,
      artwork_fingerprint: fingerprint,
      printed_fields_digest: createHash("sha256")
        .update(JSON.stringify({ printed_rules_text: null, ...printingAttributes }))
        .digest("hex"),
      treatment: null,
    },
    appearance_evidence: { images: [{ role: "front", source_url: imageUrl.href, artwork_fingerprint: fingerprint }] },
    memberships: { products: [], distribution_contexts: [], source_buckets: [text(set.id)] },
    product_release_catalogue: { products: [], distribution_contexts: [], relationships: [] },
    source_sidecar: {
      publisher_record_json: JSON.stringify(card),
      pagination_metadata: metadata,
      unmapped_optional_fields: unmappedFields(card),
    },
  };
}
function publisherImageUrl(value: unknown) {
  const url = new URL(text(value));
  if (
    url.origin !== "https://cmsassets.rgpub.io" ||
    !url.pathname.startsWith("/sanity/images/dsfx7636/game_data_live/") ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new AdapterParseFailure("Riftbound card image is outside the registered publisher image authority.");
  return url;
}
const mappedFields = new Set([
  "id",
  "collectorNumber",
  "name",
  "set",
  "cardType",
  "publicCode",
  "rarity",
  "domain",
  "cardImage",
  "orientation",
  "illustrator",
  "text",
  "energy",
  "tags",
  "might",
  "power",
  "mightBonus",
  "effect",
  "label",
  "value",
  "values",
  "type",
  "superType",
  "icon",
  "provider",
  "url",
  "dimensions",
  "width",
  "height",
  "aspectRatio",
  "colors",
  "primary",
  "secondary",
  "mimeType",
  "accessibilityText",
  "richText",
  "body",
]);
function unmappedFields(value: Record<string, unknown>) {
  const fields: { path: string; value: string }[] = [];
  const visit = (current: unknown, path: string, depth: number) => {
    if (depth > 20) throw new AdapterParseFailure("Riftbound source metadata nesting is excessive.");
    if (Array.isArray(current)) current.forEach((entry, i) => visit(entry, `${path}[${i}]`, depth + 1));
    else if (current && typeof current === "object")
      for (const [key, entry] of Object.entries(current)) {
        const next = `${path}.${key}`;
        if (!mappedFields.has(key)) fields.push({ path: next, value: JSON.stringify(entry) });
        else visit(entry, next, depth + 1);
      }
  };
  visit(value, "publisher_record", 0);
  return fields;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AdapterParseFailure("Riftbound required object is missing.");
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new AdapterParseFailure("Riftbound required list is missing.");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new AdapterParseFailure("Riftbound required text is missing.");
  return value;
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new AdapterParseFailure("Riftbound numeric field is invalid.");
  return value;
}
function numericField(value: unknown): number | null {
  return value === undefined ? null : number(record(record(value).value).id);
}
function identifiers(value: unknown): string[] {
  return array(value).map((item) => text(record(item).id));
}
function richText(value: unknown): string | null {
  if (value === undefined) return null;
  const rich = record(record(value).richText);
  if (rich.type !== "html") throw new AdapterParseFailure("Riftbound rules text encoding changed.");
  return decodeHTML(
    text(rich.body)
      .replace(/<br\s*\/?\s*>|<\/p>/giu, "\n")
      .replace(/<[^>]*>/gu, ""),
  ).trim();
}
