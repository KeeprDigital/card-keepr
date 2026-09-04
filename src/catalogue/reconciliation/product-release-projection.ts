import type {
  CatalogueDistributionContext,
  CatalogueProduct,
  EvidenceCategory,
  ProductRelationship,
} from "./product-release-catalogue";
import type { CuratedProvenance } from "../shared";

export type PrintingProductProjection = {
  id: string;
  official_code: string | null;
  name: string | null;
  evidence_category: EvidenceCategory;
  source_lineage?: string;
  source_observation_ids?: string[];
  curated_provenance?: readonly CuratedProvenance[];
};

export type PrintingDistributionContextProjection = {
  id: string;
  kind: CatalogueDistributionContext["kind"];
  label: string;
  product_id: string | null;
  evidence_category: EvidenceCategory;
  source_lineage?: string;
  source_observation_ids?: string[];
  curated_provenance?: readonly CuratedProvenance[];
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
  const contextsById = new Map(contexts.map((context) => [context.id, context]));
  const curatedAbsences = new Set(
    relationships
      .filter((relationship) => relationship.evidence_category === "curated" && !relationship.observed)
      .map(relationshipTargetKey),
  );
  const current = relationships.filter(
    (relationship) =>
      relationship.observed &&
      !curatedAbsences.has(relationshipTargetKey(relationship)) &&
      relationship.from.type === "printing" &&
      relationship.from.id === printingId,
  );
  const productProjections = current.flatMap((relationship) => {
    if (relationship.kind !== "printing-product" || relationship.to.type !== "product") {
      return [];
    }
    const product = productsById.get(relationship.to.id);
    if (product === undefined) return [];
    return [
      {
        id: product.id,
        official_code: product.official_code,
        name: product.name,
        evidence_category: relationship.evidence_category,
        ...(relationship.source_lineage === undefined ? {} : { source_lineage: relationship.source_lineage }),
        ...(relationship.source_observation_ids.length === 0
          ? {}
          : { source_observation_ids: [...relationship.source_observation_ids] }),
        ...(relationship.curated_provenance === undefined
          ? {}
          : { curated_provenance: relationship.curated_provenance }),
      },
    ];
  });
  const contextProjections = current.flatMap((relationship) => {
    if (relationship.kind !== "printing-distribution-context" || relationship.to.type !== "distribution_context") {
      return [];
    }
    const context = contextsById.get(relationship.to.id);
    if (context === undefined) return [];
    return [
      {
        id: context.id,
        kind: context.kind,
        label: context.label,
        product_id: context.product_id,
        evidence_category: relationship.evidence_category,
        ...(relationship.source_lineage === undefined ? {} : { source_lineage: relationship.source_lineage }),
        ...(relationship.source_observation_ids.length === 0
          ? {}
          : { source_observation_ids: [...relationship.source_observation_ids] }),
        ...(relationship.curated_provenance === undefined
          ? {}
          : { curated_provenance: relationship.curated_provenance }),
      },
    ];
  });
  return {
    products: productProjections.sort(projectionOrder),
    distribution_contexts: contextProjections.sort(projectionOrder),
  };
}

function relationshipTargetKey(relationship: ProductRelationship): string {
  return [
    relationship.kind,
    relationship.from.type,
    relationship.from.id,
    relationship.to.type,
    relationship.to.id,
  ].join("|");
}

function projectionOrder(
  left: { id: string; source_lineage?: string },
  right: { id: string; source_lineage?: string },
): number {
  return left.id.localeCompare(right.id) || (left.source_lineage ?? "").localeCompare(right.source_lineage ?? "");
}
