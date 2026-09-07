import { AdministrationProblem, repositoryStatements, type CatalogueStore } from "../shared";

export const inspectionEvidenceClasses = ["identity", "admission", "correction", "curated"] as const;
export type InspectionEvidenceClass = (typeof inspectionEvidenceClasses)[number];

export function inspectionEvidenceStatement(
  database: CatalogueStore,
  preparationId: string,
  game: string,
  kind: string,
  after: string,
  count = false,
) {
  let source: string;
  switch (kind) {
    case "identity":
      source = `SELECT json_array(entity_id, source_observation_id) AS id,
      json_object('entity_id', entity_id, 'entity_kind', entity_kind, 'source_lineage', source_lineage,
      'ingestion_run_id', ingestion_run_id, 'source_snapshot_id', source_snapshot_id,
      'source_observation_set_id', source_observation_set_id, 'source_observation_id', source_observation_id,
      'locator', locator, 'variant_key', variant_key, 'evidence', json(evidence_json), 'mapped_at', mapped_at) AS document_json
      FROM reconciliation_source_mappings WHERE preparation_id = ?1`;
      break;
    case "admission":
      source = `SELECT proposal.id, json_object('proposal_id', proposal.id,
      'source_lineage', proposal.source_lineage, 'generation', pin.generation, 'action', decision.action,
      'decision', json(decision.decision_json)) AS document_json
      FROM reconciliation_selected_admissions pin JOIN entity_proposals proposal ON proposal.id = pin.proposal_id
      LEFT JOIN entity_admission_decisions decision ON decision.proposal_id = pin.proposal_id AND decision.generation = pin.generation
      WHERE pin.preparation_id = ?1 AND proposal.game = ?2`;
      break;
    case "correction":
      source = `SELECT decision.id, json_object('id', decision.id, 'sequence', decision.sequence,
      'request', json(decision.request_json), 'reviewed', json(decision.reviewed_json),
      'review_digest', decision.review_digest, 'decided_at', decision.decided_at) AS document_json
      FROM identity_correction_decisions decision JOIN reconciliation_correction_pins pin ON decision.sequence <= pin.decision_cutoff
      WHERE pin.preparation_id = ?1 AND decision.game = ?2`;
      break;
    case "curated":
      source = `SELECT revision.id, json_object('id', revision.id, 'proposal', json(revision.proposal_json),
      'content_digest', revision.content_digest, 'reviewed_source_digest', pin.reviewed_source_digest) AS document_json
      FROM ingestion_run_curated_revisions pin JOIN curated_revision_read revision ON revision.id = pin.revision_id
      WHERE pin.ingestion_run_id = ?1 AND json_extract(revision.proposal_json, '$.supported_game') = ?2`;
      break;
    default:
      throw new AdministrationProblem(422, "invalid_inspection_class", "Use a supported inspection evidence class.");
  }
  return repositoryStatements(database)
    .prepare(`WITH records AS (${source})
    SELECT ${count ? "count(*) AS count" : "id, document_json"} FROM records
    WHERE ?2 IS NOT NULL AND id > ?3 ${count ? "" : "ORDER BY id LIMIT 1"}`)
    .bind(preparationId, game, after);
}
