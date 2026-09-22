import {
  type CatalogueStore,
  repositoryStatements,
  atomicRepositoryStatement,
  administrationOutcomeGuardStatement,
} from "../shared";

export function promotionRecordStatement(database: CatalogueStore, key: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("SELECT operation, request_json, response_json FROM administration_idempotency WHERE idempotency_key = ?")
    .bind(key);
}

/** The immutable promotion confirmation that stands in for the owner's production envelope. */
export function recordProductionPromotionStatement(
  database: CatalogueStore,
  input: { key: string; request: string; response: string; at: string },
): D1PreparedStatement {
  return atomicRepositoryStatement(database, {
    statement: repositoryStatements(database)
      .prepare(
        `INSERT INTO administration_idempotency
      (idempotency_key, operation, request_json, response_json, http_status, outcome, created_at)
      VALUES (?, 'production_promotion', ?, ?, 201, 'success', ?)`,
      )
      .bind(input.key, input.request, input.response, input.at),
    after: [administrationOutcomeGuardStatement(database, input.key)],
  });
}

/** A stop is audit evidence only: the first occurrence of each code per workflow run is kept. */
export function recordPromotionStopStatement(
  database: CatalogueStore,
  input: { key: string; request: string; response: string; status: number; at: string },
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(
      `INSERT OR IGNORE INTO administration_idempotency
      (idempotency_key, operation, request_json, response_json, http_status, outcome, created_at)
      VALUES (?, 'production_promotion_stopped', ?, ?, ?, 'problem', ?)`,
    )
    .bind(input.key, input.request, input.response, input.status, input.at);
}
