import {
  applyD1Migrations,
  env,
  type D1Migration,
} from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import {
  acceptCatalogueRecovery,
  beginCatalogueRecovery,
  inspectCatalogueRecovery,
  type D1RecoveryProvider,
  verifyCatalogueRecovery,
} from "../../../src/catalogue/recovery";
import type {
  RestoredCatalogueVerification,
} from "../../../src/catalogue/backup-recovery";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
const digest = "a".repeat(64);
const contentDigest = "b".repeat(64);
const completeVerification: RestoredCatalogueVerification = {
  schema: true,
  integrity: true,
  current_revision: true,
  representative_entities: true,
  search: true,
  provenance: true,
  audit: true,
  api: true,
};

beforeEach(async () => {
  await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
  await testEnv.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET active_recovery_id = NULL, active_ingestion_run_id = NULL, active_release_id = NULL, active_release_expires_at = NULL WHERE singleton = 1 AND recovery_health = 'healthy'",
  ).run();
  await retainVerifiedBackup("recovery-source", "bookmark-target");
});

test("Time Travel recovery records the current and immediate undo bookmarks while blocking mutation", async () => {
  const events: string[] = [];
  const provider = recoveryProvider({
    currentBookmark: async () => {
      events.push("bookmark:current");
      return "bookmark-before-recovery";
    },
    timeTravelRestore: async (input) => {
      events.push(`restore:${input.bookmark}`);
      return {
        bookmark: "bookmark-restored",
        previousBookmark: "bookmark-immediate-undo",
      };
    },
  });

  const begun = await beginCatalogueRecovery(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    {
      recoveryId: "recovery-time-travel",
      method: "time_travel",
      targetRevisionId: "catrev_spine_000",
      targetBookmark: "bookmark-target",
      targetDigest: digest,
      backupAttemptId: "recovery-source",
      expectedCurrentRevisionId: "catrev_spine_000",
      idempotencyKey: "begin-time-travel",
      observedAt: "2026-08-05T08:00:00.000Z",
      cloudflareAccountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
      catalogueDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
      verificationToken: "verification-token",
    },
    provider,
  );

  expect(events).toEqual([
    "bookmark:current",
    "restore:bookmark-target",
  ]);
  expect(begun).toMatchObject({
    contract: "card-keepr-catalogue-recovery@1",
    id: "recovery-time-travel",
    state: "validating",
    method: "time_travel",
    target_revision_id: "catrev_spine_000",
    target_bookmark: "bookmark-target",
    current_bookmark: "bookmark-before-recovery",
    restored_bookmark: "bookmark-restored",
    undo_bookmark: "bookmark-immediate-undo",
    retained_database_id: null,
  });
  await expect(testEnv.CATALOGUE_DB.prepare(
    "SELECT recovery_health FROM operation_state WHERE singleton = 1",
  ).first()).resolves.toEqual({ recovery_health: "blocked" });

  const replay = await beginCatalogueRecovery(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    {
      recoveryId: "recovery-time-travel",
      method: "time_travel",
      targetRevisionId: "catrev_spine_000",
      targetBookmark: "bookmark-target",
      targetDigest: digest,
      backupAttemptId: "recovery-source",
      expectedCurrentRevisionId: "catrev_spine_000",
      idempotencyKey: "begin-time-travel",
      observedAt: "2026-08-05T08:01:00.000Z",
      cloudflareAccountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
      catalogueDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
      verificationToken: "verification-token",
    },
    provider,
  );
  expect(replay).toEqual(begun);
  expect(events).toHaveLength(2);
  await verifyCatalogueRecovery(
    testEnv.CATALOGUE_DB,
    "recovery-time-travel",
    {
      targetDigest: digest,
      idempotencyKey: "verify-time-travel",
      observedAt: "2026-08-05T08:02:00.000Z",
      cloudflareAccountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
      verificationToken: "verification-token",
    },
    provider,
  );
  await acceptCatalogueRecovery(
    testEnv.CATALOGUE_DB,
    "recovery-time-travel",
    {
      expectedRestoredRevisionId: "catrev_spine_000",
      targetDigest: digest,
      confirmationRecoveryId: "recovery-time-travel",
      idempotencyKey: "accept-time-travel",
      observedAt: "2026-08-05T08:03:00.000Z",
      boundDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
    },
  );
});

test("replacement recovery validates a fresh database and retains the old database through acceptance", async () => {
  const events: string[] = [];
  const provider = recoveryProvider({
    currentBookmark: async () => "bookmark-before-replacement",
    prepareReplacementTarget: async (input) => {
      events.push(`prepare:${input.currentDatabaseId}`);
      return { databaseId: "replacement-database-id" };
    },
    restoreSql: async (input) => {
      events.push(`import:${input.databaseId}`);
      await new Response(input.body).arrayBuffer();
    },
    reconstructAndVerify: async (input) => {
      events.push(`verify:${input.databaseId}`);
      expect(input.expectedRevisionId).toBe("catrev_spine_000");
      expect(input.expectedSchemaMigrationLevel).toBe(16);
      return completeVerification;
    },
  });

  const begun = await beginCatalogueRecovery(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    {
      recoveryId: "recovery-replacement",
      method: "replacement_database",
      targetRevisionId: "catrev_spine_000",
      targetBookmark: "bookmark-target",
      targetDigest: digest,
      backupAttemptId: "recovery-source",
      expectedCurrentRevisionId: "catrev_spine_000",
      idempotencyKey: "begin-replacement",
      observedAt: "2026-08-05T09:00:00.000Z",
      cloudflareAccountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
      catalogueDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
      verificationToken: "verification-token",
    },
    provider,
  );
  expect(begun).toMatchObject({
    state: "validating",
    restored_database_id: "replacement-database-id",
    retained_database_id: testEnv.CATALOGUE_D1_DATABASE_ID,
  });
  expect(events).toEqual([
    `prepare:${testEnv.CATALOGUE_D1_DATABASE_ID}`,
    "import:replacement-database-id",
  ]);

  const verified = await verifyCatalogueRecovery(
    testEnv.CATALOGUE_DB,
    "recovery-replacement",
    {
      targetDigest: digest,
      idempotencyKey: "verify-replacement",
      observedAt: "2026-08-05T09:10:00.000Z",
      cloudflareAccountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
      verificationToken: "verification-token",
    },
    provider,
  );
  expect(verified).toMatchObject({
    state: "awaiting_acceptance",
    verification: completeVerification,
    retained_database_id: testEnv.CATALOGUE_D1_DATABASE_ID,
  });
  expect(events.at(-1)).toBe("verify:replacement-database-id");

  await expect(acceptCatalogueRecovery(
    testEnv.CATALOGUE_DB,
    "recovery-replacement",
    {
      expectedRestoredRevisionId: "catrev_spine_000",
      targetDigest: digest,
      confirmationRecoveryId: "recovery-replacement",
      idempotencyKey: "accept-replacement",
      observedAt: "2026-08-05T09:20:00.000Z",
      boundDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
    },
  )).rejects.toMatchObject({
    status: 409,
    code: "recovery_database_not_bound",
  });
  await expect(testEnv.CATALOGUE_DB.prepare(
    "SELECT recovery_health FROM operation_state WHERE singleton = 1",
  ).first()).resolves.toEqual({ recovery_health: "blocked" });
  const accepted = await acceptCatalogueRecovery(
    testEnv.CATALOGUE_DB,
    "recovery-replacement",
    {
      expectedRestoredRevisionId: "catrev_spine_000",
      targetDigest: digest,
      confirmationRecoveryId: "recovery-replacement",
      idempotencyKey: "accept-replacement",
      observedAt: "2026-08-05T09:21:00.000Z",
      boundDatabaseId: "replacement-database-id",
    },
  );
  expect(accepted).toMatchObject({ state: "accepted" });
});

test("failed recovery remains blocked and only one exact linked child may continue it", async () => {
  const failing = recoveryProvider({
    timeTravelRestore: async () => {
      throw new Error("synthetic restore failure");
    },
  });
  await expect(beginCatalogueRecovery(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    recoveryInput("recovery-failed", "begin-failed"),
    failing,
  )).rejects.toMatchObject({ code: "recovery_failed" });
  expect(await inspectCatalogueRecovery(
    testEnv.CATALOGUE_DB,
    "recovery-failed",
  )).toMatchObject({ state: "failed", failure: { code: "recovery_failed" } });
  await expect(beginCatalogueRecovery(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    recoveryInput("recovery-unlinked", "begin-unlinked"),
    recoveryProvider(),
  )).rejects.toMatchObject({ code: "recovery_link_required" });

  const linked = await beginCatalogueRecovery(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    {
      ...recoveryInput("recovery-linked", "begin-linked"),
      linkedOperationId: "recovery-failed",
    },
    recoveryProvider(),
  );
  expect(linked).toMatchObject({
    state: "validating",
    linked_operation_id: "recovery-failed",
  });
  await expect(beginCatalogueRecovery(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    {
      ...recoveryInput("recovery-second-child", "begin-second-child"),
      linkedOperationId: "recovery-failed",
    },
    recoveryProvider(),
  )).rejects.toMatchObject({ code: "recovery_link_superseded" });
});

function recoveryInput(recoveryId: string, idempotencyKey: string) {
  return {
    recoveryId,
    method: "time_travel" as const,
    targetRevisionId: "catrev_spine_000",
    targetBookmark: "bookmark-target",
    targetDigest: digest,
    backupAttemptId: "recovery-source",
    expectedCurrentRevisionId: "catrev_spine_000",
    idempotencyKey,
    observedAt: "2026-08-05T10:00:00.000Z",
    cloudflareAccountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
    catalogueDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
    verificationToken: "verification-token",
  };
}

function recoveryProvider(
  overrides: Partial<D1RecoveryProvider> = {},
): D1RecoveryProvider {
  return {
    currentBookmark: async () => "bookmark-current",
    timeTravelRestore: async () => ({
      bookmark: "bookmark-restored",
      previousBookmark: "bookmark-undo",
    }),
    prepareReplacementTarget: async () => ({
      databaseId: "replacement-database-id",
    }),
    restoreSql: async (input) => {
      await new Response(input.body).arrayBuffer();
    },
    reconstructAndVerify: async () => completeVerification,
    ...overrides,
  };
}

async function retainVerifiedBackup(
  attemptId: string,
  bookmark: string,
): Promise<void> {
  const objectKey = `d1-backups/catrev_spine_000/${attemptId}/catalogue.sql`;
  const manifestKey = `d1-backups/catrev_spine_000/${attemptId}/manifest.json`;
  const sql = new TextEncoder().encode("-- verified recovery source\n");
  await testEnv.BACKUPS.put(objectKey, sql);
  await testEnv.BACKUPS.put(manifestKey, JSON.stringify({
    contract: "card-keepr-catalogue-backup-manifest@1",
    attempt_id: attemptId,
    catalogue_revision_id: "catrev_spine_000",
    content_sha256: contentDigest,
    d1_bookmark: bookmark,
    export_bytes: sql.byteLength,
    exported_at: "2026-08-05T07:00:00.000Z",
    object_key: objectKey,
    producing_workflow_identity: attemptId,
    schema_migration_level: 16,
    expected_evidence: {
      cards: 1,
      printings: 1,
      products: 1,
      legality_rules: 1,
      api_documents: 1,
      search_terms: 1,
      search_chunks: 1,
      provenance: 0,
      audit_rows: 1,
      representative_card_id: "card_recovery",
      representative_printing_id: "printing_recovery",
      representative_product_id: "product_recovery",
      representative_legality_rule_id: "rule_recovery",
      representative_search_text: "recovery",
      representative_curated_revision_id: null,
      representative_curated_revision_digest: null,
      publication_ingestion_run_id: "run_recovery",
    },
    verification: {
      disposable_database_id: "disposable-recovery-source",
      restore_generation: 1,
      verified: true,
      verified_at: "2026-08-05T07:10:00.000Z",
    },
  }));
  await testEnv.CATALOGUE_DB.prepare(
    `INSERT OR IGNORE INTO catalogue_backup_attempts (
       idempotency_key, request_json, owner_token, catalogue_revision_id,
       state, object_key, d1_bookmark, started_at, completed_at,
       manifest_key, content_sha256, manifest_sha256, export_bytes,
       schema_migration_level, disposable_database_id, restore_generation,
       restore_phase
     ) VALUES (?, ?, ?, 'catrev_spine_000', 'verified', ?, ?, ?, ?, ?, ?, ?, ?, 16, ?, 1, 'verified')`,
  ).bind(
    attemptId,
    JSON.stringify({ expected_current_revision_id: "catrev_spine_000" }),
    `backup:${attemptId}`,
    objectKey,
    bookmark,
    "2026-08-05T07:00:00.000Z",
    "2026-08-05T07:10:00.000Z",
    manifestKey,
    contentDigest,
    digest,
    sql.byteLength,
    "disposable-recovery-source",
  ).run();
}
