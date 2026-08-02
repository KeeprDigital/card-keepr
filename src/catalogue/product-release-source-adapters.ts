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
  officialLegalityRulesHtmlObservation,
  officialLegalityRulesObservation,
} from "./official-legality-source-adapters.mjs";

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

export const officialRawAdapterContracts: readonly OfficialRawAdapterContract[] =
  Object.freeze(
    rawContractDefinitions.flatMap((definition) =>
      [
        {
          ...definition,
          parserContract: `${definition.sourceLineage}-raw-surfaces@1`,
          legalityAware: false,
        },
        {
          ...definition,
          adapterVersion:
            legalityAwareAdapterVersions[definition.sourceLineage],
          parserContract:
            `${definition.sourceLineage}-raw-surfaces-with-legality@2`,
          legalityAware: true,
        },
      ].map((version) =>
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
              )
            : historicalBandaiSnapshotDecoder(
                version.format,
                version.supportedGame,
                version.sourceLineage,
                version.requiredSurfaces,
                version.urls,
              ),
          discoverRequests: bandaiRequestDiscovery(
            version.format,
            version.sourceLineage,
            version.requiredSurfaces,
            version.urls,
          ),
        })
      )
    ),
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

function bandaiRequestDiscovery(
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
        headers: { accept: "text/html" },
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
    const candidates: {
      role: "listing" | "detail" | "product_detail" | "image";
      url: string;
      headers: Record<string, string>;
    }[] = [];
    if (initialSurface !== null) {
      const structured = bandaiPublisherPayload(
        discoveryHtml,
        sourceLineage,
        initialSurface,
      );
      if (structured !== null) {
        candidates.push(
          ...structuredImageUrls(structured, current, sourceLineage).map(
            (url) => ({
              role: "image" as const,
              url,
              headers: {
                accept:
                  "image/avif,image/webp,image/png,image/jpeg,image/gif",
              },
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
        ...discoveredPartitionRequests(format, discoveryHtml, current).map(
          (url) => ({
            role: "listing" as const,
            url,
            headers: { accept: "text/html" },
          }),
        ),
      );
    }
    for (const match of discoveryHtml.matchAll(
      /<(a|img|source)\b([^>]*?)>/giu,
    )) {
      const tag = match[1]!.toLowerCase();
      const attributes = match[2]!;
      const rawUrl =
        tag === "a"
          ? htmlAttribute(attributes, "href")
          : htmlAttribute(attributes, "data-src") ??
            htmlAttribute(attributes, "src");
      if (
        rawUrl === null ||
        rawUrl.startsWith("#") ||
        /^(?:data|javascript|mailto|tel):/iu.test(rawUrl)
      ) {
        continue;
      }
      let resolved: URL;
      try {
        resolved = new URL(decodeHtmlText(rawUrl), current);
      } catch {
        continue;
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
        headers: {
          accept: role === "image"
            ? "image/avif,image/webp,image/png,image/jpeg,image/gif"
            : "text/html",
        },
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
): string[] {
  const facets = [...html.matchAll(
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
  const stage = nextPartitionFacet(format, facets, current);
  if (stage === null) return [];
  return stage.options.map((value) => {
    const url = new URL(current);
    url.searchParams.set(stage.key, value);
    return url.href;
  });
}

function nextPartitionFacet(
  format: DiscoveryFormat,
  facets: readonly { key: string; options: string[] }[],
  current: URL,
): { key: string; options: string[] } | null {
  const find = (keys: readonly string[]) =>
    facets.find(({ key }) => keys.includes(key)) ?? null;
  if (format === "one-piece") {
    const recording = find(["recording"]);
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
      aliases.some((key) => current.searchParams.has(key))
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

function discoveredHtmlRole(
  format: DiscoveryFormat,
  initialSurface: string | null,
  url: URL,
): "listing" | "detail" | "product_detail" | null {
  const target = `${url.pathname}${url.search}`;
  if (
    initialSurface === "products" ||
    initialSurface === "releases" ||
    /\/products?\//iu.test(target)
  ) {
    if (nonCardProductClassification(target) !== null) return null;
    return /(?:detail|products?\/[^/?]+|products?\.php\?.*\bid=)/iu.test(
        target,
      )
      ? "product_detail"
      : /(?:page|paged|offset)=\d+/iu.test(target)
        ? "listing"
        : null;
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

function historicalBandaiSnapshotDecoder(
  format: DiscoveryFormat,
  game: ProductSourceGame,
  sourceLineage: string,
  requiredSurfaces: readonly string[],
  urls: Readonly<Record<string, string>>,
): OfficialRawAdapterContract["parseBytes"] {
  return bandaiSnapshotDecoder(format, game, sourceLineage, requiredSurfaces, urls, {
    parseLegality: false,
    acceptPublisherDeclaredEmpty: false,
  });
}

function legalityAwareBandaiSnapshotDecoder(
  format: DiscoveryFormat,
  game: ProductSourceGame,
  sourceLineage: string,
  requiredSurfaces: readonly string[],
  urls: Readonly<Record<string, string>>,
): OfficialRawAdapterContract["parseBytes"] {
  return bandaiSnapshotDecoder(format, game, sourceLineage, requiredSurfaces, urls, {
    parseLegality: true,
    acceptPublisherDeclaredEmpty: true,
    acceptDiscoveryRoot: true,
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
      surface,
    );
    if (structuredPayload !== null) {
      if (
        profile.parseLegality &&
        isLegalityRuleSurface(game, surface) &&
        containsUnmodeledDedicatedPolicyContent(html, sourceLineage, surface)
      ) {
        throw new Error(
          `Official Source ${surface} retained non-empty Legality data without an exact, complete Legality Rule parser.`,
        );
      }
      return normalizedSurfaceObservations(
        format,
        game,
        sourceLineage,
        surface,
        structuredPayload,
        profile.parseLegality,
      );
    }
    if (dynamicRole === "detail") {
      return [
        parseBandaiCardDetail(
          html,
          format,
          sourceLineage,
          context.url,
        ),
      ];
    }
    if (dynamicRole === "product_detail") {
      return [
        parseBandaiProductDetail(
          html,
          sourceLineage,
          context.url,
        ),
      ];
    }
    const parsed =
      format === "one-piece" && surface === "card-list"
        ? parseOnePieceBandaiCardList(html, context.url)
        : parseBandaiSurfaceCoverage(
            html,
            format,
            sourceLineage,
            surface,
            context.url,
            profile.acceptPublisherDeclaredEmpty &&
              isLegalityPolicySurface(surface),
          );
    const legalityObservation = profile.parseLegality &&
        isLegalityRuleSurface(game, surface)
      ? officialLegalityRulesHtmlObservation(game, sourceLineage, html) ??
        null
      : null;
    if (
      profile.parseLegality &&
      isLegalityRuleSurface(game, surface) &&
      containsUnparsedLegalityPublication(
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
      attachRawSurfaceEvidence(
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
  return [...links, ...options, ...unmatchedEntries]
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
  headers: { accept: "text/html" };
  discovered_from: {
    kind: "publisher_navigation";
    label: string;
    url: string;
    resolution: string;
  };
}> {
  const headers = [...html.matchAll(
    /<header\b[^>]*>([\s\S]*?)<\/header>/giu,
  )];
  if (headers.length !== 1) {
    throw new Error(
      "Official Source discovery must retain exactly one publisher header.",
    );
  }
  const seeds = bandaiDiscoverySeeds(sourceLineage);
  const acceptedLabels = new Set(seeds.map(({ label }) => label));
  const discoveryUrl = new URL(urls[requiredSurfaces[0]!]!).href;
  const observedSeeds = new Map<string, {
    label: string;
    url: string;
    resolution: string;
  }>();
  for (const match of headers[0]![1]!.matchAll(
    /<a\b([^>]*)>([\s\S]*?)<\/a>/giu,
  )) {
    const href = htmlAttribute(match[1]!, "href");
    if (href === null) continue;
    const label = htmlText(match[2]!).toLocaleLowerCase();
    let resolvedUrl: string;
    try {
      resolvedUrl = new URL(
        decodeHtmlText(href),
        urls[requiredSurfaces[0]!]!,
      ).href;
    } catch {
      if (acceptedLabels.has(label)) {
        throw new Error(
          "Official Source discovery moved a required navigation URL.",
        );
      }
      continue;
    }
    if (!acceptedLabels.has(label)) continue;
    const seed = seeds.find((candidate) => candidate.label === label);
    if (seed === undefined) {
      throw new Error(
        "Official Source discovery contains unknown or mismatched required-surface navigation.",
      );
    }
    if (observedSeeds.has(seed.id)) {
      throw new Error(
        `Official Source discovery duplicates the ${seed.id} navigation link.`,
      );
    }
    if (!officialUrl(sourceLineage, new URL(resolvedUrl), "document")) {
      throw new Error(
        "Official Source discovery moved a required navigation URL outside its registered authority.",
      );
    }
    observedSeeds.set(seed.id, {
      label,
      url: resolvedUrl,
      resolution: decodeHtmlText(href),
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
    const surfaces = discoverySurfacesForStageLink(
      sourceLineage,
      discoveryKey,
      label,
      resolved,
    );
    for (const surface of surfaces) {
      if (!requiredSurfaces.includes(surface)) continue;
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
  if (sourceLineage === "fusion-world-en") {
    if (/histor|previous|past/u.test(signal)) return ["legality-history"];
    if (/restriction|banned|limited|official rules/u.test(signal)) {
      return ["legality-current"];
    }
  }
  if (sourceLineage === "digimon-en") {
    if (/histor|previous|past/u.test(signal)) return ["restrictions-history"];
    if (/restriction|banned|limited/u.test(signal)) {
      return ["restrictions-current"];
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
      officialUrl(sourceLineage, new URL(context.url), "document")
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

function parseOnePieceBandaiCardList(
  html: string,
  requestUrl: string,
): ParsedBandaiSurface {
  const recordingSelect = html.match(
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
        cost: integerOrNull(field("Cost")),
        life: cardType === "leader" ? integerOrNull(field("Life")) : null,
        battle_attributes: textValues(field("Attribute")),
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
        normalizedRarity: rarity.length === 0
          ? null
          : rarity.toLowerCase(),
        attributes: { illustration_types: [] },
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
    return cardObservation(
      detail,
      [],
      new Map(),
      { revision: "captured-by-policy-surface", entries: [] },
      { revision: "captured-by-policy-surface", entries: [] },
      "one-piece",
    );
  });
  return {
    observations,
    retainedDocument: {
      page: "card-list",
      recording_options: recordings,
      declared_record_count: declaredCount,
      parsed_locators: modalMatches.map((match) => decodeHtmlText(match[1]!)),
      ...(schemaReviewValues.length === 0
        ? {}
        : { schema_review_values: schemaReviewValues }),
    },
    consumedFields: [
      "page",
      "recording_options",
      "declared_record_count",
      "parsed_locators",
    ],
  };
}

function parseBandaiCardDetail(
  html: string,
  format: DiscoveryFormat,
  sourceLineage: string,
  requestUrl: string,
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
      return officialUrl(sourceLineage, new URL(resolved), "image")
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
      ? explicitFusionLeaderFaces(html, requestUrl, sourceLineage)
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
  return attachRawSurfaceEvidence(
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
      .filter((url) =>
        officialUrl(sourceLineage, new URL(url), "image")
      );
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

function parseBandaiProductDetail(
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
    return attachRawSurfaceEvidence(
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
  return attachRawSurfaceEvidence(
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

function parseBandaiSurfaceCoverage(
  html: string,
  format: DiscoveryFormat,
  sourceLineage: string,
  surface: string,
  url: string,
  acceptPublisherDeclaredEmpty: boolean,
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
  const publicationEntryMatches = [...html.matchAll(
    /<(article|li|tr)\b([^>]*)>([\s\S]*?)<\/\1>/giu,
  )];
  const declaredCountMatch = html.match(
    />\s*(\d+)\s+(?:results?|records?|items?)\s*</iu,
  );
  const publisherDeclaresEmpty = acceptPublisherDeclaredEmpty &&
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
    publicationLinks.length === 0 &&
    discoveredOptions.length === 0 &&
    publicationEntries.length === 0 &&
    !publisherDeclaresEmpty
  ) {
    throw new Error(
      `Official Source ${surface} has no structural publication entries.`,
    );
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
      productIndexObservations.length > 0
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

function normalizedSurfaceObservations(
  format: DiscoveryFormat,
  game: ProductSourceGame,
  sourceLineage: string,
  surface: string,
  rawDocument: Record<string, unknown>,
  legalityAware: boolean,
): readonly unknown[] {
  const normalized = normalizeLineageSurface(
    format,
    sourceLineage,
    surface,
    rawDocument,
  );
  const document = normalized.document;
  let observations: readonly unknown[];
  if (isDiscoverySurface(surface)) {
    observations = parseRawDiscoverySurface(document, format, game);
  } else if (surface === "products") {
    observations = parseRawProductsSurface(document);
  } else if (surface === "releases") {
    observations = [
      ...parseRawReleasesSurface(document),
      ...(legalityAware && isLegalityRuleSurface(game, surface)
        ? [officialLegalityRulesObservation(game, sourceLineage, document)]
        : []),
    ];
  } else {
    observations = [
      rawCoverageObservation(document, surface),
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
  return observations.map((observation, index) =>
    attachRawSurfaceEvidence(
      observation,
      sourceLineage,
      surface,
      rawDocument,
      index === 0,
      normalized.consumedFields,
    )
  );
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
): {
  document: Record<string, unknown>;
  consumedFields: readonly string[];
} {
  const normalized =
    format === "one-piece"
      ? normalizeOnePieceSurface(surface, raw)
      : format === "fusion-world"
        ? normalizeFusionWorldSurface(surface, raw)
        : format === "digimon"
          ? normalizeDigimonSurface(surface, raw)
          : normalizeGundamSurface(sourceLineage, surface, raw);
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
  return normalizedSurfaceBody(
    normalizedPolicy(raw, `one-piece-${surface}`),
    ["publication", "revision", "declared_record_count", "partition", "entries"],
  );
}

function normalizeFusionWorldSurface(
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
    normalizedPolicy(raw, `fusion-world-${surface}`),
    ["publication", "revision", "declared_record_count", "partition", "entries"],
  );
}

function normalizeDigimonSurface(
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
): Record<string, unknown> {
  if (raw.publication !== expectedPublication) {
    throw new Error("Official policy publication identity is invalid.");
  }
  const allowed = new Set([
    "publication", "locale", "revision", "declared_record_count",
    "partition", "entries",
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

function normalizeFusionWorldDetails(value: unknown): unknown[] {
  return requiredArray(value, "Fusion World Card details").map((item) => {
    const card = requiredRecord(item, "Fusion World Card detail");
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
    return canonicalDetail(card, {
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
    });
  });
}

function normalizeDigimonDetails(value: unknown): unknown[] {
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
    imageFields: readonly { role: string; value: unknown }[];
  },
): Record<string, unknown> {
  const printing =
    raw.printing === undefined
      ? undefined
      : requiredRecord(raw.printing, "Official Printing fields");
  const images =
    printing === undefined
      ? []
      : mapping.imageFields.map(({ role, value }) => ({
          role,
          source_url: requiredText(value, "Official Printing image URL"),
          artwork_fingerprint: requiredText(
            raw.artwork_fingerprint,
            "Official artwork fingerprint",
          ),
        }));
  return {
    path: requiredText(raw[mapping.path], "Official Card locator"),
    number: requiredText(raw[mapping.number], "Official Card number"),
    title: requiredText(raw[mapping.title], "Official Card name"),
    rules: requiredText(raw[mapping.rules], "Official Card rules"),
    profile: requiredText(raw.profile, "Official Game Profile"),
    attributes: mapping.attributes,
    product_codes: requiredTextArray(
      raw.product_codes,
      "Official Product codes",
    ),
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
            normalizedRarity: printing.normalized_rarity ?? null,
            attributes: printing.attributes ?? {},
          },
          printed_rules: requiredText(
            raw.printed_rules,
            "Official printed rules",
          ),
          variant: requiredText(raw.variant, "Official Printing variant"),
          artwork_fingerprint: requiredText(
            raw.artwork_fingerprint,
            "Official artwork fingerprint",
          ),
          printed_fields_digest: requiredText(
            raw.printed_fields_digest,
            "Official printed fields digest",
          ),
          image: images[0]!.source_url,
          images,
        }),
  };
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

function attachRawSurfaceEvidence(
  observation: unknown,
  sourceLineage: string,
  surface: string,
  document: Record<string, unknown>,
  retainDocument: boolean,
  mappedRootFields: readonly string[],
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
          ...retainedMappedLeaves.flatMap(({ consumed }) => consumed),
        ]),
      ].sort(),
      unmapped_optional_fields: [
        ...unmapped,
        ...retainedMappedLeaves.flatMap(({ unmapped }) => unmapped),
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

function parseRawDiscoverySurface(
  surface: Record<string, unknown>,
  format: DiscoveryFormat,
  game: ProductSourceGame,
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
  const entries = completePartitionEntries(surface.partitions);
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
    ...parseOfficialDiscovery(
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
    return {
      ...record,
      memberships: {
        ...memberships,
        source_buckets: sourceBuckets,
      },
    };
  });
}

function parseRawProductsSurface(
  surface: Record<string, unknown>,
): readonly unknown[] {
  const products = completePartitionEntries(surface.partitions)
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

function parseRawReleasesSurface(
  surface: Record<string, unknown>,
): readonly unknown[] {
  const entries = completePartitionEntries(surface.partitions)
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

function rawCoverageObservation(
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

function completePartitionEntries(value: unknown): unknown[] {
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
        throw new Error(
          `Official Source leaf partitions overlap between ${priorBucket} and ${bucket}.`,
        );
      }
      claimedEntries.set(identity, bucket);
    }
    allEntries.push(...entries);
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

function parseOfficialDiscovery(
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
