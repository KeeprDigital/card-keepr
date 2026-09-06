import { type CatalogueStore, repositoryStatements } from "../shared";
// Named prepared statements; callers retain execution and atomic batch composition.

export function revisionCardDocumentsStatement(database: CatalogueStore, revisionId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT card_id AS id, document_json
         FROM revision_cards
         WHERE catalogue_revision_id = ?`)
    .bind(revisionId);
}

export function revisionPrintingDocumentsStatement(database: CatalogueStore, revisionId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT printing_id AS id, document_json
         FROM revision_printings
         WHERE catalogue_revision_id = ?`)
    .bind(revisionId);
}

export type CandidateObservedEntityRow = { card_id: string; printing_id: string | null };
export type ReconciliationPartitionLineageRow = { source_lineage: string };

export function candidateObservedEntitiesStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT card_id, printing_id
         FROM reconciliation_candidates
         WHERE ingestion_run_id = ?`)
    .bind(runId);
}

export function reconciliationPartitionLineagesStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT DISTINCT source_lineage
         FROM reconciliation_evidence_partitions
         WHERE ingestion_run_id = ?
         ORDER BY source_lineage`)
    .bind(runId);
}

export function currentPrintingLocatorsStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(`SELECT printing_id, source_lineage
         FROM reconciled_printing_locators
         WHERE current = 1
         ORDER BY printing_id, source_lineage, locator`);
}

export function currentCardObservationLineagesStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(`SELECT card_id, source_lineage
         FROM reconciled_card_observations
         WHERE current = 1
         ORDER BY card_id, source_lineage, catalogue_revision_id,
                  source_observation_id`);
}

export function candidateWarningDocumentStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT warnings_json
       FROM reconciliation_candidates
       WHERE ingestion_run_id = ?
       ORDER BY source_observation_id
       LIMIT 1`)
    .bind(runId);
}

export function candidateWarningPartitionStatement(database: CatalogueStore, runId: string, after: number) {
  return repositoryStatements(database)
    .prepare(`SELECT ordinal, content FROM reconciliation_record_partitions
    WHERE ingestion_run_id = ? AND kind = 'warnings' AND ordinal > ? ORDER BY ordinal LIMIT 1`)
    .bind(runId, after);
}
