import { unstable_splitSqlQuery } from "wrangler";

export function nativeRecoveryExportSql(exported) {
  const virtual = exported.split("\n").filter((line) => line.includes("CREATE VIRTUAL TABLE"));
  if (virtual.length > 0) throw new Error(`Export still contains virtual tables: ${virtual.join(" | ")}`);
  // D1 management exports omit provider-owned bookkeeping; AUTOINCREMENT
  // counters are reconstructed by inserting the retained primary keys.
  const statements = unstable_splitSqlQuery(exported).filter(
    (sql) =>
      !/^(?:CREATE TABLE|INSERT INTO) ["`]?_cf_/i.test(sql.trim()) &&
      !/^(?:INSERT INTO|DELETE FROM) sqlite_sequence/i.test(sql.trim()) &&
      !/^(?:PRAGMA foreign_keys|BEGIN TRANSACTION|COMMIT)/i.test(sql.trim()),
  );
  return (
    "PRAGMA defer_foreign_keys=ON;\n" +
    [
      // Tables and their indexes form the schema retained rows are checked
      // against: D1 keeps foreign keys enforced, and a composite FOREIGN KEY
      // is a "foreign key mismatch" until the parent UNIQUE index exists.
      ...statements.filter((sql) => /^CREATE (?:TABLE|(?:UNIQUE )?INDEX)/i.test(sql.trim())),
      ...statements.filter((sql) => !/^CREATE (?:TABLE|(?:UNIQUE )?INDEX|TRIGGER)/i.test(sql.trim())),
      // Restore retained rows before installing the original write fences.
      // Those triggers must govern later writes, not replayed data.
      ...statements.filter((sql) => /^CREATE TRIGGER/i.test(sql.trim())),
    ].join(";\n") +
    ";"
  );
}
