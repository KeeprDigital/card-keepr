import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createServer } from "vite";
import { canTransitionIngestionRun, ingestionRunStates } from "../src/catalogue/shared/ingestion-run-state.ts";
import * as ingestionQueries from "./helpers/query-helpers/ingestion.mjs";
import { d1Adapter } from "./helpers/query-helpers/sqlite-d1-adapter.mjs";

async function repositoryTransition(t, database) {
  const vite = await createServer({
    root: resolve(import.meta.dirname, ".."),
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  t.after(() => vite.close());
  // Both capabilities must share the same module graph and store registry.
  const { catalogueStore, atomicRepositoryStatement, repositoryStatements } = await vite.ssrLoadModule(
    "/src/catalogue/shared/catalogue-store-repository.ts",
  );
  const { runTransitionGuardStatement } = await vite.ssrLoadModule(
    "/src/catalogue/shared/ingestion-guards-repository.ts",
  );
  const store = catalogueStore(d1Adapter(database));
  return async (from, to, failureCode) => {
    const statement = ingestionQueries
      .updateTransitionMatrixRun(repositoryStatements(store))
      .bind(to, failureCode, from);
    // Keeping the same state is not a transition. Every actual edge uses the
    // production repository guard, including its persisted termination facts.
    return store.batch([
      from === to
        ? statement
        : atomicRepositoryStatement(store, {
            statement,
            after: [runTransitionGuardStatement(store, { runId: "run", from, to })],
          }),
    ]);
  };
}

test("repository batches enforce all 726 Ingestion Run transition and termination combinations", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  // The transition-rule seam supplies valid unrelated approval and lock facts.
  // SQL runs in real SQLite, with no transition trigger or mocked guard result.
  database.exec(`CREATE TABLE ingestion_runs (id TEXT PRIMARY KEY, expected_current_revision_id TEXT);
  INSERT INTO ingestion_runs VALUES ('run','revision');
  CREATE TABLE ingestion_run_current (
    ingestion_run_id TEXT PRIMARY KEY, state TEXT NOT NULL, failure_code TEXT,
    candidate_digest TEXT, candidate_catalogue_digest TEXT, candidate_created_at TEXT,
    approval_deadline TEXT, terminal_at TEXT, approved_candidate_digest TEXT, approved_expected_revision_id TEXT, approved_at TEXT
  );
  CREATE TABLE ingestion_run_terminations (ingestion_run_id TEXT PRIMARY KEY);
  CREATE TABLE operation_state (singleton INTEGER, active_ingestion_run_id TEXT, recovery_health TEXT);
  INSERT INTO operation_state VALUES (1, 'run', 'healthy');
  CREATE TABLE catalogue_state (singleton INTEGER, current_revision_id TEXT);
  INSERT INTO catalogue_state VALUES (1, 'revision');`);
  const update = await repositoryTransition(t, database);
  let cases = 0;
  for (const from of ingestionRunStates) {
    for (const to of ingestionRunStates) {
      for (const terminationRecorded of [false, true]) {
        for (const failureCode of [null, "source_evidence_failed", "ingestion_run_terminated"]) {
          database.exec("DELETE FROM ingestion_run_current; DELETE FROM ingestion_run_terminations;");
          ingestionQueries.insertTransitionMatrixRun(database).run(from);
          if (terminationRecorded) database.exec("INSERT INTO ingestion_run_terminations VALUES ('run')");
          const message = `${from} -> ${to}; termination=${terminationRecorded}; failure=${failureCode}`;
          if (from === to || canTransitionIngestionRun(from, to, { terminationRecorded, failureCode })) {
            await assert.doesNotReject(() => update(from, to, failureCode), message);
            assert.equal(ingestionQueries.transitionMatrixRunState(database).get().state, to, message);
          } else {
            await assert.rejects(
              () => update(from, to, failureCode),
              /illegal_ingestion_transition|must name a legal state edge/u,
              message,
            );
            assert.equal(ingestionQueries.transitionMatrixRunState(database).get().state, from, message);
          }
          cases += 1;
        }
      }
    }
  }
  assert.equal(cases, 726);
});

test("a retained termination decision cannot fail a paused run with a missing failure code", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  for (const file of (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  }
  database.exec(`INSERT INTO ingestion_runs (
    id, started_at, expected_current_revision_id, idempotency_key
  ) VALUES ('run', '2026-09-04T00:00:00.000Z', 'catrev_spine_000', 'start_run');
  INSERT INTO ingestion_run_current (ingestion_run_id, state, last_event_sequence, last_event_id, completed_stage_count)
  VALUES ('run', 'paused', 1, 'guard-fixture', 1);
  UPDATE operation_state SET active_ingestion_run_id = 'run' WHERE singleton = 1;
  INSERT INTO ingestion_run_terminations VALUES (
    'run', 'owner_requested', '2026-09-04T00:01:00.000Z', '2026-09-04T00:02:00.000Z', 'terminate_run', '${"a".repeat(64)}', '{}'
  );`);
  const update = await repositoryTransition(t, database);
  await assert.rejects(() => update("paused", "failed", null), /illegal_ingestion_transition/u);
  assert.equal(ingestionQueries.transitionMatrixRunState(database).get().state, "paused");
  await assert.doesNotReject(() => update("paused", "failed", "ingestion_run_terminated"));
  assert.equal(ingestionQueries.transitionMatrixRunState(database).get().state, "failed");
});
