/** Retained result rows for exercising the owner's bounded inspection boundary. */
export function seedCleanupResult(database: D1Database, cleanup: string, key: string) {
  return database
    .prepare(
      "INSERT INTO evidence_cleanup_results (cleanup_id, object_key, state, reason) VALUES (?, ?, 'deleted', NULL)",
    )
    .bind(cleanup, key);
}
