import { type CatalogueStore, repositoryStatements } from "../shared";
// Prepared statements only; callers own execution and atomic batch composition.

export function reconciliationRunStateStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("SELECT state, candidate_digest FROM ingestion_run_current WHERE ingestion_run_id = ?")
    .bind(runId);
}

export function candidateAtRevisionStatement(database: CatalogueStore, revisionId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT run.id AS ingestion_run_id, run.candidate_json
       FROM catalogue_revisions AS revision
       JOIN ingestion_run_read AS run ON run.id = revision.ingestion_run_id
       WHERE revision.id = ?`)
    .bind(revisionId);
}

export function errataProvenanceByIdsStatement(database: CatalogueStore, erratumIdsJson: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT erratum_id, source_lineage, source_observation_id, count(*) OVER () AS total
         FROM erratum_provenance
         WHERE erratum_id IN (SELECT value FROM json_each(?))
         ORDER BY erratum_id, source_lineage, source_observation_id LIMIT 500`)
    .bind(erratumIdsJson);
}

export function currentPrintingMembershipsStatement(
  database: CatalogueStore,
  after: readonly string[],
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`WITH candidates AS (
    SELECT DISTINCT printing_id, source_lineage, relationship_kind, relationship_value
    FROM reconciled_printing_memberships WHERE current = 1
      AND (printing_id, source_lineage, relationship_kind, relationship_value) > (?, ?, ?, ?)
    ORDER BY printing_id, source_lineage, relationship_kind, relationship_value LIMIT 100),
    bounded AS (SELECT *, row_number() OVER (ORDER BY printing_id, source_lineage, relationship_kind, relationship_value) AS ordinal,
      sum(length(CAST(printing_id || source_lineage || relationship_kind || relationship_value AS BLOB)) + 128)
      OVER (ORDER BY printing_id, source_lineage, relationship_kind, relationship_value) AS bytes FROM candidates)
    SELECT printing_id, source_lineage, relationship_kind, relationship_value FROM bounded
    WHERE bytes <= 524288 OR ordinal = 1 ORDER BY printing_id, source_lineage, relationship_kind, relationship_value`)
    .bind(...after);
}

export function currentWithdrawalEvidenceStatement(
  database: CatalogueStore,
  kind: "card" | "printing",
  after: string,
): D1PreparedStatement {
  const table = kind === "card" ? "reconciled_cards" : "reconciled_printings";
  return repositoryStatements(database)
    .prepare(`SELECT id, withdrawal_evidence_json FROM ${table}
    WHERE withdrawal_evidence_json IS NOT NULL AND id > ? ORDER BY id LIMIT 1`)
    .bind(after);
}

export function publishedWithdrawalAssertionsStatement(
  database: CatalogueStore,
  input: Readonly<{ entityType: string; entityId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT assertion, state, effective_at
           FROM reconciled_withdrawal_assertions
           WHERE entity_type = ? AND entity_id = ?
           ORDER BY effective_at DESC, published_catalogue_revision_id, source_observation_id LIMIT 1`)
    .bind(input.entityType, input.entityId);
}

export function activeParsingRunStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT run.id, run.state, run.selected_games_json,
              run.expected_current_revision_id,
              (SELECT ingestion_run_id FROM ingestion_collection_reservations WHERE ingestion_run_id = run.id) AS active_ingestion_run_id,
              operation.recovery_health
       FROM ingestion_run_read AS run
       JOIN operation_state AS operation ON operation.singleton = 1
       WHERE run.id = ?`)
    .bind(runId);
}

export function printingRelationshipsForLineageStatement(
  database: CatalogueStore,
  input: Readonly<{ printingId: string; sourceLineage: string; afterKind: string; afterValue: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT DISTINCT relationship_kind, relationship_value
    FROM reconciled_printing_memberships WHERE printing_id = ? AND source_lineage = ? AND current = 1
      AND (relationship_kind, relationship_value) > (?, ?)
    ORDER BY relationship_kind, relationship_value LIMIT 1`)
    .bind(input.printingId, input.sourceLineage, input.afterKind, input.afterValue);
}

export function disappearedPrintingsStatement(
  database: CatalogueStore,
  input: Readonly<{ sourceLineage: string; observedPrintingIdsJson: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT DISTINCT printing.id
       FROM reconciled_printings AS printing
       JOIN reconciled_printing_locators AS locator
         ON locator.printing_id = printing.id
       WHERE locator.source_lineage = ?
         AND locator.current = 1
         AND NOT EXISTS (
           SELECT 1 FROM json_each(?) AS observed
           WHERE observed.value = printing.id
         )
         AND printing.withdrawn = 0
       ORDER BY printing.id`)
    .bind(input.sourceLineage, input.observedPrintingIdsJson);
}

export function disappearedCardsStatement(
  database: CatalogueStore,
  input: Readonly<{ sourceLineage: string; observedCardIdsJson: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT DISTINCT card.id
       FROM reconciled_cards AS card
       JOIN reconciled_card_observations AS observation
         ON observation.card_id = card.id
       WHERE observation.source_lineage = ?
         AND observation.current = 1
         AND NOT EXISTS (
           SELECT 1 FROM json_each(?) AS observed
           WHERE observed.value = card.id
         )
         AND card.withdrawn = 0
       ORDER BY card.id`)
    .bind(input.sourceLineage, input.observedCardIdsJson);
}

export function reconciledPrintingDocumentStatement(database: CatalogueStore, printingId: string): D1PreparedStatement {
  return repositoryStatements(database).prepare("SELECT * FROM reconciled_printings WHERE id = ?").bind(printingId);
}

export function reconciledPrintingLocatorsStatement(database: CatalogueStore, printingId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT source_lineage, locator, variant_key,
                first_revision_id, last_observed_revision_id,
                current, last_missing_revision_id
         FROM reconciled_printing_locators
         WHERE printing_id = ? ORDER BY locator`)
    .bind(printingId);
}

export function reconciledPrintingRelationshipsStatement(
  database: CatalogueStore,
  printingId: string,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT source_lineage, source_observation_id,
                relationship_kind, relationship_value,
                membership.first_revision_id,
                membership.last_observed_revision_id,
                first_revision.published_at AS first_revision_order,
                last_revision.published_at AS last_observed_revision_order,
                current, last_missing_revision_id
         FROM reconciled_printing_memberships AS membership
         JOIN catalogue_revisions AS first_revision
           ON first_revision.id = membership.first_revision_id
         JOIN catalogue_revisions AS last_revision
           ON last_revision.id = membership.last_observed_revision_id
         WHERE printing_id = ?
         ORDER BY source_lineage, relationship_kind, relationship_value,
                  first_revision.published_at,
                  membership.first_revision_id,
                  last_revision.published_at,
                  membership.last_observed_revision_id,
                  source_observation_id`)
    .bind(printingId);
}
