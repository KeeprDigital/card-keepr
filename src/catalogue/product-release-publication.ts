import type { CatalogueCandidate } from "./catalogue-candidate";
import type { NormalizedLifecycle } from "./publication-lifecycle-types";
import { byteBoundedJsonArrays } from "./reconciliation-payload";

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
  database: D1Database,
  candidate: CatalogueCandidate,
  revisionId: string,
): Promise<ProductReleaseLifecyclePlan> {
  const products = candidate.products ?? [];
  const relationships = candidate.product_relationships ?? [];
  const releases = products.flatMap((product) => product.releases);
  const [
    existingProducts,
    existingReleases,
    existingRelationships,
    inferredProductRows,
  ] =
    await Promise.all([
      rowsById<ExistingProductRow>(
        database,
        `SELECT id, first_revision_id, last_observed_revision_id,
                withdrawn, withdrawal_revision_id, withdrawal_evidence_json
         FROM reconciled_products
         WHERE id IN (SELECT value FROM json_each(?))`,
        products.map(({ id }) => id),
      ),
      rowsById<ExistingReleaseRow>(
        database,
        `SELECT id, first_revision_id, last_observed_revision_id
         FROM reconciled_releases
         WHERE id IN (SELECT value FROM json_each(?))`,
        releases.map(({ id }) => id),
      ),
      rowsById<ExistingRelationshipRow>(
        database,
        `SELECT id, first_revision_id, last_observed_revision_id,
                current, last_missing_revision_id
         FROM reconciled_product_relationships
         WHERE id IN (SELECT value FROM json_each(?))`,
        relationships.map(({ id }) => id),
      ),
      database
        .prepare(
          `SELECT card.supported_game AS game,
                  membership.relationship_value AS official_code,
                  membership.first_revision_id,
                  membership.last_observed_revision_id,
                  last_revision.published_at AS last_published_at
           FROM reconciled_printing_memberships AS membership
           JOIN reconciled_printings AS printing
             ON printing.id = membership.printing_id
           JOIN reconciled_cards AS card ON card.id = printing.card_id
           JOIN catalogue_revisions AS first_revision
             ON first_revision.id = membership.first_revision_id
           JOIN catalogue_revisions AS last_revision
             ON last_revision.id = membership.last_observed_revision_id
           WHERE membership.relationship_kind = 'product'
             AND membership.relationship_value IN (
               SELECT value FROM json_each(?)
             )
           ORDER BY card.supported_game, membership.relationship_value,
                    first_revision.published_at,
                    membership.first_revision_id`,
        )
        .bind(
          JSON.stringify(
            products.flatMap(({ official_code }) =>
              official_code === null ? [] : [official_code],
            ),
          ),
        )
        .all<InferredProductLifecycleRow>(),
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
    const lastOrder = JSON.stringify([
      row.last_published_at,
      row.last_observed_revision_id,
    ]);
    inferredProductLifecycles.set(key, {
      first_revision_id:
        existing?.first_revision_id ?? row.first_revision_id,
      last_observed_revision_id:
        existing === undefined ||
        lastOrder > existing.last_order
          ? row.last_observed_revision_id
          : existing.last_observed_revision_id,
      last_order:
        existing === undefined ||
        lastOrder > existing.last_order
          ? lastOrder
          : existing.last_order,
    });
  }
  const observedGames = new Set(candidate.product_observed_games ?? []);
  const observedLineages = new Set(
    candidate.product_observed_lineages ?? [],
  );
  const observedReleaseIds = new Set(
    products.flatMap((product) => {
      const sourceObservations = product.source_observations ?? [];
      if (
        sourceObservations.length === 0 ||
        observedLineages.size === 0
      ) {
        return product.observed && observedGames.has(product.game)
          ? product.releases.map(({ id }) => id)
          : [];
      }
      const observedEventKeys = new Set(
        sourceObservations
          .filter(({ evidence }) => observedLineages.has(evidence.source))
          .flatMap(({ releases: observed }) =>
            observed.map(({ eventKey }) => eventKey),
          ),
      );
      return product.releases
        .filter(({ event_key }) => observedEventKeys.has(event_key))
        .map(({ id }) => id);
    }),
  );
  const observedProductIds = new Set(
    products.flatMap((product) => {
      if (!product.observed || !observedGames.has(product.game)) return [];
      const sourceObservations = product.source_observations ?? [];
      if (sourceObservations.length === 0) {
        return observedLineages.size === 0 ? [product.id] : [];
      }
      return sourceObservations.some(({ evidence }) =>
          observedLineages.has(evidence.source)
        )
        ? [product.id]
        : [];
    }),
  );
  return {
    products: Object.fromEntries(
      products.map((product) => {
        const existing = existingProducts.get(product.id);
        const inferred =
          product.official_code === null
            ? undefined
            : inferredProductLifecycles.get(
                JSON.stringify([product.game, product.official_code]),
              );
        const withdrawal = product.withdrawal;
        const withdrawn =
          existing?.withdrawn === 1 || withdrawal !== null;
        const withdrawalRevision =
          withdrawal === null
            ? existing?.withdrawal_revision_id ?? null
            : existing?.withdrawal_revision_id ?? revisionId;
        const withdrawalEvidence =
          withdrawal === null
            ? existing?.withdrawal_evidence_json ?? null
            : existing?.withdrawal_evidence_json ??
              JSON.stringify(withdrawal.evidence);
        return [
          product.id,
          {
            first_revision_id:
              existing?.first_revision_id ??
              inferred?.first_revision_id ??
              revisionId,
            last_observed_revision_id: observedProductIds.has(product.id)
              ? revisionId
              : existing?.last_observed_revision_id ??
                inferred?.last_observed_revision_id ??
                revisionId,
            withdrawn,
            withdrawal:
              withdrawalRevision === null ||
              withdrawalEvidence === null
                ? null
                : {
                    revision_id: withdrawalRevision,
                    evidence: JSON.parse(
                      withdrawalEvidence,
                    ) as Record<string, unknown>,
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
            first_revision_id:
              existing?.first_revision_id ?? revisionId,
            last_observed_revision_id: observedReleaseIds.has(release.id)
              ? revisionId
              : existing?.last_observed_revision_id ?? revisionId,
          },
        ];
      }),
    ),
    relationships: Object.fromEntries(
      relationships.map((relationship) => {
        const existing = existingRelationships.get(relationship.id);
        if (relationship.evidence_category === "curated") {
          return [relationship.id, {
            first_revision_id: revisionId,
            last_observed_revision_id: revisionId,
            current: relationship.observed,
            last_missing_revision_id: relationship.observed ? null : revisionId,
          }];
        }
        const lineageObserved =
          observedLineages.size === 0
            ? observedGames.has(relationship.game)
            : relationship.source_lineage !== undefined &&
              observedLineages.has(relationship.source_lineage);
        const disappeared =
          !relationship.observed &&
          observedGames.has(relationship.game) &&
          lineageObserved;
        return [
          relationship.id,
          {
            first_revision_id:
              existing?.first_revision_id ?? revisionId,
            last_observed_revision_id:
              relationship.observed && lineageObserved
              ? revisionId
              : existing?.last_observed_revision_id ?? revisionId,
            current: lineageObserved
              ? relationship.observed
              : disappeared
                ? false
                : existing?.current === 1,
            last_missing_revision_id:
              relationship.observed && lineageObserved
              ? null
              : disappeared
                ? revisionId
                : existing?.last_missing_revision_id ?? null,
          },
        ];
      }),
    ),
  };
}

export function productReleasePublicationStatements(
  database: D1Database,
  candidate: CatalogueCandidate,
  revisionId: string,
  lifecycles: ProductReleaseLifecyclePlan,
): D1PreparedStatement[] {
  const products = candidate.products ?? [];
  const productDocuments = products.map((product) => {
    const lifecycle =
      lifecycles.products[product.id] ?? defaultLifecycle(revisionId);
    const data = {
      type: "product",
      id: product.id,
      game: product.game,
      official_code: product.official_code,
      name: product.name,
      releases: product.releases.map(
        ({ product_id: _productId, ...release }) => release,
      ),
      ...("curated_provenance" in product &&
          Array.isArray(product.curated_provenance)
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
  const relationshipDocuments = (candidate.product_relationships ?? []).map(
    (relationship) => {
      const lifecycle =
        lifecycles.relationships[relationship.id] ??
        defaultRelationshipLifecycle(revisionId, relationship.observed);
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
          ...(relationship.source_lineage === undefined
            ? {}
            : { source_lineage: relationship.source_lineage }),
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
    },
  );
  return [
    ...statements(
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
          lifecycle.withdrawal === null ||
          lifecycle.withdrawal === undefined
            ? null
            : JSON.stringify(lifecycle.withdrawal.evidence),
      })),
      `INSERT INTO reconciled_products (
         id, supported_game, official_code, name, first_revision_id,
         last_observed_revision_id, withdrawn, withdrawal_revision_id,
         withdrawal_evidence_json
       )
       SELECT json_extract(value, '$.id'),
              json_extract(value, '$.game'),
              json_extract(value, '$.official_code'),
              json_extract(value, '$.name'),
              json_extract(value, '$.first_revision_id'),
              json_extract(value, '$.last_observed_revision_id'),
              json_extract(value, '$.withdrawn'),
              json_extract(value, '$.withdrawal_revision_id'),
              json_extract(value, '$.withdrawal_evidence_json')
       FROM json_each(?) WHERE true
       ON CONFLICT (id) DO UPDATE SET
         official_code = excluded.official_code,
         name = excluded.name,
         last_observed_revision_id = excluded.last_observed_revision_id,
         withdrawn = excluded.withdrawn,
         withdrawal_revision_id = excluded.withdrawal_revision_id,
         withdrawal_evidence_json = excluded.withdrawal_evidence_json`,
    ),
    ...statements(
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
      `INSERT INTO reconciled_releases (
         id, product_id, event_key, region, date_precision, date_value,
         release_status, first_revision_id, last_observed_revision_id
       )
       SELECT json_extract(value, '$.id'),
              json_extract(value, '$.product_id'),
              json_extract(value, '$.event_key'),
              json_extract(value, '$.region'),
              json_extract(value, '$.date.precision'),
              json_extract(value, '$.date.value'),
              json_extract(value, '$.status'),
              json_extract(value, '$.first_revision_id'),
              json_extract(value, '$.last_observed_revision_id')
       FROM json_each(?) WHERE true
       ON CONFLICT (id) DO UPDATE SET
         event_key = excluded.event_key,
         region = excluded.region,
         date_precision = excluded.date_precision,
         date_value = excluded.date_value,
         release_status = excluded.release_status,
         last_observed_revision_id = excluded.last_observed_revision_id`,
    ),
    ...statements(
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
      `INSERT INTO reconciled_distribution_contexts (
         id, supported_game, context_key, kind, label, product_id,
         evidence_category, source_lineages_json, current
       )
       SELECT json_extract(value, '$.id'),
              json_extract(value, '$.game'),
              json_extract(value, '$.key'),
              json_extract(value, '$.kind'),
              json_extract(value, '$.label'),
              json_extract(value, '$.product_id'),
              json_extract(value, '$.evidence_category'),
              json_extract(value, '$.source_lineages_json'),
              json_extract(value, '$.current')
       FROM json_each(?) WHERE true
       ON CONFLICT (id) DO UPDATE SET
         label = excluded.label, kind = excluded.kind,
         product_id = excluded.product_id,
         evidence_category = excluded.evidence_category,
         source_lineages_json = excluded.source_lineages_json,
         current = excluded.current`,
    ),
    ...statements(
      database,
      relationshipDocuments.filter(({ relationship }) =>
        relationship.evidence_category !== "curated"
      ).map(({ relationship, lifecycle, document }) => ({
        id: relationship.id,
        game: relationship.game,
        kind: relationship.kind,
        from_type: relationship.from.type,
        from_id: relationship.from.id,
        to_type: relationship.to.type,
        to_id: relationship.to.id,
        evidence_category: relationship.evidence_category,
        source_lineage: relationship.source_lineage,
        source_observation_ids_json: JSON.stringify(
          relationship.source_observation_ids,
        ),
        relationship_value: relationship.relationship_value,
        first_revision_id: lifecycle.first_revision_id,
        last_observed_revision_id: lifecycle.last_observed_revision_id,
        current: lifecycle.current ? 1 : 0,
        last_missing_revision_id: lifecycle.last_missing_revision_id,
        document_json: JSON.stringify(document),
      })),
      `INSERT INTO reconciled_product_relationships (
         id, supported_game, relationship_kind, from_type, from_id,
         to_type, to_id, evidence_category, source_lineage,
         source_observation_ids_json, relationship_value,
         first_revision_id, last_observed_revision_id, current,
         last_missing_revision_id, document_json
       )
       SELECT json_extract(value, '$.id'),
              json_extract(value, '$.game'),
              json_extract(value, '$.kind'),
              json_extract(value, '$.from_type'),
              json_extract(value, '$.from_id'),
              json_extract(value, '$.to_type'),
              json_extract(value, '$.to_id'),
              json_extract(value, '$.evidence_category'),
              json_extract(value, '$.source_lineage'),
              json_extract(value, '$.source_observation_ids_json'),
              json_extract(value, '$.relationship_value'),
              json_extract(value, '$.first_revision_id'),
              json_extract(value, '$.last_observed_revision_id'),
              json_extract(value, '$.current'),
              json_extract(value, '$.last_missing_revision_id'),
              json_extract(value, '$.document_json')
       FROM json_each(?) WHERE true
       ON CONFLICT (id) DO UPDATE SET
         evidence_category = excluded.evidence_category,
         source_observation_ids_json =
           excluded.source_observation_ids_json,
         last_observed_revision_id =
           excluded.last_observed_revision_id,
         current = excluded.current,
         last_missing_revision_id = excluded.last_missing_revision_id,
         document_json = excluded.document_json`,
    ),
    ...statements(
      database,
      productDocuments.map(({ product, envelope }) => ({
        product_id: product.id,
        supported_game: product.game,
        official_code: product.official_code,
        name: product.name,
        search_text: productSearchText(
          product.official_code,
          product.name,
        ),
        release_regions_json: JSON.stringify(
          product.releases.map(({ region }) => region),
        ),
        document_json: JSON.stringify(envelope),
      })),
      `INSERT INTO revision_products (
         catalogue_revision_id, product_id, supported_game,
         official_code, name, search_text, release_regions_json,
         document_json
       )
       SELECT ?, json_extract(value, '$.product_id'),
              json_extract(value, '$.supported_game'),
              json_extract(value, '$.official_code'),
              json_extract(value, '$.name'),
              json_extract(value, '$.search_text'),
              json_extract(value, '$.release_regions_json'),
              json_extract(value, '$.document_json')
       FROM json_each(?)`,
      revisionId,
    ),
    ...statements(
      database,
      productDocuments.map(({ product }) => ({
        product_id: product.id,
        search_text: productSearchText(
          product.official_code,
          product.name,
        ),
      })),
      `INSERT INTO revision_products_fts (
         catalogue_revision_id, product_id, search_text
       )
       SELECT ?, json_extract(value, '$.product_id'),
              json_extract(value, '$.search_text')
       FROM json_each(?)`,
      revisionId,
    ),
    ...statements(
      database,
      relationshipDocuments.map(({ relationship, document }) => ({
        relationship_id: relationship.id,
        document_json: JSON.stringify(document),
      })),
      `INSERT INTO revision_product_relationships (
         catalogue_revision_id, relationship_id, document_json
       )
       SELECT ?, json_extract(value, '$.relationship_id'),
              json_extract(value, '$.document_json')
       FROM json_each(?)`,
      revisionId,
    ),
  ];
}

function productSearchText(
  officialCode: string | null,
  name: string | null,
): string {
  return [officialCode, name]
    .filter((value): value is string => value !== null)
    .join("\n")
    .normalize("NFKC")
    .toLocaleLowerCase("en");
}

async function rowsById<T extends { id: string }>(
  database: D1Database,
  sql: string,
  ids: readonly string[],
): Promise<Map<string, T>> {
  if (ids.length === 0) return new Map();
  const result = await database
    .prepare(sql)
    .bind(JSON.stringify(ids))
    .all<T>();
  return new Map(result.results.map((row) => [row.id, row]));
}

function statements(
  database: D1Database,
  rows: readonly Record<string, unknown>[],
  sql: string,
  prefix?: string,
): D1PreparedStatement[] {
  return byteBoundedJsonArrays(rows).map((chunk) =>
    prefix === undefined
      ? database.prepare(sql).bind(chunk)
      : database.prepare(sql).bind(prefix, chunk),
  );
}

function defaultLifecycle(revisionId: string): NormalizedLifecycle {
  return {
    first_revision_id: revisionId,
    last_observed_revision_id: revisionId,
    withdrawn: false,
    withdrawal: null,
  };
}

function defaultRelationshipLifecycle(
  revisionId: string,
  current: boolean,
): ProductRelationshipLifecycle {
  return {
    first_revision_id: revisionId,
    last_observed_revision_id: revisionId,
    current,
    last_missing_revision_id: null,
  };
}
