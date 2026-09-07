export class ReconciliationDocumentStorageError extends Error {
  constructor(cause: unknown) {
    super("Reconciliation document storage is temporarily unavailable.", { cause });
    this.name = "ReconciliationDocumentStorageError";
  }
}
export async function documentStorage<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw new ReconciliationDocumentStorageError(cause);
  }
}
