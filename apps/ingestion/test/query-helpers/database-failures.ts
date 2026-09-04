import { readSqliteMasterSql } from "./published-catalogue";
export function withoutCatalogueSchemaState(database: D1Database): D1Database {
  return new Proxy(database, {
    get(database, property, receiver) {
      if (property === "prepare") {
        return (query: string) => database.prepare(query.replace("catalogue_schema_state", "missing_schema_state"));
      }
      return Reflect.get(database, property, receiver);
    },
  });
}

export function crashAfterRetryTerminalDatabase(database: D1Database): D1Database {
  let batchCount = 0;
  let terminated = false;
  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          if (terminated) {
            throw new Error("injected termination after retry terminal commit");
          }
          return target.prepare(query);
        };
      }
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          batchCount += 1;
          const result = await target.batch(statements);
          if (batchCount === 6) {
            terminated = true;
            throw new Error("injected termination after retry terminal commit");
          }
          return result;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function countDeletionResponseQueriesDatabase(database: D1Database): {
  database: D1Database;
  responseQueries: () => number;
} {
  let responseQueryCount = 0;
  return {
    database: new Proxy(database, {
      get(target, property) {
        if (property === "prepare") {
          return (query: string) => {
            if (
              query.includes("SELECT confirmation_response_json FROM catalogue_export_deletions WHERE id = ?") ||
              query.includes(
                "SELECT response_json FROM catalogue_export_deletion_retries WHERE idempotency_key = ? AND deletion_id = ?",
              )
            ) {
              responseQueryCount += 1;
            }
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    responseQueries: () => responseQueryCount,
  };
}

export async function capturePublicationGuard(database: D1Database) {
  const definition = await readSqliteMasterSql(database).first<{ sql: string }>();
  return definition === null ? null : { ...definition, restore: () => database.prepare(definition.sql) };
}

export function failSnapshotCommitFor(database: D1Database, requestId: string): D1PreparedStatement {
  return database.prepare(
    `CREATE TRIGGER fail_batch_snapshot_commit
     BEFORE INSERT ON source_snapshots
     WHEN NEW.request_id = '${requestId}'
     BEGIN
       SELECT RAISE(FAIL, 'synthetic_batch_commit_outage');
     END`,
  );
}
