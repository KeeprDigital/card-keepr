import type { CatalogueCandidate, CatalogueStore } from "../shared";
import {
  inferredProductLifecycleStatement,
  productLifecycleRowsStatement,
  productRelationshipLifecycleRowsStatement,
  publishDistributionContextsStatements,
  publishProductLifecyclesStatements,
  publishProductRelationshipLifecyclesStatements,
  publishProductSearchStatements,
  publishReleaseLifecyclesStatements,
  publishRevisionProductRelationshipsStatements,
  publishRevisionProductsStatements,
  releaseLifecycleRowsStatement,
} from "./product-release-publication-repository";
import type { NormalizedLifecycle } from "./publication-lifecycle-types";

export type ProductRelationshipLifecycle = {
  first_revision_id: string;
  last_observed_revision_id: string;
  current: boolean;
  last_missing_revision_id: string | null;
};

export type ProductReleaseLifecyclePlan = {
  products: Record<string, NormalizedLifecycle>;
  releases: Record<
    string,
    {
      first_revision_id: string;
      last_observed_revision_id: string;
    }
  >;
  relationships: Record<string, ProductRelationshipLifecycle>;
};

type ExistingProductRow = {
  id: string;
  first_revision_id: string;
  last_observed_revision_id: string;
  withdrawn: number;
  withdrawal_revision_id: string | null;
  withdrawal_evidence_json: string | null;
};

type ExistingRelationshipRow = {
  id: string;
  first_revision_id: string;
  last_observed_revision_id: string;
  current: number;
  last_missing_revision_id: string | null;
};

type ExistingReleaseRow = {
  id: string;
  first_revision_id: string;
  last_observed_revision_id: string;
};

type InferredProductLifecycleRow = {
  game: string;
  official_code: string;
  first_revision_id: string;
  last_observed_revision_id: string;
  last_published_at: string;
};

export async function productReleaseLifecyclePlan(
  database: CatalogueStore,
  candidate: CatalogueCandidate,
  revisionId: string,
): Promise<ProductReleaseLifecyclePlan> {
  const products = candidate.products ?? [];
  const relationships = candidate.product_relationships ?? [];
  const releases = products.flatMap((product) => product.releases);
  const [existingProducts, existingReleases, existingRelationships, inferredProductRows] = await Promise.all([
    rowsById<ExistingProductRow>(
      database,
      productLifecycleRowsStatement,
      products.map(({ id }) => id),
    ),
    rowsById<ExistingReleaseRow>(
      database,
      releaseLifecycleRowsStatement,
      releases.map(({ id }) => id),
    ),
    rowsById<ExistingRelationshipRow>(
      database,
      productRelationshipLifecycleRowsStatement,
      relationships.map(({ id }) => id),
    ),
    inferredProductLifecycleStatement(
      database,
      JSON.stringify(products.flatMap(({ official_code }) => (official_code === null ? [] : [official_code]))),
    ).all<InferredProductLifecycleRow>(),
  ]);
  const inferredProductLifecycles = new Map<
    string,
    {
      first_revision_id: string;
      last_observed_revision_id: string;
      last_order: string;
    }
  >();
  for (const row of inferredProductRows.results) {
    const key = JSON.stringify([row.game, row.official_code]);
    const existing = inferredProductLifecycles.get(key);
    const lastOrder = JSON.stringify([row.last_published_at, row.last_observed_revision_id]);
    inferredProductLifecycles.set(key, {
      first_revision_id: existing?.first_revision_id ?? row.first_revision_id,
      last_observed_revision_id:
        existing === undefined || lastOrder > existing.last_order
          ? row.last_observed_revision_id
          : existing.last_observed_revision_id,
      last_order: existing === undefined || lastOrder > existing.last_order ? lastOrder : existing.last_order,
    });
  }
  const observedGames = new Set(candidate.product_observed_games ?? []);
  const observedLineages = new Set(candidate.product_observed_lineages ?? []);
  const observedReleaseIds = new Set(
    products.flatMap((product) => {
      const sourceObservations = product.source_observations ?? [];
      if (sourceObservations.length === 0 || observedLineages.size === 0) {
        return product.observed && observedGames.has(product.game) ? product.releases.map(({ id }) => id) : [];
      }
      const observedEventKeys = new Set(
        sourceObservations
          .filter(({ evidence }) => observedLineages.has(evidence.source))
          .flatMap(({ releases: observed }) => observed.map(({ eventKey }) => eventKey)),
      );
      return product.releases.filter(({ event_key }) => observedEventKeys.has(event_key)).map(({ id }) => id);
    }),
  );
  const observedProductIds = new Set(
    products.flatMap((product) => {
      if (!product.observed || !observedGames.has(product.game)) return [];
      const sourceObservations = product.source_observations ?? [];
      if (sourceObservations.length === 0) {
        return observedLineages.size === 0 ? [product.id] : [];
      }
      return sourceObservations.some(({ evidence }) => observedLineages.has(evidence.source)) ? [product.id] : [];
    }),
  );
  return {
    products: Object.fromEntries(
      products.map((product) => {
        const existing = existingProducts.get(product.id);
        const inferred =
          product.official_code === null
            ? undefined
            : inferredProductLifecycles.get(JSON.stringify([product.game, product.official_code]));
        const withdrawal = product.withdrawal;
        const withdrawn = existing?.withdrawn === 1 || withdrawal !== null;
        const withdrawalRevision =
          withdrawal === null
            ? (existing?.withdrawal_revision_id ?? null)
            : (existing?.withdrawal_revision_id ?? revisionId);
        const withdrawalEvidence =
          withdrawal === null
            ? (existing?.withdrawal_evidence_json ?? null)
            : (existing?.withdrawal_evidence_json ?? JSON.stringify(withdrawal.evidence));
        return [
          product.id,
          {
            first_revision_id: existing?.first_revision_id ?? inferred?.first_revision_id ?? revisionId,
            last_observed_revision_id: observedProductIds.has(product.id)
              ? revisionId
              : (existing?.last_observed_revision_id ?? inferred?.last_observed_revision_id ?? revisionId),
            withdrawn,
            withdrawal:
              withdrawalRevision === null || withdrawalEvidence === null
                ? null
                : {
                    revision_id: withdrawalRevision,
                    evidence: JSON.parse(withdrawalEvidence) as Record<string, unknown>,
                  },
          },
        ];
      }),
    ),
    releases: Object.fromEntries(
      releases.map((release) => {
        const existing = existingReleases.get(release.id);
        return [
          release.id,
          {
            first_revision_id: existing?.first_revision_id ?? revisionId,
            last_observed_revision_id: observedReleaseIds.has(release.id)
              ? revisionId
              : (existing?.last_observed_revision_id ?? revisionId),
          },
        ];
      }),
    ),
    relationships: Object.fromEntries(
      relationships.map((relationship) => {
        const existing = existingRelationships.get(relationship.id);
        if (relationship.evidence_category === "curated") {
          return [
            relationship.id,
            {
              first_revision_id: revisionId,
              last_observed_revision_id: revisionId,
              current: relationship.observed,
              last_missing_revision_id: relationship.observed ? null : revisionId,
            },
          ];
        }
        const lineageObserved =
          observedLineages.size === 0
            ? observedGames.has(relationship.game)
            : relationship.source_lineage !== undefined && observedLineages.has(relationship.source_lineage);
        const disappeared = !relationship.observed && observedGames.has(relationship.game) && lineageObserved;
        return [
          relationship.id,
          {
            first_revision_id: existing?.first_revision_id ?? revisionId,
            last_observed_revision_id:
              relationship.observed && lineageObserved
                ? revisionId
                : (existing?.last_observed_revision_id ?? revisionId),
            current: lineageObserved ? relationship.observed : disappeared ? false : existing?.current === 1,
            last_missing_revision_id:
              relationship.observed && lineageObserved
                ? null
                : disappeared
                  ? revisionId
                  : (existing?.last_missing_revision_id ?? null),
          },
        ];
      }),
    ),
  };
}

export function productReleasePublicationStatements(
  database: CatalogueStore,
  candidate: CatalogueCandidate,
  revisionId: string,
  lifecycles: ProductReleaseLifecyclePlan,
): D1PreparedStatement[] {
  const products = candidate.products ?? [];
  const productDocuments = products.map((product) => {
    const lifecycle = lifecycles.products[product.id] ?? defaultLifecycle(revisionId);
    const data = {
      type: "product",
      id: product.id,
      game: product.game,
      official_code: product.official_code,
      name: product.name,
      releases: product.releases.map(({ product_id: _productId, ...release }) => release),
      ...("curated_provenance" in product && Array.isArray(product.curated_provenance)
        ? { curated_provenance: product.curated_provenance }
        : {}),
      lifecycle,
      links: { self: `/v1/products/${product.id}` },
    };
    return {
      product,
      lifecycle,
      envelope: {
        data,
        included: product.included,
        provenance: product.provenance,
        disagreements: product.disagreements,
      },
    };
  });
  const relationshipDocuments = (candidate.product_relationships ?? []).map((relationship) => {
    const lifecycle =
      lifecycles.relationships[relationship.id] ?? defaultRelationshipLifecycle(revisionId, relationship.observed);
    return {
      relationship,
      lifecycle,
      document: {
        type: "relationship",
        id: relationship.id,
        kind: relationship.kind,
        from: relationship.from,
        to: relationship.to,
        evidence_category: relationship.evidence_category,
        ...(relationship.source_lineage === undefined ? {} : { source_lineage: relationship.source_lineage }),
        ...(relationship.source_observation_ids.length === 0
          ? {}
          : { source_observation_ids: relationship.source_observation_ids }),
        ...(relationship.curated_provenance === undefined
          ? {}
          : { curated_provenance: relationship.curated_provenance }),
        relationship_value: relationship.relationship_value,
        lifecycle,
      },
    };
  });
  return [
    ...publishProductLifecyclesStatements(
      database,
      productDocuments.map(({ product, lifecycle }) => ({
        id: product.id,
        game: product.game,
        official_code: product.official_code,
        name: product.name,
        first_revision_id: lifecycle.first_revision_id,
        last_observed_revision_id: lifecycle.last_observed_revision_id,
        withdrawn: lifecycle.withdrawn ? 1 : 0,
        withdrawal_revision_id: lifecycle.withdrawal?.revision_id ?? null,
        withdrawal_evidence_json:
          lifecycle.withdrawal === null || lifecycle.withdrawal === undefined
            ? null
            : JSON.stringify(lifecycle.withdrawal.evidence),
      })),
    ),
    ...publishReleaseLifecyclesStatements(
      database,
      products.flatMap((product) =>
        product.releases.map((release) => {
          const lifecycle = lifecycles.releases[release.id] ?? {
            first_revision_id: revisionId,
            last_observed_revision_id: revisionId,
          };
          return {
            ...release,
            ...lifecycle,
          };
        }),
      ),
    ),
    ...publishDistributionContextsStatements(
      database,
      (candidate.distribution_contexts ?? []).map((context) => {
        const { curated_provenance: provenance, ...facts } = context;
        return {
          ...facts,
          ...(Array.isArray(provenance) ? { curated_provenance: provenance } : {}),
          source_lineages_json: JSON.stringify(context.source_lineages ?? []),
          current: context.observed ? 1 : 0,
        };
      }),
    ),
    ...publishProductRelationshipLifecyclesStatements(
      database,
      relationshipDocuments
        .filter(({ relationship }) => relationship.evidence_category !== "curated")
        .map(({ relationship, lifecycle, document }) => ({
          id: relationship.id,
          game: relationship.game,
          kind: relationship.kind,
          from_type: relationship.from.type,
          from_id: relationship.from.id,
          to_type: relationship.to.type,
          to_id: relationship.to.id,
          evidence_category: relationship.evidence_category,
          source_lineage: relationship.source_lineage,
          source_observation_ids_json: JSON.stringify(relationship.source_observation_ids),
          relationship_value: relationship.relationship_value,
          first_revision_id: lifecycle.first_revision_id,
          last_observed_revision_id: lifecycle.last_observed_revision_id,
          current: lifecycle.current ? 1 : 0,
          last_missing_revision_id: lifecycle.last_missing_revision_id,
          document_json: JSON.stringify(document),
        })),
    ),
    ...publishRevisionProductsStatements(
      database,
      productDocuments.map(({ product, envelope }) => ({
        product_id: product.id,
        supported_game: product.game,
        official_code: product.official_code,
        name: product.name,
        search_text: productSearchText(product.official_code, product.name),
        release_regions_json: JSON.stringify(product.releases.map(({ region }) => region)),
        document_json: JSON.stringify(envelope),
      })),
      revisionId,
    ),
    ...publishProductSearchStatements(
      database,
      productDocuments.map(({ product }) => ({
        product_id: product.id,
        search_text: productSearchText(product.official_code, product.name),
      })),
      revisionId,
    ),
    ...publishRevisionProductRelationshipsStatements(
      database,
      relationshipDocuments.map(({ relationship, document }) => ({
        relationship_id: relationship.id,
        document_json: JSON.stringify(document),
      })),
      revisionId,
    ),
  ];
}

function productSearchText(officialCode: string | null, name: string | null): string {
  return [officialCode, name]
    .filter((value): value is string => value !== null)
    .join("\n")
    .normalize("NFKC")
    .toLocaleLowerCase("en");
}

async function rowsById<T extends { id: string }>(
  database: CatalogueStore,
  statement: (database: CatalogueStore, idsJson: string) => D1PreparedStatement,
  ids: readonly string[],
): Promise<Map<string, T>> {
  if (ids.length === 0) return new Map();
  const result = await statement(database, JSON.stringify(ids)).all<T>();
  return new Map(result.results.map((row) => [row.id, row]));
}

function defaultLifecycle(revisionId: string): NormalizedLifecycle {
  return {
    first_revision_id: revisionId,
    last_observed_revision_id: revisionId,
    withdrawn: false,
    withdrawal: null,
  };
}

function defaultRelationshipLifecycle(revisionId: string, current: boolean): ProductRelationshipLifecycle {
  return {
    first_revision_id: revisionId,
    last_observed_revision_id: revisionId,
    current,
    last_missing_revision_id: null,
  };
}
