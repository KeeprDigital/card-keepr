import { type CatalogueStore, repositoryStatements } from "./catalogue-store-repository";

/** Check the outcome while its claim and cleanup evidence are still in the same transaction. */
export function administrationOutcomeGuardStatement(database: CatalogueStore, key: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`WITH outcome AS (
    SELECT * FROM administration_idempotency WHERE idempotency_key = ?
  ) SELECT CASE
    WHEN changes() = 0 THEN 1
    WHEN EXISTS (SELECT 1 FROM outcome JOIN administration_idempotency_claims AS claim
      ON claim.idempotency_key = outcome.idempotency_key)
      AND NOT EXISTS (SELECT 1 FROM outcome JOIN administration_idempotency_claims AS claim
        ON claim.idempotency_key = outcome.idempotency_key
        AND claim.operation = outcome.operation AND claim.request_json = outcome.request_json
        AND claim.owner_token = outcome.claim_owner_token AND claim.claim_version = outcome.claim_version)
      THEN json_extract('{}', 'administration_idempotency_owner_changed')
    WHEN EXISTS (SELECT 1 FROM outcome WHERE operation = 'retry_publication_cleanup' AND outcome = 'success')
      AND NOT EXISTS (SELECT 1 FROM outcome JOIN ingestion_publication_cleanup AS cleanup
        ON cleanup.ingestion_run_id = json_extract(outcome.request_json, '$.run_id')
        AND cleanup.state = 'completed' AND cleanup.idempotency_key = outcome.idempotency_key
        AND cleanup.request_json = outcome.request_json AND cleanup.claim_token IS NULL
        AND cleanup.claim_version = json_extract(outcome.response_json, '$.publication_cleanup.generation'))
      THEN json_extract('{}', 'cleanup_completion_claim_changed')
    ELSE 1 END`)
    .bind(key);
}

export function administrationClaimGuardStatement(database: CatalogueStore, key: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT CASE
    WHEN changes() = 0 OR NOT EXISTS (SELECT 1 FROM administration_idempotency WHERE idempotency_key = ?)
    THEN 1 ELSE json_extract('{}', 'administration_idempotency_completed') END`)
    .bind(key);
}
