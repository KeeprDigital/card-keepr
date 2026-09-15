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
