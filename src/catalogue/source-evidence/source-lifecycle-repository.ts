import { type CatalogueStore, repositoryStatements, atomicRepositoryStatement } from "../shared";

export type SourceLifecycleDecision = {
  idempotency_key: string;
  source_lineage: string;
  state: "active" | "retired";
  generation: number;
  rationale: string;
  request_json: string;
  decided_at: string;
};
export function sourceLifecycleHistoryStatement(database: CatalogueStore, lineage: string) {
  return repositoryStatements(database)
    .prepare("SELECT * FROM source_lifecycle_decisions WHERE source_lineage = ? ORDER BY generation DESC LIMIT 100")
    .bind(lineage);
}
export function sourceLifecycleReplayStatement(database: CatalogueStore, key: string) {
  return repositoryStatements(database)
    .prepare("SELECT * FROM source_lifecycle_decisions WHERE idempotency_key = ?")
    .bind(key);
}
export function sourceAuthorityDecisionCountStatement(database: CatalogueStore) {
  return repositoryStatements(database).prepare("SELECT COUNT(*) AS count FROM source_authority_decisions");
}
export function sourcesActiveGuardStatement(database: CatalogueStore, lineages: readonly string[]) {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN EXISTS (
    SELECT 1 FROM source_lifecycle_decisions AS decision WHERE source_lineage IN (SELECT value FROM json_each(?))
      AND state = 'retired' AND generation = (SELECT MAX(generation) FROM source_lifecycle_decisions WHERE source_lineage = decision.source_lineage)
    ) THEN json_extract('{}', 'source_retired') ELSE 1 END`)
    .bind(JSON.stringify(lineages));
}
export function insertSourceLifecycleDecisionStatement(
  database: CatalogueStore,
  decision: SourceLifecycleDecision,
  authorityCount: number,
) {
  const statements = repositoryStatements(database);
  return atomicRepositoryStatement(database, {
    statement: statements
      .prepare(`INSERT INTO source_lifecycle_decisions
      (idempotency_key, source_lineage, state, generation, rationale, request_json, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        decision.idempotency_key,
        decision.source_lineage,
        decision.state,
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
        THEN json_extract('{}', 'source_lifecycle_operation_not_idle')
      WHEN ? <> COALESCE((SELECT MAX(generation) FROM source_lifecycle_decisions WHERE source_lineage = ?), 0) + 1
        OR ? <> (SELECT COUNT(*) FROM source_authority_decisions)
        THEN json_extract('{}', 'source_lifecycle_generation_mismatch')
      ELSE 1 END`)
        .bind(decision.generation, decision.source_lineage, authorityCount),
    ],
  });
}
