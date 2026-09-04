/** Counts preparation authority without changing lifecycle state. */
export function preparedReleaseCount(database: D1Database) {
  return database.prepare(
    "SELECT COUNT(*) AS count FROM administration_idempotency WHERE operation='prepare_production_release'",
  );
}
export function seedUnrelatedAdministrationKey(database: D1Database, key: string) {
  return database
    .prepare(`INSERT INTO administration_idempotency
    (idempotency_key,operation,request_json,response_json,http_status,outcome,created_at)
    VALUES (?,'unrelated_operation','{}','{}',201,'success','2026-08-05T00:00:00.000Z')`)
    .bind(key);
}
