import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { adapterRetirementSql } from "../scripts/adapter-retirement-sql.mjs";
import { seedEvidence } from "./helpers/query-helpers/adapter-isolation.mjs";

test("retirement checks immutable event authority before treating a pinned run as terminal", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec(await readFile(new URL("../migrations/0001_baseline.sql", import.meta.url), "utf8"));
  await seedEvidence(database);
  const sql = await adapterRetirementSql(["one-piece-en@6"]);
  assert.equal(database.prepare(sql).all().length, 1);
  assert.deepEqual(database.prepare(await adapterRetirementSql(["gundam-asia@1"])).all(), []);
  database.exec("UPDATE ingestion_run_current SET state = 'failed'");
  assert.equal(database.prepare(sql).all().length, 1, "a corrupted terminal projection must still block");
  database.exec("DELETE FROM ingestion_run_current");
  assert.equal(database.prepare(sql).all().length, 1, "missing authority must still block");
});

test("a verified terminal run can release its adapter implementation", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec(await readFile(new URL("../migrations/0001_baseline.sql", import.meta.url), "utf8"));
  await seedEvidence(database, "failed");
  const sql = await adapterRetirementSql(["one-piece-en@6"]);
  assert.deepEqual(database.prepare(sql).all(), []);
  database.exec("UPDATE ingestion_run_selected_games SET game = 'gundam'");
  assert.equal(database.prepare(sql).all().length, 1, "changed birth selection must block terminal retirement");
});
