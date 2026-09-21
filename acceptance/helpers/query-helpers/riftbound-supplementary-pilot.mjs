// Named SQLite statements over restored catalogue databases for the Riftbound
// supplementary-source pilots; the lineage is bound at execution time.
export function supplementaryRetainedProposals(database) {
  return database.prepare(
    "SELECT id, content_json, evidence_json FROM entity_proposals WHERE source_lineage=? ORDER BY id",
  );
}
export function supplementaryEvidenceCounts(database) {
  return database.prepare(`SELECT evidence.proposal_id, COUNT(DISTINCT evidence.source_observation_id) AS observations
    FROM entity_proposal_source_evidence evidence JOIN entity_proposals proposals ON proposals.id=evidence.proposal_id
    WHERE proposals.source_lineage=? GROUP BY evidence.proposal_id ORDER BY evidence.proposal_id`);
}
export function supplementaryDecisions(database) {
  return database.prepare(`SELECT decisions.* FROM entity_admission_decisions decisions JOIN entity_proposals proposals
    ON proposals.id=decisions.proposal_id WHERE proposals.source_lineage=? ORDER BY decisions.proposal_id, decisions.generation`);
}
