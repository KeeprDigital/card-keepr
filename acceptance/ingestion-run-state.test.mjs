import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { canTransitionIngestionRun, ingestionRunStates } from "../src/catalogue/shared/ingestion-run-state.ts";
import * as ingestionQueries from "./helpers/query-helpers/ingestion.mjs";
import * as schemaQueries from "./helpers/query-helpers/schema.mjs";

test("the migrated database enforces the shared Ingestion Run transition table, including termination facts", async () => {
  const migrated = new DatabaseSync(":memory:");
  try {
    for (const file of (await readdir(new URL("../migrations/", import.meta.url)))
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      migrated.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
    }
    const { sql } = schemaQueries.ingestionTransitionTrigger(migrated).get();
    // Exercise the actual installed trigger independently of unrelated row,
    // publication, and provenance guards; this is the transition-rule seam.
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`CREATE TABLE ingestion_runs (id TEXT PRIMARY KEY, state TEXT NOT NULL, failure_code TEXT);
        CREATE TABLE ingestion_run_terminations (ingestion_run_id TEXT PRIMARY KEY);`);
      database.exec(sql);
      for (const from of ingestionRunStates) {
        for (const to of ingestionRunStates) {
          for (const terminationRecorded of [false, true]) {
            for (const failureCode of [null, "source_evidence_failed", "ingestion_run_terminated"]) {
              database.exec("DELETE FROM ingestion_runs; DELETE FROM ingestion_run_terminations;");
              ingestionQueries.insertTransitionMatrixRun(database).run(from);
              if (terminationRecorded) database.exec("INSERT INTO ingestion_run_terminations VALUES ('run')");
              const update = () => ingestionQueries.updateTransitionMatrixRun(database).run(to, failureCode);
              const message = `${from} -> ${to}; termination=${terminationRecorded}; failure=${failureCode}`;
              if (from === to || canTransitionIngestionRun(from, to, { terminationRecorded, failureCode })) {
                assert.doesNotThrow(update, message);
              } else {
                assert.throws(update, /illegal_ingestion_transition/u, message);
              }
            }
          }
        }
      }
    } finally {
      database.close();
    }
  } finally {
    migrated.close();
  }
});

test("a retained termination decision cannot fail a paused run with a missing failure code", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    for (const file of (await readdir(new URL("../migrations/", import.meta.url)))
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      database.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
    }
    database.exec(`INSERT INTO ingestion_runs (
      id, state, selected_games_json, started_at, expected_current_revision_id, idempotency_key, candidate_json
    ) VALUES ('run', 'planning', '["one-piece"]', '2026-09-04T00:00:00.000Z', 'catrev_spine_000', 'start_run', '{}');
    UPDATE operation_state SET active_ingestion_run_id = 'run' WHERE singleton = 1;
    UPDATE ingestion_runs SET state = 'collecting' WHERE id = 'run';
    UPDATE ingestion_runs SET state = 'paused' WHERE id = 'run';
    INSERT INTO ingestion_run_terminations VALUES (
      'run', 'owner_requested', '2026-09-04T00:01:00.000Z', '2026-09-04T00:02:00.000Z', 'terminate_run', '${"a".repeat(64)}', '{}'
    );`);
    assert.throws(
      () => database.exec("UPDATE ingestion_runs SET state = 'failed', failure_code = NULL WHERE id = 'run'"),
      /illegal_ingestion_transition/u,
    );
    assert.equal(ingestionQueries.transitionMatrixRunState(database).get().state, "paused");
  } finally {
    database.close();
  }
});
