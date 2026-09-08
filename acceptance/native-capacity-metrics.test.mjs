import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { onePieceEvidenceMetrics } from "./helpers/one-piece-evidence-metrics.mjs";
import { nativeRetainedOccupancy, operationalCapacityMetrics } from "./helpers/native-capacity-metrics.mjs";

test("storage census includes automatic indexes and separates retained rows from allocations", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-capacity-census-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = new DatabaseSync(join(directory, "catalogue.sqlite"));
  database.exec(
    "CREATE TABLE catalogue_state (id TEXT PRIMARY KEY, value TEXT UNIQUE); INSERT INTO catalogue_state VALUES ('one','two');",
  );
  const pages = database
    .prepare("SELECT sum(pgsize) AS bytes FROM dbstat WHERE name LIKE 'sqlite_autoindex_%'")
    .get().bytes;
  database.close();
  const report = await onePieceEvidenceMetrics(directory, "", new Map(), [], 0, {}, {});
  const autoindexes = Object.entries(report.storage).filter(([name]) => name.startsWith("sqlite_autoindex_"));
  assert.equal(autoindexes.length, 2);
  assert.equal(
    autoindexes.reduce((sum, [, entry]) => sum + entry.allocated_page_bytes, 0),
    pages,
  );
  assert.equal(report.storage.catalogue_state.rows, 1);
  await writeFile(join(directory, "image.bin"), Buffer.alloc(1024));
  const occupancy = await nativeRetainedOccupancy(directory);
  assert.equal(occupancy.by_directory["image.bin"].logical_bytes, 1024);
  assert.ok(occupancy.logical_bytes > 1024);
});

test("operational census counts retries and observed owner routes without inventing SQL executions", () => {
  const row = {
    contract: "card-keepr-operational-log@1",
    event: "request.completed",
    runtime: "ingestion",
    request: { method: "POST", route: "/v1/publications" },
    status: 202,
    duration_ms: 12,
    d1: { prepared_statements: 3, batch_calls: 1, batch_statements: 2 },
  };
  const report = operationalCapacityMetrics(
    [
      JSON.stringify(row),
      JSON.stringify({ ...row, status: 503, duration_ms: 24 }),
      '{"contract":"card-keepr-operational-log@1"',
    ].join("\n"),
  );
  assert.equal(report.malformed_records, 1);
  const group = report.groups["ingestion:request.completed:POST:/v1/publications"];
  assert.equal(group.count, 2);
  assert.equal(group.failures, 1);
  assert.deepEqual(group.elapsed_ms, { sum: 36, maximum: 24, p95: 24 });
  assert.deepEqual(group.d1, { prepared_statements: 6, batch_calls: 2, batch_statements: 4 });
});
