import { type CatalogueStore, repositoryStatements } from "../shared";

export function currentCardModelStatement(database: CatalogueStore) {
  return repositoryStatements(database).prepare(`SELECT ${currentCardModelSql("revision")} AS model_ready
    FROM catalogue_revisions revision
    WHERE revision.id=(SELECT current_revision_id FROM catalogue_state WHERE singleton=1)`);
}

/** Current responses require every selected game to have regenerated definitions.
 * Native components use immutable pins; legacy checks seek invalid-record indexes.
 */
export function currentCardModelSql(revision: string) {
  return `(CASE WHEN ${revision}.publication_operation_id IS NOT NULL THEN
    NOT EXISTS(SELECT 1 FROM catalogue_composition_games model_member
      JOIN game_candidates model_candidate ON model_candidate.id=model_member.candidate_id
      JOIN reconciliation_operations model_operation ON model_operation.id=model_candidate.preparation_id
      WHERE model_member.catalogue_revision_id=${revision}.id
      AND json_extract(model_operation.definition_pins_json,'$.card_model') IS NOT 'categories')
    ELSE NOT EXISTS(SELECT 1 FROM revision_cards model_card
      WHERE model_card.catalogue_revision_id=${revision}.id
      AND model_card.card_model_ready=0)
      AND NOT EXISTS(SELECT 1 FROM revision_printings model_printing
      WHERE model_printing.catalogue_revision_id=${revision}.id
      AND model_printing.card_model_ready=0) END)`;
}
