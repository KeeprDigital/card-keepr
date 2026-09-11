import assert from "node:assert/strict";
import { test } from "vitest";
import {
  captureCompositionSnapshot,
  verifyCompositionSnapshot,
} from "../../src/catalogue/backup-recovery/composition-verification.ts";

// Verification-provider seam: fixed source evidence and an independently mutated
// restore response exercise the streaming census without a Worker or R2 runtime.
function snapshotProvider(pageSize = 1) {
  const rows = new Map([
    ["catalogue_exports", [{ snapshot_rowid: 1, catalogue_revision_id: "old", maintenance_state: "deleted" }]],
    ["catalogue_export_deletion_plans", [{ snapshot_rowid: 1, id: "plan", component_names_json: '["digimon.0"]' }]],
    ["catalogue_export_deletions", [{ snapshot_rowid: 1, id: "deletion", state: "deleted", plan_id: "plan" }]],
    [
      "catalogue_export_deletion_tombstones",
      [{ snapshot_rowid: 1, catalogue_revision_id: "old", deletion_id: "deletion", manifest_digest: "a".repeat(64) }],
    ],
    [
      "catalogue_export_deletion_retries",
      [{ snapshot_rowid: 1, idempotency_key: "retry", deletion_id: "deletion", response_json: '{"state":"deleted"}' }],
    ],
  ]);
  return {
    rows,
    query: async (request) => {
      if (request.kind === "composition-state")
        return [
          {
            id: "current",
            content_digest: "b".repeat(64),
            publication_operation_id: "publication_current",
            ingestion_run_id: "source",
            migration_level: 23,
            members: 1,
            cards: 1,
            products: 0,
            missing_search: 0,
            missing_lifecycle: 0,
            search_state: "ready",
          },
        ];
      if (request.kind === "composition-page")
        return (rows.get(request.table) ?? []).filter((row) => row.snapshot_rowid > request.after).slice(0, pageSize);
      if (request.kind === "composition-columns")
        return Object.keys(rows.get(request.table)?.[0] ?? { id: null })
          .filter((name) => name !== "snapshot_rowid")
          .map((name) => ({ name }));
      return [];
    },
  };
}

for (const table of [
  "catalogue_exports",
  "catalogue_export_deletion_plans",
  "catalogue_export_deletions",
  "catalogue_export_deletion_tombstones",
  "catalogue_export_deletion_retries",
]) {
  test(`restored deletion authority rejects missing ${table} evidence`, async () => {
    const source = snapshotProvider(),
      restored = snapshotProvider();
    const expected = await captureCompositionSnapshot(source.query, "current");
    assert.ok(expected);
    await verifyCompositionSnapshot(restored.query, expected);
    restored.rows.delete(table);
    await assert.rejects(verifyCompositionSnapshot(restored.query, expected), /Restored composition snapshot differs/);
  });
}

for (const [table, field, value] of [
  ["catalogue_export_deletion_tombstones", "manifest_digest", "c".repeat(64)],
  ["catalogue_export_deletion_plans", "component_names_json", '["digimon.unknown"]'],
  ["catalogue_exports", "maintenance_state", "available"],
]) {
  test(`restored deletion authority rejects changed ${field}`, async () => {
    const source = snapshotProvider(),
      restored = snapshotProvider();
    const expected = await captureCompositionSnapshot(source.query, "current");
    assert.ok(expected);
    restored.rows.get(table)[0][field] = value;
    await assert.rejects(verifyCompositionSnapshot(restored.query, expected), /Restored composition snapshot differs/);
  });
}

test("batched private authority census preserves every ordered row and detects a changed restore", async () => {
  const single = snapshotProvider(),
    batched = snapshotProvider(4);
  const rows = [1, 3, 4, 9, 10, 14, 18].map((snapshot_rowid) => ({
    snapshot_rowid,
    content: JSON.stringify({ ordinal: snapshot_rowid }),
    sha256: "a".repeat(64),
  }));
  single.rows.set("reconciliation_checkpoints", structuredClone(rows));
  batched.rows.set("reconciliation_checkpoints", structuredClone(rows));
  let privateQueries = 0;
  const expected = await captureCompositionSnapshot(single.query, "current");
  const actual = await captureCompositionSnapshot(async (request) => {
    if (request.kind === "composition-page" && request.table === "reconciliation_checkpoints") privateQueries++;
    return batched.query(request);
  }, "current");
  assert.equal(privateQueries, 3);
  assert.deepEqual(actual, expected);
  assert.equal(actual.tables.find((entry) => entry.table === "reconciliation_checkpoints").rows, 7);
  batched.rows.get("reconciliation_checkpoints")[2].content = "changed";
  await assert.rejects(verifyCompositionSnapshot(batched.query, expected), /Restored composition snapshot differs/);
});

test("private snapshot pages reject oversized payloads and repeated cursors", async () => {
  const oversized = snapshotProvider(4);
  oversized.rows.set("reconciliation_checkpoints", [{ snapshot_rowid: 1, content: "x".repeat(1_048_576) }]);
  await assert.rejects(captureCompositionSnapshot(oversized.query, "current"), /byte budget/);
  const repeated = snapshotProvider(4);
  repeated.rows.set("reconciliation_checkpoints", [
    { snapshot_rowid: 1, content: "first" },
    { snapshot_rowid: 1, content: "second" },
  ]);
  await assert.rejects(captureCompositionSnapshot(repeated.query, "current"), /Invalid snapshot cursor/);
});

test("bounded snapshot pages preserve the single-row digest across private and public tables", async () => {
  const single = snapshotProvider(),
    batched = snapshotProvider(16);
  for (const table of ["reconciliation_reducer_state", "publication_query_documents", "staging_object_writes"]) {
    const rows = Array.from({ length: 33 }, (_, index) => ({ snapshot_rowid: index * 2 + 1, content: `row ${index}` }));
    single.rows.set(table, structuredClone(rows));
    batched.rows.set(table, structuredClone(rows));
  }
  const expected = await captureCompositionSnapshot(single.query, "current");
  assert.deepEqual(await captureCompositionSnapshot(batched.query, "current"), expected);
  batched.rows.get("publication_query_documents")[17].content = "changed";
  await assert.rejects(verifyCompositionSnapshot(batched.query, expected), /snapshot differs/);
});

test("snapshot SQL pages every UTF-8 row and preserves a single large legacy row", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { compositionVerificationQuery } =
    await import("../../src/catalogue/backup-recovery/composition-verification-repository.ts");
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE publication_query_documents (id TEXT, content TEXT)");
    const insert = database.prepare("INSERT INTO publication_query_documents VALUES (?, ?)");
    for (let n = 0; n < 35; n++) insert.run(String(n), "界".repeat(n === 17 ? 400000 : 40000));
    const columnsQuery = compositionVerificationQuery({
      kind: "composition-columns",
      table: "publication_query_documents",
    });
    const columns = database
      .prepare(columnsQuery.sql)
      .all(...columnsQuery.params)
      .map((row) => row.name);
    const actual = [];
    let after = 0;
    let boundedPages = 0;
    for (;;) {
      const query = compositionVerificationQuery({
        kind: "composition-page",
        table: "publication_query_documents",
        after,
        columns,
      });
      const page = database.prepare(query.sql).all(...query.params);
      if (!page.length) break;
      assert.ok(page.length <= 16);
      const bytes = page.reduce((total, row) => total + Buffer.byteLength(JSON.stringify(row)), 0);
      assert.ok(bytes <= 1048576 || page.length === 1);
      if (page.length > 1 && page.length < 16) boundedPages++;
      actual.push(...page);
      after = page.at(-1).snapshot_rowid;
    }
    assert.ok(boundedPages > 1);
    assert.deepEqual(
      actual,
      database.prepare("SELECT rowid AS snapshot_rowid,* FROM publication_query_documents ORDER BY rowid").all(),
    );
  } finally {
    database.close();
  }
});

// Old snapshots hash one ordered schema entry at a time. Paging must preserve that exact digest.
test("schema pages preserve the single-entry snapshot and reject changed or malformed restore evidence", async () => {
  const base = snapshotProvider();
  const schema = Array.from({ length: 65 }, (_, n) => ({
    name: `table_${String(n).padStart(3, "0")}`,
    type: "table",
    sql: `CREATE TABLE t${n}(id TEXT)`,
  }));
  const source =
    (size, mutate = (page) => page) =>
    async (request) =>
      request.kind === "composition-schema"
        ? mutate(schema.filter((row) => row.name > request.after).slice(0, size))
        : base.query(request);
  const expected = await captureCompositionSnapshot(source(1), "current");
  let pages = 0;
  const batched = source(32);
  assert.deepEqual(
    await captureCompositionSnapshot(async (request) => {
      if (request.kind === "composition-schema") pages++;
      return batched(request);
    }, "current"),
    expected,
  );
  assert.equal(pages, 4);
  await assert.rejects(
    verifyCompositionSnapshot(
      source(32, (page) => page.map((row) => (row.name === "table_033" ? { ...row, sql: "changed" } : row))),
      expected,
    ),
    /snapshot differs/,
  );
  await assert.rejects(captureCompositionSnapshot(source(33), "current"), /row budget/);
  await assert.rejects(
    captureCompositionSnapshot(
      source(2, (page) => page.reverse()),
      "current",
    ),
    /Invalid schema snapshot cursor/,
  );
  await assert.rejects(
    captureCompositionSnapshot(
      source(1, (page) => page.map((row) => ({ ...row, sql: "x".repeat(1048576) }))),
      "current",
    ),
    /byte budget/,
  );
});

test("the SQLite schema query pages every entry within its row and UTF-8 byte bounds", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { compositionVerificationQuery, maximumSchemaSnapshotPageBytes } =
    await import("../../src/catalogue/backup-recovery/composition-verification-repository.ts");
  const database = new DatabaseSync(":memory:");
  try {
    for (let n = 0; n < 65; n++) database.exec(`CREATE TABLE t_${String(n).padStart(3, "0")}(id TEXT)`);
    for (let n = 0; n < 8; n++) database.exec(`CREATE VIEW wide_${n} AS SELECT '${"界".repeat(50000)}' AS text`);
    const expected = database
      .prepare("SELECT name,type,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name")
      .all();
    let after = "";
    const actual = [];
    let partialBytePage = false;
    for (;;) {
      const query = compositionVerificationQuery({ kind: "composition-schema", after });
      const page = database.prepare(query.sql).all(...query.params);
      if (!page.length) break;
      assert.ok(page.length <= 32);
      assert.ok(
        page.reduce((bytes, row) => bytes + Buffer.byteLength(JSON.stringify(row)), 0) <=
          maximumSchemaSnapshotPageBytes,
      );
      if (page.some((row) => row.name.startsWith("wide_")) && page.at(-1).name !== "wide_7") partialBytePage = true;
      actual.push(...page);
      after = page.at(-1).name;
    }
    assert.equal(partialBytePage, true);
    assert.deepEqual(actual, expected);
  } finally {
    database.close();
  }
});
