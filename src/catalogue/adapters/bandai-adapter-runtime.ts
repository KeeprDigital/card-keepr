import { parse as parseHtml } from "parse5";
import type {
  DiscoveryFormat,
  LiveContractFlags,
  OfficialRawAdapterContract,
  ProductSourceGame,
  RawAdapterDefinition,
} from "./adapter-contract";
import {
  attachRawSurfaceEvidenceV1,
  cardObservation,
  colourValues,
  completeObservation,
  decodeHtmlText,
  digimonTextSections,
  digivolutionRequirements,
  firstLabelValue,
  fusionWorldFullLocatorFromUrl,
  fusionWorldLocatorIdentity,
  htmlAttribute,
  htmlLabelPairs,
  htmlText,
  integerOrNull,
  isPlainRecord,
  looseHtmlAttribute,
  nonCardProductClassification,
  type ParsedBandaiSurface,
  productLinksFromHtml,
  productMapKey,
  productOnlyObservation,
  sourceSidecar,
  stageRecord,
  textValues,
} from "./adapter-html";
import {
  type NormalizedSurfaceBody,
  normalizedGundamRarity,
  nullableText,
  requiredArray,
  requiredNonNegativeInteger,
  requiredRecord,
  requiredText,
  requiredTextArray,
  stableValue,
  uniqueTextValues,
} from "./adapter-normalization";
import type { CatalogueObservation, OfficialSourceObservation } from "./adapter-observations";
import { AdapterParseFailure, adapterUrl, withAdapterParseFailure } from "./adapter-parse-failure";
import { parseBandaiProductIndex } from "./adapter-product-html";
import { officialArtworkFingerprint } from "./official-artwork-identity.ts";
import { officialUrl } from "./official-source-authority";
import { onePieceRecordingMemberships } from "./one-piece-source-adapter.ts";

export type GameParsers = {
  surfaceUrl?: (surface: string, url: URL) => boolean;
  packageOptions?: (html: string) => string[];
  productDetail: (html: string, sourceLineage: string, url: string) => CatalogueObservation;
  structuredObservations: (
    surface: string,
    document: Record<string, unknown>,
    sourceLineage: string,
  ) => readonly OfficialSourceObservation[];
  unmappedFields?: (surface: string, document: Record<string, unknown>) => readonly { path: string; value: unknown }[];
  packagesRoot?: (html: string, sourceLineage: string, surface: string, url: string) => CatalogueObservation;
  productIndex?: (html: string, sourceLineage: string, url: string) => CatalogueObservation[];
  validateProductCoverage?: (html: string) => void;

  cardDetail?: (html: string, sourceLineage: string, requestUrl: string) => CatalogueObservation;
  errataArticle?: (html: string, sourceLineage: string, requestUrl: string) => readonly OfficialSourceObservation[];
  popupCardList?: (html: string, requestUrl: string) => CatalogueObservation[];
  inlineCardList?: (html: string, requestUrl: string) => ParsedBandaiSurface;
};

export type SurfaceNormalizer = (
  sourceLineage: string,
  surface: string,
  raw: Record<string, unknown>,
) => NormalizedSurfaceBody;

export function createBandaiAdapter(
  definition: RawAdapterDefinition,
  normalizeSurface: SurfaceNormalizer,
  gameParsers: GameParsers,
): OfficialRawAdapterContract {
  const version = definition.version;
  const requiredSurfaces = Object.freeze([...definition.requiredSurfaces]);
  const urls = Object.freeze({ ...definition.urls, ...version.urls });
  const parse = bandaiSnapshotDecoder(
    definition.format,
    definition.supportedGame,
    definition.sourceLineage,
    requiredSurfaces,
    urls,
    version,
    normalizeSurface,
    gameParsers,
  );
  const discover = bandaiRequestDiscovery(
    definition.format,
    definition.sourceLineage,
    requiredSurfaces,
    urls,
    version.expandedOnePieceCatalogue,
    version.catalogueComplete,
    version.completeDigimonCatalogue,
    gameParsers,
  );
  return Object.freeze({
    adapterVersion: version.adapterVersion,
    parserContract: version.parserContract,
    sourceLineage: definition.sourceLineage,
    supportedGame: definition.supportedGame,
    format: definition.format,
    sourceOrigin: definition.sourceOrigin,
    documentPathnamePrefixes: definition.documentPathnamePrefixes,
    imagePathnamePrefixes: definition.imagePathnamePrefixes,
    partition: definition.partition,
    reconciliationAreas: definition.reconciliationAreas,
    inheritDiscoveryRequestHeaders: definition.inheritDiscoveryRequestHeaders,
    listingReconciliation: definition.listingReconciliation,
    requiredSurfaces,
    requestUrlForSurface: (surface: string) =>
      exactSurfaceUrl(definition.sourceLineage, requiredSurfaces, urls, surface),
    requestUrlForDiscovery: () =>
      exactSurfaceUrl(definition.sourceLineage, requiredSurfaces, urls, requiredSurfaces[0]!),
    parse: (context, bytes) => withAdapterParseFailure(() => parse(bytes, context)),
    discoverRequests: (bytes, context) => withAdapterParseFailure(() => discover(bytes, context)),
  });
}

const maximumFusionCompleteListingHtmlBytes = 1024 * 1024;

function bandaiRequestDiscovery(
  format: DiscoveryFormat,
  sourceLineage: string,
  requiredSurfaces: readonly string[],
  urls: Readonly<Record<string, string>>,
  expandedOnePieceCatalogue = false,
  catalogueComplete = false,
  completeDigimonCatalogue = false,
  gameParsers: GameParsers,
): OfficialRawAdapterContract["discoverRequests"] {
  return (bytes, context) => {
    if (context.requestId?.includes(":image:")) return [];
    const mediaType = context.mediaType?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "text/html") return [];
    const html = decodeUtf8(bytes, "request discovery");
    if (context.requestId === `${sourceLineage}:discovery`) {
      return bandaiDiscoveryRecords(html, sourceLineage, requiredSurfaces, urls).map((record) => ({
        role: "listing" as const,
        discoveryKey: record.surface.slice("@seed:".length),
        url: record.url,
        headers: officialDiscoveredRequestHeaders("listing"),
      }));
    }
    const dynamicRole = dynamicRequestRole(context.requestId);
    const stageKey = discoveryStageKey(context.requestId);
    if (stageKey !== null) {
      return [];
    }
    const discoveryHtml = stripKnownPublisherNavigation(html, sourceLineage, context.url);
    const initialSurface =
      dynamicRole === null ? surfaceFromContext(context, sourceLineage, requiredSurfaces, urls, gameParsers) : null;
    const current = adapterUrl(context.url);
    const completeGundamCatalogue = catalogueComplete && format === "gundam";
    const gundamLiveListing =
      completeGundamCatalogue && (initialSurface === requiredSurfaces[0] || dynamicRole === "listing")
        ? parseCompleteGundamLiveListing(discoveryHtml, current, sourceLineage)
        : null;
    const completeGundamLeaf =
      completeGundamCatalogue && (gundamCompleteListingLeaf(current) || gundamLiveListing !== null);
    if (
      catalogueComplete &&
      format === "fusion-world" &&
      current.origin === adapterUrl(urls["card-search"]!).origin &&
      current.pathname === adapterUrl(urls["card-search"]!).pathname
    ) {
      const partitions = discoveredPartitionRequests(
        format,
        discoveryHtml,
        current,
        expandedOnePieceCatalogue,
        catalogueComplete,
        gameParsers,
      ).map((url) => ({
        role: "listing" as const,
        url,
        headers: officialDiscoveredRequestHeaders("listing"),
      }));
      if (!fusionWorldRestructuredListingLeaf(current)) return partitions;
      fusionWorldHtmlListingEntries(discoveryHtml, context.url, sourceLineage);
      const details = [
        ...new Map(
          [...discoveryHtml.matchAll(/<a\b([^>]*)>/giu)].flatMap((match) => {
            const anchor = fusionWorldListingAnchor(match[1]!, context.url, sourceLineage);
            return anchor === null
              ? []
              : [
                  [
                    anchor.url.href,
                    {
                      role: "detail" as const,
                      url: anchor.url.href,
                      headers: officialDiscoveredRequestHeaders("detail"),
                    },
                  ] as const,
                ];
          }),
        ).values(),
      ].sort((left, right) => left.url.localeCompare(right.url));
      // The restructured card-search root is itself the default category
      // leaf: it both enumerates the remaining category partitions and
      // yields its own Card detail follow-ups.
      return [...partitions, ...details];
    }
    const structuredSurface = dynamicStructuredSurface(
      dynamicRole,
      initialSurface,
      requiredSurfaces,
      completeDigimonCatalogue,
      completeGundamCatalogue,
    );
    const discoveredRequests: {
      role: "listing" | "detail" | "product_detail" | "image";
      url: string;
      headers: Record<string, string>;
    }[] = [];
    if (structuredSurface !== null) {
      const structured = bandaiPublisherPayload(discoveryHtml, sourceLineage, structuredSurface);
      if (structured !== null) {
        if (!completeGundamCatalogue || completeGundamLeaf) {
          discoveredRequests.push(
            ...structuredImageUrls(structured, current, sourceLineage).map((url) => ({
              role: "image" as const,
              url,
              headers: officialDiscoveredRequestHeaders("image"),
            })),
          );
        }
      }
    }
    if (completeGundamCatalogue && (initialSurface === "errata" || gundamErrataListingUrl(current, sourceLineage))) {
      discoveredRequests.push(
        ...gundamErrataArticleUrls(discoveryHtml, current, sourceLineage).map((url) => ({
          role: "detail" as const,
          url,
          headers: officialDiscoveredRequestHeaders("detail"),
        })),
      );
    }
    if (
      ((initialSurface !== null && isDiscoverySurface(initialSurface)) || dynamicRole === "listing") &&
      // Fusion Product pagination has the listing role too, but no Card
      // category facet. Its Product links are discovered by the URL loop below.
      !(
        format === "fusion-world" &&
        dynamicRole === "listing" &&
        current.origin === adapterUrl(urls.products!).origin &&
        current.pathname === adapterUrl(urls.products!).pathname
      ) &&
      !(completeGundamCatalogue && (initialSurface === "errata" || gundamErrataListingUrl(current, sourceLineage)))
    ) {
      discoveredRequests.push(
        ...discoveredPartitionRequests(
          format,
          discoveryHtml,
          current,
          expandedOnePieceCatalogue,
          catalogueComplete,
          gameParsers,
        ).map((url) => ({
          role: "listing" as const,
          url,
          headers: officialDiscoveredRequestHeaders("listing"),
        })),
      );
    }
    for (const match of discoveryHtml.matchAll(/<(a|img|source)\b([^>]*?)>/giu)) {
      const tag = match[1]!.toLowerCase();
      const attributes = match[2]!;
      const fusionWorldAnchor =
        tag === "a" && catalogueComplete && format === "fusion-world"
          ? fusionWorldListingAnchor(attributes, context.url, sourceLineage)
          : null;
      const rawUrl =
        tag === "a"
          ? completeGundamCatalogue
            ? (htmlAttribute(attributes, "data-src") ?? htmlAttribute(attributes, "href"))
            : htmlAttribute(attributes, "href")
          : (htmlAttribute(attributes, "data-src") ??
            htmlAttribute(attributes, "src") ??
            looseHtmlAttribute(attributes, "data-src") ??
            looseHtmlAttribute(attributes, "src"));
      let resolved: URL;
      if (fusionWorldAnchor === null) {
        if (rawUrl === null || rawUrl.startsWith("#") || /^(?:data|javascript|mailto|tel):/iu.test(rawUrl)) {
          continue;
        }
        try {
          resolved = adapterUrl(decodeHtmlText(rawUrl), current);
        } catch {
          continue;
        }
      } else {
        resolved = fusionWorldAnchor.url;
      }
      resolved.hash = "";
      if (resolved.protocol !== "https:" || resolved.href === current.href) {
        continue;
      }
      const role =
        tag === "img" || tag === "source" || /\.(?:avif|gif|jpe?g|png|webp)(?:$|\?)/iu.test(resolved.href)
          ? "image"
          : discoveredHtmlRole(format, initialSurface, resolved, catalogueComplete, completeDigimonCatalogue);
      if (role === null) continue;
      if (
        completeGundamCatalogue &&
        (initialSurface === requiredSurfaces[0] || dynamicRole === "listing") &&
        !completeGundamLeaf &&
        role !== "listing"
      )
        continue;
      if (!officialUrl(sourceLineage, resolved, role === "image" ? "image" : "document")) continue;
      discoveredRequests.push({
        role,
        url: resolved.href,
        headers: officialDiscoveredRequestHeaders(role),
      });
    }
    return [
      ...new Map(discoveredRequests.map((discovered) => [`${discovered.role}:${discovered.url}`, discovered])).values(),
    ].sort((left, right) => `${left.role}:${left.url}`.localeCompare(`${right.role}:${right.url}`));
  };
}

function officialDiscoveredRequestHeaders(
  role: "listing" | "detail" | "product_detail" | "image",
): Record<string, string> {
  return {
    accept: role === "image" ? "image/avif,image/webp,image/png,image/jpeg,image/gif" : "text/html",
    "user-agent": `card-keepr-official-source/1; request-role=${role}`,
  };
}

function structuredImageUrls(value: unknown, base: URL, sourceLineage: string): string[] {
  const discovered: string[] = [];
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      if (/\.(?:avif|gif|jpe?g|png|webp)(?:$|\?)/iu.test(item)) {
        const url = adapterUrl(item, base);
        if (url.protocol === "https:" && officialUrl(sourceLineage, url, "image")) {
          discovered.push(url.href);
        }
      }
      return;
    }
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (isPlainRecord(item)) Object.values(item).forEach(visit);
  };
  visit(value);
  return [...new Set(discovered)].sort();
}

function discoveredPartitionRequests(
  format: DiscoveryFormat,
  html: string,
  current: URL,
  expandedOnePieceCatalogue = false,
  catalogueComplete = false,
  gameParsers: GameParsers,
): string[] {
  if (format === "fusion-world") {
    // The live Fusion World card search partitions by publisher category
    // ("Filter by series"); the currently selected category is already
    // served by the requested leaf itself.
    const currentCategory = current.searchParams.get("category[0]");
    return fusionPublisherCategoryOptions(html)
      .filter((category) => category !== currentCategory)
      .map((category) => {
        const target = adapterUrl(current);
        target.search = "";
        target.searchParams.set("search", "true");
        target.searchParams.set("category[0]", category);
        return target.href;
      });
  }
  if (catalogueComplete && format === "gundam" && !current.searchParams.has("package")) {
    const packageOptions = gameParsers.packageOptions!(html);
    if (packageOptions.length > 0) {
      return packageOptions.map((packageValue) => {
        const target = adapterUrl(current);
        target.searchParams.set("package", packageValue);
        return target.href;
      });
    }
  }
  const selectFacets = [...html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/giu)]
    .map((match) => {
      const attributes = match[1]!;
      const key = htmlAttribute(attributes, "name") ?? htmlAttribute(attributes, "id");
      if (key === null) return null;
      const options = [...match[2]!.matchAll(/<option\b[^>]*\bvalue=["']([^"']+)["'][^>]*>/giu)]
        .map((option) => decodeHtmlText(option[1]!).trim())
        .filter(
          (value) => value.length > 0 && ((catalogueComplete && format === "gundam") || !/^(?:all|0|-)$/iu.test(value)),
        );
      return options.length === 0
        ? null
        : {
            key: key.toLowerCase(),
            options: [...new Set(options)].sort(),
          };
    })
    .filter((entry): entry is { key: string; options: string[] } => entry !== null);
  const stage = nextPartitionFacet(format, selectFacets, current, expandedOnePieceCatalogue);
  if (stage === null) return [];
  return stage.options.map((value) => {
    const url = adapterUrl(current);
    url.searchParams.set(stage.key, value);
    return url.href;
  });
}

function fusionWorldHtmlListingEntries(
  html: string,
  requestUrl: string,
  sourceLineage: string,
): { locator: string; canonical: string }[] {
  const claimed = new Map<string, string>();
  for (const match of html.matchAll(/<a\b([^>]*\bhref=["'][^"']+["'][^>]*)>([\s\S]*?)<\/a>/giu)) {
    const anchor = fusionWorldListingAnchor(match[1]!, requestUrl, sourceLineage);
    if (anchor === null) continue;
    const locator = anchor.locator;
    const identity = fusionWorldLocatorIdentity(locator);
    const dataCardNumber = htmlAttribute(match[1]!, "data-card-number");
    const label =
      htmlText(match[2]!) ||
      decodeHtmlText(htmlAttribute(match[2]!.match(/<img\b([^>]*)>/iu)?.[1] ?? "", "alt") ?? "").trim();
    const observedCardNumber =
      dataCardNumber ?? label.match(/\b[A-Z]{1,6}\d{0,3}-[A-Z0-9]{1,6}\b/u)?.[0] ?? identity.cardNumber;
    if (observedCardNumber !== identity.cardNumber) {
      throw new AdapterParseFailure(
        `Fusion World full locator ${locator} conflicts with Card number ${observedCardNumber}.`,
      );
    }
    const canonical = JSON.stringify(
      stableValue({
        card_number: observedCardNumber,
        label,
      }),
    );
    const prior = claimed.get(locator);
    if (prior !== undefined && prior !== canonical) {
      throw new AdapterParseFailure(`Fusion World full locator ${locator} has conflicting live listing payloads.`);
    }
    claimed.set(locator, canonical);
  }
  return [...claimed.entries()]
    .map(([locator, canonical]) => ({ locator, canonical }))
    .sort((left, right) => left.locator.localeCompare(right.locator));
}

function fusionWorldListingAnchor(
  attributes: string,
  requestUrl: string,
  sourceLineage: string,
): { url: URL; locator: string } | null {
  const href = htmlAttribute(attributes, "href");
  if (href === null) return null;
  const decodedHref = decodeHtmlText(href).trim();
  const javascriptTarget = /^javascript:void\(0\);?$/iu.test(decodedHref);
  const rawTarget = javascriptTarget ? htmlAttribute(attributes, "data-src") : decodedHref;
  if (rawTarget === null) return null;
  let url: URL;
  try {
    url = adapterUrl(decodeHtmlText(rawTarget), requestUrl);
  } catch {
    return null;
  }
  url.hash = "";
  if (!officialUrl(sourceLineage, url, "document") || !/(?:detail|card)/iu.test(url.pathname)) {
    return null;
  }
  const locator = fusionWorldFullLocatorFromUrl(url, javascriptTarget);
  return locator === null ? null : { url, locator };
}

function fusionWorldRestructuredListingLeaf(url: URL): boolean {
  // The live card search serves one complete category listing per request:
  // exactly ?search=true with one publisher category identifier.
  const categories = url.searchParams.getAll("category[0]");
  return (
    url.searchParams.getAll("search").length === 1 &&
    url.searchParams.get("search") === "true" &&
    categories.length === 1 &&
    /^\d+$/u.test(categories[0]!) &&
    [...url.searchParams.keys()].every((key) => key === "search" || key === "category[0]")
  );
}

function fusionPublisherCategoryOptions(html: string): string[] {
  const sections = [
    ...html.matchAll(
      /<section\b[^>]*\bclass=["'][^"']*\bsearchColSet-product\b[^"']*["'][^>]*>([\s\S]*?)<\/section>/giu,
    ),
  ];
  if (sections.length === 0) {
    throw new AdapterParseFailure("Official Source Fusion World category discovery is unavailable.");
  }
  const options = sections.flatMap((section) =>
    [...section[1]!.matchAll(/<a\b([^>]*)>/giu)].flatMap((match) => {
      const value = htmlAttribute(match[1]!, "data-val")?.trim();
      return value === undefined || value.length === 0 || !/^\d+$/u.test(value) ? [] : [value];
    }),
  );
  return [...new Set(options)];
}

function nextPartitionFacet(
  format: DiscoveryFormat,
  facets: readonly { key: string; options: string[] }[],
  current: URL,
  expandedOnePieceCatalogue = false,
): { key: string; options: string[] } | null {
  const find = (keys: readonly string[]) => facets.find(({ key }) => keys.includes(key)) ?? null;
  const hasFacet = (keys: readonly string[]) => keys.some((key) => current.searchParams.has(key));
  if (format === "one-piece") {
    const recording = find([expandedOnePieceCatalogue ? "series" : "recording"]);
    if (recording === null) return null;
    const selected = current.searchParams.getAll(recording.key);
    if (selected.length > 1) return null;
    // The restructured discovery root is itself pinned to one live series
    // leaf, so the remaining Recordings are enumerated around it.
    const numeric = recording.options.filter((value) => /^\d+$/u.test(value) && !selected.includes(value));
    return numeric.length === 0 ? null : { key: recording.key, options: numeric };
  }
  const hierarchy =
    format === "fusion-world"
      ? [["card_type"], ["colour", "color"], ["cost"]]
      : format === "digimon"
        ? [["category"], ["cardcategory", "card_type"], ["colour", "color"]]
        : [["package"]];
  for (const aliases of hierarchy) {
    const facet = find(aliases);
    if (facet === null) continue;
    if (hasFacet(aliases)) {
      continue;
    }
    return facet;
  }
  return null;
}

const fusionCountInertElements = new Set([
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
  "style",
  "script",
  "template",
  "textarea",
  "title",
  "xmp",
]);

type HtmlTreeNode = {
  attrs?: readonly { name: string; value: string }[];
  childNodes?: readonly HtmlTreeNode[];
  nodeName: string;
  tagName?: string;
  value?: string;
};

function visibleFusionPublisherCount(html: string): string | null {
  const resultNodes: HtmlTreeNode[] = [];
  const stack: { hiddenAncestor: boolean; node: HtmlTreeNode }[] = [
    {
      hiddenAncestor: false,
      node: parseHtml(html) as unknown as HtmlTreeNode,
    },
  ];
  while (stack.length > 0) {
    const { hiddenAncestor, node } = stack.pop()!;
    const attributes = new Map((node.attrs ?? []).map(({ name, value }) => [name, value]));
    const hidden = hiddenAncestor || attributes.has("hidden");
    if (!hidden && node.tagName === "div" && asciiClassTokens(attributes.get("class") ?? "").includes("resultTxt")) {
      resultNodes.push(node);
    }
    if (node.tagName !== undefined && fusionCountInertElements.has(node.tagName)) {
      continue;
    }
    const children = node.childNodes ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ hiddenAncestor: hidden, node: children[index]! });
    }
  }
  if (resultNodes.length !== 1) return null;

  const children = resultNodes[0]!.childNodes ?? [];
  if (children.length !== 3) return null;
  const [prefix, countContainer, suffix] = children;
  if (
    prefix?.nodeName !== "#text" ||
    !/^[\t\n\f\r ]*Result[\t\n\f\r ]*$/i.test(prefix.value ?? "") ||
    countContainer?.tagName !== "span" ||
    !asciiClassTokens(attributeValue(countContainer, "class")).includes("num") ||
    suffix?.nodeName !== "#text" ||
    !/^[\t\n\f\r ]*cards?[\t\n\f\r ]*$/i.test(suffix.value ?? "")
  ) {
    return null;
  }
  const countChildren = countContainer.childNodes ?? [];
  if (countChildren.length !== 1 || countChildren[0]!.nodeName !== "#text") {
    return null;
  }
  return countChildren[0]!.value?.match(/^[\t\n\f\r ]*(\d+)[\t\n\f\r ]*$/)?.[1] ?? null;
}

function asciiClassTokens(value: string): string[] {
  return value.split(/[\t\n\f\r ]+/).filter(Boolean);
}

function attributeValue(node: HtmlTreeNode, name: string): string {
  return node.attrs?.find((attribute) => attribute.name === name)?.value ?? "";
}

function dynamicRequestRole(requestId: string | undefined): "listing" | "detail" | "product_detail" | "image" | null {
  const match = requestId?.match(/:(listing|detail|product_detail|image)(?::[a-z0-9]+(?:-[a-z0-9]+)*)?:[a-f0-9]{64}$/u);
  return (match?.[1] as ReturnType<typeof dynamicRequestRole>) ?? null;
}

function discoveryStageKey(requestId: string | undefined): string | null {
  return requestId?.match(/:listing:([a-z0-9]+(?:-[a-z0-9]+)*):[a-f0-9]{64}$/u)?.[1] ?? null;
}

function dynamicStructuredSurface(
  dynamicRole: ReturnType<typeof dynamicRequestRole>,
  fallbackSurface: string | null,
  requiredSurfaces: readonly string[],
  completeDigimonCatalogue: boolean,
  completeGundamCatalogue = false,
): string | null {
  return dynamicRole === "listing" && (completeDigimonCatalogue || completeGundamCatalogue)
    ? requiredSurfaces[0]!
    : fallbackSurface;
}

function gundamCompleteListingLeaf(url: URL): boolean {
  const packages = url.searchParams.getAll("package");
  const pages = url.searchParams.getAll("page");
  return (
    [...url.searchParams.keys()].every((key) => key === "package" || key === "page") &&
    packages.length === 1 &&
    packages[0]!.trim().length > 0 &&
    pages.length <= 1 &&
    (pages.length === 0 || /^[1-9]\d*$/u.test(pages[0]!))
  );
}

function parseCompleteGundamLiveListing(
  html: string,
  requestUrl: URL,
  sourceLineage: string,
): {
  declaredTotal: number;
  fullLocators: string[];
  selectedPackage: string | null;
  selectedPage: number;
  terminalPage: boolean;
} | null {
  const totals = [
    ...html.matchAll(
      /<div\b[^>]*\bclass=["'][^"']*\bresultTxt\b[^"']*["'][^>]*>[\s\S]*?<span\b[^>]*\bclass=["'][^"']*\bnum\b[^"']*["'][^>]*>\s*(\d+)\s*<\/span>[\s\S]*?<\/div>/giu,
    ),
  ];
  const cardItems = [...html.matchAll(/<li\b[^>]*\bclass=["'][^"']*\bcardItem\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/giu)];
  if (totals.length === 0 && cardItems.length === 0) return null;
  if (totals.length !== 1) {
    throw new AdapterParseFailure("Official Source Gundam listing requires one exact publisher total.");
  }
  if ([...requestUrl.searchParams.keys()].some((key) => key !== "package" && key !== "page")) {
    throw new AdapterParseFailure("Official Source Gundam listing request has unsupported facets.");
  }
  const requestedPackages = requestUrl.searchParams.getAll("package");
  if (requestedPackages.length > 1 || requestedPackages[0]?.trim() === "") {
    throw new AdapterParseFailure("Official Source Gundam listing request package is invalid.");
  }
  const selectedPackages = [...html.matchAll(/<input\b([^>]*)>/giu)].flatMap((match) => {
    const attributes = match[1]!;
    return htmlAttribute(attributes, "name") === "package" ? [htmlAttribute(attributes, "value")?.trim() ?? ""] : [];
  });
  const requestedPackage = requestedPackages[0] ?? "";
  if (selectedPackages.length === 0 || selectedPackages.some((value) => value !== requestedPackage)) {
    throw new AdapterParseFailure("Official Source Gundam selected package does not match the request.");
  }
  const requestedPages = requestUrl.searchParams.getAll("page");
  if (requestedPages.length > 1 || (requestedPages.length === 1 && !/^[1-9]\d*$/u.test(requestedPages[0]!))) {
    throw new AdapterParseFailure("Official Source Gundam listing request page is invalid.");
  }
  const requestedPage = requestedPages[0] ?? "1";
  const selectedPages = [...html.matchAll(/<input\b([^>]*)>/giu)].flatMap((match) => {
    const attributes = match[1]!;
    return htmlAttribute(attributes, "name") === "page" ? [htmlAttribute(attributes, "value")?.trim() ?? ""] : [];
  });
  if (
    requestedPages.length === 1 &&
    (selectedPages.length === 0 || selectedPages.some((value) => value !== requestedPage))
  ) {
    throw new AdapterParseFailure("Official Source Gundam selected page does not match the request.");
  }
  if (requestedPages.length === 0 && selectedPages.some((value) => value !== "1")) {
    throw new AdapterParseFailure("Official Source Gundam selected page does not match the request.");
  }
  const declaredTotal = Number.parseInt(totals[0]![1]!, 10);
  const fullLocators = cardItems.map((item) => {
    const anchor = item[1]!.match(/<a\b([^>]*)>/iu);
    const rawDetail = anchor === null ? null : htmlAttribute(anchor[1]!, "data-src");
    if (rawDetail === null) {
      throw new AdapterParseFailure("Official Source Gundam listing Card has no full detail locator.");
    }
    const detailUrl = adapterUrl(decodeHtmlText(rawDetail), requestUrl);
    const entries = [...detailUrl.searchParams.entries()];
    const locator = detailUrl.searchParams.get("detailSearch")?.trim();
    if (
      !officialUrl(sourceLineage, detailUrl, "document") ||
      !/\/cards\/detail\.php$/u.test(detailUrl.pathname) ||
      entries.length !== 1 ||
      entries[0]![0] !== "detailSearch" ||
      locator === undefined ||
      !/^[A-Z0-9]+(?:-[A-Z0-9]+)+(?:_p[1-9]\d*)?$/u.test(locator)
    ) {
      throw new AdapterParseFailure("Official Source Gundam listing Card full detail locator is invalid.");
    }
    return locator;
  });
  const terminalPage = /<div\b[^>]*\bclass=["'][^"']*\bpager\b[^"']*["'][^>]*>\s*<\/div>/iu.test(html);
  if (
    new Set(fullLocators).size !== fullLocators.length ||
    fullLocators.length > declaredTotal ||
    (terminalPage && requestedPage === "1" && fullLocators.length !== declaredTotal)
  ) {
    throw new AdapterParseFailure("Official Source Gundam publisher total does not match its unique full locators.");
  }
  return {
    declaredTotal,
    fullLocators,
    selectedPackage: requestedPackages[0] ?? null,
    selectedPage: Number.parseInt(requestedPage, 10),
    terminalPage,
  };
}

function discoveredHtmlRole(
  format: DiscoveryFormat,
  initialSurface: string | null,
  url: URL,
  catalogueComplete = false,
  completeDigimonCatalogue = false,
): "listing" | "detail" | "product_detail" | null {
  const target = `${url.pathname}${url.search}`;
  if (
    catalogueComplete &&
    format === "gundam" &&
    (initialSurface === "errata" || /^\/(?:asia-en|en)\/news\/$/u.test(url.pathname))
  ) {
    return gundamErrataListingUrl(url) ? "listing" : null;
  }
  if (
    catalogueComplete &&
    format === "gundam" &&
    /^\/(?:asia-en|en)\/cards\/(?:index\.php)?$/u.test(url.pathname) &&
    (url.searchParams.has("package") || url.searchParams.has("page")) &&
    !url.searchParams.has("detailSearch")
  ) {
    return "listing";
  }
  if (
    catalogueComplete &&
    format === "fusion-world" &&
    /\/cardlist\/detail\.php$/iu.test(url.pathname) &&
    fusionWorldFullLocatorFromUrl(url, false) !== null
  ) {
    return "detail";
  }
  if (initialSurface === "products" || initialSurface === "releases" || /\/products?\//iu.test(target)) {
    // The live product-detail model fetches accessory pages and classifies
    // them from their retained markup instead of skipping them by URL
    // vocabulary.
    if (catalogueComplete && format === "fusion-world" && url.searchParams.has("status")) return "listing";
    return /(?:detail|products?\/[^/?]+|products?\.php\?.*\bid=)/iu.test(target)
      ? "product_detail"
      : /(?:page|paged|offset)=\d+/iu.test(target)
        ? "listing"
        : null;
  }
  if (
    completeDigimonCatalogue &&
    format === "digimon" &&
    /(?:category|cardcategory|colour|color|version)=/iu.test(target)
  ) {
    return "listing";
  }
  if (/(?:detailSearch|card[_-]?(?:detail|id)|popup)=/iu.test(target)) {
    return "detail";
  }
  if (/\/cards?\/[^/?]+/iu.test(target) || /\/cardlist\/card\//iu.test(target)) {
    return "detail";
  }
  if (
    /(?:page|paged|offset)=\d+/iu.test(target) ||
    (format === "fusion-world" && /(?:card_type|colour|color|cost)=/iu.test(target)) ||
    (format === "digimon" && /(?:category|cardcategory|colour|color|version)=/iu.test(target)) ||
    (format === "gundam" && /(?:package|page)=/iu.test(target))
  ) {
    return "listing";
  }
  return null;
}

function gundamErrataArticleUrls(html: string, current: URL, sourceLineage: string): string[] {
  return [
    ...new Set(
      [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/giu)].flatMap((match) => {
        const href = htmlAttribute(match[1]!, "href");
        if (href === null || !/\b(?:errata|revision|correction)\b/iu.test(htmlText(match[2]!))) return [];
        let url: URL;
        try {
          url = adapterUrl(decodeHtmlText(href), current);
        } catch {
          return [];
        }
        url.hash = "";
        return gundamErrataArticleUrl(url, sourceLineage) ? [url.href] : [];
      }),
    ),
  ].sort();
}

function gundamErrataArticleUrl(url: URL, sourceLineage: string): boolean {
  const locale = sourceLineage === "gundam-en-asia" ? "asia-en" : "en";
  return (
    url.origin === "https://www.gundam-gcg.com" &&
    new RegExp(`^/${locale}/news/(?:01|02)_[0-9]+\\.html$`, "u").test(url.pathname) &&
    url.search === "" &&
    url.username === "" &&
    url.password === ""
  );
}

function gundamErrataListingUrl(url: URL, sourceLineage?: string): boolean {
  const locale = sourceLineage === undefined ? "(?:asia-en|en)" : sourceLineage === "gundam-en-asia" ? "asia-en" : "en";
  const keys = [...url.searchParams.keys()];
  const pages = url.searchParams.getAll("page");
  const tags = url.searchParams.getAll("tag");
  return (
    url.origin === "https://www.gundam-gcg.com" &&
    new RegExp(`^/${locale}/news/$`, "u").test(url.pathname) &&
    url.searchParams.getAll("subcategory").length === 1 &&
    url.searchParams.get("subcategory") === "news" &&
    (pages.length === 0 || (pages.length === 1 && /^[1-9]\d*$/u.test(pages[0]!))) &&
    // The live news hub appends an explicit all-tags filter to its
    // subcategory tabs.
    (tags.length === 0 || (tags.length === 1 && tags[0] === "all")) &&
    keys.every((key) => key === "subcategory" || key === "page" || key === "tag")
  );
}

function officialHostname(sourceLineage: string, hostname: string): boolean {
  const expected =
    sourceLineage === "one-piece-en"
      ? ["onepiece-cardgame.com"]
      : sourceLineage === "fusion-world-en"
        ? ["dbs-cardgame.com"]
        : sourceLineage === "digimon-en"
          ? ["digimoncard.com"]
          : ["gundam-gcg.com"];
  return expected.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

function exactSurfaceUrl(
  sourceLineage: string,
  requiredSurfaces: readonly string[],
  urls: Readonly<Record<string, string>>,
  surface: string,
): string {
  if (!requiredSurfaces.includes(surface)) {
    throw new AdapterParseFailure(`Official Source lineage ${sourceLineage} has no ${surface} surface.`, {
      category: "configuration",
    });
  }
  const url = urls[surface];
  if (url === undefined) {
    throw new AdapterParseFailure(`Official Source lineage ${sourceLineage} has no ${surface} URL.`, {
      category: "configuration",
    });
  }
  return adapterUrl(url).href;
}

function bandaiSnapshotDecoder(
  format: DiscoveryFormat,
  game: ProductSourceGame,
  sourceLineage: string,
  requiredSurfaces: readonly string[],
  urls: Readonly<Record<string, string>>,
  profile: LiveContractFlags,
  normalizeSurface: SurfaceNormalizer,
  gameParsers: GameParsers,
): (
  bytes: Uint8Array,
  context: { mediaType: string | null; url: string; requestId?: string },
) => readonly OfficialSourceObservation[] {
  return (bytes, context) => {
    const dynamicRole = dynamicRequestRole(context.requestId);
    const mediaType = context.mediaType?.split(";", 1)[0]?.trim().toLowerCase();
    if (dynamicRole === "image") {
      if (mediaType === undefined || !mediaType.startsWith("image/") || bytes.byteLength === 0) {
        throw new AdapterParseFailure("Official Printing Image request did not retain non-empty image bytes.");
      }
      return [];
    }
    if (
      context.requestId === `${sourceLineage}:discovery` &&
      adapterUrl(context.url).href === adapterUrl(urls[requiredSurfaces[0]!]!).href
    ) {
      if (mediaType !== "text/html") {
        throw new AdapterParseFailure("Official Source discovery must be captured as text/html.");
      }
      const html = decodeUtf8(bytes, "discovery");
      if (/\bdata-keepr-official-payload\b/iu.test(html)) {
        throw new AdapterParseFailure(
          "Production Official Source parsing does not accept synthetic Keepr payload wrappers.",
        );
      }
      if (profile.completeDigimonCatalogue === true) {
        assertDigimonCatalogueFactsAtCompleteLeaf(html, sourceLineage, requiredSurfaces[0]!, context.url);
      }
      const records = bandaiDiscoveryRecords(html, sourceLineage, requiredSurfaces, urls);
      return [
        {
          observation_type: "official_surface_evidence",
          source_lineage: sourceLineage,
          surface: "discovery",
          records,
          completeness: {
            declared_record_count: records.length,
            parsed_record_count: records.length,
            required_surfaces_complete: true,
            partitions_complete: true,
            structurally_complete: true,
          },
        },
      ];
    }
    const discoveryKey = discoveryStageKey(context.requestId);
    if (discoveryKey !== null) {
      if (mediaType !== "text/html") {
        throw new AdapterParseFailure("Official Source discovery stages must be captured as text/html.");
      }
      const html = decodeUtf8(bytes, `discovery stage ${discoveryKey}`);
      const records = bandaiDiscoveryStageRecords(html, context.url, sourceLineage, discoveryKey, requiredSurfaces);
      return [
        {
          observation_type: "official_surface_evidence",
          source_lineage: sourceLineage,
          surface: "discovery",
          records,
          completeness: {
            declared_record_count: records.length,
            parsed_record_count: records.length,
            required_surfaces_complete: true,
            partitions_complete: true,
            structurally_complete: true,
          },
        },
      ];
    }
    const surface = dynamicRole ?? surfaceFromContext(context, sourceLineage, requiredSurfaces, urls, gameParsers);
    const structuredSurface = dynamicStructuredSurface(
      dynamicRole,
      surface,
      requiredSurfaces,
      profile.completeDigimonCatalogue === true,
      profile.catalogueComplete === true && format === "gundam",
    );
    if (structuredSurface === null) {
      throw new AdapterParseFailure("Official Source dynamic surface identity is invalid.");
    }
    if (mediaType !== "text/html") {
      throw new AdapterParseFailure(`Official Source ${surface} must be captured as text/html.`);
    }
    if (
      profile.catalogueComplete === true &&
      format === "fusion-world" &&
      (dynamicRole === "listing" || surface === "card-search") &&
      fusionWorldRestructuredListingLeaf(adapterUrl(context.url)) &&
      bytes.byteLength > maximumFusionCompleteListingHtmlBytes
    ) {
      throw new AdapterParseFailure(
        `Fusion World complete listing HTML exceeds the ${maximumFusionCompleteListingHtmlBytes}-byte parser limit.`,
      );
    }
    const html = stripKnownPublisherNavigation(decodeUtf8(bytes, surface), sourceLineage, context.url);
    if (/\bdata-keepr-official-payload\b/iu.test(html)) {
      throw new AdapterParseFailure(
        "Production Official Source parsing does not accept synthetic Keepr payload wrappers.",
      );
    }
    const structuredPayload = bandaiPublisherPayload(html, sourceLineage, structuredSurface);
    if (structuredPayload !== null) {
      if (profile.completeDigimonCatalogue === true && structuredSurface === requiredSurfaces[0]) {
        assertDigimonPayloadAtCompleteLeaf(structuredPayload, context.url);
      }
      if (profile.catalogueComplete === true && format === "gundam" && structuredSurface === requiredSurfaces[0]) {
        assertGundamPayloadAtCompleteLeaf(structuredPayload, context.url);
      }
      const observations = normalizedSurfaceObservationsV2(
        format,
        game,
        sourceLineage,
        structuredSurface,
        structuredPayload,
        profile.expandedOnePieceCatalogue === true,
        profile.catalogueComplete === true,

        normalizeSurface,
        gameParsers,
      );
      return observations;
    }
    if (dynamicRole === "detail") {
      if (
        profile.catalogueComplete === true &&
        format === "gundam" &&
        gundamErrataArticleUrl(adapterUrl(context.url), sourceLineage)
      ) {
        return gameParsers.errataArticle!(html, sourceLineage, context.url);
      }
      if (profile.catalogueComplete === true && format === "gundam") {
        return [gameParsers.cardDetail!(html, sourceLineage, context.url)];
      }
      return [
        profile.catalogueComplete === true && format === "fusion-world"
          ? gameParsers.cardDetail!(html, sourceLineage, context.url)
          : parseBandaiCardDetailV2(
              html,
              format,
              sourceLineage,
              context.url,
              profile.catalogueComplete === true && format === "gundam",
            ),
      ];
    }
    if (dynamicRole === "product_detail") {
      return [gameParsers.productDetail(html, sourceLineage, context.url)];
    }
    const isOnePieceRecordingLeaf =
      profile.expandedOnePieceCatalogue === true &&
      format === "one-piece" &&
      dynamicRole === "listing" &&
      /^\d+$/u.test(adapterUrl(context.url).searchParams.get("series") ?? "");
    if (
      profile.completeDigimonCatalogue === true &&
      format === "digimon" &&
      dynamicRole === "listing" &&
      structuredSurface === requiredSurfaces[0] &&
      (isCompleteDigimonLeafUrl(context.url) || digimonPopupRecordCount(html) > 0)
    ) {
      assertCompleteDigimonLeafUrl(context.url);
      return gameParsers.popupCardList!(html, context.url);
    }
    const completeGundamListing =
      profile.catalogueComplete === true && format === "gundam" && structuredSurface === requiredSurfaces[0]
        ? parseCompleteGundamLiveListing(html, adapterUrl(context.url), sourceLineage)
        : null;
    if (
      profile.catalogueComplete === true &&
      format === "gundam" &&
      structuredSurface === requiredSurfaces[0] &&
      completeGundamListing === null
    ) {
      // The live card search renders no listing at all until a package is
      // selected. The bare search root must prove its empty state and its
      // package enumeration; a package leaf that fails to render its listing
      // is unmodelled drift and must fail the parse.
      if (adapterUrl(context.url).searchParams.has("package")) {
        throw new AdapterParseFailure("Official Source Gundam package leaf did not render its card listing.");
      }
      return [gameParsers.packagesRoot!(html, sourceLineage, surface, context.url)];
    }
    const parsed =
      completeGundamListing !== null
        ? completeGundamListingCoverage(completeGundamListing, sourceLineage, surface, context.url)
        : format === "one-piece" && (surface === "card-list" || isOnePieceRecordingLeaf)
          ? gameParsers.inlineCardList!(html, context.url)
          : parseBandaiSurfaceCoverageV2(
              html,
              format,
              sourceLineage,
              profile.catalogueComplete === true &&
                format === "fusion-world" &&
                surface === "listing" &&
                /\/products\//u.test(adapterUrl(context.url).pathname)
                ? "products"
                : surface,
              context.url,
              false,
              profile.catalogueComplete === true,
              profile.liveShapes === true,
              gameParsers,
            );
    return parsed.observations.map((observation, index) =>
      attachRawSurfaceEvidenceV1(
        observation,
        sourceLineage,
        surface,
        parsed.retainedDocument,
        index === 0,
        parsed.consumedFields,
      ),
    );
  };
}

function hasExactHtmlAttributes(attributes: string, expected: readonly string[]): boolean {
  const retained = [...attributes.matchAll(/\b([a-z][a-z0-9:-]*)\s*=\s*(?:"[^"]*"|'[^']*')/giu)];
  const names = retained.map((match) => match[1]!.toLowerCase()).sort();
  const residue = retained.reduce((value, match) => value.replace(match[0], ""), attributes).trim();
  return residue.length === 0 && names.join(",") === [...expected].sort().join(",");
}

function stripKnownPublisherNavigation(
  html: string,
  sourceLineage: string,
  contextUrl: string,
  scope: "all" | "header-only" = "all",
): string {
  const allowed = knownPublisherNavigationLinks(sourceLineage);
  const containsOnlyKnownLinks = (body: string): boolean => {
    const anchors = [...body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/giu)];
    if (
      anchors.length === 0 ||
      anchors.some((anchor) => {
        if (!hasExactHtmlAttributes(anchor[1]!, ["href"])) return true;
        const href = htmlAttribute(anchor[1]!, "href");
        if (href === null) return true;
        let resolved: string;
        try {
          resolved = adapterUrl(decodeHtmlText(href), contextUrl).href;
        } catch {
          return true;
        }
        const label = htmlText(anchor[2]!).toLocaleLowerCase();
        return !allowed.has(`${label}\u0000${resolved}`);
      })
    ) {
      return false;
    }
    const withoutKnownNavigation = body.replace(/<a\b[^>]*>[\s\S]*?<\/a>/giu, "").replace(/<\/?(?:ul|ol|li)>/giu, "");
    return htmlText(withoutKnownNavigation).length === 0;
  };
  const withoutHeader = html.replace(
    /<header\b([^>]*)>([\s\S]*?)<\/header>/giu,
    (header, attributes: string, body: string) => {
      if (attributes.trim().length > 0) return header;
      const navigation = body.match(/^\s*<nav\b([^>]*)>([\s\S]*?)<\/nav>\s*$/iu);
      return navigation !== null && navigation[1]!.trim().length === 0 && containsOnlyKnownLinks(navigation[2]!)
        ? ""
        : header;
    },
  );
  if (scope === "header-only") return withoutHeader;
  return withoutHeader
    .replace(/<nav\b([^>]*)>([\s\S]*?)<\/nav>/giu, (navigation, attributes: string, body: string) =>
      hasExactNavigationContainerAttributes(attributes) && containsOnlyKnownLinks(body) ? "" : navigation,
    )
    .replace(/<main\b([^>]*)>([\s\S]*?)<\/main>/giu, (main, attributes: string, body: string) =>
      attributes.trim().length === 0 && containsOnlyKnownLinks(body) ? "" : main,
    );
}

function hasExactNavigationContainerAttributes(attributes: string): boolean {
  return (
    attributes.trim().length === 0 ||
    (hasExactHtmlAttributes(attributes, ["aria-label"]) &&
      htmlAttribute(attributes, "aria-label") === "Rules publications")
  );
}

function knownPublisherNavigationLinks(sourceLineage: string): Set<string> {
  const labelsBySurface: Readonly<Record<string, string>> = {
    "card-list": "card list",
    packages: "find cards",
    errata: sourceLineage.startsWith("gundam-") ? "errata and corrections" : "errata cards",
  };
  const allowed = new Set<string>();
  for (const seed of [...publisherNavigationSeeds(sourceLineage), ...bandaiDiscoverySeeds(sourceLineage)]) {
    allowed.add(`${seed.label}\u0000${adapterUrl(seed.url).href}`);
    for (const [surface, resolution] of Object.entries(seed.resolutions)) {
      const label = labelsBySurface[surface];
      if (label !== undefined) {
        allowed.add(`${label}\u0000${adapterUrl(resolution, seed.url).href}`);
      }
    }
  }
  if (sourceLineage === "fusion-world-en") {
    allowed.add(
      "previous restriction history\u0000https://www.dbs-cardgame.com/fw/en/rules/banned-limited-cards/?view=history",
    );
  } else if (sourceLineage === "digimon-en") {
    allowed.add("previous restriction history\u0000https://world.digimoncard.com/rule/restriction_card/?view=history");
  }
  return allowed;
}

function publicationText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  const label = (value as Record<string, unknown>).label;
  return typeof label === "string" ? label : "";
}

function bandaiDiscoveryRecords(
  html: string,
  sourceLineage: string,
  requiredSurfaces: readonly string[],
  urls: Readonly<Record<string, string>>,
): Array<{
  id: string;
  surface: string;
  method: "GET";
  url: string;
  headers: Record<string, string>;
  discovered_from: {
    kind: "publisher_navigation";
    label: string;
    url: string;
    resolution: string;
  };
}> {
  const headers = [...html.matchAll(/<header\b([^>]*)>([\s\S]*?)<\/header>/giu)];
  if (headers.length !== 1) {
    throw new AdapterParseFailure("Official Source discovery must retain exactly one publisher header.");
  }
  const seeds = bandaiDiscoverySeeds(sourceLineage);
  const framing = exactPublisherDiscoveryFraming(sourceLineage);
  if (headers[0]![1]!.trim() !== framing.headerAttributes || !framing.container.test(html)) {
    throw new AdapterParseFailure(
      "Official Source discovery does not match its retained publisher navigation framing.",
    );
  }
  const discoveryUrl = adapterUrl(urls[requiredSurfaces[0]!]!).href;
  const observedSeeds = new Map<
    string,
    {
      label: string;
      url: string;
      resolution: string;
    }
  >();
  for (const seed of seeds) {
    const anchor = framing.seeds[seed.id];
    if (anchor === undefined || !anchor.pattern.test(html)) {
      continue;
    }
    if (countPatternMatches(html, anchor.pattern) !== (anchor.occurrences ?? 1)) {
      throw new AdapterParseFailure(`Official Source discovery duplicates the ${seed.id} navigation link.`);
    }
    const resolvedUrl = adapterUrl(anchor.resolution, discoveryUrl).href;
    if (resolvedUrl !== adapterUrl(seed.url).href) {
      throw new AdapterParseFailure("Official Source discovery moved a required navigation URL.");
    }
    observedSeeds.set(seed.id, {
      label: seed.label,
      url: resolvedUrl,
      resolution: anchor.resolution,
    });
  }
  if (observedSeeds.size !== seeds.length) {
    throw new AdapterParseFailure("Official Source discovery navigation does not prove every required surface family.");
  }
  return seeds.map((seed) => {
    const observedSeed = observedSeeds.get(seed.id);
    if (observedSeed === undefined) {
      throw new AdapterParseFailure(`Official Source discovery did not retain the ${seed.id} navigation link.`);
    }
    return {
      id: `${sourceLineage}:discovery-seed:${seed.id}`,
      surface: `@seed:${seed.id}`,
      method: "GET" as const,
      url: observedSeed.url,
      headers: { accept: "text/html" as const },
      discovered_from: {
        kind: "publisher_navigation" as const,
        label: observedSeed.label,
        url: discoveryUrl,
        resolution: observedSeed.resolution,
      },
    };
  });
}

type ExactDiscoveryFraming = Readonly<{
  headerAttributes: string;
  container: RegExp;
  seeds: Readonly<
    Record<
      string,
      Readonly<{
        pattern: RegExp;
        resolution: string;
        occurrences?: number;
      }>
    >
  >;
}>;

function countPatternMatches(html: string, pattern: RegExp): number {
  return [...html.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))].length;
}

// The exact publisher navigation framing every live discovery root must
// retain: the publisher header grammar captured before the 2026-08 site
// restructure, patched with the restructured link resolutions below.
function exactPublisherDiscoveryFraming(sourceLineage: string): ExactDiscoveryFraming {
  return restructuredPublisherDiscoveryFraming(sourceLineage, publisherHeaderNavigationFraming(sourceLineage));
}

function publisherHeaderNavigationFraming(sourceLineage: string): ExactDiscoveryFraming {
  if (sourceLineage === "one-piece-en") {
    return {
      headerAttributes: 'class="headerCol js-header uniweb-translation-mask"',
      container:
        /<div class="headerColInner">[\s\S]*<div class="headerColInnerWrap">[\s\S]*<nav class="gnaviCol uniweb-translation-mask">/u,
      seeds: {
        cards: {
          pattern:
            /<li class="menuColListItem">\s*<a class="menuColListLink" href="\/cardlist\/">\s*<span class="menuColListLinkTit">FIND CARDS<\/span>\s*<\/a>\s*<\/li>/u,
          resolution: "/cardlist/",
        },
        products: {
          pattern:
            /<li class="menuColListItem">\s*<a class="menuColListLink" href="\/products\/">\s*<span class="menuColListLinkTit">ALL PRODUCTS<\/span>\s*<\/a>\s*<\/li>/u,
          resolution: "/products/",
        },
        rules: {
          pattern:
            /<li class="menuColListItem">\s*<a class="menuColListLink" href="\/rules\/">\s*<span class="menuColListLinkTit">RULES<\/span>\s*<span class="menuColListLinkTxt">Rules and important updates<\/span>\s*<\/a>\s*<\/li>/u,
          resolution: "/rules/",
        },
      },
    };
  }
  if (sourceLineage === "fusion-world-en") {
    return {
      headerAttributes: 'class="header js-header"',
      container:
        /<nav class="headerGnavCol">[\s\S]*<ul class="headerGnavList">[\s\S]*<div class="headerDropMenuListItemInner">/u,
      seeds: {
        cards: {
          pattern:
            /<li class="headerGnavListItem navLink">\s*<a href="\/fw\/en\/cardlist\/" class="js-headerGnavItem">CARDS<\/a>\s*<\/li>/u,
          resolution: "/fw/en/cardlist/",
        },
        products: {
          pattern:
            /<div class="headerDropMenuListBox">\s*<p class="largeMenu"><a href="\/fw\/en\/products\/">ALL Products<\/a><\/p>\s*<\/div>/u,
          resolution: "/fw/en/products/",
        },
        rules: {
          pattern:
            /<li class="headerGnavListItem navLink">\s*<a href="\/fw\/en\/news\/01_31\.html" class="js-headerGnavItem">RULES<\/a>\s*<\/li>/u,
          resolution: "/fw/en/news/01_31.html",
        },
      },
    };
  }
  if (sourceLineage === "digimon-en") {
    return {
      headerAttributes: 'class="header"',
      container:
        /<\/header>\s*<nav id="gnavi_sp" class="switch">\s*<div class="inner">[\s\S]*<ul class="gnavi_inner">/u,
      seeds: {
        cards: {
          pattern:
            /<li class="gnavi_cardlist current"><a href="\/cardlist\/">\s*<img src="\/images\/common\/gnavi\/gnavi_cardlist\.png\?v02" alt="CARD LIST"><\/a><\/li>/u,
          resolution: "/cardlist/",
        },
        products: {
          pattern:
            /<li class="gnavi_products "><a href="\/products\/"><img src="\/images\/common\/gnavi\/gnavi_products\.png" alt="PRODUCTS"><\/a><\/li>/u,
          resolution: "/products/",
        },
        rules: {
          pattern:
            /<li class="gnavi_rule "><a href="\/rule\/"><img src="\/images\/common\/gnavi\/gnavi_rule\.png\?v02" alt="RULES"><\/a><\/li>/u,
          resolution: "/rule/",
        },
      },
    };
  }
  const locale = sourceLineage === "gundam-en-asia" ? "asia-en" : "en";
  return {
    headerAttributes: 'class="header"',
    container:
      /<div class="headerWrapper">[\s\S]*<div id="js_headerGnav" class="headerNavWrapper">\s*<nav class="">\s*<ul class="headerGnavList">/u,
    seeds: {
      cards: {
        pattern: new RegExp(
          `<li class="menuColListItem">\\s*<a class="menuColListLink" href="/${locale}/cards/">\\s*<span class="menuColListLinkTit">FIND CARDS</span>\\s*</a>\\s*</li>`,
          "u",
        ),
        resolution: `/${locale}/cards/`,
      },
      products: {
        pattern: new RegExp(
          `<li class="menuColListItem">\\s*<a class="menuColListLink" href="/${locale}/products/list\\.php">\\s*<span class="menuColListLinkTit">PRODUCT LIST</span>\\s*</a>\\s*</li>`,
          "u",
        ),
        resolution: `/${locale}/products/list.php`,
      },
      rules: {
        pattern: new RegExp(`<li><a class="hoverText" href="/${locale}/rules/">RULES</a></li>`, "u"),
        resolution: `/${locale}/rules/`,
      },
      news: {
        pattern: new RegExp(`<li><a class="hoverText" href="/${locale}/news/">NEWS</a></li>`, "u"),
        resolution: `/${locale}/news/`,
      },
    },
  };
}

function restructuredPublisherDiscoveryFraming(
  sourceLineage: string,
  framing: ExactDiscoveryFraming,
): ExactDiscoveryFraming {
  const reseed = (
    id: string,
    patch: Readonly<{ resolution?: string; occurrences?: number }>,
  ): Readonly<
    Record<
      string,
      Readonly<{
        pattern: RegExp;
        resolution: string;
        occurrences?: number;
      }>
    >
  > => ({
    ...framing.seeds,
    [id]: { ...framing.seeds[id]!, ...patch },
  });
  if (sourceLineage === "one-piece-en") {
    // The live pages repeat the publisher navigation once in the header and
    // once in the footer; the cards link now resolves through the
    // publisher's series redirect.
    return {
      ...framing,
      seeds: Object.fromEntries(
        Object.entries(framing.seeds).map(([id, anchor]) => [
          id,
          {
            ...anchor,
            occurrences: 2,
            ...(id === "cards" ? { resolution: "/cardlist/?series=569116" } : {}),
          },
        ]),
      ),
    };
  }
  if (sourceLineage === "fusion-world-en") {
    return {
      ...framing,
      seeds: reseed("cards", {
        resolution: "/fw/en/cardlist/?search=true&category%5B0%5D=583301",
      }),
    };
  }
  if (sourceLineage === "digimon-en") {
    return {
      ...framing,
      seeds: reseed("cards", {
        resolution: "/cards/index.php?search=true",
      }),
    };
  }
  return framing;
}

function bandaiDiscoveryStageRecords(
  html: string,
  requestUrl: string,
  sourceLineage: string,
  discoveryKey: string,
  requiredSurfaces: readonly string[],
): Array<{
  id: string;
  surface: string;
  method: "GET";
  url: string;
  headers: { accept: "text/html" };
  discovered_from: {
    kind: "publisher_navigation" | "retained_stage_request";
    label: string;
    url: string;
    resolution: string;
  };
}> {
  const seed = bandaiDiscoverySeeds(sourceLineage).find(({ id }) => id === discoveryKey);
  if (seed === undefined) {
    throw new AdapterParseFailure(`Official Source discovery uses unknown stage vocabulary: ${discoveryKey}.`);
  }
  const current = adapterUrl(requestUrl);
  if (!officialUrl(sourceLineage, current, "document")) {
    throw new AdapterParseFailure("Official Source discovery stage is outside registered authority.");
  }
  const records = new Map<string, ReturnType<typeof stageRecord>>();
  for (const surface of Object.keys(seed.resolutions)) {
    if (!requiredSurfaces.includes(surface)) {
      throw new AdapterParseFailure(`Official Source discovery uses unknown required-surface vocabulary: ${surface}.`);
    }
    if (seed.resolutions[surface] === "") {
      assertDiscoveryStageSurface(html, discoveryKey, surface);
      records.set(
        surface,
        stageRecord(sourceLineage, surface, current.href, {
          kind: "retained_stage_request",
          label: discoveryKey,
          url: current.href,
          resolution: "",
        }),
      );
    }
  }
  const stageHtml = stripKnownPublisherNavigation(html, sourceLineage, current.href, "header-only");
  for (const match of stageHtml.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/giu)) {
    const href = htmlAttribute(match[1]!, "href");
    if (href === null) continue;
    const label = htmlText(match[2]!);
    let resolved: URL;
    try {
      resolved = adapterUrl(decodeHtmlText(href), current);
    } catch {
      continue;
    }
    resolved.hash = "";
    if (!officialUrl(sourceLineage, resolved, "document")) continue;
    // Each promised surface is pinned to the exact URL its seed resolution
    // names; label heuristics never create records.
    const surfaces = Object.entries(seed.resolutions)
      .filter(([, resolution]) => resolution !== "" && adapterUrl(resolution, seed.url).href === resolved.href)
      .map(([surface]) => surface);
    for (const surface of surfaces) {
      if (!requiredSurfaces.includes(surface)) continue;
      if (records.has(surface)) {
        // Live publisher pages repeat their navigation for desktop and
        // mobile; an identical repeated link is tolerated while a
        // conflicting one stays a hard failure.
        if (records.get(surface)!.url === resolved.href) {
          continue;
        }
        throw new AdapterParseFailure(`Official Source discovery duplicates the ${surface} surface link.`);
      }
      records.set(
        surface,
        stageRecord(sourceLineage, surface, resolved.href, {
          kind: "publisher_navigation",
          label: label.toLocaleLowerCase() || seed.label,
          url: current.href,
          resolution: decodeHtmlText(href),
        }),
      );
    }
  }
  // A catalogue-complete adapter that cannot prove one of its promised
  // surfaces would otherwise derive an empty Official Source Collection
  // Plan and fail much later at reconciliation; fail the parse instead.
  for (const surface of Object.keys(seed.resolutions)) {
    if (!records.has(surface)) {
      throw new AdapterParseFailure(
        `Official Source ${discoveryKey} discovery stage did not retain the ${surface} surface link.`,
      );
    }
  }
  return [...records.values()].sort(
    (left, right) => requiredSurfaces.indexOf(left.surface) - requiredSurfaces.indexOf(right.surface),
  );
}

function assertDiscoveryStageSurface(html: string, discoveryKey: string, surface: string): void {
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu);
  const signal = title === null ? "" : htmlText(title[1]!);
  const expected =
    discoveryKey === "cards"
      ? /\bcard(?:s| list| search)?\b/iu
      : discoveryKey === "products"
        ? /\bproduct(?:s| list)?\b/iu
        : discoveryKey === "rules"
          ? /\brules?\b/iu
          : /\bnews\b/iu;
  if (!expected.test(signal)) {
    throw new AdapterParseFailure(`Official Source ${surface} stage did not prove its publisher page identity.`);
  }
}

// The navigation seeds every live discovery root proves, with each promised
// surface pinned to its exact resolution: the publisher header grammar
// captured before the 2026-08 site restructure, patched with the live
// resolutions by restructuredDiscoverySeed.
function bandaiDiscoverySeeds(sourceLineage: string) {
  return publisherNavigationSeeds(sourceLineage)
    .map((seed) => restructuredDiscoverySeed(sourceLineage, seed))
    .filter((seed) => Object.keys(seed.resolutions).length > 0);
}

// The pre-restructure publisher navigation grammar. Live pages still link
// several of these URLs (the publisher redirects them), so the known
// navigation allowlist retains them beside the restructured resolutions.
function publisherNavigationSeeds(sourceLineage: string): ReadonlyArray<{
  id: string;
  label: string;
  url: string;
  resolutions: Readonly<Record<string, string>>;
}> {
  const seeds: Array<{
    id: string;
    label: string;
    url: string;
    resolutions: Readonly<Record<string, string>>;
  }> =
    sourceLineage === "one-piece-en"
      ? [
          {
            id: "cards",
            label: "find cards",
            url: "https://en.onepiece-cardgame.com/cardlist/",
            resolutions: { "card-list": "" },
          },
          {
            id: "products",
            label: "all products",
            url: "https://en.onepiece-cardgame.com/products/",
            resolutions: { products: "", releases: "" },
          },
          {
            id: "rules",
            label: "rules",
            url: "https://en.onepiece-cardgame.com/rules/",
            resolutions: {
              errata: "errata_card/",
            },
          },
        ]
      : sourceLineage === "fusion-world-en"
        ? [
            {
              id: "cards",
              label: "cards",
              url: "https://www.dbs-cardgame.com/fw/en/cardlist/",
              resolutions: { "card-search": "" },
            },
            {
              id: "products",
              label: "all products",
              url: "https://www.dbs-cardgame.com/fw/en/products/",
              resolutions: { products: "", releases: "" },
            },
            {
              id: "rules",
              label: "rules",
              url: "https://www.dbs-cardgame.com/fw/en/news/01_31.html",
              resolutions: {
                errata: "../rules/errata-card/",
              },
            },
          ]
        : sourceLineage === "digimon-en"
          ? [
              {
                id: "cards",
                label: "card list",
                url: "https://world.digimoncard.com/cardlist/",
                resolutions: { "card-list": "../cards/index.php?search=true" },
              },
              {
                id: "products",
                label: "products",
                url: "https://world.digimoncard.com/products/",
                resolutions: { products: "", releases: "" },
              },
              {
                id: "rules",
                label: "rules",
                url: "https://world.digimoncard.com/rule/",
                resolutions: {
                  errata: "errata_card/",
                },
              },
            ]
          : sourceLineage === "gundam-en-asia" || sourceLineage === "gundam-en-us"
            ? (() => {
                const locale = sourceLineage === "gundam-en-asia" ? "asia-en" : "en";
                const root = `https://www.gundam-gcg.com/${locale}/`;
                return [
                  {
                    id: "cards",
                    label: "find cards",
                    url: `${root}cards/`,
                    resolutions: { packages: "index.php" },
                  },
                  {
                    id: "products",
                    label: "product list",
                    url: `${root}products/list.php`,
                    resolutions: { products: "", releases: "" },
                  },
                  {
                    id: "rules",
                    label: "rules",
                    url: `${root}rules/`,
                    resolutions: {},
                  },
                  {
                    id: "news",
                    label: "news",
                    url: `${root}news/`,
                    resolutions: { errata: "?subcategory=rules" },
                  },
                ] as Array<{
                  id: string;
                  label: string;
                  url: string;
                  resolutions: Readonly<Record<string, string>>;
                }>;
              })()
            : [];
  if (seeds.length === 0) {
    throw new AdapterParseFailure(`Official Source discovery has no navigation grammar for ${sourceLineage}.`);
  }
  return seeds;
}

function restructuredDiscoverySeed(
  sourceLineage: string,
  seed: {
    id: string;
    label: string;
    url: string;
    resolutions: Readonly<Record<string, string>>;
  },
): {
  id: string;
  label: string;
  url: string;
  resolutions: Readonly<Record<string, string>>;
} {
  if (sourceLineage === "one-piece-en" && seed.id === "cards") {
    return {
      ...seed,
      url: "https://en.onepiece-cardgame.com/cardlist/?series=569116",
      resolutions: { "card-list": "" },
    };
  }
  if (sourceLineage === "one-piece-en" && seed.id === "rules") {
    return {
      ...seed,
      resolutions: {
        errata: "errata_card/",
      },
    };
  }
  if (sourceLineage === "fusion-world-en" && seed.id === "cards") {
    return {
      ...seed,
      url: "https://www.dbs-cardgame.com/fw/en/cardlist/?search=true&category%5B0%5D=583301",
      resolutions: { "card-search": "" },
    };
  }
  if (sourceLineage === "fusion-world-en" && seed.id === "rules") {
    const { errata: _droppedErrata, ...resolutions } = seed.resolutions;
    return { ...seed, resolutions };
  }
  if (sourceLineage === "digimon-en" && seed.id === "cards") {
    return {
      ...seed,
      url: "https://world.digimoncard.com/cards/index.php?search=true",
      resolutions: { "card-list": "" },
    };
  }
  if (sourceLineage.startsWith("gundam-") && seed.id === "cards") {
    // The live find-cards page is the card search itself; there is no
    // longer a separate index.php link to prove.
    return { ...seed, resolutions: { packages: "" } };
  }
  if (sourceLineage.startsWith("gundam-") && seed.id === "news") {
    return {
      ...seed,
      resolutions: { errata: "?subcategory=news&tag=all&page=1" },
    };
  }
  return seed;
}

function bandaiPublisherPayload(html: string, sourceLineage: string, surface: string): Record<string, unknown> | null {
  const expectedId = publisherPayloadScriptId(sourceLineage, surface);
  const matches = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)].filter(
    (match) => htmlAttribute(match[1]!, "id") === expectedId,
  );
  if (matches.length > 1) {
    throw new AdapterParseFailure(`Official Source ${surface} publisher data is duplicated.`);
  }
  const match = matches[0];
  if (match === undefined) return null;
  if (htmlAttribute(match[1]!, "type") !== "application/json") {
    throw new AdapterParseFailure(`Official Source ${surface} publisher data has the wrong media type.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(match[2]!);
  } catch {
    throw new AdapterParseFailure(`Official Source ${surface} publisher data is invalid JSON.`);
  }
  return requiredRecord(value, `Official Source ${surface} publisher data`);
}

function assertDigimonCatalogueFactsAtCompleteLeaf(
  html: string,
  sourceLineage: string,
  surface: string,
  requestUrl: string,
): void {
  const payload = bandaiPublisherPayload(html, sourceLineage, surface);
  if (payload !== null) assertDigimonPayloadAtCompleteLeaf(payload, requestUrl);
  if (digimonPopupRecordCount(html) > 0) {
    assertCompleteDigimonLeafUrl(requestUrl);
  }
}

function assertDigimonPayloadAtCompleteLeaf(payload: Record<string, unknown>, requestUrl: string): void {
  if (!digimonPayloadContainsCatalogueFacts(payload)) return;
  assertCompleteDigimonLeafUrl(requestUrl);
}

function assertCompleteDigimonLeafUrl(requestUrl: string): void {
  if (!isCompleteDigimonLeafUrl(requestUrl)) {
    throw new AdapterParseFailure(
      "Official Source Digimon catalogue facts require a complete Digimon leaf with exact category, cardcategory, and color facets.",
    );
  }
}

function isCompleteDigimonLeafUrl(requestUrl: string): boolean {
  const url = adapterUrl(requestUrl);
  const exactFacet = (name: string) =>
    url.searchParams.getAll(name).length === 1 && url.searchParams.get(name)?.trim() !== "";
  const exactColourFacet = Number(exactFacet("color")) + Number(exactFacet("colour")) === 1;
  return (
    url.pathname === "/cards/index.php" && exactFacet("category") && exactFacet("cardcategory") && exactColourFacet
  );
}

function digimonPopupRecordCount(html: string): number {
  return [...html.matchAll(/<li\b[^>]*\bclass=["'][^"']*\bimage_lists_item\b[^"']*\bdata\b[^"']*["'][^>]*>/giu)].length;
}

function digimonPayloadContainsCatalogueFacts(payload: Record<string, unknown>): boolean {
  const populated = (value: unknown) => Array.isArray(value) && value.length > 0;
  if (populated(payload.card_popups) || populated(payload.products) || populated(payload.release_calendar)) return true;
  if (payload.result === null || typeof payload.result !== "object") return false;
  const partitions = (payload.result as Record<string, unknown>).partitions;
  return (
    Array.isArray(partitions) &&
    partitions.some(
      (partition) =>
        partition !== null &&
        typeof partition === "object" &&
        populated((partition as Record<string, unknown>).entries),
    )
  );
}

function assertGundamPayloadAtCompleteLeaf(payload: Record<string, unknown>, requestUrl: string): void {
  if (!gundamPayloadContainsCatalogueFacts(payload)) return;
  if (!gundamCompleteListingLeaf(adapterUrl(requestUrl))) {
    throw new AdapterParseFailure(
      "Official Source Gundam catalogue facts require an exact package leaf with only an optional positive page.",
    );
  }
}

function gundamPayloadContainsCatalogueFacts(payload: Record<string, unknown>): boolean {
  const populated = (value: unknown) => Array.isArray(value) && value.length > 0;
  if (populated(payload.card_details) || populated(payload.products) || populated(payload.releases)) return true;
  if (payload.result === null || typeof payload.result !== "object") return false;
  const partitions = (payload.result as Record<string, unknown>).partitions;
  return (
    Array.isArray(partitions) &&
    partitions.some(
      (partition) =>
        partition !== null &&
        typeof partition === "object" &&
        populated((partition as Record<string, unknown>).entries),
    )
  );
}

function publisherPayloadScriptId(sourceLineage: string, surface: string): string {
  return `${publisherPayloadScriptPrefix(sourceLineage)}-${surface}-data`;
}

function publisherPayloadScriptPrefix(sourceLineage: string): string {
  const prefix =
    sourceLineage === "one-piece-en"
      ? "one-piece-card-game"
      : sourceLineage === "fusion-world-en"
        ? "fusion-world-card-game"
        : sourceLineage === "digimon-en"
          ? "digimon-card-game"
          : sourceLineage === "gundam-en-asia"
            ? "gundam-card-game-asia"
            : sourceLineage === "gundam-en-us"
              ? "gundam-card-game-us"
              : null;
  if (prefix === null) {
    throw new AdapterParseFailure(`Official Source publisher data has no grammar for ${sourceLineage}.`);
  }
  return prefix;
}

function surfaceFromContext(
  context: { url: string; requestId?: string },
  sourceLineage: string,
  requiredSurfaces: readonly string[],
  urls: Readonly<Record<string, string>>,
  gameParsers: GameParsers,
): string {
  const prefix = `${sourceLineage}:`;
  if (context.requestId?.startsWith(prefix)) {
    const surface = context.requestId.slice(prefix.length);
    if (
      requiredSurfaces.includes(surface) &&
      exactSurfaceDocumentUrl(sourceLineage, surface, context.url, gameParsers)
    ) {
      return surface;
    }
    throw new AdapterParseFailure(`Official Source Request identity does not match the ${sourceLineage} URL contract.`);
  }
  const matches = requiredSurfaces.filter(
    (surface) => adapterUrl(urls[surface]!).href === adapterUrl(context.url).href,
  );
  if (matches.length !== 1) {
    throw new AdapterParseFailure(`Official Source URL does not identify one exact ${sourceLineage} surface.`);
  }
  return matches[0]!;
}

function exactSurfaceDocumentUrl(
  sourceLineage: string,
  surface: string,
  requestUrl: string,
  gameParsers: GameParsers,
): boolean {
  const url = adapterUrl(requestUrl);
  if (!officialUrl(sourceLineage, url, "document")) return false;
  return gameParsers.surfaceUrl?.(surface, url) ?? true;
}

function decodeUtf8(bytes: Uint8Array, surface: string): string {
  try {
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes);
  } catch {
    throw new AdapterParseFailure(`Official Source ${surface} bytes are not valid UTF-8.`);
  }
}

function parseBandaiCardDetailV2(
  html: string,
  format: DiscoveryFormat,
  sourceLineage: string,
  requestUrl: string,
  preserveGundamVocabulary = false,
): CatalogueObservation {
  return parseBandaiCardDetailFrozenV1(html, format, sourceLineage, requestUrl, "path-v2", preserveGundamVocabulary);
}

function parseBandaiCardDetailFrozenV1(
  html: string,
  format: DiscoveryFormat,
  sourceLineage: string,
  requestUrl: string,
  imageAuthority: "hostname-v1" | "path-v2",
  preserveGundamVocabulary = false,
): CatalogueObservation {
  const pairs = htmlLabelPairs(html);
  const field = (names: readonly string[]): string | null => firstLabelValue(pairs, names);
  const pageText = htmlText(html);
  const cardNumber =
    field(["Card Number", "Card No.", "Card No", "No."]) ??
    pageText.match(/\b[A-Z]{1,6}\d{0,2}-\d{2,5}\b/u)?.[0] ??
    null;
  const name =
    field(["Card Name", "Name"]) ??
    htmlText(
      html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/iu)?.[1] ?? html.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/iu)?.[1] ?? "",
    );
  const cardType = field(["Card Type", "Type", "Category"]);
  const colour = field(["Color", "Colour"]);
  const rules = field(["Effect", "Skill", "Card Text", "Text"]);
  if (cardNumber === null || name.length === 0 || cardType === null || colour === null) {
    throw new AdapterParseFailure(`${sourceLineage} Card detail is missing Card Number, name, Card Type, or Color.`);
  }
  const discoveredImageUrls = [...html.matchAll(/<img\b([^>]*)>/giu)].flatMap((match) => {
    const attributes = match[1]!;
    const rawUrl = htmlAttribute(attributes, "data-src") ?? htmlAttribute(attributes, "src");
    if (rawUrl === null || !/\.(?:avif|gif|jpe?g|png|webp)(?:$|\?)/iu.test(rawUrl)) {
      return [];
    }
    const roleMarker = [
      htmlAttribute(attributes, "class"),
      htmlAttribute(attributes, "id"),
      htmlAttribute(attributes, "data-face"),
      htmlAttribute(attributes, "data-role"),
    ]
      .filter((value): value is string => value !== null)
      .join(" ");
    if (
      !/(?:card|face|front|back|image|pic)/iu.test(roleMarker) &&
      !rawUrl.toLocaleLowerCase().includes(cardNumber.toLocaleLowerCase())
    ) {
      return [];
    }
    const resolved = adapterUrl(decodeHtmlText(rawUrl), requestUrl).href;
    return (
      imageAuthority === "hostname-v1"
        ? officialHostname(sourceLineage, adapterUrl(resolved).hostname)
        : officialUrl(sourceLineage, adapterUrl(resolved), "image")
    )
      ? [resolved]
      : [];
  });
  if (discoveredImageUrls.length === 0) {
    throw new AdapterParseFailure(`${sourceLineage} Card detail has no Printing Image URL.`);
  }
  const requestedCardIdentity = [...adapterUrl(requestUrl).searchParams.entries()].find(([key]) =>
    /^(?:card(?:id|no|number)?|detailSearch|popup)$/iu.test(key),
  )?.[1];
  if (
    requestedCardIdentity !== undefined &&
    requestedCardIdentity.normalize("NFC").trim().toLocaleUpperCase() !==
      cardNumber.normalize("NFC").trim().toLocaleUpperCase()
  ) {
    throw new AdapterParseFailure(`${sourceLineage} requested Card identity does not match the parsed Card Number.`);
  }
  const locator =
    htmlAttribute(
      html.match(/<[^>]*\bdata-(?:card-id|popup-id|detail-search)=["'][^"']+["'][^>]*>/iu)?.[0] ?? "",
      "data-card-id",
    ) ??
    htmlAttribute(html.match(/<[^>]*\bdata-popup-id=["'][^"']+["'][^>]*>/iu)?.[0] ?? "", "data-popup-id") ??
    htmlAttribute(html.match(/<[^>]*\bdata-detail-search=["'][^"']+["'][^>]*>/iu)?.[0] ?? "", "data-detail-search") ??
    [...adapterUrl(requestUrl).searchParams.entries()].find(([key]) =>
      /^(?:card(?:id|no|number)?|detailSearch|id|popup)$/iu.test(key),
    )?.[1] ??
    cardNumber;
  const normalizedType = cardType.toLowerCase().replace(/\s+/gu, "_");
  const fusionFaces =
    format === "fusion-world" && normalizedType === "leader"
      ? explicitFusionLeaderFaces(html, requestUrl, sourceLineage, imageAuthority)
      : null;
  const imageEvidence =
    fusionFaces === null
      ? [
          {
            role: "front" as const,
            source_url: discoveredImageUrls[0]!,
          },
        ]
      : fusionFaces.map(({ role, imageUrl }) => ({
          role,
          source_url: imageUrl,
        }));
  const colours =
    colour === "-"
      ? format === "fusion-world" || (format === "gundam" && !preserveGundamVocabulary)
        ? ["colourless"]
        : []
      : colourValues(colour);
  const attributes =
    format === "one-piece"
      ? {
          card_type: normalizedType,
          colours,
          cost: integerOrNull(field(["Cost"])),
          life: normalizedType === "leader" ? integerOrNull(field(["Life"])) : null,
          battle_attributes: textValues(field(["Attribute"])),
          power: integerOrNull(field(["Power"])),
          counter: integerOrNull(field(["Counter"])),
          traits: textValues(field(["Type", "Traits"])),
          block_icons: textValues(field(["Block icon", "Block"])),
          effect_text: rules,
          trigger_text: field(["Trigger"]),
        }
      : format === "fusion-world"
        ? {
            card_type: normalizedType,
            colours,
            cost: integerOrNull(field(["Cost"])),
            specified_cost: specifiedCosts(field(["Specified Cost", "Specified cost"])),
            power: integerOrNull(field(["Power"])),
            combo_power: integerOrNull(field(["Combo Power"])),
            traits: textValues(field(["Special Trait", "Traits"])),
            skills: [...(rules === null ? [] : [{ kind: "ordinary", text: rules }])],
            ...(fusionFaces !== null
              ? {
                  leader_faces: fusionFaces.map((face) => ({
                    role: face.role,
                    name: face.name,
                    power: face.power,
                    traits: face.traits,
                    skills: face.skills,
                  })),
                }
              : {}),
          }
        : format === "digimon"
          ? {
              card_type: normalizedType,
              colours,
              level: integerOrNull(field(["Level", "Lv", "Lv."])),
              play_cost: integerOrNull(field(["Play Cost"])),
              use_cost: integerOrNull(field(["Use Cost"])),
              dp: integerOrNull(field(["DP"])),
              form: field(["Form"]),
              attribute: field(["Attribute"]),
              traits: textValues(field(["Type", "Traits"])),
              digivolution_requirements: digivolutionRequirements(
                allLabelValues(pairs, ["Digivolve", "Digivolution Cost", "Evolution Cost"]),
              ),
              text_sections: digimonTextSections(pairs),
              dual_colours: colourValues(field(["DUAL Color", "Dual Color"])),
              dual_cost: integerOrNull(field(["DUAL Cost", "Dual Cost"])),
              link_dp: integerOrNull(field(["[Link DP]", "Link DP"])),
            }
          : {
              card_type: normalizedType,
              colours,
              level: integerOrNull(field(["Level"])),
              cost: integerOrNull(field(["Cost"])),
              block_icon: field(["Block", "Block icon"]),
              effect_text: rules,
              zone: field(["Zone"]),
              traits: textValues(field(["Trait", "Traits"])),
              link_condition: field(["Link"]),
              ap: integerOrNull(field(["AP"])),
              hp: integerOrNull(field(["HP"])),
              series_titles: textValues(field(["Title", "Series"])),
            };
  const alternateArtworkValue =
    format === "digimon"
      ? field(["Alternative Art"])
      : format === "gundam"
        ? field(["Alternate Art", "Alternative Art"])
        : null;
  const alternateArtwork =
    format === "digimon"
      ? officialBoolean(alternateArtworkValue, "Digimon Alternative Art")
      : format === "gundam"
        ? officialBoolean(alternateArtworkValue, "Gundam Alternate Art")
        : null;
  const artworkId =
    htmlAttribute(html.match(/<[^>]*\bdata-artwork-id=["'][^"']+["'][^>]*>/iu)?.[0] ?? "", "data-artwork-id") ??
    field(["Artwork ID", "Artwork Identifier", "Illustration ID"]);
  const artworkFingerprint = officialArtworkFingerprint(
    cardNumber,
    imageEvidence.map(({ role }) => role),
    artworkId,
  );
  const productLinks = productLinksFromHtml(html, requestUrl);
  const products = productLinks.products;
  const distribution =
    products.length === 0
      ? {
          code: `detail:${adapterUrl(requestUrl).pathname}`,
          kind: "source_bucket",
          label: field(["Where to get it", "Card Set(s)"]) ?? "Card detail",
        }
      : {
          code: `product:${products[0]!.code}`,
          kind: "product",
          label: products[0]!.title,
          product_reference: {
            kind: "official_code",
            value: products[0]!.code,
          },
        };
  const detail = {
    path: locator,
    number: cardNumber,
    title: name,
    rules,
    profile: `${format}@1`,
    attributes,
    product_codes: products.map(({ code }) => code),
    fuzzy_product_labels: productLinks.fuzzyLabels,
    distribution,
    printing: {
      rarity: field(["Rarity"]),
      normalizedRarity:
        format === "gundam" && preserveGundamVocabulary
          ? normalizedGundamRarity(field(["Rarity"]))
          : (field(["Rarity"])?.toLowerCase() ?? null),
      attributes:
        format === "digimon"
          ? {
              alternative_art: alternateArtwork,
            }
          : format === "gundam"
            ? {
                alternate_art: alternateArtwork,
              }
            : format === "one-piece"
              ? { illustration_types: [] }
              : {},
    },
    treatment: alternateArtworkValue === null ? null : alternateArtwork ? "alternate" : "standard",
    printed_rules: rules,
    variant: locator === cardNumber ? "base" : locator.slice(cardNumber.length) || locator,
    artwork_fingerprint: artworkFingerprint,
    printed_fields_digest: `printed-material:${JSON.stringify(stableValue({ rules, attributes }))}`,
    image: imageEvidence[0]!.source_url,
    images: imageEvidence.map(({ role, source_url }) => ({
      role,
      source_url,
      artwork_fingerprint: artworkFingerprint,
    })),
  };
  const observation = cardObservation(
    detail,
    products,
    new Map(),
    { revision: "captured-by-policy-surface", entries: [] },
    format === "one-piece"
      ? "one-piece"
      : format === "fusion-world"
        ? "fusion-world"
        : format === "digimon"
          ? "digimon"
          : "gundam",
  );
  const knownLabels = [
    "Card Number",
    "Card No.",
    "Card No",
    "No.",
    "Card Name",
    "Name",
    "Card Type",
    "Type",
    "Category",
    "Color",
    "Colour",
    "Effect",
    "Skill",
    "Card Text",
    "Text",
    "Cost",
    "Life",
    "Attribute",
    "Power",
    "Counter",
    "Traits",
    "Block icon",
    "Block",
    "Trigger",
    "Specified Cost",
    "Specified cost",
    "Combo Power",
    "Special Trait",
    "Level",
    "Play Cost",
    "Use Cost",
    "DP",
    "Form",
    "Digivolve",
    "Digivolution Cost",
    "Evolution Cost",
    "Inherited Effect",
    "Security Effect",
    "DUAL Color",
    "Dual Color",
    "DUAL Cost",
    "Dual Cost",
    "[DUAL Effect]",
    "[DUAL Rule]",
    "[Link Condition]",
    "[Link DP]",
    "Link DP",
    "[Link Effect]",
    "[Special Digivolution Condition]",
    "Alternative Art",
    "Alternate Art",
    "Artwork ID",
    "Artwork Identifier",
    "Illustration ID",
    "Zone",
    "Trait",
    "Link",
    "AP",
    "HP",
    "Title",
    "Series",
    "Rarity",
    "Where to get it",
    "Card Set(s)",
  ];
  return attachRawSurfaceEvidenceV1(
    observation,
    sourceLineage,
    "card-detail",
    Object.fromEntries(pairs.map(({ label, value }) => [label, value])),
    true,
    knownLabels,
  );
}

function explicitFusionLeaderFaces(
  html: string,
  requestUrl: string,
  sourceLineage: string,
  imageAuthority: "hostname-v1" | "path-v2",
): {
  role: "front" | "back";
  name: string;
  power: number | null;
  traits: string[];
  skills: string;
  imageUrl: string;
}[] {
  const faces = [
    ...html.matchAll(/<(section|div)\b([^>]*\bdata-face=["'](front|back)["'][^>]*)>([\s\S]*?)<\/\1>/giu),
  ].map((match) => {
    const role = match[3]!.toLowerCase() as "front" | "back";
    const body = match[4]!;
    const pairs = htmlLabelPairs(body);
    const imageMatches = [
      ...body.matchAll(/<img\b[^>]*\b(?:data-src|src)=["']([^"']+\.(?:avif|gif|jpe?g|png|webp)(?:\?[^"']*)?)["']/giu),
    ]
      .map((image) => adapterUrl(decodeHtmlText(image[1]!), requestUrl).href)
      .filter((url) =>
        imageAuthority === "hostname-v1"
          ? officialHostname(sourceLineage, adapterUrl(url).hostname)
          : officialUrl(sourceLineage, adapterUrl(url), "image"),
      );
    if (imageMatches.length !== 1) {
      throw new AdapterParseFailure(`Fusion World Leader ${role} face requires exactly one role-specific image.`);
    }
    const faceName =
      firstLabelValue(pairs, ["Name", "Card Name"]) ??
      htmlText(body.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/iu)?.[1] ?? "");
    if (faceName.length === 0) {
      throw new AdapterParseFailure(`Fusion World Leader ${role} face name is missing.`);
    }
    return {
      role,
      name: faceName,
      power: integerOrNull(firstLabelValue(pairs, ["Power"])),
      traits: textValues(firstLabelValue(pairs, ["Special Trait", "Traits"])),
      skills: firstLabelValue(pairs, ["Skill", "Effect", "Card Text"]) ?? "",
      imageUrl: imageMatches[0]!,
    };
  });
  if (
    faces.length !== 2 ||
    faces.filter(({ role }) => role === "front").length !== 1 ||
    faces.filter(({ role }) => role === "back").length !== 1
  ) {
    throw new AdapterParseFailure("Fusion World Leader requires explicit front and back face containers.");
  }
  return faces.sort((left, right) => (left.role === "front" ? 0 : 1) - (right.role === "front" ? 0 : 1));
}

function allLabelValues(pairs: readonly { label: string; value: string }[], names: readonly string[]): string[] {
  return pairs
    .filter(({ label }) => names.some((name) => label.localeCompare(name, undefined, { sensitivity: "accent" }) === 0))
    .map(({ value }) => value)
    .filter((value) => value.length > 0 && value !== "-");
}

function parseBandaiSurfaceCoverageV2(
  html: string,
  format: DiscoveryFormat,
  sourceLineage: string,
  surface: string,
  url: string,
  acceptPublisherDeclaredEmpty: boolean,
  catalogueComplete = false,
  liveShapes = false,
  gameParsers: GameParsers,
): ParsedBandaiSurface {
  return parseBandaiSurfaceCoverageByContract(
    html,
    format,
    sourceLineage,
    surface,
    url,
    acceptPublisherDeclaredEmpty,
    catalogueComplete,
    liveShapes,
    gameParsers,
  );
}

function completeGundamListingCoverage(
  listing: {
    declaredTotal: number;
    fullLocators: string[];
    selectedPackage: string | null;
    selectedPage: number;
    terminalPage: boolean;
  },
  sourceLineage: string,
  surface: string,
  url: string,
): ParsedBandaiSurface {
  return {
    observations: [
      {
        completeness:
          listing.terminalPage && listing.fullLocators.length === listing.declaredTotal
            ? completeObservation(listing.declaredTotal, listing.fullLocators.length)
            : {
                structurally_complete: true,
                required_surfaces_complete: false,
                partitions_complete: false,
                declared_record_count: listing.declaredTotal,
                parsed_record_count: listing.fullLocators.length,
              },
        product_release_catalogue: {
          products: [],
          distribution_contexts: [],
          relationships: [],
        },
      },
    ],
    retainedDocument: {
      source_lineage: sourceLineage,
      surface,
      url,
      selected_package: listing.selectedPackage,
      selected_page: listing.selectedPage,
      declared_total: listing.declaredTotal,
      full_locators: listing.fullLocators,
      terminal_page: listing.terminalPage,
    },
    consumedFields: [
      "source_lineage",
      "surface",
      "url",
      "selected_package",
      "selected_page",
      "declared_total",
      "full_locators",
      "terminal_page",
    ],
  };
}

function parseBandaiSurfaceCoverageByContract(
  html: string,
  format: DiscoveryFormat,
  sourceLineage: string,
  surface: string,
  url: string,
  acceptPublisherDeclaredEmpty: boolean,
  catalogueComplete: boolean,
  liveShapes = false,
  gameParsers: GameParsers,
): ParsedBandaiSurface {
  const text = htmlText(html);
  const restructuredFusionLeafSurface =
    catalogueComplete &&
    format === "fusion-world" &&
    (surface === "listing" || surface === "card-search") &&
    fusionWorldRestructuredListingLeaf(adapterUrl(url));
  if (
    catalogueComplete &&
    format === "fusion-world" &&
    surface === "card-search" &&
    fusionPublisherCategoryOptions(html).length === 0
  ) {
    throw new AdapterParseFailure("Official Source Fusion World card search enumerates no categories.");
  }
  const fusionListingEntries =
    catalogueComplete && format === "fusion-world" && (surface === "listing" || restructuredFusionLeafSurface)
      ? fusionWorldHtmlListingEntries(html, url, sourceLineage)
      : [];
  if (
    surface === "listing" &&
    /(?:too many search results|more than 1,?000|results? (?:were )?capped)/iu.test(text) &&
    discoveredPartitionRequests(format, html, adapterUrl(url), false, catalogueComplete, gameParsers).length === 0
  ) {
    throw new AdapterParseFailure("Official Source leaf partition still displays its result-cap signal.");
  }
  const surfacePublicationPattern =
    surface === "products" || surface === "releases"
      ? /(PRODUCT|RELEASE)/iu
      : surface === "errata"
        ? /ERRATA/iu
        : isDiscoverySurface(surface) || surface === "listing"
          ? /CARD/iu
          : /(RULE|RESTRICTION|BANNED|LIMITED|BLOCK)/iu;
  if (
    text.length < 20 ||
    !/(BANDAI|ONE PIECE|DRAGON BALL|DIGIMON|GUNDAM)/iu.test(text) ||
    !surfacePublicationPattern.test(text)
  ) {
    throw new AdapterParseFailure(`Official Source ${surface} HTML does not contain its expected Bandai publication.`);
  }
  const publicationLinks = [...html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu)]
    .map((match) => ({
      url: adapterUrl(decodeHtmlText(match[1]!), url).href,
      label: htmlText(match[2]!),
    }))
    .filter(({ label }) => label.length > 0);
  const discoveredOptions = [...html.matchAll(/<option\b[^>]*\bvalue=["']([^"']*)["'][^>]*>([\s\S]*?)<\/option>/giu)]
    .map((match) => ({
      value: decodeHtmlText(match[1]!),
      label: htmlText(match[2]!),
    }))
    .filter(({ value, label }) => value.length > 0 || label.length > 0);
  const publicationEntryMatches = [...html.matchAll(/<(article|li|tr)\b([^>]*)>([\s\S]*?)<\/\1>/giu)];
  const completeFusionListingLeaf = restructuredFusionLeafSurface;
  const fusionListingDeclaredCount =
    catalogueComplete && format === "fusion-world" && (surface === "listing" || restructuredFusionLeafSurface)
      ? visibleFusionPublisherCount(html)
      : null;
  const declaredCount =
    fusionListingDeclaredCount ?? html.match(/>\s*(\d+)\s+(?:results?|records?|items?)\s*</iu)?.[1] ?? null;
  if (completeFusionListingLeaf && fusionListingDeclaredCount === null) {
    throw new AdapterParseFailure("Fusion World complete listing leaf must contain one exact publisher total.");
  }
  if (
    catalogueComplete &&
    format === "fusion-world" &&
    surface === "listing" &&
    declaredCount !== null &&
    Number.parseInt(declaredCount, 10) !== fusionListingEntries.length
  ) {
    throw new AdapterParseFailure(
      `Fusion World listing declared ${declaredCount} Cards but yielded ${fusionListingEntries.length} unique full locators.`,
    );
  }
  const fusionComingSoonDeclaresEmpty =
    catalogueComplete &&
    format === "fusion-world" &&
    surface === "products" &&
    adapterUrl(url).searchParams.get("status") === "coming-soon" &&
    declaredCount === "0";
  const fusionListingDeclaresEmpty = completeFusionListingLeaf && fusionListingDeclaredCount === "0";
  const publisherDeclaresEmpty =
    (acceptPublisherDeclaredEmpty || fusionComingSoonDeclaresEmpty || fusionListingDeclaresEmpty) &&
    declaredCount === "0";
  const publicationEntries = publicationEntryMatches
    .filter((match) => !publisherDeclaresEmpty || htmlAttribute(match[2]!, "data-publication-empty") !== "true")
    .map((match) => htmlText(match[3]!))
    .filter((entry) => entry.length > 0);
  if (
    fusionListingEntries.length === 0 &&
    publicationLinks.length === 0 &&
    discoveredOptions.length === 0 &&
    publicationEntries.length === 0 &&
    !publisherDeclaresEmpty
  ) {
    throw new AdapterParseFailure(`Official Source ${surface} has no structural publication entries.`);
  }
  const fusionLiveProductSurface =
    liveShapes && catalogueComplete && format === "fusion-world" && (surface === "products" || surface === "releases");
  if (catalogueComplete && format === "fusion-world" && surface === "products") {
    gameParsers.validateProductCoverage!(html);
  }
  const labelPairs = htmlLabelPairs(html);
  const parsedPublicationCount = completeFusionListingLeaf
    ? fusionListingEntries.length
    : publicationEntries.length > 0
      ? publicationEntries.length
      : publicationLinks.length > 0
        ? publicationLinks.length
        : discoveredOptions.length;
  const declaredPublicationCount = Number.parseInt(declaredCount ?? String(parsedPublicationCount), 10);
  const productIndexObservations = fusionLiveProductSurface
    ? gameParsers.productIndex!(html, sourceLineage, url)
    : surface === "products" || surface === "releases"
      ? parseBandaiProductIndex(html, url)
      : [];
  return {
    observations:
      fusionListingEntries.length > 0
        ? fusionListingEntries.map(({ locator, canonical }) => ({
            completeness: completeObservation(),
            listing_identity_evidence: { locator, canonical },
            product_release_catalogue: {
              products: [],
              distribution_contexts: [],
              relationships: [],
            },
          }))
        : productIndexObservations.length > 0
          ? productIndexObservations
          : [
              {
                completeness: completeObservation(declaredPublicationCount, parsedPublicationCount),
                product_release_catalogue: {
                  products: [],
                  distribution_contexts: [],
                  relationships: [],
                },
              },
            ],
    retainedDocument: {
      source_lineage: sourceLineage,
      surface,
      url,
      document_title: htmlText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu)?.[1] ?? text.slice(0, 200)),
      publication_links: publicationLinks,
      discovered_options: discoveredOptions,
      publication_entries: publicationEntries,
      ...(fusionListingEntries.length === 0 ? {} : { listing_identity_evidence: fusionListingEntries }),
      ...(labelPairs.length === 0
        ? {}
        : {
            label_values: Object.fromEntries(labelPairs.map(({ label, value }) => [label, value])),
          }),
    },
    consumedFields: [
      "source_lineage",
      "surface",
      "url",
      "document_title",
      "publication_links",
      "discovered_options",
      "publication_entries",
      ...(fusionListingEntries.length === 0 ? [] : ["listing_identity_evidence"]),
    ],
  };
}

function officialBoolean(value: string | null, field: string): boolean {
  if (value === null) return false;
  const normalized = value.normalize("NFC").trim().toLocaleLowerCase();
  if (["yes", "true", "alternative art", "alternate art"].includes(normalized)) {
    return true;
  }
  if (["no", "false", "standard", "base", "-"].includes(normalized)) {
    return false;
  }
  throw new AdapterParseFailure(`Unrecognized official ${field} value: ${value}`);
}

function specifiedCosts(value: string | null): { colour: string; count: number }[] {
  if (value === null || value === "-" || value.trim() === "") return [];
  return value.split(/[,/]/u).map((part) => {
    const text = part.normalize("NFC").trim();
    const colour = text.match(/\b(red|blue|green|yellow|black)\b/iu)?.[1]?.toLocaleLowerCase();
    const count = text.match(/\b(\d+)\b/u)?.[1];
    if (colour === undefined || count === undefined || Number(count) < 1) {
      throw new AdapterParseFailure(`Unrecognized official Fusion World specified cost: ${text}`);
    }
    return { colour, count: Number.parseInt(count, 10) };
  });
}

function normalizedSurfaceObservationsV2(
  format: DiscoveryFormat,
  game: ProductSourceGame,
  sourceLineage: string,
  surface: string,
  rawDocument: Record<string, unknown>,
  expandedOnePieceCatalogue = false,
  catalogueComplete = false,
  normalizeSurface: SurfaceNormalizer,
  gameParsers: GameParsers,
): OfficialSourceObservation[] {
  const normalized = normalizeLineageSurface(sourceLineage, surface, rawDocument, normalizeSurface, gameParsers);
  const document = normalized.document;
  let observations: readonly OfficialSourceObservation[];
  if (isDiscoverySurface(surface)) {
    observations = parseRawDiscoverySurfaceV2(document, format, game, expandedOnePieceCatalogue, catalogueComplete);
  } else if (surface === "products") {
    observations = parseRawProductsSurfaceV2(document);
  } else if (surface === "releases") {
    observations = parseRawReleasesSurfaceV2(document);
  } else {
    observations = [
      rawCoverageObservationV2(document, surface),
      ...gameParsers.structuredObservations(surface, document, sourceLineage),
    ];
  }
  return observations.map((observation, index) => {
    const record = observation;
    return "kind" in record && record.kind === "official_erratum"
      ? record
      : attachRawSurfaceEvidenceV1(
          record,
          sourceLineage,
          surface,
          rawDocument,
          index === 0,
          normalized.consumedFields,
          normalized.unmappedOptionalFields,
        );
  });
}

function normalizeLineageSurface(
  sourceLineage: string,
  surface: string,
  raw: Record<string, unknown>,
  normalizeSurface: SurfaceNormalizer,
  gameParsers: GameParsers,
): {
  document: Record<string, unknown>;
  consumedFields: readonly string[];
  unmappedOptionalFields: readonly { path: string; value: unknown }[];
} {
  const normalized = normalizeSurface(sourceLineage, surface, raw);
  return {
    document: {
      contract: "card-keepr-official-source-surface@1",
      lineage: sourceLineage,
      surface,
      ...normalized.value,
    },
    consumedFields: normalized.consumedFields,
    unmappedOptionalFields: gameParsers.unmappedFields?.(surface, raw) ?? [],
  };
}

function parseRawDiscoverySurfaceFrozenV1(
  surface: Record<string, unknown>,
  format: DiscoveryFormat,
  game: ProductSourceGame,
): CatalogueObservation[] {
  return parseRawDiscoverySurfaceByContract(surface, format, game, false);
}

function parseRawDiscoverySurfaceCompleteOnePieceV3(
  surface: Record<string, unknown>,
  format: DiscoveryFormat,
  game: ProductSourceGame,
): CatalogueObservation[] {
  return parseRawDiscoverySurfaceByContract(surface, format, game, true);
}

function parseRawDiscoverySurfaceByContract(
  surface: Record<string, unknown>,
  format: DiscoveryFormat,
  game: ProductSourceGame,
  expandedOnePieceCatalogue: boolean,
): CatalogueObservation[] {
  const sourceBuckets = uniqueTextValues(surface.source_buckets, "Official Source discovery buckets");
  if (sourceBuckets.length === 0) {
    throw new AdapterParseFailure("Official Source discovery buckets are incomplete.");
  }
  const facets = requiredArray(surface.facets, "Official Source discovery facets");
  if (facets.length === 0) {
    throw new AdapterParseFailure("Official Source discovery facets are incomplete.");
  }
  const entries =
    expandedOnePieceCatalogue && format === "one-piece"
      ? completeCompatibleOnePiecePartitionEntries(surface.partitions)
      : completePartitionEntriesFrozenV1(surface.partitions);
  const recordingMemberships =
    expandedOnePieceCatalogue && format === "one-piece" ? onePieceRecordingMemberships(surface.partitions) : null;
  const details = requiredArray(surface.details, "Official Source Card details");
  const products = requiredArray(surface.products, "Official Source referenced Products");
  const productRecords = products.map((value) => requiredRecord(value, "Official Source referenced Product"));
  const cardProducts = productRecords.filter((product) => productNonCardClassification(product) === null);
  const nonCardProducts = productRecords.filter((product) => productNonCardClassification(product) !== null);
  const releases = requiredArray(surface.releases, "Official Source referenced Releases");
  const keys = surfaceKeys[format];
  return [
    ...parseOfficialDiscoveryFrozenV1(
      {
        [keys.listing]: {
          page: 1,
          pages: 1,
          total: entries.length,
          has_next: false,
          entries,
        },
        [keys.details]: details,
        [keys.products]: cardProducts,
        [keys.releases]: releases,
        [keys.errata]: {
          revision: "captured-by-required-policy-surfaces",
          entries: [],
        },
      },
      keys,
      game,
    ),
    ...nonCardProducts.map((product) => nonCardProductObservation(product, productNonCardClassification(product)!)),
  ].map((observation) => {
    const record = observation;
    const memberships =
      record.memberships === undefined
        ? {
            products: [],
            distribution_contexts: [],
            source_buckets: [],
          }
        : record.memberships;
    const identityEvidence = isPlainRecord(record.identity_evidence) ? record.identity_evidence : null;
    const locator = typeof identityEvidence?.locator === "string" ? identityEvidence.locator : null;
    const recordingSourceBuckets = locator === null ? null : (recordingMemberships?.get(locator) ?? null);
    return {
      ...record,
      memberships: {
        ...memberships,
        source_buckets: expandedOnePieceCatalogue ? (recordingSourceBuckets ?? sourceBuckets) : sourceBuckets,
      },
    };
  });
}

function parseRawProductsSurfaceFrozenV1(surface: Record<string, unknown>): CatalogueObservation[] {
  const products = completePartitionEntriesFrozenV1(surface.partitions).map((value) =>
    requiredRecord(value, "Official Source Product"),
  );
  const releasesByCode = new Map<string, Record<string, unknown>[]>();
  const policy = {
    revision: "captured-by-required-policy-surfaces",
    entries: [],
  };
  return products.map((product) => {
    const classification = productNonCardClassification(product);
    return classification === null
      ? productOnlyObservation(product, releasesByCode, policy)
      : nonCardProductObservation(product, classification);
  });
}

function parseRawReleasesSurfaceFrozenV1(surface: Record<string, unknown>): CatalogueObservation[] {
  const entries = completePartitionEntriesFrozenV1(surface.partitions).map((value) =>
    requiredRecord(value, "Official Source Release entry"),
  );
  const products = new Map<string, Record<string, unknown>>();
  const releases = new Map<string, Record<string, unknown>[]>();
  const nonCardProducts = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    const product = requiredRecord(entry.product, "Official Source Release Product");
    const code = nullableText(product.code, "Official Release Product code");
    const release = requiredRecord(entry.release, "Official Source Release value");
    if (nullableText(release.code, "Official Release code") !== code) {
      throw new AdapterParseFailure("Official Source Release Product binding is inconsistent.");
    }
    const key = productMapKey(product);
    if (productNonCardClassification(product) !== null) {
      nonCardProducts.set(key, product);
      continue;
    }
    products.set(key, product);
    releases.set(key, [...(releases.get(key) ?? []), release]);
  }
  const policy = {
    revision: "captured-by-required-policy-surfaces",
    entries: [],
  };
  return [
    ...[...products.entries()].map(([key, product]) =>
      productOnlyObservation(product, new Map([[key, releases.get(key) ?? []]]), policy),
    ),
    ...[...nonCardProducts.values()].map((product) =>
      nonCardProductObservation(product, productNonCardClassification(product)!),
    ),
  ];
}

function parseRawDiscoverySurfaceV2(
  surface: Record<string, unknown>,
  format: DiscoveryFormat,
  game: ProductSourceGame,
  expandedOnePieceCatalogue = false,
  catalogueComplete = false,
): CatalogueObservation[] {
  if (expandedOnePieceCatalogue && format === "one-piece") {
    return parseRawDiscoverySurfaceCompleteOnePieceV3(surface, format, game);
  }
  if (catalogueComplete && format === "fusion-world") {
    const entries = completePartitionEntriesCatalogueV3(surface.partitions, fusionWorldFullLocatorIdentity);
    return parseRawDiscoverySurfaceFrozenV1(
      {
        ...surface,
        partitions: [
          {
            bucket: "fusion-world-full-locator-deduplication",
            page: 1,
            pages: 1,
            total: entries.length,
            has_next: false,
            entries,
          },
        ],
      },
      format,
      game,
    );
  }
  if (catalogueComplete && format === "gundam") {
    const entries = completePartitionEntriesCatalogueV3(surface.partitions, gundamFullLocatorIdentity);
    return parseRawDiscoverySurfaceFrozenV1(
      {
        ...surface,
        partitions: [
          {
            bucket: "gundam-full-locator-deduplication",
            page: 1,
            pages: 1,
            total: entries.length,
            has_next: false,
            entries,
          },
        ],
      },
      format,
      game,
    );
  }
  return parseRawDiscoverySurfaceFrozenV1(surface, format, game);
}

function parseRawProductsSurfaceV2(surface: Record<string, unknown>): CatalogueObservation[] {
  return parseRawProductsSurfaceFrozenV1(surface);
}

function parseRawReleasesSurfaceV2(surface: Record<string, unknown>): CatalogueObservation[] {
  return parseRawReleasesSurfaceFrozenV1(surface);
}

function rawCoverageObservationV2(surface: Record<string, unknown>, name: string): CatalogueObservation {
  return rawCoverageObservationFrozenV1(surface, name);
}

function rawCoverageObservationFrozenV1(surface: Record<string, unknown>, name: string): CatalogueObservation {
  requiredText(surface.revision, `Official Source ${name} revision`);
  requiredArray(surface.entries, `Official Source ${name} entries`);
  return {
    completeness: completeObservation(),
    product_release_catalogue: {
      products: [],
      distribution_contexts: [],
      relationships: [],
    },
  };
}

type PartitionEntryIdentityStrategy = {
  label: string;
  identity(entry: unknown, canonical: string): string;
};

const fusionWorldFullLocatorIdentity: PartitionEntryIdentityStrategy = {
  label: "full locator",
  identity: (entry) =>
    requiredText(requiredRecord(entry, "Fusion World partition entry").detail, "Fusion World full locator"),
};

const gundamFullLocatorIdentity: PartitionEntryIdentityStrategy = {
  label: "full locator",
  identity: (entry) => requiredText(requiredRecord(entry, "Gundam partition entry").detail, "Gundam full locator"),
};

function completePartitionEntriesCatalogueV3(
  value: unknown,
  identityStrategy: PartitionEntryIdentityStrategy,
): unknown[] {
  const pages = requiredArray(value, "Official Source discovery partitions").map((item) =>
    requiredRecord(item, "Official Source discovery partition page"),
  );
  if (pages.length === 0) {
    throw new AdapterParseFailure("Official Source discovery partitions are incomplete.");
  }
  const byBucket = new Map<string, Record<string, unknown>[]>();
  for (const page of pages) {
    if (Object.hasOwn(page, "result_cap")) {
      throw new AdapterParseFailure("Official Source partition result-cap evidence does not prove complete coverage.");
    }
    const bucket = requiredText(page.bucket, "Official Source partition bucket");
    byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), page]);
  }
  const allEntries: unknown[] = [];
  const claimedEntries = new Map<string, { bucket: string; canonical: string }>();
  for (const [bucket, bucketPages] of byBucket) {
    bucketPages.sort(
      (left, right) =>
        requiredPositiveInteger(left.page, "Official Source page") -
        requiredPositiveInteger(right.page, "Official Source page"),
    );
    const pageCount = requiredPositiveInteger(bucketPages[0]!.pages, "Official Source page count");
    if (
      bucketPages.length !== pageCount ||
      bucketPages.some(
        (page, index) =>
          page.bucket !== bucket ||
          page.page !== index + 1 ||
          page.pages !== pageCount ||
          page.has_next !== index + 1 < pageCount,
      )
    ) {
      throw new AdapterParseFailure("Official Source pagination evidence does not prove complete partitions.");
    }
    const entries = bucketPages.flatMap((page) => requiredArray(page.entries, "Official Source partition entries"));
    const declaredTotal = requiredNonNegativeInteger(bucketPages[0]!.total, "Official Source partition total");
    if (entries.length !== declaredTotal || bucketPages.some((page) => page.total !== declaredTotal)) {
      throw new AdapterParseFailure("Official Source count evidence does not prove complete partitions.");
    }
    for (const entry of entries) {
      const canonical = JSON.stringify(stableValue(entry));
      const identity = identityStrategy.identity(entry, canonical);
      const prior = claimedEntries.get(identity);
      if (prior !== undefined) {
        if (prior.canonical !== canonical) {
          const location =
            prior.bucket === bucket
              ? `within leaf partition ${bucket}`
              : `between leaf partitions ${prior.bucket} and ${bucket}`;
          throw new AdapterParseFailure(`Official Source ${identityStrategy.label} ${identity} conflicts ${location}.`);
        }
        continue;
      }
      claimedEntries.set(identity, { bucket, canonical });
      allEntries.push(entry);
    }
  }
  return allEntries;
}

function completePartitionEntriesFrozenV1(value: unknown): unknown[] {
  return completePartitionEntriesByContract(value, false);
}

function completeCompatibleOnePiecePartitionEntries(value: unknown): unknown[] {
  return completePartitionEntriesByContract(value, true);
}

function completePartitionEntriesByContract(value: unknown, allowCompatibleOverlap: boolean): unknown[] {
  const pages = requiredArray(value, "Official Source discovery partitions").map((item) =>
    requiredRecord(item, "Official Source discovery partition page"),
  );
  if (pages.length === 0) {
    throw new AdapterParseFailure("Official Source discovery partitions are incomplete.");
  }
  const byBucket = new Map<string, Record<string, unknown>[]>();
  for (const page of pages) {
    if (Object.hasOwn(page, "result_cap")) {
      throw new AdapterParseFailure("Official Source partition result-cap evidence does not prove complete coverage.");
    }
    const bucket = requiredText(page.bucket, "Official Source partition bucket");
    byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), page]);
  }
  const allEntries: unknown[] = [];
  const claimedEntries = new Map<string, string>();
  for (const [bucket, bucketPages] of byBucket) {
    bucketPages.sort(
      (left, right) =>
        requiredPositiveInteger(left.page, "Official Source page") -
        requiredPositiveInteger(right.page, "Official Source page"),
    );
    const pageCount = requiredPositiveInteger(bucketPages[0]!.pages, "Official Source page count");
    if (
      bucketPages.length !== pageCount ||
      bucketPages.some(
        (page, index) =>
          page.bucket !== bucket ||
          page.page !== index + 1 ||
          page.pages !== pageCount ||
          page.has_next !== index + 1 < pageCount,
      )
    ) {
      throw new AdapterParseFailure("Official Source pagination evidence does not prove complete partitions.");
    }
    const entries = bucketPages.flatMap((page) => requiredArray(page.entries, "Official Source partition entries"));
    const declaredTotal = requiredNonNegativeInteger(bucketPages[0]!.total, "Official Source partition total");
    if (entries.length !== declaredTotal || bucketPages.some((page) => page.total !== declaredTotal)) {
      throw new AdapterParseFailure("Official Source count evidence does not prove complete partitions.");
    }
    for (const entry of entries) {
      const identity = JSON.stringify(stableValue(entry));
      const priorBucket = claimedEntries.get(identity);
      if (priorBucket !== undefined && priorBucket !== bucket) {
        if (!allowCompatibleOverlap) {
          throw new AdapterParseFailure(
            `Official Source leaf partitions overlap between ${priorBucket} and ${bucket}.`,
          );
        }
        continue;
      }
      claimedEntries.set(identity, bucket);
      allEntries.push(entry);
    }
  }
  return allEntries;
}

function isDiscoverySurface(surface: string): boolean {
  return surface === "card-list" || surface === "card-search" || surface === "packages";
}

function requiredPositiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new AdapterParseFailure(`${name} is invalid.`);
  }
  return Number(value);
}

const surfaceKeys = {
  "one-piece": {
    listing: "card_list",
    details: "card_pages",
    products: "product_catalog",
    releases: "release_schedule",
    errata: "correction_notices",
  },
  "fusion-world": {
    listing: "search",
    details: "detail_pages",
    products: "products",
    releases: "releases",
    errata: "errata_notices",
  },
  digimon: {
    listing: "card_index",
    details: "card_details",
    products: "product_index",
    releases: "release_calendar",
    errata: "errata_notices",
  },
  gundam: {
    listing: "card_search",
    details: "card_details",
    products: "product_list",
    releases: "release_list",
    errata: "errata",
  },
} as const;

function parseOfficialDiscoveryFrozenV1(
  document: unknown,
  keys: (typeof surfaceKeys)[DiscoveryFormat],
  game: ProductSourceGame,
): CatalogueObservation[] {
  const root = requiredRecord(document, "Official discovery document");
  const listing = requiredRecord(root[keys.listing], `Official ${keys.listing}`);
  const details = requiredArray(root[keys.details], `Official ${keys.details}`).map((value) =>
    requiredRecord(value, "Official Card detail"),
  );
  const products = requiredArray(root[keys.products], `Official ${keys.products}`).map((value) =>
    requiredRecord(value, "Official Product"),
  );
  const releases = requiredArray(root[keys.releases], `Official ${keys.releases}`).map((value) =>
    requiredRecord(value, "Official Release"),
  );
  const errata = requiredSurface(root[keys.errata], keys.errata);
  const entries = requiredArray(listing.entries, "Official listing entries").map((value) =>
    requiredRecord(value, "Official listing entry"),
  );

  if (
    listing.page !== 1 ||
    listing.pages !== 1 ||
    listing.has_next !== false ||
    listing.total !== entries.length ||
    Object.hasOwn(listing, "result_cap")
  ) {
    throw new AdapterParseFailure("Official listing pagination/count/cap evidence does not prove complete coverage.");
  }
  if (details.length !== entries.length) {
    throw new AdapterParseFailure("Official listing/detail partitions do not prove complete coverage.");
  }
  const detailPaths = uniqueRequiredText(details, "path", "Card detail path");
  const listingPaths = uniqueRequiredText(entries, "detail", "listing detail path");
  if (
    detailPaths.length !== listingPaths.length ||
    detailPaths.some((path, index) => path !== [...listingPaths].sort()[index])
  ) {
    throw new AdapterParseFailure("Official listing/detail discovery surfaces are incomplete or overlap.");
  }
  const productsByReference = new Map(products.map((product) => [productMapKey(product), product]));
  if (productsByReference.size !== products.length) {
    throw new AdapterParseFailure("Official Product partitions overlap.");
  }
  const releasesByReference = new Map<string, Record<string, unknown>[]>();
  for (const release of releases) {
    const code = nullableText(release.code, "Official Release Product code");
    const title =
      release.product_title === undefined ? null : nullableText(release.product_title, "Official Release Product name");
    const key = code === null ? (title === null ? null : productMapKey({ code: null, title })) : code;
    if (key === null || !productsByReference.has(key)) {
      throw new AdapterParseFailure("Official Release references an undiscovered Product.");
    }
    releasesByReference.set(key, [...(releasesByReference.get(key) ?? []), release]);
  }

  const observedProductReferences = new Set<string>();
  const observations: CatalogueObservation[] = details.map((detail) => {
    const productCodes = requiredTextArray(detail.product_codes, "Official Card Product codes");
    const productReferences = [
      ...productCodes,
      ...(detail.product_names === undefined
        ? []
        : requiredTextArray(detail.product_names, "Official Card Product names").map((title) =>
            productMapKey({ code: null, title }),
          )),
    ];
    productReferences.forEach((reference) => {
      if (!productsByReference.has(reference)) {
        throw new AdapterParseFailure("Official Card detail references an undiscovered Product.");
      }
      observedProductReferences.add(reference);
    });
    return cardObservation(
      detail,
      productReferences.map((reference) => productsByReference.get(reference)!),
      releasesByReference,
      errata,
      game,
    );
  });
  observations.push(
    ...products
      .filter((product) => !observedProductReferences.has(productMapKey(product)))
      .map((product) => productOnlyObservation(product, releasesByReference, errata)),
  );
  return observations;
}

function productNonCardClassification(product: Record<string, unknown>): "accessory" | null {
  return nonCardProductClassification(
    JSON.stringify({
      code: product.code ?? null,
      title: product.title ?? null,
      distribution: product.distribution ?? null,
      raw: product,
    }),
  );
}

function nonCardProductObservation(
  product: Record<string, unknown>,
  classification: "accessory",
): CatalogueObservation {
  const policy = {
    revision: "captured-by-required-policy-surfaces",
    entries: [],
  };
  return {
    completeness: completeObservation(),
    product_release_catalogue: {
      products: [],
      distribution_contexts: [
        {
          key: `non-card:${classification}:${productMapKey(product).normalize("NFC").trim().toLocaleLowerCase()}`,
          kind: "other",
          label: classification,
          evidence_category: "explicit",
        },
      ],
      relationships: [],
    },
    source_sidecar: sourceSidecar(null, [product], policy),
  };
}

function requiredSurface(value: unknown, name: string) {
  const surface = requiredRecord(value, `Official ${name}`);
  requiredText(surface.revision, `Official ${name} revision`);
  requiredArray(surface.entries, `Official ${name} entries`);
  return surface;
}

function uniqueRequiredText(values: Record<string, unknown>[], field: string, name: string): string[] {
  const result = values.map((value) => requiredText(value[field], name)).sort();
  if (new Set(result).size !== result.length) {
    throw new AdapterParseFailure(`Official ${name} values overlap.`);
  }
  return result;
}
