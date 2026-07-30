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

export type ProductReference = {
  kind: "official_code" | "name";
  value: string;
};

export type ProductEvidenceResource = {
  type: "source_observation";
  id: string;
  captured_at: string;
  source: string;
};

export type ProductDisagreement = {
  path: string;
  status: "unresolved";
  candidates: { value: unknown; observation_id: string }[];
};

export type ProductWithdrawal = {
  revision_id?: string;
  evidence: {
    assertion: "withdrawn";
    effective_at: string;
    evidence: string;
    source_lineage: string;
    source_snapshot_id: string;
    source_observation_set_id: string;
    source_observation_id: string;
  };
};

export type CatalogueProduct = {
  reference: ProductReference;
  id: string;
  game: SupportedGame;
  official_code: string | null;
  name: string | null;
  releases: CatalogueRelease[];
  observed: boolean;
  withdrawal: ProductWithdrawal | null;
  included: ProductEvidenceResource[];
  provenance: Record<string, string[]>;
  disagreements: ProductDisagreement[];
  source_observations?: ProductSourceObservation[];
};

export type CatalogueRelease = {
  id: string;
  product_id: string;
  region: "EN-OCEANIA" | "EN-ASIA" | "EN-US" | "unknown";
  date: {
    precision: ReleasePrecision | null;
    value: string | null;
  };
  status: ReleaseStatus | null;
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
  observed: boolean;
  source_lineages?: string[];
};

export type ProductEntityReference = {
  type: "printing" | "product" | "distribution_context" | "card";
  id: string;
};

export type ProductRelationship = {
  id: string;
  game: SupportedGame;
  kind:
    | "printing-product"
    | "printing-distribution-context"
    | "distribution-context-product"
    | "product-card";
  from: ProductEntityReference;
  to: ProductEntityReference;
  evidence_category: EvidenceCategory;
  resolution: "canonical";
  source_lineage: string;
  source_observation_ids: string[];
  relationship_value: string;
  observed: boolean;
};

export type ProductReleaseEvidenceInput = {
  value: unknown;
  sourceObservationId: string;
  sourceObservationSetId: string;
  sourceSnapshotId: string;
  sourceLineage: string;
  capturedAt: string;
  currentCardId: string;
  currentPrintingId: string | null;
};

export type ProductSourceObservation = {
  reference: ProductReference;
  id: string;
  officialCode: string | null;
  name: string;
  releases: {
    region: CatalogueRelease["region"];
    precision: ReleasePrecision;
    value: string | null;
    status: ReleaseStatus;
  }[];
  withdrawal: ProductWithdrawal | null;
  evidence: ProductEvidenceResource;
};

type ObservedProduct = ProductSourceObservation;

type ParsedObservation = {
  products: ObservedProduct[];
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
  evidenceInputs: readonly ProductReleaseEvidenceInput[],
  game: SupportedGame,
): Promise<{
  products: CatalogueProduct[];
  observedProducts: CatalogueProduct[];
  distribution_contexts: CatalogueDistributionContext[];
  product_relationships: ProductRelationship[];
  productSurfaceObserved: boolean;
  warnings: Record<string, unknown>[];
}> {
  const observations = await Promise.all(
    evidenceInputs.map((input) => parseProductReleaseObservation(input, game)),
  );
  const observedSurface = evidenceInputs.some(
    ({ value }) => value !== undefined,
  );
  const currentObservations = observations.flatMap(
    ({ products }) => products,
  );
  const observedProductIds = new Set(
    currentObservations.map((product) => product.id),
  );
  const checkedLineages = new Set(
    observedSurface
      ? evidenceInputs.map(({ sourceLineage }) => sourceLineage)
      : [],
  );
  const priorObservations = (prior?.products ?? [])
    .filter((product) => product.game === game)
    .flatMap(sourceObservationsForProduct);
  const preservedObservations = priorObservations.filter(
    ({ evidence }) => !checkedLineages.has(evidence.source),
  );
  const resolvedProducts = resolveObservedProducts(
    [...preservedObservations, ...currentObservations],
    game,
  ).map((product) => ({
    ...product,
    observed: observedProductIds.has(product.id),
  }));
  const resolvedProductIds = new Set(
    resolvedProducts.map((product) => product.id),
  );
  const disappearedProducts = (prior?.products ?? []).filter(
    (product) =>
      observedSurface &&
      product.game === game &&
      !observedProductIds.has(product.id) &&
      sourceObservationsForProduct(product).some(({ evidence }) =>
        checkedLineages.has(evidence.source),
      ),
  );
  const products = uniqueById([
    ...(prior?.products ?? [])
      .filter(
        (product) =>
          product.game !== game ||
          !resolvedProductIds.has(product.id),
      )
      .map((product) => ({
        ...product,
        observed: false,
        source_observations:
          product.game === game && observedSurface
            ? sourceObservationsForProduct(product).filter(
                ({ evidence }) => !checkedLineages.has(evidence.source),
              )
            : product.source_observations,
      })),
    ...resolvedProducts,
  ]);
  const observedProducts = products.filter((product) =>
    observedProductIds.has(product.id),
  );
  const observedContexts = aggregateContexts(
    observations.flatMap(({ distributionContexts }) => distributionContexts),
  );
  const observedContextIds = new Set(
    observedContexts.map((context) => context.id),
  );
  const preservedContexts = (prior?.distribution_contexts ?? []).flatMap(
    (context) => {
      if (context.game !== game || !observedSurface) return [context];
      if (context.source_lineages === undefined) return [context];
      const sourceLineages = (context.source_lineages ?? []).filter(
        (lineage) => !checkedLineages.has(lineage),
      );
      return sourceLineages.length === 0
        ? []
        : [{ ...context, source_lineages: sourceLineages }];
    },
  );
  const distributionContexts = aggregateContexts([
    ...preservedContexts,
    ...observedContexts,
  ]).map((context) => ({
    ...context,
    observed:
      observedContextIds.has(context.id) ||
      (context.source_lineages?.length ?? 0) > 0,
  }));
  const observedRelationships = aggregateRelationships(
    observations.flatMap(({ relationships }) => relationships),
  );
  const observedRelationshipIds = new Set(
    observedRelationships.map((relationship) => relationship.id),
  );
  const relationships = uniqueById([
    ...(prior?.product_relationships ?? [])
      .filter(
        (relationship) =>
          relationship.game !== game ||
          !observedSurface ||
          !checkedLineages.has(relationship.source_lineage) ||
          !observedRelationshipIds.has(relationship.id),
      )
      .map((relationship) => ({
        ...relationship,
        observed:
          relationship.game !== game ||
          !observedSurface ||
          !checkedLineages.has(relationship.source_lineage),
      })),
    ...observedRelationships,
  ]);
  return {
    products,
    observedProducts,
    distribution_contexts: distributionContexts,
    product_relationships: relationships,
    productSurfaceObserved: observedSurface,
    warnings: [
      ...observations.flatMap(({ warnings }) => warnings),
      ...disappearedProducts.map((product) => ({
        code: "product_not_observed",
        product_id: product.id,
        source_lineages: sourceObservationsForProduct(product)
          .map(({ evidence }) => evidence.source)
          .filter((lineage) => checkedLineages.has(lineage))
          .sort(),
        detail:
          "The Product was not observed in this complete run; it remains historical and is not withdrawn.",
      })),
    ],
  };
}

async function parseProductReleaseObservation(
  input: ProductReleaseEvidenceInput,
  game: SupportedGame,
): Promise<ParsedObservation> {
  if (input.value === undefined) {
    return {
      products: [],
      distributionContexts: [],
      relationships: [],
      warnings: [],
    };
  }
  const root = record(input.value, "product_release_catalogue");
  const evidence: ProductEvidenceResource = {
    type: "source_observation",
    id: input.sourceObservationId,
    captured_at: input.capturedAt,
    source: input.sourceLineage,
  };
  const products: ObservedProduct[] = [];
  const productsByReference = new Map<string, ObservedProduct>();
  for (const raw of array(root.products, "product_release_catalogue.products")) {
    const product = record(raw, "Product");
    const reference = productReference(product.reference);
    const officialCode = nullableText(
      product.official_code,
      "Product official_code",
    );
    const name = text(product.name, "Product name");
    assertReferenceFacts(reference, officialCode, name);
    const id = await productIdFor(game, reference);
    const releases = array(product.releases, "Product releases").map(
      (rawRelease) => {
        const release = record(rawRelease, "Release");
        const date = record(release.date, "Release date");
        const precision = releasePrecision(date.precision);
        const value = nullableText(date.value, "Release date value");
        assertDatePrecision(precision, value);
        return {
          region: releaseRegion(release.region),
          precision,
          value,
          status: releaseStatus(release.status),
        };
      },
    );
    const observed: ObservedProduct = {
      reference,
      id,
      officialCode,
      name,
      releases,
      withdrawal: productWithdrawal(product.withdrawal, input),
      evidence,
    };
    products.push(observed);
    productsByReference.set(referenceKey(reference), observed);
  }

  const distributionContexts: CatalogueDistributionContext[] = [];
  const contextsByKey = new Map<string, CatalogueDistributionContext>();
  for (const raw of array(
    root.distribution_contexts,
    "product_release_catalogue.distribution_contexts",
  )) {
    const context = record(raw, "Distribution Context");
    const key = text(context.key, "Distribution Context key");
    const reference = optionalProductReference(context.product_reference);
    const linkedProduct =
      reference === null
        ? null
        : productsByReference.get(referenceKey(reference));
    if (reference !== null && linkedProduct === undefined) {
      throw new Error(
        "A Distribution Context references an unknown typed Product.",
      );
    }
    const parsed: CatalogueDistributionContext = {
      id: await distributionContextIdFor(game, key),
      game,
      key,
      kind: contextKind(context.kind),
      label: text(context.label, "Distribution Context label"),
      product_id: linkedProduct?.id ?? null,
      evidence_category: evidenceCategory(context.evidence_category),
      observed: true,
      source_lineages: [input.sourceLineage],
    };
    distributionContexts.push(parsed);
    contextsByKey.set(key, parsed);
  }

  const relationships: ProductRelationship[] = [];
  const warnings: Record<string, unknown>[] = [];
  for (const raw of array(
    root.relationships,
    "product_release_catalogue.relationships",
  )) {
    const relationship = record(raw, "Product relationship");
    const kind = relationshipKind(relationship.kind);
    const resolution = relationshipResolution(relationship.resolution);
    const reference =
      kind === "printing-product" ||
      kind === "distribution-context-product" ||
      kind === "product-card"
        ? productReference(relationship.product_reference)
        : null;
    if (resolution === "warning") {
      warnings.push({
        code: "product_relationship_unresolved",
        relationship_kind: kind,
        relationship_value:
          reference?.value ??
          optionalText(relationship.context_key) ??
          "unresolved",
        detail:
          "An ambiguous or fuzzy Product relationship remains unresolved and was not made canonical.",
      });
      continue;
    }
    const product =
      reference === null
        ? null
        : productsByReference.get(referenceKey(reference));
    if (reference !== null && product === undefined) {
      throw new Error(
        "A canonical relationship references an unknown typed Product.",
      );
    }
    const contextKey =
      kind === "printing-distribution-context" ||
      kind === "distribution-context-product"
        ? text(relationship.context_key, "relationship context_key")
        : null;
    const context =
      contextKey === null ? null : contextsByKey.get(contextKey);
    if (contextKey !== null && context === undefined) {
      throw new Error(
        "A canonical relationship references an unknown Distribution Context.",
      );
    }
    const endpoints = relationshipEndpoints(
      kind,
      input,
      product?.id ?? null,
      context?.id ?? null,
    );
    const relationshipValue =
      kind === "printing-distribution-context"
        ? contextKey!
        : kind === "product-card"
          ? input.currentCardId
          : reference!.value;
    relationships.push({
      id: await relationshipIdFor(
        game,
        kind,
        endpoints.from,
        endpoints.to,
        input.sourceLineage,
      ),
      game,
      kind,
      ...endpoints,
      evidence_category: evidenceCategory(relationship.evidence_category),
      resolution: "canonical",
      source_lineage: input.sourceLineage,
      source_observation_ids: [input.sourceObservationId],
      relationship_value: relationshipValue,
      observed: true,
    });
  }
  return {
    products,
    distributionContexts,
    relationships,
    warnings,
  };
}

function resolveObservedProducts(
  observations: readonly ObservedProduct[],
  game: SupportedGame,
): CatalogueProduct[] {
  const grouped = new Map<string, ObservedProduct[]>();
  for (const observation of observations) {
    grouped.set(observation.id, [
      ...(grouped.get(observation.id) ?? []),
      observation,
    ]);
  }
  return [...grouped.values()]
    .map((values) => resolveProduct(values, game))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function resolveProduct(
  observations: readonly ObservedProduct[],
  game: SupportedGame,
): CatalogueProduct {
  const first = observations[0]!;
  const included = uniqueById(
    observations.map(({ evidence }) => evidence),
  );
  const provenance: Record<string, string[]> = {};
  const disagreements: ProductDisagreement[] = [];
  const officialCode = resolveFact(
    observations,
    ({ officialCode }) => officialCode,
    "/data/official_code",
    provenance,
    disagreements,
  );
  const name = resolveFact(
    observations,
    (observation) => observation.name,
    "/data/name",
    provenance,
    disagreements,
  );
  const releaseGroups = new Map<
    CatalogueRelease["region"],
    { release: ObservedProduct["releases"][number]; product: ObservedProduct }[]
  >();
  for (const product of observations) {
    for (const release of product.releases) {
      releaseGroups.set(release.region, [
        ...(releaseGroups.get(release.region) ?? []),
        { release, product },
      ]);
    }
  }
  const releases = [...releaseGroups]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([region, values], index) => {
      const factInputs = values.map(({ release, product }) => ({
        ...product,
        release,
      }));
      const precision = resolveFact(
        factInputs,
        ({ release }) => release.precision,
        `/data/releases/${index}/date/precision`,
        provenance,
        disagreements,
      );
      const value = resolveFact(
        factInputs,
        ({ release }) => release.value,
        `/data/releases/${index}/date/value`,
        provenance,
        disagreements,
      );
      const status = resolveFact(
        factInputs,
        ({ release }) => release.status,
        `/data/releases/${index}/status`,
        provenance,
        disagreements,
      );
      return {
        id: releaseIdFor(first.id, region),
        product_id: first.id,
        region,
        date: { precision, value },
        status,
      };
    });
  const withdrawal = [...observations]
    .filter(
      (observation): observation is ObservedProduct & {
        withdrawal: ProductWithdrawal;
      } => observation.withdrawal !== null,
    )
    .sort((left, right) =>
      canonicalJson([
        left.evidence.captured_at,
        left.evidence.id,
      ]).localeCompare(
        canonicalJson([
          right.evidence.captured_at,
          right.evidence.id,
        ]),
      ),
    )
    .at(-1)?.withdrawal ?? null;
  return {
    reference: first.reference,
    id: first.id,
    game,
    official_code: officialCode,
    name,
    releases,
    observed: true,
    withdrawal,
    included,
    provenance,
    disagreements: disagreements.sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
    source_observations: [...observations].sort((left, right) =>
      canonicalJson([
        left.evidence.source,
        left.evidence.id,
      ]).localeCompare(
        canonicalJson([
          right.evidence.source,
          right.evidence.id,
        ]),
      ),
    ),
  };
}

function sourceObservationsForProduct(
  product: CatalogueProduct,
): ProductSourceObservation[] {
  if (product.source_observations !== undefined) {
    return product.source_observations;
  }
  return product.included.map((evidence) => ({
    reference: product.reference,
    id: product.id,
    officialCode: product.official_code,
    name: product.name ?? product.reference.value,
    releases: product.releases.map((release) => ({
      region: release.region,
      precision: release.date.precision ?? "unknown",
      value: release.date.value,
      status: release.status ?? "announced",
    })),
    withdrawal:
      product.withdrawal?.evidence.source_lineage === evidence.source
        ? product.withdrawal
        : null,
    evidence,
  }));
}

function aggregateContexts(
  contexts: readonly CatalogueDistributionContext[],
): CatalogueDistributionContext[] {
  const grouped = new Map<string, CatalogueDistributionContext[]>();
  for (const context of contexts) {
    grouped.set(context.id, [...(grouped.get(context.id) ?? []), context]);
  }
  return [...grouped.values()]
    .map((values) => ({
      ...values.at(-1)!,
      source_lineages: [
        ...new Set(
          values.flatMap(({ source_lineages }) => source_lineages ?? []),
        ),
      ].sort(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function resolveFact<T extends { evidence: ProductEvidenceResource }, V>(
  observations: readonly T[],
  value: (observation: T) => V,
  path: string,
  provenance: Record<string, string[]>,
  disagreements: ProductDisagreement[],
): V | null {
  const candidates = observations.map((observation) => ({
    value: value(observation),
    observation_id: observation.evidence.id,
  }));
  const distinct = new Map(
    candidates.map((candidate) => [canonicalJson(candidate.value), candidate]),
  );
  if (distinct.size === 1) {
    provenance[path] = [
      ...new Set(candidates.map(({ observation_id }) => observation_id)),
    ].sort();
    return candidates[0]!.value;
  }
  disagreements.push({
    path,
    status: "unresolved",
    candidates: [...distinct.values()].sort((left, right) =>
      left.observation_id.localeCompare(right.observation_id),
    ),
  });
  return null;
}

function aggregateRelationships(
  relationships: readonly ProductRelationship[],
): ProductRelationship[] {
  const grouped = new Map<string, ProductRelationship[]>();
  for (const relationship of relationships) {
    grouped.set(relationship.id, [
      ...(grouped.get(relationship.id) ?? []),
      relationship,
    ]);
  }
  return [...grouped.values()]
    .map((values) => ({
      ...values[0]!,
      source_observation_ids: [
        ...new Set(
          values.flatMap(({ source_observation_ids }) => source_observation_ids),
        ),
      ].sort(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function productIdFor(
  game: SupportedGame,
  reference: ProductReference,
): Promise<string> {
  return `product_${await sha256Text(
    canonicalJson({ game, reference }),
  )}`;
}

export async function distributionContextIdFor(
  game: SupportedGame,
  key: string,
): Promise<string> {
  return `distribution_context_${await sha256Text(canonicalJson({ game, key }))}`;
}

function releaseIdFor(
  productId: string,
  region: CatalogueRelease["region"],
): string {
  return `release_${productId}:${region}`;
}

async function relationshipIdFor(
  game: SupportedGame,
  kind: ProductRelationship["kind"],
  from: ProductEntityReference,
  to: ProductEntityReference,
  sourceLineage: string,
): Promise<string> {
  return `relationship_${await sha256Text(
    canonicalJson({ game, kind, from, to, source_lineage: sourceLineage }),
  )}`;
}

function relationshipEndpoints(
  kind: ProductRelationship["kind"],
  input: ProductReleaseEvidenceInput,
  productId: string | null,
  contextId: string | null,
): { from: ProductEntityReference; to: ProductEntityReference } {
  if (kind === "printing-product") {
    if (input.currentPrintingId === null || productId === null) {
      throw new Error(
        "A Printing-to-Product relationship requires both entities.",
      );
    }
    return {
      from: { type: "printing", id: input.currentPrintingId },
      to: { type: "product", id: productId },
    };
  }
  if (kind === "printing-distribution-context") {
    if (input.currentPrintingId === null || contextId === null) {
      throw new Error(
        "A Printing-to-Distribution-Context relationship requires both entities.",
      );
    }
    return {
      from: { type: "printing", id: input.currentPrintingId },
      to: { type: "distribution_context", id: contextId },
    };
  }
  if (kind === "distribution-context-product") {
    if (contextId === null || productId === null) {
      throw new Error(
        "A Distribution-Context-to-Product relationship requires both entities.",
      );
    }
    return {
      from: { type: "distribution_context", id: contextId },
      to: { type: "product", id: productId },
    };
  }
  if (productId === null) {
    throw new Error("A Product-to-Card relationship requires a Product.");
  }
  return {
    from: { type: "product", id: productId },
    to: { type: "card", id: input.currentCardId },
  };
}

function productWithdrawal(
  value: unknown,
  input: ProductReleaseEvidenceInput,
): ProductWithdrawal | null {
  if (value === undefined || value === null) return null;
  const withdrawal = record(value, "Product withdrawal");
  if (withdrawal.state !== "withdrawn") {
    throw new Error("Product withdrawal state is invalid.");
  }
  return {
    evidence: {
      assertion: "withdrawn",
      effective_at: text(
        withdrawal.effective_at,
        "Product withdrawal effective_at",
      ),
      evidence: text(withdrawal.evidence, "Product withdrawal evidence"),
      source_lineage: input.sourceLineage,
      source_snapshot_id: input.sourceSnapshotId,
      source_observation_set_id: input.sourceObservationSetId,
      source_observation_id: input.sourceObservationId,
    },
  };
}

function productReference(value: unknown): ProductReference {
  const reference = record(value, "Product reference");
  if (
    reference.kind !== "official_code" &&
    reference.kind !== "name"
  ) {
    throw new Error("Product reference kind is invalid.");
  }
  return {
    kind: reference.kind,
    value: text(reference.value, "Product reference value"),
  };
}

function optionalProductReference(value: unknown): ProductReference | null {
  return value === undefined || value === null ? null : productReference(value);
}

function referenceKey(reference: ProductReference): string {
  return canonicalJson(reference);
}

function assertReferenceFacts(
  reference: ProductReference,
  officialCode: string | null,
  name: string,
): void {
  if (
    (reference.kind === "official_code" &&
      officialCode !== reference.value) ||
    (reference.kind === "name" &&
      (officialCode !== null || name !== reference.value))
  ) {
    throw new Error("Product reference conflicts with Product facts.");
  }
}

function uniqueById<T extends { id: string }>(values: readonly T[]): T[] {
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

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
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
    throw new Error(
      "Release date value does not match its published precision.",
    );
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

function relationshipResolution(value: unknown): "canonical" | "warning" {
  if (value === "explicit" || value === "deterministic") return "canonical";
  if (value === "ambiguous" || value === "fuzzy") return "warning";
  throw new Error("Product relationship resolution is invalid.");
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
