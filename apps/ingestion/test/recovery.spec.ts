import {
  applyD1Migrations,
  env,
  type D1Migration,
} from "cloudflare:test";
import { exports } from "cloudflare:workers";
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
    testEnv.BACKUPS,
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
    testEnv.BACKUPS,
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
    testEnv.BACKUPS,
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
    testEnv.BACKUPS,
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
    testEnv.BACKUPS,
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

test("recovery rejects a pre-guard backup before any provider restore call", async () => {
  await retainVerifiedBackup("recovery-pre-guard", "bookmark-pre-guard", 15);
  let providerCalls = 0;
  const provider = recoveryProvider({
    currentBookmark: async () => {
      providerCalls += 1;
      return "bookmark-current";
    },
    timeTravelRestore: async () => {
      providerCalls += 1;
      return { bookmark: "unexpected", previousBookmark: "unexpected" };
    },
  });
  await expect(beginCatalogueRecovery(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    {
      ...recoveryInput("recovery-pre-guard", "begin-pre-guard"),
      targetBookmark: "bookmark-pre-guard",
      backupAttemptId: "recovery-pre-guard",
    },
    provider,
  )).rejects.toMatchObject({
    code: "recovery_backup_schema_incompatible",
  });
  expect(providerCalls).toBe(0);
  await expect(testEnv.CATALOGUE_DB.prepare(
    `SELECT recovery_health, active_recovery_id, recovery_restore_guard
     FROM operation_state WHERE singleton = 1`,
  ).first()).resolves.toEqual({
    recovery_health: "healthy",
    active_recovery_id: null,
    recovery_restore_guard: "clear",
  });
});

test("concurrent acceptance keys produce one retained acceptance", async () => {
  const provider = recoveryProvider();
  await beginCatalogueRecovery(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    recoveryInput("recovery-concurrent-accept", "begin-concurrent-accept"),
    provider,
  );
  await verifyCatalogueRecovery(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    "recovery-concurrent-accept",
    {
      targetDigest: digest,
      idempotencyKey: "verify-concurrent-accept",
      observedAt: "2026-08-05T09:30:00.000Z",
      cloudflareAccountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
      verificationToken: "verification-token",
    },
    provider,
  );
  const accept = (idempotencyKey: string) => acceptCatalogueRecovery(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    "recovery-concurrent-accept",
    {
      expectedRestoredRevisionId: "catrev_spine_000",
      targetDigest: digest,
      confirmationRecoveryId: "recovery-concurrent-accept",
      idempotencyKey,
      observedAt: "2026-08-05T09:31:00.000Z",
      boundDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
    },
  );
  const outcomes = await Promise.allSettled([
    accept("accept-concurrent-a"),
    accept("accept-concurrent-b"),
  ]);
  expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
  const rejected = outcomes.find(({ status }) => status === "rejected");
  expect(rejected).toMatchObject({
    status: "rejected",
    reason: { code: "idempotency_key_reused" },
  });
  await expect(testEnv.CATALOGUE_DB.prepare(
    `SELECT state, acceptance_idempotency_key
     FROM catalogue_recovery_operations
     WHERE id = 'recovery-concurrent-accept'`,
  ).first()).resolves.toMatchObject({
    state: "accepted",
    acceptance_idempotency_key: expect.stringMatching(
      /^accept-concurrent-[ab]$/,
    ),
  });
});

test("a race during external prework cannot acquire the block or begin restore", async () => {
  let restoreCalls = 0;
  const provider = recoveryProvider({
    currentBookmark: async () => {
      await testEnv.CATALOGUE_DB.prepare(
        "UPDATE catalogue_state SET current_revision_id = 'catrev_raced' WHERE singleton = 1",
      ).run();
      return "bookmark-before-race";
    },
    timeTravelRestore: async () => {
      restoreCalls += 1;
      return {
        bookmark: "bookmark-restored",
        previousBookmark: "bookmark-undo",
      };
    },
  });
  await expect(beginCatalogueRecovery(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    recoveryInput("recovery-raced", "begin-raced"),
    provider,
  )).rejects.toMatchObject({ code: "recovery_state_changed" });
  expect(restoreCalls).toBe(0);
  await expect(testEnv.CATALOGUE_DB.prepare(
    "SELECT COUNT(*) AS count FROM catalogue_recovery_operations WHERE id = 'recovery-raced'",
  ).first()).resolves.toEqual({ count: 0 });
  await testEnv.CATALOGUE_DB.prepare(
    "UPDATE catalogue_state SET current_revision_id = 'catrev_spine_000' WHERE singleton = 1",
  ).run();
});

test("an ambiguous Time Travel response rehydrates a fail-closed journal", async () => {
  const provider = recoveryProvider({
    timeTravelRestore: async () => {
      await testEnv.CATALOGUE_DB.prepare(
        "DROP TRIGGER catalogue_recovery_operations_are_not_deleted",
      ).run();
      await testEnv.CATALOGUE_DB.prepare(
        "DELETE FROM catalogue_recovery_operations WHERE id = 'recovery-ambiguous'",
      ).run();
      await testEnv.CATALOGUE_DB.prepare(
        `UPDATE operation_state
         SET recovery_health = 'healthy', active_recovery_id = NULL,
             recovery_restore_guard = 'blocked'
         WHERE singleton = 1`,
      ).run();
      throw new Error("response lost after accepted restore");
    },
  });
  await expect(beginCatalogueRecovery(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    recoveryInput("recovery-ambiguous", "begin-ambiguous"),
    provider,
  )).rejects.toMatchObject({ code: "recovery_failed" });
  await expect(testEnv.CATALOGUE_DB.prepare(
    `SELECT recovery_health, active_recovery_id, recovery_restore_guard
     FROM operation_state WHERE singleton = 1`,
  ).first()).resolves.toEqual({
    recovery_health: "blocked",
    active_recovery_id: "recovery-ambiguous",
    recovery_restore_guard: "blocked",
  });
  await expect(inspectCatalogueRecovery(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    "recovery-ambiguous",
  )).resolves.toMatchObject({
    state: "failed",
    failure: { code: "recovery_failed" },
  });
});

test("replacement acceptance rehydrates its journal through the rebound HTTP route", async () => {
  const provider = recoveryProvider({
    prepareReplacementTarget: async () => ({
      databaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
    }),
  });
  await beginCatalogueRecovery(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    {
      ...recoveryInput("recovery-route-rebound", "begin-route-rebound"),
      method: "replacement_database",
      catalogueDatabaseId: "retained-old-database-id",
      linkedOperationId: "recovery-ambiguous",
    },
    provider,
  );
  await verifyCatalogueRecovery(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    "recovery-route-rebound",
    {
      targetDigest: digest,
      idempotencyKey: "verify-route-rebound",
      observedAt: "2026-08-05T09:40:00.000Z",
      cloudflareAccountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
      verificationToken: "verification-token",
    },
    provider,
  );
  await testEnv.CATALOGUE_DB.prepare(
    `DELETE FROM catalogue_recovery_operations
     WHERE id IN ('recovery-route-rebound', 'recovery-ambiguous')`,
  ).run();
  await testEnv.CATALOGUE_DB.prepare(
    `UPDATE operation_state
     SET recovery_health = 'healthy', active_recovery_id = NULL,
         recovery_restore_guard = 'blocked'
     WHERE singleton = 1`,
  ).run();

  const response = await exports.default.fetch(new Request(
    "https://card-keepr.invalid/v1/recoveries/recovery-route-rebound/acceptance",
    {
      method: "POST",
      headers: {
        authorization: "Bearer vitest-administration-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        expected_restored_revision_id: "catrev_spine_000",
        target_digest: digest,
        confirmation_recovery_id: "recovery-route-rebound",
        idempotency_key: "accept-route-rebound",
      }),
    },
  ));
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ state: "accepted" });
  await expect(testEnv.CATALOGUE_DB.prepare(
    `SELECT recovery_health, active_recovery_id, recovery_restore_guard
     FROM operation_state WHERE singleton = 1`,
  ).first()).resolves.toEqual({
    recovery_health: "healthy",
    active_recovery_id: null,
    recovery_restore_guard: "clear",
  });
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
    testEnv.BACKUPS,
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
  schemaMigrationLevel = 16,
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
    schema_migration_level: schemaMigrationLevel,
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
     ) VALUES (?, ?, ?, 'catrev_spine_000', 'verified', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'verified')`,
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
    schemaMigrationLevel,
    "disposable-recovery-source",
  ).run();
}
