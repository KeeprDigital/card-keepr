import type { SourceAdapterParseContext, SourceAdapterRegistration } from "./source-adapter-registration-types";
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
const pilotNumbers = ["P-001", "ST01-001", "OP16-002", "OP16-019", "OP16-021"];
const pilotRoots = new Map(
  pilotNumbers.map((number) => [
    `${number.toLowerCase()}-catalogue`,
    number === "P-001" ? root : `https://onepiece.limitlesstcg.com/cards/${number}`,
  ]),
);
const pilotCoverage = {
  description:
    "Complete English variant inventories and referenced fronts for P-001, ST01-001, OP16-002, OP16-019 and OP16-021. This named pilot does not establish full-source coverage.",
  cardIdentities: pilotNumbers.map((value) => ({ kind: "card_number", value })),
  requiredSurfaces: [...pilotRoots.keys()],
  requestUrlForSurface(requested: string) {
    const url = pilotRoots.get(requested);
    if (url === undefined)
      throw new AdapterParseFailure("Unknown Limitless coverage surface.", { category: "configuration" });
    return url;
  },
};

function pageIdentity(value: string) {
  const url = adapterUrl(value);
  const number = /^\/cards\/(?:en\/)?(P-001|ST01-001|OP16-002|OP16-019|OP16-021)$/u.exec(url.pathname)?.[1];
  if (
    url.origin !== adapterUrl(root).origin ||
    number === undefined ||
    url.hash ||
    url.username ||
    url.password ||
    [...url.searchParams.keys()].some((k) => k !== "v") ||
    url.searchParams.getAll("v").length > 1 ||
    (url.search && !/^\?v=[1-9][0-9]*$/u.test(url.search))
  )
    throw new AdapterParseFailure("Limitless page is outside the declared source coverage.");
  return {
    number,
    variant: url.searchParams.get("v"),
    base: `${url.origin}${url.pathname}`,
    canonical: `${url.origin}/cards/en/${number}${url.search}`,
  };
}
function parsePage(bytes: Uint8Array, url: string, parents: SourceAdapterParseContext["parents"] = []) {
  const identity = pageIdentity(url);
  const { variant } = identity;
  const html = decodeAdapterUtf8(bytes);
  const required = (pattern: RegExp, label: string) => requiredHtmlMatch(html, pattern, `Limitless ${label}`)[1]!;
  const number = htmlText(required(/<span class="card-text-id">([\s\S]*?)<\/span>/u, "card identifier"));
  if (number !== identity.number) throw new AdapterParseFailure("Limitless page and card identifier disagree.");
  const name = htmlText(required(/<span class="card-text-name">([\s\S]*?)<\/span>/u, "card name"));
  const tooltip = (label: string) =>
    htmlText(required(new RegExp(`<span data-tooltip="${label}">([\\s\\S]*?)<\\/span>`, "u"), label));
  const text = required(/<div class="card-text">([\s\S]*?)<div class="card-legality">/u, "card content");
  const sections = [...text.matchAll(/<div class="card-text-section">([\s\S]*?)<\/div>/gu)];
  if (sections.length !== 3) throw new AdapterParseFailure("Limitless rules sections changed.");
  const recognizedLabels = new Set(["Category", "Color", "Attribute", "Type"]);
  const optionalFields = [...text.matchAll(/<span data-tooltip="([^"]+)">([\s\S]*?)<\/span>/gu)]
    .map((match) => ({ label: htmlText(match[1]!), value: htmlText(match[2]!) }))
    .filter(({ label }) => !recognizedLabels.has(label));
  const rules = sections[1]![1]!
    .replace(/<span data-tooltip="([^"]+)">[\s\S]*?<\/span>/gu, (span, label: string) =>
      recognizedLabels.has(htmlText(label)) ? span : "",
    )
    .split(/<br>\s*<br>\s*\[Trigger\]/u);
  if (rules.length > 2) throw new AdapterParseFailure("Limitless repeats the Trigger section.");
  const effect = htmlText(rules[0]!);
  const category = tooltip("Category");
  const hasCombatProperties = category === "Leader" || category === "Character";
  const raw = {
    Category: category,
    Color: tooltip("Color"),
    Cost: category === "Leader" ? null : htmlText(required(/([0-9]+) Cost/u, "cost")),
    Life: category === "Leader" ? htmlText(required(/([0-9]+) Life/u, "life")) : null,
    Attribute: hasCombatProperties ? tooltip("Attribute") : null,
    Power: hasCombatProperties ? htmlText(required(/([0-9]+) Power/u, "power")) : null,
    Counter: /\+([0-9]+) Counter/u.exec(text)?.[1] ?? null,
    Type: tooltip("Type").split("/"),
    "Block icon": [htmlText(required(/<div class="regulation-mark">\s*Block ([0-9]+)<\/div>/u, "printed block icon"))],
    Effect: effect,
    Trigger: rules[1] === undefined ? null : `[Trigger] ${htmlText(rules[1])}`,
  };
  const normalized = normalizeOnePieceCardPage(raw);
  const image = required(/<div class="card-image">\s*<img\b[^>]*\bsrc="([^"]+)"/u, "front image");
  const imageUrl = adapterUrl(image);
  if (
    imageUrl.origin !== imageOrigin ||
    !new RegExp(`^/one-piece/${number.split("-")[0]}/${number}(?:_p[0-9]+)?_EN\\.webp$`, "u").test(imageUrl.pathname) ||
    imageUrl.search ||
    imageUrl.hash
  )
    throw new AdapterParseFailure("Limitless image is outside the declared source image authority.");
  const table = required(/<table class="card-prints-versions">([\s\S]*?)<\/table>/u, "complete Printing table");
  const rows = [...table.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gu)].filter((r) => /<td>/u.test(r[2]!));
  if (rows.length === 0 || rows.filter((r) => /class="current"/u.test(r[1]!)).length !== 1)
    throw new AdapterParseFailure("Limitless Printing inventory lacks one selected record.");
  const links = rows.map((row) => {
    if (/class="current"/u.test(row[1]!)) return url;
    const href = requiredHtmlMatch(row[2]!, /<td>\s*<a\s+href="([^"]+)"/u, "Limitless Printing page link")[1]!;
    const linked = adapterUrl(href.replaceAll("&amp;", "&"), root).href;
    if (pageIdentity(linked).number !== number)
      throw new AdapterParseFailure("Limitless Printing inventory links a different Card number.");
    return linked;
  });
  const canonicalLinks = links.map((link) => pageIdentity(link).canonical).sort();
  if (new Set(canonicalLinks).size !== rows.length || !canonicalLinks.includes(pageIdentity(identity.base).canonical))
    throw new AdapterParseFailure("Limitless Printing inventory has duplicate or missing base identities.");
  for (const parent of parents) {
    if (![`/cards/${number}`, `/cards/en/${number}`].includes(adapterUrl(parent.url).pathname)) continue;
    const parentLinks = parsePage(parent.bytes, parent.url)
      .links.map((link) => pageIdentity(link).canonical)
      .sort();
    if (JSON.stringify(parentLinks) !== JSON.stringify(canonicalLinks))
      throw new AdapterParseFailure("Limitless Printing inventory changed between retained pages.");
  }
  const artwork = officialArtworkFingerprint(number, ["front"], null);
  const observation = cardObservation(
    {
      path: identity.canonical,
      number,
      title: name,
      rules: effect,
      profile: "one-piece@1",
      attributes: { ...normalized.attributes, effect_text: effect },
      distribution: { code: `${number.toLowerCase()}-catalogue`, kind: "source_bucket" },
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
  retainedParentContext: { maximumDepth: 3, maximumTotalBytes: 3 * 1024 * 1024 },
  origin: "production",
  requestSurface: { kind: "credential-free-https" },
  reconciliationCapability: "catalogue",
  printingAdmission: "owner_review",
  reconciliationAreas: ["catalogue"],
  coverageContracts: { [surface]: coverage, "five-card-pilot": pilotCoverage },
  requiredSurfaces: coverage.requiredSurfaces,
  requestUrlForSurface: coverage.requestUrlForSurface,
  parseBytes(bytes, context) {
    if (context.requestId?.includes(":image:")) return [];
    return [parsePage(bytes, context.url, context.parents).observation];
  },
  discoverRequests(bytes, context) {
    if (context.requestId?.includes(":image:")) return [];
    const page = parsePage(bytes, context.url, context.parents);
    return [
      ...page.links
        .filter((url) => url !== pageIdentity(context.url).base && url !== context.url)
        .map((url) => ({ role: "detail" as const, url, headers: { accept: "text/html" } })),
      { role: "image" as const, url: page.image, headers: { accept: "image/webp" } },
    ];
  },
};
