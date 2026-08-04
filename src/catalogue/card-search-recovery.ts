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
): Promise<void> {
  await requireState(database, "ready");
  await executeBatch(database, prepareCardSearchForD1ExportStatements);
}

export async function withCardSearchPreparedForD1Export<T>(
  database: D1Database,
  exportDatabase: () => Promise<T>,
): Promise<T> {
  await prepareCardSearchForD1Export(database);
  try {
    return await exportDatabase();
  } finally {
    await reconstructCardSearchAfterD1Restore(database);
  }
}

export async function reconstructCardSearchAfterD1Restore(
  database: D1Database,
): Promise<void> {
  await requireState(database, "reconstructing");
  await executeBatch(
    database,
    reconstructCardSearchAfterD1RestoreStatements,
  );
}

function executeBatch(
  database: D1Database,
  statements: readonly string[],
): Promise<D1Result[]> {
  return database.batch(statements.map((sql) => database.prepare(sql)));
}

async function requireState(
  database: D1Database,
  expected: "ready" | "reconstructing",
): Promise<void> {
  const state = await database.prepare(
    "SELECT state FROM card_search_fts_state WHERE singleton = 1",
  ).first<{ state: string }>();
  if (state?.state !== expected) {
    throw new Error(
      `Card search FTS must be ${expected}; found ${state?.state ?? "missing"}.`,
    );
  }
}
