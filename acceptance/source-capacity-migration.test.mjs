import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import * as queries from "./helpers/query-helpers/source-capacity-migration.mjs";
import * as schema from "./helpers/query-helpers/schema.mjs";

test("capacity migration preserves populated source dependencies, decisions and fences", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys=ON");
    const root = new URL("../migrations/", import.meta.url);
    for (const name of (await readdir(root))
      .filter((name) => name.endsWith(".sql") && Number.parseInt(name, 10) < 36)
      .sort()) {
      database.exec("BEGIN");
      database.exec(await readFile(new URL(name, root), "utf8"));
      database.exec("COMMIT");
    }
    assert.equal(schema.schemaMigrationLevel(database).get().migration_level, 35);
    for (const statement of queries.seedRetainedSourceHistory(database)) statement.run();
    queries.insertCapacityExtension(database).run(2, 20000, "before-capacity-migration", "a".repeat(64));
    const before = schema.seedRows(database);
    const foreignKeys = queries.inboundForeignKeys(database).all();
    const definitions = () =>
      schema
        .schemaDefinitionRows(database)
        .all()
        .filter(
          ({ type, name }) =>
            type === "trigger" || type === "view" || (type === "index" && !name.startsWith("source_requests_pending_")),
        );
    const retainedDefinitions = definitions();
    assert.throws(() => queries.insertAdapter(database).run("before-large@1", 249999), /CHECK constraint/u);
    database.exec("BEGIN");
    const migration = await readFile(new URL("0036_source_collection_capacity.sql", root), "utf8");
    database.exec(migration);
    database.exec("COMMIT");
    assert.equal(schema.schemaMigrationLevel(database).get().migration_level, 36);
    database.exec("BEGIN");
    assert.throws(() => database.exec(migration), /malformed JSON/u);
    database.exec("ROLLBACK");
    assert.equal(schema.schemaMigrationLevel(database).get().migration_level, 36);
    assert.deepEqual(schema.seedRows(database), before);
    assert.deepEqual(queries.inboundForeignKeys(database).all(), foreignKeys);
    assert.deepEqual(definitions(), retainedDefinitions);
    assert.throws(() => queries.mutateRetainedAdapter(database).run(), /source_adapter_version_immutable/u);
    assert.throws(() => queries.mutateRetainedExtension(database).run(), /capacity_extension_immutable/u);
    assert.throws(() => queries.deleteRetainedExtension(database).run(), /capacity_extension_immutable/u);
    assert.throws(() => queries.insertAdapter(database).run("ceiling@1", 250000), /CHECK constraint/u);
    assert.throws(
      () => queries.insertCapacityExtension(database).run(3, 250000, "ceiling", "b".repeat(64)),
      /CHECK constraint/u,
    );
    queries.insertAdapter(database).run("last-valid@1", 249999);
    queries.insertCapacityExtension(database).run(3, 249999, "last-valid", "c".repeat(64));
    queries.recoveryFence(database).run("blocked");
    assert.throws(() => queries.insertAdapter(database).run("fenced@1", 12000), /catalogue_recovery_writer_fenced/u);
    assert.throws(
      () => queries.insertCapacityExtension(database).run(4, 22000, "fenced", "d".repeat(64)),
      /catalogue_recovery_writer_fenced/u,
    );
    queries.recoveryFence(database).run("clear");
    assert.deepEqual(schema.foreignKeyViolations(database).all(), []);
    assert.equal(schema.integrityCheck(database).get().integrity_check, "ok");
  } finally {
    database.close();
  }
});
