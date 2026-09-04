import { type CatalogueStore, repositoryStatements } from "../../../../src/catalogue/shared";

export async function createAtomicBatchFixture(database: D1Database): Promise<void> {
  await database.exec("DROP TABLE IF EXISTS atomic_batch_fixture");
  await database.exec("CREATE TABLE atomic_batch_fixture (id TEXT PRIMARY KEY, value INTEGER NOT NULL)");
}

export function insertAtomicBatchValue(database: CatalogueStore, id: string, value: number): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("INSERT INTO atomic_batch_fixture VALUES (?, ?) RETURNING id, value")
    .bind(id, value);
}

export function requireAtomicBatchValue(
  database: CatalogueStore,
  id: string,
  value: number | null,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN EXISTS (
    SELECT 1 FROM atomic_batch_fixture WHERE id = ? AND value = ?
  ) THEN 1 ELSE json_extract('{}', 'atomic_batch_value_changed') END`)
    .bind(id, value);
}

export function atomicBatchValues(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare("SELECT id, value FROM atomic_batch_fixture ORDER BY id");
}
