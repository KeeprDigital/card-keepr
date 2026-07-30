import type {
  CatalogueDistributionContext,
  CatalogueProduct,
  EvidenceCategory,
  ProductRelationship,
} from "./product-release-catalogue";

export type PrintingProductProjection = {
  id: string;
  official_code: string | null;
  name: string | null;
  evidence_category: EvidenceCategory;
  source_lineage: string;
  source_observation_ids: string[];
};

export type PrintingDistributionContextProjection = {
  id: string;
  kind: CatalogueDistributionContext["kind"];
  label: string;
  product_id: string | null;
  evidence_category: EvidenceCategory;
  source_lineage: string;
  source_observation_ids: string[];
};

export function typedPrintingProjections(
  printingId: string,
  products: readonly CatalogueProduct[],
  contexts: readonly CatalogueDistributionContext[],
  relationships: readonly ProductRelationship[],
): {
  products: PrintingProductProjection[];
  distribution_contexts: PrintingDistributionContextProjection[];
} {
  const productsById = new Map(products.map((product) => [product.id, product]));
  const contextsById = new Map(
    contexts.map((context) => [context.id, context]),
  );
  const current = relationships.filter(
    (relationship) =>
      relationship.observed &&
      relationship.from.type === "printing" &&
      relationship.from.id === printingId,
  );
  const productProjections = current.flatMap((relationship) => {
    if (
      relationship.kind !== "printing-product" ||
      relationship.to.type !== "product"
    ) {
      return [];
    }
    const product = productsById.get(relationship.to.id);
    if (product === undefined) return [];
    return [{
      id: product.id,
      official_code: product.official_code,
      name: product.name,
      evidence_category: relationship.evidence_category,
      source_lineage: relationship.source_lineage,
      source_observation_ids: [...relationship.source_observation_ids],
    }];
  });
  const contextProjections = current.flatMap((relationship) => {
    if (
      relationship.kind !== "printing-distribution-context" ||
      relationship.to.type !== "distribution_context"
    ) {
      return [];
    }
    const context = contextsById.get(relationship.to.id);
    if (context === undefined) return [];
    return [{
      id: context.id,
      kind: context.kind,
      label: context.label,
      product_id: context.product_id,
      evidence_category: relationship.evidence_category,
      source_lineage: relationship.source_lineage,
      source_observation_ids: [...relationship.source_observation_ids],
    }];
  });
  return {
    products: productProjections.sort(projectionOrder),
    distribution_contexts: contextProjections.sort(projectionOrder),
  };
}

function projectionOrder(
  left: { id: string; source_lineage: string },
  right: { id: string; source_lineage: string },
): number {
  return (
    left.id.localeCompare(right.id) ||
    left.source_lineage.localeCompare(right.source_lineage)
  );
}
