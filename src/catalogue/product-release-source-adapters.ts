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
  parseBytes: (
    bytes: Uint8Array,
    context: { mediaType: string | null; url: string },
  ) => readonly unknown[];
};

const rawContractDefinitions = [
  {
    adapterVersion: "one-piece-json-document@2",
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
  },
] as const;

export const officialRawAdapterContracts: readonly OfficialRawAdapterContract[] =
  Object.freeze(
    rawContractDefinitions.map((definition) =>
      Object.freeze({
        ...definition,
        requiredSurfaces: Object.freeze([...definition.requiredSurfaces]),
        parseBytes: rawSnapshotDecoder(
          definition.format,
          definition.supportedGame,
          definition.sourceLineage,
          definition.requiredSurfaces,
        ),
      }),
    ),
  );

export function officialSourceDiscoveryRequests(
  sourceLineage: string,
  origin: string,
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
  const base = new URL(origin);
  return contract.requiredSurfaces.map((surface) => ({
    id: `${sourceLineage}:${surface}`,
    method: "GET",
    url: new URL(
      `${sourceLineage}/${surface}`,
      base.href.endsWith("/") ? base : new URL(`${base.href}/`),
    ).href,
    headers: {
      accept:
        surface.includes("card") ||
        surface === "packages" ||
        surface === "products"
          ? "text/html"
          : "application/json",
    },
  }));
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
    const document = decodeRawSurfacePayload(bytes, context.mediaType, surface);
    if (
      document.contract !== "card-keepr-official-source-surface@1" ||
      document.lineage !== sourceLineage ||
      document.surface !== surface
    ) {
      throw new Error(
        `Official Source ${surface} bytes do not satisfy the ${sourceLineage} surface binding.`,
      );
    }
    if (isDiscoverySurface(surface)) {
      return parseRawDiscoverySurface(document, format, game);
    }
    if (surface === "products") {
      return parseRawProductsSurface(document);
    }
    if (surface === "releases") {
      return parseRawReleasesSurface(document);
    }
    return [rawCoverageObservation(document, surface)];
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
  );
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
    allEntries.push(...entries);
  }
  return allEntries;
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
  if (detail.printing !== undefined) {
    relationships.push({
      kind: "printing-distribution-context",
      context_key: distributionCode,
      evidence_category: "derived",
      resolution: "deterministic",
    });
  }
  if (distributionProductReference !== null) {
    relationships.push({
      kind: "distribution-context-product",
      context_key: distributionCode,
      product_reference: distributionProductReference,
      evidence_category: "explicit",
      resolution: "explicit",
    });
  } else if (typeof distribution.product_label === "string") {
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
              raw: requiredText(
                requiredRecord(detail.printing, "Official Printing").rarity,
                "Official Printing rarity",
              ),
              normalized: requiredText(
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
            images: [{
              role: "front",
              source_url: detail.image,
              artwork_fingerprint: artwork,
            }],
          },
        }),
    memberships: {
      products: [],
      distribution_contexts: [],
      source_buckets: [],
    },
    product_release_catalogue: {
      ...productCatalogue,
      distribution_contexts: [{
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
  return {
    raw: { detail, products, legality, errata },
    consumed_fields: [
      "detail.number",
      "detail.title",
      "detail.rules",
      "products[].code",
      "products[].title",
    ],
    unmapped_optional_fields: products.flatMap((product, index) =>
      product.campaign_note === undefined
        ? []
        : [{
            path: `source_sidecar.raw.products[${index}].campaign_note`,
            value: product.campaign_note,
          }]
    ),
  };
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
