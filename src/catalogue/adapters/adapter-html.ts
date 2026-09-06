import type { ProductSourceGame } from "./adapter-contract";
import { nullableText, requiredArray, requiredRecord, requiredText } from "./adapter-normalization";
import type { CardObservation, CatalogueObservation, OfficialSourceObservation } from "./adapter-observations";
import { AdapterParseFailure, adapterUrl } from "./adapter-parse-failure";
import { partitionMappedOfficialLeaves } from "./official-source-field-coverage";
export function fusionWorldFullLocatorFromUrl(url: URL, exactLiveQuery: boolean): string | null {
  const entries = [...url.searchParams.entries()];
  const identities = entries.filter(([key]) => /^(?:card(?:[_-]?(?:id|no|number))?|detailSearch|popup)$/iu.test(key));
  if (identities.length === 0) return null;
  if (identities.length !== 1) {
    throw new AdapterParseFailure("Fusion World full locator has conflicting query identities.");
  }
  const [identityKey, rawCardLocator] = identities[0]!;
  const variantValues = url.searchParams.getAll("p");
  if (variantValues.length > 1) {
    throw new AdapterParseFailure("Fusion World full locator has conflicting variant queries.");
  }
  if (exactLiveQuery && (identityKey !== "card_no" || entries.some(([key]) => key !== "card_no" && key !== "p"))) {
    throw new AdapterParseFailure("Fusion World full locator has an unsupported live query field.");
  }
  const cardLocator = rawCardLocator.normalize("NFC").trim();
  const baseIdentity = fusionWorldLocatorIdentity(cardLocator);
  const variant = variantValues[0]?.normalize("NFC").trim();
  if (variant === undefined) return cardLocator;
  if (baseIdentity.variant !== "base" || !/^_[A-Za-z0-9-]+$/u.test(variant)) {
    throw new AdapterParseFailure("Fusion World full locator has a conflicting variant query.");
  }
  const locator = `${baseIdentity.cardNumber}${variant}`;
  fusionWorldLocatorIdentity(locator);
  return locator;
}

export function htmlAttribute(attributes: string, name: string): string | null {
  const match = attributes.match(new RegExp(`\\b${name}=["']([^"']+)["']`, "iu"));
  return match?.[1] ?? null;
}

export type ParsedBandaiSurface = {
  observations: readonly OfficialSourceObservation[];
  retainedDocument: Record<string, unknown>;
  consumedFields: readonly string[];
};

export function fusionWorldLocatorIdentity(value: string): {
  cardNumber: string;
  variant: string;
} {
  const match = value.match(/^([A-Z]{1,6}\d{0,3}-[A-Z0-9]{1,6})(_[A-Za-z0-9-]+)?$/u);
  if (match === null) {
    throw new AdapterParseFailure(`Fusion World full locator ${value} is invalid.`);
  }
  return {
    cardNumber: match[1]!,
    variant: match[2] ?? "base",
  };
}

export function looseHtmlAttribute(attributes: string, name: string): string | null {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "iu"));
  return match?.[1] ?? null;
}

/**
 * Frozen V1 card-detail decoder foundation. Historical registrations always
 * select hostname-v1. Newer registrations may only layer stricter authority
 * through their versioned entry point above.
 */
export function productLinksFromHtml(
  html: string,
  requestUrl: string,
): {
  products: { code: string; title: string }[];
  fuzzyLabels: string[];
} {
  const products = [...html.matchAll(/<a\b([^>]*\bdata-product-code=["']([^"']+)["'][^>]*)>([\s\S]*?)<\/a>/giu)].map(
    (match) => {
      const href = htmlAttribute(match[1]!, "href");
      if (href === null) {
        throw new AdapterParseFailure("An explicit Product link has no official href.");
      }
      const url = adapterUrl(decodeHtmlText(href), requestUrl);
      if (url.protocol !== "https:") {
        throw new AdapterParseFailure("An explicit Product link is not HTTPS.");
      }
      return {
        code: decodeHtmlText(match[2]!).normalize("NFC").trim(),
        title: htmlText(match[3]!),
      };
    },
  );
  for (const product of products) {
    if (product.code.length === 0 || product.title.length === 0) {
      throw new AdapterParseFailure("An explicit Product link requires code and title evidence.");
    }
  }
  const fuzzyLabels = [
    ...html.matchAll(/<a\b([^>]*\bclass=["'][^"']*\bproduct-link\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/giu),
  ]
    .filter((match) => htmlAttribute(match[1]!, "data-product-code") === null)
    .map((match) => htmlText(match[2]!))
    .filter((label) => label.length > 0);
  return {
    products: [...new Map(products.map((product) => [product.code, product])).values()].sort((left, right) =>
      left.code.localeCompare(right.code),
    ),
    fuzzyLabels: [...new Set(fuzzyLabels)].sort(),
  };
}

export function htmlLabelPairs(html: string): { label: string; value: string }[] {
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
  for (const match of html.matchAll(/<div\b[^>]*>\s*<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>([\s\S]*?)<\/div>/giu)) {
    pairs.push({
      label: htmlText(match[1]!).replace(/:$/u, "").trim(),
      value: htmlText(match[2]!),
    });
  }
  return pairs.filter(({ label }) => label.length > 0);
}

export function firstLabelValue(
  pairs: readonly { label: string; value: string }[],
  names: readonly string[],
): string | null {
  for (const name of names) {
    const found = pairs.find(({ label }) => label.localeCompare(name, undefined, { sensitivity: "accent" }) === 0);
    if (found !== undefined) return found.value;
  }
  return null;
}

export function requiredHtmlMatch(value: string, pattern: RegExp, name: string): RegExpMatchArray {
  const match = value.match(pattern);
  if (match === null) throw new AdapterParseFailure(`${name} is unavailable.`);
  return match;
}

export function htmlText(value: string): string {
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

export function decodeHtmlText(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#039;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replace(/&#(\d+);/gu, (_match, digits: string) => String.fromCodePoint(Number.parseInt(digits, 10)));
}

export function integerOrNull(value: string | null): number | null {
  if (value === null || value === "-" || value === "") return null;
  const normalized = value.normalize("NFC").trim();
  if (!/^\d+$/u.test(normalized) && !/^\d{1,3}(?:,\d{3})+$/u.test(normalized)) {
    throw new AdapterParseFailure(`Unrecognized official numeric token: ${value}`);
  }
  return Number.parseInt(normalized.replaceAll(",", ""), 10);
}

export function textValues(value: string | null): string[] {
  return value === null || value === "-"
    ? []
    : [
        ...new Set(
          value
            .split("/")
            .map((item) => item.trim())
            .filter(Boolean),
        ),
      ];
}

export function colourValues(value: string | null): string[] {
  if (value === null || value === "-") return [];
  return [
    ...new Set(
      value
        .split(/[/,]/u)
        .map((item) => item.normalize("NFC").trim().toLocaleLowerCase())
        .filter(Boolean),
    ),
  ];
}

export function digimonTextSections(
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
    ["[special digivolution condition]", "special_digivolution_condition"],
  ]);
  return pairs.flatMap(({ label, value }) => {
    const kind = kinds.get(label.normalize("NFC").trim().toLocaleLowerCase());
    const text = value.normalize("NFC").trim();
    return kind === undefined || text.length === 0 || text === "-" ? [] : [{ kind, text }];
  });
}

export function digivolutionRequirements(values: readonly string[]): {
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
      throw new AdapterParseFailure(`Unrecognized official Digimon digivolution requirement: ${value}`);
    }
    return {
      index: index + 1,
      from_level: Number(normalized.match(/\bLv\.?\s*(\d+)\b/iu)?.[1] ?? Number.NaN) || null,
      colours: [
        ...new Set(
          [...normalized.matchAll(/\b(red|blue|green|yellow|black|purple|white)\b/giu)].map((match) =>
            match[1]!.toLocaleLowerCase(),
          ),
        ),
      ],
      cost: Number.parseInt(cost, 10),
      raw_condition: normalized,
    };
  });
}

export function exactOnePieceSourceDate(value: unknown, name: string): string {
  const date = requiredText(value, name);
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(date)) {
    throw new AdapterParseFailure(`${name} is invalid.`);
  }
  const instant = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 10) !== date) {
    throw new AdapterParseFailure(`${name} is invalid.`);
  }
  return date;
}

export function attachRawSurfaceEvidenceV1<T extends OfficialSourceObservation>(
  observation: T,
  sourceLineage: string,
  surface: string,
  document: Record<string, unknown>,
  retainDocument: boolean,
  mappedRootFields: readonly string[],
  explicitUnmappedFields: readonly { path: string; value: unknown }[] = [],
): T {
  const record = requiredRecord(observation, `Official Source ${surface} observation`);
  const existing = record.source_sidecar === undefined ? {} : requiredRecord(record.source_sidecar, "Source sidecar");
  const raw = existing.raw === undefined ? {} : requiredRecord(existing.raw, "Source sidecar raw fields");
  const consumed = Array.isArray(existing.consumed_fields) ? existing.consumed_fields : [];
  const unmapped = Array.isArray(existing.unmapped_optional_fields) ? existing.unmapped_optional_fields : [];
  const retainedMappedLeaves = retainDocument
    ? mappedRootFields.flatMap((field) =>
        partitionMappedOfficialLeaves(document[field], `source_sidecar.raw.official_surfaces[0].document.${field}`),
      )
    : [];
  const explicitlyUnmappedPaths = new Set(explicitUnmappedFields.map(({ path }) => path));
  return {
    ...observation,
    source_sidecar: {
      ...existing,
      raw: {
        ...raw,
        official_surfaces: [
          ...(Array.isArray(raw.official_surfaces) ? raw.official_surfaces : []),
          {
            source_lineage: sourceLineage,
            surface,
            ...(retainDocument ? { document } : { retained_by_observation_ordinal: 1 }),
          },
        ],
      },
      consumed_fields: [
        ...new Set([
          ...consumed,
          "source_sidecar.raw.official_surfaces[].source_lineage",
          "source_sidecar.raw.official_surfaces[].surface",
          ...retainedMappedLeaves.flatMap(({ consumed }) =>
            consumed.filter((path) => !explicitlyUnmappedPaths.has(path)),
          ),
        ]),
      ].sort(),
      unmapped_optional_fields: [
        ...unmapped,
        ...retainedMappedLeaves.flatMap(({ unmapped }) => unmapped),
        ...(retainDocument ? explicitUnmappedFields : []),
        ...(retainDocument ? Object.entries(document) : [])
          .filter(([field]) => !mappedRootFields.includes(field))
          .flatMap(([field, value]) => leafEntries(value, `source_sidecar.raw.official_surfaces[0].document.${field}`)),
      ],
    },
  };
}

export function cardObservation(
  detail: Record<string, unknown>,
  products: Record<string, unknown>[],
  releasesByCode: Map<string, Record<string, unknown>[]>,
  errata: Record<string, unknown>,
  game: ProductSourceGame,
): CardObservation {
  const distribution = requiredRecord(detail.distribution, "Official Distribution");
  const distributionCode = requiredText(distribution.code, "Official Distribution code");
  const sourceBucket = distribution.kind === "source_bucket";
  const distributionProductReference =
    distribution.product_reference === undefined
      ? null
      : productReferenceValue(distribution.product_reference, "Official Distribution Product reference");
  if (
    distributionProductReference !== null &&
    !products.some(
      (product) => productReferenceKey(productReference(product)) === productReferenceKey(distributionProductReference),
    )
  ) {
    throw new AdapterParseFailure("Official Distribution references a Product not evidenced by the Card detail.");
  }
  const productCatalogue = catalogue(products, releasesByCode);
  const relationships: Record<string, unknown>[] = products.flatMap((product) => {
    const reference = productReference(product);
    return [
      ...(detail.printing === undefined
        ? []
        : [
            {
              kind: "printing-product",
              product_reference: reference,
              evidence_category: "explicit",
              resolution: "explicit",
            },
          ]),
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
        kind: detail.printing === undefined ? "product-card" : "printing-product",
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
  } else if (!sourceBucket && typeof distribution.product_label === "string") {
    relationships.push({
      kind: "distribution-context-product",
      context_key: distributionCode,
      product_reference: {
        kind: "name",
        value: requiredText(distribution.product_label, "Official Distribution Product label"),
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
      effective_rules_text: nullableText(detail.rules, "Official Card rules"),
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
                requiredRecord(detail.printing, "Official Printing").normalizedRarity,
                "Official normalized rarity",
              ),
            },
            printed_rules_text: nullableText(detail.printed_rules, "Official printed rules"),
            game_data: {
              profile: requiredText(detail.profile, "Official Card profile"),
              attributes: requiredRecord(detail.printing, "Official Printing").attributes,
            },
          },
          identity_evidence: {
            locator: requiredText(detail.path, "Official Card path"),
            variant_key: requiredText(detail.variant, "Official variant"),
            artwork_fingerprint: requiredText(artwork, "Official artwork fingerprint"),
            printed_fields_digest: requiredText(detail.printed_fields_digest, "Official printed fields digest"),
            treatment: detail.treatment === "standard" || detail.treatment === "alternate" ? detail.treatment : null,
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
                ? [
                    {
                      role: "front",
                      source_url: detail.image,
                      artwork_fingerprint: artwork,
                    },
                  ]
                : requiredArray(detail.images, "Official Printing images"),
          },
        }),
    memberships: {
      products: products.map((product) => productReference(product).value),
      distribution_contexts: sourceBucket ? [] : [distributionCode],
      source_buckets: sourceBucket ? [distributionCode] : [],
    },
    product_release_catalogue: {
      ...productCatalogue,
      distribution_contexts: sourceBucket
        ? []
        : [
            {
              key: distributionCode,
              kind: distribution.kind,
              label: distribution.label,
              ...(distributionProductReference === null ? {} : { product_reference: distributionProductReference }),
              evidence_category: "explicit",
            },
          ],
      relationships,
    },
    source_sidecar: sourceSidecar(detail, products, errata),
  };
}

export function catalogue(products: Record<string, unknown>[], releasesByCode: Map<string, Record<string, unknown>[]>) {
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

export function sourceSidecar(
  detail: Record<string, unknown> | null,
  products: Record<string, unknown>[],
  errata: Record<string, unknown>,
) {
  const productFieldCoverage = products.flatMap((product, index) => {
    const productPath = `products[${index}]`;
    const consumed = ["code", "title", "distribution"].flatMap((field) =>
      product[field] === undefined ? [] : leafPaths(product[field], `${productPath}.${field}`),
    );
    const unmapped = Object.entries(product)
      .filter(([field]) => field !== "code" && field !== "title" && field !== "distribution")
      .flatMap(([field, value]) => leafEntries(value, `source_sidecar.raw.${productPath}.${field}`));
    return [{ consumed, unmapped }];
  });
  return {
    raw: { detail, products, errata },
    consumed_fields: [
      "detail.number",
      "detail.title",
      "detail.rules",
      ...productFieldCoverage.flatMap(({ consumed }) => consumed),
    ],
    unmapped_optional_fields: productFieldCoverage.flatMap(({ unmapped }) => unmapped),
  };
}

export function leafPaths(value: unknown, path: string): string[] {
  if (Array.isArray(value)) {
    return value.length === 0 ? [path] : value.flatMap((item, index) => leafPaths(item, `${path}[${index}]`));
  }
  if (isPlainRecord(value)) {
    const entries = Object.entries(value);
    return entries.length === 0 ? [path] : entries.flatMap(([field, item]) => leafPaths(item, `${path}.${field}`));
  }
  return [path];
}

export function leafEntries(value: unknown, path: string): { path: string; value: unknown }[] {
  if (Array.isArray(value)) {
    return value.length === 0
      ? [{ path, value }]
      : value.flatMap((item, index) => leafEntries(item, `${path}[${index}]`));
  }
  if (isPlainRecord(value)) {
    const entries = Object.entries(value);
    return entries.length === 0
      ? [{ path, value }]
      : entries.flatMap(([field, item]) => leafEntries(item, `${path}.${field}`));
  }
  return [{ path, value }];
}

export function completeObservation(declaredRecordCount = 1, parsedRecordCount = 1) {
  return {
    structurally_complete: true,
    required_surfaces_complete: true,
    partitions_complete: true,
    declared_record_count: declaredRecordCount,
    parsed_record_count: parsedRecordCount,
  };
}

export function productReference(product: Record<string, unknown>): { kind: "official_code" | "name"; value: string } {
  const code = nullableText(product.code, "Official Product code");
  return code === null
    ? {
        kind: "name",
        value: requiredText(product.title, "Official Product title"),
      }
    : { kind: "official_code", value: code };
}

export function productMapKey(product: Record<string, unknown>): string {
  const reference = productReference(product);
  return reference.kind === "official_code" ? reference.value : `name:${reference.value}`;
}

export function productReferenceValue(value: unknown, name: string): { kind: "official_code" | "name"; value: string } {
  const reference = requiredRecord(value, name);
  if (reference.kind !== "official_code" && reference.kind !== "name") {
    throw new AdapterParseFailure(`${name} kind is invalid.`);
  }
  return {
    kind: reference.kind,
    value: requiredText(reference.value, `${name} value`),
  };
}

export function productReferenceKey(reference: { kind: "official_code" | "name"; value: string }): string {
  return `${reference.kind}:${reference.value}`;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stageRecord(
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

export function productOnlyObservation(
  product: Record<string, unknown>,
  releasesByCode: Map<string, Record<string, unknown>[]>,
  errata: Record<string, unknown>,
): CatalogueObservation {
  const distribution =
    product.distribution === undefined ? null : requiredRecord(product.distribution, "Official Product Distribution");
  const contextKey = distribution === null ? null : requiredText(distribution.code, "Official Distribution code");
  return {
    completeness: completeObservation(),
    product_release_catalogue: {
      ...catalogue([product], releasesByCode),
      distribution_contexts:
        distribution === null
          ? []
          : [
              {
                key: contextKey,
                kind: distribution.kind,
                label: distribution.label,
                product_reference: productReference(product),
                evidence_category: "explicit",
              },
            ],
      relationships:
        distribution === null
          ? []
          : [
              {
                kind: "distribution-context-product",
                context_key: contextKey,
                product_reference: productReference(product),
                evidence_category: "explicit",
                resolution: "explicit",
              },
            ],
    },
    source_sidecar: sourceSidecar(null, [product], errata),
  };
}

export function liveOfficialProductCode(title: string): string | null {
  return title.match(/\[([A-Z0-9][A-Z0-9-]{0,15})\]$/u)?.[1] ?? null;
}

export function liveOfficialReleaseDateText(value: string): string {
  const normalized = value.normalize("NFC").trim();
  // Live publisher shorthand: "2027.1.30", "September 25,2026", and
  // "December, 10 2021".
  const dotted = normalized.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})$/u);
  if (dotted !== null) {
    return `${dotted[1]}-${dotted[2]!.padStart(2, "0")}-${dotted[3]!.padStart(2, "0")}`;
  }
  return normalized
    .replace(/^([A-Za-z]+ \d{1,2}),(\d{4})$/u, "$1, $2")
    .replace(/^([A-Za-z]+),\s*(\d{1,2})\s+(\d{4})$/u, "$1 $2, $3");
}

export function nonCardProductClassificationV2(value: string): "accessory" | null {
  // The 2026-08 live listings publish deck cases alongside the previously
  // modelled accessory vocabulary.
  return nonCardProductClassification(value) !== null || /(?:card cases?|deck[ _-]?cases?)/iu.test(value)
    ? "accessory"
    : null;
}

export function nonCardProductClassification(value: string): "accessory" | null {
  return /(?:accessor|sleeve|storage|binder|playmat)/iu.test(value) ? "accessory" : null;
}

export function productEventKey(prefix: string, product: Record<string, unknown>): string {
  const reference = productReference(product);
  if (reference.kind === "official_code") {
    return `${prefix}:${reference.value}`;
  }
  const bytes = new TextEncoder().encode(reference.value.normalize("NFC").trim());
  const readablePrefix = [...bytes.slice(0, 64)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${prefix}:name-${readablePrefix}-${hash.toString(16).padStart(16, "0")}`;
}
