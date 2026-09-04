import {
  prepareCardSearchForD1ExportStatements,
  reconstructCardSearchAfterD1RestoreStatements,
} from "./card-search-recovery-statements.ts";

export function acquireCardSearchExportLeaseStatement(
  database: D1Database,
  input: Readonly<{ ownerToken: string; leaseExpiresAt: string; observedAt: string }>,
): D1PreparedStatement {
  return database
    .prepare(`UPDATE card_search_fts_state
     SET state = 'reconstructing', owner_token = ?, lease_expires_at = ?
     WHERE singleton = 1
       AND (
         state = 'ready'
         OR (state = 'reconstructing' AND owner_token = ?)
         OR (state = 'reconstructing' AND lease_expires_at <= ?)
       )`)
    .bind(input.ownerToken, input.leaseExpiresAt, input.ownerToken, input.observedAt);
}

export function guardCardSearchExportLeaseStatement(
  database: D1Database,
  input: Readonly<{ ownerToken: string }>,
): D1PreparedStatement {
  return database
    .prepare(`SELECT CASE WHEN EXISTS (
           SELECT 1 FROM card_search_fts_state
           WHERE singleton = 1
             AND state = 'reconstructing'
             AND owner_token = ?
         ) THEN 1 ELSE json_extract('invalid', '$') END`)
    .bind(input.ownerToken);
}

export function completeCardSearchReconstructionStatement(
  database: D1Database,
  input: Readonly<{ ownerToken: string }>,
): D1PreparedStatement {
  return database
    .prepare(`UPDATE card_search_fts_state
         SET state = 'ready', owner_token = NULL, lease_expires_at = NULL
         WHERE singleton = 1
           AND state = 'reconstructing'
           AND owner_token = ?`)
    .bind(input.ownerToken);
}

export function cardSearchExportLeaseOwnerStatement(database: D1Database): D1PreparedStatement {
  return database.prepare("SELECT owner_token FROM card_search_fts_state WHERE singleton = 1");
}

export function releaseCardSearchExportLeaseStatement(
  database: D1Database,
  input: Readonly<{ ownerToken: string }>,
): D1PreparedStatement {
  return database
    .prepare(`UPDATE card_search_fts_state
     SET state = 'ready', owner_token = NULL, lease_expires_at = NULL
     WHERE singleton = 1 AND owner_token = ?`)
    .bind(input.ownerToken);
}

export function prepareCardSearchExportStatements(database: D1Database): D1PreparedStatement[] {
  return prepareCardSearchForD1ExportStatements.map((sql) => database.prepare(sql));
}
export function reconstructCardSearchStatements(database: D1Database): D1PreparedStatement[] {
  return reconstructCardSearchAfterD1RestoreStatements.map((sql) => database.prepare(sql));
}
export function completedCardSearchReconstructionQuery(ownerToken: string): { sql: string; params: string[] } {
  return {
    sql: `UPDATE card_search_fts_state
         SET state = 'ready', owner_token = NULL, lease_expires_at = NULL
         WHERE singleton = 1 AND state = 'reconstructing'
           AND owner_token = ?`,
    params: [ownerToken],
  };
}
