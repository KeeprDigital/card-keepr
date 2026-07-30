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
  sourceLineage: string;
  supportedGame: ProductSourceGame;
  format: DiscoveryFormat;
  requiredSurfaces: readonly string[];
  requestUrlForSurface: (surface: string) => string;
  parseBytes: (
    bytes: Uint8Array,
    context: { mediaType: string | null; url: string; requestId?: string },
  ) => readonly unknown[];
  parseFixtureBytes: (
    bytes: Uint8Array,
    context: { mediaType: string | null; url: string; requestId?: string },
  ) => readonly unknown[];
  discoverRequests: (
    bytes: Uint8Array,
    context: { mediaType: string | null; url: string; requestId?: string },
  ) => readonly {
    role: "listing" | "detail" | "product_detail" | "image";
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
    adapterVersion: "fusion-world-en@1",
    sourceLineage: "fusion-world-en",
    supportedGame: "fusion-world",
    format: "fusion-world",
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
    adapterVersion: "digimon-en@1",
    sourceLineage: "digimon-en",
    supportedGame: "digimon",
    format: "digimon",
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
    adapterVersion: "gundam-en-asia@1",
    sourceLineage: "gundam-en-asia",
    supportedGame: "gundam",
    format: "gundam",
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
    adapterVersion: "gundam-en-us@1",
    sourceLineage: "gundam-en-us",
    supportedGame: "gundam",
    format: "gundam",
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

export const officialRawAdapterContracts: readonly OfficialRawAdapterContract[] =
  Object.freeze(
    rawContractDefinitions.map((definition) =>
      Object.freeze({
        ...definition,
        requiredSurfaces: Object.freeze([...definition.requiredSurfaces]),
        requestUrlForSurface: (surface: string) =>
          exactSurfaceUrl(
            definition.sourceLineage,
            definition.requiredSurfaces,
            definition.urls,
            surface,
          ),
        parseBytes: bandaiSnapshotDecoder(
          definition.format,
          definition.supportedGame,
          definition.sourceLineage,
          definition.requiredSurfaces,
          definition.urls,
        ),
        parseFixtureBytes: rawSnapshotDecoder(
          definition.format,
          definition.supportedGame,
          definition.sourceLineage,
          definition.requiredSurfaces,
        ),
        discoverRequests: bandaiRequestDiscovery(
          definition.format,
          definition.sourceLineage,
          definition.requiredSurfaces,
          definition.urls,
        ),
      }),
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
  const contract = officialRawAdapterContracts.find(
    (candidate) => candidate.sourceLineage === sourceLineage,
  );
  if (contract === undefined) {
    throw new Error("Official Source lineage has no discovery contract.");
  }
  return contract.requiredSurfaces.map((surface) => ({
    id: `${sourceLineage}:${surface}`,
    method: "GET",
    url: contract.requestUrlForSurface(surface),
    headers: { accept: "text/html" },
  }));
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
    const initialSurface = dynamicRequestRole(context.requestId) === null
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
      const structured = bandaiJsonLdPayload(
        html,
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
    if (initialSurface !== null && isDiscoverySurface(initialSurface)) {
      candidates.push(
        ...discoveredPartitionRequests(format, html, current).map((url) => ({
          role: "listing" as const,
          url,
          headers: { accept: "text/html" },
        })),
      );
    }
    for (const match of html.matchAll(
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
        !officialHostname(sourceLineage, resolved.hostname) ||
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
          officialHostname(sourceLineage, url.hostname)
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
  const selectedKeys =
    format === "one-piece"
      ? ["series", "recording"]
      : format === "fusion-world"
        ? ["card_type", "colour", "color", "cost"]
        : format === "digimon"
          ? [
              "version",
              "category",
              "cardcategory",
              "card_type",
              "colour",
              "color",
            ]
          : ["package"];
  const values = [...html.matchAll(
    /<select\b([^>]*)>([\s\S]*?)<\/select>/giu,
  )]
    .map((match) => {
      const attributes = match[1]!;
      const key =
        htmlAttribute(attributes, "name") ??
        htmlAttribute(attributes, "id");
      if (key === null || !selectedKeys.includes(key.toLowerCase())) {
        return null;
      }
      const options = [...match[2]!.matchAll(
        /<option\b[^>]*\bvalue=["']([^"']+)["'][^>]*>/giu,
      )]
        .map((option) => decodeHtmlText(option[1]!).trim())
        .filter((value) =>
          value.length > 0 && !/^(?:all|0|-)$/iu.test(value)
        );
      return options.length === 0
        ? null
        : { key: key.toLowerCase(), options: [...new Set(options)].sort() };
    })
    .filter(
      (entry): entry is { key: string; options: string[] } => entry !== null,
    )
    .sort(
      (left, right) =>
        selectedKeys.indexOf(left.key) - selectedKeys.indexOf(right.key),
    );
  if (values.length === 0) return [];
  let partitions: Record<string, string>[] = [{}];
  for (const facet of values) {
    partitions = partitions.flatMap((partition) =>
      facet.options.map((value) => ({
        ...partition,
        [facet.key]: value,
      }))
    );
  }
  return partitions.map((partition) => {
    const url = new URL(current);
    for (const [key, value] of Object.entries(partition)) {
      url.searchParams.set(key, value);
    }
    return url.href;
  });
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
    /:(listing|detail|product_detail|image):[a-f0-9]{64}$/u,
  );
  return match?.[1] as ReturnType<typeof dynamicRequestRole> ?? null;
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

function officialHostname(sourceLineage: string, hostname: string): boolean {
  const expected =
    sourceLineage === "one-piece-en"
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

function bandaiSnapshotDecoder(
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
    const html = decodeUtf8(bytes, surface);
    if (/\bdata-keepr-official-payload\b/iu.test(html)) {
      throw new Error(
        "Production Official Source parsing does not accept synthetic Keepr payload wrappers.",
      );
    }
    const structuredPayload = bandaiJsonLdPayload(
      html,
      sourceLineage,
      surface,
    );
    if (structuredPayload !== null) {
      return normalizedSurfaceObservations(
        format,
        game,
        sourceLineage,
        surface,
        structuredPayload,
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
            sourceLineage,
            surface,
            context.url,
          );
    return parsed.observations.map((observation, index) =>
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

function bandaiJsonLdPayload(
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
    const publisher =
      publication.publisher !== null &&
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
    const part = publication.hasPart.find(
      (candidate) =>
        candidate !== null &&
        typeof candidate === "object" &&
        !Array.isArray(candidate) &&
        (candidate as Record<string, unknown>).identifier ===
          `${sourceLineage}:${surface}`,
    );
    if (part === undefined) continue;
    return requiredRecord(
      (part as Record<string, unknown>).payload,
      `Official Source ${surface} JSON-LD payload`,
    );
  }
  return null;
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
      new URL(context.url).href === new URL(urls[surface]!).href
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
  if (!/<select\b[^>]*\bid=["']series["']/iu.test(html)) {
    throw new Error("One Piece Card List series discovery is unavailable.");
  }
  const declaredMatch = html.match(
    /<div\b[^>]*\bclass=["'][^"']*\bcountCol\b[^"']*["'][^>]*>\s*(\d+)\s+results?\s*<\/div>/iu,
  );
  if (declaredMatch === null) {
    throw new Error("One Piece Card List result count is unavailable.");
  }
  const series = [...html.matchAll(
    /<option\b[^>]*\bvalue=["']([^"']+)["'][^>]*>([\s\S]*?)<\/option>/giu,
  )]
    .filter((match) => match[1]!.length > 0)
    .map((match) => ({
      value: decodeHtmlText(match[1]!),
      label: htmlText(match[2]!),
    }));
  if (series.length === 0) {
    throw new Error("One Piece Card List Recording discovery is empty.");
  }
  const modalMatches = [...html.matchAll(
    /<dl\b[^>]*\bclass=["'][^"']*\bmodalCol\b[^"']*["'][^>]*\bid=["']([^"']+)["'][^>]*>([\s\S]*?)<\/dl>/giu,
  )];
  const declaredCount = Number.parseInt(declaredMatch[1]!, 10);
  if (modalMatches.length !== declaredCount) {
    throw new Error(
      "One Piece Card List declared and parsed record counts differ.",
    );
  }
  const base = new URL(requestUrl);
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
    const field = (className: string): string | null => {
      const found = body.match(
        new RegExp(
          `<div\\b[^>]*\\bclass=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>` +
            `<h3[^>]*>[\\s\\S]*?<\\/h3>([\\s\\S]*?)<\\/div>`,
          "iu",
        ),
      );
      return found === null ? null : htmlText(found[1]!);
    };
    const effect = requiredNullableText(field("text"), "Official effect");
    const setLabel = field("getInfo") ?? "Unclassified Card List";
    const colour = requiredNullableText(field("color"), "Official colour");
    const variant =
      locator === cardNumber ? "base" : locator.slice(cardNumber.length);
    const artworkFingerprint = `material:${JSON.stringify(stableValue({
      card_number: cardNumber,
      rarity,
      card_type: cardType,
      name,
      set_label: setLabel,
      variant,
    }))}`;
    const printedFieldsDigest = `printed-material:${
      JSON.stringify(stableValue({
        card_number: cardNumber,
        rarity,
        card_type: cardType,
        rules: effect ?? "",
        colour,
        cost: field("cost"),
        attribute: field("attribute"),
        power: field("power"),
        counter: field("counter"),
        feature: field("feature"),
        block: field("block"),
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
        cost: integerOrNull(field("cost")),
        life: cardType === "leader" ? integerOrNull(field("cost")) : null,
        battle_attributes: textValues(field("attribute")),
        power: integerOrNull(field("power")),
        counter: integerOrNull(field("counter")),
        traits: textValues(field("feature")),
        block_icons: textValues(field("block")),
        effect_text: effect,
        trigger_text: null,
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
      series_options: series,
      declared_record_count: declaredCount,
      parsed_locators: modalMatches.map((match) => decodeHtmlText(match[1]!)),
    },
    consumedFields: [
      "page",
      "series_options",
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
  const field = (names: readonly string[]): string | null =>
    names
      .map((name) => labelledHtmlValue(html, name))
      .find((value) => value !== null) ?? null;
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
  const rules =
    field(["Effect", "Skill", "Card Text", "Text"]) ?? "";
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
  const imageUrls = [...html.matchAll(
    /<img\b[^>]*\b(?:data-src|src)=["']([^"']+\.(?:avif|gif|jpe?g|png|webp)(?:\?[^"']*)?)["']/giu,
  )]
    .map((match) => new URL(decodeHtmlText(match[1]!), requestUrl).href)
    .filter((url) => officialHostname(sourceLineage, new URL(url).hostname));
  if (imageUrls.length === 0) {
    throw new Error(`${sourceLineage} Card detail has no Printing Image URL.`);
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
  const colours = colour === "-"
    ? format === "fusion-world" || format === "gundam"
      ? ["colourless"]
      : []
    : colour.split(/[\/,]/u).map((value) => value.trim().toLowerCase());
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
          effect_text: rules.length === 0 ? null : rules,
          trigger_text: field(["Trigger"]),
        }
      : format === "fusion-world"
        ? {
            card_type: normalizedType,
            colours,
            cost: integerOrNull(field(["Cost"])),
            specified_cost: [],
            power: integerOrNull(field(["Power"])),
            combo_power: integerOrNull(field(["Combo Power"])),
            traits: textValues(field(["Special Trait", "Traits"])),
            skills: [
              ...(rules.length === 0
                ? []
                : [{ kind: "ordinary", text: rules }]),
            ],
            ...(normalizedType === "leader"
              ? {
                  leader_faces: ["front", "back"].map((role) => ({
                    role,
                    name,
                    power: integerOrNull(field(["Power"])),
                    traits: textValues(field(["Special Trait", "Traits"])),
                    skills: [],
                  })),
                }
              : {}),
          }
        : format === "digimon"
          ? {
              card_type: normalizedType,
              colours,
              level: integerOrNull(field(["Level"])),
              play_cost: integerOrNull(field(["Play Cost"])),
              use_cost: integerOrNull(field(["Use Cost"])),
              dp: integerOrNull(field(["DP"])),
              form: field(["Form"]),
              attribute: field(["Attribute"]),
              traits: textValues(field(["Type", "Traits"])),
              digivolution_requirements: [],
              text_sections: [
                ...(rules.length === 0
                  ? []
                  : [{ kind: "effect", text: rules }]),
              ],
            }
          : {
              card_type: normalizedType,
              colours,
              level: integerOrNull(field(["Level"])),
              cost: integerOrNull(field(["Cost"])),
              block_icon: field(["Block", "Block icon"]),
              effect_text: rules.length === 0 ? null : rules,
              zone: field(["Zone"]),
              traits: textValues(field(["Trait", "Traits"])),
              link_condition: field(["Link"]),
              ap: integerOrNull(field(["AP"])),
              hp: integerOrNull(field(["HP"])),
              series_titles: textValues(field(["Title", "Series"])),
            };
  const materialFacts = stableValue({
    card_number: cardNumber,
    name,
    card_type: normalizedType,
    colours,
    image_roles:
      format === "fusion-world" && normalizedType === "leader"
        ? ["front", "back"]
        : ["front"],
  });
  const artworkFingerprint = `material:${JSON.stringify(materialFacts)}`;
  const detail = {
    path: locator,
    number: cardNumber,
    title: name,
    rules,
    profile: `${format}@1`,
    attributes,
    product_codes: [],
    distribution: {
      code: `detail:${new URL(requestUrl).pathname}`,
      kind: "source_bucket",
      label: field(["Where to get it", "Card Set(s)"]) ?? "Card detail",
    },
    printing: {
      rarity: field(["Rarity"]),
      normalizedRarity: field(["Rarity"])?.toLowerCase() ?? null,
      attributes:
        format === "digimon"
          ? { alternative_art: false }
          : format === "gundam"
            ? { alternate_art: false }
            : format === "one-piece"
              ? { illustration_types: [] }
              : {},
    },
    printed_rules: rules,
    variant: locator === cardNumber
      ? "base"
      : locator.slice(cardNumber.length) || locator,
    artwork_fingerprint: artworkFingerprint,
    printed_fields_digest: `printed-material:${
      JSON.stringify(stableValue({ rules, attributes }))
    }`,
    image: imageUrls[0]!,
    images: imageUrls.map((url, index) => ({
      role:
        format === "fusion-world" &&
          normalizedType === "leader" &&
          index === 1
          ? "back"
          : index === 0
            ? "front"
            : "other",
      source_url: url,
      artwork_fingerprint: artworkFingerprint,
    })),
  };
  return cardObservation(
    detail,
    [],
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
}

function parseBandaiProductDetail(
  html: string,
  sourceLineage: string,
  requestUrl: string,
): Record<string, unknown> {
  const code =
    labelledHtmlValue(html, "Product Code") ??
    htmlText(html).match(/\b[A-Z]{1,6}\d{0,2}-\d{2,5}\b/u)?.[0] ??
    null;
  const title = htmlText(
    html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/iu)?.[1] ??
      html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu)?.[1] ??
      "",
  );
  if (code === null || title.length === 0) {
    throw new Error(
      `${sourceLineage} Product detail is missing its official code or title.`,
    );
  }
  const product = { code, title };
  const releaseDate = labelledHtmlValue(html, "Release Date");
  const releases = new Map<string, Record<string, unknown>[]>();
  if (releaseDate !== null) {
    releases.set(code, [{
      event_key: new URL(requestUrl).href,
      region: labelledHtmlValue(html, "Region") ?? "unknown",
      precision: /^\d{4}-\d{2}-\d{2}$/u.test(releaseDate) ? "day" : "unknown",
      date: releaseDate,
      status: labelledHtmlValue(html, "Status") ?? "announced",
    }]);
  }
  return productOnlyObservation(
    product,
    releases,
    { revision: "captured-by-policy-surface", entries: [] },
    { revision: "captured-by-policy-surface", entries: [] },
  );
}

function labelledHtmlValue(html: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const patterns = [
    new RegExp(
      `<(?:dt|th|h[1-6]|span|div)\\b[^>]*>\\s*${escaped}\\s*:?\\s*</(?:dt|th|h[1-6]|span|div)>\\s*<(?:dd|td|div|span)\\b[^>]*>([\\s\\S]*?)</(?:dd|td|div|span)>`,
      "iu",
    ),
    new RegExp(
      `<[^>]*\\bdata-field=["']${escaped}["'][^>]*>([\\s\\S]*?)</[^>]+>`,
      "iu",
    ),
  ];
  for (const pattern of patterns) {
    const value = html.match(pattern)?.[1];
    if (value !== undefined) {
      const text = htmlText(value);
      if (text.length > 0 && text !== "-") return text;
      if (text === "-") return "-";
    }
  }
  return null;
}

function parseBandaiSurfaceCoverage(
  html: string,
  sourceLineage: string,
  surface: string,
  url: string,
): ParsedBandaiSurface {
  const text = htmlText(html);
  if (
    surface === "listing" &&
    /(?:too many search results|more than 1,?000|results? (?:were )?capped)/iu
      .test(text)
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
    /<(?:article|li|tr)\b[^>]*>([\s\S]*?)<\/(?:article|li|tr)>/giu,
  )]
    .map((match) => htmlText(match[1]!))
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
  return {
    observations: [{
      completeness: completeObservation(),
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
  return /^\d+$/u.test(value) ? Number.parseInt(value, 10) : null;
}

function textValues(value: string | null): string[] {
  return value === null || value === "-"
    ? []
    : [...new Set(value.split("/").map((item) => item.trim()).filter(Boolean))];
}

function requiredNullableText(value: string | null, name: string): string | null {
  if (value === null) return null;
  if (value.length === 0) throw new Error(`${name} is invalid.`);
  return value;
}

function rawSnapshotDecoder(
  format: DiscoveryFormat,
  game: ProductSourceGame,
  sourceLineage: string,
  requiredSurfaces: readonly string[],
): OfficialRawAdapterContract["parseBytes"] {
  return (bytes, context) => {
    const surface = surfaceFromUrl(context.url);
    if (!requiredSurfaces.includes(surface)) {
      throw new Error(
        `Official Source URL does not identify a required ${sourceLineage} surface.`,
      );
    }
    const rawDocument = decodeRawSurfacePayload(
      bytes,
      context.mediaType,
      surface,
    );
    return normalizedSurfaceObservations(
      format,
      game,
      sourceLineage,
      surface,
      rawDocument,
    );
  };
}

function normalizedSurfaceObservations(
  format: DiscoveryFormat,
  game: ProductSourceGame,
  sourceLineage: string,
  surface: string,
  rawDocument: Record<string, unknown>,
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
    observations = parseRawReleasesSurface(document);
  } else {
    observations = [rawCoverageObservation(document, surface)];
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
      normalizedPartitions(
        normalizePartitionEntries(raw.events, normalizeOnePieceReleaseEntry),
        "release-event",
      ),
      ["publication", "events"],
    );
  }
  return normalizedSurfaceBody(
    normalizedPolicy(raw, `one-piece-${surface}`),
    ["publication", "revision", "entries"],
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
    ["publication", "revision", "entries"],
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
    ["publication", "revision", "entries"],
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
    ["publication", "locale", "revision", "entries"],
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
  return {
    revision: requiredText(raw.revision, "Official policy revision"),
    entries: requiredArray(raw.entries, "Official policy entries"),
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
    code: requiredText(product[codeField], "Official Product code"),
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
  return {
    product: product(entry.product),
    release: release(
      requiredRecord(entry.release, "Official Release facts"),
    ),
  };
}

function canonicalRelease(
  release: Record<string, unknown>,
  fields: { code: string; event: string },
): Record<string, unknown> {
  return {
    code: requiredText(release[fields.code], "Official Release Product code"),
    event_key: requiredText(release[fields.event], "Official Release identity"),
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
          ...(retainDocument ? mappedRootFields : []).map(
            (field) =>
              `source_sidecar.raw.official_surfaces[0].document.${field}`,
          ),
        ]),
      ].sort(),
      unmapped_optional_fields: [
        ...unmapped,
        ...(retainDocument ? Object.entries(document) : [])
          .filter(([field]) => !mappedRootFields.includes(field))
          .map(([field, value]) => ({
            path:
              `source_sidecar.raw.official_surfaces[0].document.${field}`,
            value,
          })),
      ],
    },
  };
}

function decodeRawSurfacePayload(
  bytes: Uint8Array,
  mediaType: string | null,
  surface: string,
): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes);
  } catch {
    throw new Error(`Official Source ${surface} bytes are not valid UTF-8.`);
  }
  const normalizedMediaType = mediaType?.split(";", 1)[0]?.trim().toLowerCase();
  let json: string;
  if (
    isDiscoverySurface(surface) ||
    surface === "products"
  ) {
    if (normalizedMediaType !== "text/html") {
      throw new Error(
        `Official Source ${surface} must be captured as text/html.`,
      );
    }
    const matches = [
      ...text.matchAll(
        /<script\s+type=["']application\/json["']\s+data-keepr-official-payload(?:=["'][^"']*["'])?\s*>([\s\S]*?)<\/script>/giu,
      ),
    ];
    if (matches.length !== 1) {
      throw new Error(
        `Official Source ${surface} HTML must contain exactly one official payload.`,
      );
    }
    json = matches[0]![1]!;
  } else {
    if (
      normalizedMediaType !== "application/json" &&
      normalizedMediaType !== "application/ld+json"
    ) {
      throw new Error(
        `Official Source ${surface} must be captured as application/json.`,
      );
    }
    json = text;
  }
  try {
    return requiredRecord(
      JSON.parse(json),
      `Official Source ${surface} payload`,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Official Source")
    ) {
      throw error;
    }
    throw new Error(`Official Source ${surface} payload is not valid JSON.`);
  }
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
  const releases = requiredArray(
    surface.releases,
    "Official Source referenced Releases",
  );
  const keys = surfaceKeys[format];
  return parseOfficialDiscovery(
    {
      [keys.listing]: {
        page: 1,
        pages: 1,
        total: entries.length,
        has_next: false,
        entries,
      },
      [keys.details]: details,
      [keys.products]: products,
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
  ).map((observation) => {
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
  return products.map((product) =>
    productOnlyObservation(product, releasesByCode, policy, policy)
  );
}

function parseRawReleasesSurface(
  surface: Record<string, unknown>,
): readonly unknown[] {
  const entries = completePartitionEntries(surface.partitions)
    .map((value) => requiredRecord(value, "Official Source Release entry"));
  const products = new Map<string, Record<string, unknown>>();
  const releases = new Map<string, Record<string, unknown>[]>();
  for (const entry of entries) {
    const product = requiredRecord(
      entry.product,
      "Official Source Release Product",
    );
    const code = requiredText(product.code, "Official Release Product code");
    const release = requiredRecord(
      entry.release,
      "Official Source Release value",
    );
    if (requiredText(release.code, "Official Release code") !== code) {
      throw new Error(
        "Official Source Release Product binding is inconsistent.",
      );
    }
    products.set(code, product);
    releases.set(code, [...(releases.get(code) ?? []), release]);
  }
  const policy = {
    revision: "captured-by-required-policy-surfaces",
    entries: [],
  };
  return [...products.entries()].map(([code, product]) =>
    productOnlyObservation(
      product,
      new Map([[code, releases.get(code) ?? []]]),
      policy,
      policy,
    )
  );
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

export function officialDiscoveryAdapter(
  format: DiscoveryFormat,
  game: ProductSourceGame,
): (document: unknown) => readonly unknown[] {
  return (document) => parseOfficialDiscovery(document, surfaceKeys[format], game);
}

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
  const productsByCode = new Map(
    products.map((product) => [
      requiredText(product.code, "Official Product code"),
      product,
    ]),
  );
  if (productsByCode.size !== products.length) {
    throw new Error("Official Product partitions overlap.");
  }
  const releasesByCode = new Map<string, Record<string, unknown>[]>();
  for (const release of releases) {
    const code = requiredText(release.code, "Official Release Product code");
    if (!productsByCode.has(code)) {
      throw new Error("Official Release references an undiscovered Product.");
    }
    releasesByCode.set(code, [...(releasesByCode.get(code) ?? []), release]);
  }

  const observedProductCodes = new Set<string>();
  const observations = details.map((detail) => {
    const productCodes = requiredTextArray(
      detail.product_codes,
      "Official Card Product codes",
    );
    productCodes.forEach((code) => {
      if (!productsByCode.has(code)) {
        throw new Error("Official Card detail references an undiscovered Product.");
      }
      observedProductCodes.add(code);
    });
    return cardObservation(
      detail,
      productCodes.map((code) => productsByCode.get(code)!),
      releasesByCode,
      legality,
      errata,
      game,
    );
  });
  observations.push(
    ...products
      .filter((product) =>
        !observedProductCodes.has(requiredText(product.code, "Product code"))
      )
      .map((product) =>
        productOnlyObservation(product, releasesByCode, legality, errata)
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
      resolution: "warning",
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
      effective_rules_text: requiredText(detail.rules, "Official Card rules"),
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
            printed_rules_text: requiredText(
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
            treatment: "standard",
            demonstrably_novel: true,
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
      products: [],
      distribution_contexts: [],
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

function catalogue(
  products: Record<string, unknown>[],
  releasesByCode: Map<string, Record<string, unknown>[]>,
) {
  return {
    products: products.map((product) => {
      const code = requiredText(product.code, "Official Product code");
      return {
        reference: productReference(product),
        official_code: code,
        name: requiredText(product.title, "Official Product title"),
        releases: (releasesByCode.get(code) ?? []).map((release) => ({
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

function completeObservation() {
  return {
    structurally_complete: true,
    required_surfaces_complete: true,
    partitions_complete: true,
    declared_record_count: 1,
    parsed_record_count: 1,
  };
}

function productReference(
  product: Record<string, unknown>,
): { kind: "official_code"; value: string } {
  return {
    kind: "official_code",
    value: requiredText(product.code, "Official Product code"),
  };
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
