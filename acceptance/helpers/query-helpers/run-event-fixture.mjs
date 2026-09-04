import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Render the canonical fixture's actual expanded native batch. SQLite owns
 * binding serialization, so quoted JSON and numbered placeholders are preserved
 * without interpreting SQL or maintaining another run persistence recipe.
 */
export async function renderRunFixtureSql(vite, input) {
  const root = resolve(import.meta.dirname, "../../..");
  const scratch = new DatabaseSync(":memory:");
  try {
    const migrations = (await readdir(resolve(root, "migrations"))).filter((name) => name.endsWith(".sql")).sort();
    for (const migration of migrations) scratch.exec(await readFile(resolve(root, "migrations", migration), "utf8"));
    const rendered = [];
    const executions = new WeakMap();
    const database = {
      prepare(sql) {
        let bindings = [];
        const prepared = {
          bind(...values) {
            bindings = values;
            return prepared;
          },
        };
        executions.set(prepared, () => {
          const statement = scratch.prepare(sql);
          const result =
            statement.columns().length > 0
              ? { success: true, results: statement.all(...bindings), meta: {} }
              : (() => {
                  const result = statement.run(...bindings);
                  return {
                    success: true,
                    results: [],
                    meta: { changes: result.changes, last_row_id: result.lastInsertRowid },
                  };
                })();
          rendered.push(`${statement.expandedSQL};`);
          return result;
        });
        return prepared;
      },
      async batch(statements) {
        scratch.exec("BEGIN");
        try {
          const results = statements.map((statement) => executions.get(statement)());
          scratch.exec("COMMIT");
          return results;
        } catch (error) {
          scratch.exec("ROLLBACK");
          throw error;
        }
      },
    };
    const { seedRunFixtureStatement } = await vite.ssrLoadModule("/apps/ingestion/test/query-helpers/run-events.ts");
    await seedRunFixtureStatement(database, input).run();
    return rendered.join("\n");
  } finally {
    scratch.close();
  }
}
