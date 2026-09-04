import { type CatalogueStore, repositoryStatements } from "../shared";
// Named prepared statements; callers retain execution and atomic batch composition.

export function recordSourceFreshnessStatement(
  database: CatalogueStore,
  input: Readonly<{
    game: string;
    area: string;
    sourceLineage: string;
    region: string;
    checkedAt: string;
    runId: string;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO source_freshness (
          game,
          area,
          source_lineage,
          region,
          checked_at,
          ingestion_run_id
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (game, area, source_lineage, region) DO UPDATE SET
          checked_at = excluded.checked_at,
          ingestion_run_id = excluded.ingestion_run_id`)
    .bind(input.game, input.area, input.sourceLineage, input.region, input.checkedAt, input.runId);
}

export function runObservationAdaptersStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT DISTINCT
         observation.adapter_version,
         observation.supported_game
       FROM source_observation_sets AS observation
       JOIN source_snapshots AS snapshot
         ON snapshot.id = observation.source_snapshot_id
       WHERE snapshot.ingestion_run_id = ?
       ORDER BY observation.supported_game, observation.adapter_version`)
    .bind(runId);
}

export function publishedSourceFreshnessStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(`SELECT game, area, source_lineage, region, checked_at
       FROM source_freshness
       WHERE area IN (
         'cards-and-printings', 'products-and-releases',
         'legality-rules', 'errata'
       )
       ORDER BY game, area, source_lineage, region`);
}
