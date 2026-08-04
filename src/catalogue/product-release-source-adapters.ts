import {
  officialReleaseDateNeedsSchemaReview,
  officialReleaseStatusNeedsSchemaReview,
  normalizedOfficialReleaseDate,
  normalizedOfficialReleaseStatus,
} from "./official-source-release-normalization.mjs";
import {
  partitionMappedOfficialLeaves,
} from "./official-source-field-coverage.mjs";
import {
  officialArtworkFingerprint,
} from "./official-artwork-identity.mjs";
import {
  officialLiveLegalityRulesObservation,
  officialLegalityRulesHtmlObservation,
  officialLegalityRulesObservation,
} from "./official-legality-source-adapters.mjs";
import { liveOfficialLegalityDocument } from "./official-legality-live-html.mjs";
import {
  normalizeOnePieceCardPage,
  normalizedOnePieceRarity,
  onePieceDonCardObservation,
  onePieceRecordingMemberships,
} from "./one-piece-source-adapter.mjs";

type ProductSourceGame =
  | "one-piece"
  | "fusion-world"
  | "digimon"
  | "gundam";

type DiscoveryFormat =
  | "one-piece"
  | "fusion-world"
  | "digimon"
  | "gundam";

export type OfficialRawAdapterContract = {
  adapterVersion: string;
  parserContract: string;
  sourceLineage: string;
  supportedGame: ProductSourceGame;
  format: DiscoveryFormat;
  requiredSurfaces: readonly string[];
  sourceOrigin: string;
  documentPathnamePrefixes: readonly string[];
  imagePathnamePrefixes: readonly string[];
  partition: "EN-OCEANIA" | "EN-ASIA" | "EN-US";
  requestUrlForDiscovery?: () => string;
  requestUrlForSurface: (surface: string) => string;
  parseBytes: (
    bytes: Uint8Array,
    context: { mediaType: string | null; url: string; requestId?: string },
  ) => readonly unknown[];
  discoverRequests: (
    bytes: Uint8Array,
    context: { mediaType: string | null; url: string; requestId?: string },
  ) => readonly {
    role: "listing" | "detail" | "product_detail" | "image";
    discoveryKey?: string;
    url: string;
    headers: Record<string, string>;
  }[];
};

const rawContractDefinitions = [
  {
    adapterVersion: "one-piece-en@1",
    sourceLineage: "one-piece-en",
    supportedGame: "one-piece",
    format: "one-piece",
    sourceOrigin: "https://en.onepiece-cardgame.com",
    documentPathnamePrefixes: ["/cardlist/", "/products/", "/rules/"],
    imagePathnamePrefixes: ["/images/"],
    partition: "EN-OCEANIA",
    requiredSurfaces: [
      "card-list",
      "products",
      "releases",
      "restrictions",
      "block-policy",
      "errata",
      "don-rules",
    ],
    urls: {
      "card-list": "https://en.onepiece-cardgame.com/cardlist/",
      products: "https://en.onepiece-cardgame.com/products/",
      releases: "https://en.onepiece-cardgame.com/products/",
      restrictions:
        "https://en.onepiece-cardgame.com/rules/restriction/",
      "block-policy":
        "https://en.onepiece-cardgame.com/rules/block_icon/",
      errata: "https://en.onepiece-cardgame.com/rules/errata_card/",
      "don-rules": "https://en.onepiece-cardgame.com/rules/",
    },
  },
  {
    adapterVersion: "fusion-world-en@2",
    sourceLineage: "fusion-world-en",
    supportedGame: "fusion-world",
    format: "fusion-world",
    sourceOrigin: "https://www.dbs-cardgame.com",
    documentPathnamePrefixes: ["/fw/en/"],
    imagePathnamePrefixes: ["/fw/images/"],
    partition: "EN-OCEANIA",
    requiredSurfaces: [
      "card-search",
      "products",
      "releases",
      "legality-current",
      "legality-history",
      "errata",
    ],
    urls: {
      "card-search": "https://www.dbs-cardgame.com/fw/en/cardlist/",
      products: "https://www.dbs-cardgame.com/fw/en/products/",
      releases: "https://www.dbs-cardgame.com/fw/en/products/",
      "legality-current":
        "https://www.dbs-cardgame.com/fw/en/rules/banned-limited-cards/",
      "legality-history":
        "https://www.dbs-cardgame.com/fw/en/rules/banned-limited-cards/",
      errata: "https://www.dbs-cardgame.com/fw/en/rules/errata-card/",
    },
  },
  {
    adapterVersion: "digimon-en@2",
    sourceLineage: "digimon-en",
    supportedGame: "digimon",
    format: "digimon",
    sourceOrigin: "https://world.digimoncard.com",
    documentPathnamePrefixes: ["/cards/", "/cardlist/", "/products/", "/rule/"],
    imagePathnamePrefixes: ["/images/"],
    partition: "EN-OCEANIA",
    requiredSurfaces: [
      "card-list",
      "products",
      "releases",
      "restrictions-current",
      "restrictions-history",
      "errata",
    ],
    urls: {
      "card-list":
        "https://world.digimoncard.com/cards/index.php?search=true",
      products: "https://world.digimoncard.com/products/",
      releases: "https://world.digimoncard.com/products/",
      "restrictions-current":
        "https://world.digimoncard.com/rule/restriction_card/",
      "restrictions-history":
        "https://world.digimoncard.com/rule/restriction_card/",
      errata: "https://world.digimoncard.com/rule/errata_card/",
    },
  },
  {
    adapterVersion: "gundam-en-asia@2",
    sourceLineage: "gundam-en-asia",
    supportedGame: "gundam",
    format: "gundam",
    sourceOrigin: "https://www.gundam-gcg.com",
    documentPathnamePrefixes: ["/asia-en/"],
    imagePathnamePrefixes: ["/asia-en/"],
    partition: "EN-ASIA",
    requiredSurfaces: [
      "packages",
      "products",
      "releases",
      "legality",
      "errata",
    ],
    urls: {
      packages: "https://www.gundam-gcg.com/asia-en/cards/index.php",
      products: "https://www.gundam-gcg.com/asia-en/products/list.php",
      releases: "https://www.gundam-gcg.com/asia-en/products/list.php",
      legality: "https://www.gundam-gcg.com/asia-en/rules/",
      errata:
        "https://www.gundam-gcg.com/asia-en/news/?subcategory=rules",
    },
  },
  {
    adapterVersion: "gundam-en-us@2",
    sourceLineage: "gundam-en-us",
    supportedGame: "gundam",
    format: "gundam",
    sourceOrigin: "https://www.gundam-gcg.com",
    documentPathnamePrefixes: ["/en/"],
    imagePathnamePrefixes: ["/en/"],
    partition: "EN-US",
    requiredSurfaces: [
      "packages",
      "products",
      "releases",
      "legality",
      "errata",
    ],
    urls: {
      packages: "https://www.gundam-gcg.com/en/cards/index.php",
      products: "https://www.gundam-gcg.com/en/products/list.php",
      releases: "https://www.gundam-gcg.com/en/products/list.php",
      legality: "https://www.gundam-gcg.com/en/rules/",
      errata: "https://www.gundam-gcg.com/en/news/?subcategory=rules",
    },
  },
] as const;

const legalityAwareAdapterVersions: Readonly<
  Record<(typeof rawContractDefinitions)[number]["sourceLineage"], string>
> = {
  "one-piece-en": "one-piece-en@2",
  "fusion-world-en": "fusion-world-en@3",
  "digimon-en": "digimon-en@3",
  "gundam-en-asia": "gundam-en-asia@3",
  "gundam-en-us": "gundam-en-us@3",
};

const completeDigimonAdapterVersion = "digimon-en@4";

export const officialRawAdapterContracts: readonly OfficialRawAdapterContract[] =
  Object.freeze(
    rawContractDefinitions.flatMap((definition) => {
      const versions = [
        {
          ...definition,
          parserContract: `${definition.sourceLineage}-raw-surfaces@1`,
          legalityAware: false,
          expandedOnePieceCatalogue: false,
          catalogueComplete: false,
          completeDigimonCatalogue: false,
        },
        {
          ...definition,
          adapterVersion:
            legalityAwareAdapterVersions[definition.sourceLineage],
          urls: activeBandaiSurfaceUrls(
            definition.sourceLineage,
            definition.urls,
          ),
          parserContract:
            `${definition.sourceLineage}-raw-surfaces-with-legality@2`,
          legalityAware: true,
          expandedOnePieceCatalogue: false,
          catalogueComplete: false,
          completeDigimonCatalogue: false,
        },
        ...(definition.sourceLineage === "one-piece-en"
          ? [{
              ...definition,
              adapterVersion: "one-piece-en@3",
              parserContract: "one-piece-en-complete-catalogue@3",
              legalityAware: true,
              expandedOnePieceCatalogue: true,
              catalogueComplete: false,
              completeDigimonCatalogue: false,
            }]
          : []),
        ...(definition.sourceLineage === "fusion-world-en"
          ? [{
              ...definition,
              adapterVersion: "fusion-world-en@4",
              urls: activeBandaiSurfaceUrls(
                definition.sourceLineage,
                definition.urls,
              ),
              parserContract:
                "fusion-world-en-raw-surfaces-with-legality-and-catalogue@3",
              legalityAware: true,
              expandedOnePieceCatalogue: false,
              catalogueComplete: true,
              completeDigimonCatalogue: false,
            }]
          : []),
        ...(definition.sourceLineage === "digimon-en"
          ? [{
              ...definition,
              adapterVersion: completeDigimonAdapterVersion,
              urls: activeBandaiSurfaceUrls(
                definition.sourceLineage,
                definition.urls,
              ),
              parserContract:
                "digimon-en-raw-surfaces-complete-catalogue@3",
              legalityAware: true,
              expandedOnePieceCatalogue: false,
              catalogueComplete: false,
              completeDigimonCatalogue: true,
            }]
          : []),
      ];
      return versions.map((version) =>
        Object.freeze({
          ...version,
          requiredSurfaces: Object.freeze([...version.requiredSurfaces]),
          requestUrlForSurface: (surface: string) =>
            exactSurfaceUrl(
              version.sourceLineage,
              version.requiredSurfaces,
              version.urls,
              surface,
            ),
          requestUrlForDiscovery: version.legalityAware
            ? () => exactSurfaceUrl(
                version.sourceLineage,
                version.requiredSurfaces,
                version.urls,
                version.requiredSurfaces[0]!,
              )
            : undefined,
          parseBytes: version.legalityAware
            ? legalityAwareBandaiSnapshotDecoder(
                version.format,
                version.supportedGame,
                version.sourceLineage,
                version.requiredSurfaces,
                version.urls,
                version.expandedOnePieceCatalogue,
                version.catalogueComplete,
                version.completeDigimonCatalogue,
              )
            : historicalBandaiSnapshotDecoderV1(
                version.format,
                version.supportedGame,
                version.sourceLineage,
                version.requiredSurfaces,
                version.urls,
              ),
          discoverRequests: version.legalityAware
            ? bandaiRequestDiscovery(
              version.format,
              version.sourceLineage,
              version.requiredSurfaces,
              version.urls,
              version.expandedOnePieceCatalogue,
              version.catalogueComplete,
              version.completeDigimonCatalogue,
            )
            : historicalBandaiRequestDiscoveryV1(
              version.format,
              version.sourceLineage,
              version.requiredSurfaces,
              version.urls,
            ),
        })
      );
    }),
  );

export function officialSourceDiscoveryRequests(
  sourceLineage: string,
): readonly {
  id: string;
  method: "GET";
  url: string;
  headers: Record<string, string>;
}[] {
  const contract = officialRawAdapterContracts.filter(
    (candidate) => candidate.sourceLineage === sourceLineage,
  ).at(-1);
  if (contract === undefined) {
    throw new Error("Official Source lineage has no discovery contract.");
  }
  if (contract.requestUrlForDiscovery === undefined) {
    throw new Error("Official Source lineage has no active discovery root.");
  }
  return [{
    id: `${sourceLineage}:discovery`,
    method: "GET",
    url: contract.requestUrlForDiscovery(),
    headers: { accept: "text/html" },
  }];
}

function historicalBandaiRequestDiscoveryV1(
  format: DiscoveryFormat,
  sourceLineage: string,
  requiredSurfaces: readonly string[],
  urls: Readonly<Record<string, string>>,
): OfficialRawAdapterContract["discoverRequests"] {
  return (bytes, context) => {
    if (context.requestId?.includes(":image:")) return [];
    const mediaType = context.mediaType?.split(";", 1)[0]?.trim()
      .toLowerCase();
    if (mediaType !== "text/html") return [];
    const html = decodeUtf8(bytes, "historical request discovery V1");
    const dynamicRole = dynamicRequestRole(context.requestId);
    const initialSurface = dynamicRole === null
      ? historicalSurfaceFromContextV1(
        context,
        sourceLineage,
        requiredSurfaces,
        urls,
      )
      : null;
    const discoveryHtml = stripKnownPublisherNavigation(
      html,
      sourceLineage,
      context.url,
    );
    const current = new URL(context.url);
    const candidates: Array<{
      role: "listing" | "detail" | "product_detail" | "image";
      url: string;
      headers: Record<string, string>;
    }> = [];
    if (initialSurface !== null) {
      const structured = bandaiPublisherPayload(
        discoveryHtml,
        sourceLineage,
        initialSurface,
      );
      if (structured !== null) {
        candidates.push(
          ...historicalStructuredImageUrlsV1(
            structured,
            current,
            sourceLineage,
          ).map((url) => ({
            role: "image" as const,
            url,
            headers: historicalDiscoveredRequestHeadersV1("image"),
          })),
        );
      }
    }
    if (
      (initialSurface !== null && isDiscoverySurface(initialSurface)) ||
      dynamicRole === "listing"
    ) {
      candidates.push(
        ...historicalPartitionRequestsV1(format, discoveryHtml, current).map((url) => ({
          role: "listing" as const,
          url,
          headers: historicalDiscoveredRequestHeadersV1("listing"),
        })),
      );
    }
    for (const match of discoveryHtml.matchAll(
      /<(a|img|source)\b([^>]*?)>/giu,
    )) {
      const tag = match[1]!.toLowerCase();
      const attributes = match[2]!;
      const rawUrl = tag === "a"
        ? htmlAttribute(attributes, "href")
        : htmlAttribute(attributes, "data-src") ??
          htmlAttribute(attributes, "src");
      if (
        rawUrl === null || rawUrl.startsWith("#") ||
        /^(?:data|javascript|mailto|tel):/iu.test(rawUrl)
      ) continue;
      let resolved: URL;
      try {
        resolved = new URL(decodeHtmlText(rawUrl), current);
      } catch {
        continue;
      }
      resolved.hash = "";
      if (resolved.protocol !== "https:" || resolved.href === current.href) {
        continue;
      }
      const role = tag === "img" || tag === "source" ||
          /\.(?:avif|gif|jpe?g|png|webp)(?:$|\?)/iu.test(resolved.href)
        ? "image"
        : historicalDiscoveredHtmlRoleV1(format, initialSurface, resolved);
      if (
        role === null ||
        !historicalOfficialUrlV1(sourceLineage, resolved, role === "image")
      ) continue;
      candidates.push({
        role,
        url: resolved.href,
        headers: historicalDiscoveredRequestHeadersV1(role),
      });
    }
    return [...new Map(candidates.map((candidate) => [
      `${candidate.role}:${candidate.url}`,
      candidate,
    ])).values()].sort((left, right) =>
      `${left.role}:${left.url}`.localeCompare(`${right.role}:${right.url}`)
    );
  };
}

function historicalDiscoveredRequestHeadersV1(
  role: "listing" | "detail" | "product_detail" | "image",
): Record<string, string> {
  return {
    accept: role === "image"
      ? "image/avif,image/webp,image/png,image/jpeg,image/gif"
      : "text/html",
    "user-agent": `card-keepr-official-source/1; request-role=${role}`,
  };
}

function historicalStructuredImageUrlsV1(
  value: unknown,
  base: URL,
  sourceLineage: string,
): string[] {
  const discovered: string[] = [];
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      if (/\.(?:avif|gif|jpe?g|png|webp)(?:$|\?)/iu.test(item)) {
        const url = new URL(item, base);
        if (
          url.protocol === "https:" &&
          historicalOfficialUrlV1(sourceLineage, url, true)
        ) {
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

function historicalPartitionRequestsV1(
  format: DiscoveryFormat,
  html: string,
  current: URL,
): string[] {
  const facets = [...html.matchAll(
    /<select\b([^>]*)>([\s\S]*?)<\/select>/giu,
  )].flatMap((match) => {
    const key = htmlAttribute(match[1]!, "name") ??
      htmlAttribute(match[1]!, "id");
    if (key === null) return [];
    const options = [...match[2]!.matchAll(
      /<option\b[^>]*\bvalue=["']([^"']+)["'][^>]*>/giu,
    )].map((option) => decodeHtmlText(option[1]!).trim())
      .filter((value) => value.length > 0 && !/^(?:all|0|-)$/iu.test(value));
    return options.length === 0
      ? []
      : [{ key: key.toLowerCase(), options: [...new Set(options)].sort() }];
  });
  const hierarchy = format === "one-piece"
    ? [["recording"]]
    : format === "fusion-world"
      ? [["card_type"], ["colour", "color"], ["cost"]]
      : format === "digimon"
        ? [["category"], ["cardcategory", "card_type"], ["colour", "color"]]
        : [["package"]];
  const facet = hierarchy.flatMap((aliases) =>
    facets.filter(({ key }) =>
      aliases.includes(key) && !aliases.some((name) =>
        current.searchParams.has(name)
      )
    )
  )[0];
  if (facet === undefined) return [];
  return facet.options
    .filter((value) => format !== "one-piece" || /^\d+$/u.test(value))
    .map((value) => {
      const url = new URL(current);
      url.searchParams.set(facet.key, value);
      return url.href;
    });
}

function historicalDiscoveredHtmlRoleV1(
  format: DiscoveryFormat,
  initialSurface: string | null,
  url: URL,
): "listing" | "detail" | "product_detail" | null {
  const target = `${url.pathname}${url.search}`;
  if (
    format === "gundam" && initialSurface === "legality" &&
    /\/(?:asia-en|en)\/news\/01_279\.html$/u.test(url.pathname)
  ) return "detail";
  if (initialSurface === "legality") return null;
  if (
    initialSurface === "products" || initialSurface === "releases" ||
    /\/products?\//iu.test(target)
  ) {
    if (nonCardProductClassification(target) !== null) return null;
    return /(?:detail|products?\/[^/?]+|products?\.php\?.*\bid=)/iu.test(target)
      ? "product_detail"
      : /(?:page|paged|offset)=\d+/iu.test(target) ? "listing" : null;
  }
  if (
    /(?:detailSearch|card[_-]?(?:detail|id)|popup)=/iu.test(target) ||
    /\/cards?\/[^/?]+|\/cardlist\/card\//iu.test(target)
  ) return "detail";
  return /(?:page|paged|offset)=\d+/iu.test(target) ||
      (format === "fusion-world" && /(?:card_type|colour|color|cost)=/iu.test(target)) ||
      (format === "digimon" && /(?:category|cardcategory|colour|color|version)=/iu.test(target)) ||
      (format === "gundam" && /(?:package|page)=/iu.test(target))
    ? "listing"
    : null;
}

function historicalOfficialUrlV1(
  sourceLineage: string,
  url: URL,
  image: boolean,
): boolean {
  const origin = sourceLineage === "one-piece-en"
    ? "https://en.onepiece-cardgame.com"
    : sourceLineage === "fusion-world-en"
      ? "https://www.dbs-cardgame.com"
      : sourceLineage === "digimon-en"
        ? "https://world.digimoncard.com"
        : "https://www.gundam-gcg.com";
  const prefixes = image
    ? sourceLineage === "fusion-world-en"
      ? ["/fw/images/"]
      : sourceLineage === "gundam-en-asia"
        ? ["/asia-en/"]
        : sourceLineage === "gundam-en-us" ? ["/en/"] : ["/images/"]
    : sourceLineage === "one-piece-en"
      ? ["/cardlist/", "/products/", "/rules/"]
      : sourceLineage === "fusion-world-en"
        ? ["/fw/en/"]
        : sourceLineage === "digimon-en"
          ? ["/cards/", "/cardlist/", "/products/", "/rule/"]
          : sourceLineage === "gundam-en-asia" ? ["/asia-en/"] : ["/en/"];
  return url.origin === origin && prefixes.some((prefix) =>
    url.pathname.startsWith(prefix)
  ) && url.username === "" && url.password === "" && url.hash === "";
}

function bandaiRequestDiscovery(
  format: DiscoveryFormat,
  sourceLineage: string,
  requiredSurfaces: readonly string[],
  urls: Readonly<Record<string, string>>,
  expandedOnePieceCatalogue = false,
  catalogueComplete = false,
  completeDigimonCatalogue = false,
): OfficialRawAdapterContract["discoverRequests"] {
  return (bytes, context) => {
    if (context.requestId?.includes(":image:")) return [];
    const mediaType = context.mediaType?.split(";", 1)[0]?.trim()
      .toLowerCase();
    if (mediaType !== "text/html") return [];
    const html = decodeUtf8(bytes, "request discovery");
    if (context.requestId === `${sourceLineage}:discovery`) {
      return bandaiDiscoveryRecords(
        html,
        sourceLineage,
        requiredSurfaces,
        urls,
      ).map((record) => ({
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
    const discoveryHtml = stripKnownPublisherNavigation(
      html,
      sourceLineage,
      context.url,
    );
    const initialSurface = dynamicRole === null
      ? surfaceFromContext(
          context,
          sourceLineage,
          requiredSurfaces,
          urls,
        )
      : null;
    const current = new URL(context.url);
    if (
      catalogueComplete &&
      format === "fusion-world" &&
      current.origin === new URL(urls["card-search"]!).origin &&
      current.pathname === new URL(urls["card-search"]!).pathname
    ) {
      const partitions = discoveredPartitionRequests(
        format,
        discoveryHtml,
        current,
        expandedOnePieceCatalogue,
        catalogueComplete,
      ).map((url) => ({
        role: "listing" as const,
        url,
        headers: officialDiscoveredRequestHeaders("listing"),
      }));
      if (!fusionWorldCompleteListingLeaf(current)) return partitions;
      fusionWorldHtmlListingEntries(discoveryHtml, context.url, sourceLineage);
      return [...new Map(
        [...discoveryHtml.matchAll(/<a\b([^>]*)>/giu)].flatMap((match) => {
          const anchor = fusionWorldListingAnchor(
            match[1]!,
            context.url,
            sourceLineage,
          );
          return anchor === null
            ? []
            : [[anchor.url.href, {
                role: "detail" as const,
                url: anchor.url.href,
                headers: officialDiscoveredRequestHeaders("detail"),
              }] as const];
        }),
      ).values()].sort((left, right) => left.url.localeCompare(right.url));
    }
    const structuredSurface = dynamicStructuredSurface(
      dynamicRole,
      initialSurface,
      requiredSurfaces,
      completeDigimonCatalogue,
    );
    const candidates: {
      role: "listing" | "detail" | "product_detail" | "image";
      url: string;
      headers: Record<string, string>;
    }[] = [];
    if (structuredSurface !== null) {
      const structured = bandaiPublisherPayload(
        discoveryHtml,
        sourceLineage,
        structuredSurface,
      );
      if (structured !== null) {
        candidates.push(
          ...structuredImageUrls(structured, current, sourceLineage).map(
            (url) => ({
              role: "image" as const,
              url,
              headers: officialDiscoveredRequestHeaders("image"),
            }),
          ),
        );
      }
    }
    if (
      (initialSurface !== null && isDiscoverySurface(initialSurface)) ||
      dynamicRole === "listing"
    ) {
      candidates.push(
        ...discoveredPartitionRequests(
          format,
          discoveryHtml,
          current,
          expandedOnePieceCatalogue,
          catalogueComplete,
        ).map(
          (url) => ({
            role: "listing" as const,
            url,
            headers: officialDiscoveredRequestHeaders("listing"),
          }),
        ),
      );
    }
    for (const match of discoveryHtml.matchAll(
      /<(a|img|source)\b([^>]*?)>/giu,
    )) {
      const tag = match[1]!.toLowerCase();
      const attributes = match[2]!;
      const fusionWorldAnchor = tag === "a" && catalogueComplete &&
          format === "fusion-world"
        ? fusionWorldListingAnchor(attributes, context.url, sourceLineage)
        : null;
      const rawUrl =
        tag === "a"
          ? htmlAttribute(attributes, "href")
          : htmlAttribute(attributes, "data-src") ??
            htmlAttribute(attributes, "src");
      let resolved: URL;
      if (fusionWorldAnchor === null) {
        if (
          rawUrl === null ||
          rawUrl.startsWith("#") ||
          /^(?:data|javascript|mailto|tel):/iu.test(rawUrl)
        ) {
          continue;
        }
        try {
          resolved = new URL(decodeHtmlText(rawUrl), current);
        } catch {
          continue;
        }
      } else {
        resolved = fusionWorldAnchor.url;
      }
      resolved.hash = "";
      if (
        resolved.protocol !== "https:" ||
        resolved.href === current.href
      ) {
        continue;
      }
      const role =
        tag === "img" || tag === "source" ||
          /\.(?:avif|gif|jpe?g|png|webp)(?:$|\?)/iu.test(resolved.href)
          ? "image"
          : discoveredHtmlRole(
              format,
              initialSurface,
              resolved,
              catalogueComplete,
              completeDigimonCatalogue,
            );
      if (role === null) continue;
      if (!officialUrl(
        sourceLineage,
        resolved,
        role === "image" ? "image" : "document",
      )) continue;
      candidates.push({
        role,
        url: resolved.href,
        headers: officialDiscoveredRequestHeaders(role),
      });
    }
    return [
      ...new Map(
        candidates.map((candidate) => [
          `${candidate.role}:${candidate.url}`,
          candidate,
        ]),
      ).values(),
    ].sort((left, right) =>
      `${left.role}:${left.url}`.localeCompare(`${right.role}:${right.url}`)
    );
  };
}

function officialDiscoveredRequestHeaders(
  role: "listing" | "detail" | "product_detail" | "image",
): Record<string, string> {
  return {
    accept: role === "image"
      ? "image/avif,image/webp,image/png,image/jpeg,image/gif"
      : "text/html",
    "user-agent": `card-keepr-official-source/1; request-role=${role}`,
  };
}

function structuredImageUrls(
  value: unknown,
  base: URL,
  sourceLineage: string,
): string[] {
  const discovered: string[] = [];
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      if (/\.(?:avif|gif|jpe?g|png|webp)(?:$|\?)/iu.test(item)) {
        const url = new URL(item, base);
        if (
          url.protocol === "https:" &&
          officialUrl(sourceLineage, url, "image")
        ) {
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
): string[] {
  const selectFacets = [...html.matchAll(
    /<select\b([^>]*)>([\s\S]*?)<\/select>/giu,
  )]
    .map((match) => {
      const attributes = match[1]!;
      const key =
        htmlAttribute(attributes, "name") ??
        htmlAttribute(attributes, "id");
      if (key === null) return null;
      const options = [...match[2]!.matchAll(
        /<option\b[^>]*\bvalue=["']([^"']+)["'][^>]*>/giu,
      )]
        .map((option) => decodeHtmlText(option[1]!).trim())
        .filter((value) =>
          value.length > 0 && !/^(?:all|0|-)$/iu.test(value)
        );
      return options.length === 0
        ? null
        : {
            key: key.toLowerCase(),
            options: [...new Set(options)].sort(),
          };
    })
    .filter(
      (entry): entry is { key: string; options: string[] } => entry !== null,
    );
  const checkboxOptions = new Map<string, string[]>();
  if (catalogueComplete && format === "fusion-world") {
    for (const match of html.matchAll(/<input\b([^>]*)>/giu)) {
      const attributes = match[1]!;
      if (htmlAttribute(attributes, "type")?.toLowerCase() !== "checkbox") {
        continue;
      }
      const key = htmlAttribute(attributes, "name")?.toLowerCase();
      const value = htmlAttribute(attributes, "value");
      if (
        key === undefined ||
        value === null ||
        !/^(?:card_type|colou?r|cost)\[\]$/u.test(key)
      ) {
        continue;
      }
      const normalizedValue = decodeHtmlText(value).trim();
      if (
        normalizedValue.length === 0 ||
        /^all$/iu.test(normalizedValue)
      ) {
        continue;
      }
      checkboxOptions.set(key, [
        ...(checkboxOptions.get(key) ?? []),
        normalizedValue,
      ]);
    }
  }
  const facets = [
    ...selectFacets,
    ...[...checkboxOptions.entries()].map(([key, options]) => ({
      key,
      options: [...new Set(options)].sort(),
    })),
  ];
  const stage = nextPartitionFacet(
    format,
    facets,
    current,
    expandedOnePieceCatalogue,
    catalogueComplete && format === "fusion-world",
  );
  if (stage === null) return [];
  return stage.options.map((value) => {
    const url = new URL(current);
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
  for (const match of html.matchAll(
    /<a\b([^>]*\bhref=["'][^"']+["'][^>]*)>([\s\S]*?)<\/a>/giu,
  )) {
    const anchor = fusionWorldListingAnchor(
      match[1]!,
      requestUrl,
      sourceLineage,
    );
    if (anchor === null) continue;
    const locator = anchor.locator;
    const identity = fusionWorldLocatorIdentity(locator);
    const dataCardNumber = htmlAttribute(match[1]!, "data-card-number");
    const label = htmlText(match[2]!) || decodeHtmlText(
      htmlAttribute(
        match[2]!.match(/<img\b([^>]*)>/iu)?.[1] ?? "",
        "alt",
      ) ?? "",
    ).trim();
    const observedCardNumber = dataCardNumber ??
      label.match(/\b[A-Z]{1,6}\d{0,3}-[A-Z0-9]{1,6}\b/u)?.[0] ??
      identity.cardNumber;
    if (observedCardNumber !== identity.cardNumber) {
      throw new Error(
        `Fusion World full locator ${locator} conflicts with Card number ${observedCardNumber}.`,
      );
    }
    const canonical = JSON.stringify(stableValue({
      card_number: observedCardNumber,
      label,
    }));
    const prior = claimed.get(locator);
    if (prior !== undefined && prior !== canonical) {
      throw new Error(
        `Fusion World full locator ${locator} has conflicting live listing payloads.`,
      );
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
  const rawTarget = javascriptTarget
    ? htmlAttribute(attributes, "data-src")
    : decodedHref;
  if (rawTarget === null) return null;
  let url: URL;
  try {
    url = new URL(decodeHtmlText(rawTarget), requestUrl);
  } catch {
    return null;
  }
  url.hash = "";
  if (
    !officialUrl(sourceLineage, url, "document") ||
    !/(?:detail|card)/iu.test(url.pathname)
  ) {
    return null;
  }
  const locator = fusionWorldFullLocatorFromUrl(url, javascriptTarget);
  return locator === null ? null : { url, locator };
}

function fusionWorldFullLocatorFromUrl(
  url: URL,
  exactLiveQuery: boolean,
): string | null {
  const entries = [...url.searchParams.entries()];
  const identities = entries.filter(([key]) =>
    /^(?:card(?:[_-]?(?:id|no|number))?|detailSearch|popup)$/iu.test(key)
  );
  if (identities.length === 0) return null;
  if (identities.length !== 1) {
    throw new Error("Fusion World full locator has conflicting query identities.");
  }
  const [identityKey, rawCardLocator] = identities[0]!;
  const variantValues = url.searchParams.getAll("p");
  if (variantValues.length > 1) {
    throw new Error("Fusion World full locator has conflicting variant queries.");
  }
  if (
    exactLiveQuery &&
    (identityKey !== "card_no" ||
      entries.some(([key]) => key !== "card_no" && key !== "p"))
  ) {
    throw new Error("Fusion World full locator has an unsupported live query field.");
  }
  const cardLocator = rawCardLocator.normalize("NFC").trim();
  const baseIdentity = fusionWorldLocatorIdentity(cardLocator);
  const variant = variantValues[0]?.normalize("NFC").trim();
  if (variant === undefined) return cardLocator;
  if (baseIdentity.variant !== "base" || !/^_[A-Za-z0-9-]+$/u.test(variant)) {
    throw new Error("Fusion World full locator has a conflicting variant query.");
  }
  const locator = `${baseIdentity.cardNumber}${variant}`;
  fusionWorldLocatorIdentity(locator);
  return locator;
}

function fusionWorldCompleteListingLeaf(url: URL): boolean {
  const accepted = new Set(["card_type[]", "color[]", "colour[]", "cost[]"]);
  const entries = [...url.searchParams.entries()];
  return entries.every(([key, value]) =>
    accepted.has(key) && value.trim().length > 0
  ) &&
    url.searchParams.getAll("card_type[]").length === 1 &&
    url.searchParams.getAll("cost[]").length === 1 &&
    url.searchParams.getAll("color[]").length +
        url.searchParams.getAll("colour[]").length === 1;
}

function nextPartitionFacet(
  format: DiscoveryFormat,
  facets: readonly { key: string; options: string[] }[],
  current: URL,
  expandedOnePieceCatalogue = false,
  bracketedFusionFacets = false,
): { key: string; options: string[] } | null {
  const find = (keys: readonly string[]) =>
    facets.find(({ key }) =>
      keys.includes(bracketedFusionFacets ? key.replace(/\[\]$/u, "") : key)
    ) ?? null;
  const hasFacet = (keys: readonly string[]) =>
    keys.some((key) =>
      current.searchParams.has(key) ||
      (bracketedFusionFacets && current.searchParams.has(`${key}[]`))
    );
  if (format === "one-piece") {
    const recording = find([
      expandedOnePieceCatalogue ? "series" : "recording",
    ]);
    if (recording === null || current.searchParams.has(recording.key)) {
      return null;
    }
    const numeric = recording.options.filter((value) => /^\d+$/u.test(value));
    return numeric.length === 0
      ? null
      : { key: recording.key, options: numeric };
  }
  const hierarchy =
    format === "fusion-world"
      ? [["card_type"], ["colour", "color"], ["cost"]]
      : format === "digimon"
        ? [
            ["category"],
            ["cardcategory", "card_type"],
            ["colour", "color"],
          ]
        : [["package"]];
  for (const aliases of hierarchy) {
    const facet = find(aliases);
    if (facet === null) continue;
    if (
      hasFacet(aliases)
    ) {
      continue;
    }
    return facet;
  }
  return null;
}

function htmlAttribute(attributes: string, name: string): string | null {
  const match = attributes.match(
    new RegExp(`\\b${name}=["']([^"']+)["']`, "iu"),
  );
  return match?.[1] ?? null;
}

function dynamicRequestRole(
  requestId: string | undefined,
): "listing" | "detail" | "product_detail" | "image" | null {
  const match = requestId?.match(
    /:(listing|detail|product_detail|image)(?::[a-z0-9]+(?:-[a-z0-9]+)*)?:[a-f0-9]{64}$/u,
  );
  return match?.[1] as ReturnType<typeof dynamicRequestRole> ?? null;
}

function discoveryStageKey(requestId: string | undefined): string | null {
  return requestId?.match(
    /:listing:([a-z0-9]+(?:-[a-z0-9]+)*):[a-f0-9]{64}$/u,
  )?.[1] ?? null;
}

function dynamicStructuredSurface(
  dynamicRole: ReturnType<typeof dynamicRequestRole>,
  fallbackSurface: string | null,
  requiredSurfaces: readonly string[],
  completeDigimonCatalogue: boolean,
): string | null {
  return completeDigimonCatalogue && dynamicRole === "listing"
    ? requiredSurfaces[0]!
    : fallbackSurface;
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
    format === "gundam" &&
    initialSurface === "legality" &&
    /\/(?:asia-en|en)\/news\/01_279\.html$/u.test(url.pathname)
  ) {
    return "detail";
  }
  if (initialSurface === "legality") return null;
  if (
    catalogueComplete &&
    format === "fusion-world" &&
    /\/cardlist\/detail\.php$/iu.test(url.pathname) &&
    fusionWorldFullLocatorFromUrl(url, false) !== null
  ) {
    return "detail";
  }
  if (
    initialSurface === "products" ||
    initialSurface === "releases" ||
    /\/products?\//iu.test(target)
  ) {
    if (nonCardProductClassification(target) !== null) return null;
    if (
      catalogueComplete &&
      format === "fusion-world" &&
      url.searchParams.has("status")
    ) return "listing";
    return /(?:detail|products?\/[^/?]+|products?\.php\?.*\bid=)/iu.test(
        target,
      )
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
  if (
    /\/cards?\/[^/?]+/iu.test(target) ||
    /\/cardlist\/card\//iu.test(target)
  ) {
    return "detail";
  }
  if (
    /(?:page|paged|offset)=\d+/iu.test(target) ||
    (format === "fusion-world" &&
      /(?:card_type|colour|color|cost)=/iu.test(target)) ||
    (format === "digimon" &&
      /(?:category|cardcategory|colour|color|version)=/iu.test(target)) ||
    (format === "gundam" && /(?:package|page)=/iu.test(target))
  ) {
    return "listing";
  }
  return null;
}

function nonCardProductClassification(value: string): "accessory" | null {
  return /(?:accessor|sleeve|storage|binder|playmat)/iu.test(value)
    ? "accessory"
    : null;
}

function officialUrl(
  sourceLineage: string,
  url: URL,
  role: "document" | "image",
): boolean {
  const contract = officialRawAdapterContracts.filter(
    (candidate) => candidate.sourceLineage === sourceLineage,
  ).at(-1);
  return contract !== undefined &&
    url.origin === contract.sourceOrigin &&
    contract[
      role === "image"
        ? "imagePathnamePrefixes"
        : "documentPathnamePrefixes"
    ].some((prefix) =>
      url.pathname.startsWith(prefix)
    ) &&
    url.username === "" &&
    url.password === "" &&
    url.hash === "";
}

function officialHostname(sourceLineage: string, hostname: string): boolean {
  const expected = sourceLineage === "one-piece-en"
    ? ["onepiece-cardgame.com"]
    : sourceLineage === "fusion-world-en"
      ? ["dbs-cardgame.com"]
      : sourceLineage === "digimon-en"
        ? ["digimoncard.com"]
        : ["gundam-gcg.com"];
  return expected.some((suffix) =>
    hostname === suffix || hostname.endsWith(`.${suffix}`)
  );
}

function exactSurfaceUrl(
  sourceLineage: string,
  requiredSurfaces: readonly string[],
  urls: Readonly<Record<string, string>>,
  surface: string,
): string {
  if (!requiredSurfaces.includes(surface)) {
    throw new Error(
      `Official Source lineage ${sourceLineage} has no ${surface} surface.`,
    );
  }
  const url = urls[surface];
  if (url === undefined) {
    throw new Error(
      `Official Source lineage ${sourceLineage} has no ${surface} URL.`,
    );
  }
  return new URL(url).href;
}

function historicalBandaiSnapshotDecoderV1(
  format: DiscoveryFormat,
  game: ProductSourceGame,
  sourceLineage: string,
  requiredSurfaces: readonly string[],
  urls: Readonly<Record<string, string>>,
): OfficialRawAdapterContract["parseBytes"] {
  return (bytes, context) => {
    const dynamicRole = dynamicRequestRole(context.requestId);
    const mediaType = context.mediaType?.split(";", 1)[0]?.trim()
      .toLowerCase();
    if (dynamicRole === "image") {
      if (
        mediaType === undefined ||
        !mediaType.startsWith("image/") ||
        bytes.byteLength === 0
      ) {
        throw new Error(
          "Official Printing Image request did not retain non-empty image bytes.",
        );
      }
      return [];
    }
    const surface = dynamicRole ?? historicalSurfaceFromContextV1(
      context,
      sourceLineage,
      requiredSurfaces,
      urls,
    );
    if (mediaType !== "text/html") {
      throw new Error(
        `Official Source ${surface} must be captured as text/html.`,
      );
    }
    const html = decodeUtf8(bytes, surface);
    if (/\bdata-keepr-official-payload\b/iu.test(html)) {
      throw new Error(
        "Production Official Source parsing does not accept synthetic Keepr payload wrappers.",
      );
    }
    const structuredPayload = historicalBandaiJsonLdPayloadV1(
      html,
      sourceLineage,
      surface,
    );
    if (structuredPayload !== null) {
      return normalizedSurfaceObservationsV1(
        format,
        game,
        sourceLineage,
        surface,
        structuredPayload,
      );
    }
    if (dynamicRole === "detail") {
      return [parseBandaiCardDetailV1(
        html,
        format,
        sourceLineage,
        context.url,
      )];
    }
    if (dynamicRole === "product_detail") {
      return [parseBandaiProductDetailFrozenV1(
        html,
        sourceLineage,
        context.url,
      )];
    }
    const parsed = format === "one-piece" && surface === "card-list"
      ? parseOnePieceBandaiCardListV1(html, context.url)
      : parseBandaiSurfaceCoverageV1(
          html,
          format,
          sourceLineage,
          surface,
          context.url,
        );
    return parsed.observations.map((observation, index) =>
      attachRawSurfaceEvidenceV1(
        observation,
        sourceLineage,
        surface,
        parsed.retainedDocument,
        index === 0,
        parsed.consumedFields,
      )
    );
  };
}

function historicalBandaiJsonLdPayloadV1(
  html: string,
  sourceLineage: string,
  surface: string,
): Record<string, unknown> | null {
  for (const match of html.matchAll(
    /<script\b[^>]*\btype=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu,
  )) {
    let value: unknown;
    try {
      value = JSON.parse(match[1]!);
    } catch {
      throw new Error("Official Source JSON-LD publication is invalid.");
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const publication = value as Record<string, unknown>;
    const publisher = publication.publisher !== null &&
        typeof publication.publisher === "object" &&
        !Array.isArray(publication.publisher)
      ? publication.publisher as Record<string, unknown>
      : {};
    if (
      publication["@context"] !== "https://schema.org" ||
      publication["@type"] !== "Dataset" ||
      publisher.name !== "Bandai" ||
      !Array.isArray(publication.hasPart)
    ) {
      continue;
    }
    const part = publication.hasPart.find((candidate) =>
      candidate !== null &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      (candidate as Record<string, unknown>).identifier ===
        `${sourceLineage}:${surface}`
    );
    if (part === undefined) continue;
    return requiredRecord(
      (part as Record<string, unknown>).payload,
      `Official Source ${surface} JSON-LD payload`,
    );
  }
  return null;
}

function historicalSurfaceFromContextV1(
  context: { url: string; requestId?: string },
  sourceLineage: string,
  requiredSurfaces: readonly string[],
  urls: Readonly<Record<string, string>>,
): string {
  const prefix = `${sourceLineage}:`;
  if (context.requestId?.startsWith(prefix)) {
    const surface = context.requestId.slice(prefix.length);
    const contextUrl = new URL(context.url).href;
    if (
      requiredSurfaces.includes(surface) &&
      contextUrl === new URL(urls[surface]!).href
    ) {
      return surface;
    }
    throw new Error(
      `Official Source Request identity does not match the ${sourceLineage} URL contract.`,
    );
  }
  const matches = requiredSurfaces.filter((surface) =>
    new URL(urls[surface]!).href === new URL(context.url).href
  );
  if (matches.length !== 1) {
    throw new Error(
      `Official Source URL does not identify one exact ${sourceLineage} surface.`,
    );
  }
  return matches[0]!;
}

function legalityAwareBandaiSnapshotDecoder(
  format: DiscoveryFormat,
  game: ProductSourceGame,
  sourceLineage: string,
  requiredSurfaces: readonly string[],
  urls: Readonly<Record<string, string>>,
  expandedOnePieceCatalogue = false,
  catalogueComplete = false,
  completeDigimonCatalogue = false,
): OfficialRawAdapterContract["parseBytes"] {
  return bandaiSnapshotDecoder(format, game, sourceLineage, requiredSurfaces, urls, {
    parseLegality: true,
    acceptPublisherDeclaredEmpty: true,
    acceptDiscoveryRoot: true,
    expandedOnePieceCatalogue,
    catalogueComplete,
    completeDigimonCatalogue,
  });
}

function bandaiSnapshotDecoder(
  format: DiscoveryFormat,
  game: ProductSourceGame,
  sourceLineage: string,
  requiredSurfaces: readonly string[],
  urls: Readonly<Record<string, string>>,
  profile: Readonly<{
    parseLegality: boolean;
    acceptPublisherDeclaredEmpty: boolean;
    acceptDiscoveryRoot?: boolean;
    expandedOnePieceCatalogue?: boolean;
    catalogueComplete?: boolean;
    completeDigimonCatalogue?: boolean;
  }>,
): OfficialRawAdapterContract["parseBytes"] {
  return (bytes, context) => {
    const dynamicRole = dynamicRequestRole(context.requestId);
    const mediaType = context.mediaType?.split(";", 1)[0]?.trim()
      .toLowerCase();
    if (dynamicRole === "image") {
      if (
        mediaType === undefined ||
        !mediaType.startsWith("image/") ||
        bytes.byteLength === 0
      ) {
        throw new Error(
          "Official Printing Image request did not retain non-empty image bytes.",
        );
      }
      return [];
    }
    if (
      profile.acceptDiscoveryRoot === true &&
      context.requestId === `${sourceLineage}:discovery` &&
      new URL(context.url).href === new URL(urls[requiredSurfaces[0]!]!).href
    ) {
      if (mediaType !== "text/html") {
        throw new Error("Official Source discovery must be captured as text/html.");
      }
      const html = decodeUtf8(bytes, "discovery");
      if (/\bdata-keepr-official-payload\b/iu.test(html)) {
        throw new Error(
          "Production Official Source parsing does not accept synthetic Keepr payload wrappers.",
        );
      }
      if (profile.completeDigimonCatalogue === true) {
        assertDigimonCatalogueFactsAtCompleteLeaf(
          html,
          sourceLineage,
          requiredSurfaces[0]!,
          context.url,
        );
      }
      const records = bandaiDiscoveryRecords(
        html,
        sourceLineage,
        requiredSurfaces,
        urls,
      );
      return [{
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
      }];
    }
    const discoveryKey = discoveryStageKey(context.requestId);
    if (profile.acceptDiscoveryRoot === true && discoveryKey !== null) {
      if (mediaType !== "text/html") {
        throw new Error("Official Source discovery stages must be captured as text/html.");
      }
      const html = decodeUtf8(bytes, `discovery stage ${discoveryKey}`);
      const records = bandaiDiscoveryStageRecords(
        html,
        context.url,
        sourceLineage,
        discoveryKey,
        requiredSurfaces,
      );
      return [{
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
      }];
    }
    const surface = dynamicRole ??
      surfaceFromContext(
        context,
        sourceLineage,
        requiredSurfaces,
        urls,
      );
    const structuredSurface = dynamicStructuredSurface(
      dynamicRole,
      surface,
      requiredSurfaces,
      profile.completeDigimonCatalogue === true,
    );
    if (structuredSurface === null) {
      throw new Error("Official Source dynamic surface identity is invalid.");
    }
    if (mediaType !== "text/html") {
      throw new Error(
        `Official Source ${surface} must be captured as text/html.`,
      );
    }
    const html = stripKnownPublisherNavigation(
      decodeUtf8(bytes, surface),
      sourceLineage,
      context.url,
    );
    if (/\bdata-keepr-official-payload\b/iu.test(html)) {
      throw new Error(
        "Production Official Source parsing does not accept synthetic Keepr payload wrappers.",
      );
    }
    const structuredPayload = bandaiPublisherPayload(
      html,
      sourceLineage,
      structuredSurface,
    );
    if (structuredPayload !== null) {
      if (
        profile.completeDigimonCatalogue === true &&
        structuredSurface === requiredSurfaces[0]
      ) {
        assertDigimonPayloadAtCompleteLeaf(structuredPayload, context.url);
      }
      const observations = normalizedSurfaceObservationsV2(
        format,
        game,
        sourceLineage,
        structuredSurface,
        structuredPayload,
        profile.parseLegality,
        profile.expandedOnePieceCatalogue === true,
        profile.catalogueComplete === true,
        profile.completeDigimonCatalogue === true,
      );
      if (
        profile.parseLegality &&
        isLegalityRuleSurface(game, surface)
      ) {
        assertStructuredAndVisibleLegalityMatch(
          html,
          game,
          sourceLineage,
          surface,
          observations,
        );
        if (containsUnmodeledDedicatedPolicyContent(
          html,
          sourceLineage,
          surface,
        )) {
          throw new Error(
            `Official Source ${surface} retained non-empty Legality data without an exact, complete Legality Rule parser.`,
          );
        }
      }
      return observations;
    }
    const liveLegality = profile.parseLegality
      ? liveOfficialLegalityDocument(
          game,
          sourceLineage,
          surface,
          context.url,
          html,
        )
      : null;
    const isPlannedFusionPolicyRoot =
      sourceLineage === "fusion-world-en" &&
      dynamicRole === null &&
      (surface === "legality-current" || surface === "legality-history");
    if (
      liveLegality !== null &&
      (dynamicRole !== null || isPlannedFusionPolicyRoot)
    ) {
      return [attachRawSurfaceEvidenceV1(
        officialLiveLegalityRulesObservation(
          game,
          sourceLineage,
          liveLegality.document,
        ),
        sourceLineage,
        liveLegality.surface,
        liveLegality.document,
        true,
        Object.keys(liveLegality.document),
      )];
    }
    if (dynamicRole === "detail") {
      return [
        profile.catalogueComplete === true && format === "fusion-world"
          ? parseFusionWorldCardDetailV3(
            html,
            sourceLineage,
            context.url,
          )
          : parseBandaiCardDetailV2(
          html,
          format,
          sourceLineage,
          context.url,
          ),
      ];
    }
    if (dynamicRole === "product_detail") {
      return [
        parseBandaiProductDetailV2(
          html,
          sourceLineage,
          context.url,
        ),
      ];
    }
    if (
      profile.expandedOnePieceCatalogue === true &&
      surface === "don-rules"
    ) {
      throw new Error(
        "One Piece DON!! Card facts require explicit snapshot evidence.",
      );
    }
    const isOnePieceRecordingLeaf =
      profile.expandedOnePieceCatalogue === true &&
      format === "one-piece" &&
      dynamicRole === "listing" &&
      /^\d+$/u.test(new URL(context.url).searchParams.get("series") ?? "");
    const isStructurallyEmptyFusionErrata =
      profile.catalogueComplete === true &&
      format === "fusion-world" &&
      surface === "errata" &&
      />\s*0\s+records?\s*</iu.test(html) &&
      /<article\b[^>]*\bdata-publication-empty=["']true["'][^>]*>/iu.test(
        html,
      );
    if (
      profile.catalogueComplete === true &&
      format === "fusion-world" &&
      surface === "errata" &&
      !isStructurallyEmptyFusionErrata
    ) {
      return parseFusionWorldOfficialErrataHtmlV3(html);
    }
    if (
      profile.completeDigimonCatalogue === true &&
      format === "digimon" &&
      dynamicRole === "listing" &&
      structuredSurface === requiredSurfaces[0] &&
      (isCompleteDigimonLeafUrl(context.url) ||
        digimonPopupRecordCount(html) > 0)
    ) {
      assertCompleteDigimonLeafUrl(context.url);
      return parseDigimonCardListPopupHtmlV4(html, context.url);
    }
    const parsed =
      format === "one-piece" &&
          (surface === "card-list" || isOnePieceRecordingLeaf)
        ? parseOnePieceBandaiCardListV1(
            html,
            context.url,
            profile.expandedOnePieceCatalogue === true,
          )
        : parseBandaiSurfaceCoverageV2(
            html,
            format,
            sourceLineage,
            profile.catalogueComplete === true &&
                format === "fusion-world" &&
                surface === "listing" &&
                /\/products\//u.test(new URL(context.url).pathname)
              ? "products"
              : surface,
            context.url,
            profile.acceptPublisherDeclaredEmpty &&
              (isLegalityPolicySurface(surface) ||
                isStructurallyEmptyFusionErrata),
            profile.catalogueComplete === true,
          );
    const liveLegalityDocument = liveLegality?.document ?? null;
    const legalityObservation = profile.parseLegality &&
        isLegalityRuleSurface(game, surface)
      ? liveLegalityDocument === null
        ? officialLegalityRulesHtmlObservation(game, sourceLineage, html) ?? null
        : officialLiveLegalityRulesObservation(
            game,
            sourceLineage,
            liveLegalityDocument,
          )
      : null;
    if (
      profile.parseLegality &&
      isLegalityRuleSurface(game, surface) &&
      liveLegalityDocument === null && containsUnparsedLegalityPublication(
        html,
        sourceLineage,
        parsed.retainedDocument,
        isLegalityPolicySurface(surface),
        legalityObservation !== null &&
          Array.isArray(legalityObservation.legality_rules)
          ? legalityObservation.legality_rules.length
          : 0,
      )
    ) {
      throw new Error(
        `Official Source ${surface} retained non-empty Legality data without an exact, complete Legality Rule parser.`,
      );
    }
    const observations = legalityObservation === null
      ? parsed.observations
      : [...parsed.observations, legalityObservation];
    return observations.map((observation, index) =>
      attachRawSurfaceEvidenceV1(
        observation,
        sourceLineage,
        surface,
        parsed.retainedDocument,
        index === 0,
        parsed.consumedFields,
      )
    );
  };
}

function containsUnparsedLegalityPublication(
  html: string,
  sourceLineage: string,
  document: Readonly<Record<string, unknown>>,
  dedicatedPolicySurface: boolean,
  parsedRuleCount: number,
): boolean {
  const links = Array.isArray(document.publication_links)
    ? document.publication_links
    : [];
  const entries = Array.isArray(document.publication_entries)
    ? document.publication_entries
    : [];
  const options = Array.isArray(document.discovered_options)
    ? document.discovered_options
    : [];
  const unmatchedEntries = [...entries];
  const exactRuleEntries = [...html.matchAll(
    /<article\b([^>]*)>([\s\S]*?)<\/article>/giu,
  )]
    .filter((match) =>
      /(?:^|\s)restriction-card(?:\s|$)/u.test(
        htmlAttribute(match[1]!, "class") ?? "",
      )
    )
    .map((match) => htmlText(match[2]!));
  if (exactRuleEntries.length !== parsedRuleCount) return true;
  for (const exactRuleEntry of exactRuleEntries) {
    const retainedIndex = unmatchedEntries.findIndex(
      (entry) => entry === exactRuleEntry,
    );
    if (retainedIndex === -1) return true;
    unmatchedEntries.splice(retainedIndex, 1);
  }
  if (dedicatedPolicySurface) {
    return containsUnmodeledDedicatedPolicyContent(
      html,
      sourceLineage,
    );
  }
  return [...links, ...options, ...unmatchedEntries, htmlText(html)]
    .map(publicationText)
    .some((text) =>
      /\b(?:ban(?:ned)?|block(?:ed)?|eligib(?:le|ility)|forbid(?:den)?|legal(?:ity)?|limit(?:ed)?|prohibit(?:ed)?|restriction|rotation|suspend(?:ed)?|unless)\b|\bmay (?:no longer|not) be (?:included|used)\b|\b(?:if|when) your\b|\bduring [^.]*events?\b|\bonly at\b|\bno more than \d+ cop(?:y|ies)\b/iu
        .test(text)
    );
}

function containsUnmodeledDedicatedPolicyContent(
  html: string,
  sourceLineage?: string,
  consumedPublisherSurface?: string,
): boolean {
  let residual = html.replace(
    /<article\b([^>]*)>[\s\S]*?<\/article>/giu,
    (article, attributes: string) =>
      /(?:^|\s)restriction-card(?:\s|$)/u.test(
        htmlAttribute(attributes, "class") ?? "",
      )
        ? ""
        : article,
  );
  if (sourceLineage !== undefined && consumedPublisherSurface !== undefined) {
    const consumedPublisherScriptId = publisherPayloadScriptId(
      sourceLineage,
      consumedPublisherSurface,
    );
    residual = residual.replace(
      /<script\b([^>]*)>[\s\S]*?<\/script>/giu,
      (script, attributes: string) => {
        const id = htmlAttribute(attributes, "id");
        return hasExactHtmlAttributes(attributes, ["id", "type"]) &&
            htmlAttribute(attributes, "type") === "application/json" &&
            id === consumedPublisherScriptId
          ? ""
          : script;
      },
    );
  }
  if (/<script\b/iu.test(residual)) return true;
  residual = residual
    .replace(/<!doctype\s+html\s*>/giu, "")
    .replace(
      /<title\b[^>]*>([\s\S]*?)<\/title>/giu,
      (title, body: string) =>
        isKnownLegalityPublisherTitle(htmlText(body)) ? "" : title,
    )
    .replace(
      /<h1\b[^>]*>([\s\S]*?)<\/h1>/giu,
      (heading, body: string) =>
        htmlText(body) === "Restriction Rules" ? "" : heading,
    )
    .replace(
      /<p\b[^>]*>([\s\S]*?)<\/p>/giu,
      (paragraph, body: string) =>
        /^\d+\s+records?$/iu.test(htmlText(body)) ? "" : paragraph,
    )
    .replace(
      /<article\b([^>]*)>([\s\S]*?)<\/article>/giu,
      (article, attributes: string, body: string) =>
        htmlAttribute(attributes, "data-publication-empty") === "true" &&
          /^No (?:restrictions are currently published|published entries)\.$/iu
            .test(htmlText(body))
          ? ""
          : article,
    );
  return htmlText(residual).length > 0;
}

function assertStructuredAndVisibleLegalityMatch(
  html: string,
  game: ProductSourceGame,
  sourceLineage: string,
  surface: string,
  structuredObservations: readonly unknown[],
): void {
  const hasVisibleArticles = [...html.matchAll(
    /<article\b([^>]*)>[\s\S]*?<\/article>/giu,
  )].some((match) =>
    /(?:^|\s)restriction-card(?:\s|$)/u.test(
      htmlAttribute(match[1]!, "class") ?? "",
    )
  );
  const hasVisibleTotal = />\s*\d+\s+(?:records?|results?|items?)\s*</iu
    .test(html);
  if (!hasVisibleArticles && !hasVisibleTotal) return;

  let visibleObservation: Record<string, unknown> | null;
  try {
    visibleObservation = officialLegalityRulesHtmlObservation(
      game,
      sourceLineage,
      html,
    );
  } catch {
    throwStructuredVisibleLegalityMismatch(surface);
  }
  if (visibleObservation === null) {
    throwStructuredVisibleLegalityMismatch(surface);
  }
  const structuredObservation = structuredObservations.find((observation) =>
    isPlainRecord(observation) &&
    observation.observation_type === "legality_rules"
  );
  if (!isPlainRecord(structuredObservation)) {
    throwStructuredVisibleLegalityMismatch(surface);
  }
  const canonicalPublication = (
    observation: Record<string, unknown>,
  ): unknown => ({
    completeness: requiredRecord(
      observation.completeness,
      "Official Legality completeness",
    ),
    rules: requiredArray(
      observation.legality_rules,
      "Official Legality rules",
    ).map((rule) => requiredRecord(rule, "Official Legality rule"))
      .sort((left, right) =>
        requiredText(left.id, "Official Legality identity").localeCompare(
          requiredText(right.id, "Official Legality identity"),
        )
      ),
  });
  if (
    JSON.stringify(stableValue(canonicalPublication(structuredObservation))) !==
      JSON.stringify(stableValue(canonicalPublication(visibleObservation)))
  ) {
    throwStructuredVisibleLegalityMismatch(surface);
  }
}

function throwStructuredVisibleLegalityMismatch(surface: string): never {
  throw new Error(
    `Official Source ${surface} retained non-empty Legality data without an exact, complete Legality Rule parser.`,
  );
}

function isKnownLegalityPublisherTitle(title: string): boolean {
  return /^(?:BANDAI Official publication|Official Bandai CARD PRODUCT RELEASE RULE ERRATA RESTRICTION publication|BANDAI CARD PRODUCT RELEASE RULE RESTRICTION publication|BANDAI (?:one-piece|fusion-world|digimon|gundam) CARD PRODUCT RELEASE RULE ERRATA RESTRICTION|BANDAI DRAGON BALL CARD RULE RESTRICTION(?: HISTORY)?|BANDAI ONE PIECE CARD RELEASE publication|Bandai Dragon Ball(?: Super Card Game)? Fusion World Restriction Rules)$/iu
    .test(title);
}

function hasExactHtmlAttributes(
  attributes: string,
  expected: readonly string[],
): boolean {
  const retained = [...attributes.matchAll(
    /\b([a-z][a-z0-9:-]*)\s*=\s*(?:"[^"]*"|'[^']*')/giu,
  )];
  const names = retained.map((match) => match[1]!.toLowerCase()).sort();
  const residue = retained.reduce(
    (value, match) => value.replace(match[0], ""),
    attributes,
  ).trim();
  return residue.length === 0 &&
    names.join(",") === [...expected].sort().join(",");
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
          resolved = new URL(decodeHtmlText(href), contextUrl).href;
        } catch {
          return true;
        }
        const label = htmlText(anchor[2]!).toLocaleLowerCase();
        return !allowed.has(`${label}\u0000${resolved}`);
      })
    ) {
      return false;
    }
    const withoutKnownNavigation = body
      .replace(/<a\b[^>]*>[\s\S]*?<\/a>/giu, "")
      .replace(/<\/?(?:ul|ol|li)>/giu, "");
    return htmlText(withoutKnownNavigation).length === 0;
  };
  const withoutHeader = html.replace(
    /<header\b([^>]*)>([\s\S]*?)<\/header>/giu,
    (header, attributes: string, body: string) => {
      if (attributes.trim().length > 0) return header;
      const navigation = body.match(
        /^\s*<nav\b([^>]*)>([\s\S]*?)<\/nav>\s*$/iu,
      );
      return navigation !== null && navigation[1]!.trim().length === 0 &&
          containsOnlyKnownLinks(navigation[2]!)
        ? ""
        : header;
    },
  );
  if (scope === "header-only") return withoutHeader;
  return withoutHeader.replace(
    /<nav\b([^>]*)>([\s\S]*?)<\/nav>/giu,
    (navigation, attributes: string, body: string) =>
      hasExactNavigationContainerAttributes(attributes) &&
        containsOnlyKnownLinks(body)
        ? ""
        : navigation,
  ).replace(
    /<main\b([^>]*)>([\s\S]*?)<\/main>/giu,
    (main, attributes: string, body: string) =>
      attributes.trim().length === 0 && containsOnlyKnownLinks(body)
        ? ""
        : main,
  );
}

function hasExactNavigationContainerAttributes(attributes: string): boolean {
  return attributes.trim().length === 0 ||
    (hasExactHtmlAttributes(attributes, ["aria-label"]) &&
      htmlAttribute(attributes, "aria-label") === "Rules publications");
}

function knownPublisherNavigationLinks(sourceLineage: string): Set<string> {
  const labelsBySurface: Readonly<Record<string, string>> = {
    "card-list": "card list",
    packages: "find cards",
    restrictions: "restriction cards",
    "block-policy": "block policy",
    errata: sourceLineage.startsWith("gundam-")
      ? "errata and corrections"
      : "errata cards",
    "legality-current": "current banned and limited cards",
    "legality-history": "previous restriction history",
    "restrictions-current": "current restriction cards",
    "restrictions-history": "previous restriction history",
  };
  const allowed = new Set<string>();
  for (const seed of bandaiDiscoverySeeds(sourceLineage)) {
    allowed.add(`${seed.label}\u0000${new URL(seed.url).href}`);
    for (const [surface, resolution] of Object.entries(seed.resolutions)) {
      const label = labelsBySurface[surface];
      if (label !== undefined) {
        allowed.add(`${label}\u0000${new URL(resolution, seed.url).href}`);
      }
    }
  }
  if (sourceLineage === "fusion-world-en") {
    allowed.add(
      "previous restriction history\u0000https://www.dbs-cardgame.com/fw/en/rules/banned-limited-cards/?view=history",
    );
  } else if (sourceLineage === "digimon-en") {
    allowed.add(
      "previous restriction history\u0000https://world.digimoncard.com/rule/restriction_card/?view=history",
    );
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
  const headers = [...html.matchAll(
    /<header\b([^>]*)>([\s\S]*?)<\/header>/giu,
  )];
  if (headers.length !== 1) {
    throw new Error(
      "Official Source discovery must retain exactly one publisher header.",
    );
  }
  const seeds = bandaiDiscoverySeeds(sourceLineage);
  const framing = exactPublisherDiscoveryFraming(sourceLineage);
  if (
    headers[0]![1]!.trim() !== framing.headerAttributes ||
    !framing.container.test(html)
  ) {
    throw new Error(
      "Official Source discovery does not match its retained publisher navigation framing.",
    );
  }
  const discoveryUrl = new URL(urls[requiredSurfaces[0]!]!).href;
  const observedSeeds = new Map<string, {
    label: string;
    url: string;
    resolution: string;
  }>();
  for (const seed of seeds) {
    const anchor = framing.seeds[seed.id];
    if (anchor === undefined || !anchor.pattern.test(html)) {
      continue;
    }
    if (countPatternMatches(html, anchor.pattern) !== 1) {
      throw new Error(
        `Official Source discovery duplicates the ${seed.id} navigation link.`,
      );
    }
    const resolvedUrl = new URL(anchor.resolution, discoveryUrl).href;
    if (resolvedUrl !== new URL(seed.url).href) {
      throw new Error(
        "Official Source discovery moved a required navigation URL.",
      );
    }
    observedSeeds.set(seed.id, {
      label: seed.label,
      url: resolvedUrl,
      resolution: anchor.resolution,
    });
  }
  if (observedSeeds.size !== seeds.length) {
    throw new Error(
      "Official Source discovery navigation does not prove every required surface family.",
    );
  }
  return seeds.map((seed) => {
    const observedSeed = observedSeeds.get(seed.id);
    if (observedSeed === undefined) {
      throw new Error(
        `Official Source discovery did not retain the ${seed.id} navigation link.`,
      );
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
  seeds: Readonly<Record<string, Readonly<{
    pattern: RegExp;
    resolution: string;
  }>>>;
}>;

function countPatternMatches(html: string, pattern: RegExp): number {
  return [...html.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))]
    .length;
}

function exactPublisherDiscoveryFraming(
  sourceLineage: string,
): ExactDiscoveryFraming {
  if (sourceLineage === "one-piece-en") {
    return {
      headerAttributes: 'class="headerCol js-header uniweb-translation-mask"',
      container: /<div class="headerColInner">[\s\S]*<div class="headerColInnerWrap">[\s\S]*<nav class="gnaviCol uniweb-translation-mask">/u,
      seeds: {
        cards: {
          pattern: /<li class="menuColListItem">\s*<a class="menuColListLink" href="\/cardlist\/">\s*<span class="menuColListLinkTit">FIND CARDS<\/span>\s*<\/a>\s*<\/li>/u,
          resolution: "/cardlist/",
        },
        products: {
          pattern: /<li class="menuColListItem">\s*<a class="menuColListLink" href="\/products\/">\s*<span class="menuColListLinkTit">ALL PRODUCTS<\/span>\s*<\/a>\s*<\/li>/u,
          resolution: "/products/",
        },
        rules: {
          pattern: /<li class="menuColListItem">\s*<a class="menuColListLink" href="\/rules\/">\s*<span class="menuColListLinkTit">RULES<\/span>\s*<span class="menuColListLinkTxt">Rules and important updates<\/span>\s*<\/a>\s*<\/li>/u,
          resolution: "/rules/",
        },
      },
    };
  }
  if (sourceLineage === "fusion-world-en") {
    return {
      headerAttributes: 'class="header js-header"',
      container: /<nav class="headerGnavCol">[\s\S]*<ul class="headerGnavList">[\s\S]*<div class="headerDropMenuListItemInner">/u,
      seeds: {
        cards: {
          pattern: /<li class="headerGnavListItem navLink">\s*<a href="\/fw\/en\/cardlist\/" class="js-headerGnavItem">CARDS<\/a>\s*<\/li>/u,
          resolution: "/fw/en/cardlist/",
        },
        products: {
          pattern: /<div class="headerDropMenuListBox">\s*<p class="largeMenu"><a href="\/fw\/en\/products\/">ALL Products<\/a><\/p>\s*<\/div>/u,
          resolution: "/fw/en/products/",
        },
        rules: {
          pattern: /<li class="headerGnavListItem navLink">\s*<a href="\/fw\/en\/news\/01_31\.html" class="js-headerGnavItem">RULES<\/a>\s*<\/li>/u,
          resolution: "/fw/en/news/01_31.html",
        },
      },
    };
  }
  if (sourceLineage === "digimon-en") {
    return {
      headerAttributes: 'class="header"',
      container: /<\/header>\s*<nav id="gnavi_sp" class="switch">\s*<div class="inner">[\s\S]*<ul class="gnavi_inner">/u,
      seeds: {
        cards: {
          pattern: /<li class="gnavi_cardlist current"><a href="\/cardlist\/">\s*<img src="\/images\/common\/gnavi\/gnavi_cardlist\.png\?v02" alt="CARD LIST"><\/a><\/li>/u,
          resolution: "/cardlist/",
        },
        products: {
          pattern: /<li class="gnavi_products "><a href="\/products\/"><img src="\/images\/common\/gnavi\/gnavi_products\.png" alt="PRODUCTS"><\/a><\/li>/u,
          resolution: "/products/",
        },
        rules: {
          pattern: /<li class="gnavi_rule "><a href="\/rule\/"><img src="\/images\/common\/gnavi\/gnavi_rule\.png\?v02" alt="RULES"><\/a><\/li>/u,
          resolution: "/rule/",
        },
      },
    };
  }
  const locale = sourceLineage === "gundam-en-asia" ? "asia-en" : "en";
  return {
    headerAttributes: 'class="header"',
    container: /<div class="headerWrapper">[\s\S]*<div id="js_headerGnav" class="headerNavWrapper">\s*<nav class="">\s*<ul class="headerGnavList">/u,
    seeds: {
      cards: {
        pattern: new RegExp(`<li class="menuColListItem">\\s*<a class="menuColListLink" href="/${locale}/cards/">\\s*<span class="menuColListLinkTit">FIND CARDS</span>\\s*</a>\\s*</li>`, "u"),
        resolution: `/${locale}/cards/`,
      },
      products: {
        pattern: new RegExp(`<li class="menuColListItem">\\s*<a class="menuColListLink" href="/${locale}/products/list\\.php">\\s*<span class="menuColListLinkTit">PRODUCT LIST</span>\\s*</a>\\s*</li>`, "u"),
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
  const seed = bandaiDiscoverySeeds(sourceLineage).find(
    ({ id }) => id === discoveryKey,
  );
  if (seed === undefined) {
    throw new Error(
      `Official Source discovery uses unknown stage vocabulary: ${discoveryKey}.`,
    );
  }
  const current = new URL(requestUrl);
  if (!officialUrl(sourceLineage, current, "document")) {
    throw new Error("Official Source discovery stage is outside registered authority.");
  }
  const records = new Map<string, ReturnType<typeof stageRecord>>();
  for (const surface of Object.keys(seed.resolutions)) {
    if (!requiredSurfaces.includes(surface)) {
      throw new Error(
        `Official Source discovery uses unknown required-surface vocabulary: ${surface}.`,
      );
    }
    if (seed.resolutions[surface] === "") {
      assertDiscoveryStageSurface(html, discoveryKey, surface);
      records.set(surface, stageRecord(
        sourceLineage,
        surface,
        current.href,
        {
          kind: "retained_stage_request",
          label: discoveryKey,
          url: current.href,
          resolution: "",
        },
      ));
    }
  }
  const stageHtml = stripKnownPublisherNavigation(
    html,
    sourceLineage,
    current.href,
    "header-only",
  );
  const fusionPolicyRecords = sourceLineage === "fusion-world-en" &&
      discoveryKey === "rules"
    ? exactFusionPolicyStageRecords(stageHtml, current.href)
    : null;
  for (const record of fusionPolicyRecords ?? []) {
    records.set(record.surface, record);
  }
  const digimonHasExplicitHistoryLink = sourceLineage === "digimon-en" &&
    discoveryKey === "rules" &&
    /<a\b[^>]*href=["'][^"']*restriction_card[^"']*["'][^>]*>[\s\S]*?(?:history|previous|past)[\s\S]*?<\/a>/iu
      .test(stageHtml);
  for (const match of stageHtml.matchAll(
    /<a\b([^>]*)>([\s\S]*?)<\/a>/giu,
  )) {
    const href = htmlAttribute(match[1]!, "href");
    if (href === null) continue;
    const label = htmlText(match[2]!);
    let resolved: URL;
    try {
      resolved = new URL(decodeHtmlText(href), current);
    } catch {
      continue;
    }
    resolved.hash = "";
    if (!officialUrl(sourceLineage, resolved, "document")) continue;
    if (
      sourceLineage === "fusion-world-en" &&
      discoveryKey === "rules" &&
      fusionPolicyRecords !== null &&
      /histor|previous|past|effective|restriction|banned|limited|official rules/iu
        .test(`${label} ${resolved.pathname} ${resolved.search}`)
    ) {
      const retainedArchive = new Map([
        ["effective december 2025", "https://www.dbs-cardgame.com/fw/en/news/01_332.html"],
        ["effective july 2025", "https://www.dbs-cardgame.com/fw/en/news/01_239.html"],
        ["effective july 2024", "https://www.dbs-cardgame.com/fw/en/news/01_65.html"],
      ]);
      const exactRequired = fusionPolicyRecords.some(({ url }) =>
        url === resolved.href
      );
      if (
        exactRequired ||
        retainedArchive.get(label.toLocaleLowerCase()) === resolved.href
      ) {
        continue;
      }
      throw new Error(
        "Fusion World policy discovery contains an unrecognized sibling publication.",
      );
    }
    const surfaces = discoverySurfacesForStageLink(
      sourceLineage,
      discoveryKey,
      label,
      resolved,
      digimonHasExplicitHistoryLink,
    );
    for (const surface of surfaces) {
      if (!requiredSurfaces.includes(surface)) continue;
      if (
        fusionPolicyRecords !== null &&
        (surface === "legality-current" || surface === "legality-history")
      ) {
        continue;
      }
      if (records.has(surface)) {
        throw new Error(
          `Official Source discovery duplicates the ${surface} surface link.`,
        );
      }
      records.set(surface, stageRecord(
        sourceLineage,
        surface,
        resolved.href,
        {
          kind: "publisher_navigation",
          label: label.toLocaleLowerCase(),
          url: current.href,
          resolution: decodeHtmlText(href),
        },
      ));
    }
  }
  return [...records.values()].sort((left, right) =>
    requiredSurfaces.indexOf(left.surface) -
      requiredSurfaces.indexOf(right.surface)
  );
}

function exactFusionPolicyStageRecords(
  html: string,
  requestUrl: string,
): Array<ReturnType<typeof stageRecord>> | null {
  const retainedCurrent = html.match(
    /<a class="commonBtn" target="" href="([^"]+)">Banned\/Restricted Cards from Effective March 2026<\/a>/u,
  );
  const syntheticCurrent = html.match(
    /<a href="([^"]+)">Current banned and limited cards<\/a>/u,
  );
  const historyMarker =
    '<p class="xxSmallTitle">Application history of banned/restricted cards</p>';
  const historyStart = html.indexOf(historyMarker);
  const retainedHistory = historyStart < 0
    ? null
    : html.slice(historyStart + historyMarker.length).match(
      /<a class="commonBtn" target="" href="([^"]+)">(Effective March 2026)<\/a>/u,
    );
  const syntheticHistory = html.match(
    /<a href="([^"]+)">(Previous restriction history)<\/a>/u,
  );
  const current = retainedCurrent ?? syntheticCurrent;
  const history = retainedHistory ?? syntheticHistory;
  if (current === null && history === null) return null;
  if (current === null) {
    throw new Error("Fusion World current policy discovery is incomplete.");
  }
  if (history === null) {
    throw new Error("Fusion World policy history discovery is incomplete.");
  }
  return ([
    [
      "legality-current",
      current[1]!,
      "banned/restricted cards from effective march 2026",
    ],
    ["legality-history", history[1]!, history[2]!.toLocaleLowerCase()],
  ] as const).map(([surface, resolution, label]) => {
    const url = new URL(resolution, requestUrl);
    if (!exactFusionPolicySurfaceUrl(surface, url)) {
      throw new Error(
        "Fusion World policy discovery does not match its exact retained publication URL.",
      );
    }
    return stageRecord("fusion-world-en", surface, url.href, {
      kind: "publisher_navigation",
      label,
      url: requestUrl,
      resolution,
    });
  });
}

function assertDiscoveryStageSurface(
  html: string,
  discoveryKey: string,
  surface: string,
): void {
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu);
  const signal = title === null ? "" : htmlText(title[1]!);
  const expected = discoveryKey === "cards"
    ? /\bcard(?:s| list| search)?\b/iu
    : discoveryKey === "products"
      ? /\bproduct(?:s| list)?\b/iu
      : discoveryKey === "rules"
        ? /\brules?\b/iu
        : /\bnews\b/iu;
  if (!expected.test(signal)) {
    throw new Error(
      `Official Source ${surface} stage did not prove its publisher page identity.`,
    );
  }
}

function stageRecord(
  sourceLineage: string,
  surface: string,
  url: string,
  discoveredFrom: {
    kind: "publisher_navigation" | "retained_stage_request";
    label: string;
    url: string;
    resolution: string;
  },
) {
  return {
    id: `${sourceLineage}:${surface}`,
    surface,
    method: "GET" as const,
    url,
    headers: { accept: "text/html" as const },
    discovered_from: discoveredFrom,
  };
}

function discoverySurfacesForStageLink(
  sourceLineage: string,
  discoveryKey: string,
  label: string,
  url: URL,
  digimonHasExplicitHistoryLink = false,
): string[] {
  const signal = `${label} ${url.pathname} ${url.search}`.toLocaleLowerCase();
  if (discoveryKey === "cards") {
    if (sourceLineage === "digimon-en" && /cards\/index\.php|card list/u.test(signal)) {
      return ["card-list"];
    }
    if (sourceLineage.startsWith("gundam-") && /cards\/index\.php|find cards/u.test(signal)) {
      return ["packages"];
    }
    return [];
  }
  if (discoveryKey === "news" && /errata|correction/u.test(signal)) {
    return ["errata"];
  }
  if (discoveryKey !== "rules") return [];
  if (/errata|correction/u.test(signal)) return ["errata"];
  if (sourceLineage === "one-piece-en") {
    if (/block(?:_|\s|-)?icon|block policy/u.test(signal)) return ["block-policy"];
    if (/restriction|banned|limited/u.test(signal)) return ["restrictions"];
  }
  if (
    sourceLineage === "fusion-world-en" &&
    /histor|previous|past|restriction|banned|limited|official rules/u.test(signal)
  ) {
    throw new Error(
      "Fusion World policy discovery requires its exact retained publication mapping.",
    );
  }
  if (sourceLineage === "digimon-en") {
    if (/histor|previous|past/u.test(signal)) return ["restrictions-history"];
    if (/restriction|banned|limited/u.test(signal)) {
      return url.pathname === "/rule/restriction_card/"
          && !digimonHasExplicitHistoryLink
        ? ["restrictions-current", "restrictions-history"]
        : ["restrictions-current"];
    }
  }
  return [];
}

function bandaiDiscoverySeeds(sourceLineage: string): ReadonlyArray<{
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
  }> = sourceLineage === "one-piece-en"
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
          restrictions: "restriction/",
          "block-policy": "block_icon/",
          errata: "errata_card/",
          "don-rules": "",
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
            "legality-current": "../rules/banned-limited-cards/",
            "legality-history": "../rules/banned-limited-cards/",
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
              "restrictions-current": "restriction_card/",
              "restrictions-history": "restriction_card/",
              errata: "errata_card/",
            },
          },
        ]
        : sourceLineage === "gundam-en-asia" ||
            sourceLineage === "gundam-en-us"
          ? (() => {
            const locale = sourceLineage === "gundam-en-asia"
              ? "asia-en"
              : "en";
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
                resolutions: { legality: "" },
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
    throw new Error(
      `Official Source discovery has no navigation grammar for ${sourceLineage}.`,
    );
  }
  return seeds;
}

function bandaiPublisherPayload(
  html: string,
  sourceLineage: string,
  surface: string,
): Record<string, unknown> | null {
  const expectedId = publisherPayloadScriptId(sourceLineage, surface);
  const matches = [...html.matchAll(
    /<script\b([^>]*)>([\s\S]*?)<\/script>/giu,
  )].filter((match) => htmlAttribute(match[1]!, "id") === expectedId);
  if (matches.length > 1) {
    throw new Error(`Official Source ${surface} publisher data is duplicated.`);
  }
  const match = matches[0];
  if (match === undefined) return null;
  if (htmlAttribute(match[1]!, "type") !== "application/json") {
    throw new Error(`Official Source ${surface} publisher data has the wrong media type.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(match[2]!);
  } catch {
    throw new Error(`Official Source ${surface} publisher data is invalid JSON.`);
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

function assertDigimonPayloadAtCompleteLeaf(
  payload: Record<string, unknown>,
  requestUrl: string,
): void {
  if (!digimonPayloadContainsCatalogueFacts(payload)) return;
  assertCompleteDigimonLeafUrl(requestUrl);
}

function assertCompleteDigimonLeafUrl(requestUrl: string): void {
  if (!isCompleteDigimonLeafUrl(requestUrl)) {
    throw new Error(
      "Official Source Digimon catalogue facts require a complete Digimon leaf with exact category, cardcategory, and color facets.",
    );
  }
}

function isCompleteDigimonLeafUrl(requestUrl: string): boolean {
  const url = new URL(requestUrl);
  const exactFacet = (name: string) =>
    url.searchParams.getAll(name).length === 1 &&
    url.searchParams.get(name)?.trim() !== "";
  const exactColourFacet =
    Number(exactFacet("color")) + Number(exactFacet("colour")) === 1;
  return url.pathname === "/cards/index.php" &&
    exactFacet("category") &&
    exactFacet("cardcategory") &&
    exactColourFacet;
}

function digimonPopupRecordCount(html: string): number {
  return [...html.matchAll(
    /<li\b[^>]*\bclass=["'][^"']*\bimage_lists_item\b[^"']*\bdata\b[^"']*["'][^>]*>/giu,
  )].length;
}

function digimonPayloadContainsCatalogueFacts(
  payload: Record<string, unknown>,
): boolean {
  const populated = (value: unknown) => Array.isArray(value) && value.length > 0;
  if (
    populated(payload.card_popups) ||
    populated(payload.products) ||
    populated(payload.release_calendar)
  ) return true;
  if (payload.result === null || typeof payload.result !== "object") return false;
  const partitions = (payload.result as Record<string, unknown>).partitions;
  return Array.isArray(partitions) && partitions.some((partition) =>
    partition !== null &&
    typeof partition === "object" &&
    populated((partition as Record<string, unknown>).entries)
  );
}

function publisherPayloadScriptId(
  sourceLineage: string,
  surface: string,
): string {
  return `${publisherPayloadScriptPrefix(sourceLineage)}-${surface}-data`;
}

function publisherPayloadScriptPrefix(sourceLineage: string): string {
  const prefix = sourceLineage === "one-piece-en"
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
    throw new Error(`Official Source publisher data has no grammar for ${sourceLineage}.`);
  }
  return prefix;
}

function surfaceFromContext(
  context: { url: string; requestId?: string },
  sourceLineage: string,
  requiredSurfaces: readonly string[],
  urls: Readonly<Record<string, string>>,
): string {
  const prefix = `${sourceLineage}:`;
  if (context.requestId?.startsWith(prefix)) {
    const surface = context.requestId.slice(prefix.length);
    if (
      requiredSurfaces.includes(surface) &&
      exactSurfaceDocumentUrl(sourceLineage, surface, context.url)
    ) {
      return surface;
    }
    throw new Error(
      `Official Source Request identity does not match the ${sourceLineage} URL contract.`,
    );
  }
  const matches = requiredSurfaces.filter(
    (surface) => new URL(urls[surface]!).href === new URL(context.url).href,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Official Source URL does not identify one exact ${sourceLineage} surface.`,
    );
  }
  return matches[0]!;
}

function exactSurfaceDocumentUrl(
  sourceLineage: string,
  surface: string,
  requestUrl: string,
): boolean {
  const url = new URL(requestUrl);
  if (!officialUrl(sourceLineage, url, "document")) return false;
  if (
    sourceLineage === "fusion-world-en" &&
    (surface === "legality-current" || surface === "legality-history")
  ) {
    return exactFusionPolicySurfaceUrl(surface, url);
  }
  return true;
}

function exactFusionPolicySurfaceUrl(surface: string, url: URL): boolean {
  const exact = surface === "legality-current"
    ? [
      "https://www.dbs-cardgame.com/fw/en/news/01_305.html",
    ]
    : surface === "legality-history"
      ? [
        "https://www.dbs-cardgame.com/fw/en/news/01_399.html",
      ]
      : [];
  return exact.includes(url.href);
}

function activeBandaiSurfaceUrls(
  sourceLineage: string,
  urls: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return sourceLineage === "fusion-world-en"
    ? {
      ...urls,
      "legality-current":
        "https://www.dbs-cardgame.com/fw/en/news/01_305.html",
      "legality-history":
        "https://www.dbs-cardgame.com/fw/en/news/01_399.html",
    }
    : urls;
}

function decodeUtf8(bytes: Uint8Array, surface: string): string {
  try {
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes);
  } catch {
    throw new Error(`Official Source ${surface} bytes are not valid UTF-8.`);
  }
}

type ParsedBandaiSurface = {
  observations: readonly Record<string, unknown>[];
  retainedDocument: Record<string, unknown>;
  consumedFields: readonly string[];
};

function parseOnePieceBandaiCardListV1(
  html: string,
  requestUrl: string,
  expandedOnePieceCatalogue = false,
): ParsedBandaiSurface {
  const recordingSelect = expandedOnePieceCatalogue
    ? html.match(
        /<select\b[^>]*\b(?:id|name)=["']series["'][^>]*>([\s\S]*?)<\/select>/iu,
      )
    : html.match(
        /<select\b[^>]*\b(?:id|name)=["']recording["'][^>]*>([\s\S]*?)<\/select>/iu,
      );
  if (recordingSelect === null) {
    throw new Error("One Piece Card List Recording discovery is unavailable.");
  }
  const declaredMatch = html.match(
    /<div\b[^>]*\bclass=["'][^"']*\bcountCol\b[^"']*["'][^>]*>\s*(\d+)\s+results?\s*<\/div>/iu,
  );
  if (declaredMatch === null) {
    throw new Error("One Piece Card List result count is unavailable.");
  }
  const recordings = [...recordingSelect[1]!.matchAll(
    /<option\b[^>]*\bvalue=["']([^"']+)["'][^>]*>([\s\S]*?)<\/option>/giu,
  )]
    .filter((match) => /^\d+$/u.test(match[1]!))
    .map((match) => ({
      value: decodeHtmlText(match[1]!),
      label: htmlText(match[2]!),
    }));
  if (recordings.length === 0) {
    throw new Error("One Piece Card List Recording discovery is empty.");
  }
  const modalMatches = [...html.matchAll(
    /<dl\b[^>]*\bclass=["'][^"']*\bmodalCol\b[^"']*["'][^>]*\s+id=["']([^"']+)["'][^>]*>([\s\S]*?)<\/dl>/giu,
  )];
  const declaredCount = Number.parseInt(declaredMatch[1]!, 10);
  if (modalMatches.length !== declaredCount) {
    throw new Error(
      "One Piece Card List declared and parsed record counts differ.",
    );
  }
  const base = new URL(requestUrl);
  const recordingKey = expandedOnePieceCatalogue ? "series" : "recording";
  const recordingValues = base.searchParams.getAll(recordingKey);
  if (expandedOnePieceCatalogue && recordingValues.length > 1) {
    throw new Error("One Piece Card List Recording identity is duplicated.");
  }
  const recording = recordingValues[0] ?? null;
  if (recording !== null && !/^\d+$/u.test(recording)) {
    throw new Error("One Piece Card List Recording identity is invalid.");
  }
  const schemaReviewValues: {
    locator: string;
    field: string;
    value: string;
  }[] = [];
  const observations = modalMatches.map((match) => {
    const locator = decodeHtmlText(match[1]!);
    const body = match[2]!;
    const info = requiredHtmlMatch(
      body,
      /<div\b[^>]*\bclass=["'][^"']*\binfoCol\b[^"']*["'][^>]*>\s*<span>([\s\S]*?)<\/span>\s*\|\s*<span>([\s\S]*?)<\/span>\s*\|\s*<span>([\s\S]*?)<\/span>/iu,
      "One Piece Card identity",
    );
    const cardNumber = htmlText(info[1]!);
    const rarity = htmlText(info[2]!);
    const cardType = htmlText(info[3]!).toLowerCase();
    const name = htmlText(
      requiredHtmlMatch(
        body,
        /<div\b[^>]*\bclass=["'][^"']*\bcardName\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/iu,
        "One Piece Card name",
      )[1]!,
    );
    const imagePath = decodeHtmlText(
      requiredHtmlMatch(
        body,
        /<div\b[^>]*\bclass=["'][^"']*\bfrontCol\b[^"']*["'][^>]*>[\s\S]*?<img\b[^>]*\bdata-src=["']([^"']+)["']/iu,
        "One Piece Printing image",
      )[1]!,
    );
    const imageUrl = new URL(imagePath, base).href;
    const pairs = htmlLabelPairs(body);
    const field = (...labels: string[]): string | null =>
      firstLabelValue(pairs, labels);
    const effect = requiredNullableText(
      field("Effect", "Card Text", "Text"),
      "Official effect",
    );
    const setLabel =
      field("Card Set(s)", "Where to get it") ?? "Unclassified Card List";
    const colour = requiredNullableText(
      field("Color", "Colour"),
      "Official colour",
    );
    const variant =
      locator === cardNumber ? "base" : locator.slice(cardNumber.length);
    const modalTag = match[0]!.slice(0, match[0]!.indexOf(">") + 1);
    const artworkId =
      htmlAttribute(modalTag, "data-artwork-id") ??
      field("Artwork ID", "Artwork Identifier", "Illustration ID");
    const rawTreatment =
      htmlAttribute(modalTag, "data-artwork-treatment") ??
      field("Artwork Treatment", "Treatment");
    const treatment = officialArtworkTreatment(rawTreatment);
    if (rawTreatment !== null && treatment === null) {
      schemaReviewValues.push({
        locator,
        field: "One Piece artwork treatment",
        value: rawTreatment,
      });
    }
    const normalizedRarity = rarity.length === 0
      ? null
      : expandedOnePieceCatalogue
        ? normalizedOnePieceRarity(rarity)
        : rarity.toLowerCase();
    if (expandedOnePieceCatalogue) {
      for (const pair of pairs.filter(({ label }) =>
        !onePieceKnownCardListLabel(label)
      )) {
        schemaReviewValues.push({
          locator,
          field: pair.label,
          value: pair.value,
        });
      }
    }
    const artworkFingerprint = officialArtworkFingerprint(
      cardNumber,
      ["front"],
      artworkId,
    );
    const printedFieldsDigest = `printed-material:${
      JSON.stringify(stableValue({
        card_number: cardNumber,
        rarity,
        card_type: cardType,
        rules: effect ?? "",
        colour,
        cost: field("Cost"),
        life: field("Life"),
        attribute: field("Attribute"),
        power: field("Power"),
        counter: field("Counter"),
        feature: field("Type", "Traits"),
        block: field("Block icon", "Block"),
        trigger: field("Trigger"),
      }))
    }`;
    const cost = integerOrNull(field("Cost"));
    const life = expandedOnePieceCatalogue
      ? integerOrNull(field("Life"))
      : cardType === "leader" ? integerOrNull(field("Life")) : null;
    if (expandedOnePieceCatalogue) {
      assertOnePieceTypeNullability(cardType, cost, life);
    }
    const detail = {
      path: locator,
      number: cardNumber,
      title: name,
      rules: effect ?? "",
      profile: "one-piece@1",
      attributes: {
        card_type: cardType,
        colours: colour === null
          ? []
          : colour.split("/").map((value) => value.trim().toLowerCase()),
        cost,
        life,
        battle_attributes: textValues(field("Attribute")).map((value) =>
          expandedOnePieceCatalogue ? value.toLocaleLowerCase() : value
        ),
        power: integerOrNull(field("Power")),
        counter: integerOrNull(field("Counter")),
        traits: textValues(field("Type", "Traits")),
        block_icons: textValues(field("Block icon", "Block")),
        effect_text: effect,
        trigger_text: requiredNullableText(
          field("Trigger"),
          "Official trigger",
        ),
      },
      product_codes: [],
      distribution: {
        code: `card-set:${setLabel}`,
        kind: "source_bucket",
        label: setLabel,
      },
      printing: {
        rarity: rarity.length === 0 ? null : rarity,
        normalizedRarity,
        attributes: expandedOnePieceCatalogue
          ? {}
          : { illustration_types: [] },
      },
      treatment,
      printed_rules: effect ?? "",
      variant,
      artwork_fingerprint: artworkFingerprint,
      printed_fields_digest: printedFieldsDigest,
      image: imageUrl,
      images: [{
        role: "front",
        source_url: imageUrl,
        artwork_fingerprint: artworkFingerprint,
      }],
    };
    const observation = cardObservation(
      detail,
      [],
      new Map(),
      { revision: "captured-by-policy-surface", entries: [] },
      { revision: "captured-by-policy-surface", entries: [] },
      "one-piece",
    );
    return !expandedOnePieceCatalogue || recording === null
      ? observation
      : {
          ...observation,
          memberships: {
            ...requiredRecord(
              observation.memberships,
              "One Piece Recording memberships",
            ),
            source_buckets: [`recording:${recording}`],
          },
        };
  });
  return {
    observations,
    retainedDocument: {
      page: "card-list",
      recording_options: recordings,
      declared_record_count: declaredCount,
      parsed_locators: modalMatches.map((match) => decodeHtmlText(match[1]!)),
      ...(expandedOnePieceCatalogue
        ? {
            raw_label_pairs: modalMatches.flatMap((match) =>
              htmlLabelPairs(match[2]!).map(({ label, value }) => ({
                locator: decodeHtmlText(match[1]!),
                label,
                value,
              }))
            ),
          }
        : {}),
      ...(schemaReviewValues.length === 0
        ? {}
        : { schema_review_values: schemaReviewValues }),
    },
    consumedFields: [
      "page",
      "recording_options",
      "declared_record_count",
      "parsed_locators",
      ...(expandedOnePieceCatalogue ? ["raw_label_pairs"] : []),
    ],
  };
}

function onePieceKnownCardListLabel(label: string): boolean {
  return [
    "Effect", "Card Text", "Text", "Card Set(s)", "Where to get it",
    "Color", "Colour", "Cost", "Life", "Attribute", "Power", "Counter",
    "Type", "Traits", "Block icon", "Block", "Trigger", "Artwork ID",
    "Artwork Identifier", "Illustration ID", "Artwork Treatment", "Treatment",
  ].some((known) =>
    known.localeCompare(label, undefined, { sensitivity: "accent" }) === 0
  );
}

function assertOnePieceTypeNullability(
  cardType: string,
  cost: number | null,
  life: number | null,
): void {
  if (cardType === "leader" && cost !== null) {
    throw new Error("One Piece Leader cost must be null.");
  }
  if (cardType !== "leader" && life !== null) {
    throw new Error(`One Piece ${cardType} life must be null.`);
  }
  if (cardType !== "leader" && cost === null) {
    throw new Error(`One Piece ${cardType} cost must be non-null.`);
  }
  if (cardType === "leader" && life === null) {
    throw new Error("One Piece Leader life must be non-null.");
  }
}

function parseBandaiCardDetailV1(
  html: string,
  format: DiscoveryFormat,
  sourceLineage: string,
  requestUrl: string,
): Record<string, unknown> {
  return parseBandaiCardDetailFrozenV1(
    html,
    format,
    sourceLineage,
    requestUrl,
    "hostname-v1",
  );
}

function parseBandaiCardDetailV2(
  html: string,
  format: DiscoveryFormat,
  sourceLineage: string,
  requestUrl: string,
): Record<string, unknown> {
  return parseBandaiCardDetailFrozenV1(
    html,
    format,
    sourceLineage,
    requestUrl,
    "path-v2",
  );
}

function parseFusionWorldCardDetailV3(
  html: string,
  sourceLineage: string,
  requestUrl: string,
): Record<string, unknown> {
  const pairs = htmlLabelPairs(html);
  const cardNumber = firstLabelValue(
    pairs,
    ["Card Number", "Card No.", "Card No", "No."],
  );
  if (cardNumber === null) {
    throw new Error("Fusion World Card detail is missing its Card Number.");
  }
  const request = new URL(requestUrl);
  const requestedLocator = fusionWorldFullLocatorFromUrl(
    request,
    request.searchParams.has("card_no"),
  );
  if (requestedLocator === null) {
    throw new Error("Fusion World detail request has no full locator.");
  }
  const identity = fusionWorldLocatorIdentity(requestedLocator);
  if (identity.cardNumber !== cardNumber.normalize("NFC").trim()) {
    throw new Error(
      `Fusion World full locator ${requestedLocator} does not match Card number ${cardNumber}.`,
    );
  }
  const dataCardId = htmlAttribute(
    html.match(/<[^>]*\bdata-card-id=["'][^"']+["'][^>]*>/iu)?.[0] ?? "",
    "data-card-id",
  );
  if (dataCardId !== requestedLocator) {
    throw new Error(
      `Fusion World full locator ${requestedLocator} and data-card-id must match exactly.`,
    );
  }
  request.search = "";
  request.searchParams.set("cardId", identity.cardNumber);
  return parseBandaiCardDetailFrozenV1(
    html,
    "fusion-world",
    sourceLineage,
    request.href,
    "path-v2",
  );
}

function fusionWorldLocatorIdentity(value: string): {
  cardNumber: string;
  variant: string;
} {
  const match = value.match(
    /^([A-Z]{1,6}\d{0,3}-[A-Z0-9]{1,6})(_[A-Za-z0-9-]+)?$/u,
  );
  if (match === null) {
    throw new Error(`Fusion World full locator ${value} is invalid.`);
  }
  return {
    cardNumber: match[1]!,
    variant: match[2] ?? "base",
  };
}

/**
 * Frozen V1 card-detail decoder foundation. Historical registrations always
 * select hostname-v1. Newer registrations may only layer stricter authority
 * through their versioned entry point above.
 */
function parseBandaiCardDetailFrozenV1(
  html: string,
  format: DiscoveryFormat,
  sourceLineage: string,
  requestUrl: string,
  imageAuthority: "hostname-v1" | "path-v2",
): Record<string, unknown> {
  const pairs = htmlLabelPairs(html);
  const field = (names: readonly string[]): string | null =>
    firstLabelValue(pairs, names);
  const pageText = htmlText(html);
  const cardNumber =
    field(["Card Number", "Card No.", "Card No", "No."]) ??
    pageText.match(/\b[A-Z]{1,6}\d{0,2}-\d{2,5}\b/u)?.[0] ??
    null;
  const name =
    field(["Card Name", "Name"]) ??
    htmlText(
      html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/iu)?.[1] ??
        html.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/iu)?.[1] ??
        "",
    );
  const cardType = field(["Card Type", "Type", "Category"]);
  const colour = field(["Color", "Colour"]);
  const rules = field(["Effect", "Skill", "Card Text", "Text"]);
  if (
    cardNumber === null ||
    name.length === 0 ||
    cardType === null ||
    colour === null
  ) {
    throw new Error(
      `${sourceLineage} Card detail is missing Card Number, name, Card Type, or Color.`,
    );
  }
  const discoveredImageUrls = [...html.matchAll(/<img\b([^>]*)>/giu)]
    .flatMap((match) => {
      const attributes = match[1]!;
      const rawUrl =
        htmlAttribute(attributes, "data-src") ??
        htmlAttribute(attributes, "src");
      if (
        rawUrl === null ||
        !/\.(?:avif|gif|jpe?g|png|webp)(?:$|\?)/iu.test(rawUrl)
      ) {
        return [];
      }
      const roleMarker = [
        htmlAttribute(attributes, "class"),
        htmlAttribute(attributes, "id"),
        htmlAttribute(attributes, "data-face"),
        htmlAttribute(attributes, "data-role"),
      ].filter((value): value is string => value !== null).join(" ");
      if (
        !/(?:card|face|front|back|image|pic)/iu.test(roleMarker) &&
        !rawUrl.toLocaleLowerCase().includes(
          cardNumber.toLocaleLowerCase(),
        )
      ) {
        return [];
      }
      const resolved = new URL(decodeHtmlText(rawUrl), requestUrl).href;
      return (imageAuthority === "hostname-v1"
          ? officialHostname(sourceLineage, new URL(resolved).hostname)
          : officialUrl(sourceLineage, new URL(resolved), "image"))
        ? [resolved]
        : [];
    });
  if (discoveredImageUrls.length === 0) {
    throw new Error(`${sourceLineage} Card detail has no Printing Image URL.`);
  }
  const requestedCardIdentity = [...new URL(requestUrl).searchParams.entries()]
    .find(([key]) =>
      /^(?:card(?:id|no|number)?|detailSearch|popup)$/iu.test(key)
    )?.[1];
  if (
    requestedCardIdentity !== undefined &&
    requestedCardIdentity.normalize("NFC").trim().toLocaleUpperCase() !==
      cardNumber.normalize("NFC").trim().toLocaleUpperCase()
  ) {
    throw new Error(
      `${sourceLineage} requested Card identity does not match the parsed Card Number.`,
    );
  }
  const locator =
    htmlAttribute(
      html.match(/<[^>]*\bdata-(?:card-id|popup-id|detail-search)=["'][^"']+["'][^>]*>/iu)?.[0] ??
        "",
      "data-card-id",
    ) ??
    htmlAttribute(
      html.match(/<[^>]*\bdata-popup-id=["'][^"']+["'][^>]*>/iu)?.[0] ?? "",
      "data-popup-id",
    ) ??
    htmlAttribute(
      html.match(/<[^>]*\bdata-detail-search=["'][^"']+["'][^>]*>/iu)?.[0] ??
        "",
      "data-detail-search",
    ) ??
    [...new URL(requestUrl).searchParams.entries()]
      .find(([key]) =>
        /^(?:card(?:id|no|number)?|detailSearch|id|popup)$/iu.test(key)
      )?.[1] ??
    cardNumber;
  const normalizedType = cardType.toLowerCase().replace(/\s+/gu, "_");
  const fusionFaces =
    format === "fusion-world" && normalizedType === "leader"
      ? explicitFusionLeaderFaces(
          html,
          requestUrl,
          sourceLineage,
          imageAuthority,
        )
      : null;
  const imageEvidence =
    fusionFaces === null
      ? [{
          role: "front" as const,
          source_url: discoveredImageUrls[0]!,
        }]
      : fusionFaces.map(({ role, imageUrl }) => ({
          role,
          source_url: imageUrl,
        }));
  const colours = colour === "-"
    ? format === "fusion-world" || format === "gundam"
      ? ["colourless"]
      : []
    : colourValues(colour);
  const attributes =
    format === "one-piece"
      ? {
          card_type: normalizedType,
          colours,
          cost: integerOrNull(field(["Cost"])),
          life: normalizedType === "leader"
            ? integerOrNull(field(["Life"]))
            : null,
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
            specified_cost: specifiedCosts(
              field(["Specified Cost", "Specified cost"]),
            ),
            power: integerOrNull(field(["Power"])),
            combo_power: integerOrNull(field(["Combo Power"])),
            traits: textValues(field(["Special Trait", "Traits"])),
            skills: [
              ...(rules === null
                ? []
                : [{ kind: "ordinary", text: rules }]),
            ],
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
                allLabelValues(
                  pairs,
                  ["Digivolve", "Digivolution Cost", "Evolution Cost"],
                ),
              ),
              text_sections: digimonTextSections(pairs),
              dual_colours: colourValues(
                field(["DUAL Color", "Dual Color"]),
              ),
              dual_cost: integerOrNull(
                field(["DUAL Cost", "Dual Cost"]),
              ),
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
      ? officialBoolean(
          alternateArtworkValue,
          "Digimon Alternative Art",
        )
      : format === "gundam"
        ? officialBoolean(
            alternateArtworkValue,
            "Gundam Alternate Art",
          )
        : null;
  const artworkId =
    htmlAttribute(
      html.match(/<[^>]*\bdata-artwork-id=["'][^"']+["'][^>]*>/iu)?.[0] ?? "",
      "data-artwork-id",
    ) ??
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
          code: `detail:${new URL(requestUrl).pathname}`,
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
      normalizedRarity: field(["Rarity"])?.toLowerCase() ?? null,
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
    treatment:
      alternateArtworkValue === null
        ? null
        : alternateArtwork
          ? "alternate"
          : "standard",
    printed_rules: rules,
    variant: locator === cardNumber
      ? "base"
      : locator.slice(cardNumber.length) || locator,
    artwork_fingerprint: artworkFingerprint,
    printed_fields_digest: `printed-material:${
      JSON.stringify(stableValue({ rules, attributes }))
    }`,
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
  const faces = [...html.matchAll(
    /<(section|div)\b([^>]*\bdata-face=["'](front|back)["'][^>]*)>([\s\S]*?)<\/\1>/giu,
  )].map((match) => {
    const role = match[3]!.toLowerCase() as "front" | "back";
    const body = match[4]!;
    const pairs = htmlLabelPairs(body);
    const imageMatches = [...body.matchAll(
      /<img\b[^>]*\b(?:data-src|src)=["']([^"']+\.(?:avif|gif|jpe?g|png|webp)(?:\?[^"']*)?)["']/giu,
    )]
      .map((image) => new URL(decodeHtmlText(image[1]!), requestUrl).href)
      .filter((url) => imageAuthority === "hostname-v1"
        ? officialHostname(sourceLineage, new URL(url).hostname)
        : officialUrl(sourceLineage, new URL(url), "image"));
    if (imageMatches.length !== 1) {
      throw new Error(
        `Fusion World Leader ${role} face requires exactly one role-specific image.`,
      );
    }
    const faceName =
      firstLabelValue(pairs, ["Name", "Card Name"]) ??
      htmlText(
        body.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/iu)?.[1] ?? "",
      );
    if (faceName.length === 0) {
      throw new Error(`Fusion World Leader ${role} face name is missing.`);
    }
    return {
      role,
      name: faceName,
      power: integerOrNull(firstLabelValue(pairs, ["Power"])),
      traits: textValues(
        firstLabelValue(pairs, ["Special Trait", "Traits"]),
      ),
      skills:
        firstLabelValue(pairs, ["Skill", "Effect", "Card Text"]) ?? "",
      imageUrl: imageMatches[0]!,
    };
  });
  if (
    faces.length !== 2 ||
    faces.filter(({ role }) => role === "front").length !== 1 ||
    faces.filter(({ role }) => role === "back").length !== 1
  ) {
    throw new Error(
      "Fusion World Leader requires explicit front and back face containers.",
    );
  }
  return faces.sort((left, right) =>
    (left.role === "front" ? 0 : 1) - (right.role === "front" ? 0 : 1)
  );
}

function productLinksFromHtml(
  html: string,
  requestUrl: string,
): {
  products: { code: string; title: string }[];
  fuzzyLabels: string[];
} {
  const products = [...html.matchAll(
    /<a\b([^>]*\bdata-product-code=["']([^"']+)["'][^>]*)>([\s\S]*?)<\/a>/giu,
  )].map((match) => {
    const href = htmlAttribute(match[1]!, "href");
    if (href === null) {
      throw new Error("An explicit Product link has no official href.");
    }
    const url = new URL(decodeHtmlText(href), requestUrl);
    if (url.protocol !== "https:") {
      throw new Error("An explicit Product link is not HTTPS.");
    }
    return {
      code: decodeHtmlText(match[2]!).normalize("NFC").trim(),
      title: htmlText(match[3]!),
    };
  });
  for (const product of products) {
    if (product.code.length === 0 || product.title.length === 0) {
      throw new Error(
        "An explicit Product link requires code and title evidence.",
      );
    }
  }
  const fuzzyLabels = [...html.matchAll(
    /<a\b([^>]*\bclass=["'][^"']*\bproduct-link\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/giu,
  )]
    .filter((match) => htmlAttribute(match[1]!, "data-product-code") === null)
    .map((match) => htmlText(match[2]!))
    .filter((label) => label.length > 0);
  return {
    products: [
      ...new Map(products.map((product) => [product.code, product])).values(),
    ].sort((left, right) => left.code.localeCompare(right.code)),
    fuzzyLabels: [...new Set(fuzzyLabels)].sort(),
  };
}

function parseBandaiProductDetailFrozenV1(
  html: string,
  sourceLineage: string,
  requestUrl: string,
): Record<string, unknown> {
  const pairs = htmlLabelPairs(html);
  const field = (...names: string[]): string | null =>
    firstLabelValue(pairs, names);
  const code =
    htmlAttribute(
      html.match(/<[^>]*\bdata-product-code=["'][^"']+["'][^>]*>/iu)?.[0] ??
        "",
      "data-product-code",
    ) ??
    field("Product Code");
  const title = htmlText(
    html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/iu)?.[1] ??
      html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu)?.[1] ??
      "",
  );
  if (title.length === 0) {
    throw new Error(
      `${sourceLineage} Product detail is missing its official title.`,
    );
  }
  const nonCardClassification = nonCardProductClassification(
    `${requestUrl} ${title}`,
  );
  if (nonCardClassification !== null) {
    const rawDocument = Object.fromEntries(
      pairs.map(({ label, value }) => [label, value]),
    );
    return attachRawSurfaceEvidenceV1(
      {
        completeness: completeObservation(),
        product_release_catalogue: {
          products: [],
          distribution_contexts: [{
            key:
              `non-card:${nonCardClassification}:${
                (code ?? title).normalize("NFC").trim().toLocaleLowerCase()
              }`,
            kind: "other",
            label: nonCardClassification,
            evidence_category: "explicit",
          }],
          relationships: [],
        },
      },
      sourceLineage,
      "product-detail",
      rawDocument,
      true,
      ["Product Code"],
    );
  }
  const product = { code, title };
  const releaseDate = field("Release Date", "Available Date", "On Sale");
  const releaseStatus = field("Status");
  const releases = new Map<string, Record<string, unknown>[]>();
  if (releaseDate !== null) {
    const date = normalizedOfficialReleaseDate(releaseDate);
    releases.set(productMapKey(product), [{
      event_key:
        field("Release Event ID", "Release ID", "Event ID") ??
        productEventKey("product-release", product),
      region: normalizedOfficialRegion(
        field("Region", "Market", "Territory"),
        sourceLineage,
      ),
      precision: date.precision,
      date: date.value,
      status: normalizedOfficialReleaseStatus(releaseStatus),
    }]);
  }
  const observation = productOnlyObservation(
    product,
    releases,
    { revision: "captured-by-policy-surface", entries: [] },
    { revision: "captured-by-policy-surface", entries: [] },
  );
  return attachRawSurfaceEvidenceV1(
    observation,
    sourceLineage,
    "product-detail",
    Object.fromEntries(pairs.map(({ label, value }) => [label, value])),
    true,
    [
      "Product Code",
      ...(officialReleaseDateNeedsSchemaReview(releaseDate)
        ? []
        : ["Release Date", "Available Date", "On Sale"]),
      "Release Event ID",
      "Release ID",
      "Event ID",
      "Region",
      "Market",
      "Territory",
      ...(officialReleaseStatusNeedsSchemaReview(releaseStatus)
        ? []
        : ["Status"]),
    ],
  );
}

function parseBandaiProductDetailV2(
  html: string,
  sourceLineage: string,
  requestUrl: string,
): Record<string, unknown> {
  return parseBandaiProductDetailFrozenV1(html, sourceLineage, requestUrl);
}

function normalizedOfficialRegion(
  value: string | null,
  sourceLineage: string,
): "EN-OCEANIA" | "EN-ASIA" | "EN-US" | "unknown" {
  const normalized = value?.normalize("NFC").trim().toLocaleLowerCase() ?? "";
  if (
    /^(?:en[- ]?us|us|usa|united states|north america)$/u.test(normalized)
  ) {
    return "EN-US";
  }
  if (/^(?:en[- ]?asia|asia|south east asia|southeast asia)$/u.test(normalized)) {
    return "EN-ASIA";
  }
  if (
    /^(?:en[- ]?oceania|oceania|australia|australia\/new zealand)$/u.test(
      normalized,
    )
  ) {
    return "EN-OCEANIA";
  }
  if (normalized.length === 0) {
    if (sourceLineage === "gundam-en-us") return "EN-US";
    if (sourceLineage === "gundam-en-asia") return "EN-ASIA";
  }
  return "unknown";
}

function labelledHtmlValue(html: string, label: string): string | null {
  return htmlLabelPairs(html)
    .find(({ label: candidate }) =>
      candidate.localeCompare(label, undefined, { sensitivity: "accent" }) === 0
    )?.value ?? null;
}

function htmlLabelPairs(
  html: string,
): { label: string; value: string }[] {
  const pairs: { label: string; value: string }[] = [];
  for (const match of html.matchAll(
    /<(?:dt|th)\b[^>]*>([\s\S]*?)<\/(?:dt|th)>\s*<(?:dd|td)\b[^>]*>([\s\S]*?)<\/(?:dd|td)>/giu,
  )) {
    pairs.push({
      label: htmlText(match[1]!).replace(/:$/u, "").trim(),
      value: htmlText(match[2]!),
    });
  }
  for (const match of html.matchAll(
    /<([a-z][a-z0-9]*)\b([^>]*\bdata-field=["']([^"']+)["'][^>]*)>([\s\S]*?)<\/\1>/giu,
  )) {
    pairs.push({
      label: decodeHtmlText(match[3]!).replace(/:$/u, "").trim(),
      value: htmlText(match[4]!),
    });
  }
  for (const match of html.matchAll(
    /<div\b[^>]*>\s*<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>([\s\S]*?)<\/div>/giu,
  )) {
    pairs.push({
      label: htmlText(match[1]!).replace(/:$/u, "").trim(),
      value: htmlText(match[2]!),
    });
  }
  return pairs.filter(({ label }) => label.length > 0);
}

function firstLabelValue(
  pairs: readonly { label: string; value: string }[],
  names: readonly string[],
): string | null {
  for (const name of names) {
    const found = pairs.find(({ label }) =>
      label.localeCompare(name, undefined, { sensitivity: "accent" }) === 0
    );
    if (found !== undefined) return found.value;
  }
  return null;
}

function allLabelValues(
  pairs: readonly { label: string; value: string }[],
  names: readonly string[],
): string[] {
  return pairs
    .filter(({ label }) =>
      names.some((name) =>
        label.localeCompare(name, undefined, { sensitivity: "accent" }) === 0
      )
    )
    .map(({ value }) => value)
    .filter((value) => value.length > 0 && value !== "-");
}

function parseBandaiSurfaceCoverageV1(
  html: string,
  format: DiscoveryFormat,
  sourceLineage: string,
  surface: string,
  url: string,
): ParsedBandaiSurface {
  const text = htmlText(html);
  if (
    surface === "listing" &&
    /(?:too many search results|more than 1,?000|results? (?:were )?capped)/iu
      .test(text) &&
    discoveredPartitionRequests(format, html, new URL(url)).length === 0
  ) {
    throw new Error(
      "Official Source leaf partition still displays its result-cap signal.",
    );
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
    throw new Error(
      `Official Source ${surface} HTML does not contain its expected Bandai publication.`,
    );
  }
  const publicationLinks = [...html.matchAll(
    /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu,
  )]
    .map((match) => ({
      url: new URL(decodeHtmlText(match[1]!), url).href,
      label: htmlText(match[2]!),
    }))
    .filter(({ label }) => label.length > 0);
  const discoveredOptions = [...html.matchAll(
    /<option\b[^>]*\bvalue=["']([^"']*)["'][^>]*>([\s\S]*?)<\/option>/giu,
  )]
    .map((match) => ({
      value: decodeHtmlText(match[1]!),
      label: htmlText(match[2]!),
    }))
    .filter(({ value, label }) => value.length > 0 || label.length > 0);
  const publicationEntries = [...html.matchAll(
    /<(article|li|tr)\b([^>]*)>([\s\S]*?)<\/\1>/giu,
  )]
    .map((match) => htmlText(match[3]!))
    .filter((entry) => entry.length > 0);
  if (
    publicationLinks.length === 0 &&
    discoveredOptions.length === 0 &&
    publicationEntries.length === 0
  ) {
    throw new Error(
      `Official Source ${surface} has no structural publication entries.`,
    );
  }
  const declaredCountMatch = html.match(
    /\b(?:showing\s+)?(\d+)\s+(?:results?|records?|items?)\b/iu,
  );
  const parsedPublicationCount = publicationEntries.length > 0
    ? publicationEntries.length
    : publicationLinks.length > 0
      ? publicationLinks.length
      : discoveredOptions.length;
  const declaredPublicationCount = Number.parseInt(
    declaredCountMatch?.[1] ?? String(parsedPublicationCount),
    10,
  );
  const labelPairs = htmlLabelPairs(html);
  const productIndexObservations =
    surface === "products" || surface === "releases"
      ? parseBandaiProductIndex(html, url)
      : [];
  return {
    observations: productIndexObservations.length > 0
      ? productIndexObservations
      : [{
          completeness: completeObservation(
            declaredPublicationCount,
            parsedPublicationCount,
          ),
          product_release_catalogue: {
            products: [],
            distribution_contexts: [],
            relationships: [],
          },
        }],
    retainedDocument: {
      source_lineage: sourceLineage,
      surface,
      url,
      document_title: htmlText(
        html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu)?.[1] ??
          text.slice(0, 200),
      ),
      publication_links: publicationLinks,
      discovered_options: discoveredOptions,
      publication_entries: publicationEntries,
      ...(labelPairs.length === 0
        ? {}
        : {
            label_values: Object.fromEntries(
              labelPairs.map(({ label, value }) => [label, value]),
            ),
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
    ],
  };
}

function parseBandaiSurfaceCoverageV2(
  html: string,
  format: DiscoveryFormat,
  sourceLineage: string,
  surface: string,
  url: string,
  acceptPublisherDeclaredEmpty: boolean,
  catalogueComplete = false,
): ParsedBandaiSurface {
  return parseBandaiSurfaceCoverageByContract(
    html,
    format,
    sourceLineage,
    surface,
    url,
    acceptPublisherDeclaredEmpty,
    catalogueComplete,
  );
}

function parseBandaiSurfaceCoverageByContract(
  html: string,
  format: DiscoveryFormat,
  sourceLineage: string,
  surface: string,
  url: string,
  acceptPublisherDeclaredEmpty: boolean,
  catalogueComplete: boolean,
): ParsedBandaiSurface {
  const text = htmlText(html);
  const fusionListingEntries = catalogueComplete &&
      format === "fusion-world" && surface === "listing"
    ? fusionWorldHtmlListingEntries(html, url, sourceLineage)
    : [];
  if (
    surface === "listing" &&
    /(?:too many search results|more than 1,?000|results? (?:were )?capped)/iu
      .test(text) &&
    discoveredPartitionRequests(
      format,
      html,
      new URL(url),
      false,
      catalogueComplete,
    ).length === 0
  ) {
    throw new Error(
      "Official Source leaf partition still displays its result-cap signal.",
    );
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
    throw new Error(
      `Official Source ${surface} HTML does not contain its expected Bandai publication.`,
    );
  }
  const publicationLinks = [...html.matchAll(
    /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu,
  )]
    .map((match) => ({
      url: new URL(decodeHtmlText(match[1]!), url).href,
      label: htmlText(match[2]!),
    }))
    .filter(({ label }) => label.length > 0);
  const discoveredOptions = [...html.matchAll(
    /<option\b[^>]*\bvalue=["']([^"']*)["'][^>]*>([\s\S]*?)<\/option>/giu,
  )]
    .map((match) => ({
      value: decodeHtmlText(match[1]!),
      label: htmlText(match[2]!),
    }))
    .filter(({ value, label }) => value.length > 0 || label.length > 0);
  const publicationEntryMatches = [...html.matchAll(
    /<(article|li|tr)\b([^>]*)>([\s\S]*?)<\/\1>/giu,
  )];
  const declaredCountMatch = html.match(
    />\s*(\d+)\s+(?:results?|records?|items?)\s*</iu,
  ) ?? (catalogueComplete && format === "fusion-world" && surface === "listing"
    ? html.match(
        /<div\b[^>]*\bclass=["'][^"']*\bresultTxt\b[^"']*["'][^>]*>[\s\S]*?<span\b[^>]*\bclass=["'][^"']*\bnum\b[^"']*["'][^>]*>\s*(\d+)\s*<\/span>\s*cards?\b[\s\S]*?<\/div>/iu,
      )
    : null);
  if (
    catalogueComplete &&
    format === "fusion-world" &&
    surface === "listing" &&
    declaredCountMatch !== null &&
    Number.parseInt(declaredCountMatch[1]!, 10) !== fusionListingEntries.length
  ) {
    throw new Error(
      `Fusion World listing declared ${declaredCountMatch[1]} Cards but yielded ${fusionListingEntries.length} unique full locators.`,
    );
  }
  const fusionComingSoonDeclaresEmpty =
    catalogueComplete &&
    format === "fusion-world" &&
    surface === "products" &&
    new URL(url).searchParams.get("status") === "coming-soon" &&
    declaredCountMatch?.[1] === "0";
  const publisherDeclaresEmpty =
    (acceptPublisherDeclaredEmpty || fusionComingSoonDeclaresEmpty) &&
    declaredCountMatch?.[1] === "0";
  const publicationEntries = publicationEntryMatches
    .filter(
      (match) =>
        !publisherDeclaresEmpty ||
        htmlAttribute(match[2]!, "data-publication-empty") !== "true",
    )
    .map((match) => htmlText(match[3]!))
    .filter((entry) => entry.length > 0);
  if (
    fusionListingEntries.length === 0 &&
    publicationLinks.length === 0 &&
    discoveredOptions.length === 0 &&
    publicationEntries.length === 0 &&
    !publisherDeclaresEmpty
  ) {
    throw new Error(
      `Official Source ${surface} has no structural publication entries.`,
    );
  }
  if (catalogueComplete && format === "fusion-world" && surface === "products") {
    requireFusionWorldHtmlProductStatusCoverage(html, url);
  }
  const labelPairs = htmlLabelPairs(html);
  const parsedPublicationCount =
    publicationEntries.length > 0
      ? publicationEntries.length
      : publicationLinks.length > 0
        ? publicationLinks.length
        : discoveredOptions.length;
  const declaredPublicationCount = Number.parseInt(
    declaredCountMatch?.[1] ??
      String(parsedPublicationCount),
    10,
  );
  const productIndexObservations =
    surface === "products" || surface === "releases"
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
        : [{
            completeness: completeObservation(
              declaredPublicationCount,
              parsedPublicationCount,
            ),
            product_release_catalogue: {
              products: [],
              distribution_contexts: [],
              relationships: [],
            },
          }],
    retainedDocument: {
      source_lineage: sourceLineage,
      surface,
      url,
      document_title: htmlText(
        html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu)?.[1] ?? text.slice(0, 200),
      ),
      publication_links: publicationLinks,
      discovered_options: discoveredOptions,
      publication_entries: publicationEntries,
      ...(fusionListingEntries.length === 0
        ? {}
        : { listing_identity_evidence: fusionListingEntries }),
      ...(labelPairs.length === 0
        ? {}
        : {
            label_values: Object.fromEntries(
              labelPairs.map(({ label, value }) => [label, value]),
            ),
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
      ...(fusionListingEntries.length === 0
        ? []
        : ["listing_identity_evidence"]),
    ],
  };
}

function requireFusionWorldHtmlProductStatusCoverage(
  html: string,
  requestUrl: string,
): void {
  const accepted = ["available", "coming-soon"];
  const url = new URL(requestUrl);
  const requestedStatus = url.searchParams.get("status");
  const entryStatuses = [...html.matchAll(
    /<(?:article|li|tr)\b([^>]*\bdata-product-status=["'][^"']+["'][^>]*)>/giu,
  )].map((match) =>
    htmlAttribute(match[1]!, "data-product-status")?.normalize("NFC").trim()
  ).filter((status): status is string => status !== null && status !== undefined);
  if (requestedStatus !== null) {
    const explicitlyEmptyComingSoon =
      requestedStatus === "coming-soon" &&
      entryStatuses.length === 0 &&
      />\s*0\s+(?:results?|records?|items?)\s*</iu.test(html);
    if (explicitlyEmptyComingSoon) return;
    if (
      !accepted.includes(requestedStatus) ||
      entryStatuses.length === 0 ||
      entryStatuses.some((status) => status !== requestedStatus)
    ) {
      throw new Error(
        `Fusion World Product status page ${requestedStatus} is incomplete.`,
      );
    }
    return;
  }
  const tabStatuses = [...html.matchAll(
    /<a\b([^>]*\bdata-product-status=["'][^"']+["'][^>]*)>[\s\S]*?<\/a>/giu,
  )].map((match) =>
    htmlAttribute(match[1]!, "data-product-status")?.normalize("NFC").trim()
  ).filter((status): status is string => status !== null && status !== undefined);
  const missingTabs = accepted.filter((status) => !tabStatuses.includes(status));
  const unexpected = [...tabStatuses, ...entryStatuses].filter(
    (status) => !accepted.includes(status),
  );
  if (
    missingTabs.length > 0 ||
    unexpected.length > 0
  ) {
    throw new Error(
      `Fusion World Product status tabs are incomplete; missing tabs: ${missingTabs.join(", ") || "none"}; unexpected: ${[...new Set(unexpected)].join(", ") || "none"}.`,
    );
  }
}

function parseBandaiProductIndex(
  html: string,
  requestUrl: string,
): Record<string, unknown>[] {
  type ProductIndexEntry =
    | {
        product: {
          code: string | null;
          title: string;
          distribution: {
            code: string;
            kind: string;
            label: string;
          };
        };
        announced: boolean;
      }
    | {
        non_card_context: {
          key: string;
          kind: string;
          label: string;
          evidence_category: "explicit";
        };
      };
  const containers = [...html.matchAll(
    /<(article|li|tr)\b([^>]*)>([\s\S]*?)<\/\1>/giu,
  )].map((match) => ({ attributes: match[2]!, body: match[3]! }));
  if (containers.length === 0) {
    containers.push(
      ...[...html.matchAll(
        /<a\b[^>]*\bhref=["'][^"']+["'][^>]*>[\s\S]*?<\/a>/giu,
      )].map((match) => ({ attributes: "", body: match[0]! })),
    );
  }
  const entries = containers.flatMap<ProductIndexEntry>(
    ({ attributes, body }) => {
    const link = body.match(
      /<a\b([^>]*\bhref=["'][^"']+["'][^>]*)>([\s\S]*?)<\/a>/iu,
    );
    if (link === null) return [];
    const href = htmlAttribute(link[1]!, "href");
    if (href === null || !/\/products?\//iu.test(href)) return [];
    const title = htmlText(link[2]!);
    const resolved = new URL(decodeHtmlText(href), requestUrl);
    const code =
      htmlAttribute(link[1]!, "data-product-code")?.normalize("NFC").trim() ??
      firstLabelValue(htmlLabelPairs(body), ["Product Code"]);
    if (title.length === 0) return [];
    const classificationText = `${attributes} ${body} ${resolved.pathname}`;
    const nonCardClassification =
      nonCardProductClassification(classificationText);
    const nonCard = nonCardClassification !== null;
    const cardBearing =
      /(?:booster|starter|deck|card|set)/iu.test(classificationText);
    const classification = nonCard
      ? { kind: "other", label: nonCardClassification }
      : cardBearing
        ? { kind: "product", label: "booster" }
        : { kind: "other", label: "other" };
    if (nonCard || !cardBearing) {
      return [{
        non_card_context: {
          key: `non-card:${classification.label}:${
            (code ?? title).normalize("NFC").trim().toLocaleLowerCase()
          }`,
          ...classification,
          evidence_category: "explicit",
        },
      }];
    }
    const product = {
      code: code === null || code.length === 0 ? null : code,
      title,
    };
    return [{
      product: {
        ...product,
        distribution: {
          code:
            `product-classification:${classification.label}:${productMapKey(product)}`,
          ...classification,
        },
      },
      announced: /(?:coming soon|upcoming|announced)/iu.test(htmlText(body)),
    }];
    },
  );
  return [
    ...new Map(entries.map((entry) => [
      "product" in entry
        ? `product:${productMapKey(entry.product)}`
        : `context:${entry.non_card_context.key}`,
      entry,
    ])).values(),
  ].map((entry) => {
    if ("non_card_context" in entry) {
      return {
        completeness: completeObservation(),
        product_release_catalogue: {
          products: [],
          distribution_contexts: [entry.non_card_context],
          relationships: [],
        },
      };
    }
    const { product, announced } = entry;
    const releases = new Map<string, Record<string, unknown>[]>();
    if (announced) {
      releases.set(productMapKey(product), [{
        event_key: productEventKey("product-index-announcement", product),
        region: "unknown",
        precision: "unknown",
        date: null,
        status: "announced",
      }]);
    }
    return productOnlyObservation(
      product,
      releases,
      { revision: "captured-by-policy-surface", entries: [] },
      { revision: "captured-by-policy-surface", entries: [] },
    );
  });
}

function requiredHtmlMatch(
  value: string,
  pattern: RegExp,
  name: string,
): RegExpMatchArray {
  const match = value.match(pattern);
  if (match === null) throw new Error(`${name} is unavailable.`);
  return match;
}

function htmlText(value: string): string {
  return decodeHtmlText(
    value
      .replace(/<br\b[^>]*>/giu, "\n")
      .replace(/<\/(?:p|div|li|section|article|h[1-6])\s*>/giu, "\n")
      .replace(/<[^>]+>/gu, " "),
  )
    .split(/\r?\n/u)
    .map((line) => line.replace(/[^\S\r\n]+/gu, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function decodeHtmlText(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#039;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replace(/&#(\d+);/gu, (_match, digits: string) =>
      String.fromCodePoint(Number.parseInt(digits, 10))
    );
}

function integerOrNull(value: string | null): number | null {
  if (value === null || value === "-" || value === "") return null;
  const normalized = value.normalize("NFC").trim();
  if (
    !/^\d+$/u.test(normalized) &&
    !/^\d{1,3}(?:,\d{3})+$/u.test(normalized)
  ) {
    throw new Error(`Unrecognized official numeric token: ${value}`);
  }
  return Number.parseInt(normalized.replaceAll(",", ""), 10);
}

function textValues(value: string | null): string[] {
  return value === null || value === "-"
    ? []
    : [...new Set(value.split("/").map((item) => item.trim()).filter(Boolean))];
}

function colourValues(value: string | null): string[] {
  if (value === null || value === "-") return [];
  return [...new Set(
    value
      .split(/[\/,]/u)
      .map((item) => item.normalize("NFC").trim().toLocaleLowerCase())
      .filter(Boolean),
  )];
}

function digimonTextSections(
  pairs: readonly { label: string; value: string }[],
): { kind: string; text: string }[] {
  const kinds = new Map([
    ["effect", "effect"],
    ["inherited effect", "inherited_effect"],
    ["security effect", "security_effect"],
    ["rule", "rule"],
    ["[dual effect]", "dual_effect"],
    ["[dual rule]", "dual_rule"],
    ["[link condition]", "link_condition"],
    ["[link effect]", "link_effect"],
    [
      "[special digivolution condition]",
      "special_digivolution_condition",
    ],
  ]);
  return pairs.flatMap(({ label, value }) => {
    const kind = kinds.get(label.normalize("NFC").trim().toLocaleLowerCase());
    const text = value.normalize("NFC").trim();
    return kind === undefined || text.length === 0 || text === "-"
      ? []
      : [{ kind, text }];
  });
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
  throw new Error(`Unrecognized official ${field} value: ${value}`);
}

function officialArtworkTreatment(
  value: string | null,
): "standard" | "alternate" | null {
  if (value === null) return null;
  const normalized = value.normalize("NFC").trim().toLocaleLowerCase();
  if (["standard", "base"].includes(normalized)) return "standard";
  if (["alternate", "alternative", "alternate art", "alternative art"].includes(
    normalized,
  )) {
    return "alternate";
  }
  return null;
}

function specifiedCosts(
  value: string | null,
): { colour: string; count: number }[] {
  if (value === null || value === "-" || value.trim() === "") return [];
  return value.split(/[,/]/u).map((part) => {
    const text = part.normalize("NFC").trim();
    const colour = text.match(/\b(red|blue|green|yellow|black)\b/iu)?.[1]
      ?.toLocaleLowerCase();
    const count = text.match(/\b(\d+)\b/u)?.[1];
    if (colour === undefined || count === undefined || Number(count) < 1) {
      throw new Error(
        `Unrecognized official Fusion World specified cost: ${text}`,
      );
    }
    return { colour, count: Number.parseInt(count, 10) };
  });
}

function digivolutionRequirements(
  values: readonly string[],
): {
  index: number;
  from_level: number | null;
  colours: string[];
  cost: number;
  raw_condition: string | null;
}[] {
  return values.map((value, index) => {
    const normalized = value.normalize("NFC").trim();
    const cost = normalized.match(/(?::|\bcost\s*)\s*(\d+)\s*$/iu)?.[1];
    if (cost === undefined) {
      throw new Error(
        `Unrecognized official Digimon digivolution requirement: ${value}`,
      );
    }
    return {
      index: index + 1,
      from_level:
        Number(
          normalized.match(/\bLv\.?\s*(\d+)\b/iu)?.[1] ?? Number.NaN,
        ) || null,
      colours: [...new Set(
        [...normalized.matchAll(/\b(red|blue|green|yellow|black|purple|white)\b/giu)]
          .map((match) => match[1]!.toLocaleLowerCase()),
      )],
      cost: Number.parseInt(cost, 10),
      raw_condition: normalized,
    };
  });
}

function requiredNullableText(value: string | null, name: string): string | null {
  if (value === null) return null;
  if (value.length === 0) throw new Error(`${name} is invalid.`);
  return value;
}

function normalizedSurfaceObservationsV1(
  format: DiscoveryFormat,
  game: ProductSourceGame,
  sourceLineage: string,
  surface: string,
  rawDocument: Record<string, unknown>,
): readonly unknown[] {
  const normalized = normalizeLineageSurfaceV1(
    format,
    sourceLineage,
    surface,
    rawDocument,
  );
  const document = normalized.document;
  const observations = isDiscoverySurface(surface)
    ? parseRawDiscoverySurfaceFrozenV1(document, format, game)
    : surface === "products"
      ? parseRawProductsSurfaceFrozenV1(document)
      : surface === "releases"
        ? parseRawReleasesSurfaceFrozenV1(document)
        : [rawCoverageObservationFrozenV1(document, surface)];
  return observations.map((observation, index) =>
    attachRawSurfaceEvidenceV1(
      observation,
      sourceLineage,
      surface,
      rawDocument,
      index === 0,
      normalized.consumedFields,
    )
  );
}

function normalizeLineageSurfaceV1(
  format: DiscoveryFormat,
  sourceLineage: string,
  surface: string,
  raw: Record<string, unknown>,
): {
  document: Record<string, unknown>;
  consumedFields: readonly string[];
} {
  const normalized = format === "one-piece"
    ? normalizeOnePieceSurfaceV1(surface, raw)
    : format === "fusion-world"
      ? normalizeFusionWorldSurfaceV1(surface, raw)
      : format === "digimon"
        ? normalizeDigimonSurfaceV1(surface, raw)
        : normalizeGundamSurfaceV1(sourceLineage, surface, raw);
  return {
    document: {
      contract: "card-keepr-official-source-surface@1",
      lineage: sourceLineage,
      surface,
      ...normalized.value,
    },
    consumedFields: normalized.consumedFields,
  };
}

function onePieceUnmappedOptionalFields(
  surface: string,
  raw: Record<string, unknown>,
): { path: string; value: unknown }[] {
  if (surface !== "card-list" || !Array.isArray(raw.card_pages)) return [];
  return raw.card_pages.flatMap((value, cardIndex) => {
    if (!isPlainRecord(value) || !isPlainRecord(value.printing)) return [];
    const printingAttributes = isPlainRecord(value.printing.attributes)
      ? value.printing.attributes
      : {};
    const illustrationWarnings = Array.isArray(
        printingAttributes.illustration_types,
      )
      ? printingAttributes.illustration_types.flatMap(
      (illustration, illustrationIndex) =>
        typeof illustration === "string" &&
          ["comic", "animation", "original", "other"].includes(
            illustration.toLocaleLowerCase(),
          )
          ? []
          : [{
              path:
                "source_sidecar.raw.official_surfaces[0].document." +
                `card_pages[${cardIndex}].printing.attributes.` +
                `illustration_types[${illustrationIndex}]`,
              value: illustration,
            }],
      )
      : [];
    return illustrationWarnings;
  });
}

function normalizeOnePieceSurfaceV1(
  surface: string,
  raw: Record<string, unknown>,
): NormalizedSurfaceBody {
  if (surface === "card-list") {
    if (raw.page !== "card-list") {
      throw new Error("One Piece card-list page identity is invalid.");
    }
    return normalizedSurfaceBody(
      normalizedDiscovery(
        raw.series_options,
        raw.page_info,
        normalizeOnePieceDetails(raw.card_pages),
        normalizeOnePieceProducts(raw.products),
        normalizeOnePieceReleases(raw.release_schedule),
        "recording",
        exactOnePieceLeaves(raw.series_options),
      ),
      [
        "page", "series_options", "page_info", "card_pages", "products",
        "release_schedule",
      ],
    );
  }
  if (surface === "products") {
    if (raw.page !== "product-list") {
      throw new Error("One Piece Product page identity is invalid.");
    }
    return normalizedSurfaceBody(
      normalizedPartitions(
        normalizePartitionEntries(raw.result, normalizeOnePieceProduct),
        "recording",
      ),
      ["page", "series_options", "result"],
    );
  }
  if (surface === "releases") {
    if (raw.publication !== "release-schedule") {
      throw new Error("One Piece Release publication identity is invalid.");
    }
    return normalizedSurfaceBody(
      normalizedPartitions(
        normalizePartitionEntries(raw.events, normalizeOnePieceReleaseEntry),
        "release-event",
      ),
      ["publication", "events"],
    );
  }
  return normalizedSurfaceBody(
    normalizedPolicyV1(raw, `one-piece-${surface}`),
    ["publication", "revision", "entries"],
  );
}

function normalizeFusionWorldSurfaceV1(
  surface: string,
  raw: Record<string, unknown>,
): NormalizedSurfaceBody {
  if (surface === "card-search") {
    if (raw.view !== "card-search") {
      throw new Error("Fusion World card-search view identity is invalid.");
    }
    const facets = requiredRecord(raw.facets, "Fusion World facets");
    for (const name of ["card_type", "colour", "cost"]) {
      requiredArray(facets[name], `Fusion World ${name} facet`);
    }
    return normalizedSurfaceBody(
      normalizedDiscovery(
        Object.entries(facets).map(([name, values]) => ({ name, values })),
        raw.result,
        normalizeFusionWorldDetails(raw.detail_pages),
        normalizeFusionWorldProducts(raw.products),
        normalizeFusionWorldReleases(raw.releases),
        "card_type=leader&colour=red&cost=1",
        exactFusionLeaves(facets),
      ),
      ["view", "facets", "result", "detail_pages", "products", "releases"],
    );
  }
  if (surface === "products") {
    if (raw.view !== "products") {
      throw new Error("Fusion World Product view identity is invalid.");
    }
    const tabs = uniqueTextValues(raw.status_tabs, "Fusion World Product tabs");
    if (!tabs.includes("available") || !tabs.includes("coming-soon")) {
      throw new Error("Fusion World Product tabs are incomplete.");
    }
    return normalizedSurfaceBody(
      normalizedPartitions(
        normalizePartitionEntries(raw.result, normalizeFusionWorldProduct),
        "product-status",
      ),
      ["view", "status_tabs", "result"],
    );
  }
  if (surface === "releases") {
    if (raw.publication !== "product-release-dates") {
      throw new Error("Fusion World Release publication identity is invalid.");
    }
    return normalizedSurfaceBody(
      normalizedPartitions(
        normalizePartitionEntries(raw.events, normalizeFusionWorldReleaseEntry),
        "release-event",
      ),
      ["publication", "events"],
    );
  }
  return normalizedSurfaceBody(
    normalizedPolicyV1(raw, `fusion-world-${surface}`),
    ["publication", "revision", "entries"],
  );
}

function normalizeDigimonSurfaceV1(
  surface: string,
  raw: Record<string, unknown>,
): NormalizedSurfaceBody {
  if (surface === "card-list") {
    if (raw.view !== "card-list") {
      throw new Error("Digimon card-list view identity is invalid.");
    }
    const filters = requiredRecord(raw.filters, "Digimon filters");
    for (const name of ["category", "cardcategory", "colour"]) {
      requiredArray(filters[name], `Digimon ${name} filter`);
    }
    return normalizedSurfaceBody(
      normalizedDiscovery(
        raw.version_options,
        raw.result,
        normalizeDigimonDetails(raw.card_popups),
        normalizeDigimonProducts(raw.products),
        normalizeDigimonReleases(raw.release_calendar),
        "category=all&cardcategory=digimon&colour=blue",
        exactDigimonLeaves(filters),
      ),
      [
        "view", "version_options", "filters", "result", "card_popups",
        "products", "release_calendar",
      ],
    );
  }
  if (surface === "products") {
    if (raw.view !== "product-index") {
      throw new Error("Digimon Product index identity is invalid.");
    }
    requiredArray(raw.tile_categories, "Digimon Product tile categories");
    return normalizedSurfaceBody(
      normalizedPartitions(
        normalizePartitionEntries(raw.result, normalizeDigimonProduct),
        "product-category",
      ),
      ["view", "tile_categories", "result"],
    );
  }
  if (surface === "releases") {
    if (raw.publication !== "product-release-calendar") {
      throw new Error("Digimon Release publication identity is invalid.");
    }
    return normalizedSurfaceBody(
      normalizedPartitions(
        normalizePartitionEntries(raw.events, normalizeDigimonReleaseEntry),
        "release-event",
      ),
      ["publication", "events"],
    );
  }
  return normalizedSurfaceBody(
    normalizedPolicyV1(raw, `digimon-${surface}`),
    ["publication", "revision", "entries"],
  );
}

function normalizeGundamSurfaceV1(
  sourceLineage: string,
  surface: string,
  raw: Record<string, unknown>,
): NormalizedSurfaceBody {
  const expectedLocale = sourceLineage === "gundam-en-asia"
    ? "EN-ASIA"
    : "EN-US";
  if (raw.locale !== expectedLocale) {
    throw new Error("Gundam surface locale does not match its Source Lineage.");
  }
  if (surface === "packages") {
    if (raw.view !== "card-search") {
      throw new Error("Gundam card-search view identity is invalid.");
    }
    return normalizedSurfaceBody(
      normalizedDiscovery(
        raw.package_options,
        raw.result,
        normalizeGundamDetails(raw.card_details),
        normalizeGundamProducts(raw.products),
        normalizeGundamReleases(raw.releases),
        "package=all",
        exactGundamLeaves(raw.package_options),
      ),
      [
        "view", "locale", "package_options", "result", "card_details",
        "products", "releases",
      ],
    );
  }
  if (surface === "products") {
    if (raw.view !== "product-list") {
      throw new Error("Gundam Product list identity is invalid.");
    }
    return normalizedSurfaceBody(
      normalizedPartitions(
        normalizePartitionEntries(raw.result, normalizeGundamProduct),
        "package",
      ),
      ["view", "locale", "result"],
    );
  }
  if (surface === "releases") {
    if (raw.publication !== "locale-product-release-dates") {
      throw new Error("Gundam Release publication identity is invalid.");
    }
    return normalizedSurfaceBody(
      normalizedPartitions(
        normalizePartitionEntries(raw.events, normalizeGundamReleaseEntry),
        "release-event",
      ),
      ["publication", "locale", "events"],
    );
  }
  return normalizedSurfaceBody(
    normalizedPolicyV1(raw, `gundam-${surface}`),
    ["publication", "locale", "revision", "entries"],
  );
}

function normalizedPolicyV1(
  raw: Record<string, unknown>,
  expectedPublication: string,
): Record<string, unknown> {
  if (raw.publication !== expectedPublication) {
    throw new Error("Official policy publication identity is invalid.");
  }
  return {
    revision: requiredText(raw.revision, "Official policy revision"),
    entries: requiredArray(raw.entries, "Official policy entries"),
  };
}

function normalizedSurfaceObservationsV2(
  format: DiscoveryFormat,
  game: ProductSourceGame,
  sourceLineage: string,
  surface: string,
  rawDocument: Record<string, unknown>,
  legalityAware: boolean,
  expandedOnePieceCatalogue = false,
  catalogueComplete = false,
  completeDigimonCatalogue = false,
): readonly unknown[] {
  const normalized = normalizeLineageSurface(
    format,
    sourceLineage,
    surface,
    rawDocument,
    expandedOnePieceCatalogue,
    catalogueComplete,
    completeDigimonCatalogue,
  );
  const document = normalized.document;
  let observations: readonly unknown[];
  if (isDiscoverySurface(surface)) {
    observations = parseRawDiscoverySurfaceV2(
      document,
      format,
      game,
      expandedOnePieceCatalogue,
      catalogueComplete,
    );
  } else if (surface === "products") {
    observations = parseRawProductsSurfaceV2(document);
  } else if (surface === "releases") {
    observations = [
      ...parseRawReleasesSurfaceV2(document),
      ...(legalityAware && isLegalityRuleSurface(game, surface)
        ? [officialLegalityRulesObservation(game, sourceLineage, document)]
        : []),
    ];
  } else if (
    expandedOnePieceCatalogue && game === "one-piece" && surface === "errata"
  ) {
    observations = [
      rawCoverageObservationV2(document, surface),
      ...onePieceOfficialErrataObservations(document.entries),
    ];
  } else {
    observations = [
      rawCoverageObservationV2(document, surface),
      ...(expandedOnePieceCatalogue && game === "one-piece" &&
          surface === "don-rules"
        ? [onePieceDonCardObservation(document.don_card)]
        : []),
      ...(catalogueComplete && format === "fusion-world" && surface === "errata"
        ? fusionWorldOfficialErrataObservations(document)
        : []),
      ...(
        completeDigimonCatalogue && game === "digimon" && surface === "errata"
           ? parseDigimonOfficialErrata(document)
           : []
      ),
      ...(legalityAware && isLegalityPolicySurface(surface)
        ? [
            officialLegalityRulesObservation(
              game,
              sourceLineage,
              document,
            ),
          ]
        : []),
    ];
  }
  return observations.map((observation, index) => {
    const record = requiredRecord(
      observation,
      `Official Source ${surface} observation`,
    );
    return record.kind === "official_erratum"
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

function onePieceOfficialErrataObservations(value: unknown): unknown[] {
  const fields = [
    "notice_id",
    "card_number",
    "card_name",
    "published_on",
    "effective_from",
    "before_text",
    "after_text",
    "note",
    "applies_to_parallel_printings",
    "image_url",
  ];
  return requiredArray(value, "One Piece Errata entries").map((item) => {
    const entry = requiredRecord(item, "One Piece Erratum");
    const undeclared = Object.keys(entry).filter((field) =>
      !fields.includes(field)
    );
    const missing = fields.filter((field) => !Object.hasOwn(entry, field));
    if (undeclared.length > 0 || missing.length > 0) {
      throw new Error(
        `One Piece Erratum has undeclared or missing fields: ${[
          ...undeclared,
          ...missing,
        ].sort().join(", ")}.`,
      );
    }
    const noticeId = requiredText(
      entry.notice_id,
      "One Piece Erratum notice id",
    );
    if (!/^[A-Za-z][A-Za-z0-9_-]+$/u.test(noticeId)) {
      throw new Error("One Piece Erratum notice id is invalid.");
    }
    const cardNumber = requiredText(
      entry.card_number,
      "One Piece Erratum Card number",
    );
    if (!/^[A-Z]{1,5}[0-9]{0,3}-[A-Z0-9]{1,6}$/u.test(cardNumber)) {
      throw new Error("One Piece Erratum Card number is invalid.");
    }
    const cardName = requiredText(
      entry.card_name,
      "One Piece Erratum Card name",
    );
    const publishedOn = exactOnePieceSourceDate(
      entry.published_on,
      "One Piece Erratum published_on",
    );
    const effectiveFrom = entry.effective_from === null
      ? null
      : exactOnePieceSourceDate(
          entry.effective_from,
          "One Piece Erratum effective_from",
        );
    const before = requiredText(
      entry.before_text,
      "One Piece Erratum Before text",
    );
    const after = requiredText(
      entry.after_text,
      "One Piece Erratum After text",
    );
    const note = nullableText(entry.note, "One Piece Erratum Note");
    if (typeof entry.applies_to_parallel_printings !== "boolean") {
      throw new Error(
        "One Piece Erratum parallel Printing applicability is invalid.",
      );
    }
    const imageUrl = requiredText(
      entry.image_url,
      "One Piece Erratum image URL",
    );
    let parsedImageUrl: URL;
    try {
      parsedImageUrl = new URL(imageUrl);
    } catch {
      throw new Error("One Piece Erratum image URL is invalid.");
    }
    if (!officialUrl("one-piece-en", parsedImageUrl, "image")) {
      throw new Error("One Piece Erratum image URL is invalid.");
    }
    return {
      kind: "official_erratum",
      game: "one-piece",
      target: {
        type: "card",
        official_identity: { kind: "card_number", value: cardNumber },
      },
      published_on: publishedOn,
      effective_from: effectiveFrom,
      observed_printed_rules_text: before,
      corrected_rules_text: after,
      official_wording: [
        ...(note === null ? [] : [`Note: ${note}`]),
        `Before: ${before}`,
        `After: ${after}`,
      ].join("\n"),
      applies_to_parallel_printings: entry.applies_to_parallel_printings,
      source: {
        fragment: `#${noticeId}`,
        display_name: `${cardNumber} ${cardName}`,
        image_url: imageUrl,
      },
      completeness: {
        structurally_complete: true,
        required_surfaces_complete: true,
        partitions_complete: true,
        declared_record_count: 1,
        parsed_record_count: 1,
      },
    };
  });
}

function fusionWorldOfficialErrataObservations(
  document: Record<string, unknown>,
): readonly Record<string, unknown>[] {
  const entries = requiredArray(
    document.entries,
    "Fusion World Errata entries",
  );
  return entries.map((value) => {
    const entry = requiredRecord(value, "Fusion World Erratum");
    const allowed = new Set([
      "entry_id",
      "card_number",
      "published_on",
      "effective_from",
      "before",
      "after",
      "notice",
      "image_url",
    ]);
    const unexpected = Object.keys(entry).find((field) => !allowed.has(field));
    if (unexpected !== undefined) {
      throw new Error(
        `Fusion World Erratum contains unknown field ${unexpected}.`,
      );
    }
    const entryId = requiredText(entry.entry_id, "Fusion World Erratum identity");
    const cardNumber = requiredText(
      entry.card_number,
      "Fusion World Erratum Card Number",
    );
    const publishedOn = requiredText(
      entry.published_on,
      "Fusion World Erratum published date",
    );
    const effectiveFrom = entry.effective_from === null
      ? null
      : requiredText(
          entry.effective_from,
          "Fusion World Erratum effective date",
        );
    const before = requiredText(entry.before, "Fusion World Erratum Before text");
    const after = requiredText(entry.after, "Fusion World Erratum After text");
    const notice = requiredText(entry.notice, "Fusion World Erratum notice");
    const imageUrl = requiredText(
      entry.image_url,
      "Fusion World Erratum image URL",
    );
    const image = new URL(imageUrl);
    if (!officialUrl("fusion-world-en", image, "image")) {
      throw new Error("Fusion World Erratum image provenance is invalid.");
    }
    return {
      kind: "official_erratum",
      game: "fusion-world",
      target: {
        type: "card",
        official_identity: { kind: "card_number", value: cardNumber },
      },
      published_on: publishedOn,
      effective_from: effectiveFrom,
      observed_printed_rules_text: before,
      corrected_rules_text: after,
      official_wording: `Before: ${before}\nAfter: ${after}\nNote: ${notice}`,
      applies_to_parallel_printings: true,
      source: {
        fragment: `#${entryId}`,
        display_name: cardNumber,
        image_url: image.href,
      },
      completeness: completeObservation(1, 1),
    };
  });
}

function exactOnePieceSourceDate(value: unknown, name: string): string {
  const date = requiredText(value, name);
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(date)) {
    throw new Error(`${name} is invalid.`);
  }
  const instant = new Date(`${date}T00:00:00.000Z`);
  if (
    Number.isNaN(instant.getTime()) ||
    instant.toISOString().slice(0, 10) !== date
  ) {
    throw new Error(`${name} is invalid.`);
  }
  return date;
}

function parseFusionWorldOfficialErrataHtmlV3(
  html: string,
): readonly Record<string, unknown>[] {
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu);
  const title = htmlText(titleMatch?.[1] ?? "");
  if (!/(?:BANDAI|DRAGON BALL).*ERRATA/iu.test(title)) {
    throw new Error("Fusion World Errata title authority is invalid.");
  }
  const matches = [...html.matchAll(
    /<article\b([^>]*\bdata-erratum-id=["'][^"']+["'][^>]*)>([\s\S]*?)<\/article>/giu,
  )];
  if (matches.length === 0) {
    throw new Error("Fusion World Errata has no exact correction entries.");
  }
  if ([...html.matchAll(/\bdata-erratum-id=["'][^"']+["']/giu)].length !==
      matches.length) {
    throw new Error("Fusion World Errata entry inventory is incomplete.");
  }
  const entries = matches.map((match) => {
    const attributes = match[1]!;
    const entryId = htmlAttribute(attributes, "data-erratum-id");
    const className = htmlAttribute(attributes, "class");
    if (entryId === null || className !== "erratum") {
      throw new Error("Fusion World Errata entry authority is invalid.");
    }
    const unconsumedAttributes = attributes
      .replace(/\bclass=["'][^"']*["']/iu, "")
      .replace(/\bdata-erratum-id=["'][^"']*["']/iu, "")
      .trim();
    if (unconsumedAttributes.length > 0) {
      throw new Error("Fusion World Errata entry has unsupported attributes.");
    }
    const body = match[2]!;
    const definitionLists = [...body.matchAll(/<dl\b[^>]*>([\s\S]*?)<\/dl>/giu)];
    if (definitionLists.length !== 1) {
      throw new Error("Fusion World Errata entry requires one exact field list.");
    }
    const list = definitionLists[0]![1]!;
    const pairs = htmlLabelPairs(`<dl>${list}</dl>`);
    const expectedLabels = [
      "Card Number",
      "Published On",
      "Effective From",
      "Before",
      "After",
      "Note",
    ];
    if (
      pairs.length !== expectedLabels.length ||
      [...list.matchAll(/<dt\b/giu)].length !== expectedLabels.length ||
      [...list.matchAll(/<dd\b/giu)].length !== expectedLabels.length ||
      expectedLabels.some((label) =>
        pairs.filter((pair) => pair.label === label).length !== 1
      ) ||
      pairs.some(({ label }) => !expectedLabels.includes(label))
    ) {
      throw new Error("Fusion World Errata fields are incomplete or unknown.");
    }
    const value = (label: string): string =>
      requiredText(
        pairs.find((pair) => pair.label === label)?.value,
        `Fusion World Errata ${label}`,
      );
    const imageMatches = [...body.matchAll(
      /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/giu,
    )];
    if (imageMatches.length !== 1) {
      throw new Error("Fusion World Errata requires one correction image.");
    }
    const imageUrl = new URL(decodeHtmlText(imageMatches[0]![1]!));
    if (!officialUrl("fusion-world-en", imageUrl, "image")) {
      throw new Error("Fusion World Errata image provenance is invalid.");
    }
    const residualBody = body
      .replace(definitionLists[0]![0], "")
      .replace(imageMatches[0]![0], "");
    if (htmlText(residualBody).length > 0) {
      throw new Error("Official Source has unparsed Fusion World Errata wording.");
    }
    return {
      entry_id: entryId,
      card_number: value("Card Number"),
      published_on: value("Published On"),
      effective_from: value("Effective From"),
      before: value("Before"),
      after: value("After"),
      notice: value("Note"),
      image_url: imageUrl.href,
    };
  });
  let residualPage = html.replace(titleMatch?.[0] ?? "", "");
  for (const match of matches) residualPage = residualPage.replace(match[0], "");
  residualPage = residualPage.replace(/<\/?(?:html|main)\b[^>]*>/giu, "");
  if (htmlText(residualPage).length > 0) {
    throw new Error("Official Source has unparsed Fusion World Errata wording.");
  }
  return fusionWorldOfficialErrataObservations({ entries });
}

function parseDigimonOfficialErrata(
  document: Record<string, unknown>,
): Record<string, unknown>[] {
  const entries = requiredArray(
    document.entries,
    "Digimon Official Errata entries",
  );
  return entries.map((value) => {
    const entry = requiredRecord(value, "Digimon Official Erratum");
    const allowedFields = new Set([
      "card_number",
      "published_on",
      "effective_from",
      "observed_printed_rules_text",
      "corrected_rules_text",
      "official_wording",
      "applies_to_parallel_printings",
      "source_fragment",
      "display_name",
      "image_url",
    ]);
    const unknownField = Object.keys(entry).find(
      (field) => !allowedFields.has(field),
    );
    if (unknownField !== undefined) {
      throw new Error(
        `Digimon Official Erratum contains unknown field ${unknownField}.`,
      );
    }
    if (typeof entry.applies_to_parallel_printings !== "boolean") {
      throw new Error(
        "Digimon Official Erratum applies-to-parallel-printings flag is invalid.",
      );
    }
    return {
      kind: "official_erratum",
      game: "digimon",
      target: {
        type: "card",
        official_identity: {
          kind: "card_number",
          value: requiredText(entry.card_number, "Digimon Erratum Card Number"),
        },
      },
      published_on: requiredText(
        entry.published_on,
        "Digimon Erratum published date",
      ),
      effective_from: entry.effective_from === null
        ? null
        : requiredText(
            entry.effective_from,
            "Digimon Erratum effective date",
          ),
      observed_printed_rules_text: requiredText(
        entry.observed_printed_rules_text,
        "Digimon Erratum observed Printed Rules Text",
      ),
      corrected_rules_text: entry.corrected_rules_text === null
        ? null
        : requiredText(
            entry.corrected_rules_text,
            "Digimon Erratum corrected Rules Text",
          ),
      official_wording: requiredText(
        entry.official_wording,
        "Digimon Erratum official wording",
      ),
      applies_to_parallel_printings: entry.applies_to_parallel_printings,
      source: {
        fragment: requiredText(
          entry.source_fragment,
          "Digimon Erratum source fragment",
        ),
        display_name: requiredText(
          entry.display_name,
          "Digimon Erratum display name",
        ),
        image_url: requiredText(entry.image_url, "Digimon Erratum image URL"),
      },
      completeness: {
        structurally_complete: true,
        required_surfaces_complete: true,
        partitions_complete: true,
        declared_record_count: 1,
        parsed_record_count: 1,
      },
    };
  });
}

function parseDigimonCardListPopupHtmlV4(
  html: string,
  requestUrl: string,
): Record<string, unknown>[] {
  const declaredRecordCount = digimonDeclaredRecordCount(html);
  const leafPublisherCardType = requiredText(
    new URL(requestUrl).searchParams.get("cardcategory"),
    "Official Digimon leaf cardcategory",
  );
  const leafCardType = digimonProfileCardType(
    leafPublisherCardType,
    "Official Digimon leaf cardcategory",
  );
  const recordStarts = [...html.matchAll(
    /<li\b[^>]*\bclass=["'][^"']*\bimage_lists_item\b[^"']*\bdata\b[^"']*["'][^>]*>/giu,
  )].map((match) => match.index);
  const popupCount = [...html.matchAll(
    /<div\b[^>]*\bclass=["'][^"']*\bpopupCol\b[^"']*["'][^>]*>/giu,
  )].length;
  if (popupCount !== recordStarts.length) {
    throw new Error(
      "Official Digimon Card List popup records are structurally incomplete.",
    );
  }
  if (
    declaredRecordCount !== recordStarts.length
  ) {
    throw new Error(
      "Official Digimon Card List declared and parsed record counts differ.",
    );
  }
  if (recordStarts.length === 0) {
    return [attachRawSurfaceEvidenceV1({
      completeness: completeObservation(0, 0),
      product_release_catalogue: {
        products: [],
        distribution_contexts: [],
        relationships: [],
      },
    }, "digimon-en", "card-list", {
      declared_record_count: declaredRecordCount,
      leaf_cardcategory: leafPublisherCardType,
    }, true, ["declared_record_count", "leaf_cardcategory"])];
  }
  const records = recordStarts.map((start, index) =>
    html.slice(start, recordStarts[index + 1] ?? html.length)
  );
  return records.map((record) => {
    const popupMatches = [...record.matchAll(
      /<div\b([^>]*\bclass=["'][^"']*\bpopupCol\b[^"']*["'][^>]*)>/giu,
    )];
    if (popupMatches.length !== 1) {
      throw new Error(
        "Official Digimon Card List record requires one exact popup.",
      );
    }
    const locator = requiredText(
      htmlAttribute(popupMatches[0]![1]!, "id"),
      "Official Digimon popup locator",
    );
    const locatorIdentity = locator.match(
      /^([A-Z]{1,6}\d{0,3}-\d{2,5})(?:_P(\d+))?$/u,
    );
    if (locatorIdentity === null) {
      throw new Error("Official Digimon popup locator is invalid.");
    }
    const cardAnchorMatches = [...record.matchAll(
      /<a\b([^>]*\bclass=["'][^"']*\bcard_img\b[^"']*["'][^>]*)>/giu,
    )];
    if (
      cardAnchorMatches.length !== 1 ||
      htmlAttribute(cardAnchorMatches[0]![1]!, "data-src") !== `#${locator}`
    ) {
      throw new Error(
        "Official Digimon Card List anchor does not match its popup locator.",
      );
    }
    const titleList = exactDigimonClassBody(
      record,
      "ul",
      "cardTitleList",
      "Official Digimon Card title fields",
    );
    const titleFields = [...titleList.matchAll(
      /<li\b([^>]*)>([\s\S]*?)<\/li>/giu,
    )].map((match) => ({
      name: exactHtmlClassName(match[1]!),
      value: htmlText(match[2]!),
    }));
    const allowedTitleFields = new Set([
      "cardNo", "cardRarity", "cardType", "cardLv", "cardParallel",
    ]);
    const unknownTitleField = titleFields.find(
      ({ name }) => name === null || !allowedTitleFields.has(name),
    );
    if (unknownTitleField !== undefined) {
      throw new Error(
        `Official Digimon Card List contains unknown title field ${unknownTitleField.name ?? "without an exact class"}.`,
      );
    }
    const titleField = (name: string): string | null => {
      const matches = titleFields.filter((field) => field.name === name);
      if (matches.length > 1) {
        throw new Error(`Official Digimon Card List duplicates ${name}.`);
      }
      return matches[0]?.value ?? null;
    };
    const cardNumber = requiredText(
      titleField("cardNo"),
      "Official Digimon Card number",
    );
    if (cardNumber !== locatorIdentity[1]) {
      throw new Error(
        "Official Digimon Card number does not match its popup locator.",
      );
    }
    const alternativeArtNumber = locatorIdentity[2];
    const alternativeArtLabel = titleField("cardParallel");
    if (
      (alternativeArtNumber === undefined && alternativeArtLabel !== null) ||
      (alternativeArtNumber !== undefined &&
        alternativeArtLabel !== "Alternative Art")
    ) {
      throw new Error(
        "Official Digimon alternate-art marker does not match its popup locator.",
      );
    }
    const publisherCardType = requiredText(
      titleField("cardType"),
      "Official Digimon Card type",
    );
    const cardType = digimonProfileCardType(
      publisherCardType,
      "Official Digimon Card type",
    );
    if (cardType !== leafCardType) {
      throw new Error(
        "Official Digimon Card Type does not match the leaf cardcategory.",
      );
    }
    const levelValue = titleField("cardLv");
    const level = digimonCardLevel(levelValue, cardType);
    const info = exactDigimonClassBody(
      record,
      "div",
      "cardInfoCol",
      "Official Digimon Card information",
      /<\/div>\s*<!--\s*InfoCol\s*-->/iu,
    );
    const retainedQa = digimonCardQa(info);
    const pairs = htmlLabelPairs(retainedQa.remainingHtml);
    const allowedLabels = new Set([
      "Color", "Cost", "Play Cost", "Use Cost", "DP", "Form",
      "Attribute", "Type", "[Special Digivolution Condition]", "[Effect]",
      "Effect", "[Inherited Effect]", "Inherited Effect", "[Security Effect]",
      "Security Effect", "DUAL Color", "DUAL Cost", "[DUAL Effect]",
      "[DUAL Rule]", "[Link Condition]", "[Link DP]", "[Link Effect]",
      "Notes",
    ]);
    const unknownLabel = pairs.find(({ label }) =>
      !allowedLabels.has(label) && !/^Digivolve Cost \d+$/u.test(label)
    );
    if (unknownLabel !== undefined) {
      throw new Error(
        `Official Digimon Card List contains unknown field ${unknownLabel.label}.`,
      );
    }
    const duplicatedLabel = pairs.find(({ label }, pairIndex) =>
      pairs.findIndex((pair) => pair.label === label) !== pairIndex
    );
    if (duplicatedLabel !== undefined) {
      throw new Error(
        `Official Digimon Card List duplicates field ${duplicatedLabel.label}.`,
      );
    }
    const mediumHeadings = [...info.matchAll(
      /<div\b[^>]*\bclass=["'][^"']*\bcardInfoTitMedium\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/giu,
    )].map((match) => htmlText(match[1]!));
    if (mediumHeadings.some((heading) => !/^Card Text \d+$/u.test(heading))) {
      throw new Error(
        "Official Digimon Card List contains unrecognized Card text framing.",
      );
    }
    const field = (...names: string[]): string | null =>
      firstLabelValue(pairs, names);
    const digivolutionRequirements = pairs
      .filter(({ label }) => /^Digivolve Cost \d+$/u.test(label))
      .sort((left, right) => left.label.localeCompare(right.label, "en", {
        numeric: true,
      }))
      .map(({ value }, requirementIndex) => {
        const match = value.match(
          /^((?:Red|Blue|Green|Yellow|Black|Purple|White)(?:\s*\/\s*(?:Red|Blue|Green|Yellow|Black|Purple|White))*)\s+(\d+)\s+from\s+Lv\.?(\d+)$/iu,
        );
        if (match === null) {
          throw new Error(
            `Unrecognized official Digimon digivolution requirement: ${value}`,
          );
        }
        return {
          index: requirementIndex + 1,
          from_level: Number.parseInt(match[3]!, 10),
          colours: colourValues(match[1]!),
          cost: Number.parseInt(match[2]!, 10),
          raw_condition: value,
        };
      });
    const effect = requiredText(
      field("[Effect]", "Effect"),
      "Official Digimon Card effect",
    );
    const textSectionPairs = pairs.map(({ label, value }) => ({
      label: new Map([
        ["[Effect]", "Effect"],
        ["[Inherited Effect]", "Inherited Effect"],
        ["[Security Effect]", "Security Effect"],
      ]).get(label) ?? label,
      value,
    }));
    const imageContainer = exactDigimonClassBody(
      record,
      "div",
      "cardImgInner",
      "Official Digimon Printing image",
    );
    const imageMatches = [...imageContainer.matchAll(/<img\b([^>]*)>/giu)];
    if (imageMatches.length !== 1) {
      throw new Error(
        "Official Digimon Printing requires one exact front image.",
      );
    }
    const rawImageUrl = htmlAttribute(imageMatches[0]![1]!, "data-src") ??
      htmlAttribute(imageMatches[0]![1]!, "src");
    const imageUrl = new URL(
      requiredText(rawImageUrl, "Official Digimon Printing image URL"),
      requestUrl,
    );
    if (!officialUrl("digimon-en", imageUrl, "image")) {
      throw new Error("Official Digimon Printing image URL is not authoritative.");
    }
    const detail = canonicalDetail({
      popup_id: locator,
      card_number: cardNumber,
      name: exactDigimonClassText(
        record,
        "div",
        "cardTitle",
        "Official Digimon Card name",
      ),
      Effect: effect,
      profile: "digimon@1",
      product_codes: [],
      fuzzy_product_labels: [],
      distribution: {
        code: `listing:${new URL(requestUrl).search}`,
        kind: "source_bucket",
        label: field("Notes") ?? "Digimon Card List leaf",
      },
      printing: {
        rarity: requiredText(
          titleField("cardRarity"),
          "Official Digimon Printing rarity",
        ),
        attributes: { alternative_art: alternativeArtNumber !== undefined },
      },
      printed_rules: effect,
      variant: alternativeArtNumber === undefined
        ? "base"
        : `alternate-art-${Number.parseInt(alternativeArtNumber, 10)}`,
      image_url: imageUrl.href,
    }, {
      path: "popup_id",
      number: "card_number",
      title: "name",
      rules: "Effect",
      attributes: {
        card_type: cardType,
        colours: colourValues(field("Color")),
        level,
        play_cost: integerOrNull(field("Play Cost", "Cost")),
        use_cost: integerOrNull(field("Use Cost")),
        dp: integerOrNull(field("DP")),
        form: field("Form"),
        attribute: field("Attribute"),
        traits: textValues(field("Type")),
        digivolution_requirements: digivolutionRequirements,
        text_sections: digimonTextSections(textSectionPairs),
        dual_colours: colourValues(field("DUAL Color")),
        dual_cost: integerOrNull(field("DUAL Cost")),
        link_dp: integerOrNull(field("[Link DP]")),
      },
      imageFields: [{ role: "front", value: imageUrl.href }],
      preserveFuzzyProductLabels: true,
      derivePrintingIdentity: true,
    });
    const observation = cardObservation(
      detail,
      [],
      new Map(),
      { revision: "captured-by-policy-surface", entries: [] },
      { revision: "captured-by-policy-surface", entries: [] },
      "digimon",
    );
    return attachRawSurfaceEvidenceV1({
      ...observation,
      completeness: completeObservation(1, 1),
    }, "digimon-en", "card-list", {
      popup_id: locator,
      publisher_card_type: publisherCardType,
      publisher_level: levelValue,
      leaf_cardcategory: leafPublisherCardType,
      card_qa: retainedQa.entries,
    }, true, [
      "popup_id",
      "publisher_card_type",
      "publisher_level",
      "leaf_cardcategory",
    ]);
  });
}

const digimonProfileCardTypes = new Map([
  ["digi-egg", "digi_egg"],
  ["digimon", "digimon"],
  ["tamer", "tamer"],
  ["option", "option"],
  ["digimon/option", "digimon_option"],
]);

function digimonProfileCardType(value: unknown, name: string): string {
  const publisherType = requiredText(value, name);
  const normalizedPublisherType = publisherType.normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("en");
  const profileType = digimonProfileCardTypes.get(normalizedPublisherType);
  if (profileType === undefined) {
    throw new Error(`${name} is unknown.`);
  }
  return profileType;
}

function digimonCardLevel(value: string | null, cardType: string): number | null {
  if (value === null) return null;
  const normalized = value.normalize("NFKC").trim();
  if (/^(?:|-|—|n\/a|not available|unavailable)$/iu.test(normalized)) {
    return null;
  }
  const level = normalized.match(/^Lv\.(\d+)$/u)?.[1];
  if (level === undefined) {
    throw new Error(`Official Digimon ${cardType} level is invalid.`);
  }
  return Number.parseInt(level, 10);
}

function digimonDeclaredRecordCount(html: string): number {
  const containers = [...html.matchAll(
    /<div\b[^>]*\bclass=["'][^"']*\bresultTxt\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/giu,
  )];
  if (containers.length > 1) {
    throw new Error("Official Digimon Card List result count is duplicated.");
  }
  const container = containers[0];
  if (container === undefined) {
    throw new Error("Official Digimon Card List result count is unavailable.");
  }
  const count = htmlText(container[1]!).match(/^Result\s+(\d+)\s+cards?$/iu)?.[1];
  if (count === undefined) {
    throw new Error("Official Digimon Card List result count is invalid.");
  }
  return Number.parseInt(count, 10);
}

function digimonCardQa(infoHtml: string): {
  remainingHtml: string;
  entries: Record<string, unknown>[];
} {
  const listMatches = [...infoHtml.matchAll(
    /<ul\b[^>]*\bclass=["'][^"']*\bcardFaqList\b[^"']*["'][^>]*>([\s\S]*?)<\/ul>/giu,
  )];
  if (listMatches.length > 1) {
    throw new Error("Official Digimon Card Q&A list is duplicated.");
  }
  const match = listMatches[0];
  if (match === undefined) return { remainingHtml: infoHtml, entries: [] };
  const body = match[1]!;
  const starts = [...body.matchAll(
    /<li\b[^>]*\bclass=["'][^"']*\bcardFaqListItem\b[^"']*["'][^>]*>/giu,
  )].map((item) => item.index);
  if (starts.length === 0) {
    throw new Error("Official Digimon Card Q&A list is structurally empty.");
  }
  const entries = starts.map((start, index) => {
    const entry = body.slice(start, starts[index + 1] ?? body.length);
    return {
      number: exactDigimonClassText(
        entry,
        "p",
        "cardFaqNum",
        "Official Digimon Card Q&A number",
      ),
      date: digimonOptionalClassText(entry, "p", "cardFaqDate"),
      question: exactDigimonClassText(
        entry,
        "dt",
        "cardFaqQuestion",
        "Official Digimon Card Q&A question",
      ),
      answer: exactDigimonClassText(
        entry,
        "dd",
        "cardFaqAnswer",
        "Official Digimon Card Q&A answer",
      ),
    };
  });
  return {
    remainingHtml: infoHtml.replace(match[0], ""),
    entries,
  };
}

function exactHtmlClassName(attributes: string): string | null {
  const value = htmlAttribute(attributes, "class");
  if (value === null) return null;
  const names = value.trim().split(/\s+/u).filter(Boolean);
  return names.length === 1 ? names[0]! : null;
}

function exactDigimonClassBody(
  html: string,
  tag: string,
  className: string,
  label: string,
  closingPattern?: RegExp,
): string {
  const opening = new RegExp(
    `<${tag}\\b([^>]*\\bclass=["'][^"']*\\b${className}\\b[^"']*["'][^>]*)>`,
    "giu",
  );
  const matches = [...html.matchAll(opening)];
  if (matches.length !== 1) {
    throw new Error(`${label} requires one exact ${className} container.`);
  }
  const bodyStart = matches[0]!.index + matches[0]![0].length;
  const tail = html.slice(bodyStart);
  const closing = closingPattern ?? new RegExp(`</${tag}>`, "iu");
  const close = tail.match(closing);
  if (close?.index === undefined) {
    throw new Error(`${label} is structurally incomplete.`);
  }
  return tail.slice(0, close.index);
}

function exactDigimonClassText(
  html: string,
  tag: string,
  className: string,
  label: string,
): string {
  return requiredText(
    htmlText(exactDigimonClassBody(html, tag, className, label)),
    label,
  );
}

function digimonOptionalClassText(
  html: string,
  tag: string,
  className: string,
): string | null {
  const matches = [...html.matchAll(new RegExp(
    `<${tag}\\b[^>]*\\bclass=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)</${tag}>`,
    "giu",
  ))];
  if (matches.length > 1) {
    throw new Error(`Official Digimon Card Q&A duplicates ${className}.`);
  }
  return matches[0] === undefined ? null : htmlText(matches[0]![1]!);
}

function isLegalityPolicySurface(surface: string): boolean {
  return /(?:legality|restriction|block-policy|don-rules)/u.test(surface);
}

function isLegalityRuleSurface(
  game: ProductSourceGame,
  surface: string,
): boolean {
  return isLegalityPolicySurface(surface) ||
    (game === "one-piece" && surface === "releases");
}

function normalizeLineageSurface(
  format: DiscoveryFormat,
  sourceLineage: string,
  surface: string,
  raw: Record<string, unknown>,
  expandedOnePieceCatalogue = false,
  catalogueComplete = false,
  completeDigimonCatalogue = false,
): {
  document: Record<string, unknown>;
  consumedFields: readonly string[];
  unmappedOptionalFields: readonly { path: string; value: unknown }[];
} {
  const normalized =
    format === "one-piece"
      ? normalizeOnePieceSurface(surface, raw, expandedOnePieceCatalogue)
      : format === "fusion-world"
        ? normalizeFusionWorldSurface(surface, raw, catalogueComplete)
        : format === "digimon"
          ? normalizeDigimonSurface(surface, raw, completeDigimonCatalogue)
          : normalizeGundamSurface(sourceLineage, surface, raw);
  return {
    document: {
      contract: "card-keepr-official-source-surface@1",
      lineage: sourceLineage,
      surface,
      ...normalized.value,
    },
    consumedFields: normalized.consumedFields,
    unmappedOptionalFields:
      expandedOnePieceCatalogue && format === "one-piece"
        ? onePieceUnmappedOptionalFields(surface, raw)
        : [],
  };
}

type NormalizedSurfaceBody = {
  value: Record<string, unknown>;
  consumedFields: readonly string[];
};

function normalizedSurfaceBody(
  value: Record<string, unknown>,
  consumedFields: readonly string[],
): NormalizedSurfaceBody {
  return { value, consumedFields };
}

function normalizeOnePieceSurface(
  surface: string,
  raw: Record<string, unknown>,
  expandedOnePieceCatalogue = false,
): NormalizedSurfaceBody {
  if (surface === "card-list") {
    if (raw.page !== "card-list") {
      throw new Error("One Piece card-list page identity is invalid.");
    }
    return normalizedSurfaceBody(
      normalizedDiscovery(
        raw.series_options,
        raw.page_info,
        expandedOnePieceCatalogue
          ? normalizeOnePieceDetails(raw.card_pages)
          : normalizeOnePieceDetailsV2(raw.card_pages),
        normalizeOnePieceProducts(raw.products),
        normalizeOnePieceReleases(raw.release_schedule),
        "recording",
        exactOnePieceLeaves(raw.series_options),
      ),
      [
        "page",
        "series_options",
        "page_info",
        "card_pages",
        "products",
        "release_schedule",
      ],
    );
  }
  if (surface === "products") {
    if (raw.page !== "product-list") {
      throw new Error("One Piece Product page identity is invalid.");
    }
    return normalizedSurfaceBody(
      normalizedPartitions(
        normalizePartitionEntries(raw.result, normalizeOnePieceProduct),
        "recording",
      ),
      ["page", "series_options", "result"],
    );
  }
  if (surface === "releases") {
    if (raw.publication !== "release-schedule") {
      throw new Error("One Piece Release publication identity is invalid.");
    }
    return normalizedSurfaceBody(
      {
        ...normalizedPartitions(
        normalizePartitionEntries(raw.events, normalizeOnePieceReleaseEntry),
        "release-event",
        ),
        entries: requiredArray(
          raw.release_timing_entries,
          "One Piece release-timing entries",
        ),
      },
      ["publication", "events", "release_timing_entries"],
    );
  }
  if (!expandedOnePieceCatalogue) {
    return normalizedSurfaceBody(
      normalizedPolicy(raw, `one-piece-${surface}`),
      [
        "publication",
        "revision",
        "declared_record_count",
        "partition",
        "entries",
      ],
    );
  }
  const policy = normalizedPolicy(
    raw,
    `one-piece-${surface}`,
    surface === "don-rules" ? ["don_card"] : [],
  );
  const hasDonCard = surface === "don-rules";
  return normalizedSurfaceBody(
    {
      ...policy,
      ...(hasDonCard
        ? {
            don_card: requiredRecord(
              raw.don_card,
              "One Piece DON!! rules Card",
            ),
          }
        : {}),
    },
    [
      "publication",
      "revision",
      "declared_record_count",
      "partition",
      "entries",
      ...(hasDonCard ? ["don_card"] : []),
    ],
  );
}

function normalizeFusionWorldSurface(
  surface: string,
  raw: Record<string, unknown>,
  catalogueComplete = false,
): NormalizedSurfaceBody {
  if (surface === "card-search") {
    if (raw.view !== "card-search") {
      throw new Error("Fusion World card-search view identity is invalid.");
    }
    const facets = requiredRecord(raw.facets, "Fusion World facets");
    for (const name of ["card_type", "colour", "cost"]) {
      requiredArray(facets[name], `Fusion World ${name} facet`);
    }
    return normalizedSurfaceBody(
      normalizedDiscovery(
        Object.entries(facets).map(([name, values]) => ({ name, values })),
        raw.result,
        normalizeFusionWorldDetails(raw.detail_pages, catalogueComplete),
        normalizeFusionWorldProducts(raw.products),
        normalizeFusionWorldReleases(raw.releases),
        "card_type=leader&colour=red&cost=1",
        exactFusionLeaves(facets),
      ),
      ["view", "facets", "result", "detail_pages", "products", "releases"],
    );
  }
  if (surface === "products") {
    if (raw.view !== "products") {
      throw new Error("Fusion World Product view identity is invalid.");
    }
    const tabs = uniqueTextValues(raw.status_tabs, "Fusion World Product tabs");
    if (!tabs.includes("available") || !tabs.includes("coming-soon")) {
      throw new Error("Fusion World Product tabs are incomplete.");
    }
    if (catalogueComplete) {
      requireFusionWorldProductStatusLeaves(raw.result, tabs);
    }
    return normalizedSurfaceBody(
      normalizedPartitions(
        normalizePartitionEntries(raw.result, normalizeFusionWorldProduct),
        "product-status",
      ),
      ["view", "status_tabs", "result"],
    );
  }
  if (surface === "releases") {
    if (raw.publication !== "product-release-dates") {
      throw new Error("Fusion World Release publication identity is invalid.");
    }
    return normalizedSurfaceBody(
      normalizedPartitions(
        normalizePartitionEntries(raw.events, normalizeFusionWorldReleaseEntry),
        "release-event",
      ),
      ["publication", "events"],
    );
  }
  return normalizedSurfaceBody(
    normalizedPolicy(raw, `fusion-world-${surface}`),
    ["publication", "revision", "declared_record_count", "partition", "entries"],
  );
}

function requireFusionWorldProductStatusLeaves(
  value: unknown,
  statuses: readonly string[],
): void {
  const result = requiredRecord(
    value,
    "Fusion World Product partition result",
  );
  const leaves = new Set(
    requiredArray(
      result.partitions,
      "Fusion World Product status leaves",
    ).map((item) =>
      requiredText(
        requiredRecord(item, "Fusion World Product status leaf").bucket,
        "Fusion World Product status leaf identity",
      )
    ),
  );
  const missing = statuses.filter((status) => !leaves.has(status));
  const unexpected = [...leaves].filter((status) => !statuses.includes(status));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Fusion World Product status leaves do not match the discovered tabs; missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}.`,
    );
  }
}

function normalizeDigimonSurface(
  surface: string,
  raw: Record<string, unknown>,
  completeDigimonCatalogue = false,
): NormalizedSurfaceBody {
  if (surface === "card-list") {
    if (raw.view !== "card-list") {
      throw new Error("Digimon card-list view identity is invalid.");
    }
    const filters = requiredRecord(raw.filters, "Digimon filters");
    for (const name of ["category", "cardcategory", "colour"]) {
      requiredArray(filters[name], `Digimon ${name} filter`);
    }
    return normalizedSurfaceBody(
      normalizedDiscovery(
        raw.version_options,
        raw.result,
        normalizeDigimonDetails(raw.card_popups, completeDigimonCatalogue),
        normalizeDigimonProducts(raw.products),
        normalizeDigimonReleases(raw.release_calendar),
        "category=all&cardcategory=digimon&colour=blue",
        exactDigimonLeaves(filters),
      ),
      [
        "view",
        "version_options",
        "filters",
        "result",
        "card_popups",
        "products",
        "release_calendar",
      ],
    );
  }
  if (surface === "products") {
    if (raw.view !== "product-index") {
      throw new Error("Digimon Product index identity is invalid.");
    }
    requiredArray(raw.tile_categories, "Digimon Product tile categories");
    return normalizedSurfaceBody(
      normalizedPartitions(
        normalizePartitionEntries(raw.result, normalizeDigimonProduct),
        "product-category",
      ),
      ["view", "tile_categories", "result"],
    );
  }
  if (surface === "releases") {
    if (raw.publication !== "product-release-calendar") {
      throw new Error("Digimon Release publication identity is invalid.");
    }
    return normalizedSurfaceBody(
      normalizedPartitions(
        normalizePartitionEntries(raw.events, normalizeDigimonReleaseEntry),
        "release-event",
      ),
      ["publication", "events"],
    );
  }
  return normalizedSurfaceBody(
    normalizedPolicy(raw, `digimon-${surface}`),
    ["publication", "revision", "declared_record_count", "partition", "entries"],
  );
}

function normalizeGundamSurface(
  sourceLineage: string,
  surface: string,
  raw: Record<string, unknown>,
): NormalizedSurfaceBody {
  const expectedLocale =
    sourceLineage === "gundam-en-asia" ? "EN-ASIA" : "EN-US";
  if (raw.locale !== expectedLocale) {
    throw new Error("Gundam surface locale does not match its Source Lineage.");
  }
  if (surface === "packages") {
    if (raw.view !== "card-search") {
      throw new Error("Gundam card-search view identity is invalid.");
    }
    return normalizedSurfaceBody(
      normalizedDiscovery(
        raw.package_options,
        raw.result,
        normalizeGundamDetails(raw.card_details),
        normalizeGundamProducts(raw.products),
        normalizeGundamReleases(raw.releases),
        "package=all",
        exactGundamLeaves(raw.package_options),
      ),
      [
        "view",
        "locale",
        "package_options",
        "result",
        "card_details",
        "products",
        "releases",
      ],
    );
  }
  if (surface === "products") {
    if (raw.view !== "product-list") {
      throw new Error("Gundam Product list identity is invalid.");
    }
    return normalizedSurfaceBody(
      normalizedPartitions(
        normalizePartitionEntries(raw.result, normalizeGundamProduct),
        "package",
      ),
      ["view", "locale", "result"],
    );
  }
  if (surface === "releases") {
    if (raw.publication !== "locale-product-release-dates") {
      throw new Error("Gundam Release publication identity is invalid.");
    }
    return normalizedSurfaceBody(
      normalizedPartitions(
        normalizePartitionEntries(raw.events, normalizeGundamReleaseEntry),
        "release-event",
      ),
      ["publication", "locale", "events"],
    );
  }
  return normalizedSurfaceBody(
    normalizedPolicy(raw, `gundam-${surface}`),
    ["publication", "locale", "revision", "declared_record_count", "partition", "entries"],
  );
}

function normalizedDiscovery(
  discoveredVocabulary: unknown,
  partition: unknown,
  details: unknown,
  products: unknown,
  releases: unknown,
  bucket: string,
  expectedLeaves: readonly string[],
): Record<string, unknown> {
  const page = requiredRecord(partition, "Official Source result");
  if (page.cap_signal !== undefined && page.cap_signal !== null) {
    throw new Error(
      "Official Source partition result-cap evidence does not prove complete coverage.",
    );
  }
  const partitions = requiredArray(
    page.partitions,
    "Official Source partitions",
  );
  const actualLeaves = partitions.map((value) =>
    requiredText(
      requiredRecord(value, "Official Source partition").bucket,
      "Official Source leaf partition",
    )
  );
  if (
    expectedLeaves.length === 0 ||
    actualLeaves.length !== expectedLeaves.length ||
    new Set(actualLeaves).size !== actualLeaves.length ||
    [...actualLeaves].sort().some(
      (value, index) => value !== [...expectedLeaves].sort()[index],
    )
  ) {
    throw new Error(
      `Official Source discovered vocabulary does not close over exact leaf partitions for ${bucket}.`,
    );
  }
  return {
    source_buckets: [bucket],
    facets: requiredArray(
      discoveredVocabulary,
      "Official Source discovered vocabulary",
    ),
    partitions,
    details: requiredArray(details, "Official Source details"),
    products: requiredArray(products, "Official Source Products"),
    releases: requiredArray(releases, "Official Source Releases"),
  };
}

function exactOnePieceLeaves(value: unknown): string[] {
  return requiredArray(value, "One Piece Recording vocabulary").map((item) => {
    if (typeof item === "string") return requiredText(item, "Recording");
    const record = requiredRecord(item, "One Piece Recording");
    return requiredText(record.value, "One Piece Recording value");
  });
}

function exactFusionLeaves(facets: Record<string, unknown>): string[] {
  const cardTypes = uniqueTextValues(
    facets.card_type,
    "Fusion World Card Type facets",
  );
  const colours = uniqueTextValues(
    facets.colour,
    "Fusion World Colour facets",
  );
  const costs = uniqueTextValues(
    facets.cost,
    "Fusion World Cost facets",
  );
  return cardTypes.flatMap((cardType) =>
    colours.flatMap((colour) =>
      costs.map(
        (cost) =>
          `card_type=${cardType.toLowerCase()}&colour=${colour.toLowerCase()}&cost=${cost}`,
      )
    )
  );
}

function exactDigimonLeaves(filters: Record<string, unknown>): string[] {
  const categories = uniqueTextValues(
    filters.category,
    "Digimon Category filters",
  );
  const cardCategories = uniqueTextValues(
    filters.cardcategory,
    "Digimon Card Type filters",
  );
  const colours = uniqueTextValues(
    filters.colour,
    "Digimon Colour filters",
  );
  return categories.flatMap((category) =>
    cardCategories.flatMap((cardCategory) =>
      colours.map(
        (colour) =>
          `category=${category.toLowerCase()}&cardcategory=${cardCategory.toLowerCase()}&colour=${colour.toLowerCase()}`,
      )
    )
  );
}

function exactGundamLeaves(value: unknown): string[] {
  return requiredArray(value, "Gundam package vocabulary").map((item) => {
    if (typeof item === "string") {
      return `package=${requiredText(item, "Gundam package")}`;
    }
    const record = requiredRecord(item, "Gundam package");
    return `package=${requiredText(record.value, "Gundam package value")}`;
  });
}

function normalizedPartitions(
  value: unknown,
  bucket: string,
): Record<string, unknown> {
  const result = requiredRecord(value, "Official Source partition result");
  if (result.cap_signal !== undefined && result.cap_signal !== null) {
    throw new Error(
      "Official Source partition result-cap evidence does not prove complete coverage.",
    );
  }
  return {
    partitions: requiredArray(
      result.partitions,
      `Official Source ${bucket} partitions`,
    ),
  };
}

function normalizedPolicy(
  raw: Record<string, unknown>,
  expectedPublication: string,
  additionalFields: readonly string[] = [],
): Record<string, unknown> {
  if (raw.publication !== expectedPublication) {
    throw new Error("Official policy publication identity is invalid.");
  }
  const allowed = new Set([
    "publication", "locale", "revision", "declared_record_count",
    "partition", "entries", ...additionalFields,
  ]);
  const unknown = Object.keys(raw).find((field) => !allowed.has(field));
  if (unknown !== undefined) {
    throw new Error(`Official policy contains unknown field ${unknown}.`);
  }
  const entries = requiredArray(raw.entries, "Official policy entries");
  const declaredRecordCount = requiredNonNegativeInteger(
    raw.declared_record_count,
    "Official policy declared record count",
  );
  const partition = requiredRecord(raw.partition, "Official policy partition");
  const partitionFields = ["page", "pages", "total", "has_next"];
  const unknownPartitionField = Object.keys(partition).find((field) =>
    !partitionFields.includes(field)
  );
  if (unknownPartitionField !== undefined) {
    throw new Error(
      `Official policy partition contains unknown field ${unknownPartitionField}.`,
    );
  }
  if (
    partition.page !== 1 || partition.pages !== 1 ||
    partition.has_next !== false || partition.total !== declaredRecordCount
  ) {
    throw new Error("Official policy partition is incomplete or conflicts with its declared total.");
  }
  if (declaredRecordCount !== entries.length) {
    throw new Error(
      `Official policy declares ${declaredRecordCount} records but exactly ${entries.length} were parsed.`,
    );
  }
  return {
    revision: requiredText(raw.revision, "Official policy revision"),
    declared_record_count: declaredRecordCount,
    entries,
  };
}

function normalizePartitionEntries(
  value: unknown,
  entry: (value: unknown) => unknown,
): Record<string, unknown> {
  const result = requiredRecord(value, "Official Source partition result");
  return {
    ...result,
    partitions: requiredArray(
      result.partitions,
      "Official Source partitions",
    ).map((rawPage) => {
      const page = requiredRecord(rawPage, "Official Source partition");
      return {
        ...page,
        entries: requiredArray(
          page.entries,
          "Official Source partition entries",
        ).map(entry),
      };
    }),
  };
}

function normalizeOnePieceDetails(value: unknown): unknown[] {
  return requiredArray(value, "One Piece Card pages").map((item) => {
    const card = requiredRecord(item, "One Piece Card page");
    const printing = card.printing === undefined
      ? null
      : requiredRecord(card.printing, "One Piece Printing fields");
    const forbiddenIdentityField = [
      "artwork_fingerprint",
      "printed_fields_digest",
    ].find((field) =>
      Object.hasOwn(card, field) ||
      (printing !== null && Object.hasOwn(printing, field))
    );
    if (forbiddenIdentityField !== undefined) {
      throw new Error(
        `One Piece raw Card pages cannot supply identity digest ${forbiddenIdentityField}.`,
      );
    }
    const normalized = normalizeOnePieceCardPage(card);
    const cardNumber = requiredText(card.card_number, "One Piece Card number");
    return canonicalDetail(card, {
      path: "source_record_id",
      number: "card_number",
      title: "name",
      rules: "Effect",
      attributes: normalized.attributes,
      printingAttributes: normalized.printingAttributes,
      normalizedRarity: normalized.normalizedRarity,
      artworkFingerprint: officialArtworkFingerprint(
        cardNumber,
        ["front"],
        null,
      ),
      printedFieldsDigest: `printed-material:${JSON.stringify(stableValue({
        card_number: cardNumber,
        category: card.Category,
        colour: card.Color,
        cost: card.Cost,
        life: card.Life,
        attribute: card.Attribute,
        power: card.Power,
        counter: card.Counter,
        type: card.Type,
        block_icon: card["Block icon"],
        effect: card.Effect,
        trigger: card.Trigger,
        rarity: printing?.rarity ?? null,
        variant: card.variant ?? null,
      }))}`,
      imageFields: [{ role: "front", value: card.image_url }],
    });
  });
}

function normalizeOnePieceDetailsV2(value: unknown): unknown[] {
  return requiredArray(value, "One Piece Card pages").map((item) => {
    const card = requiredRecord(item, "One Piece Card page");
    return canonicalDetail(card, {
      path: "source_record_id",
      number: "card_number",
      title: "name",
      rules: "Effect",
      attributes: {
        card_type: card.Category,
        colours: card.Color,
        cost: card.Cost,
        life: card.Life,
        battle_attributes: card.Attribute,
        power: card.Power,
        counter: card.Counter,
        traits: card.Type,
        block_icons: card["Block icon"],
        effect_text: card.Effect,
        trigger_text: card.Trigger,
      },
      imageFields: [{ role: "front", value: card.image_url }],
    });
  });
}

function normalizeFusionWorldDetails(
  value: unknown,
  validateIdentity = false,
): unknown[] {
  return requiredArray(value, "Fusion World Card details").map((item) => {
    const card = requiredRecord(item, "Fusion World Card detail");
    if (validateIdentity) validateFusionWorldDetailIdentity(card);
    const images = requiredArray(
      card.image_urls,
      "Fusion World Card images",
    ).map((image) => {
      const record = requiredRecord(image, "Fusion World Card image");
      return {
        role: requiredText(record.role, "Fusion World image role"),
        value: record.url,
      };
    });
    if (
      card.card_type === "leader" &&
      (
        images.length !== 2 ||
        new Set(images.map(({ role }) => role)).size !== 2 ||
        !images.some(({ role }) => role === "front") ||
        !images.some(({ role }) => role === "back")
      )
    ) {
      throw new Error(
        "Fusion World Leader requires exact front and back image roles.",
      );
    }
    return canonicalDetail(
      validateIdentity
        ? fusionWorldPublisherDetailV3(card, images)
        : card,
      {
        path: "detail_path",
        number: "card_number",
        title: "name",
        rules: "skills_text",
        attributes: {
          card_type: card.card_type,
          colours: card.color,
          cost: card.cost,
          specified_cost: card.specified_cost,
          power: card.power,
          combo_power: card.combo_power,
          traits: card.special_traits,
          skills: card.skills,
          ...(card.leader_faces === undefined
            ? {}
            : { leader_faces: card.leader_faces }),
        },
        imageFields: images,
      },
    );
  });
}

function fusionWorldPublisherDetailV3(
  card: Record<string, unknown>,
  images: readonly { role: string; value: unknown }[],
): Record<string, unknown> {
  const prohibited = [
    "profile",
    "artwork_fingerprint",
    "printed_fields_digest",
  ].find((field) => Object.hasOwn(card, field));
  if (prohibited !== undefined) {
    throw new Error(
      `Fusion World detail contains caller-supplied canonical field ${prohibited}.`,
    );
  }
  const printing = card.printing === undefined
    ? undefined
    : requiredRecord(card.printing, "Fusion World Printing fields");
  if (printing !== undefined && Object.hasOwn(printing, "normalized_rarity")) {
    throw new Error(
      "Fusion World detail contains caller-supplied canonical field normalized_rarity.",
    );
  }
  const cardNumber = requiredText(
    card.card_number,
    "Fusion World Card number",
  );
  const variant = requiredText(card.variant, "Fusion World variant suffix");
  const rarity = printing === undefined
    ? null
    : nullableText(printing.rarity, "Fusion World Printing rarity");
  const printedFields = {
    card_number: cardNumber,
    card_type: card.card_type,
    color: card.color,
    combo_power: card.combo_power,
    cost: card.cost,
    power: card.power,
    printed_rules: card.printed_rules,
    skills: card.skills,
    special_traits: card.special_traits,
    specified_cost: card.specified_cost,
    rarity,
    variant,
  };
  return {
    ...card,
    profile: "fusion-world@1",
    ...(printing === undefined
      ? {}
      : {
          printing: {
            ...printing,
            normalized_rarity: rarity?.toLowerCase() ?? null,
          },
          artwork_fingerprint: officialArtworkFingerprint(
            cardNumber,
            images.map(({ role }) => role),
            variant,
          ),
          printed_fields_digest:
            `printed-material:${JSON.stringify(stableValue(printedFields))}`,
        }),
  };
}

function validateFusionWorldDetailIdentity(
  card: Record<string, unknown>,
): void {
  const locator = requiredText(
    card.detail_path,
    "Fusion World full locator",
  );
  const cardNumber = requiredText(
    card.card_number,
    "Fusion World Card number",
  );
  const variant = requiredText(
    card.variant,
    "Fusion World variant suffix",
  );
  const expectedLocatorTail = variant === "base"
    ? cardNumber
    : `${cardNumber}${variant}`;
  const locatorTail = locator.split("/").filter(Boolean).at(-1);
  if (locatorTail !== expectedLocatorTail) {
    throw new Error(
      `Fusion World full locator ${locator} does not match Card number ${cardNumber} and variant ${variant}.`,
    );
  }
}

function normalizeDigimonDetails(
  value: unknown,
  completeCatalogue = false,
): unknown[] {
  return requiredArray(value, "Digimon Card popups").map((item) => {
    const card = requiredRecord(item, "Digimon Card popup");
    return canonicalDetail(card, {
      path: "popup_id",
      number: "card_number",
      title: "name",
      rules: "Effect",
      attributes: {
        card_type: card.cardcategory,
        colours: card.Color,
        level: card.Lv,
        play_cost: card["Play Cost"],
        use_cost: card["Use Cost"],
        dp: card.DP,
        form: card.Form,
        attribute: card.Attribute,
        traits: card.Type,
        digivolution_requirements: card["Digivolution Cost"],
        text_sections: card.text_sections,
        dual_colours: card["DUAL Color"],
        dual_cost: card["DUAL Cost"],
        link_dp: card["Link DP"],
      },
      imageFields: [{ role: "front", value: card.image_url }],
      preserveFuzzyProductLabels: completeCatalogue,
      derivePrintingIdentity: completeCatalogue,
    });
  });
}

function normalizeGundamDetails(value: unknown): unknown[] {
  return requiredArray(value, "Gundam Card details").map((item) => {
    const card = requiredRecord(item, "Gundam Card detail");
    return canonicalDetail(card, {
      path: "detailSearch",
      number: "card_number",
      title: "name",
      rules: "Effect",
      attributes: {
        card_type: card.Type,
        colours: card.Color,
        level: card.Level,
        cost: card.Cost,
        block_icon: card.Block,
        effect_text: card.Effect,
        zone: card.Zone,
        traits: card.Trait,
        link_condition: card.Link,
        ap: card.AP,
        hp: card.HP,
        series_titles: card.Title,
      },
      imageFields: [{ role: "front", value: card.image_url }],
    });
  });
}

function canonicalDetail(
  raw: Record<string, unknown>,
  mapping: {
    path: string;
    number: string;
    title: string;
    rules: string;
    attributes: Record<string, unknown>;
    printingAttributes?: Record<string, unknown>;
    normalizedRarity?: string | null;
    artworkFingerprint?: string;
    printedFieldsDigest?: string;
    imageFields: readonly { role: string; value: unknown }[];
    preserveFuzzyProductLabels?: boolean;
    derivePrintingIdentity?: boolean;
  },
): Record<string, unknown> {
  const printing =
    raw.printing === undefined
      ? undefined
      : requiredRecord(raw.printing, "Official Printing fields");
  if (
    mapping.derivePrintingIdentity === true &&
    (
      raw.artwork_fingerprint !== undefined ||
      raw.printed_fields_digest !== undefined ||
      printing?.normalized_rarity !== undefined
    )
  ) {
    throw new Error(
      "Official Source publisher data must not supply normalized rarity, artwork identity, or printed-fields digest.",
    );
  }
  const path = requiredText(raw[mapping.path], "Official Card locator");
  const number = requiredText(raw[mapping.number], "Official Card number");
  const rules = requiredText(raw[mapping.rules], "Official Card rules");
  const artworkFingerprint = printing === undefined
    ? null
    : mapping.artworkFingerprint ??
      (mapping.derivePrintingIdentity === true
        ? officialArtworkFingerprint(
            number,
            mapping.imageFields.map(({ role }) => role),
            path,
          )
        : requiredText(
            raw.artwork_fingerprint,
            "Official artwork fingerprint",
          ));
  const images =
    printing === undefined
      ? []
      : mapping.imageFields.map(({ role, value }) => ({
          role,
          source_url: requiredText(value, "Official Printing image URL"),
          artwork_fingerprint: artworkFingerprint,
        }));
  return {
    path,
    number,
    title: requiredText(raw[mapping.title], "Official Card name"),
    rules,
    profile: requiredText(raw.profile, "Official Game Profile"),
    attributes: mapping.attributes,
    product_codes: requiredTextArray(
      raw.product_codes,
      "Official Product codes",
    ),
    ...(!mapping.preserveFuzzyProductLabels ||
        raw.fuzzy_product_labels === undefined
      ? {}
      : {
          fuzzy_product_labels: requiredTextArray(
            raw.fuzzy_product_labels,
            "Unresolved Official Product labels",
          ),
        }),
    ...(raw.product_names === undefined
      ? {}
      : {
          product_names: requiredTextArray(
            raw.product_names,
            "Official Product names",
          ),
        }),
    distribution: requiredRecord(
      raw.distribution,
      "Official Distribution",
    ),
    ...(printing === undefined
      ? {}
      : {
          printing: {
            rarity: printing.rarity ?? null,
            normalizedRarity: mapping.normalizedRarity !== undefined
              ? mapping.normalizedRarity
              : mapping.derivePrintingIdentity === true
                ? normalizedDigimonRarity(printing.rarity)
                : printing.normalized_rarity ?? null,
            attributes: Object.hasOwn(mapping, "printingAttributes")
              ? mapping.printingAttributes ?? {}
              : printing.attributes ?? {},
          },
          printed_rules: requiredText(
            raw.printed_rules,
            "Official printed rules",
          ),
          variant: requiredText(raw.variant, "Official Printing variant"),
          artwork_fingerprint: artworkFingerprint,
          printed_fields_digest: mapping.printedFieldsDigest ??
            (mapping.derivePrintingIdentity === true
              ? `printed-material:${JSON.stringify(stableValue({
                  rules: requiredText(
                    raw.printed_rules,
                    "Official printed rules",
                  ),
                  rarity: printing.rarity ?? null,
                  attributes: printing.attributes ?? {},
                }))}`
              : requiredText(
                  raw.printed_fields_digest,
                  "Official printed fields digest",
                )),
          image: images[0]!.source_url,
          images,
        }),
  };
}

function normalizedDigimonRarity(value: unknown): string | null {
  if (value === null) return null;
  const raw = requiredText(value, "Official Digimon rarity");
  const normalized = new Map([
    ["c", "common"],
    ["common", "common"],
    ["u", "uncommon"],
    ["uncommon", "uncommon"],
    ["r", "rare"],
    ["rare", "rare"],
    ["sr", "super-rare"],
    ["super rare", "super-rare"],
    ["sec", "secret-rare"],
    ["secret rare", "secret-rare"],
    ["p", "promo"],
    ["promo", "promo"],
  ]).get(raw.toLowerCase());
  if (normalized === undefined) {
    throw new Error("Official Digimon rarity vocabulary is unsupported.");
  }
  return normalized;
}

function normalizeOnePieceProducts(value: unknown): unknown[] {
  return requiredArray(value, "One Piece Products").map(
    normalizeOnePieceProduct,
  );
}

function normalizeFusionWorldProducts(value: unknown): unknown[] {
  return requiredArray(value, "Fusion World Products").map(
    normalizeFusionWorldProduct,
  );
}

function normalizeDigimonProducts(value: unknown): unknown[] {
  return requiredArray(value, "Digimon Products").map(
    normalizeDigimonProduct,
  );
}

function normalizeGundamProducts(value: unknown): unknown[] {
  return requiredArray(value, "Gundam Products").map(
    normalizeGundamProduct,
  );
}

function normalizeOnePieceProduct(value: unknown): Record<string, unknown> {
  const product = requiredRecord(value, "One Piece Product");
  return canonicalProduct(product, "product_code", "product_name");
}

function normalizeFusionWorldProduct(value: unknown): Record<string, unknown> {
  const product = requiredRecord(value, "Fusion World Product");
  return canonicalProduct(product, "productCode", "productName");
}

function normalizeDigimonProduct(value: unknown): Record<string, unknown> {
  const product = requiredRecord(value, "Digimon Product");
  return canonicalProduct(product, "productId", "productTitle");
}

function normalizeGundamProduct(value: unknown): Record<string, unknown> {
  const product = requiredRecord(value, "Gundam Product");
  return canonicalProduct(product, "productCode", "productName");
}

function canonicalProduct(
  product: Record<string, unknown>,
  codeField: string,
  nameField: string,
): Record<string, unknown> {
  return {
    code: optionalOfficialCode(
      product[codeField],
      "Official Product code",
    ),
    title: requiredText(product[nameField], "Official Product name"),
    ...(product.distribution === undefined
      ? {}
      : { distribution: product.distribution }),
    ...Object.fromEntries(
      Object.entries(product).filter(([field]) =>
        field !== codeField &&
        field !== nameField &&
        field !== "distribution"
      ),
    ),
  };
}

function normalizeOnePieceReleases(value: unknown): unknown[] {
  return requiredArray(value, "One Piece Releases").map((item) =>
    canonicalRelease(requiredRecord(item, "One Piece Release"), {
      code: "product_code",
      event: "announcement_id",
    })
  );
}

function normalizeFusionWorldReleases(value: unknown): unknown[] {
  return requiredArray(value, "Fusion World Releases").map((item) =>
    canonicalRelease(requiredRecord(item, "Fusion World Release"), {
      code: "productCode",
      event: "releaseId",
    })
  );
}

function normalizeDigimonReleases(value: unknown): unknown[] {
  return requiredArray(value, "Digimon Releases").map((item) =>
    canonicalRelease(requiredRecord(item, "Digimon Release"), {
      code: "productId",
      event: "calendarEntryId",
    })
  );
}

function normalizeGundamReleases(value: unknown): unknown[] {
  return requiredArray(value, "Gundam Releases").map((item) =>
    canonicalRelease(requiredRecord(item, "Gundam Release"), {
      code: "productCode",
      event: "releaseEventId",
    })
  );
}

function normalizeOnePieceReleaseEntry(value: unknown): unknown {
  return canonicalReleaseEntry(value, normalizeOnePieceProduct, (release) =>
    canonicalRelease(release, {
      code: "product_code",
      event: "announcement_id",
    }));
}

function normalizeFusionWorldReleaseEntry(value: unknown): unknown {
  return canonicalReleaseEntry(value, normalizeFusionWorldProduct, (release) =>
    canonicalRelease(release, {
      code: "productCode",
      event: "releaseId",
    }));
}

function normalizeDigimonReleaseEntry(value: unknown): unknown {
  return canonicalReleaseEntry(value, normalizeDigimonProduct, (release) =>
    canonicalRelease(release, {
      code: "productId",
      event: "calendarEntryId",
    }));
}

function normalizeGundamReleaseEntry(value: unknown): unknown {
  return canonicalReleaseEntry(value, normalizeGundamProduct, (release) =>
    canonicalRelease(release, {
      code: "productCode",
      event: "releaseEventId",
    }));
}

function canonicalReleaseEntry(
  value: unknown,
  product: (value: unknown) => Record<string, unknown>,
  release: (value: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  const entry = requiredRecord(value, "Official Release entry");
  const normalizedProduct = product(entry.product);
  const normalizedRelease = release(
    requiredRecord(entry.release, "Official Release facts"),
  );
  return {
    product: normalizedProduct,
    release: {
      ...normalizedRelease,
      product_title: normalizedProduct.title,
    },
  };
}

function canonicalRelease(
  release: Record<string, unknown>,
  fields: { code: string; event: string },
): Record<string, unknown> {
  return {
    code: optionalOfficialCode(
      release[fields.code],
      "Official Release Product code",
    ),
    event_key: requiredText(release[fields.event], "Official Release identity"),
    ...(release.productName === undefined &&
        release.product_name === undefined &&
        release.productTitle === undefined
      ? {}
      : {
          product_title: requiredText(
            release.productName ??
              release.product_name ??
              release.productTitle,
            "Official Release Product name",
          ),
        }),
    region: release.region,
    precision: release.precision,
    date: release.date,
    status: release.status,
  };
}

function attachRawSurfaceEvidenceV1(
  observation: unknown,
  sourceLineage: string,
  surface: string,
  document: Record<string, unknown>,
  retainDocument: boolean,
  mappedRootFields: readonly string[],
  explicitUnmappedFields: readonly { path: string; value: unknown }[] = [],
): Record<string, unknown> {
  const record = requiredRecord(
    observation,
    `Official Source ${surface} observation`,
  );
  const existing =
    record.source_sidecar === undefined
      ? {}
      : requiredRecord(record.source_sidecar, "Source sidecar");
  const raw =
    existing.raw === undefined
      ? {}
      : requiredRecord(existing.raw, "Source sidecar raw fields");
  const consumed = Array.isArray(existing.consumed_fields)
    ? existing.consumed_fields
    : [];
  const unmapped = Array.isArray(existing.unmapped_optional_fields)
    ? existing.unmapped_optional_fields
      : [];
  const retainedMappedLeaves = retainDocument
    ? mappedRootFields.flatMap((field) =>
        partitionMappedOfficialLeaves(
          document[field],
          `source_sidecar.raw.official_surfaces[0].document.${field}`,
        )
      )
    : [];
  const explicitlyUnmappedPaths = new Set(
    explicitUnmappedFields.map(({ path }) => path),
  );
  return {
    ...record,
    source_sidecar: {
      ...existing,
      raw: {
        ...raw,
        official_surfaces: [
          ...(
            Array.isArray(raw.official_surfaces)
              ? raw.official_surfaces
              : []
          ),
          {
            source_lineage: sourceLineage,
            surface,
            ...(retainDocument
              ? { document }
              : { retained_by_observation_ordinal: 1 }),
          },
        ],
      },
      consumed_fields: [
        ...new Set([
          ...consumed,
          "source_sidecar.raw.official_surfaces[].source_lineage",
          "source_sidecar.raw.official_surfaces[].surface",
          ...retainedMappedLeaves.flatMap(({ consumed }) =>
            consumed.filter((path) => !explicitlyUnmappedPaths.has(path))
          ),
        ]),
      ].sort(),
      unmapped_optional_fields: [
        ...unmapped,
        ...retainedMappedLeaves.flatMap(({ unmapped }) => unmapped),
        ...(retainDocument ? explicitUnmappedFields : []),
        ...(retainDocument ? Object.entries(document) : [])
          .filter(([field]) => !mappedRootFields.includes(field))
          .flatMap(([field, value]) =>
            leafEntries(
              value,
              `source_sidecar.raw.official_surfaces[0].document.${field}`,
            )
          ),
      ],
    },
  };
}

function parseRawDiscoverySurfaceFrozenV1(
  surface: Record<string, unknown>,
  format: DiscoveryFormat,
  game: ProductSourceGame,
): readonly unknown[] {
  return parseRawDiscoverySurfaceByContract(surface, format, game, false);
}

function parseRawDiscoverySurfaceCompleteOnePieceV3(
  surface: Record<string, unknown>,
  format: DiscoveryFormat,
  game: ProductSourceGame,
): readonly unknown[] {
  return parseRawDiscoverySurfaceByContract(surface, format, game, true);
}

function parseRawDiscoverySurfaceByContract(
  surface: Record<string, unknown>,
  format: DiscoveryFormat,
  game: ProductSourceGame,
  expandedOnePieceCatalogue: boolean,
): readonly unknown[] {
  const sourceBuckets = uniqueTextValues(
    surface.source_buckets,
    "Official Source discovery buckets",
  );
  if (sourceBuckets.length === 0) {
    throw new Error("Official Source discovery buckets are incomplete.");
  }
  const facets = requiredArray(
    surface.facets,
    "Official Source discovery facets",
  );
  if (facets.length === 0) {
    throw new Error("Official Source discovery facets are incomplete.");
  }
  const entries = expandedOnePieceCatalogue && format === "one-piece"
    ? completeCompatibleOnePiecePartitionEntries(surface.partitions)
    : completePartitionEntriesFrozenV1(surface.partitions);
  const recordingMemberships = expandedOnePieceCatalogue &&
      format === "one-piece"
    ? onePieceRecordingMemberships(surface.partitions)
    : null;
  const details = requiredArray(
    surface.details,
    "Official Source Card details",
  );
  const products = requiredArray(
    surface.products,
    "Official Source referenced Products",
  );
  const productRecords = products.map((value) =>
    requiredRecord(value, "Official Source referenced Product")
  );
  const cardProducts = productRecords.filter(
    (product) => productNonCardClassification(product) === null,
  );
  const nonCardProducts = productRecords.filter(
    (product) => productNonCardClassification(product) !== null,
  );
  const releases = requiredArray(
    surface.releases,
    "Official Source referenced Releases",
  );
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
        [keys.legality]: {
          revision: "captured-by-required-policy-surfaces",
          entries: [],
        },
        [keys.errata]: {
          revision: "captured-by-required-policy-surfaces",
          entries: [],
        },
      },
      keys,
      game,
    ),
    ...nonCardProducts.map((product) =>
      nonCardProductObservation(
        product,
        productNonCardClassification(product)!,
      )
    ),
  ].map((observation) => {
    const record = requiredRecord(
      observation,
      "Official discovery observation",
    );
    const memberships =
      record.memberships === undefined
        ? {
            products: [],
            distribution_contexts: [],
            source_buckets: [],
          }
        : requiredRecord(
            record.memberships,
            "Official discovery memberships",
          );
    const identityEvidence = isPlainRecord(record.identity_evidence)
      ? record.identity_evidence
      : null;
    const locator = typeof identityEvidence?.locator === "string"
      ? identityEvidence.locator
      : null;
    const recordingSourceBuckets = locator === null
      ? null
      : recordingMemberships?.get(locator) ?? null;
    return {
      ...record,
      memberships: {
        ...memberships,
        source_buckets: expandedOnePieceCatalogue
          ? recordingSourceBuckets ?? sourceBuckets
          : sourceBuckets,
      },
    };
  });
}

function parseRawProductsSurfaceFrozenV1(
  surface: Record<string, unknown>,
): readonly unknown[] {
  const products = completePartitionEntriesFrozenV1(surface.partitions)
    .map((value) => requiredRecord(value, "Official Source Product"));
  const releasesByCode = new Map<string, Record<string, unknown>[]>();
  const policy = {
    revision: "captured-by-required-policy-surfaces",
    entries: [],
  };
  return products.map((product) => {
    const classification = productNonCardClassification(product);
    return classification === null
      ? productOnlyObservation(product, releasesByCode, policy, policy)
      : nonCardProductObservation(product, classification);
  });
}

function parseRawReleasesSurfaceFrozenV1(
  surface: Record<string, unknown>,
): readonly unknown[] {
  const entries = completePartitionEntriesFrozenV1(surface.partitions)
    .map((value) => requiredRecord(value, "Official Source Release entry"));
  const products = new Map<string, Record<string, unknown>>();
  const releases = new Map<string, Record<string, unknown>[]>();
  const nonCardProducts = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    const product = requiredRecord(
      entry.product,
      "Official Source Release Product",
    );
    const code = nullableText(product.code, "Official Release Product code");
    const release = requiredRecord(
      entry.release,
      "Official Source Release value",
    );
    if (nullableText(release.code, "Official Release code") !== code) {
      throw new Error(
        "Official Source Release Product binding is inconsistent.",
      );
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
      productOnlyObservation(
        product,
        new Map([[key, releases.get(key) ?? []]]),
        policy,
        policy,
      )
    ),
    ...[...nonCardProducts.values()].map((product) =>
      nonCardProductObservation(
        product,
        productNonCardClassification(product)!,
      )
    ),
  ];
}

function parseRawDiscoverySurfaceV2(
  surface: Record<string, unknown>,
  format: DiscoveryFormat,
  game: ProductSourceGame,
  expandedOnePieceCatalogue = false,
  catalogueComplete = false,
): readonly unknown[] {
  if (expandedOnePieceCatalogue && format === "one-piece") {
    return parseRawDiscoverySurfaceCompleteOnePieceV3(surface, format, game);
  }
  if (catalogueComplete && format === "fusion-world") {
    const entries = completePartitionEntriesCatalogueV3(
      surface.partitions,
      fusionWorldFullLocatorIdentity,
    );
    return parseRawDiscoverySurfaceFrozenV1(
      {
        ...surface,
        partitions: [{
          bucket: "fusion-world-full-locator-deduplication",
          page: 1,
          pages: 1,
          total: entries.length,
          has_next: false,
          entries,
        }],
      },
      format,
      game,
    );
  }
  return parseRawDiscoverySurfaceFrozenV1(surface, format, game);
}

function parseRawProductsSurfaceV2(
  surface: Record<string, unknown>,
): readonly unknown[] {
  return parseRawProductsSurfaceFrozenV1(surface);
}

function parseRawReleasesSurfaceV2(
  surface: Record<string, unknown>,
): readonly unknown[] {
  return parseRawReleasesSurfaceFrozenV1(surface);
}

function rawCoverageObservationV2(
  surface: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  return rawCoverageObservationFrozenV1(surface, name);
}

function rawCoverageObservationFrozenV1(
  surface: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
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

const canonicalPartitionEntryIdentity: PartitionEntryIdentityStrategy = {
  label: "canonical entry",
  identity: (_entry, canonical) => canonical,
};

const fusionWorldFullLocatorIdentity: PartitionEntryIdentityStrategy = {
  label: "full locator",
  identity: (entry) =>
    requiredText(
      requiredRecord(entry, "Fusion World partition entry").detail,
      "Fusion World full locator",
    ),
};

function completePartitionEntriesCatalogueV3(
  value: unknown,
  identityStrategy: PartitionEntryIdentityStrategy,
): unknown[] {
  const pages = requiredArray(
    value,
    "Official Source discovery partitions",
  ).map((item) =>
    requiredRecord(item, "Official Source discovery partition page")
  );
  if (pages.length === 0) {
    throw new Error("Official Source discovery partitions are incomplete.");
  }
  const byBucket = new Map<string, Record<string, unknown>[]>();
  for (const page of pages) {
    if (Object.hasOwn(page, "result_cap")) {
      throw new Error(
        "Official Source partition result-cap evidence does not prove complete coverage.",
      );
    }
    const bucket = requiredText(
      page.bucket,
      "Official Source partition bucket",
    );
    byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), page]);
  }
  const allEntries: unknown[] = [];
  const claimedEntries = new Map<
    string,
    { bucket: string; canonical: string }
  >();
  for (const [bucket, bucketPages] of byBucket) {
    bucketPages.sort(
      (left, right) =>
        requiredPositiveInteger(left.page, "Official Source page") -
        requiredPositiveInteger(right.page, "Official Source page"),
    );
    const pageCount = requiredPositiveInteger(
      bucketPages[0]!.pages,
      "Official Source page count",
    );
    if (
      bucketPages.length !== pageCount ||
      bucketPages.some(
        (page, index) =>
          page.bucket !== bucket ||
          page.page !== index + 1 ||
          page.pages !== pageCount ||
          page.has_next !== (index + 1 < pageCount),
      )
    ) {
      throw new Error(
        "Official Source pagination evidence does not prove complete partitions.",
      );
    }
    const entries = bucketPages.flatMap((page) =>
      requiredArray(page.entries, "Official Source partition entries")
    );
    const declaredTotal = requiredNonNegativeInteger(
      bucketPages[0]!.total,
      "Official Source partition total",
    );
    if (
      entries.length !== declaredTotal ||
      bucketPages.some((page) => page.total !== declaredTotal)
    ) {
      throw new Error(
        "Official Source count evidence does not prove complete partitions.",
      );
    }
    for (const entry of entries) {
      const canonical = JSON.stringify(stableValue(entry));
      const identity = identityStrategy.identity(entry, canonical);
      const prior = claimedEntries.get(identity);
      if (prior !== undefined) {
        if (prior.canonical !== canonical) {
          const location = prior.bucket === bucket
            ? `within leaf partition ${bucket}`
            : `between leaf partitions ${prior.bucket} and ${bucket}`;
          throw new Error(
            `Official Source ${identityStrategy.label} ${identity} conflicts ${location}.`,
          );
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

function completePartitionEntriesByContract(
  value: unknown,
  allowCompatibleOverlap: boolean,
): unknown[] {
  const pages = requiredArray(
    value,
    "Official Source discovery partitions",
  ).map((item) =>
    requiredRecord(item, "Official Source discovery partition page")
  );
  if (pages.length === 0) {
    throw new Error("Official Source discovery partitions are incomplete.");
  }
  const byBucket = new Map<string, Record<string, unknown>[]>();
  for (const page of pages) {
    if (Object.hasOwn(page, "result_cap")) {
      throw new Error(
        "Official Source partition result-cap evidence does not prove complete coverage.",
      );
    }
    const bucket = requiredText(
      page.bucket,
      "Official Source partition bucket",
    );
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
    const pageCount = requiredPositiveInteger(
      bucketPages[0]!.pages,
      "Official Source page count",
    );
    if (
      bucketPages.length !== pageCount ||
      bucketPages.some(
        (page, index) =>
          page.bucket !== bucket ||
          page.page !== index + 1 ||
          page.pages !== pageCount ||
          page.has_next !== (index + 1 < pageCount),
      )
    ) {
      throw new Error(
        "Official Source pagination evidence does not prove complete partitions.",
      );
    }
    const entries = bucketPages.flatMap((page) =>
      requiredArray(page.entries, "Official Source partition entries")
    );
    const declaredTotal = requiredNonNegativeInteger(
      bucketPages[0]!.total,
      "Official Source partition total",
    );
    if (
      entries.length !== declaredTotal ||
      bucketPages.some((page) => page.total !== declaredTotal)
    ) {
      throw new Error(
        "Official Source count evidence does not prove complete partitions.",
      );
    }
    for (const entry of entries) {
      const identity = JSON.stringify(stableValue(entry));
      const priorBucket = claimedEntries.get(identity);
      if (priorBucket !== undefined && priorBucket !== bucket) {
        if (!allowCompatibleOverlap) {
          throw new Error(
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

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

function surfaceFromUrl(value: string): string {
  const pathname = new URL(value).pathname.replace(/\/+$/u, "");
  return decodeURIComponent(pathname.slice(pathname.lastIndexOf("/") + 1));
}

function isDiscoverySurface(surface: string): boolean {
  return surface === "card-list" ||
    surface === "card-search" ||
    surface === "packages";
}

function uniqueTextValues(value: unknown, name: string): string[] {
  const result = requiredArray(value, name).map((item) =>
    requiredText(item, name)
  );
  if (new Set(result).size !== result.length) {
    throw new Error(`${name} overlap.`);
  }
  return result;
}

function requiredPositiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`${name} is invalid.`);
  }
  return Number(value);
}

function requiredNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`${name} is invalid.`);
  }
  return Number(value);
}

const surfaceKeys = {
  "one-piece": {
    listing: "card_list",
    details: "card_pages",
    products: "product_catalog",
    releases: "release_schedule",
    legality: "rules_restrictions",
    errata: "correction_notices",
  },
  "fusion-world": {
    listing: "search",
    details: "detail_pages",
    products: "products",
    releases: "releases",
    legality: "banned_limited",
    errata: "errata_notices",
  },
  digimon: {
    listing: "card_index",
    details: "card_details",
    products: "product_index",
    releases: "release_calendar",
    legality: "restricted_cards",
    errata: "errata_notices",
  },
  gundam: {
    listing: "card_search",
    details: "card_details",
    products: "product_list",
    releases: "release_list",
    legality: "regulation",
    errata: "errata",
  },
} as const;

function parseOfficialDiscoveryFrozenV1(
  document: unknown,
  keys: (typeof surfaceKeys)[DiscoveryFormat],
  game: ProductSourceGame,
): readonly unknown[] {
  const root = requiredRecord(document, "Official discovery document");
  const listing = requiredRecord(root[keys.listing], `Official ${keys.listing}`);
  const details = requiredArray(root[keys.details], `Official ${keys.details}`)
    .map((value) => requiredRecord(value, "Official Card detail"));
  const products = requiredArray(root[keys.products], `Official ${keys.products}`)
    .map((value) => requiredRecord(value, "Official Product"));
  const releases = requiredArray(root[keys.releases], `Official ${keys.releases}`)
    .map((value) => requiredRecord(value, "Official Release"));
  const legality = requiredSurface(root[keys.legality], keys.legality);
  const errata = requiredSurface(root[keys.errata], keys.errata);
  const entries = requiredArray(listing.entries, "Official listing entries")
    .map((value) => requiredRecord(value, "Official listing entry"));

  if (
    listing.page !== 1 ||
    listing.pages !== 1 ||
    listing.has_next !== false ||
    listing.total !== entries.length ||
    Object.hasOwn(listing, "result_cap")
  ) {
    throw new Error(
      "Official listing pagination/count/cap evidence does not prove complete coverage.",
    );
  }
  if (details.length !== entries.length) {
    throw new Error(
      "Official listing/detail partitions do not prove complete coverage.",
    );
  }
  const detailPaths = uniqueRequiredText(details, "path", "Card detail path");
  const listingPaths = uniqueRequiredText(entries, "detail", "listing detail path");
  if (
    detailPaths.length !== listingPaths.length ||
    detailPaths.some((path, index) => path !== [...listingPaths].sort()[index])
  ) {
    throw new Error(
      "Official listing/detail discovery surfaces are incomplete or overlap.",
    );
  }
  const productsByReference = new Map(
    products.map((product) => [
      productMapKey(product),
      product,
    ]),
  );
  if (productsByReference.size !== products.length) {
    throw new Error("Official Product partitions overlap.");
  }
  const releasesByReference = new Map<string, Record<string, unknown>[]>();
  for (const release of releases) {
    const code = nullableText(release.code, "Official Release Product code");
    const title = release.product_title === undefined
      ? null
      : nullableText(
          release.product_title,
          "Official Release Product name",
        );
    const key = code === null
      ? title === null
        ? null
        : productMapKey({ code: null, title })
      : code;
    if (key === null || !productsByReference.has(key)) {
      throw new Error("Official Release references an undiscovered Product.");
    }
    releasesByReference.set(key, [
      ...(releasesByReference.get(key) ?? []),
      release,
    ]);
  }

  const observedProductReferences = new Set<string>();
  const observations = details.map((detail) => {
    const productCodes = requiredTextArray(
      detail.product_codes,
      "Official Card Product codes",
    );
    const productReferences = [
      ...productCodes,
      ...(detail.product_names === undefined
        ? []
        : requiredTextArray(
            detail.product_names,
            "Official Card Product names",
          ).map((title) => productMapKey({ code: null, title }))),
    ];
    productReferences.forEach((reference) => {
      if (!productsByReference.has(reference)) {
        throw new Error("Official Card detail references an undiscovered Product.");
      }
      observedProductReferences.add(reference);
    });
    return cardObservation(
      detail,
      productReferences.map((reference) =>
        productsByReference.get(reference)!
      ),
      releasesByReference,
      legality,
      errata,
      game,
    );
  });
  observations.push(
    ...products
      .filter((product) =>
        !observedProductReferences.has(productMapKey(product))
      )
      .map((product) =>
        productOnlyObservation(product, releasesByReference, legality, errata)
      ),
  );
  return observations;
}

function cardObservation(
  detail: Record<string, unknown>,
  products: Record<string, unknown>[],
  releasesByCode: Map<string, Record<string, unknown>[]>,
  legality: Record<string, unknown>,
  errata: Record<string, unknown>,
  game: ProductSourceGame,
): Record<string, unknown> {
  const distribution = requiredRecord(
    detail.distribution,
    "Official Distribution",
  );
  const distributionCode = requiredText(
    distribution.code,
    "Official Distribution code",
  );
  const sourceBucket = distribution.kind === "source_bucket";
  const distributionProductReference =
    distribution.product_reference === undefined
      ? null
      : productReferenceValue(
          distribution.product_reference,
          "Official Distribution Product reference",
        );
  if (
    distributionProductReference !== null &&
    !products.some(
      (product) =>
        productReferenceKey(productReference(product)) ===
        productReferenceKey(distributionProductReference),
    )
  ) {
    throw new Error(
      "Official Distribution references a Product not evidenced by the Card detail.",
    );
  }
  const productCatalogue = catalogue(products, releasesByCode);
  const relationships: Record<string, unknown>[] = products.flatMap((product) => {
    const reference = productReference(product);
    return [
      ...(detail.printing === undefined
        ? []
        : [{
            kind: "printing-product",
            product_reference: reference,
            evidence_category: "explicit",
            resolution: "explicit",
          }]),
      {
        kind: "product-card",
        product_reference: reference,
        card_reference: { kind: "current_card" },
        evidence_category: "explicit",
        resolution: "explicit",
      },
    ];
  });
  if (Array.isArray(detail.fuzzy_product_labels)) {
    for (const label of detail.fuzzy_product_labels) {
      if (typeof label !== "string" || label.trim().length === 0) continue;
      relationships.push({
        kind: detail.printing === undefined
          ? "product-card"
          : "printing-product",
        product_reference: {
          kind: "name",
          value: label.trim(),
        },
        evidence_category: "derived",
        resolution: "fuzzy",
      });
    }
  }
  if (detail.printing !== undefined && !sourceBucket) {
    relationships.push({
      kind: "printing-distribution-context",
      context_key: distributionCode,
      evidence_category: "derived",
      resolution: "deterministic",
    });
  }
  if (!sourceBucket && distributionProductReference !== null) {
    relationships.push({
      kind: "distribution-context-product",
      context_key: distributionCode,
      product_reference: distributionProductReference,
      evidence_category: "explicit",
      resolution: "explicit",
    });
  } else if (
    !sourceBucket &&
    typeof distribution.product_label === "string"
  ) {
    relationships.push({
      kind: "distribution-context-product",
      context_key: distributionCode,
      product_reference: {
        kind: "name",
        value: requiredText(
          distribution.product_label,
          "Official Distribution Product label",
        ),
      },
      evidence_category: "explicit",
      resolution: "fuzzy",
    });
  }
  const artwork = detail.artwork_fingerprint;
  return {
    completeness: completeObservation(),
    card: {
      game,
      official_identity: {
        kind: "card_number",
        value: requiredText(detail.number, "Official Card number"),
      },
      name: requiredText(detail.title, "Official Card title"),
      effective_rules_text: nullableText(
        detail.rules,
        "Official Card rules",
      ),
      game_data: {
        profile: requiredText(detail.profile, "Official Card profile"),
        attributes: detail.attributes,
      },
    },
    ...(detail.printing === undefined
      ? {}
      : {
          printing: {
            rarity: {
              raw: nullableText(
                requiredRecord(detail.printing, "Official Printing").rarity,
                "Official Printing rarity",
              ),
              normalized: nullableText(
                requiredRecord(detail.printing, "Official Printing")
                  .normalizedRarity,
                "Official normalized rarity",
              ),
            },
            printed_rules_text: nullableText(
              detail.printed_rules,
              "Official printed rules",
            ),
            game_data: {
              profile: requiredText(detail.profile, "Official Card profile"),
              attributes: requiredRecord(
                detail.printing,
                "Official Printing",
              ).attributes,
            },
          },
          identity_evidence: {
            locator: requiredText(detail.path, "Official Card path"),
            variant_key: requiredText(detail.variant, "Official variant"),
            artwork_fingerprint: requiredText(
              artwork,
              "Official artwork fingerprint",
            ),
            printed_fields_digest: requiredText(
              detail.printed_fields_digest,
              "Official printed fields digest",
            ),
            treatment:
              detail.treatment === "standard" ||
                detail.treatment === "alternate"
                ? detail.treatment
                : null,
            // A Source Adapter can declare the image role and URL, but only
            // retained and digest-verified image bytes can prove novelty.
            demonstrably_novel: false,
            novelty_basis: {
              kind: "official_printing_image",
              source_url: requiredText(detail.image, "Official image URL"),
              artwork_fingerprint: artwork,
            },
          },
          appearance_evidence: {
            images:
              detail.images === undefined
                ? [{
                    role: "front",
                    source_url: detail.image,
                    artwork_fingerprint: artwork,
                  }]
                : requiredArray(
                    detail.images,
                    "Official Printing images",
                  ),
          },
        }),
    memberships: {
      products: products.map((product) =>
        productReference(product).value
      ),
      distribution_contexts: sourceBucket ? [] : [distributionCode],
      source_buckets: sourceBucket ? [distributionCode] : [],
    },
    product_release_catalogue: {
      ...productCatalogue,
      distribution_contexts: sourceBucket
        ? []
        : [{
            key: distributionCode,
            kind: distribution.kind,
            label: distribution.label,
            ...(distributionProductReference === null
              ? {}
              : { product_reference: distributionProductReference }),
            evidence_category: "explicit",
          }],
      relationships,
    },
    source_sidecar: sourceSidecar(detail, products, legality, errata),
  };
}

function productOnlyObservation(
  product: Record<string, unknown>,
  releasesByCode: Map<string, Record<string, unknown>[]>,
  legality: Record<string, unknown>,
  errata: Record<string, unknown>,
): Record<string, unknown> {
  const distribution =
    product.distribution === undefined
      ? null
      : requiredRecord(product.distribution, "Official Product Distribution");
  const contextKey =
    distribution === null
      ? null
      : requiredText(distribution.code, "Official Distribution code");
  return {
    completeness: completeObservation(),
    product_release_catalogue: {
      ...catalogue([product], releasesByCode),
      distribution_contexts:
        distribution === null
          ? []
          : [{
              key: contextKey,
              kind: distribution.kind,
              label: distribution.label,
              product_reference: productReference(product),
              evidence_category: "explicit",
            }],
      relationships:
        distribution === null
          ? []
          : [{
              kind: "distribution-context-product",
              context_key: contextKey,
              product_reference: productReference(product),
              evidence_category: "explicit",
              resolution: "explicit",
            }],
    },
    source_sidecar: sourceSidecar(null, [product], legality, errata),
  };
}

function productNonCardClassification(
  product: Record<string, unknown>,
): "accessory" | null {
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
): Record<string, unknown> {
  const policy = {
    revision: "captured-by-required-policy-surfaces",
    entries: [],
  };
  return {
    completeness: completeObservation(),
    product_release_catalogue: {
      products: [],
      distribution_contexts: [{
        key:
          `non-card:${classification}:${
            productMapKey(product).normalize("NFC").trim().toLocaleLowerCase()
          }`,
        kind: "other",
        label: classification,
        evidence_category: "explicit",
      }],
      relationships: [],
    },
    source_sidecar: sourceSidecar(null, [product], policy, policy),
  };
}

function catalogue(
  products: Record<string, unknown>[],
  releasesByCode: Map<string, Record<string, unknown>[]>,
) {
  return {
    products: products.map((product) => {
      const code = nullableText(product.code, "Official Product code");
      return {
        reference: productReference(product),
        official_code: code,
        name: requiredText(product.title, "Official Product title"),
        releases: (releasesByCode.get(productMapKey(product)) ?? []).map((release) => ({
          event_key: release.event_key,
          region: release.region,
          date: { precision: release.precision, value: release.date },
          status: release.status,
        })),
      };
    }),
    distribution_contexts: [],
    relationships: [],
  };
}

function sourceSidecar(
  detail: Record<string, unknown> | null,
  products: Record<string, unknown>[],
  legality: Record<string, unknown>,
  errata: Record<string, unknown>,
) {
  const productFieldCoverage = products.flatMap((product, index) => {
    const productPath = `products[${index}]`;
    const consumed = ["code", "title", "distribution"].flatMap((field) =>
      product[field] === undefined
        ? []
        : leafPaths(product[field], `${productPath}.${field}`)
    );
    const unmapped = Object.entries(product)
      .filter(([field]) =>
        field !== "code" && field !== "title" && field !== "distribution"
      )
      .flatMap(([field, value]) =>
        leafEntries(
          value,
          `source_sidecar.raw.${productPath}.${field}`,
        )
      );
    return [{ consumed, unmapped }];
  });
  return {
    raw: { detail, products, legality, errata },
    consumed_fields: [
      "detail.number",
      "detail.title",
      "detail.rules",
      ...productFieldCoverage.flatMap(({ consumed }) => consumed),
    ],
    unmapped_optional_fields: productFieldCoverage.flatMap(
      ({ unmapped }) => unmapped,
    ),
  };
}

function leafPaths(value: unknown, path: string): string[] {
  if (Array.isArray(value)) {
    return value.length === 0
      ? [path]
      : value.flatMap((item, index) => leafPaths(item, `${path}[${index}]`));
  }
  if (isPlainRecord(value)) {
    const entries = Object.entries(value);
    return entries.length === 0
      ? [path]
      : entries.flatMap(([field, item]) =>
          leafPaths(item, `${path}.${field}`)
        );
  }
  return [path];
}

function leafEntries(
  value: unknown,
  path: string,
): { path: string; value: unknown }[] {
  if (Array.isArray(value)) {
    return value.length === 0
      ? [{ path, value }]
      : value.flatMap((item, index) =>
          leafEntries(item, `${path}[${index}]`)
        );
  }
  if (isPlainRecord(value)) {
    const entries = Object.entries(value);
    return entries.length === 0
      ? [{ path, value }]
      : entries.flatMap(([field, item]) =>
          leafEntries(item, `${path}.${field}`)
        );
  }
  return [{ path, value }];
}

function requiredSurface(value: unknown, name: string) {
  const surface = requiredRecord(value, `Official ${name}`);
  requiredText(surface.revision, `Official ${name} revision`);
  requiredArray(surface.entries, `Official ${name} entries`);
  return surface;
}

function completeObservation(
  declaredRecordCount = 1,
  parsedRecordCount = 1,
) {
  return {
    structurally_complete: true,
    required_surfaces_complete: true,
    partitions_complete: true,
    declared_record_count: declaredRecordCount,
    parsed_record_count: parsedRecordCount,
  };
}

function productReference(
  product: Record<string, unknown>,
): { kind: "official_code" | "name"; value: string } {
  const code = nullableText(product.code, "Official Product code");
  return code === null
    ? {
        kind: "name",
        value: requiredText(product.title, "Official Product title"),
      }
    : { kind: "official_code", value: code };
}

function productMapKey(product: Record<string, unknown>): string {
  const reference = productReference(product);
  return reference.kind === "official_code"
    ? reference.value
    : `name:${reference.value}`;
}

function productEventKey(
  prefix: string,
  product: Record<string, unknown>,
): string {
  const reference = productReference(product);
  if (reference.kind === "official_code") {
    return `${prefix}:${reference.value}`;
  }
  const bytes = new TextEncoder().encode(
    reference.value.normalize("NFC").trim(),
  );
  const readablePrefix = [...bytes.slice(0, 64)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${prefix}:name-${readablePrefix}-${
    hash.toString(16).padStart(16, "0")
  }`;
}

function productReferenceValue(
  value: unknown,
  name: string,
): { kind: "official_code" | "name"; value: string } {
  const reference = requiredRecord(value, name);
  if (reference.kind !== "official_code" && reference.kind !== "name") {
    throw new Error(`${name} kind is invalid.`);
  }
  return {
    kind: reference.kind,
    value: requiredText(reference.value, `${name} value`),
  };
}

function productReferenceKey(reference: {
  kind: "official_code" | "name";
  value: string;
}): string {
  return `${reference.kind}:${reference.value}`;
}

function uniqueRequiredText(
  values: Record<string, unknown>[],
  field: string,
  name: string,
): string[] {
  const result = values.map((value) => requiredText(value[field], name)).sort();
  if (new Set(result).size !== result.length) {
    throw new Error(`Official ${name} values overlap.`);
  }
  return result;
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} is invalid.`);
  return value;
}

function requiredTextArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${name} is invalid.`);
  }
  return [...new Set(value)];
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function nullableText(value: unknown, name: string): string | null {
  if (value === null) return null;
  return requiredText(value, name);
}

function optionalOfficialCode(value: unknown, name: string): string | null {
  return value === undefined || value === null
    ? null
    : requiredText(value, name);
}
