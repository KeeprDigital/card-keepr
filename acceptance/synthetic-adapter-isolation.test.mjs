import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import * as queries from "./helpers/query-helpers/adapter-isolation.mjs";

async function fixture(t) {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  let retirement;
  for (const file of (await readdir(new URL("../migrations", import.meta.url)))
    .filter((file) => file.endsWith(".sql"))
    .sort()) {
    const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
    if (file.startsWith("0013_")) retirement = sql;
    else if (Number.parseInt(file, 10) < 13) database.exec(sql);
  }
  assert.ok(retirement, "guarded fixture-adapter retirement migration exists");
  return { database, retirement };
}

test("fixture retirement leaves only production registration rows and preserves real authority", async (t) => {
  const { database, retirement } = await fixture(t);
  await queries.seedEvidence(database);
  const before = queries.snapshot(database);
  const production = queries.productionRegistrations(database).all();
  assert.equal(queries.syntheticRegistrations(database).all().length, 8);
  database.exec(retirement);
  assert.deepEqual(queries.syntheticRegistrations(database).all(), []);
  assert.deepEqual(queries.productionRegistrations(database).all(), production);
  assert.equal(queries.schemaLevel(database).get().migration_level, 13);
  const evidence = (snapshot) =>
    snapshot.filter(({ name }) => !["source_adapter_versions", "catalogue_schema_state"].includes(name));
  assert.deepEqual(evidence(queries.snapshot(database)), evidence(before));
  assert.deepEqual(queries.foreignKeyViolations(database).all(), []);
  const after = queries.snapshot(database);
  assert.throws(() => database.exec(retirement), /malformed JSON/);
  assert.deepEqual(queries.snapshot(database), after);
});

for (const field of [
  "planOrigin",
  "planAdapter",
  "snapshotAdapter",
  "parseAdapter",
  "observationAdapter",
  "partitionAdapter",
]) {
  test(`fixture retirement rejects synthetic ${field} without changing retained data`, async (t) => {
    const { database, retirement } = await fixture(t);
    await queries.seedEvidence(database, {
      [field]: field === "planOrigin" ? "synthetic_fixture" : "fixture-one-piece-json@3",
    });
    assert.deepEqual(queries.foreignKeyViolations(database).all(), []);
    const before = queries.snapshot(database);
    assert.throws(() => database.exec(retirement), /synthetic_adapter_retirement_requires_regeneration/);
    assert.deepEqual(queries.snapshot(database), before);
    assert.equal(queries.schemaLevel(database).get().migration_level, 12);
  });
}
