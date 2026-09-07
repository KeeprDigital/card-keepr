import type { SourceAdapterRegistration } from "./source-adapter-registration-types";
import { AdapterParseFailure, adapterUrl, decodeAdapterUtf8 } from "./adapter-parse-failure";
import { cardObservation, htmlText, requiredHtmlMatch } from "./adapter-html";
import { normalizeOnePieceCardPage } from "./one-piece-source-adapter";
import { officialArtworkFingerprint } from "./official-artwork-identity";

const root = "https://onepiece.limitlesstcg.com/cards/en/P-001";
const lineage = "limitless-one-piece-en";
const surface = "p-001-catalogue";
const imageOrigin = "https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com";
const coverage = {
  description:
    "All English P-001 variant pages linked by the base card's Printing table and their front images. No other card numbers, product inventory, prices or eligibility.",
  cardIdentities: [{ kind: "card_number", value: "P-001" }],
  requiredSurfaces: [surface],
  requestUrlForSurface: (requested: string) => {
    if (requested !== surface)
      throw new AdapterParseFailure("Unknown Limitless coverage surface.", { category: "configuration" });
    return root;
  },
};

function pageIdentity(value: string) {
  const url = adapterUrl(value);
  if (
    url.origin !== adapterUrl(root).origin ||
    url.pathname !== "/cards/en/P-001" ||
    url.hash ||
    url.username ||
    url.password ||
    [...url.searchParams.keys()].some((k) => k !== "v") ||
    url.searchParams.getAll("v").length > 1 ||
    (url.search && !/^\?v=[1-9][0-9]*$/u.test(url.search))
  )
    throw new AdapterParseFailure("Limitless P-001 page is outside the declared source coverage.");
  return url.searchParams.get("v");
}
function parsePage(bytes: Uint8Array, url: string) {
  const variant = pageIdentity(url);
  const html = decodeAdapterUtf8(bytes);
  const required = (pattern: RegExp, label: string) => requiredHtmlMatch(html, pattern, `Limitless ${label}`)[1]!;
  const number = htmlText(required(/<span class="card-text-id">([\s\S]*?)<\/span>/u, "card identifier"));
  if (number !== "P-001") throw new AdapterParseFailure("Limitless page and card identifier disagree.");
  const name = htmlText(required(/<span class="card-text-name">([\s\S]*?)<\/span>/u, "card name"));
  const tooltip = (label: string) =>
    htmlText(required(new RegExp(`<span data-tooltip="${label}">([\\s\\S]*?)<\\/span>`, "u"), label));
  const text = required(/<div class="card-text">([\s\S]*?)<div class="card-legality">/u, "card content");
  const sections = [...text.matchAll(/<div class="card-text-section">([\s\S]*?)<\/div>/gu)];
  if (sections.length !== 3) throw new AdapterParseFailure("Limitless P-001 rules sections changed.");
  const recognizedLabels = new Set(["Category", "Color", "Attribute", "Type"]);
  const optionalFields = [...text.matchAll(/<span data-tooltip="([^"]+)">([\s\S]*?)<\/span>/gu)]
    .map((match) => ({ label: htmlText(match[1]!), value: htmlText(match[2]!) }))
    .filter(({ label }) => !recognizedLabels.has(label));
  const effect = htmlText(sections[1]![1]!);
  const raw = {
    Category: tooltip("Category"),
    Color: tooltip("Color"),
    Cost: htmlText(required(/([0-9]+) Cost/u, "cost")),
    Life: null,
    Attribute: tooltip("Attribute"),
    Power: htmlText(required(/([0-9]+) Power/u, "power")),
    Counter: null,
    Type: tooltip("Type").split("/"),
    "Block icon": [htmlText(required(/<div class="regulation-mark">\s*Block ([0-9]+)<\/div>/u, "printed block icon"))],
    Effect: effect,
    Trigger: null,
  };
  const normalized = normalizeOnePieceCardPage(raw);
  const image = required(/<div class="card-image">\s*<img\b[^>]*\bsrc="([^"]+)"/u, "front image");
  const imageUrl = adapterUrl(image);
  if (
    imageUrl.origin !== imageOrigin ||
    !/^\/one-piece\/P\/P-001(?:_p[0-9]+)?_EN\.webp$/u.test(imageUrl.pathname) ||
    imageUrl.search ||
    imageUrl.hash
  )
    throw new AdapterParseFailure("Limitless P-001 image is outside the declared source image authority.");
  const table = required(/<table class="card-prints-versions">([\s\S]*?)<\/table>/u, "complete Printing table");
  const rows = [...table.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gu)].filter((r) => /<td>/u.test(r[2]!));
  if (rows.length === 0 || rows.filter((r) => /class="current"/u.test(r[1]!)).length !== 1)
    throw new AdapterParseFailure("Limitless Printing inventory lacks one selected record.");
  const links = rows.map((row) => {
    if (/class="current"/u.test(row[1]!)) return url;
    const href = requiredHtmlMatch(row[2]!, /<td>\s*<a\s+href="([^"]+)"/u, "Limitless Printing page link")[1]!;
    const linked = adapterUrl(href.replaceAll("&amp;", "&"), root).href;
    pageIdentity(linked);
    return linked;
  });
  if (new Set(links).size !== rows.length || !links.includes(root))
    throw new AdapterParseFailure("Limitless Printing inventory has duplicate or missing base identities.");
  const artwork = officialArtworkFingerprint(number, ["front"], null);
  const observation = cardObservation(
    {
      path: url,
      number,
      title: name,
      rules: effect,
      profile: "one-piece@1",
      attributes: { ...normalized.attributes, effect_text: effect },
      distribution: { code: surface, kind: "source_bucket" },
      printing: { rarity: null, normalizedRarity: null, attributes: {} },
      printed_rules: null,
      variant: variant === null ? "base" : `v${variant}`,
      artwork_fingerprint: artwork,
      printed_fields_digest: JSON.stringify(raw),
      treatment: null,
      image,
      images: [{ role: "front", source_url: image, artwork_fingerprint: artwork }],
    },
    [],
    new Map(),
    { entries: [] },
    "one-piece",
  );
  observation.source_sidecar = {
    raw: { card: raw, printing_pages: links, optional_fields: optionalFields },
    consumed_fields: ["card", "printing_pages"],
    unmapped_optional_fields: optionalFields.map((field, index) => ({
      path: `source_sidecar.raw.optional_fields[${index}]`,
      value: field,
    })),
  };
  return { observation, links, image };
}

export const limitlessOnePieceSourceAdapterRegistration: SourceAdapterRegistration = {
  adapterVersion: "limitless-one-piece-en@1",
  sourceLineage: lineage,
  supportedGame: "one-piece",
  gameProfileVersion: "one-piece@1",
  parserContract: "limitless-one-piece-p001-html@1",
  maximumSnapshotBytes: 1024 * 1024,
  requestCapacity: 100,
  origin: "production",
  requestSurface: { kind: "credential-free-https" },
  reconciliationCapability: "catalogue",
  reconciliationAreas: ["catalogue"],
  coverageContracts: { [surface]: coverage },
  requiredSurfaces: coverage.requiredSurfaces,
  requestUrlForSurface: coverage.requestUrlForSurface,
  parseBytes(bytes, context) {
    if (context.requestId?.includes(":image:")) return [];
    return [parsePage(bytes, context.url).observation];
  },
  discoverRequests(bytes, context) {
    if (context.requestId?.includes(":image:")) return [];
    const page = parsePage(bytes, context.url);
    return [
      ...page.links
        .filter((url) => url !== root && url !== context.url)
        .map((url) => ({ role: "detail" as const, url, headers: { accept: "text/html" } })),
      { role: "image" as const, url: page.image, headers: { accept: "image/webp" } },
    ];
  },
};
