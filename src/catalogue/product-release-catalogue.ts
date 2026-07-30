import type { SupportedGame } from "./fixture";
import { canonicalJson, sha256Text } from "./serialization";

export type EvidenceCategory = "explicit" | "derived" | "curated";
export type ReleaseStatus = "announced" | "released";
export type ReleasePrecision =
  | "day"
  | "month"
  | "quarter"
  | "year"
  | "unknown";

export type CatalogueProduct = {
  id: string;
  game: SupportedGame;
  official_code: string | null;
  name: string;
  releases: CatalogueRelease[];
};

export type CatalogueRelease = {
  id: string;
  product_id: string;
  region: "EN-OCEANIA" | "EN-ASIA" | "EN-US" | "unknown";
  date: { precision: ReleasePrecision; value: string | null };
  status: ReleaseStatus;
};

export type CatalogueDistributionContext = {
  id: string;
  game: SupportedGame;
  key: string;
  kind:
    | "product"
    | "tournament_pack"
    | "winner_prize"
    | "promotion"
    | "other";
  label: string;
  product_id: string | null;
  evidence_category: EvidenceCategory;
};

export type ProductRelationship = {
  game: SupportedGame;
  kind:
    | "printing-product"
    | "printing-distribution-context"
    | "distribution-context-product"
    | "product-card";
  target_key: string;
  evidence_category: EvidenceCategory;
  resolution: "canonical" | "warning";
};

export type ProductReleaseObservation = {
  products: CatalogueProduct[];
  distributionContexts: CatalogueDistributionContext[];
  relationships: ProductRelationship[];
  warnings: Record<string, unknown>[];
};

export async function reconcileProductReleaseCatalogue(
  prior: {
    products?: readonly CatalogueProduct[];
    distribution_contexts?: readonly CatalogueDistributionContext[];
    product_relationships?: readonly ProductRelationship[];
  } | null,
  observationValues: readonly unknown[],
  game: SupportedGame,
): Promise<{
  products: CatalogueProduct[];
  distribution_contexts: CatalogueDistributionContext[];
  product_relationships: ProductRelationship[];
  warnings: Record<string, unknown>[];
}> {
  const observations = await Promise.all(
    observationValues.map((value) => parseProductReleaseObservation(value, game)),
  );
  const observedSurface = observationValues.some((value) => value !== undefined);
  return {
    products: unique([
      ...(prior?.products ?? []).filter(
        (product) => !observedSurface || product.game !== game,
      ),
      ...observations.flatMap(({ products }) => products),
    ]),
    distribution_contexts: unique([
      ...(prior?.distribution_contexts ?? []).filter(
        (context) => !observedSurface || context.game !== game,
      ),
      ...observations.flatMap(
        ({ distributionContexts }) => distributionContexts,
      ),
    ]),
    product_relationships: [
      ...(prior?.product_relationships ?? []).filter(
        (relationship) => !observedSurface || relationship.game !== game,
      ),
      ...observations.flatMap(({ relationships }) => relationships),
    ],
    warnings: observations.flatMap(({ warnings }) => warnings),
  };
}

export async function parseProductReleaseObservation(
  value: unknown,
  game: SupportedGame,
): Promise<ProductReleaseObservation> {
  if (value === undefined) {
    return {
      products: [],
      distributionContexts: [],
      relationships: [],
      warnings: [],
    };
  }
  const input = record(value, "product_release_catalogue");
  const productInputs = array(input.products, "product_release_catalogue.products");
  const products: CatalogueProduct[] = [];
  for (const raw of productInputs) {
    const product = record(raw, "Product");
    const officialCode = nullableText(product.official_code, "Product official_code");
    const name = text(product.name, "Product name");
    const productId = await productIdFor(game, officialCode, name);
    const releases: CatalogueRelease[] = [];
    for (const rawRelease of array(product.releases, "Product releases")) {
      const release = record(rawRelease, "Release");
      const region = releaseRegion(release.region);
      const date = record(release.date, "Release date");
      const precision = releasePrecision(date.precision);
      const dateValue = nullableText(date.value, "Release date value");
      assertDatePrecision(precision, dateValue);
      const status = releaseStatus(release.status);
      releases.push({
        id: await releaseIdFor(productId, region, precision, dateValue, status),
        product_id: productId,
        region,
        date: { precision, value: dateValue },
        status,
      });
    }
    products.push({
      id: productId,
      game,
      official_code: officialCode,
      name,
      releases: releases.sort((left, right) => left.id.localeCompare(right.id)),
    });
  }
  const productsByKey = new Map<string, CatalogueProduct>();
  for (const product of products) {
    if (product.official_code !== null) productsByKey.set(product.official_code, product);
    productsByKey.set(product.name, product);
  }
  const distributionContexts: CatalogueDistributionContext[] = [];
  for (const raw of array(
    input.distribution_contexts,
    "product_release_catalogue.distribution_contexts",
  )) {
    const context = record(raw, "Distribution Context");
    const key = text(context.key, "Distribution Context key");
    const productKey = nullableText(
      context.product_key,
      "Distribution Context product_key",
    );
    const productId =
      productKey === null ? null : productsByKey.get(productKey)?.id ?? null;
    if (productKey !== null && productId === null) {
      throw new Error("A Distribution Context references an unknown Product.");
    }
    distributionContexts.push({
      id: await distributionContextIdFor(game, key),
      game,
      key,
      kind: contextKind(context.kind),
      label: text(context.label, "Distribution Context label"),
      product_id: productId,
      evidence_category: evidenceCategory(context.evidence_category),
    });
  }
  const relationships: ProductRelationship[] = [];
  const warnings: Record<string, unknown>[] = [];
  for (const raw of array(
    input.relationships,
    "product_release_catalogue.relationships",
  )) {
    const relationship = record(raw, "Product relationship");
    const resolution =
      relationship.resolution === "ambiguous" ||
      relationship.resolution === "fuzzy"
        ? "warning"
        : "canonical";
    const parsed: ProductRelationship = {
      game,
      kind: relationshipKind(relationship.kind),
      target_key: text(relationship.target_key, "relationship target_key"),
      evidence_category: evidenceCategory(relationship.evidence_category),
      resolution,
    };
    if (resolution === "warning") {
      warnings.push({
        code: "product_relationship_unresolved",
        relationship_kind: parsed.kind,
        relationship_value: parsed.target_key,
        detail:
          "An ambiguous or fuzzy Product relationship remains unresolved and was not made canonical.",
      });
    } else {
      relationships.push(parsed);
    }
  }
  return {
    products: unique(products),
    distributionContexts: unique(distributionContexts),
    relationships,
    warnings,
  };
}

export async function productIdFor(
  game: SupportedGame,
  officialCode: string | null,
  name: string,
): Promise<string> {
  return `product_${await sha256Text(
    canonicalJson(
      officialCode === null
        ? { game, name }
        : { game, official_code: officialCode },
    ),
  )}`;
}

export async function distributionContextIdFor(
  game: SupportedGame,
  key: string,
): Promise<string> {
  return `distribution_context_${await sha256Text(canonicalJson({ game, key }))}`;
}

async function releaseIdFor(
  productId: string,
  region: CatalogueRelease["region"],
  precision: ReleasePrecision,
  value: string | null,
  status: ReleaseStatus,
): Promise<string> {
  return `release_${await sha256Text(
    canonicalJson({ product_id: productId, region, precision, value, status }),
  )}`;
}

function unique<T extends { id: string }>(values: T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()].sort(
    (left, right) => left.id.localeCompare(right.id),
  );
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be non-empty text.`);
  }
  return value.trim();
}

function nullableText(value: unknown, field: string): string | null {
  if (value === null) return null;
  return text(value, field);
}

function releaseRegion(value: unknown): CatalogueRelease["region"] {
  if (
    value !== "EN-OCEANIA" &&
    value !== "EN-ASIA" &&
    value !== "EN-US" &&
    value !== "unknown"
  ) {
    throw new Error("Release region is invalid.");
  }
  return value;
}

function releasePrecision(value: unknown): ReleasePrecision {
  if (
    value !== "day" &&
    value !== "month" &&
    value !== "quarter" &&
    value !== "year" &&
    value !== "unknown"
  ) {
    throw new Error("Release date precision is invalid.");
  }
  return value;
}

function releaseStatus(value: unknown): ReleaseStatus {
  if (value !== "announced" && value !== "released") {
    throw new Error("Release status is invalid.");
  }
  return value;
}

function assertDatePrecision(
  precision: ReleasePrecision,
  value: string | null,
): void {
  const patterns: Record<Exclude<ReleasePrecision, "unknown">, RegExp> = {
    day: /^\d{4}-\d{2}-\d{2}$/,
    month: /^\d{4}-\d{2}$/,
    quarter: /^\d{4}-Q[1-4]$/,
    year: /^\d{4}$/,
  };
  if (
    (precision === "unknown" && value !== null) ||
    (precision !== "unknown" &&
      (value === null || !patterns[precision].test(value)))
  ) {
    throw new Error("Release date value does not match its published precision.");
  }
}

function contextKind(value: unknown): CatalogueDistributionContext["kind"] {
  if (
    value !== "product" &&
    value !== "tournament_pack" &&
    value !== "winner_prize" &&
    value !== "promotion" &&
    value !== "other"
  ) {
    throw new Error("Distribution Context kind is invalid.");
  }
  return value;
}

function evidenceCategory(value: unknown): EvidenceCategory {
  if (value !== "explicit" && value !== "derived" && value !== "curated") {
    throw new Error("Relationship evidence category is invalid.");
  }
  return value;
}

function relationshipKind(value: unknown): ProductRelationship["kind"] {
  if (
    value !== "printing-product" &&
    value !== "printing-distribution-context" &&
    value !== "distribution-context-product" &&
    value !== "product-card"
  ) {
    throw new Error("Product relationship kind is invalid.");
  }
  return value;
}
