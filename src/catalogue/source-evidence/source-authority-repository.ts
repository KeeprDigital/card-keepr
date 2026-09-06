import { type CatalogueStore, atomicRepositoryStatement, repositoryStatements } from "../shared";

export type AuthorityDecision = {
  idempotency_key: string;
  game: string;
  locale: string;
  release_region: string;
  area: string;
  source_lineage: string;
  generation: number;
  rationale: string;
  request_json: string;
  decided_at: string;
};
export function authorityDecisionsStatement(database: CatalogueStore) {
  return repositoryStatements(database).prepare(`SELECT decision.* FROM source_authority_decisions AS decision
    WHERE generation = (SELECT MAX(generation) FROM source_authority_decisions AS latest
      WHERE latest.game = decision.game AND latest.locale = decision.locale
        AND latest.release_region = decision.release_region AND latest.area = decision.area)
    ORDER BY game, locale, release_region, area`);
}
export function authorityReplayStatement(database: CatalogueStore, key: string) {
  return repositoryStatements(database)
    .prepare("SELECT * FROM source_authority_decisions WHERE idempotency_key = ?")
    .bind(key);
}
export function insertAuthorityDecisionStatement(database: CatalogueStore, decision: AuthorityDecision) {
  const statements = repositoryStatements(database);
  return atomicRepositoryStatement(database, {
    statement: statements
      .prepare(`INSERT INTO source_authority_decisions
      (idempotency_key, game, locale, release_region, area, source_lineage, generation, rationale, request_json, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        decision.idempotency_key,
        decision.game,
        decision.locale,
        decision.release_region,
        decision.area,
        decision.source_lineage,
        decision.generation,
        decision.rationale,
        decision.request_json,
        decision.decided_at,
      ),
    before: [
      statements
        .prepare(`SELECT CASE
      WHEN EXISTS (SELECT 1 FROM operation_state WHERE singleton = 1 AND
        (active_ingestion_run_id IS NOT NULL OR recovery_health = 'blocked' OR
          (active_production_release_id IS NOT NULL AND active_production_release_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))))
        THEN json_extract('{}', 'source_authority_operation_not_idle')
      WHEN ? <> 1 + COALESCE((SELECT MAX(generation) FROM source_authority_decisions
        WHERE game = ? AND locale = ? AND release_region = ? AND area = ?), 0)
        THEN json_extract('{}', 'source_authority_generation_mismatch')
      ELSE 1 END`)
        .bind(decision.generation, decision.game, decision.locale, decision.release_region, decision.area),
    ],
  });
}
