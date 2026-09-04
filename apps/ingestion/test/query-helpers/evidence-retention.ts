export async function removeEvidenceRetentionTriggers(database: D1Database): Promise<void> {
  await database.batch([
    database.prepare("DROP TRIGGER IF EXISTS retain_reconciliation_candidate_evidence"),
    database.prepare("DROP TRIGGER IF EXISTS retain_revision_product_evidence"),
    database.prepare("DROP TRIGGER IF EXISTS retain_product_relationship_evidence"),
    database.prepare("DROP TRIGGER IF EXISTS retain_updated_product_relationship_evidence"),
    database.prepare("DROP TRIGGER IF EXISTS retained_source_observation_evidence_must_resolve"),
  ]);
}

export function missingRetainedCandidateEvidence(database: D1Database, runId: string): D1PreparedStatement {
  return database
    .prepare(`SELECT COUNT(*) AS count FROM reconciliation_candidates AS candidate
    WHERE candidate.ingestion_run_id = ? AND NOT EXISTS (
      SELECT 1 FROM retained_source_observation_evidence AS retained WHERE retained.source_observation_id = candidate.source_observation_id
    )`)
    .bind(runId);
}

export function missingRetainedProductEvidence(database: D1Database, revisionId: string): D1PreparedStatement {
  return database
    .prepare(`SELECT COUNT(*) AS count FROM revision_products AS product,
    json_each(product.document_json, '$.included') AS evidence
    WHERE product.catalogue_revision_id = ? AND json_extract(evidence.value, '$.type') = 'source_observation'
      AND NOT EXISTS (SELECT 1 FROM retained_source_observation_evidence AS retained
        WHERE retained.source_observation_id = json_extract(evidence.value, '$.id'))`)
    .bind(revisionId);
}

export function missingRetainedRelationshipEvidence(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT COUNT(*) AS count FROM reconciled_product_relationships AS relationship,
    json_each(relationship.source_observation_ids_json) AS observation
    WHERE NOT EXISTS (SELECT 1 FROM retained_source_observation_evidence AS retained
      WHERE retained.source_observation_id = observation.value)`);
}

export function retainedEvidenceCounts(database: D1Database): D1PreparedStatement {
  return database.prepare(
    `SELECT retained_by_table, COUNT(*) AS count FROM retained_source_observation_evidence GROUP BY retained_by_table ORDER BY retained_by_table`,
  );
}

export function retainedObservation(database: D1Database, observationId: string): D1PreparedStatement {
  return database
    .prepare(
      "SELECT retained_by_table, retained_record_id FROM retained_source_observation_evidence WHERE source_observation_id = ?",
    )
    .bind(observationId);
}

export function relationshipPublicationInput(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT id, supported_game AS game, relationship_kind AS kind, from_type, from_id,
    to_type, to_id, evidence_category, source_lineage, source_observation_ids_json, relationship_value,
    first_revision_id, last_observed_revision_id, current, last_missing_revision_id, document_json
    FROM reconciled_product_relationships LIMIT 1`);
}
