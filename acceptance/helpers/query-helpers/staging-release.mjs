// Named SQLite statements; tests retain bindings, execution, and assertions.
export function insertStagingPreparationResponse(database) {
  return database.prepare(
    "INSERT INTO administration_idempotency (idempotency_key,operation,request_json,response_json,http_status,outcome,created_at) VALUES (?,'prepare_staging_deployment',?,?,201,'success',?)",
  );
}
