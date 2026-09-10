import { type CatalogueStore, repositoryStatements } from "../shared";

export type SourceHistoryCandidate = {
  id: string;
  preparation_id: string;
  supported_game: string;
  expected_game_revision_id: string;
  pin_id: string | null;
  predecessor_candidate_id: string | null;
  catalogue_revision_id: string | null;
};
export function sourceHistoryCandidateStatement(db: CatalogueStore, candidateId: string) {
  return repositoryStatements(db)
    .prepare(`SELECT c.id,c.preparation_id,c.supported_game,c.expected_game_revision_id,
    pin.candidate_id AS pin_id,pin.predecessor_candidate_id,published.catalogue_revision_id
    FROM game_candidates c LEFT JOIN game_candidate_predecessors pin ON pin.candidate_id=c.id
    LEFT JOIN catalogue_candidate_publications published ON published.candidate_id=c.id
    WHERE c.id=?`)
    .bind(candidateId);
}

/** The singleton legacy publication state is only a boundary; native history never falls back to it. */
export function legacySourceHistoryStatement(
  db: CatalogueStore,
  game: string,
  stage: "card" | "locator" | "membership",
  after: number,
) {
  const table =
    stage === "card"
      ? "reconciled_card_observations"
      : stage === "locator"
        ? "reconciled_printing_locators"
        : "reconciled_printing_memberships";
  const join =
    stage === "card"
      ? "JOIN reconciled_cards card ON card.id=h.card_id"
      : "JOIN reconciled_printings printing ON printing.id=h.printing_id JOIN reconciled_cards card ON card.id=printing.card_id";
  return repositoryStatements(db)
    .prepare(`SELECT h.rowid AS history_rowid,h.*,card.id AS history_card_id,
    card.official_identity_kind AS history_identity_kind,card.official_identity_value AS history_identity_value
    FROM ${table} h ${join} WHERE card.supported_game=? AND h.rowid>? ORDER BY h.rowid LIMIT 1`)
    .bind(game, after);
}

export function currentNativePrintingStatement(db: CatalogueStore, printingId: string) {
  return repositoryStatements(db)
    .prepare(`SELECT entity.candidate_id,entity.preparation_id,entity.card_id,
    first.catalogue_revision_id AS first_revision_id,last.catalogue_revision_id AS last_observed_revision_id,
    lifecycle.withdrawn,withdrawal.catalogue_revision_id AS withdrawal_revision_id,lifecycle.withdrawal_evidence_json
    FROM game_accepted_candidates accepted JOIN publication_read_entities entity
      ON entity.candidate_id=accepted.candidate_id AND entity.kind='printings' AND entity.entity_id=?
    JOIN catalogue_candidate_publications published ON published.candidate_id=accepted.candidate_id
    JOIN publication_read_lifecycles lifecycle ON lifecycle.candidate_id=entity.candidate_id
      AND lifecycle.kind=entity.kind AND lifecycle.entity_id=entity.entity_id
    JOIN catalogue_candidate_publications first ON first.candidate_id=lifecycle.first_candidate_id
    JOIN catalogue_candidate_publications last ON last.candidate_id=lifecycle.last_observed_candidate_id
    LEFT JOIN catalogue_candidate_publications withdrawal ON withdrawal.candidate_id=lifecycle.withdrawal_candidate_id
    ORDER BY accepted.supported_game LIMIT 2`)
    .bind(printingId);
}
export function historyPublicationBindingsStatement(db: CatalogueStore, candidates: string, revisions: string) {
  return repositoryStatements(db)
    .prepare(`SELECT binding.candidate_id,revision.id,revision.published_at
    FROM catalogue_revisions revision LEFT JOIN catalogue_candidate_publications binding
    ON binding.catalogue_revision_id=revision.id AND binding.candidate_id IN(SELECT value FROM json_each(?1))
    WHERE binding.candidate_id IS NOT NULL OR revision.id IN(SELECT value FROM json_each(?2))`)
    .bind(candidates, revisions);
}
