import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { unstable_splitSqlQuery } from "wrangler";
import { nativeRecoveryCloudflare } from "./helpers/native-recovery-cloudflare.mjs";
import { nativeRecoveryExportSql } from "./helpers/native-recovery-export.mjs";
import * as recoveryQueries from "./helpers/query-helpers/native-recovery-export.mjs";

test("native recovery restores rows when their guard reads a later view and preserves the guard", () => {
  // Minimal export shape from #329: a retained row precedes the guard's view.
  const laterViewGuardExport = `
  CREATE TABLE source_parse_contexts (parse_operation_id TEXT PRIMARY KEY);
  CREATE TRIGGER handoff_fence_source_parse_contexts_insert BEFORE INSERT ON source_parse_contexts
    WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
    BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
  INSERT INTO source_parse_contexts VALUES('retained-parse');
  CREATE VIEW fresh_baseline_mutation_fence AS SELECT 1 AS blocked;
`;
  const original = new DatabaseSync(":memory:");
  const restored = new DatabaseSync(":memory:");
  try {
    assert.throws(() => original.exec(laterViewGuardExport), /no such table: main.fresh_baseline_mutation_fence/u);
    restored.exec(nativeRecoveryExportSql(laterViewGuardExport));
    assert.deepEqual(
      recoveryQueries
        .retainedParseIds(restored)
        .all()
        .map((row) => row.parse_operation_id),
      ["retained-parse"],
    );
    assert.throws(
      () => recoveryQueries.insertParseContext(restored).run("later-parse"),
      /fresh_baseline_mutation_fenced/u,
    );
  } finally {
    original.close();
    restored.close();
  }
});

test("native recovery export installs parent unique indexes before replaying composite foreign key rows", () => {
  // Minimal export shape from #276 staging attempt 4: a dump emits a child's
  // rows before the parent UNIQUE index its composite FOREIGN KEY targets.
  // D1 cannot disable foreign keys, so the replay must keep them enforced.
  const compositeParentExport = `
  CREATE TABLE source_observation_sets (id TEXT PRIMARY KEY, source_snapshot_id TEXT NOT NULL);
  INSERT INTO source_observation_sets VALUES('set-1','snapshot-1');
  CREATE TABLE reconciled_withdrawal_assertions (
    source_observation_id TEXT PRIMARY KEY,
    source_observation_set_id TEXT NOT NULL REFERENCES source_observation_sets(id),
    source_snapshot_id TEXT NOT NULL,
    FOREIGN KEY (source_observation_set_id, source_snapshot_id)
      REFERENCES source_observation_sets (id, source_snapshot_id)
  );
  INSERT INTO reconciled_withdrawal_assertions VALUES('observation-1','set-1','snapshot-1');
  CREATE UNIQUE INDEX source_observation_set_snapshot_identity
  ON source_observation_sets (id, source_snapshot_id);
`;
  const restored = new DatabaseSync(":memory:");
  try {
    restored.exec("PRAGMA foreign_keys=ON");
    restored.exec("BEGIN");
    restored.exec(nativeRecoveryExportSql(compositeParentExport));
    restored.exec("COMMIT");
    assert.deepEqual(
      recoveryQueries
        .retainedWithdrawalAssertionIds(restored)
        .all()
        .map((row) => row.source_observation_id),
      ["observation-1"],
    );
    assert.equal(
      recoveryQueries.retainedIndex(restored).get("source_observation_set_snapshot_identity").name,
      "source_observation_set_snapshot_identity",
    );
    recoveryQueries.insertWithdrawalAssertion(restored).run("observation-2", "set-1", "snapshot-1");
    assert.throws(
      () => recoveryQueries.insertWithdrawalAssertion(restored).run("observation-3", "set-1", "snapshot-other"),
      /FOREIGN KEY constraint failed/u,
    );
  } finally {
    restored.close();
  }
});

async function fixture(t, virtual = false) {
  const directory = await mkdtemp(join(tmpdir(), "native-export-check-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = new DatabaseSync(join(directory, "source.sqlite"));
  database.exec("CREATE TABLE catalogue_state(value TEXT NOT NULL)");
  database.prepare("INSERT INTO catalogue_state VALUES (?)").run("retained payload ".repeat(8000));
  if (virtual) database.exec("CREATE VIRTUAL TABLE forbidden_search USING fts5(value)");
  database.close();
  return directory;
}
async function exported(directory) {
  const worker = new Worker(new URL("./helpers/native-export-probe.mjs", import.meta.url), {
    workerData: { directory },
  });
  try {
    return await new Promise((resolve, reject) => {
      // This is a fixture CPU regression bound, not a network retry/timeout.
      // A separate worker lets the test detect a scan blocking the JS thread.
      const timer = setTimeout(() => reject(new Error("Native export probe exceeded five seconds")), 5000);
      worker.once("message", (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      worker.once("error", (/** @type {Error} */ error) => {
        clearTimeout(timer);
        reject(error);
      });
      worker.once("exit", (code) => {
        if (code !== 0) {
          clearTimeout(timer);
          reject(new Error(`Export probe exited ${code}`));
        }
      });
    });
  } finally {
    await worker.terminate();
  }
}
test("native export checks long retained SQL records without a quadratic scan and preserves their bytes", async (t) => {
  const result = await exported(await fixture(t));
  assert.equal(result.error, undefined);
  const restored = new DatabaseSync(":memory:");
  try {
    restored.exec(result.snapshot);
    assert.equal(restored.prepare("SELECT value FROM catalogue_state").get().value, "retained payload ".repeat(8000));
  } finally {
    restored.close();
  }
});
test("native export still rejects an actual virtual table", async (t) => {
  const result = await exported(await fixture(t, true));
  assert.match(result.error, /Export still contains virtual tables/);
});

test("native recovery export restores retained rows before enabling the original write fence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-recovery-export-"));
  const provider = nativeRecoveryCloudflare({ databaseDirectory: directory, directory });
  t.after(async () => {
    provider.close();
    await rm(directory, { recursive: true, force: true });
  });
  // Minimal retained schema and ordering from an export after accepted recovery:
  // the dump can emit existing triggers before the data guarded by those triggers.
  const exported = `
    CREATE TABLE operation_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton=1),
      recovery_restore_guard TEXT NOT NULL CHECK (recovery_restore_guard IN ('clear','blocked'))
    );
    CREATE TABLE ingestion_runs (id TEXT PRIMARY KEY);
    CREATE INDEX retained_run_case ON ingestion_runs(
      CASE WHEN id='retained-run' THEN 1 ELSE 0 END, id
    );
    CREATE TRIGGER recovery_fence_ingestion_runs_insert BEFORE INSERT ON ingestion_runs
    WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
    BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
    INSERT INTO operation_state VALUES(1,'blocked');
    INSERT INTO ingestion_runs VALUES('retained-run');
  `;
  const base = "https://api.cloudflare.com/client/v4/accounts/fixture/d1/database";
  const post = (url, body) => provider.fetch(new Request(url, { method: "POST", body: JSON.stringify(body) }));
  const created = await (await post(base, {})).json();
  const endpoint = `${base}/${created.result.uuid}/import`;
  const initialized = await (await post(endpoint, { action: "init" })).json();
  await provider.fetch(
    new Request(initialized.result.upload_url, { method: "PUT", body: nativeRecoveryExportSql(exported) }),
  );
  const restored = await (await post(endpoint, { action: "ingest" })).json();
  assert.equal(restored.result.status, "complete");
  assert.deepEqual(
    recoveryQueries
      .retainedRunIds(provider.target)
      .all()
      .map((row) => row.id),
    ["retained-run"],
  );
  assert.equal(recoveryQueries.recoveryRestoreGuard(provider.target).get().recovery_restore_guard, "blocked");
  assert.equal(recoveryQueries.retainedIndex(provider.target).get("retained_run_case").name, "retained_run_case");
  assert.throws(() => recoveryQueries.insertRun(provider.target).run("new-run"), /catalogue_recovery_writer_fenced/);
});

for (const parenthesized of [false, true]) {
  test(`native SQL splitter preserves a trigger with ${parenthesized ? "parenthesized CASE" : "=CASE"} and quoted keywords`, () => {
    const expression = "CASE WHEN NEW.value='start' THEN 'CASE END,); -- BEGIN' ELSE 'unexpected' END";
    const sql = `
      CREATE TABLE split_values(value TEXT);
      CREATE TRIGGER assign_case AFTER INSERT ON split_values WHEN NEW.value='start' BEGIN
        -- =CASE and END); in this comment are not SQL keywords.
        UPDATE split_values SET value=${parenthesized ? `(${expression})` : expression} WHERE rowid=NEW.rowid;
        /* (CASE END, BEGIN) must not close the trigger. */
        INSERT INTO split_values VALUES ('after CASE; END');
      END;
      INSERT INTO split_values VALUES ('start');
      INSERT INTO split_values VALUES ('tail');
    `;
    const statements = unstable_splitSqlQuery(sql);
    assert.equal(statements.length, 4);
    const database = new DatabaseSync(":memory:");
    try {
      for (const statement of statements) database.exec(statement);
      assert.deepEqual(
        recoveryQueries
          .retainedSplitValues(database)
          .all()
          .map((row) => row.value),
        ["CASE END,); -- BEGIN", "after CASE; END", "tail"],
      );
    } finally {
      database.close();
    }
  });
}

for (const [label, comment] of [
  ["block", "/* c */"],
  ["line", "-- c\n"],
]) {
  test(`native SQL splitter counts CASE once beside an immediate ${label} comment`, () => {
    const statements = unstable_splitSqlQuery(`SELECT CASE${comment} WHEN 1 THEN 2 ELSE 3 END; SELECT 4;`);
    assert.equal(statements.length, 2);
    const database = new DatabaseSync(":memory:");
    try {
      for (const statement of statements) database.exec(statement);
    } finally {
      database.close();
    }
  });
}

test("native SQL splitter closes CASE once before an immediate block comment inside a trigger", () => {
  const statements = unstable_splitSqlQuery(`
    CREATE TABLE split_values(value TEXT);
    CREATE TRIGGER assign_case AFTER INSERT ON split_values WHEN NEW.value='start' BEGIN
      UPDATE split_values SET value=CASE WHEN 1 THEN 'changed' ELSE 'unexpected' END/* c */ WHERE rowid=NEW.rowid;
      INSERT INTO split_values VALUES ('after-case');
    END;
    INSERT INTO split_values VALUES ('start');
    INSERT INTO split_values VALUES ('tail');
  `);
  assert.equal(statements.length, 4);
  const database = new DatabaseSync(":memory:");
  try {
    for (const statement of statements) database.exec(statement);
    assert.deepEqual(
      recoveryQueries
        .retainedSplitValues(database)
        .all()
        .map((row) => row.value),
      ["changed", "after-case", "tail"],
    );
  } finally {
    database.close();
  }
});

test("native SQL splitter preserves square-bracket keyword identifiers inside a trigger", () => {
  const statements = unstable_splitSqlQuery(`
    CREATE TABLE split_values([END] TEXT);
    CREATE TRIGGER quoted_keyword AFTER INSERT ON split_values BEGIN
      UPDATE split_values SET [END]='ok';
    END;
    INSERT INTO split_values VALUES ('start');
  `);
  assert.equal(statements.length, 3);
  const database = new DatabaseSync(":memory:");
  try {
    for (const statement of statements) database.exec(statement);
    assert.equal(recoveryQueries.retainedBracketValue(database).get().END, "ok");
  } finally {
    database.close();
  }
});

test("native SQL splitter preserves long and Unicode identifiers ending in compound keywords", () => {
  const statements = unstable_splitSqlQuery(`
    CREATE TABLE keyword_suffix_values (long_prefix_BEGIN TEXT, éCASE TEXT, long_prefix_END TEXT);
    CREATE TRIGGER preserve_keyword_suffixes AFTER INSERT ON keyword_suffix_values BEGIN
      UPDATE keyword_suffix_values SET long_prefix_BEGIN='begin', éCASE='case', long_prefix_END='end';
    END;
    INSERT INTO keyword_suffix_values VALUES ('initial', 'initial', 'initial');
  `);
  assert.equal(statements.length, 3);
  const database = new DatabaseSync(":memory:");
  try {
    for (const statement of statements) database.exec(statement);
    const row = recoveryQueries.retainedKeywordSuffixValues(database).get();
    assert.deepEqual([row.long_prefix_BEGIN, row.éCASE, row.long_prefix_END], ["begin", "case", "end"]);
  } finally {
    database.close();
  }
});
