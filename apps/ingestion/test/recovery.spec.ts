import { disableRecoveryTransitionTrigger, disableRecoveryHealthTrigger } from "./query-helpers/maintenance-guards";
import { catalogueStore } from "../../../src/catalogue/shared";
import * as ingestionQueries from "./query-helpers/ingestion";
import * as publishedCatalogueQueries from "./query-helpers/published-catalogue";
import * as backupRecoveryQueries from "./query-helpers/backup-recovery";
import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import {
  acceptCatalogueRecovery,
  beginCatalogueRecovery,
  inspectCatalogueRecovery,
  type D1RecoveryProvider,
  verifyCatalogueRecovery,
  type RestoredCatalogueVerification,
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
  await disableRecoveryTransitionTrigger(testEnv.CATALOGUE_DB);
  await disableRecoveryHealthTrigger(testEnv.CATALOGUE_DB);
  await ingestionQueries.setOperationStateActiveRecoveryIdActiveIngestionRunId(testEnv.CATALOGUE_DB).run();
  await retainVerifiedBackup("recovery-source", "bookmark-target", await currentSchemaMigrationLevel());
});

test("recovery keeps legacy backup manifests without representative document digests recoverable", async () => {
  const provider = recoveryProvider({
    reconstructAndVerify: async (input) => {
      expect(Object.hasOwn(input.expected, "representative_product_digest")).toBe(false);
      return completeVerification;
    },
  });
  await beginCatalogueRecovery(
    catalogueStore(testEnv.CATALOGUE_DB),
    testEnv.BACKUPS,
    recoveryInput("recovery-legacy-manifest", "begin-legacy-manifest"),
    provider,
  );
  await expect(
    verifyCatalogueRecovery(
      catalogueStore(testEnv.CATALOGUE_DB),
      testEnv.BACKUPS,
      "recovery-legacy-manifest",
      {
        targetDigest: digest,
        idempotencyKey: "verify-legacy-manifest",
        observedAt: "2026-08-05T07:30:00.000Z",
        cloudflareAccountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
        verificationToken: "verification-token",
      },
      provider,
    ),
  ).resolves.toMatchObject({ state: "awaiting_acceptance" });
  await expect(
    acceptCatalogueRecovery(catalogueStore(testEnv.CATALOGUE_DB), testEnv.BACKUPS, "recovery-legacy-manifest", {
      expectedRestoredRevisionId: "catrev_spine_000",
      targetDigest: digest,
      confirmationRecoveryId: "recovery-legacy-manifest",
      idempotencyKey: "accept-legacy-manifest",
      observedAt: "2026-08-05T07:31:00.000Z",
      boundDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
    }),
  ).resolves.toMatchObject({ state: "accepted" });
});

test("recovery rejects invalid representative document digests present in a backup manifest", async () => {
  const manifestKey = "d1-backups/catrev_spine_000/recovery-source/manifest.json";
  const retained = await testEnv.BACKUPS.get(manifestKey);
  if (retained === null) throw new Error("Recovery manifest is unavailable.");
  const manifest = await retained.json<Record<string, unknown>>();
  const invalidDigests = [["representative_product_digest", "A".repeat(64)]] as const;
  for (const [key, invalidDigest] of invalidDigests) {
    const mutated = structuredClone(manifest) as {
      expected_evidence: Record<string, unknown>;
    };
    mutated.expected_evidence[key] = invalidDigest;
    await testEnv.BACKUPS.put(manifestKey, JSON.stringify(mutated));
    await expect(
      beginCatalogueRecovery(
        catalogueStore(testEnv.CATALOGUE_DB),
        testEnv.BACKUPS,
        recoveryInput(`recovery-invalid-${key}`, `begin-invalid-${key}`),
        recoveryProvider(),
      ),
    ).rejects.toMatchObject({ code: "recovery_manifest_mismatch" });
  }
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
    catalogueStore(testEnv.CATALOGUE_DB),
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

  expect(events).toEqual(["bookmark:current", "restore:bookmark-target"]);
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
  await expect(ingestionQueries.readOperationStateRecoveryHealth(testEnv.CATALOGUE_DB).first()).resolves.toEqual({
    recovery_health: "blocked",
  });

  const replay = await beginCatalogueRecovery(
    catalogueStore(testEnv.CATALOGUE_DB),
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
    catalogueStore(testEnv.CATALOGUE_DB),
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
  await acceptCatalogueRecovery(catalogueStore(testEnv.CATALOGUE_DB), testEnv.BACKUPS, "recovery-time-travel", {
    expectedRestoredRevisionId: "catrev_spine_000",
    targetDigest: digest,
    confirmationRecoveryId: "recovery-time-travel",
    idempotencyKey: "accept-time-travel",
    observedAt: "2026-08-05T08:03:00.000Z",
    boundDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
  });
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
      expect(input.expectedSchemaMigrationLevel).toBe(await currentSchemaMigrationLevel());
      return completeVerification;
    },
  });

  const begun = await beginCatalogueRecovery(
    catalogueStore(testEnv.CATALOGUE_DB),
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
  expect(events).toEqual([`prepare:${testEnv.CATALOGUE_D1_DATABASE_ID}`, "import:replacement-database-id"]);

  const verified = await verifyCatalogueRecovery(
    catalogueStore(testEnv.CATALOGUE_DB),
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

  await expect(
    acceptCatalogueRecovery(catalogueStore(testEnv.CATALOGUE_DB), testEnv.BACKUPS, "recovery-replacement", {
      expectedRestoredRevisionId: "catrev_spine_000",
      targetDigest: digest,
      confirmationRecoveryId: "recovery-replacement",
      idempotencyKey: "accept-replacement",
      observedAt: "2026-08-05T09:20:00.000Z",
      boundDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
    }),
  ).rejects.toMatchObject({
    status: 409,
    code: "recovery_database_not_bound",
  });
  await expect(ingestionQueries.readOperationStateRecoveryHealth(testEnv.CATALOGUE_DB).first()).resolves.toEqual({
    recovery_health: "blocked",
  });
  const accepted = await acceptCatalogueRecovery(
    catalogueStore(testEnv.CATALOGUE_DB),
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

test("recovery rejects a backup from another schema level before any provider restore call", async () => {
  const currentLevel = await currentSchemaMigrationLevel();
  await retainVerifiedBackup("recovery-schema-incompatible", "bookmark-schema-incompatible", currentLevel - 1);
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
  await expect(
    beginCatalogueRecovery(
      catalogueStore(testEnv.CATALOGUE_DB),
      testEnv.BACKUPS,
      {
        ...recoveryInput("recovery-schema-incompatible", "begin-schema-incompatible"),
        targetBookmark: "bookmark-schema-incompatible",
        backupAttemptId: "recovery-schema-incompatible",
      },
      provider,
    ),
  ).rejects.toMatchObject({
    code: "recovery_backup_schema_incompatible",
  });
  expect(providerCalls).toBe(0);
  await expect(
    ingestionQueries.readOperationStateRecoveryHealthActiveRecoveryId(testEnv.CATALOGUE_DB).first(),
  ).resolves.toEqual({
    recovery_health: "healthy",
    active_recovery_id: null,
    recovery_restore_guard: "clear",
  });
});

test("recovery acceptance stays blocked if the guarded schema level changes", async () => {
  const provider = recoveryProvider();
  const currentLevel = await currentSchemaMigrationLevel();
  await beginCatalogueRecovery(
    catalogueStore(testEnv.CATALOGUE_DB),
    testEnv.BACKUPS,
    recoveryInput("recovery-schema-raced", "begin-schema-raced"),
    provider,
  );
  await verifyCatalogueRecovery(
    catalogueStore(testEnv.CATALOGUE_DB),
    testEnv.BACKUPS,
    "recovery-schema-raced",
    {
      targetDigest: digest,
      idempotencyKey: "verify-schema-raced",
      observedAt: "2026-08-05T09:25:00.000Z",
      cloudflareAccountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
      verificationToken: "verification-token",
    },
    provider,
  );
  await publishedCatalogueQueries.setCatalogueSchemaStateMigrationLevel(testEnv.CATALOGUE_DB).run();

  await expect(
    acceptCatalogueRecovery(catalogueStore(testEnv.CATALOGUE_DB), testEnv.BACKUPS, "recovery-schema-raced", {
      expectedRestoredRevisionId: "catrev_spine_000",
      targetDigest: digest,
      confirmationRecoveryId: "recovery-schema-raced",
      idempotencyKey: "accept-schema-raced",
      observedAt: "2026-08-05T09:26:00.000Z",
      boundDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
    }),
  ).rejects.toMatchObject({ code: "recovery_journal_invalid" });
  await expect(
    ingestionQueries.readOperationStateRecoveryHealthActiveRecoveryId(testEnv.CATALOGUE_DB).first(),
  ).resolves.toEqual({
    recovery_health: "blocked",
    active_recovery_id: "recovery-schema-raced",
    recovery_restore_guard: "blocked",
  });
  await publishedCatalogueQueries
    .setCatalogueSchemaStateMigrationLevelForRecoveryAcceptanceStaysBlockedIfGuardedSchemaLevelChanges(
      testEnv.CATALOGUE_DB,
    )
    .bind(currentLevel)
    .run();
  await expect(
    acceptCatalogueRecovery(catalogueStore(testEnv.CATALOGUE_DB), testEnv.BACKUPS, "recovery-schema-raced", {
      expectedRestoredRevisionId: "catrev_spine_000",
      targetDigest: digest,
      confirmationRecoveryId: "recovery-schema-raced",
      idempotencyKey: "accept-schema-raced",
      observedAt: "2026-08-05T09:27:00.000Z",
      boundDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
    }),
  ).resolves.toMatchObject({ state: "accepted" });
});

test("concurrent acceptance keys produce one retained acceptance", async () => {
  const provider = recoveryProvider();
  await beginCatalogueRecovery(
    catalogueStore(testEnv.CATALOGUE_DB),
    testEnv.BACKUPS,
    recoveryInput("recovery-concurrent-accept", "begin-concurrent-accept"),
    provider,
  );
  await verifyCatalogueRecovery(
    catalogueStore(testEnv.CATALOGUE_DB),
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
  const accept = (idempotencyKey: string) =>
    acceptCatalogueRecovery(catalogueStore(testEnv.CATALOGUE_DB), testEnv.BACKUPS, "recovery-concurrent-accept", {
      expectedRestoredRevisionId: "catrev_spine_000",
      targetDigest: digest,
      confirmationRecoveryId: "recovery-concurrent-accept",
      idempotencyKey,
      observedAt: "2026-08-05T09:31:00.000Z",
      boundDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
    });
  const outcomes = await Promise.allSettled([accept("accept-concurrent-a"), accept("accept-concurrent-b")]);
  expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
  const rejected = outcomes.find(({ status }) => status === "rejected");
  expect(rejected).toMatchObject({
    status: "rejected",
    reason: { code: "idempotency_key_reused" },
  });
  await expect(
    backupRecoveryQueries.readCatalogueRecoveryOperationsStateAcceptanceIdempotencyKey(testEnv.CATALOGUE_DB).first(),
  ).resolves.toMatchObject({
    state: "accepted",
    acceptance_idempotency_key: expect.stringMatching(/^accept-concurrent-[ab]$/),
  });
});

test("exact accepted replay remains immutable after a later publication", async () => {
  const provider = recoveryProvider();
  await beginCatalogueRecovery(
    catalogueStore(testEnv.CATALOGUE_DB),
    testEnv.BACKUPS,
    recoveryInput("recovery-accepted-replay", "begin-accepted-replay"),
    provider,
  );
  await verifyCatalogueRecovery(
    catalogueStore(testEnv.CATALOGUE_DB),
    testEnv.BACKUPS,
    "recovery-accepted-replay",
    {
      targetDigest: digest,
      idempotencyKey: "verify-accepted-replay",
      observedAt: "2026-08-05T09:35:00.000Z",
      cloudflareAccountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
      verificationToken: "verification-token",
    },
    provider,
  );
  const acceptance = {
    expectedRestoredRevisionId: "catrev_spine_000",
    targetDigest: digest,
    confirmationRecoveryId: "recovery-accepted-replay",
    idempotencyKey: "accept-accepted-replay",
    observedAt: "2026-08-05T09:36:00.000Z",
    boundDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
  };
  const accepted = await acceptCatalogueRecovery(
    catalogueStore(testEnv.CATALOGUE_DB),
    testEnv.BACKUPS,
    "recovery-accepted-replay",
    acceptance,
  );
  await publishedCatalogueQueries
    .setCatalogueStateCurrentRevisionIdForExactAcceptedReplayRemainsImmutableAfterLaterPublication(testEnv.CATALOGUE_DB)
    .run();
  await expect(
    acceptCatalogueRecovery(
      catalogueStore(testEnv.CATALOGUE_DB),
      testEnv.BACKUPS,
      "recovery-accepted-replay",
      acceptance,
    ),
  ).resolves.toEqual(accepted);
  await expect(
    publishedCatalogueQueries.readCatalogueStateCurrentRevisionId(testEnv.CATALOGUE_DB).first(),
  ).resolves.toEqual({
    current_revision_id: "catrev_later_publication",
  });
  await publishedCatalogueQueries
    .setCatalogueStateCurrentRevisionIdForProductCursorsPinRoutePreserveFilteredKeysetOrder(testEnv.CATALOGUE_DB)
    .run();
});

test("a race during external prework cannot acquire the block or begin restore", async () => {
  let restoreCalls = 0;
  const provider = recoveryProvider({
    currentBookmark: async () => {
      await publishedCatalogueQueries
        .setCatalogueStateCurrentRevisionIdForRaceDuringExternalPreworkCannotAcquireBlockOrBegin(testEnv.CATALOGUE_DB)
        .run();
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
  await expect(
    beginCatalogueRecovery(
      catalogueStore(testEnv.CATALOGUE_DB),
      testEnv.BACKUPS,
      recoveryInput("recovery-raced", "begin-raced"),
      provider,
    ),
  ).rejects.toMatchObject({ code: "recovery_state_changed" });
  expect(restoreCalls).toBe(0);
  await expect(
    backupRecoveryQueries.countCatalogueRecoveryOperationsCount(testEnv.CATALOGUE_DB).first(),
  ).resolves.toEqual({ count: 0 });
  await publishedCatalogueQueries
    .setCatalogueStateCurrentRevisionIdForProductCursorsPinRoutePreserveFilteredKeysetOrder(testEnv.CATALOGUE_DB)
    .run();
});

test("inspect observes a paused restore without mutation and a second begin reports recovery_exists", async () => {
  let markRestoreStarted: () => void = () => {};
  const restoreStarted = new Promise<void>((resolve) => {
    markRestoreStarted = resolve;
  });
  let releaseRestore: ((value: { bookmark: string; previousBookmark: string }) => void) | undefined;
  let restoreCalls = 0;
  const provider = recoveryProvider({
    timeTravelRestore: async () => {
      restoreCalls += 1;
      markRestoreStarted();
      return new Promise((resolve) => {
        releaseRestore = resolve;
      });
    },
  });
  const beginning = beginCatalogueRecovery(
    catalogueStore(testEnv.CATALOGUE_DB),
    testEnv.BACKUPS,
    recoveryInput("recovery-paused", "begin-paused"),
    provider,
  );
  await restoreStarted;
  await expect(
    inspectCatalogueRecovery(catalogueStore(testEnv.CATALOGUE_DB), testEnv.BACKUPS, "recovery-paused"),
  ).resolves.toMatchObject({ state: "restoring", failure: null });
  await expect(
    beginCatalogueRecovery(
      catalogueStore(testEnv.CATALOGUE_DB),
      testEnv.BACKUPS,
      recoveryInput("recovery-paused", "begin-paused"),
      provider,
    ),
  ).resolves.toMatchObject({ state: "restoring", failure: null });
  expect(restoreCalls).toBe(1);
  await expect(
    beginCatalogueRecovery(
      catalogueStore(testEnv.CATALOGUE_DB),
      testEnv.BACKUPS,
      recoveryInput("recovery-second-unlinked", "begin-second-unlinked"),
      recoveryProvider(),
    ),
  ).rejects.toMatchObject({ code: "recovery_exists" });
  await expect(
    backupRecoveryQueries.readCatalogueRecoveryOperationsStateFailureCode(testEnv.CATALOGUE_DB).first(),
  ).resolves.toEqual({ state: "restoring", failure_code: null });
  releaseRestore?.({
    bookmark: "bookmark-restored",
    previousBookmark: "bookmark-undo",
  });
  await beginning;
  await verifyCatalogueRecovery(
    catalogueStore(testEnv.CATALOGUE_DB),
    testEnv.BACKUPS,
    "recovery-paused",
    {
      targetDigest: digest,
      idempotencyKey: "verify-paused",
      observedAt: "2026-08-05T09:45:00.000Z",
      cloudflareAccountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
      verificationToken: "verification-token",
    },
    provider,
  );
  await acceptCatalogueRecovery(catalogueStore(testEnv.CATALOGUE_DB), testEnv.BACKUPS, "recovery-paused", {
    expectedRestoredRevisionId: "catrev_spine_000",
    targetDigest: digest,
    confirmationRecoveryId: "recovery-paused",
    idempotencyKey: "accept-paused",
    observedAt: "2026-08-05T09:46:00.000Z",
    boundDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
  });
});

test("an ambiguous Time Travel response rehydrates a fail-closed journal", async () => {
  const provider = recoveryProvider({
    timeTravelRestore: async () => {
      await backupRecoveryQueries.dropCatalogueRecoveryOperationsAreNotDeleted(testEnv.CATALOGUE_DB).run();
      await backupRecoveryQueries.deleteCatalogueRecoveryOperations(testEnv.CATALOGUE_DB).run();
      await ingestionQueries.setOperationStateRecoveryHealthActiveRecoveryId(testEnv.CATALOGUE_DB).run();
      throw new Error("response lost after accepted restore");
    },
  });
  await expect(
    beginCatalogueRecovery(
      catalogueStore(testEnv.CATALOGUE_DB),
      testEnv.BACKUPS,
      recoveryInput("recovery-ambiguous", "begin-ambiguous"),
      provider,
    ),
  ).rejects.toMatchObject({ code: "recovery_failed" });
  await expect(
    ingestionQueries.readOperationStateRecoveryHealthActiveRecoveryId(testEnv.CATALOGUE_DB).first(),
  ).resolves.toEqual({
    recovery_health: "blocked",
    active_recovery_id: "recovery-ambiguous",
    recovery_restore_guard: "blocked",
  });
  await expect(
    inspectCatalogueRecovery(catalogueStore(testEnv.CATALOGUE_DB), testEnv.BACKUPS, "recovery-ambiguous"),
  ).resolves.toMatchObject({
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
    catalogueStore(testEnv.CATALOGUE_DB),
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
    catalogueStore(testEnv.CATALOGUE_DB),
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
  await backupRecoveryQueries
    .deleteCatalogueRecoveryOperationsForReplacementAcceptanceRehydratesJournalThroughReboundHTTPRoute(
      testEnv.CATALOGUE_DB,
    )
    .run();
  await ingestionQueries.setOperationStateRecoveryHealthActiveRecoveryId(testEnv.CATALOGUE_DB).run();

  const response = await exports.default.fetch(
    new Request("https://card-keepr.invalid/v1/recoveries/recovery-route-rebound/acceptance", {
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
    }),
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ state: "accepted" });
  await expect(
    ingestionQueries.readOperationStateRecoveryHealthActiveRecoveryId(testEnv.CATALOGUE_DB).first(),
  ).resolves.toEqual({
    recovery_health: "healthy",
    active_recovery_id: null,
    recovery_restore_guard: "clear",
  });
});

test("accepted journal hydration stays blocked against the wrong local catalogue", async () => {
  const provider = recoveryProvider();
  await beginCatalogueRecovery(
    catalogueStore(testEnv.CATALOGUE_DB),
    testEnv.BACKUPS,
    recoveryInput("recovery-accepted-wrong-local", "begin-accepted-wrong-local"),
    provider,
  );
  await verifyCatalogueRecovery(
    catalogueStore(testEnv.CATALOGUE_DB),
    testEnv.BACKUPS,
    "recovery-accepted-wrong-local",
    {
      targetDigest: digest,
      idempotencyKey: "verify-accepted-wrong-local",
      observedAt: "2026-08-05T09:50:00.000Z",
      cloudflareAccountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
      verificationToken: "verification-token",
    },
    provider,
  );
  const acceptance = {
    expectedRestoredRevisionId: "catrev_spine_000",
    targetDigest: digest,
    confirmationRecoveryId: "recovery-accepted-wrong-local",
    idempotencyKey: "accept-accepted-wrong-local",
    observedAt: "2026-08-05T09:51:00.000Z",
    boundDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
  };
  await acceptCatalogueRecovery(
    catalogueStore(testEnv.CATALOGUE_DB),
    testEnv.BACKUPS,
    "recovery-accepted-wrong-local",
    acceptance,
  );
  await backupRecoveryQueries
    .deleteCatalogueRecoveryOperationsForAcceptedJournalHydrationStaysBlockedAgainstWrongLocalCatalogue(
      testEnv.CATALOGUE_DB,
    )
    .run();
  await publishedCatalogueQueries
    .setCatalogueStateCurrentRevisionIdForAcceptedJournalHydrationStaysBlockedAgainstWrongLocalCatalogue(
      testEnv.CATALOGUE_DB,
    )
    .run();
  await ingestionQueries.setOperationStateRecoveryRestoreGuard(testEnv.CATALOGUE_DB).run();

  await expect(
    inspectCatalogueRecovery(catalogueStore(testEnv.CATALOGUE_DB), testEnv.BACKUPS, "recovery-accepted-wrong-local"),
  ).resolves.toMatchObject({ state: "accepted" });
  await expect(
    ingestionQueries.readOperationStateRecoveryHealthActiveRecoveryId(testEnv.CATALOGUE_DB).first(),
  ).resolves.toEqual({
    recovery_health: "blocked",
    active_recovery_id: "recovery-accepted-wrong-local",
    recovery_restore_guard: "blocked",
  });
  await expect(
    acceptCatalogueRecovery(
      catalogueStore(testEnv.CATALOGUE_DB),
      testEnv.BACKUPS,
      "recovery-accepted-wrong-local",
      acceptance,
    ),
  ).rejects.toMatchObject({ code: "restored_revision_mismatch" });
  await publishedCatalogueQueries
    .setCatalogueStateCurrentRevisionIdForProductCursorsPinRoutePreserveFilteredKeysetOrder(testEnv.CATALOGUE_DB)
    .run();
  await acceptCatalogueRecovery(
    catalogueStore(testEnv.CATALOGUE_DB),
    testEnv.BACKUPS,
    "recovery-accepted-wrong-local",
    acceptance,
  );
  await expect(
    ingestionQueries.readOperationStateRecoveryHealthActiveRecoveryId(testEnv.CATALOGUE_DB).first(),
  ).resolves.toEqual({
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
  await expect(
    beginCatalogueRecovery(
      catalogueStore(testEnv.CATALOGUE_DB),
      testEnv.BACKUPS,
      recoveryInput("recovery-failed", "begin-failed"),
      failing,
    ),
  ).rejects.toMatchObject({ code: "recovery_failed" });
  expect(
    await inspectCatalogueRecovery(catalogueStore(testEnv.CATALOGUE_DB), testEnv.BACKUPS, "recovery-failed"),
  ).toMatchObject({
    state: "failed",
    failure: { code: "recovery_failed" },
  });
  await expect(
    beginCatalogueRecovery(
      catalogueStore(testEnv.CATALOGUE_DB),
      testEnv.BACKUPS,
      recoveryInput("recovery-unlinked", "begin-unlinked"),
      recoveryProvider(),
    ),
  ).rejects.toMatchObject({ code: "recovery_link_required" });

  const linked = await beginCatalogueRecovery(
    catalogueStore(testEnv.CATALOGUE_DB),
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
  await expect(
    beginCatalogueRecovery(
      catalogueStore(testEnv.CATALOGUE_DB),
      testEnv.BACKUPS,
      {
        ...recoveryInput("recovery-second-child", "begin-second-child"),
        linkedOperationId: "recovery-failed",
      },
      recoveryProvider(),
    ),
  ).rejects.toMatchObject({ code: "recovery_link_superseded" });
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

function recoveryProvider(overrides: Partial<D1RecoveryProvider> = {}): D1RecoveryProvider {
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

async function retainVerifiedBackup(attemptId: string, bookmark: string, schemaMigrationLevel: number): Promise<void> {
  const objectKey = `d1-backups/catrev_spine_000/${attemptId}/catalogue.sql`;
  const manifestKey = `d1-backups/catrev_spine_000/${attemptId}/manifest.json`;
  const sql = new TextEncoder().encode("-- verified recovery source\n");
  await testEnv.BACKUPS.put(objectKey, sql);
  await testEnv.BACKUPS.put(
    manifestKey,
    JSON.stringify({
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
        api_documents: 1,
        search_chunks: 1,
        provenance: 0,
        audit_rows: 1,
        representative_card_id: "card_recovery",
        representative_printing_id: "printing_recovery",
        representative_product_id: "product_recovery",
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
    }),
  );
  await backupRecoveryQueries
    .insertCatalogueBackupAttempts(testEnv.CATALOGUE_DB)
    .bind(
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
    )
    .run();
}

async function currentSchemaMigrationLevel(): Promise<number> {
  const state = await publishedCatalogueQueries
    .readCatalogueSchemaStateMigrationLevel(testEnv.CATALOGUE_DB)
    .first<{ migration_level: number }>();
  if (state === null) throw new Error("Catalogue schema state is unavailable.");
  return state.migration_level;
}
