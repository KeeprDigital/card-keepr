import type { FixtureCandidate } from "./fixture";
import type { NormalizedLifecycle } from "./reconciliation-publication";
import { byteBoundedJsonArrays } from "./reconciliation-payload";
import { canonicalJson } from "./serialization";

export function productReleasePublicationStatements(
  database: D1Database,
  candidate: FixtureCandidate,
  revisionId: string,
  lifecycles: Readonly<Record<string, NormalizedLifecycle>> = {},
): D1PreparedStatement[] {
  const products = candidate.products ?? [];
  const productDocuments = products.map((product) => {
    const productLifecycle =
      lifecycles[canonicalJson([
        product.game,
        product.official_code ?? product.name,
      ])] ?? defaultLifecycle(revisionId);
    return {
      product,
      lifecycle: productLifecycle,
      document: {
        type: "product",
        id: product.id,
        game: product.game,
        official_code: product.official_code,
        name: product.name,
        releases: product.releases.map(
          ({ product_id: _productId, ...release }) => release,
        ),
        lifecycle: productLifecycle,
        links: { self: `/v1/products/${product.id}` },
      },
    };
  });
  return [
    ...statements(
      database,
      productDocuments.map(({ product, lifecycle }) => ({
        ...product,
        first_revision_id: lifecycle.first_revision_id,
        last_observed_revision_id: lifecycle.last_observed_revision_id,
        withdrawn: lifecycle.withdrawn ? 1 : 0,
      })),
      `INSERT INTO reconciled_products (
         id, supported_game, official_code, name, first_revision_id,
         last_observed_revision_id, withdrawn
       )
       SELECT json_extract(value, '$.id'),
              json_extract(value, '$.game'),
              json_extract(value, '$.official_code'),
              json_extract(value, '$.name'),
              json_extract(value, '$.first_revision_id'),
              json_extract(value, '$.last_observed_revision_id'),
              json_extract(value, '$.withdrawn')
       FROM json_each(?) WHERE true
       ON CONFLICT (id) DO UPDATE SET
         name = excluded.name,
         last_observed_revision_id = excluded.last_observed_revision_id,
         withdrawn = excluded.withdrawn`,
    ),
    ...statements(
      database,
      products.flatMap((product) =>
        product.releases.map((release) => ({
          ...release,
          first_revision_id: revisionId,
          last_observed_revision_id: revisionId,
        })),
      ),
      `INSERT INTO reconciled_releases (
         id, product_id, region, date_precision, date_value,
         release_status, first_revision_id, last_observed_revision_id
       )
       SELECT json_extract(value, '$.id'),
              json_extract(value, '$.product_id'),
              json_extract(value, '$.region'),
              json_extract(value, '$.date.precision'),
              json_extract(value, '$.date.value'),
              json_extract(value, '$.status'),
              json_extract(value, '$.first_revision_id'),
              json_extract(value, '$.last_observed_revision_id')
       FROM json_each(?) WHERE true
       ON CONFLICT (id) DO UPDATE SET
         last_observed_revision_id = excluded.last_observed_revision_id`,
    ),
    ...statements(
      database,
      (candidate.distribution_contexts ?? []).map((context) => ({ ...context })),
      `INSERT INTO reconciled_distribution_contexts (
         id, supported_game, context_key, kind, label, product_id,
         evidence_category
       )
       SELECT json_extract(value, '$.id'),
              json_extract(value, '$.game'),
              json_extract(value, '$.key'),
              json_extract(value, '$.kind'),
              json_extract(value, '$.label'),
              json_extract(value, '$.product_id'),
              json_extract(value, '$.evidence_category')
       FROM json_each(?) WHERE true
       ON CONFLICT (id) DO UPDATE SET
         label = excluded.label, kind = excluded.kind,
         product_id = excluded.product_id,
         evidence_category = excluded.evidence_category`,
    ),
    ...byteBoundedJsonArrays(
      productDocuments.map(({ product, document }) => ({
        product_id: product.id,
        document_json: JSON.stringify(document),
      })),
    ).map((chunk) =>
      database
        .prepare(
          `INSERT INTO revision_products (
             catalogue_revision_id, product_id, document_json
           )
           SELECT ?, json_extract(value, '$.product_id'),
                  json_extract(value, '$.document_json')
           FROM json_each(?)`,
        )
        .bind(revisionId, chunk),
    ),
  ];
}

function statements(
  database: D1Database,
  rows: readonly Record<string, unknown>[],
  sql: string,
): D1PreparedStatement[] {
  return byteBoundedJsonArrays(rows).map((chunk) =>
    database.prepare(sql).bind(chunk),
  );
}

function defaultLifecycle(revisionId: string): NormalizedLifecycle {
  return {
    first_revision_id: revisionId,
    last_observed_revision_id: revisionId,
    withdrawn: false,
  };
}
