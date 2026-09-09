import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { catalogueStore } from "../../src/catalogue/shared/catalogue-store-repository.ts";
import { publicationCheckpointStatement } from "../../src/catalogue/reconciliation/game-publication-repository.ts";
import { insertPendingBackupStatement } from "../../src/catalogue/backup-recovery/backup-repository.ts";
import { d1Adapter } from "../../acceptance/helpers/query-helpers/sqlite-d1-adapter.mjs";
import {
  seedAcceptanceCheckpoint,
  backupIdentity,
  markBackupVerified,
  removeAcceptanceHead,
} from "./query-helpers/native-no-change-checkpoint.mjs";

function retryInput(key, operation = "refresh", parent = "refresh-failed") {
  return {
    idempotencyKey: key,
    requestJson: JSON.stringify({ publication_operation_id: operation, catalogue_revision_id: "revision" }),
    ownerToken: key,
    expectedCurrentRevisionId: "revision",
    objectKey: `backups/${key}`,
    observedAt: "2026-09-09T00:00:00.000Z",
    linkedAttemptId: parent,
  };
}

test("latest accepted evidence waits for its own verified retry despite an older verified revision backup", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    seedAcceptanceCheckpoint(db);
    const store = catalogueStore(d1Adapter(db));
    const ready = async () => (await publicationCheckpointStatement(store, "revision").first()).ready;
    assert.equal(await ready(), 0);
    await insertPendingBackupStatement(store, retryInput("retry")).run();
    assert.deepEqual(
      { ...backupIdentity(db).get("retry") },
      {
        catalogue_revision_id: "revision",
        publication_operation_id: "refresh",
        publication_ingestion_run_id: "refresh-run",
        linked_attempt_id: "refresh-failed",
      },
    );
    assert.equal(await ready(), 0);
    markBackupVerified(db).run("retry");
    assert.equal(await ready(), 1);
    removeAcceptanceHead(db).run();
    assert.equal(await ready(), 0, "missing native acceptance metadata must not admit an older backup");
  } finally {
    db.close();
  }
});

test.each([
  ["wrong-operation", "original", "refresh-failed"],
  ["missing-parent", "refresh", "absent"],
  ["missing-operation", null, "refresh-failed"],
])("native backup retry rejects %s acceptance metadata", async (key, operation, parent) => {
  const db = new DatabaseSync(":memory:");
  try {
    seedAcceptanceCheckpoint(db);
    const store = catalogueStore(d1Adapter(db));
    await assert.rejects(
      () => insertPendingBackupStatement(store, retryInput(key, operation, parent)).run(),
      /backup_acceptance_metadata_mismatch/u,
    );
    assert.equal(backupIdentity(db).get(key), undefined);
  } finally {
    db.close();
  }
});
