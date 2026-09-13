import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import test from "node:test";

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
