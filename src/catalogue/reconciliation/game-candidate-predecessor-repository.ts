/** A native preparation carries an immutable evidence predecessor, independent of consumer revision reuse. */
export function gamePredecessorCandidateSql(revision: string, game: string, preparation: string) {
  return `(SELECT CASE
    WHEN ${preparation} IS NULL OR EXISTS(SELECT 1 FROM reconciliation_operations legacy
      WHERE legacy.id=${preparation} AND legacy.supported_game IS NULL)
      THEN (SELECT candidate_id FROM catalogue_composition_games
        WHERE catalogue_revision_id=${revision} AND supported_game=${game})
    WHEN EXISTS(SELECT 1 FROM game_candidates proposed JOIN game_candidate_predecessors pin ON pin.candidate_id=proposed.id
      WHERE proposed.preparation_id=${preparation} AND proposed.id=proposed.preparation_id
      AND proposed.expected_game_revision_id=${revision} AND proposed.supported_game=${game})
      THEN (SELECT pin.predecessor_candidate_id FROM game_candidate_predecessors pin
        JOIN game_candidates proposed ON proposed.id=pin.candidate_id
        WHERE proposed.preparation_id=${preparation} AND proposed.supported_game=${game})
    ELSE json_extract('{}','accepted_predecessor_pin_missing') END)`;
}
