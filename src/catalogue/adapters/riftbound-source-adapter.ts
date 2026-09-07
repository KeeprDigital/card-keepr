import { decodeHTML } from "entities";
import { officialArtworkFingerprint } from "./official-artwork-identity";
import { AdapterParseFailure } from "./adapter-parse-failure";
import type { SourceAdapterRegistration } from "./source-adapters";

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
  reconciliationAreas: ["catalogue"],
  officialSourceContract: {
    supportedGame: "riftbound",
    partition: "EN-US",
    origin: inventoryOrigin,
    documentPathnamePrefixes: [inventoryPath],
    imagePathnamePrefixes: ["/sanity/images/dsfx7636/game_data_live/"],
    requiredSurfaces: ["catalogue"],
  },
  listingReconciliation: {
    groupsPublisherPages: false,
    strictListingIdentity: false,
    duplicateLocatorCompatibility: "never",
  },
  parseBytes(bytes, context) {
    if (context.mediaType?.startsWith("image/")) return [];
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
  requiredSurfaces: ["catalogue"],
  requestUrlForSurface(surface) {
    if (surface !== "catalogue") throw new AdapterParseFailure("Unknown Riftbound surface.");
    return `${inventoryOrigin}${inventoryPath}?locale=en_US&from=0&limit=200`;
  },
  discoverRequests(bytes, context) {
    if (context.mediaType?.startsWith("image/")) return [];
    const { cards, next } = inventory(bytes, context.url);
    return [
      ...(next === null ? [] : [{ role: "listing" as const, url: next, headers: { accept: "application/json" } }]),
      ...cards.map((value) => ({
        role: "image" as const,
        url: text(record(record(value).cardImage).url),
        headers: {},
      })),
    ];
  },
} satisfies SourceAdapterRegistration;

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
  const imageUrl = new URL(text(image.url));
  if (
    imageUrl.origin !== "https://cmsassets.rgpub.io" ||
    !imageUrl.pathname.startsWith("/sanity/images/dsfx7636/game_data_live/")
  )
    throw new AdapterParseFailure("Riftbound card image is outside the registered publisher image authority.");
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
      official_identity: code === null ? { kind: "unknown", value: null } : { kind: "card_number", value: code },
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
      printed_fields_digest: `riot-gallery-record:${id}`,
      treatment: null,
    },
    appearance_evidence: { images: [{ role: "front", source_url: imageUrl.href, artwork_fingerprint: fingerprint }] },
    memberships: { products: [], distribution_contexts: [], source_buckets: [text(set.id)] },
    product_release_catalogue: { products: [], distribution_contexts: [], relationships: [] },
    source_sidecar: { publisher_record: card, pagination_metadata: metadata, unmapped_optional_fields: [] },
  };
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
