import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createServer } from "vite";
import { d1Adapter } from "./helpers/query-helpers/sqlite-d1-adapter.mjs";
import * as capacity from "./helpers/query-helpers/source-capacity-migration.mjs";
import * as schema from "./helpers/query-helpers/schema.mjs";
import { limitlessRegistration } from "./helpers/query-helpers/limitless-registration-migration.mjs";
import {
  completeCollection,
  removeReservation,
  stalePredecessor,
} from "./helpers/query-helpers/scryfall-registration-migration.mjs";

const root = new URL("../migrations/", import.meta.url);
const migrationName = "0043_limitless_full_scope_capacity.sql";
// Dated census envelope of the retained 2026-09-21 Products/Promos bucket bodies.
const declaredCapacity = 9_559;
const registration = {
  adapter_version: "limitless-one-piece-en@1",
  source_lineage: "limitless-one-piece-en",
  supported_game: "one-piece",
  game_profile_version: "one-piece@1",
  parser_contract: "limitless-one-piece-p001-html@1",
  adapter_origin: "production",
};

test("the forward Limitless migration retains its identity and selects the census capacity", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  for (const name of (await readdir(root))
    .filter((name) => name.endsWith(".sql") && Number.parseInt(name, 10) <= 43)
    .sort()) {
    database.exec("BEGIN");
    database.exec(await readFile(new URL(name, root), "utf8"));
    database.exec("COMMIT");
  }
  assert.equal(schema.schemaMigrationLevel(database).get().migration_level, 43);
  assert.deepEqual(
    { ...limitlessRegistration(database).get() },
    { ...registration, request_capacity: declaredCapacity },
  );
});

test("the Limitless capacity change protects resumable collections and retained history atomically", async (t) => {
  const predecessors = await Promise.all(
    (await readdir(root))
      .filter((name) => name.endsWith(".sql") && Number.parseInt(name, 10) < 43)
      .sort()
      .map((name) => readFile(new URL(name, root), "utf8")),
  );
  const migration = await readFile(new URL(migrationName, root), "utf8");
  const vite = await createServer({ logLevel: "silent", server: { middlewareMode: true } });
  t.after(() => vite.close());
  const { seedRunFixtureStatement } = await vite.ssrLoadModule("/apps/ingestion/test/query-helpers/run-events.ts");
  const { validateEvidencePlan } = await vite.ssrLoadModule("/src/catalogue/source-evidence/source-evidence-model.ts");
  const { requiredSourceAdapter } = await vite.ssrLoadModule("/src/catalogue/adapters/index.ts");
  const at = "2026-09-21T00:00:00.000Z";
  const example = JSON.parse(
    await readFile(new URL("../docs/examples/one-piece-five-card-plan.json", import.meta.url), "utf8"),
  );
  const { plan: limitless } = await validateEvidencePlan({
    ...example.plans.find((plan) => plan.source_lineage === "limitless-one-piece-en"),
    idempotency_key: "migration-limitless-plan",
  });
  const { plan: other } = await validateEvidencePlan({
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "one-piece-en@6",
    idempotency_key: "migration-other-plan",
    requests: [{ id: "one-piece-en:discovery", url: requiredSourceAdapter("one-piece-en@6").requestUrlForDiscovery() }],
  });
  function fresh(context) {
    const database = new DatabaseSync(":memory:");
    context.after(() => database.close());
    database.exec("PRAGMA foreign_keys=ON");
    for (const sql of predecessors) {
      database.exec("BEGIN");
      database.exec(sql);
      database.exec("COMMIT");
    }
    return database;
  }
  async function seed(
    database,
    { state = "collecting", shape = "single", reservation = true, completed = false } = {},
  ) {
    const id = "retained-limitless";
    await seedRunFixtureStatement(d1Adapter(database), {
      id,
      state,
      selected_games_json: '["one-piece"]',
      started_at: at,
      failure_code: state === "failed" ? "retained_failure" : null,
      terminal_at: ["published", "rejected", "expired", "failed"].includes(state) ? at : null,
    }).run();
    const first = shape === "single" ? limitless : other;
    const document = shape === "composed" ? { plans: [other, limitless] } : shape === "other" ? other : limitless;
    capacity.insertEvidencePlan(database).run({
      ingestion_run_id: id,
      source_lineage: first.source_lineage,
      supported_game: first.supported_game,
      game_profile_version: first.game_profile_version,
      adapter_version: first.adapter_version,
      request_plan_json: JSON.stringify(document),
    });
    if (completed) completeCollection(database).run(at, id);
    if (!reservation) removeReservation(database).run(id);
    return id;
  }
  function refused(database, pattern = /malformed JSON/u) {
    const rows = schema.seedRows(database),
      definitions = schema.schemaObjectRows(database).all();
    const level = schema.schemaMigrationLevel(database).get().migration_level;
    database.exec("BEGIN");
    try {
      assert.throws(() => database.exec(migration), pattern);
    } finally {
      database.exec("ROLLBACK");
    }
    assert.equal(schema.schemaMigrationLevel(database).get().migration_level, level);
    assert.deepEqual(schema.seedRows(database), rows);
    assert.deepEqual(schema.schemaObjectRows(database).all(), definitions);
  }
  function migrated(database) {
    const before = schema.seedRows(database),
      definitions = schema.schemaObjectRows(database).all();
    database.exec("BEGIN");
    try {
      database.exec(migration);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    const after = schema.seedRows(database);
    assert.equal(schema.schemaMigrationLevel(database).get().migration_level, 43);
    assert.deepEqual(
      { ...limitlessRegistration(database).get() },
      { ...registration, request_capacity: declaredCapacity },
    );
    const withoutLimitless = (rows) =>
      rows.filter((row) => JSON.parse(row).adapter_version !== registration.adapter_version);
    assert.deepEqual(withoutLimitless(after.source_adapter_versions), withoutLimitless(before.source_adapter_versions));
    delete before.source_adapter_versions;
    delete after.source_adapter_versions;
    assert.deepEqual(after, before);
    assert.deepEqual(schema.schemaObjectRows(database).all(), definitions);
    assert.deepEqual(schema.foreignKeyViolations(database).all(), []);
    assert.equal(schema.integrityCheck(database).get().integrity_check, "ok");
    assert.throws(
      () => capacity.mutateRetainedAdapter(database).run(declaredCapacity + 1, registration.adapter_version),
      /source_adapter_version_immutable/u,
    );
  }
  for (const shape of ["single", "composed"]) {
    for (const state of ["planning", "collecting", "paused"]) {
      await t.test(`${shape} ${state} Limitless collection is refused`, async (context) => {
        const database = fresh(context);
        await seed(database, { shape, state, reservation: state !== "paused" });
        refused(database);
      });
    }
  }
  await t.test("a resumable Limitless collection without its reservation is still refused", async (context) => {
    const database = fresh(context);
    await seed(database, { state: "collecting", reservation: false });
    refused(database);
  });
  await t.test("another One Piece adapter's collection is not mistaken for Limitless", async (context) => {
    const database = fresh(context);
    await seed(database, { shape: "other" });
    migrated(database);
  });
  await t.test("parsing requires recorded collection completion", async (context) => {
    const database = fresh(context);
    await seed(database, { state: "parsing", reservation: false });
    refused(database);
    completeCollection(database).run(at, "retained-limitless");
    migrated(database);
  });
  for (const state of ["published", "failed"]) {
    await t.test(`${state} Limitless history remains safe with a retained reservation`, async (context) => {
      const database = fresh(context);
      await seed(database, { state });
      migrated(database);
    });
  }
  await t.test("an empty catalogue migrates and restores the registration immutability trigger", (context) => {
    const database = fresh(context);
    migrated(database);
  });
  await t.test("recovery rejection after the trigger drop restores every row and definition", (context) => {
    const database = fresh(context);
    capacity.recoveryFence(database).run("blocked");
    refused(database, /catalogue_recovery_writer_fenced/u);
    capacity.recoveryFence(database).run("clear");
    assert.throws(
      () => capacity.mutateRetainedAdapter(database).run(101, registration.adapter_version),
      /source_adapter_version_immutable/u,
    );
  });
  await t.test("stale schema and changed registration predecessors are refused atomically", (context) => {
    const database = fresh(context);
    schema.setUnexpectedSchemaLevel(database).run();
    refused(database);
    stalePredecessor(database).run(42);
    migrated(database);
    refused(database);
    stalePredecessor(database).run(42);
    refused(database);
  });
});
