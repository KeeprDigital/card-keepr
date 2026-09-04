// Named prepared statements; callers retain execution and atomic batch composition.

export function revisionCardDocumentsStatement(database: D1Database, revisionId: string): D1PreparedStatement {
  return database
    .prepare(`SELECT card_id AS id, document_json
         FROM revision_cards
         WHERE catalogue_revision_id = ?`)
    .bind(revisionId);
}

export function revisionPrintingDocumentsStatement(database: D1Database, revisionId: string): D1PreparedStatement {
  return database
    .prepare(`SELECT printing_id AS id, document_json
         FROM revision_printings
         WHERE catalogue_revision_id = ?`)
    .bind(revisionId);
}

export function revisionLegalityDocumentsStatement(database: D1Database, revisionId: string): D1PreparedStatement {
  return database
    .prepare(`SELECT legality_rule_id AS id, document_json
         FROM revision_legality_rules
         WHERE catalogue_revision_id = ?`)
    .bind(revisionId);
}

export function candidateSourceLineagesStatement(database: D1Database, runId: string): D1PreparedStatement {
  return database
    .prepare(`SELECT card_id, printing_id, source_lineage
         FROM reconciliation_candidates
         WHERE ingestion_run_id = ?`)
    .bind(runId);
}

export function reconciliationContextLineageStatement(database: D1Database, runId: string): D1PreparedStatement {
  return database
    .prepare(`SELECT source_lineage
         FROM reconciliation_contexts
         WHERE ingestion_run_id = ?`)
    .bind(runId);
}

export function reconciliationPartitionLineagesStatement(database: D1Database, runId: string): D1PreparedStatement {
  return database
    .prepare(`SELECT DISTINCT source_lineage
         FROM reconciliation_evidence_partitions
         WHERE ingestion_run_id = ?
         ORDER BY source_lineage`)
    .bind(runId);
}

export function currentPrintingLocatorsStatement(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT printing_id, source_lineage
         FROM reconciled_printing_locators
         WHERE current = 1
         ORDER BY printing_id, source_lineage, locator`);
}

export function currentCardObservationLineagesStatement(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT card_id, source_lineage
         FROM reconciled_card_observations
         WHERE current = 1
         ORDER BY card_id, source_lineage, catalogue_revision_id,
                  source_observation_id`);
}

export function candidateWarningDocumentStatement(database: D1Database, runId: string): D1PreparedStatement {
  return database
    .prepare(`SELECT warnings_json
       FROM reconciliation_candidates
       WHERE ingestion_run_id = ?
       ORDER BY source_observation_id
       LIMIT 1`)
    .bind(runId);
}
