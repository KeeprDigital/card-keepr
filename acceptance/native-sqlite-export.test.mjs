import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createExportEvidence,
  insertExportEvidence,
  countExportEvidence,
  exportEvidenceById,
} from "./helpers/query-helpers/sql-export-fixture.mjs";
import { nativeSqliteExport } from "./helpers/native-sqlite-export.mjs";

test("native SQL export preserves evidence beyond the old 64 MiB stdout ceiling", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-sql-export-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "source.sqlite");
  const db = new DatabaseSync(path);
  createExportEvidence(db).run();
  const insert = insertExportEvidence(db);
  for (let id = 0; id < 65; id++) insert.run(id, "x".repeat(1024 * 1024));
  insert.run(65, "last retained fact");
  db.close();
  await assert.rejects(nativeSqliteExport(path, join(directory, "missing", "export.sql")), { code: "ENOENT" });
  const sql = await nativeSqliteExport(path, join(directory, "export.sql"));
  assert.ok(Buffer.byteLength(sql) > 64 * 1024 * 1024);
  const restored = new DatabaseSync(":memory:");
  try {
    restored.exec(sql);
    assert.equal(countExportEvidence(restored).get().n, 66);
    assert.equal(exportEvidenceById(restored).get(65).body, "last retained fact");
  } finally {
    restored.close();
  }
});
