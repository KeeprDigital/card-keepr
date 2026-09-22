import { adapterObjectMembers } from "./adapter-object-members";
import { decodeHTML } from "entities";
import { createHash } from "node:crypto";
import { officialArtworkFingerprint, parsedOfficialArtworkIdentity } from "./official-artwork-identity";
import { AdapterParseFailure, adapterUrl, decodeAdapterUtf8, withAdapterParseFailure } from "./adapter-parse-failure";
import type { SourceAdapterRegistration, SourcePrintingIdentityEvidence } from "./source-adapter-registration-types";
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
  // One bound covers pages and publisher PNG fronts. The retained 744x1039
  // fronts are 0.73-1.42 MB, and 26 records of the retained inventory (OGN
  // overnumbered and signature Printings) declare 1488x2078 fronts, four times
  // the pixels. A 2 MiB bound would record those real fronts as body-contract
  // image gaps (#333); 8 MiB leaves headroom without admitting unbounded bodies.
  maximumSnapshotBytes: 8 * 1024 * 1024,
  // 6 gallery pages, one front per returned record (1,189 retained) and the
  // errata and products articles fit the historical bound with headroom.
  requestCapacity: 5000,
  // #389 adaptive pacing bounds. No robots or terms are retained for these
  // hosts; the bounds are conservative and back off on any refusal.
  hostPacing: [
    {
      hostname: "content.publishing.riotgames.com",
      kind: "page",
      floorMs: 1_000,
      ceilingMs: 8_000,
      maximumConcurrency: 1,
      evidence:
        "Riot publishing API behind Cloudflare bot management (retained 2026-09-08 page headers: __cf_bm cookie, CF-Cache-Status BYPASS, no-cache). No robots or terms retained. The six gallery pages were captured sequentially with HTTP 200 (2026-09-08-riftbound manifest). Sequential at 1 s or slower.",
    },
    {
      hostname: "playriftbound.com",
      kind: "page",
      floorMs: 1_000,
      ceilingMs: 8_000,
      maximumConcurrency: 1,
      evidence:
        "Riot's Next.js site on Netlify serving the errata and products articles (retained 2026-09-06 headers). No robots or terms retained. Two article requests per run; sequential at 1 s or slower.",
    },
    {
      hostname: "cmsassets.rgpub.io",
      kind: "asset",
      floorMs: 100,
      ceilingMs: 2_000,
      maximumConcurrency: 4,
      evidence:
        "Riot's Sanity image CDN behind Akamai: retained 2026-09-06 and 2026-09-14 front responses carry Cache-Control public/s-maxage=2592000 and sanity-inflight-limit 200. No robots or terms retained; seven retained fronts returned HTTP 200. Conservative bounds: at most 4 in flight, 100 ms start spacing, backing off on any refusal.",
    },
  ],
  origin: "production",
  requestSurface: { kind: "credential-free-https" },
  reconciliationCapability: "catalogue",
  printingAdmission: "source_qualification",
  qualifiesPrintingIdentity: qualifiesRiotPrintingIdentity,
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
  recordExtraction: {
    matches: ({ mediaType, url }) => !mediaType?.startsWith("image/") && new URL(url).origin === inventoryOrigin,
    extract: extractInventoryRecords,
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
      reconciliationAreas: ["errata"],
      reconciliationCapability: "errata",
      requiredSurfaces: ["errata"],
      requestUrlForSurface(surface) {
        if (surface !== "errata")
          throw new AdapterParseFailure("Unknown Riftbound Errata surface.", { category: "configuration" });
        return riftboundOriginsErrataUrl;
      },
    },
    "announced-products-2027": {
      description:
        "The nine principal Product announcements in Products and Sets into 2027, including the named Proving Grounds subsection; dates retain published precision and regions remain unknown.",
      requiredSurfaces: ["products"],
      requestUrlForSurface(surface) {
        if (surface !== "products")
          throw new AdapterParseFailure("Unknown Riftbound Product surface.", { category: "configuration" });
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

function qualifiesRiotPrintingIdentity(evidence: SourcePrintingIdentityEvidence): boolean {
  const { card, printing } = evidence.observedCardAndPrinting;
  const attributes = printing?.game_data?.attributes;
  const code = attributes?.public_code;
  if (
    card?.game !== "riftbound" ||
    card.official_identity.kind !== "publisher_name" ||
    card.official_identity.value !== card.name ||
    printing?.game_data?.profile !== "riftbound@1" ||
    typeof code !== "string"
  )
    return false;
  // Riot's printed code preserves the variant suffix. The record, set and
  // collector number must agree; a new URL or image encoding proves no identity.
  const identity = /^([A-Z]{3})-(\d{3})(?:[a-z]|\*)?\/\d{3}$/u.exec(code);
  const locator = code.replace("*", "-star").replace("/", "-").toLowerCase();
  const artwork =
    evidence.artworkFingerprint === null ? null : parsedOfficialArtworkIdentity(evidence.artworkFingerprint);
  return (
    identity !== null &&
    attributes?.set_code === identity[1] &&
    attributes?.collector_number === Number(identity[2]) &&
    evidence.locator === locator &&
    evidence.variantKey === locator &&
    artwork?.official_card_identity === code.toUpperCase() &&
    artwork.roles.length === 1 &&
    artwork.roles[0] === "front"
  );
}

function inventorySurfaceUrl(surface: string) {
  if (surface !== "catalogue")
    throw new AdapterParseFailure("Unknown Riftbound inventory surface.", { category: "configuration" });
  return `${inventoryOrigin}${inventoryPath}?locale=en_US&from=0&limit=200`;
}

function inventory(bytes: Uint8Array, sourceUrl: string) {
  const document = record(withAdapterParseFailure(() => JSON.parse(decodeAdapterUtf8(bytes))));
  const cards = array(document.data);
  return { cards, ...inventoryHeader(document, cards.length, sourceUrl) };
}

function inventoryHeader(document: Record<string, unknown>, count: number, sourceUrl: string) {
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
  if (count === 0 || count > Math.min(200, total - from))
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
    if (expected === null ? links[key] != null : adapterUrl(text(links[key]), inventoryOrigin).href !== expected)
      throw new AdapterParseFailure("Riftbound pagination does not close over exact publisher links.");
  }
  return { metadata, next };
}

/** Scan bounded tokens before constructing one publisher record; never collect the page array. */
async function extractInventoryRecords(source: () => AsyncIterable<string>, context: { url: string }) {
  const limits = {
    maximumTokenBytes: 262144,
    maximumTokenCharacters: 262144,
    maximumDepth: 32,
    maximumStructuralTokens: 16384,
  };
  const header: Record<string, unknown> = {};
  let count = 0,
    dataSeen = false;
  for await (const { member } of adapterObjectMembers(source, limits)) {
    if (member.key === "data") {
      if (member.kind === "array") dataSeen = true;
      else if (member.array) {
        if (++count > 200) throw new AdapterParseFailure("Riftbound page exceeds 200 records.");
      } else throw new AdapterParseFailure("Riftbound page data must be an array.");
    } else {
      if (member.kind !== "value" || member.array) throw new AdapterParseFailure("Riftbound page header is invalid.");
      if (member.key === "metadata" || member.key === "linkdata") header[member.key] = member.value;
    }
  }
  if (!dataSeen) throw new AdapterParseFailure("Riftbound page data is missing.");
  const { metadata, next } = inventoryHeader(header, count, context.url);
  return {
    count,
    pagination: Object.fromEntries(
      ["locale", "smartListMachineName", "channelMachineName", "limit", "totalItems", "totalPages"].map((key) => [
        key,
        metadata[key],
      ]),
    ),
    requests: next === null ? [] : [{ role: "listing" as const, url: next, headers: { accept: "application/json" } }],
    records: (async function* () {
      for await (const { member } of adapterObjectMembers(source, limits)) {
        if (member.key !== "data" || member.kind !== "value" || !member.array) continue;
        const card = record(member.value);
        yield {
          sourceKey: text(card.id),
          value: observation(card, count, metadata),
          request: {
            role: "image" as const,
            url: publisherImageUrl(record(card.cardImage).url).href,
            headers: {},
          },
        };
      }
    })(),
  };
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
  const url = adapterUrl(text(value));
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
    if (Array.isArray(current)) for (const [i, entry] of current.entries()) visit(entry, `${path}[${i}]`, depth + 1);
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
      .replace(/<br\s*(?:\/\s*)?>|<\/p>/giu, "\n")
      .replace(/<[^>]*>/gu, ""),
  ).trim();
}
