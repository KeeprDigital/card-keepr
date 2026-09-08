import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { onePieceEvidenceMetrics } from "./helpers/one-piece-evidence-metrics.mjs";
import {
  nativeOperationalTimeline,
  nativeRetainedOccupancy,
  operationalCapacityMetrics,
} from "./helpers/native-capacity-metrics.mjs";

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

test("phase timeline handles split streams, drops old events and excludes payload fields", () => {
  const timeline = nativeOperationalTimeline(2);
  const started = performance.now();
  const line = (step) =>
    JSON.stringify({
      contract: "card-keepr-operational-log@1",
      event: "workflow.step.completed",
      runtime: "ingestion",
      request: { method: "WORKFLOW", route: "/workflows/reconciliation", id: "private-id" },
      workflow: { step },
      duration_ms: 7,
      status: 200,
      payload: "secret-source-body",
    }) + "\n";
  const first = line("first");
  timeline.observe(first.slice(0, 20), "stdout");
  timeline.observe(line("second"), "stderr");
  timeline.observe(first.slice(20), "stdout");
  timeline.observe(line("third"), "stdout");
  timeline.observe('{"contract":"card-keepr-operational-log@1",broken}\n', "stdout");
  timeline.observe("x".repeat(65537), "stderr");
  timeline.observe(line("oversized-suffix"), "stderr");
  const report = timeline.snapshot(started);
  assert.deepEqual(
    report.events.map((event) => event.step),
    ["first", "third"],
  );
  assert.equal(report.dropped_events, 1);
  assert.equal(report.malformed_records, 1);
  assert.equal(report.oversized_lines, 1);
  assert.ok(report.events.every((event) => event.observed_elapsed_ms >= 0));
  assert.ok(!JSON.stringify(report).includes("secret-source-body"));
  assert.ok(!JSON.stringify(report).includes("private-id"));
  timeline.observe(line("after-discard"), "stderr");
  assert.equal(timeline.snapshot(started).events.at(-1).step, "after-discard");
});
