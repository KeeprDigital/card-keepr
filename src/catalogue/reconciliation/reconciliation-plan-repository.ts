import { type CatalogueStore, repositoryStatements } from "../shared";

export function membershipPlanStatement(database: CatalogueStore, preparationId: string, through: number, game: string) {
  return repositoryStatements(database)
    .prepare(`SELECT content, sha256 FROM reconciliation_reducer_state
      WHERE preparation_id = ? AND namespace = 'observation_plans' AND observation_ordinal <= ?
        AND json_extract(content, '$.value.plan.supportedGame') = ?
        AND json_extract(content, '$.value.plan.printingId') IS NOT NULL
        AND (json_array_length(content, '$.value.plan.memberships.products') > 0
          OR json_array_length(content, '$.value.plan.memberships.distribution_contexts') > 0)
      LIMIT 1`)
    .bind(preparationId, through, game);
}

export function observedPlanStatement(
  database: CatalogueStore,
  preparationId: string,
  through: number,
  kind: "card" | "printing",
  entityId: string,
  lineage?: string,
) {
  const path = kind === "card" ? "$.value.plan.cardId" : "$.value.plan.printingId";
  return repositoryStatements(database)
    .prepare(`SELECT content, sha256 FROM reconciliation_reducer_state
      WHERE preparation_id = ? AND namespace = 'observation_plans'
        AND json_extract(content, '${path}') = ? AND observation_ordinal <= ?
        AND json_extract(content, '$.value.plan.observationKind') = 'card_printing'
        AND (? IS NULL OR json_extract(content, '$.value.plan.sourceLineage') = ?)
      LIMIT 1`)
    .bind(preparationId, entityId, through, lineage ?? null, lineage ?? null);
}

export function previouslyObservedEntitiesStatement(
  database: CatalogueStore,
  kind: "card" | "printing",
  lineage: string,
  after: string,
) {
  const entities = kind === "card" ? "reconciled_cards" : "reconciled_printings";
  const observations = kind === "card" ? "reconciled_card_observations" : "reconciled_printing_locators";
  const foreignKey = kind === "card" ? "card_id" : "printing_id";
  return repositoryStatements(database)
    .prepare(`SELECT entity.id FROM ${entities} AS entity
      WHERE entity.id > ? AND entity.withdrawn = 0 AND EXISTS (
        SELECT 1 FROM ${observations} AS observation WHERE observation.${foreignKey} = entity.id
          AND observation.source_lineage = ? AND observation.current = 1)
      ORDER BY entity.id LIMIT 100`)
    .bind(after, lineage);
}
