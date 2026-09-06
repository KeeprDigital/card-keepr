import { type CatalogueStore, repositoryStatements } from "../shared";

export function observedPlanStatement(
  database: CatalogueStore,
  runId: string,
  through: number,
  kind: "card" | "printing",
  entityId: string,
  lineage?: string,
) {
  const path = kind === "card" ? "$.value.plan.cardId" : "$.value.plan.printingId";
  return repositoryStatements(database)
    .prepare(`SELECT content, sha256 FROM reconciliation_reducer_state
      WHERE ingestion_run_id = ? AND namespace = 'observation_plans'
        AND json_extract(content, '${path}') = ? AND observation_ordinal <= ?
        AND json_extract(content, '$.value.plan.observationKind') = 'card_printing'
        AND (? IS NULL OR json_extract(content, '$.value.plan.sourceLineage') = ?)
      LIMIT 1`)
    .bind(runId, entityId, through, lineage ?? null, lineage ?? null);
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

export function nextPlanMembershipGroupStatement(
  database: CatalogueStore,
  runId: string,
  through: number,
  afterPrinting: string,
  afterLineage: string,
) {
  return repositoryStatements(database)
    .prepare(`SELECT
      json_extract(content, '$.value.plan.printingId') AS printing_id,
      json_extract(content, '$.value.plan.sourceLineage') AS source_lineage
    FROM reconciliation_reducer_state WHERE ingestion_run_id = ? AND namespace = 'observation_plans'
      AND observation_ordinal <= ? AND json_extract(content, '$.value.plan.observationKind') = 'card_printing'
      AND (json_extract(content, '$.value.plan.printingId'), json_extract(content, '$.value.plan.sourceLineage')) > (?, ?)
    GROUP BY printing_id, source_lineage ORDER BY printing_id, source_lineage LIMIT 1`)
    .bind(runId, through, afterPrinting, afterLineage);
}

export function nextMembershipPlanStatement(
  database: CatalogueStore,
  runId: string,
  through: number,
  printingId: string,
  lineage: string,
  after: string,
) {
  return repositoryStatements(database)
    .prepare(`SELECT content, sha256, key_digest
    FROM reconciliation_reducer_state WHERE ingestion_run_id = ? AND namespace = 'observation_plans'
      AND observation_ordinal <= ? AND json_extract(content, '$.value.plan.observationKind') = 'card_printing'
      AND json_extract(content, '$.value.plan.printingId') = ?
      AND json_extract(content, '$.value.plan.sourceLineage') = ? AND key_digest > ?
    ORDER BY key_digest LIMIT 1`)
    .bind(runId, through, printingId, lineage, after);
}
