import { type CatalogueStore, repositoryStatements } from "../shared";

/** Validate incoming targets before UPSERT, including an already retained Erratum ID. */
export function errataTargetsGuardStatement(database: CatalogueStore, payload: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(?) AS incoming WHERE (
      json_extract(incoming.value, '$.target_type') = 'card' AND NOT EXISTS (
        SELECT 1 FROM reconciled_cards AS card
        WHERE card.id = json_extract(incoming.value, '$.target_id')
          AND card.supported_game = json_extract(incoming.value, '$.game')
      )
    ) OR (
      json_extract(incoming.value, '$.target_type') = 'printing' AND NOT EXISTS (
        SELECT 1 FROM reconciled_printings AS printing JOIN reconciled_cards AS card ON card.id = printing.card_id
        WHERE printing.id = json_extract(incoming.value, '$.target_id')
          AND card.supported_game = json_extract(incoming.value, '$.game')
      )
    )
  ) THEN json_extract('{}', 'reconciled_erratum_target_invalid') ELSE 1 END`)
    .bind(payload);
}
