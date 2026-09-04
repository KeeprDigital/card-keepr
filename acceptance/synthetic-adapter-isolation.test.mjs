import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import * as queries from "./helpers/query-helpers/adapter-isolation.mjs";

test("the production baseline seeds only shipped Source Adapter Versions", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec(await readFile(new URL("../migrations/0001_baseline.sql", import.meta.url), "utf8"));
  assert.deepEqual(queries.syntheticRegistrations(database).all(), []);
  assert.equal(queries.productionRegistrations(database).all().length, 6);
  assert.equal(queries.schemaLevel(database).get().migration_level, 1);
  await queries.seedEvidence(database);
  assert.deepEqual(queries.foreignKeyViolations(database).all(), []);
});
