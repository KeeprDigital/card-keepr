// Adapt real synchronous SQLite for D1 contracts; batches use one native transaction.
export function d1Adapter(database) {
  const executions = new WeakMap();
  return {
    async batch(statements) {
      database.exec("BEGIN");
      try {
        const results = statements.map((statement) => executions.get(statement)());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    prepare(sql) {
      let bindings = [];
      const prepared = {
        bind(...values) {
          bindings = values;
          return prepared;
        },
        async all() {
          return { results: database.prepare(sql).all(...bindings) };
        },
        async first() {
          return database.prepare(sql).get(...bindings) ?? null;
        },
      };
      executions.set(prepared, () => {
        const statement = database.prepare(sql);
        if (statement.columns().length > 0) {
          return { success: true, results: statement.all(...bindings), meta: {} };
        }
        const result = statement.run(...bindings);
        return { success: true, results: [], meta: { changes: result.changes, last_row_id: result.lastInsertRowid } };
      });
      return prepared;
    },
  };
}
