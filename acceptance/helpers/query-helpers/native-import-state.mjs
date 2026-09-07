export const validNativeImportSql =
  "CREATE TABLE imported_rows(id INTEGER PRIMARY KEY); INSERT INTO imported_rows VALUES(1),(2);";
export const invalidNativeImportSql = `${validNativeImportSql} INSERT INTO absent_table VALUES(3);`;
export function nativeImportState(target) {
  return {
    tablePresent: target.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='imported_rows'").get().n === 1,
    foreignKeys: target.prepare("PRAGMA foreign_keys").get().foreign_keys,
  };
}
export function nativeImportedRows(target) {
  return target
    .prepare("SELECT id FROM imported_rows ORDER BY id")
    .all()
    .map((row) => row.id);
}
