/** Automatic promotion ledger rows and the production state its fresh guards read. */
export function promotionStopCodes(database: D1Database, releaseId: string) {
  return database
    .prepare(
      `SELECT json_extract(response_json, '$.code') AS code, http_status FROM administration_idempotency
      WHERE operation='production_promotion_stopped' AND idempotency_key LIKE ? ORDER BY idempotency_key`,
    )
    .bind(`production-promotion-stop:${releaseId}:%`);
}
export function promotionPlanCount(database: D1Database) {
  return database.prepare(
    "SELECT COUNT(*) AS count FROM administration_idempotency WHERE operation='prepare_production_release' AND idempotency_key LIKE 'promotion:%'",
  );
}
export function advanceSchemaLevel(database: D1Database) {
  return database.prepare("UPDATE catalogue_schema_state SET migration_level=migration_level+1 WHERE singleton=1");
}
export function holdProductionReleaseLease(database: D1Database, releaseId: string, expiresAt: string) {
  return database
    .prepare(
      "UPDATE operation_state SET active_production_release_id=?, active_production_release_expires_at=? WHERE singleton=1",
    )
    .bind(releaseId, expiresAt);
}
