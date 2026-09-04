import { type CatalogueStore, repositoryStatements } from "../shared";
// Prepared statements only; callers own execution and atomic batch composition.

export function exportCollectionStatement(
  database: CatalogueStore,
  input: Readonly<{
    revisionId: string;
    afterPublishedAt: string | null;
    afterPublishedValue: string;
    afterRevisionId: string;
    rowLimit: number;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`WITH RECURSIVE pinned_revision(id) AS (
         SELECT ?
         UNION ALL
         SELECT revision.expected_previous_revision_id
         FROM catalogue_revisions AS revision
         JOIN pinned_revision ON revision.id = pinned_revision.id
       )
       SELECT export.catalogue_revision_id, revision.published_at,
              export.manifest_key, export.manifest_digest,
              export.maintenance_state
       FROM catalogue_exports AS export
       JOIN catalogue_revisions AS revision
         ON revision.id = export.catalogue_revision_id
       JOIN pinned_revision AS pinned
         ON pinned.id = export.catalogue_revision_id
       WHERE export.verified = 1
         AND export.maintenance_state = 'available'
         AND (
           ? IS NULL OR revision.published_at < ? OR (
             revision.published_at = ? AND
             export.catalogue_revision_id < ?
           )
         )
       ORDER BY revision.published_at DESC,
                export.catalogue_revision_id DESC
       LIMIT ?`)
    .bind(
      input.revisionId,
      input.afterPublishedAt,
      input.afterPublishedValue,
      input.afterPublishedValue,
      input.afterRevisionId,
      input.rowLimit,
    );
}

export function catalogueStatusStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(
    "SELECT current_revision_id, published_at FROM catalogue_state WHERE singleton = 1",
  );
}

export function catalogueFreshnessStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(`SELECT game, area, source_lineage, region, checked_at
         FROM source_freshness
         ORDER BY game, area, source_lineage, region`);
}

export function currentCardStatement(database: CatalogueStore, cardId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT
        card.document_json,
        catalogue.current_revision_id,
        catalogue.published_at
      FROM catalogue_state AS catalogue
      JOIN revision_cards AS card
        ON card.catalogue_revision_id = catalogue.current_revision_id
      WHERE catalogue.singleton = 1 AND card.card_id = ?`)
    .bind(cardId);
}

export function cardPrintingsStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string; cardId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT document_json
           FROM revision_printings
           WHERE catalogue_revision_id = ? AND card_id = ?
           ORDER BY printing_id`)
    .bind(input.revisionId, input.cardId);
}

export function currentPrintingStatement(database: CatalogueStore, printingId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT
        printing.document_json,
        catalogue.current_revision_id,
        catalogue.published_at
      FROM catalogue_state AS catalogue
      JOIN revision_printings AS printing
        ON printing.catalogue_revision_id = catalogue.current_revision_id
      WHERE catalogue.singleton = 1 AND printing.printing_id = ?`)
    .bind(printingId);
}

export function printingImageStatement(database: CatalogueStore, imageId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT
         image.media_type,
         image.content_sha256,
         image.content_byte_length,
         image.object_key,
         catalogue.current_revision_id
       FROM catalogue_state AS catalogue
       JOIN revision_printing_images AS image
         ON image.catalogue_revision_id = catalogue.current_revision_id
       JOIN revision_printings AS printing
         ON printing.catalogue_revision_id = catalogue.current_revision_id
        AND printing.printing_id = image.printing_id
       WHERE catalogue.singleton = 1 AND image.image_id = ?`)
    .bind(imageId);
}

export function pendingExportComponentDeletionStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string; componentName: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT 1 AS present
       FROM catalogue_exports AS export
       JOIN catalogue_export_deletions AS deletion
         ON deletion.id = export.deletion_operation_id
       JOIN catalogue_export_deletion_plans AS plan
         ON plan.id = deletion.plan_id
       JOIN json_each(plan.component_names_json) AS component
       WHERE export.catalogue_revision_id = ? AND component.value = ?`)
    .bind(input.revisionId, input.componentName);
}

export function catalogueExportStatement(database: CatalogueStore, revisionId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT
        export.catalogue_revision_id,
        revision.published_at,
        export.manifest_key,
        export.manifest_digest,
        export.maintenance_state
      FROM catalogue_exports AS export
      JOIN catalogue_revisions AS revision
        ON revision.id = export.catalogue_revision_id
      WHERE export.catalogue_revision_id = ? AND export.verified = 1`)
    .bind(revisionId);
}

export function currentProductStatement(database: CatalogueStore, productId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT product.document_json, catalogue.current_revision_id,
              catalogue.published_at
       FROM catalogue_state AS catalogue
       JOIN revision_products AS product
         ON product.catalogue_revision_id = catalogue.current_revision_id
       WHERE catalogue.singleton = 1 AND product.product_id = ?`)
    .bind(productId);
}

export function productCuratedEvidenceStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string; revisionIdsJson: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT curated_revision_id AS id,
              json_extract(provenance_json, '$.created_at') AS created_at,
              json_extract(provenance_json, '$.author') AS author
       FROM catalogue_curated_provenance
       WHERE catalogue_revision_id = ?
         AND curated_revision_id IN (SELECT value FROM json_each(?))`)
    .bind(input.revisionId, input.revisionIdsJson);
}

export function productCollectionStatement(
  database: CatalogueStore,
  input: Readonly<{
    revisionId: string;
    game: string | null;
    query: string | null;
    fts: string | null;
    region: string | null;
    hasAfter: number;
    afterGame: string;
    afterCodeNull: number;
    afterCode: string;
    afterNameNull: number;
    afterName: string;
    afterId: string;
    rowLimit: number;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT document_json
       FROM revision_products
       WHERE catalogue_revision_id = ?
         AND (? IS NULL OR supported_game = ?)
         AND (
           ? IS NULL OR product_id IN (
             SELECT product_id
             FROM revision_products_fts
             WHERE catalogue_revision_id = ?
               AND search_text MATCH ?
           )
         )
         AND (
           ? IS NULL OR EXISTS (
             SELECT 1 FROM json_each(release_regions_json)
             WHERE value = ?
           )
         )
         AND (
           ? = 0 OR (
             supported_game,
             official_code IS NULL,
             coalesce(official_code, ''),
             name IS NULL,
             coalesce(name, ''),
             product_id
           ) > (?, ?, ?, ?, ?, ?)
         )
       ORDER BY supported_game,
                official_code IS NULL,
                official_code,
                name IS NULL,
                name,
                product_id
       LIMIT ?`)
    .bind(
      input.revisionId,
      input.game,
      input.game,
      input.query,
      input.revisionId,
      input.fts,
      input.region,
      input.region,
      input.hasAfter,
      input.afterGame,
      input.afterCodeNull,
      input.afterCode,
      input.afterNameNull,
      input.afterName,
      input.afterId,
      input.rowLimit,
    );
}

export function legalityCardStatement(
  database: CatalogueStore,
  input: Readonly<{ cardId: string; revisionId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT catalogue.id AS current_revision_id, catalogue.published_at,
              card.document_json
       FROM catalogue_revisions AS catalogue
       JOIN revision_cards AS card
         ON card.catalogue_revision_id = catalogue.id
       WHERE card.card_id = ? AND catalogue.id = ?`)
    .bind(input.cardId, input.revisionId);
}

export function applicableLegalityRulesStatement(
  database: CatalogueStore,
  input: Readonly<{
    revisionId: string;
    cardId: string;
    regionsJson: string;
    game: string;
    format: string;
    onDate: string;
    eventTier: string | null;
    rowLimit: number;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`WITH applicable AS (
         SELECT legality_rule_id
         FROM revision_legality_rule_applicability
         WHERE catalogue_revision_id = ?
           AND applicability_kind = 'card'
           AND card_id = ?
         -- UNION deduplicates a target-scope rule that applies through both
         -- its enumerated Card row and its explicit all_cards row.
         UNION
         SELECT legality_rule_id
         FROM revision_legality_rule_applicability
         WHERE catalogue_revision_id = ?
           AND applicability_kind = 'all_cards'
           AND card_id = ''
       )
       SELECT rule.document_json, rule.source_retrieved_at
       FROM applicable
       JOIN revision_legality_rules AS rule
         ON rule.catalogue_revision_id = ?
        AND rule.legality_rule_id = applicable.legality_rule_id
       WHERE rule.region IN (SELECT value FROM json_each(?))
         AND rule.supported_game = ?
         AND rule.format = ?
         AND NOT (
           json_type(rule.document_json, '$.current') = 'false'
           AND json_type(rule.document_json, '$.first_revision_id') = 'text'
           AND json_type(rule.document_json, '$.last_observed_revision_id') = 'text'
           AND json_type(rule.document_json, '$.last_missing_revision_id') = 'text'
         )
         AND (
           (
             rule.effective_from <= ?
             AND (rule.effective_until IS NULL OR ? < rule.effective_until)
           )
           OR EXISTS (
             SELECT 1
             FROM json_each(rule.unresolved_scope_json, '$.dimensions')
             WHERE value = 'effective_interval'
           )
         )
         AND (
           rule.event_tier IS NULL OR rule.event_tier = ?
           OR EXISTS (
             SELECT 1
             FROM json_each(rule.unresolved_scope_json, '$.dimensions')
             WHERE value = 'event_tier'
           )
         )
       ORDER BY rule.region, rule.legality_rule_id
       LIMIT ?`)
    .bind(
      input.revisionId,
      input.cardId,
      input.revisionId,
      input.revisionId,
      input.regionsJson,
      input.game,
      input.format,
      input.onDate,
      input.onDate,
      input.eventTier,
      input.rowLimit,
    );
}

export type CatalogueStateRow = {
  current_revision_id: string;
  published_at: string;
};

export type RevisionDocumentRow = CatalogueStateRow & {
  document_json: string;
};

export type PrintingDocumentRow = {
  document_json: string;
};

export type PrintingImageRow = {
  media_type: string;
  content_sha256: string;
  content_byte_length: number;
  object_key: string;
  current_revision_id: string;
};

export type ExportRow = {
  catalogue_revision_id: string;
  published_at: string;
  manifest_key: string;
  manifest_digest: string;
  maintenance_state: "available" | "deleting" | "deleted";
};

export type ProductRow = {
  document_json: string;
  current_revision_id: string;
  published_at: string;
};

export type ContextRow = {
  current_revision_id: string;
  published_at: string;
  document_json: string;
};

export type RuleRow = {
  document_json: string;
  // The Source Snapshot retrieval instant the publication projected for the
  // rule's Source Observation (issue #98); NULL only on a row published
  // before migration 0004 whose snapshot had already gone.
  source_retrieved_at: string | null;
};
