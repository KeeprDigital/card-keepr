import {
  restoreHealthyBackupStateStatement,
  degradeActiveBackupStateStatement,
} from "../../../src/catalogue/backup-recovery/backup-repository";
import {
  reserveRecoveryOperationStatement,
  releaseAcceptedRecoveryStatement,
  clearBlockedRecoveryStatement,
  recoveryGuardStateStatement,
} from "../../../src/catalogue/backup-recovery/recovery-repository";
import {
  disableRecoveryHealthTrigger,
  resetMaintenanceOperation,
  failUnfinishedMaintenanceRecoveries,
} from "./query-helpers/maintenance-guards";
import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { catalogueStore } from "../../../src/catalogue/shared";
import {
  backupAttemptEvidenceStatement,
  completeBackupStatement,
  insertPendingBackupStatement,
  startBackupExportStatement,
} from "../../../src/catalogue/backup-recovery/backup-repository";
import {
  insertRecoveryOperationStatement,
  startRecoveryRestoreStatement,
  startRecoveryValidationStatement,
  recoveryOperationByIdStatement,
  completeRehydratedBackupStatement,
} from "../../../src/catalogue/backup-recovery/recovery-repository";
import {
  disableBackupTransitionTriggers,
  disableRecoveryTransitionTrigger,
  seedVerifyingBackup,
} from "./query-helpers/maintenance-guards";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
const database = catalogueStore(testEnv.CATALOGUE_DB);
const digest = "a".repeat(64);
const now = "2026-09-04T00:00:00.000Z";

beforeEach(async () => {
  await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
  await disableBackupTransitionTriggers(testEnv.CATALOGUE_DB);
  await disableRecoveryHealthTrigger(testEnv.CATALOGUE_DB);
  await failUnfinishedMaintenanceRecoveries(testEnv.CATALOGUE_DB).run();
  await resetMaintenanceOperation(testEnv.CATALOGUE_DB).run();
});

test("incomplete verified backup evidence rejects and rolls back earlier repository writes without triggers", async () => {
  await pendingBackup("invalid-evidence");
  await pendingBackup("rollback-control");
  await seedVerifyingBackup(testEnv.CATALOGUE_DB)
    .bind("invalid-sha256", 1, 1, "disposable-guard", 1, "manifest-guard", digest, "invalid-evidence")
    .run();
  await expect(
    database.batch([
      startBackupExportStatement(database, {
        idempotencyKey: "rollback-control",
        ownerToken: "owner-rollback-control",
      }),
      completeBackupStatement(database, {
        bookmark: "bookmark-guard",
        observedAt: now,
        manifestKey: "manifest-guard",
        manifestSha256: digest,
        idempotencyKey: "invalid-evidence",
        ownerToken: "owner-invalid-evidence",
      }),
    ]),
  ).rejects.toThrow("verified_backup_evidence_incomplete");
  await expect(backupAttemptEvidenceStatement(database, "invalid-evidence").first()).resolves.toMatchObject({
    state: "verifying",
  });
  await expect(backupAttemptEvidenceStatement(database, "rollback-control").first()).resolves.toMatchObject({
    state: "pending",
  });
});

async function pendingBackup(id: string): Promise<void> {
  await insertPendingBackupStatement(database, {
    idempotencyKey: id,
    requestJson: "{}",
    ownerToken: `owner-${id}`,
    expectedCurrentRevisionId: "catrev_spine_000",
    objectKey: `${id}.sql`,
    observedAt: now,
    linkedAttemptId: null,
  }).run();
}

test.each([
  { name: "missing content digest", content: null },
  { name: "missing manifest", manifest: null },
  { name: "invalid manifest digest", manifestDigest: "invalid" },
  { name: "missing export size", bytes: null },
  { name: "negative export size", bytes: -1 },
  { name: "missing schema", schema: null },
  { name: "zero schema", schema: 0 },
  { name: "missing disposable database", disposable: null },
  { name: "empty disposable database", disposable: "" },
  { name: "zero restore generation", generation: 0 },
])("rehydrated backup completion rejects $name without triggers", async (invalid) => {
  const id = `rehydrated-${invalid.name}`;
  await pendingBackup(id);
  const evidence = {
    content: digest,
    bytes: 1,
    schema: 1,
    disposable: "disposable-guard",
    generation: 1,
    manifest: "manifest-guard",
    manifestDigest: digest,
    ...invalid,
  };
  await seedVerifyingBackup(testEnv.CATALOGUE_DB)
    .bind(
      evidence.content,
      evidence.bytes,
      evidence.schema,
      evidence.disposable,
      evidence.generation,
      evidence.manifest,
      evidence.manifestDigest,
      id,
    )
    .run();
  await expect(
    completeRehydratedBackupStatement(database, { completed_at: now, idempotency_key: id }).run(),
  ).rejects.toThrow("verified_backup_evidence_incomplete");
  await expect(backupAttemptEvidenceStatement(database, id).first()).resolves.toMatchObject({ state: "verifying" });
});

test("complete backup evidence retains owner CAS and supports direct and composed execution", async () => {
  await pendingBackup("valid-evidence");
  await seedVerifyingBackup(testEnv.CATALOGUE_DB)
    .bind(digest, 0, 1, "disposable-guard", 1, "manifest-guard", digest, "valid-evidence")
    .run();
  const input = {
    bookmark: "bookmark-guard",
    observedAt: now,
    manifestKey: "manifest-guard",
    manifestSha256: digest,
    idempotencyKey: "valid-evidence",
    ownerToken: "wrong-owner",
  };
  expect((await completeBackupStatement(database, input).run()).meta.changes).toBe(0);
  const results = await database.batch([
    completeBackupStatement(database, { ...input, ownerToken: "owner-valid-evidence" }),
    backupAttemptEvidenceStatement(database, "valid-evidence"),
  ]);
  expect(results).toHaveLength(2);
  expect(results[0]?.meta.changes).toBe(1);
  expect(results[1]?.results).toMatchObject([{ state: "verified" }]);
});

test("recovery restore begins only from preparing after removal of its transition trigger", async () => {
  await disableRecoveryTransitionTrigger(testEnv.CATALOGUE_DB);
  await pendingBackup("recovery-state-source");
  await insertRecoveryOperationStatement(database, {
    recoveryId: "guarded-recovery",
    method: "time_travel",
    requestJson: "{}",
    idempotencyKey: "guarded-recovery",
    targetRevisionId: "catrev_spine_000",
    targetBookmark: "bookmark-guard",
    targetDigest: digest,
    backupAttemptId: "recovery-state-source",
    linkedOperationId: null,
    expectedCurrentRevisionId: "catrev_spine_000",
    currentBookmark: null,
    catalogueDatabaseId: "original-database",
    schema_migration_level: 1,
    expected_evidenceJson: "{}",
    observedAt: now,
  }).run();
  expect((await startRecoveryRestoreStatement(database, { recoveryId: "guarded-recovery" }).run()).meta.changes).toBe(
    1,
  );
  await startRecoveryValidationStatement(database, {
    recoveryId: "guarded-recovery",
    restoredBookmark: "bookmark-guard",
    undoBookmark: null,
    restoredDatabaseId: "restored-database",
    retainedDatabaseId: null,
    observedAt: now,
  }).run();
  expect((await startRecoveryRestoreStatement(database, { recoveryId: "guarded-recovery" }).run()).meta.changes).toBe(
    0,
  );
  await expect(
    recoveryOperationByIdStatement(database, { recoveryId: "guarded-recovery" }).first(),
  ).resolves.toMatchObject({ state: "validating" });
});

test.each(["backup completion", "backup failure", "recovery acceptance", "restore guard release"])(
  "%s cannot unblock an unaccepted recovery and rolls back prior writes",
  async (action) => {
    const id = `blocked-${action}`;
    await pendingBackup(id);
    await insertRecoveryOperationStatement(database, {
      recoveryId: id,
      method: "time_travel",
      requestJson: "{}",
      idempotencyKey: id,
      targetRevisionId: "catrev_spine_000",
      targetBookmark: "bookmark-guard",
      targetDigest: digest,
      backupAttemptId: id,
      linkedOperationId: null,
      expectedCurrentRevisionId: "catrev_spine_000",
      currentBookmark: null,
      catalogueDatabaseId: "original-database",
      schema_migration_level: 1,
      expected_evidenceJson: "{}",
      observedAt: now,
    }).run();
    await reserveRecoveryOperationStatement(database, {
      recoveryId: id,
      observedAt: now,
      linkedOperationId: null,
    }).run();
    const release =
      action === "backup completion"
        ? restoreHealthyBackupStateStatement(database)
        : action === "backup failure"
          ? degradeActiveBackupStateStatement(database, { idempotencyKey: id, ownerToken: `owner-${id}` })
          : action === "recovery acceptance"
            ? releaseAcceptedRecoveryStatement(database, { recoveryId: id })
            : clearBlockedRecoveryStatement(database, { id });
    await expect(
      database.batch([
        startBackupExportStatement(database, { idempotencyKey: id, ownerToken: `owner-${id}` }),
        release,
      ]),
    ).rejects.toThrow("recovery_not_accepted");
    await expect(recoveryGuardStateStatement(database).first()).resolves.toMatchObject({
      recovery_health: "blocked",
      active_recovery_id: id,
      recovery_restore_guard: "blocked",
    });
    await expect(backupAttemptEvidenceStatement(database, id).first()).resolves.toMatchObject({ state: "pending" });
  },
);
