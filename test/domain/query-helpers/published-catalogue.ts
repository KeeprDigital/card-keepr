import type { DatabaseSync, StatementSync } from "node:sqlite";

// Dedicated test queries. Tests retain binding, execution, and atomic batch composition.

export function countSqliteSchemaCount(database: DatabaseSync): StatementSync {
  return database.prepare(`SELECT count(*) AS count
         FROM sqlite_schema
         WHERE type = 'table'
           AND name LIKE 'revision_card%'
           AND lower(sql) LIKE '%create virtual table%'`);
}

export function copySqliteDatabase(database: DatabaseSync): StatementSync {
  return database.prepare("VACUUM INTO ?");
}

export function countRevisionCardQueryDocumentsCount(database: DatabaseSync): StatementSync {
  return database.prepare("SELECT COUNT(*) AS count FROM revision_card_query_documents");
}

export function inspectForeignKeyCheck(database: DatabaseSync): StatementSync {
  return database.prepare("PRAGMA foreign_key_check");
}

export function inspectIntegrityCheck(database: DatabaseSync): StatementSync {
  return database.prepare("PRAGMA integrity_check");
}
