import assert from "node:assert/strict";
import { test } from "vitest";
import {
  captureCompositionSnapshot,
  verifyCompositionSnapshot,
} from "../../src/catalogue/backup-recovery/composition-verification.ts";

// Verification-provider seam: fixed source evidence and an independently mutated
// restore response exercise the streaming census without a Worker or R2 runtime.
function snapshotProvider() {
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
        return (rows.get(request.table) ?? []).filter((row) => row.snapshot_rowid > request.after).slice(0, 1);
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
