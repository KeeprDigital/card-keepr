import { type CatalogueStore, repositoryStatements } from "../shared";

/** The selecting joins prove each retained record resolves to its owning row. */
export function retainCandidateEvidenceStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string; plansJson: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO retained_source_observation_evidence
    (source_observation_id, retained_by_table, retained_record_id)
    SELECT candidate.source_observation_id, 'reconciliation_candidates', candidate.source_observation_set_id
    FROM json_each(?) AS incoming JOIN reconciliation_candidates AS candidate
      ON candidate.ingestion_run_id = ? AND candidate.source_observation_id = json_extract(incoming.value, '$.observation_id')
    WHERE true
      AND NOT EXISTS (SELECT 1 FROM retained_source_observation_evidence AS retained
        WHERE retained.source_observation_id = candidate.source_observation_id)`)
    .bind(input.plansJson, input.runId);
}

export function retainProductRelationshipEvidenceStatement(
  database: CatalogueStore,
  payload: string,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO retained_source_observation_evidence
    (source_observation_id, retained_by_table, retained_record_id)
    SELECT observation.value, 'reconciled_product_relationships', relationship.id
    FROM json_each(?) AS incoming JOIN reconciled_product_relationships AS relationship
      ON relationship.id = json_extract(incoming.value, '$.id'),
      json_each(relationship.source_observation_ids_json) AS observation
    WHERE NOT EXISTS (SELECT 1 FROM retained_source_observation_evidence AS retained
      WHERE retained.source_observation_id = observation.value)
    ON CONFLICT (source_observation_id) DO NOTHING`)
    .bind(payload);
}

export function retainRevisionProductEvidenceStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string; payload: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO retained_source_observation_evidence
    (source_observation_id, retained_by_table, retained_record_id)
    SELECT json_extract(evidence.value, '$.id'), 'revision_products', product.product_id
    FROM json_each(?) AS incoming JOIN revision_products AS product
      ON product.catalogue_revision_id = ? AND product.product_id = json_extract(incoming.value, '$.product_id'),
      json_each(product.document_json, '$.included') AS evidence
    WHERE json_extract(evidence.value, '$.type') = 'source_observation'
      AND json_extract(evidence.value, '$.id') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM retained_source_observation_evidence AS retained
        WHERE retained.source_observation_id = json_extract(evidence.value, '$.id'))
    ON CONFLICT (source_observation_id) DO NOTHING`)
    .bind(input.payload, input.revisionId);
}
