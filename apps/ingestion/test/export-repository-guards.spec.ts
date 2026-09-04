import {
  failCatalogueExportDeletionStatement,
  insertCatalogueExportDeletionRetryStatement,
  claimCatalogueExportDeletionRetryStatement,
  catalogueExportDeletionRetryStatement,
} from "../../../src/catalogue/export/export-repository";
import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { catalogueStore } from "../../../src/catalogue/shared";
import {
  catalogueExportDeletionPlanInsertStatement,
  catalogueExportDeletionByIdStatement,
  insertCatalogueExportDeletionStatement,
  catalogueExportStatement,
  markCatalogueExportDeletingStatement,
} from "../../../src/catalogue/export/export-repository";
import {
  insertPendingBackupStatement,
  startBackupExportStatement,
  backupAttemptEvidenceStatement,
} from "../../../src/catalogue/backup-recovery/backup-repository";
import { seedApiRevision } from "../../api/test/api-fixtures";
import { insertCatalogueExports } from "./query-helpers/catalogue-export";
import { disableExportTransitionTriggers } from "./query-helpers/maintenance-guards";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
const database = catalogueStore(testEnv.CATALOGUE_DB);
const digest = "a".repeat(64);
const now = "2026-09-04T00:00:00.000Z";
let sequence = 0;

beforeEach(async () => {
  await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
  await disableExportTransitionTriggers(testEnv.CATALOGUE_DB);
});

test("export deletion rejects mismatched confirmed plan and rolls back earlier repository writes without triggers", async () => {
  const input = await deletionPlan();
  const control = `${input.deletionId}-control`;
  await insertPendingBackupStatement(database, {
    idempotencyKey: control,
    ownerToken: control,
    requestJson: "{}",
    expectedCurrentRevisionId: input.expectedCurrentRevisionId,
    objectKey: `${control}.sql`,
    observedAt: now,
    linkedAttemptId: null,
  }).run();
  await expect(
    database.batch([
      startBackupExportStatement(database, { idempotencyKey: control, ownerToken: control }),
      insertCatalogueExportDeletionStatement(database, {
        ...input,
        requestJson: JSON.stringify({
          ...JSON.parse(input.requestJson),
          confirmation_revision_id: input.expectedCurrentRevisionId,
        }),
      }),
    ]),
  ).rejects.toThrow("catalogue_export_deletion_guard_failed");
  await expect(
    catalogueExportDeletionByIdStatement(database, { deletionId: input.deletionId }).first(),
  ).resolves.toBeNull();
  await expect(backupAttemptEvidenceStatement(database, control).first()).resolves.toMatchObject({ state: "pending" });
});

test("export maintenance cannot begin without its matching deletion operation", async () => {
  const input = await deletionPlan();
  await expect(
    markCatalogueExportDeletingStatement(database, {
      deletion_id: "nonexistent",
      catalogue_revision_id: input.catalogueRevisionId,
    }).run(),
  ).rejects.toThrow("catalogue_export_maintenance_transition_invalid");
  await expect(catalogueExportStatement(database, input.catalogueRevisionId).first()).resolves.toMatchObject({
    maintenance_state: "available",
  });
});

async function deletionPlan() {
  const id = `export-guard-${++sequence}`;
  const revisionId = `catrev_${id}_old`;
  const currentId = `catrev_${id}_current`;
  await seedApiRevision({ revisionId, runId: `${id}-old`, cards: [] });
  await seedApiRevision({ revisionId: currentId, runId: `${id}-current`, cards: [] });
  await insertCatalogueExports(testEnv.CATALOGUE_DB).bind(revisionId, `${id}/manifest.json`, digest).run();
  await catalogueExportDeletionPlanInsertStatement(database, {
    id: `${id}-plan`,
    catalogue_revision_id: revisionId,
    manifest_digest: digest,
    expected_current_revision_id: currentId,
    object_keys_json: "[]",
    component_names_json: "[]",
    object_set_digest: digest,
    dependencies_json: "[]",
    plan_digest: String(sequence).padStart(64, "0"),
    created_at: now,
    expires_at: "2026-09-04T00:15:00.000Z",
  }).run();
  return {
    deletionId: id,
    planId: `${id}-plan`,
    catalogueRevisionId: revisionId,
    manifestDigest: digest,
    expectedCurrentRevisionId: currentId,
    objectSetDigest: digest,
    idempotencyKey: `${id}-key`,
    observedAt: now,
    executionOwnerToken: `${id}-owner`,
    executionLeaseExpiresAt: "2026-09-04T00:01:00.000Z",
    requestJson: JSON.stringify({
      plan_id: `${id}-plan`,
      plan_digest: String(sequence).padStart(64, "0"),
      catalogue_revision_id: revisionId,
      manifest_digest: digest,
      expected_current_revision_id: currentId,
      confirmation_revision_id: revisionId,
      deletion_id: id,
      idempotency_key: `${id}-key`,
    }),
  };
}

test.each([
  "plan_id",
  "plan_digest",
  "catalogue_revision_id",
  "manifest_digest",
  "expected_current_revision_id",
  "confirmation_revision_id",
  "deletion_id",
  "idempotency_key",
])("export confirmation binds its request %s to the stored plan", async (field) => {
  const input = await deletionPlan();
  const request = JSON.parse(input.requestJson);
  request[field] = "mismatched-value";
  await expect(
    insertCatalogueExportDeletionStatement(database, { ...input, requestJson: JSON.stringify(request) }).run(),
  ).rejects.toThrow("catalogue_export_deletion_guard_failed");
  await expect(
    catalogueExportDeletionByIdStatement(database, { deletionId: input.deletionId }).first(),
  ).resolves.toBeNull();
});

test("an export plan expires exactly at its deadline without transition triggers", async () => {
  const input = await deletionPlan();
  await expect(
    insertCatalogueExportDeletionStatement(database, { ...input, observedAt: "2026-09-04T00:15:00.000Z" }).run(),
  ).rejects.toThrow("catalogue_export_deletion_guard_failed");
});

test("export retry requires the same retained object set and rolls back its retry claim", async () => {
  const input = await deletionPlan();
  await database.batch([
    insertCatalogueExportDeletionStatement(database, input),
    markCatalogueExportDeletingStatement(database, {
      deletion_id: input.deletionId,
      catalogue_revision_id: input.catalogueRevisionId,
    }),
  ]);
  await failCatalogueExportDeletionStatement(database, {
    responseJson: "{}",
    deletionId: input.deletionId,
    retryIdempotencyKey: null,
    executionOwnerToken: input.executionOwnerToken,
  }).run();
  const idempotencyKey = `${input.deletionId}-retry`;
  await expect(
    database.batch([
      insertCatalogueExportDeletionRetryStatement(database, {
        idempotency_key: idempotencyKey,
        deletionId: input.deletionId,
        object_set_digest: "b".repeat(64),
        requestJson: "{}",
        observedAt: now,
      }),
      claimCatalogueExportDeletionRetryStatement(database, {
        idempotency_key: idempotencyKey,
        executionOwnerToken: `${idempotencyKey}-owner`,
        executionLeaseExpiresAt: input.executionLeaseExpiresAt,
        deletionId: input.deletionId,
      }),
    ]),
  ).rejects.toThrow("catalogue_export_deletion_transition_invalid");
  await expect(
    catalogueExportDeletionByIdStatement(database, { deletionId: input.deletionId }).first(),
  ).resolves.toMatchObject({
    state: "failed",
    execution_owner_token: input.executionOwnerToken,
    retry_owner_idempotency_key: null,
  });
  await expect(
    catalogueExportDeletionRetryStatement(database, { idempotency_key: idempotencyKey }).first(),
  ).resolves.toBeNull();
});
