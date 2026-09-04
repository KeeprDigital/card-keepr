// Adapt real synchronous SQLite for D1 read contracts; no database behavior is mocked.
export function d1Adapter(database) {
  return {
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
      return prepared;
    },
  };
}
