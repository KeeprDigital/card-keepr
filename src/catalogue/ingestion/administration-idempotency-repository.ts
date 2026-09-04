import { type CatalogueStore, repositoryStatements } from "../shared";
// Named prepared statements; callers retain execution and atomic batch composition.

export function administrationClaimStatement(database: CatalogueStore, key: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT
        operation,
        request_json,
        claimed_at,
        owner_token,
        claim_version,
        claim_expires_at
      FROM administration_idempotency_claims
      WHERE idempotency_key = ?`)
    .bind(key);
}

export function releaseAdministrationClaimStatement(
  database: CatalogueStore,
  input: Readonly<{
    key: string;
    operation: string;
    requestJson: string;
    ownerToken: string | null;
    claimVersion: number | null;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`DELETE FROM administration_idempotency_claims
      WHERE idempotency_key = ?
        AND operation = ?
        AND request_json = ?
        AND (? IS NULL OR owner_token = ?)
        AND (? IS NULL OR claim_version = ?)`)
    .bind(
      input.key,
      input.operation,
      input.requestJson,
      input.ownerToken,
      input.ownerToken,
      input.claimVersion,
      input.claimVersion,
    );
}

export function completeAdministrationStatement(
  database: CatalogueStore,
  input: Readonly<{
    key: string;
    operation: string;
    requestJson: string;
    responseJson: string;
    status: number;
    createdAt: string;
    ownerToken: string | null;
    claimVersion: number | null;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO administration_idempotency (
        idempotency_key,
        operation,
        request_json,
        response_json,
        http_status,
        outcome,
        created_at,
        claim_owner_token,
        claim_version
      ) VALUES (?, ?, ?, ?, ?, 'success', ?, ?, ?)`)
    .bind(
      input.key,
      input.operation,
      input.requestJson,
      input.responseJson,
      input.status,
      input.createdAt,
      input.ownerToken,
      input.claimVersion,
    );
}

export function administrationOutcomeStatement(database: CatalogueStore, key: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT
        operation,
        request_json,
        response_json,
        http_status,
        outcome
      FROM administration_idempotency
      WHERE idempotency_key = ?`)
    .bind(key);
}

export function recordAdministrationProblemStatement(
  database: CatalogueStore,
  input: Readonly<{
    key: string;
    operation: string;
    requestJson: string;
    responseJson: string;
    status: number;
    createdAt: string;
    ownerToken: string;
    claimVersion: number;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO administration_idempotency (
              idempotency_key,
              operation,
              request_json,
              response_json,
              http_status,
              outcome,
              created_at,
              claim_owner_token,
              claim_version
            ) VALUES (?, ?, ?, ?, ?, 'problem', ?, ?, ?)`)
    .bind(
      input.key,
      input.operation,
      input.requestJson,
      input.responseJson,
      input.status,
      input.createdAt,
      input.ownerToken,
      input.claimVersion,
    );
}

export function acquireAdministrationClaimStatement(
  database: CatalogueStore,
  input: Readonly<{
    key: string;
    operation: string;
    requestJson: string;
    claimedAt: string;
    ownerToken: string;
    expiresAt: string;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO administration_idempotency_claims (
          idempotency_key,
          operation,
          request_json,
          claimed_at,
          owner_token,
          claim_version,
          claim_expires_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?)
        RETURNING operation, request_json, claimed_at,
          owner_token, claim_version, claim_expires_at`)
    .bind(input.key, input.operation, input.requestJson, input.claimedAt, input.ownerToken, input.expiresAt);
}

export function takeOverAdministrationClaimStatement(
  database: CatalogueStore,
  input: Readonly<{
    claimedAt: string;
    ownerToken: string;
    expiresAt: string;
    key: string;
    operation: string;
    requestJson: string;
    priorOwnerToken: string;
    priorVersion: number;
    priorExpiresAt: string;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE administration_idempotency_claims
          SET claimed_at = ?,
              owner_token = ?,
              claim_version = claim_version + 1,
              claim_expires_at = ?
          WHERE idempotency_key = ?
            AND operation = ?
            AND request_json = ?
            AND owner_token = ?
            AND claim_version = ?
            AND claim_expires_at = ?
          RETURNING operation, request_json, claimed_at,
            owner_token, claim_version, claim_expires_at`)
    .bind(
      input.claimedAt,
      input.ownerToken,
      input.expiresAt,
      input.key,
      input.operation,
      input.requestJson,
      input.priorOwnerToken,
      input.priorVersion,
      input.priorExpiresAt,
    );
}

export function legacyAdministrationRunStatement(database: CatalogueStore, key: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT *
      FROM ingestion_runs
      WHERE idempotency_key = ?
        OR approval_idempotency_key = ?
      LIMIT 1`)
    .bind(key, key);
}
