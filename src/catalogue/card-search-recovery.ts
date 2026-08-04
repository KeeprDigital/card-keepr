import {
  prepareCardSearchForD1ExportStatements,
  reconstructCardSearchAfterD1RestoreStatements,
} from "./card-search-recovery-statements.mjs";

// D1 export does not support virtual tables. Card-search chunks are the
// exportable source of truth, so backup recovery removes only the derived FTS
// structures. The export operation must reconstruct the live database in a
// finally block after export. It must also reconstruct the disposable database
// after restore and before recovery verification. Both batches finish
// atomically; the readiness row keeps Card reads closed between them.

export async function prepareCardSearchForD1Export(
  database: D1Database,
  lease: CardSearchExportLease,
): Promise<void> {
  validateLease(lease);
  const acquired = await database.prepare(
    `UPDATE card_search_fts_state
     SET state = 'reconstructing', owner_token = ?, lease_expires_at = ?
     WHERE singleton = 1
       AND (
         state = 'ready'
         OR (state = 'reconstructing' AND lease_expires_at <= ?)
       )`,
  ).bind(
    lease.ownerToken,
    lease.leaseExpiresAt,
    lease.observedAt,
  ).run();
  if (acquired.meta.changes !== 1) {
    throw new Error("Card search FTS export lease is unavailable.");
  }
  try {
    await executeBatch(database, prepareCardSearchForD1ExportStatements);
  } catch (error) {
    await releaseLease(database, lease.ownerToken);
    throw error;
  }
}

export async function withCardSearchPreparedForD1Export<T>(
  database: D1Database,
  lease: CardSearchExportLease,
  exportDatabase: () => Promise<T>,
): Promise<T> {
  await prepareCardSearchForD1Export(database, lease);
  try {
    return await exportDatabase();
  } finally {
    await reconstructCardSearchAfterD1Restore(
      database,
      lease.ownerToken,
    );
  }
}

export async function reconstructCardSearchAfterD1Restore(
  database: D1Database,
  ownerToken: string,
): Promise<void> {
  try {
    await database.batch([
      database.prepare(
        `SELECT CASE WHEN EXISTS (
           SELECT 1 FROM card_search_fts_state
           WHERE singleton = 1
             AND state = 'reconstructing'
             AND owner_token = ?
         ) THEN 1 ELSE json_extract('invalid', '$') END`,
      ).bind(ownerToken),
      ...reconstructCardSearchAfterD1RestoreStatements.map((sql) =>
        database.prepare(sql)
      ),
      database.prepare(
        `UPDATE card_search_fts_state
         SET state = 'ready', owner_token = NULL, lease_expires_at = NULL
         WHERE singleton = 1
           AND state = 'reconstructing'
           AND owner_token = ?`,
      ).bind(ownerToken),
    ]);
  } catch (error) {
    const owner = await database.prepare(
      "SELECT owner_token FROM card_search_fts_state WHERE singleton = 1",
    ).first<{ owner_token: string | null }>();
    if (owner?.owner_token !== ownerToken) {
      throw new Error("Card search FTS export lease owner changed.");
    }
    throw error;
  }
}

export type CardSearchExportLease = Readonly<{
  ownerToken: string;
  observedAt: string;
  leaseExpiresAt: string;
}>;

function executeBatch(
  database: D1Database,
  statements: readonly string[],
): Promise<D1Result[]> {
  return database.batch(statements.map((sql) => database.prepare(sql)));
}

async function releaseLease(
  database: D1Database,
  ownerToken: string,
): Promise<void> {
  await database.prepare(
    `UPDATE card_search_fts_state
     SET state = 'ready', owner_token = NULL, lease_expires_at = NULL
     WHERE singleton = 1 AND owner_token = ?`,
  ).bind(ownerToken).run();
}

function validateLease(lease: CardSearchExportLease): void {
  if (
    lease.ownerToken.length === 0 ||
    !lease.observedAt.endsWith("Z") ||
    !lease.leaseExpiresAt.endsWith("Z") ||
    lease.leaseExpiresAt <= lease.observedAt
  ) {
    throw new Error("Card search FTS export lease is invalid.");
  }
}
