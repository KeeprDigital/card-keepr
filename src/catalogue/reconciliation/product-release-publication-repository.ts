import { atomicRepositoryStatement, byteBoundedJsonArrays, type CatalogueStore, repositoryStatements } from "../shared";
import {
  retainProductRelationshipEvidenceStatement,
  retainRevisionProductEvidenceStatement,
} from "./evidence-retention-repository";

export function productLifecycleRowsStatement(database: CatalogueStore, idsJson: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT id, first_revision_id, last_observed_revision_id,
                withdrawn, withdrawal_revision_id, withdrawal_evidence_json
         FROM reconciled_products
         WHERE id IN (SELECT value FROM json_each(?))`)
    .bind(idsJson);
}

export function releaseLifecycleRowsStatement(database: CatalogueStore, idsJson: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT id, first_revision_id, last_observed_revision_id
         FROM reconciled_releases
         WHERE id IN (SELECT value FROM json_each(?))`)
    .bind(idsJson);
}

export function productRelationshipLifecycleRowsStatement(
  database: CatalogueStore,
  idsJson: string,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT id, first_revision_id, last_observed_revision_id,
                current, last_missing_revision_id
         FROM reconciled_product_relationships
         WHERE id IN (SELECT value FROM json_each(?))`)
    .bind(idsJson);
}

export function inferredProductLifecycleStatement(
  database: CatalogueStore,
  officialCodesJson: string,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT card.supported_game AS game,
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
                    membership.first_revision_id`)
    .bind(officialCodesJson);
}

export function publishProductLifecyclesStatements(
  database: CatalogueStore,
  rows: readonly Record<string, unknown>[],
): D1PreparedStatement[] {
  return byteBoundedJsonArrays(rows).map((chunk) =>
    repositoryStatements(database)
      .prepare(`INSERT INTO reconciled_products (
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
         withdrawal_evidence_json = excluded.withdrawal_evidence_json`)
      .bind(chunk),
  );
}

export function publishReleaseLifecyclesStatements(
  database: CatalogueStore,
  rows: readonly Record<string, unknown>[],
): D1PreparedStatement[] {
  return byteBoundedJsonArrays(rows).map((chunk) =>
    repositoryStatements(database)
      .prepare(`INSERT INTO reconciled_releases (
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
         last_observed_revision_id = excluded.last_observed_revision_id`)
      .bind(chunk),
  );
}

export function publishDistributionContextsStatements(
  database: CatalogueStore,
  rows: readonly Record<string, unknown>[],
): D1PreparedStatement[] {
  return byteBoundedJsonArrays(rows).map((chunk) =>
    repositoryStatements(database)
      .prepare(`INSERT INTO reconciled_distribution_contexts (
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
         current = excluded.current`)
      .bind(chunk),
  );
}

export function publishProductRelationshipLifecyclesStatements(
  database: CatalogueStore,
  rows: readonly Record<string, unknown>[],
): D1PreparedStatement[] {
  return relationshipChunksWithoutRepeatedIds(rows).map((chunk) =>
    atomicRepositoryStatement(database, {
      after: [retainProductRelationshipEvidenceStatement(database, chunk)],
      statement: repositoryStatements(database)
        .prepare(`INSERT INTO reconciled_product_relationships (
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
         document_json = excluded.document_json`)
        .bind(chunk),
    }),
  );
}

export function publishRevisionProductsStatements(
  database: CatalogueStore,
  rows: readonly Record<string, unknown>[],
  revisionId: string,
): D1PreparedStatement[] {
  return byteBoundedJsonArrays(rows).map((chunk) =>
    atomicRepositoryStatement(database, {
      after: [retainRevisionProductEvidenceStatement(database, { revisionId, payload: chunk })],
      statement: repositoryStatements(database)
        .prepare(`INSERT INTO revision_products (
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
       FROM json_each(?)`)
        .bind(revisionId, chunk),
    }),
  );
}

export function publishProductSearchStatements(
  database: CatalogueStore,
  rows: readonly Record<string, unknown>[],
  revisionId: string,
): D1PreparedStatement[] {
  return byteBoundedJsonArrays(rows).map((chunk) =>
    repositoryStatements(database)
      .prepare(`INSERT INTO revision_products_fts (
         catalogue_revision_id, product_id, search_text
       )
       SELECT ?, json_extract(value, '$.product_id'),
              json_extract(value, '$.search_text')
       FROM json_each(?)`)
      .bind(revisionId, chunk),
  );
}

export function publishRevisionProductRelationshipsStatements(
  database: CatalogueStore,
  rows: readonly Record<string, unknown>[],
  revisionId: string,
): D1PreparedStatement[] {
  return byteBoundedJsonArrays(rows).map((chunk) =>
    repositoryStatements(database)
      .prepare(`INSERT INTO revision_product_relationships (
         catalogue_revision_id, relationship_id, document_json
       )
       SELECT ?, json_extract(value, '$.relationship_id'),
              json_extract(value, '$.document_json')
       FROM json_each(?)`)
      .bind(revisionId, chunk),
  );
}

// A repeated relationship is a later update, not another row in the same
// materialization group. Retain its intermediate evidence before that update.
function relationshipChunksWithoutRepeatedIds(rows: readonly Record<string, unknown>[]): string[] {
  const chunks: string[] = [];
  let group: Record<string, unknown>[] = [];
  const ids = new Set<string>();
  for (const row of rows) {
    const id = String(row.id);
    if (ids.has(id)) {
      chunks.push(...byteBoundedJsonArrays(group));
      group = [];
      ids.clear();
    }
    ids.add(id);
    group.push(row);
  }
  if (group.length > 0 || chunks.length === 0) chunks.push(...byteBoundedJsonArrays(group));
  return chunks;
}
