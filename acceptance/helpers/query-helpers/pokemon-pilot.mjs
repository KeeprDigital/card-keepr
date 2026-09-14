export function pokemonAdmissionHistory(database) {
  return database.prepare(`SELECT decisions.* FROM entity_admission_decisions decisions
    JOIN entity_proposals proposals ON proposals.id = decisions.proposal_id
    WHERE proposals.game = 'pokemon' ORDER BY decisions.proposal_id, decisions.generation`);
}

export function pokemonRetainedProposals(database) {
  return database.prepare(
    "SELECT id, source_lineage, content_json FROM entity_proposals WHERE game = 'pokemon' ORDER BY id",
  );
}
