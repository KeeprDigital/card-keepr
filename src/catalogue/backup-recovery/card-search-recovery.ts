import type { CatalogueStore } from "../shared";
import * as searchRecoveryStatements from "./card-search-recovery-repository";

// D1 export does not support virtual tables. Card-search chunks are the
// exportable source of truth, so backup recovery removes only the derived FTS
// structures. The export operation must reconstruct the live database in a
// finally block after export. It must also reconstruct the disposable database
// after restore and before recovery verification. Both batches finish
// atomically; the readiness row keeps Card reads closed between them.

export async function prepareCardSearchForD1Export(
  database: CatalogueStore,
  lease: CardSearchExportLease,
): Promise<void> {
  validateLease(lease);
  const acquired = await searchRecoveryStatements
    .acquireCardSearchExportLeaseStatement(database, {
      ownerToken: lease.ownerToken,
      leaseExpiresAt: lease.leaseExpiresAt,
      observedAt: lease.observedAt,
    })
    .run();
  if (acquired.meta.changes !== 1) {
    throw new Error("Card search FTS export lease is unavailable.");
  }
  try {
    await database.batch(searchRecoveryStatements.prepareCardSearchExportStatements(database));
  } catch (error) {
    await releaseLease(database, lease.ownerToken);
    throw error;
  }
}

export async function withCardSearchPreparedForD1Export<T>(
  database: CatalogueStore,
  lease: CardSearchExportLease,
  exportDatabase: () => Promise<T>,
): Promise<T> {
  await prepareCardSearchForD1Export(database, lease);
  try {
    return await exportDatabase();
  } finally {
    await reconstructCardSearchAfterD1Restore(database, lease.ownerToken);
  }
}

export async function reconstructCardSearchAfterD1Restore(database: CatalogueStore, ownerToken: string): Promise<void> {
  try {
    await database.batch([
      searchRecoveryStatements.guardCardSearchExportLeaseStatement(database, { ownerToken }),
      ...searchRecoveryStatements.reconstructCardSearchStatements(database),
      searchRecoveryStatements.completeCardSearchReconstructionStatement(database, { ownerToken }),
    ]);
  } catch (error) {
    const owner = await searchRecoveryStatements
      .cardSearchExportLeaseOwnerStatement(database)
      .first<{ owner_token: string | null }>();
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

async function releaseLease(database: CatalogueStore, ownerToken: string): Promise<void> {
  await searchRecoveryStatements.releaseCardSearchExportLeaseStatement(database, { ownerToken }).run();
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
