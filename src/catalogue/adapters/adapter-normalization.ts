import type { OfficialProduct, OfficialRelease } from "./adapter-observations";
import { AdapterParseFailure } from "./adapter-parse-failure";
import { officialArtworkFingerprint } from "./official-artwork-identity";
export function gundamPublisherNullableText(value: unknown): unknown {
  return typeof value === "string" && /^\s*[\p{Dash_Punctuation}\u2212]+\s*$/u.test(value) ? null : value;
}

export type NormalizedSurfaceBody = {
  value: Record<string, unknown>;
  consumedFields: readonly string[];
};

export function normalizedSurfaceBody(
  value: Record<string, unknown>,
  consumedFields: readonly string[],
): NormalizedSurfaceBody {
  return { value, consumedFields };
}

export function normalizedDiscovery(
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
    throw new AdapterParseFailure("Official Source partition result-cap evidence does not prove complete coverage.");
  }
  const partitions = requiredArray(page.partitions, "Official Source partitions");
  const actualLeaves = partitions.map((value) =>
    requiredText(requiredRecord(value, "Official Source partition").bucket, "Official Source leaf partition"),
  );
  if (
    expectedLeaves.length === 0 ||
    actualLeaves.length !== expectedLeaves.length ||
    new Set(actualLeaves).size !== actualLeaves.length ||
    [...actualLeaves].sort().some((value, index) => value !== [...expectedLeaves].sort()[index])
  ) {
    throw new AdapterParseFailure(
      `Official Source discovered vocabulary does not close over exact leaf partitions for ${bucket}.`,
    );
  }
  return {
    source_buckets: [bucket],
    facets: requiredArray(discoveredVocabulary, "Official Source discovered vocabulary"),
    partitions,
    details: requiredArray(details, "Official Source details"),
    products: requiredArray(products, "Official Source Products"),
    releases: requiredArray(releases, "Official Source Releases"),
  };
}

export function normalizedPartitions(value: unknown, bucket: string): Record<string, unknown> {
  const result = requiredRecord(value, "Official Source partition result");
  if (result.cap_signal !== undefined && result.cap_signal !== null) {
    throw new AdapterParseFailure("Official Source partition result-cap evidence does not prove complete coverage.");
  }
  return {
    partitions: requiredArray(result.partitions, `Official Source ${bucket} partitions`),
  };
}

export function normalizedPolicy(
  raw: Record<string, unknown>,
  expectedPublication: string,
  additionalFields: readonly string[] = [],
): Record<string, unknown> {
  if (raw.publication !== expectedPublication) {
    throw new AdapterParseFailure("Official policy publication identity is invalid.");
  }
  const allowed = new Set([
    "publication",
    "locale",
    "revision",
    "declared_record_count",
    "partition",
    "entries",
    ...additionalFields,
  ]);
  const unknown = Object.keys(raw).find((field) => !allowed.has(field));
  if (unknown !== undefined) {
    throw new AdapterParseFailure(`Official policy contains unknown field ${unknown}.`);
  }
  const entries = requiredArray(raw.entries, "Official policy entries");
  const declaredRecordCount = requiredNonNegativeInteger(
    raw.declared_record_count,
    "Official policy declared record count",
  );
  const partition = requiredRecord(raw.partition, "Official policy partition");
  const partitionFields = ["page", "pages", "total", "has_next"];
  const unknownPartitionField = Object.keys(partition).find((field) => !partitionFields.includes(field));
  if (unknownPartitionField !== undefined) {
    throw new AdapterParseFailure(`Official policy partition contains unknown field ${unknownPartitionField}.`);
  }
  if (
    partition.page !== 1 ||
    partition.pages !== 1 ||
    partition.has_next !== false ||
    partition.total !== declaredRecordCount
  ) {
    throw new AdapterParseFailure("Official policy partition is incomplete or conflicts with its declared total.");
  }
  if (declaredRecordCount !== entries.length) {
    throw new AdapterParseFailure(
      `Official policy declares ${declaredRecordCount} records but exactly ${entries.length} were parsed.`,
    );
  }
  return {
    revision: requiredText(raw.revision, "Official policy revision"),
    declared_record_count: declaredRecordCount,
    entries,
  };
}

export function normalizePartitionEntries(value: unknown, entry: (value: unknown) => unknown): Record<string, unknown> {
  const result = requiredRecord(value, "Official Source partition result");
  return {
    ...result,
    partitions: requiredArray(result.partitions, "Official Source partitions").map((rawPage) => {
      const page = requiredRecord(rawPage, "Official Source partition");
      return {
        ...page,
        entries: requiredArray(page.entries, "Official Source partition entries").map(entry),
      };
    }),
  };
}

export function canonicalDetail(
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
    allowEmptyRules?: boolean;
  },
): Record<string, unknown> {
  const printing = raw.printing === undefined ? undefined : requiredRecord(raw.printing, "Official Printing fields");
  if (
    mapping.derivePrintingIdentity === true &&
    (raw.artwork_fingerprint !== undefined ||
      raw.printed_fields_digest !== undefined ||
      printing?.normalized_rarity !== undefined)
  ) {
    throw new AdapterParseFailure(
      "Official Source publisher data must not supply normalized rarity, artwork identity, or printed-fields digest.",
    );
  }
  const path = requiredText(raw[mapping.path], "Official Card locator");
  const number = requiredText(raw[mapping.number], "Official Card number");
  const rules =
    mapping.allowEmptyRules === true && raw[mapping.rules] === ""
      ? null
      : requiredText(raw[mapping.rules], "Official Card rules");
  const artworkFingerprint =
    printing === undefined
      ? null
      : (mapping.artworkFingerprint ??
        (mapping.derivePrintingIdentity === true
          ? officialArtworkFingerprint(
              number,
              mapping.imageFields.map(({ role }) => role),
              path,
            )
          : requiredText(raw.artwork_fingerprint, "Official artwork fingerprint")));
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
    product_codes: requiredTextArray(raw.product_codes, "Official Product codes"),
    ...(!mapping.preserveFuzzyProductLabels || raw.fuzzy_product_labels === undefined
      ? {}
      : {
          fuzzy_product_labels: requiredTextArray(raw.fuzzy_product_labels, "Unresolved Official Product labels"),
        }),
    ...(raw.product_names === undefined
      ? {}
      : {
          product_names: requiredTextArray(raw.product_names, "Official Product names"),
        }),
    distribution: requiredRecord(raw.distribution, "Official Distribution"),
    ...(printing === undefined
      ? {}
      : {
          printing: {
            rarity: printing.rarity ?? null,
            normalizedRarity:
              mapping.normalizedRarity !== undefined
                ? mapping.normalizedRarity
                : mapping.derivePrintingIdentity === true
                  ? normalizedDigimonRarity(printing.rarity)
                  : (printing.normalized_rarity ?? null),
            attributes: Object.hasOwn(mapping, "printingAttributes")
              ? (mapping.printingAttributes ?? {})
              : (printing.attributes ?? {}),
          },
          printed_rules:
            mapping.allowEmptyRules === true && raw.printed_rules === ""
              ? null
              : requiredText(raw.printed_rules, "Official printed rules"),
          variant: requiredText(raw.variant, "Official Printing variant"),
          artwork_fingerprint: artworkFingerprint,
          printed_fields_digest:
            mapping.printedFieldsDigest ??
            (mapping.derivePrintingIdentity === true
              ? `printed-material:${JSON.stringify(
                  stableValue({
                    rules:
                      mapping.allowEmptyRules === true && raw.printed_rules === ""
                        ? null
                        : requiredText(raw.printed_rules, "Official printed rules"),
                    rarity:
                      mapping.normalizedRarity !== undefined ? mapping.normalizedRarity : (printing.rarity ?? null),
                    attributes: printing.attributes ?? {},
                  }),
                )}`
              : requiredText(raw.printed_fields_digest, "Official printed fields digest")),
          image: images[0]!.source_url,
          images,
        }),
  };
}

export function normalizedDigimonRarity(value: unknown): string | null {
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
    throw new AdapterParseFailure("Official Digimon rarity vocabulary is unsupported.");
  }
  return normalized;
}

export const normalizedGundamRarities: Readonly<Record<string, string>> = {
  C: "common",
  U: "uncommon",
  R: "rare",
  LR: "legend-rare",
  P: "promo",
};

export function normalizedGundamRarity(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const raw = requiredText(value, "Official Gundam rarity");
  if (raw === "-") return null;
  const match = raw.match(/^(LR|C|U|R|P)(?:\s*(?:\+{1,2}|[★☆]))?$/u);
  const normalized = match === null ? undefined : normalizedGundamRarities[match[1]!];
  if (normalized === undefined) {
    throw new AdapterParseFailure(`Official Gundam rarity vocabulary is unsupported: ${raw}`);
  }
  return normalized;
}

export function canonicalProduct(
  product: Record<string, unknown>,
  codeField: string,
  nameField: string,
): OfficialProduct {
  return {
    code: optionalOfficialCode(product[codeField], "Official Product code"),
    title: requiredText(product[nameField], "Official Product name"),
    ...(product.distribution === undefined ? {} : { distribution: product.distribution }),
    ...Object.fromEntries(
      Object.entries(product).filter(
        ([field]) => field !== codeField && field !== nameField && field !== "distribution",
      ),
    ),
  };
}

export function canonicalReleaseEntry(
  value: unknown,
  product: (value: unknown) => Record<string, unknown>,
  release: (value: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  const entry = requiredRecord(value, "Official Release entry");
  const normalizedProduct = product(entry.product);
  const normalizedRelease = release(requiredRecord(entry.release, "Official Release facts"));
  return {
    product: normalizedProduct,
    release: {
      ...normalizedRelease,
      product_title: normalizedProduct.title,
    },
  };
}

export function canonicalRelease(
  release: Record<string, unknown>,
  fields: { code: string; event: string },
): OfficialRelease {
  return {
    code: optionalOfficialCode(release[fields.code], "Official Release Product code"),
    event_key: requiredText(release[fields.event], "Official Release identity"),
    ...(release.productName === undefined && release.product_name === undefined && release.productTitle === undefined
      ? {}
      : {
          product_title: requiredText(
            release.productName ?? release.product_name ?? release.productTitle,
            "Official Release Product name",
          ),
        }),
    region: release.region,
    precision: release.precision,
    date: release.date,
    status: release.status,
  };
}

export function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

export function uniqueTextValues(value: unknown, name: string): string[] {
  const result = requiredArray(value, name).map((item) => requiredText(item, name));
  if (new Set(result).size !== result.length) {
    throw new AdapterParseFailure(`${name} overlap.`);
  }
  return result;
}

export function requiredNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new AdapterParseFailure(`${name} is invalid.`);
  }
  return Number(value);
}

export function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AdapterParseFailure(`${name} is invalid.`);
  }
  return value as Record<string, unknown>;
}

export function requiredArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new AdapterParseFailure(`${name} is invalid.`);
  return value;
}

export function requiredTextArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new AdapterParseFailure(`${name} is invalid.`);
  }
  return [...new Set(value)];
}

export function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AdapterParseFailure(`${name} is invalid.`);
  }
  return value;
}

export function nullableText(value: unknown, name: string): string | null {
  if (value === null) return null;
  return requiredText(value, name);
}

export function optionalOfficialCode(value: unknown, name: string): string | null {
  return value === undefined || value === null ? null : requiredText(value, name);
}
export type ProductReleaseFields = {
  gameLabel: string;
  productCode: string;
  productName: string;
  releaseEvent: string;
};

export function productReleaseNormalizers(fields: ProductReleaseFields) {
  const product = (value: unknown) =>
    canonicalProduct(requiredRecord(value, `${fields.gameLabel} Product`), fields.productCode, fields.productName);
  const release = (value: Record<string, unknown>) =>
    canonicalRelease(value, { code: fields.productCode, event: fields.releaseEvent });
  return {
    product,
    products: (value: unknown) => requiredArray(value, `${fields.gameLabel} Products`).map(product),
    releases: (value: unknown) =>
      requiredArray(value, `${fields.gameLabel} Releases`).map((item) =>
        release(requiredRecord(item, `${fields.gameLabel} Release`)),
      ),
    releaseEntry: (value: unknown) => canonicalReleaseEntry(value, product, release),
  };
}
