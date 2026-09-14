import {
  type CatalogueStore,
  repositoryStatements,
  atomicRepositoryStatement,
  administrationOutcomeGuardStatement,
} from "../shared";

export function stagingRecordStatement(database: CatalogueStore, key: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("SELECT operation, request_json, response_json FROM administration_idempotency WHERE idempotency_key = ?")
    .bind(key);
}

export function lastSuccessfulReleaseStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(`SELECT request_json FROM (
    SELECT request_json, created_at AS completed_at FROM administration_idempotency
      WHERE operation='production_release_succeeded' AND outcome='success'
    UNION ALL SELECT request_json, terminal_at AS completed_at FROM production_releases WHERE state='succeeded'
  ) ORDER BY completed_at DESC LIMIT 1`);
}

export function stagingDeploymentSucceededStatement(
  database: CatalogueStore,
  releaseId: string,
  plan: string,
  digest: string,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(
      `SELECT 1 AS succeeded FROM production_releases
    WHERE id=? AND request_json=? AND state='succeeded' AND binding_observation_json IS NOT NULL AND smoke_evidence_json IS NOT NULL
    UNION ALL SELECT 1 AS succeeded FROM administration_idempotency WHERE idempotency_key=? AND operation='production_release_succeeded' AND request_json=? AND outcome='success' LIMIT 1`,
    )
    .bind(releaseId, plan, `release-smoke:${digest}`, plan);
}

export function stagingSchemaLevelStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare("SELECT migration_level FROM catalogue_schema_state WHERE singleton=1");
}

export function recordStagingIntentStatement(
  database: CatalogueStore,
  key: string,
  request: string,
  response: string,
  at: string,
): D1PreparedStatement {
  return recordStagingProtocolStatement(database, { key, operation: "prepare_staging_release", request, response, at });
}

export function recordStagingProtocolStatement(
  database: CatalogueStore,
  input: {
    key: string;
    operation:
      | "prepare_staging_release"
      | "authorize_staging_release"
      | "prepare_staging_deployment"
      | "staging_release_outcome";
    request: string;
    response: string;
    at: string;
  },
): D1PreparedStatement {
  return atomicRepositoryStatement(database, {
    statement: repositoryStatements(database)
      .prepare(
        `INSERT INTO administration_idempotency
      (idempotency_key, operation, request_json, response_json, http_status, outcome, created_at)
      VALUES (?, ?, ?, ?, 201, 'success', ?)`,
      )
      .bind(input.key, input.operation, input.request, input.response, input.at),
    after: [administrationOutcomeGuardStatement(database, input.key)],
  });
}

export function stagingIntentStartingStateGate(
  database: CatalogueStore,
  migrationLevel: number,
  at: string,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(
      `SELECT CASE WHEN EXISTS (
    SELECT 1 FROM catalogue_schema_state AS schema JOIN operation_state AS operation ON operation.singleton=1
    WHERE schema.singleton=1 AND schema.migration_level=? AND operation.recovery_health='healthy'
      AND operation.recovery_restore_guard='clear' AND operation.active_recovery_id IS NULL
      AND operation.active_ingestion_run_id IS NULL
      AND (operation.active_production_release_id IS NULL OR operation.active_production_release_expires_at<=?)
    ) THEN 1 ELSE json_extract('invalid', '$') END`,
    )
    .bind(migrationLevel, at);
}
