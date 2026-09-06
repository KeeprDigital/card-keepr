import {
  type CatalogueStore,
  type CatalogueProduct,
  type CatalogueDistributionContext,
  type ProductRelationship,
  type ProductSourceObservation,
  type SupportedGame,
} from "../shared";
import { ReconciliationCandidateState } from "./reconciliation-candidate-state";
import { canonicalValueChunks } from "./reconciliation-preparation";
import { ReconciliationReducerIndex } from "./reconciliation-reducer-state";
import {
  type ProductReleaseEvidenceInput,
  aggregateContexts,
  aggregateRelationships,
  normalizedProductName,
  parseProductReleaseObservation,
  preservePublishedProductIdentity,
  resolveProduct,
  sourceObservationsForProduct,
} from "./product-release-catalogue";

type ProductGroup = { id: string; observations: ProductSourceObservation[] };

/** Each Product's evidence is reduced separately; source-wide observations are never collected in memory. */
export async function reconcileProductReleaseState(
  database: CatalogueStore,
  runId: string,
  prior: ReconciliationCandidateState,
  inputs: AsyncIterable<ProductReleaseEvidenceInput>,
  game: SupportedGame,
) {
  const result = new ReconciliationCandidateState(database, runId, `product_result_${game}`, prior);
  const index = <T>(name: string, group?: (value: T) => string) =>
    new ReconciliationReducerIndex<T>(database, runId, `${name}_${game}`, group);
  const names = index<CatalogueProduct>("prior_product_names", (product) => normalizedProductName(product.name) ?? "");
  const codes = index<CatalogueProduct>("prior_product_codes", (product) => product.official_code ?? "");
  const priorContexts = index<CatalogueDistributionContext>("prior_product_contexts");
  const priorRelationships = index<ProductRelationship>("prior_product_relationships");
  const groups = index<ProductGroup>("product_observations");
  const contexts = index<CatalogueDistributionContext>("product_contexts");
  const relationships = index<ProductRelationship>("product_relationships");
  for await (const product of prior.values("products")) {
    if (product.game !== game) continue;
    await names.seed(product.id, product);
    await codes.seed(product.id, product);
  }
  names.beginObservation();
  codes.beginObservation();
  for await (const context of prior.values("distribution_contexts")) await priorContexts.seed(context.id, context);
  for await (const relationship of prior.values("product_relationships"))
    await priorRelationships.seed(relationship.id, relationship);
  const checkedLineages = new Set<string>();
  const warnings: Record<string, unknown>[] = [];
  for await (const input of inputs) {
    if (input.value !== undefined) checkedLineages.add(input.sourceLineage);
    const parsed = await parseProductReleaseObservation(input, game);
    // Identity matching needs only candidates with the same normalized name or official code.
    const observation = await preservePublishedProductIdentity(
      parsed,
      async (product) => {
        const matches = new Map<string, CatalogueProduct>();
        const add = async (match: CatalogueProduct) => {
          if (matches.has(match.id)) return;
          await assertProductGroupBudget([...matches.values(), match]);
          matches.set(match.id, match);
        };
        for await (const match of names.matchingBeforeObservation(normalizedProductName(product.name) ?? ""))
          await add(match);
        if (product.officialCode !== null) {
          for await (const match of codes.matchingBeforeObservation(product.officialCode)) await add(match);
        }
        return [...matches.values()];
      },
      game,
    );
    warnings.push(...observation.warnings);
    for (const product of observation.products) {
      const previous = await groups.get(product.id);
      const observations = [...(previous?.observations ?? []), product];
      await assertProductGroupBudget(observations);
      await groups.seed(product.id, { id: product.id, observations });
    }
    for (const context of observation.distributionContexts) {
      const previous = await contexts.get(context.id);
      const merged = aggregateContexts(previous ? [previous, context] : [context])[0]!;
      await contexts.seed(context.id, merged);
    }
    for (const relationship of observation.relationships) {
      const previous = await relationships.get(relationship.id);
      const merged = aggregateRelationships(previous ? [previous, relationship] : [relationship])[0]!;
      await relationships.seed(relationship.id, merged);
    }
  }
  const productSurfaceObserved = checkedLineages.size > 0;
  const observedProducts: { id: string }[] = [];
  for await (const product of prior.values("products")) {
    if (product.game !== game) {
      continue;
    }
    const current = await groups.get(product.id);
    const retained = sourceObservationsForProduct(product);
    const observations = [
      ...retained.filter(({ evidence }) => !checkedLineages.has(evidence.source)),
      ...(current?.observations ?? []),
    ];
    await assertProductGroupBudget(observations);
    const resolved = observations.length > 0 ? resolveProduct(observations, game) : product;
    const productResult = { ...resolved, observed: current !== undefined };
    await result.set("products", productResult);
    if (current) observedProducts.push({ id: productResult.id });
    else if (productSurfaceObserved && retained.some(({ evidence }) => checkedLineages.has(evidence.source))) {
      warnings.push({
        code: "product_not_observed",
        game: product.game,
        product_id: product.id,
        source_lineages: retained
          .map(({ evidence }) => evidence.source)
          .filter((lineage) => checkedLineages.has(lineage))
          .sort(),
        detail: "The Product was not observed in this complete run; it remains historical and is not withdrawn.",
      });
    }
  }
  for await (const group of groups.latestValues()) {
    if (await names.has(group.id)) continue;
    const product = resolveProduct(group.observations, game);
    await result.set("products", product);
    observedProducts.push({ id: product.id });
  }
  for await (const context of prior.values("distribution_contexts")) {
    let preserved = context;
    if (context.game === game && productSurfaceObserved && context.source_lineages !== undefined) {
      const lineages = context.source_lineages.filter((lineage) => !checkedLineages.has(lineage));
      preserved = { ...context, source_lineages: lineages, ...(lineages.length === 0 ? { observed: false } : {}) };
    }
    const current = await contexts.get(context.id);
    const merged = aggregateContexts(current ? [preserved, current] : [preserved])[0]!;
    await result.set("distribution_contexts", {
      ...merged,
      observed: current !== undefined || (merged.source_lineages?.length ?? 0) > 0,
    });
  }
  for await (const context of contexts.latestValues()) {
    if (!(await priorContexts.has(context.id)))
      await result.set("distribution_contexts", { ...context, observed: true });
  }
  for await (const relationship of prior.values("product_relationships")) {
    const current = await relationships.get(relationship.id);
    if (current) {
      await result.set("product_relationships", current);
      continue;
    }
    if (relationship.evidence_category === "curated") {
      await result.delete("product_relationships", relationship.id);
      continue;
    }
    await result.set("product_relationships", {
      ...relationship,
      observed:
        relationship.game === game &&
        productSurfaceObserved &&
        relationship.source_lineage !== undefined &&
        checkedLineages.has(relationship.source_lineage)
          ? false
          : relationship.observed,
    });
  }
  for await (const relationship of relationships.latestValues()) {
    if (!(await priorRelationships.has(relationship.id))) await result.set("product_relationships", relationship);
  }
  const byId = (left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id);
  return {
    draft: result,
    observedProducts: observedProducts.sort(byId),
    productSurfaceObserved,
    warnings,
    checkedLineages: [...checkedLineages],
  };
}

async function assertProductGroupBudget(values: readonly unknown[]): Promise<void> {
  let bytes = 0;
  if (values.length > 500)
    throw new Error("reconciliation_capacity_exceeded: one Product has too many evidence records.");
  for await (const chunk of canonicalValueChunks(values)) {
    bytes += new TextEncoder().encode(chunk).byteLength;
    if (bytes > 1048576) throw new Error("reconciliation_capacity_exceeded: one Product evidence group exceeds 1 MiB.");
  }
}
