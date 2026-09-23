import type { SourceAdapterParseContext, SourceAdapterRegistration } from "./source-adapter-registration-types";
import { AdapterParseFailure, adapterUrl, decodeAdapterUtf8 } from "./adapter-parse-failure";
import { cardObservation, htmlText, requiredHtmlMatch } from "./adapter-html";
import { normalizeOnePieceCardPage } from "./one-piece-source-adapter";
import { officialArtworkFingerprint } from "./official-artwork-identity";

const origin = "https://onepiece.limitlesstcg.com";
const root = `${origin}/cards/en/P-001`;
const lineage = "limitless-one-piece-en";
const surface = "p-001-catalogue";
const imageOrigin = "https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com";
const htmlHeaders = { accept: "text/html" };
const unknownSurface = () =>
  new AdapterParseFailure("Unknown Limitless coverage surface.", { category: "configuration" });

// The complete declared scope (issue #334): both English index roots, every
// Products/Promos bucket they list, every grid detail page and every English
// front. Bandai remains the Source Authority; this scope supplies supplementary
// evidence under explicit owner admission.
const indexRoots: ReadonlyMap<string, string> = new Map([
  ["products-index", `${origin}/cards`],
  ["promos-index", `${origin}/cards/promos`],
]);
const fullCoverage = {
  description:
    "The English Products and Promos index roots, every bucket page they list (including Prize Cards and Misc. Promos), every linked card detail and variant page and every referenced English front. No prices, legality, decklists or Japanese editions.",
  requiredSurfaces: [...indexRoots.keys()],
  requestUrlForSurface(requested: string) {
    const url = indexRoots.get(requested);
    if (url === undefined) throw unknownSurface();
    return url;
  },
};
const coverage = {
  description:
    "All English P-001 variant pages linked by the base card's Printing table and their front images. No other card numbers, product inventory, prices or eligibility.",
  cardIdentities: [{ kind: "card_number", value: "P-001" }],
  requiredSurfaces: [surface],
  requestUrlForSurface: (requested: string) => {
    if (requested !== surface) throw unknownSurface();
    return root;
  },
};
const pilotNumbers = ["P-001", "ST01-001", "OP16-002", "OP16-019", "OP16-021"];
const pilotRoots = new Map(
  pilotNumbers.map((number) => [
    `${number.toLowerCase()}-catalogue`,
    number === "P-001" ? root : `${origin}/cards/${number}`,
  ]),
);
const pilotCoverage = {
  description:
    "Complete English variant inventories and referenced fronts for P-001, ST01-001, OP16-002, OP16-019 and OP16-021. This named pilot does not establish full-source coverage.",
  cardIdentities: pilotNumbers.map((value) => ({ kind: "card_number", value })),
  requiredSurfaces: [...pilotRoots.keys()],
  requestUrlForSurface(requested: string) {
    const url = pilotRoots.get(requested);
    if (url === undefined) throw unknownSurface();
    return url;
  },
};

const outsideCoverage = () => new AdapterParseFailure("Limitless page is outside the declared source coverage.");
// Card pages are `/cards/NUMBER` with an upper-case prefix and numeric suffix;
// bucket slugs (e.g. `op17-the-worlds-strongest-warriors`, `st14-3D2Y`) are
// everything else the index tables link.
const cardPath = /^\/cards\/(?:en\/)?([A-Z0-9]+-[0-9]+)$/u;
const bucketSlug = /^\/cards\/([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)$/u;

function boundedUrl(value: string) {
  const url = adapterUrl(value);
  if (url.origin !== origin || url.hash || url.username || url.password) throw outsideCoverage();
  return url;
}

/** A card page identity: any English `/cards/NUMBER[?v=N]` page, with the `/cards/en/` alias kept canonical. */
function pageIdentity(value: string) {
  const url = boundedUrl(value);
  const number = cardPath.exec(url.pathname)?.[1];
  if (
    number === undefined ||
    [...url.searchParams.keys()].some((k) => k !== "v") ||
    url.searchParams.getAll("v").length > 1 ||
    (url.search && !/^\?v=[1-9][0-9]*$/u.test(url.search))
  )
    throw outsideCoverage();
  return {
    number,
    variant: url.searchParams.get("v"),
    base: `${url.origin}${url.pathname}`,
    canonical: `${url.origin}/cards/en/${number}${url.search}`,
  };
}

/** Index roots and buckets are discovery roles; every other in-scope page is a card page. */
function classifyPage(value: string): { kind: "index" } | { kind: "bucket" } | { kind: "card" } {
  const url = boundedUrl(value);
  if ([...indexRoots.values()].includes(url.href)) return { kind: "index" };
  if (cardPath.test(url.pathname)) {
    pageIdentity(value);
    return { kind: "card" };
  }
  if (!url.search && bucketSlug.test(url.pathname)) return { kind: "bucket" };
  throw outsideCoverage();
}

function indexBuckets(bytes: Uint8Array) {
  const html = decodeAdapterUtf8(bytes);
  const table = requiredHtmlMatch(
    html,
    /<table class="data-table sets-table[^"]*">([\s\S]*?)<\/table>/u,
    "Limitless index table",
  )[1]!;
  const buckets: string[] = [];
  for (const [, href] of table.matchAll(/<a\s+href="(\/cards\/[^"]+)"/gu)) {
    const url = boundedUrl(adapterUrl(href!, origin).href);
    if ([...indexRoots.values()].includes(url.href)) continue;
    if (url.search || cardPath.test(url.pathname) || !bucketSlug.test(url.pathname))
      throw new AdapterParseFailure("Limitless index links a non-bucket page.");
    if (!buckets.includes(url.href)) buckets.push(url.href);
  }
  if (buckets.length === 0) throw new AdapterParseFailure("Limitless index lists no buckets.");
  return buckets;
}

function bucketDetailPages(bytes: Uint8Array) {
  const html = decodeAdapterUtf8(bytes);
  const grid = requiredHtmlMatch(html, /<div class="card-search-grid">([\s\S]*?)<\/div>/u, "Limitless bucket grid")[1]!;
  const pages: string[] = [];
  for (const [, href] of grid.matchAll(/<a\s+href="([^"]+)"/gu)) {
    const url = adapterUrl(href!.replaceAll("&amp;", "&"), origin).href;
    pageIdentity(url);
    if (!pages.includes(url)) pages.push(url);
  }
  return pages;
}

function parsePage(bytes: Uint8Array, url: string, parents: SourceAdapterParseContext["parents"] = []) {
  const identity = pageIdentity(url);
  const { variant } = identity;
  const html = decodeAdapterUtf8(bytes);
  const required = (pattern: RegExp, label: string) => requiredHtmlMatch(html, pattern, `Limitless ${label}`)[1]!;
  const number = htmlText(required(/<span class="card-text-id">([\s\S]*?)<\/span>/u, "card identifier"));
  if (number !== identity.number) throw new AdapterParseFailure("Limitless page and card identifier disagree.");
  const activeLanguage = /<div class="card-page-options">([\s\S]*?)<\/div>/u.exec(html)?.[1];
  if (activeLanguage !== undefined) {
    const active = requiredHtmlMatch(
      activeLanguage,
      /<a class="active" href=([^\s>]+)>/u,
      "Limitless active language",
    )[1]!;
    if (adapterUrl(active, origin).pathname !== `/cards/en/${number}`)
      throw new AdapterParseFailure("Limitless page is not the English edition.");
  }
  const name = htmlText(required(/<span class="card-text-name">([\s\S]*?)<\/span>/u, "card name"));
  const tooltip = (label: string) =>
    htmlText(required(new RegExp(`<span data-tooltip="${label}">([\\s\\S]*?)<\\/span>`, "u"), label));
  // Limitless leaves an unresolved translation key in the rendered value for a
  // few records (OP13-079 publishes "card.attribute.?", #334). An unresolved key
  // is not a source fact: the field is recorded as not stated.
  const statedTooltip = (label: string) => {
    const value = tooltip(label);
    return /^card\.[a-z_.]+/u.test(value) ? null : value;
  };
  const text = required(/<div class="card-text">([\s\S]*?)<div class="card-legality">/u, "card content");
  const sections = [...text.matchAll(/<div class="card-text-section">([\s\S]*?)<\/div>/gu)].map((match) => match[1]!);
  const rulesSections = sections.filter(
    (section) => !section.includes('class="card-text-title"') && !section.includes('data-tooltip="Type"'),
  );
  if (sections.length - rulesSections.length !== 2 || rulesSections.length > 1)
    throw new AdapterParseFailure("Limitless rules sections changed.");
  const recognizedLabels = new Set(["Category", "Color", "Attribute", "Type"]);
  const optionalFields: { label: string; value: string; url?: string }[] = [
    ...text.matchAll(/<span data-tooltip="([^"]+)">([\s\S]*?)<\/span>/gu),
  ]
    .map((match) => ({ label: htmlText(match[1]!), value: htmlText(match[2]!) }))
    .filter(({ label }) => !recognizedLabels.has(label));
  const rules = (rulesSections[0] ?? "")
    .replace(/<span data-tooltip="([^"]+)">[\s\S]*?<\/span>/gu, (span, label: string) =>
      recognizedLabels.has(htmlText(label)) ? span : "",
    )
    .split(/<br>\s*<br>\s*\[Trigger\]/u);
  if (rules.length > 2) throw new AdapterParseFailure("Limitless repeats the Trigger section.");
  // Limitless renders an inline "[Trigger]" reference inside rules text with the
  // same "<br><br>[Trigger]" shape it uses for a real Trigger section
  // (OP17-105, OP17-109 against Bandai, #334). A real Trigger opens a sentence;
  // an inline reference continues one, so a lower-case continuation is rejoined
  // rather than split into a Trigger that the Card does not have.
  const triggerOpensASentence = rules[1] === undefined || /^\s*(?:[A-Z[]|$)/u.test(htmlText(rules[1]));
  const effect = htmlText(
    triggerOpensASentence ? rules[0]! : `${rules[0]!.replace(/\s+$/u, "")} [Trigger]${rules[1]!}`,
  );
  const category = tooltip("Category");
  const hasCombatProperties = category === "Leader" || category === "Character";
  const raw = {
    Category: category,
    Color: tooltip("Color"),
    Cost: category === "Leader" ? null : htmlText(required(/([0-9]+) Cost/u, "cost")),
    Life: category === "Leader" ? htmlText(required(/([0-9]+) Life/u, "life")) : null,
    Attribute: hasCombatProperties ? statedTooltip("Attribute") : null,
    Power: hasCombatProperties ? htmlText(required(/([0-9]+) Power/u, "power")) : null,
    Counter: /\+([0-9]+) Counter/u.exec(text)?.[1] ?? null,
    Type: tooltip("Type").split("/"),
    "Block icon": [...html.matchAll(/<div class="regulation-mark">\s*Block ([0-9]+)<\/div>/gu)].map((match) =>
      htmlText(match[1]!),
    ),
    Effect: effect.length === 0 ? null : effect,
    Trigger: rules[1] === undefined || !triggerOpensASentence ? null : `[Trigger] ${htmlText(rules[1])}`,
  };
  // Retained raw fields keep the source's slash-joined text; the shared profile
  // receives each listed colour and attribute (e.g. Red/Green, Slash/Strike).
  const normalized = normalizeOnePieceCardPage({
    ...raw,
    Color: raw.Color.split("/"),
    Attribute: raw.Attribute === null ? null : raw.Attribute.split("/"),
  });
  const image = required(/<div class="card-image">\s*<img\b[^>]*\bsrc="([^"]+)"/u, "front image");
  const imageUrl = adapterUrl(image);
  const imageLanguage = new RegExp(
    `^/one-piece/${number.split("-")[0]}/${number}(?:_p[0-9]+)?_(EN|JP)\\.webp$`,
    "u",
  ).exec(imageUrl.pathname)?.[1];
  if (imageUrl.origin !== imageOrigin || imageLanguage === undefined || imageUrl.search || imageUrl.hash)
    throw new AdapterParseFailure("Limitless image is outside the declared source image authority.");
  // The grid lists a few English variants whose only source front is the
  // Japanese print. That image is evidence about the source, not an English
  // Printing Image, so it is retained unmapped and never requested.
  const englishFront = imageLanguage === "EN";
  if (!englishFront) optionalFields.push({ label: "Front image language", value: "jp", url: image });
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
      rules: raw.Effect,
      profile: "one-piece@1",
      attributes: { ...normalized.attributes, effect_text: raw.Effect },
      distribution: { code: `${number.toLowerCase()}-catalogue`, kind: "source_bucket" },
      printing: { rarity: null, normalizedRarity: null, attributes: {} },
      printed_rules: null,
      variant: variant === null ? "base" : `v${variant}`,
      artwork_fingerprint: artwork,
      printed_fields_digest: JSON.stringify(raw),
      treatment: null,
      image,
      images: englishFront ? [{ role: "front", source_url: image, artwork_fingerprint: artwork }] : [],
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
  return { observation, links, image: englishFront ? image : null };
}

function isImage(context: SourceAdapterParseContext) {
  return context.requestId?.includes(":image:") === true || context.mediaType?.startsWith("image/") === true;
}

export const limitlessOnePieceSourceAdapterRegistration: SourceAdapterRegistration = {
  adapterVersion: "limitless-one-piece-en@1",
  sourceLineage: lineage,
  supportedGame: "one-piece",
  gameProfileVersion: "one-piece@1",
  // The registered contract name predates the full-scope parser; before
  // Go-Live the single registration is edited in place (ADR 0008).
  parserContract: "limitless-one-piece-p001-html@1",
  maximumSnapshotBytes: 1024 * 1024,
  // Dated census envelope of the retained 2026-09-21 Products/Promos bucket
  // bodies (issue #334): two index roots, 143 buckets, every unique grid detail
  // page and every unique referenced front. Edited in place before Go-Live
  // (ADR 0008) together with migrations/0043_limitless_full_scope_capacity.sql.
  // It is a finite admission bound, not measured full-import throughput.
  requestCapacity: 9_559,
  retainedParentContext: { maximumDepth: 3, maximumTotalBytes: 3 * 1024 * 1024 },
  // #389 adaptive pacing bounds. Pages stay sequential; the static front CDN
  // is a separate host with bounded concurrency.
  hostPacing: [
    {
      hostname: new URL(origin).hostname,
      kind: "page",
      floorMs: 250,
      ceilingMs: 4_000,
      maximumConcurrency: 1,
      evidence:
        "acceptance/fixtures/real-sources/2026-09-15-limitless/README.md: retained robots has an empty Disallow and the inspected legal notice, Products, Promos and Advanced Search pages state no automation prohibition; #334 made 4,852 page requests at >=2 s, all HTTP 200.",
    },
    {
      hostname: new URL(imageOrigin).hostname,
      kind: "asset",
      floorMs: 50,
      ceilingMs: 2_000,
      maximumConcurrency: 8,
      evidence:
        "Static WebP fronts on a DigitalOcean Spaces CDN; no CDN-specific terms are retained (2026-09-15-limitless README). #334 made 4,687 front requests, all HTTP 200.",
    },
  ],
  origin: "production",
  requestSurface: { kind: "credential-free-https" },
  reconciliationCapability: "catalogue",
  printingAdmission: "owner_review",
  reconciliationAreas: ["catalogue"],
  coverageContracts: { [surface]: coverage, "five-card-pilot": pilotCoverage },
  requiredSurfaces: fullCoverage.requiredSurfaces,
  requestUrlForSurface: fullCoverage.requestUrlForSurface,
  parseBytes(bytes, context) {
    if (isImage(context)) return [];
    const page = classifyPage(context.url);
    if (page.kind === "index") {
      indexBuckets(bytes);
      return [];
    }
    if (page.kind === "bucket") {
      bucketDetailPages(bytes);
      return [];
    }
    return [parsePage(bytes, context.url, context.parents).observation];
  },
  discoverRequests(bytes, context) {
    if (isImage(context)) return [];
    const page = classifyPage(context.url);
    if (page.kind === "index")
      return indexBuckets(bytes).map((url) => ({ role: "listing" as const, url, headers: htmlHeaders }));
    if (page.kind === "bucket")
      return bucketDetailPages(bytes).map((url) => ({ role: "detail" as const, url, headers: htmlHeaders }));
    const card = parsePage(bytes, context.url, context.parents);
    return [
      ...card.links
        .filter((url) => url !== pageIdentity(context.url).base && url !== context.url)
        .map((url) => ({ role: "detail" as const, url, headers: htmlHeaders })),
      ...(card.image === null ? [] : [{ role: "image" as const, url: card.image, headers: { accept: "image/webp" } }]),
    ];
  },
};
