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
      FROM reconciliation_source_mappings mapping WHERE preparation_id = ?1
      AND (EXISTS (SELECT 1 FROM reconciliation_operations operation WHERE operation.id = mapping.preparation_id AND operation.supported_game = ?2)
        OR EXISTS (SELECT 1 FROM game_candidate_entity_scopes scope WHERE scope.preparation_id = mapping.preparation_id
        AND scope.id = mapping.entity_id AND scope.kind = mapping.entity_kind || 's' AND scope.supported_game = ?2))`;
      break;
    case "admission":
      source = `SELECT proposal.id, json_object('proposal_id', proposal.id,
      'source_lineage', proposal.source_lineage, 'generation', pin.generation, 'action', decision.action,
      'decision', json(decision.decision_json)) AS document_json
      FROM reconciliation_selected_admissions pin JOIN entity_proposals proposal ON proposal.id = pin.proposal_id
      LEFT JOIN entity_admission_decisions decision ON decision.proposal_id = pin.proposal_id AND decision.generation = pin.generation
      WHERE pin.preparation_id = ?1 AND proposal.game = ?2
      UNION ALL SELECT proposal.id, json_object('proposal_id', proposal.id, 'source_lineage', proposal.source_lineage,
        'generation', automatic.generation, 'action', 'admit', 'decision', json(automatic.decision_json), 'rationale', automatic.rationale)
      FROM reconciliation_automatic_admissions automatic JOIN entity_proposals proposal ON proposal.id = automatic.proposal_id
      WHERE automatic.preparation_id = ?1 AND proposal.game = ?2
        AND NOT EXISTS (SELECT 1 FROM reconciliation_selected_admissions selected WHERE selected.preparation_id = ?1 AND selected.proposal_id = automatic.proposal_id)`;
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
      WHERE pin.ingestion_run_id = ?1 AND json_extract(revision.proposal_json, '$.game') = ?2
        AND NOT EXISTS (SELECT 1 FROM reconciliation_operations operation WHERE operation.id = ?1 AND operation.supported_game IS NOT NULL)
      UNION ALL SELECT revision.id, json_object('id', revision.id, 'proposal', json(revision.proposal_json),
        'content_digest', revision.content_digest, 'reviewed_source_digest', COALESCE(
          (SELECT json_extract(event.event_json, '$.reviewed_source_digest') FROM curated_revision_events event
            WHERE event.revision_id = revision.id AND event.kind = 'reaffirmed' AND event.rowid <= pin.event_cutoff ORDER BY event.rowid DESC LIMIT 1), revision.reviewed_source_digest),
        'active', (SELECT event.kind IN ('authored', 'reaffirmed') FROM curated_revision_events event WHERE event.revision_id = revision.id AND event.rowid <= pin.event_cutoff ORDER BY event.rowid DESC LIMIT 1))
      FROM reconciliation_curated_pins pin JOIN curated_revisions revision ON revision.rowid <= pin.revision_cutoff
      WHERE pin.preparation_id = ?1 AND revision.game = ?2`;
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
