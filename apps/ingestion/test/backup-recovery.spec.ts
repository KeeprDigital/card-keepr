import {
  applyD1Migrations,
  env,
  type D1Migration,
} from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import {
  catalogueBackupAttemptStatus,
  cloudflareD1BackupProvider,
  createVerifiedCatalogueBackup,
  type D1BackupProvider,
  type RestoredCatalogueVerification,
  verifyRestoredCatalogue,
} from "../../../src/catalogue/backup-recovery";
import {
  startOrObserveCatalogueBackupWorkflow,
  type CatalogueBackupWorkflowParams,
} from "../../../src/catalogue/backup-workflow";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };

const completeRestoredVerification = (): RestoredCatalogueVerification => ({
  schema: true,
  integrity: true,
  current_revision: true,
  representative_entities: true,
  search: true,
  provenance: true,
  audit: true,
  api: true,
});

const freshRestoreTarget: D1BackupProvider["prepareRestoreTarget"] =
  async (input) => ({
    databaseId:
      `${input.configuredDatabaseId}:${input.attemptId}:${input.generation}`,
  });

beforeEach(async () => {
  await applyD1Migrations(
    testEnv.CATALOGUE_DB,
    testEnv.TEST_MIGRATIONS,
  );
  await testEnv.CATALOGUE_DB.prepare(
    "DELETE FROM catalogue_backup_retention",
  ).run();
  await testEnv.CATALOGUE_DB.prepare(
    "DELETE FROM catalogue_backup_attempts",
  ).run();
  await testEnv.CATALOGUE_DB.prepare(
    `UPDATE operation_state
     SET recovery_health = 'healthy', active_ingestion_run_id = NULL
     WHERE singleton = 1`,
  ).run();
});

test("restored verification executes the real D1 schema and rejects an empty or partial catalogue", async () => {
  await expect(verifyRestoredCatalogue(testEnv.CATALOGUE_DB, {
    expectedRevisionId: "catrev_spine_000",
    expectedSchemaMigrationLevel: 16,
    expected: {
      cards: 0,
      printings: 0,
      products: 0,
      legality_rules: 0,
      api_documents: 0,
      search_terms: 0,
      search_chunks: 0,
      provenance: 0,
      audit_rows: 0,
      representative_card_id: null,
      representative_printing_id: null,
      representative_product_id: null,
      representative_legality_rule_id: null,
      representative_search_text: null,
      representative_curated_revision_id: null,
      representative_curated_revision_digest: null,
      publication_ingestion_run_id: null,
    },
  })).rejects.toThrow("Restored D1 verification failed.");
});

test("the Cloudflare provider recreates the disposable D1 for each restore generation", async () => {
  const first = await cloudflareD1BackupProvider.prepareRestoreTarget({
    accountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
    configuredDatabaseId: testEnv.DISPOSABLE_D1_DATABASE_ID,
    token: "vitest-d1-verification-token-active",
    attemptId: "provider-restore-generation",
    previousDatabaseId: null,
    generation: 1,
  });
  const second = await cloudflareD1BackupProvider.prepareRestoreTarget({
    accountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
    configuredDatabaseId: testEnv.DISPOSABLE_D1_DATABASE_ID,
    token: "vitest-d1-verification-token-active",
    attemptId: "provider-restore-generation",
    previousDatabaseId: first.databaseId,
    generation: 2,
  });
  expect(first.databaseId).toMatch(
    /^00000000-0000-4000-8000-[0-9]{12}$/u,
  );
  expect(second.databaseId).toMatch(
    /^00000000-0000-4000-8000-[0-9]{12}$/u,
  );
  expect(second.databaseId).not.toBe(first.databaseId);
});

test("the production backup boundary exports and verifies the exact restored revision", async () => {
  const events: string[] = [];
  const schemaState = await testEnv.CATALOGUE_DB.prepare(
    "SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1",
  ).first<{ migration_level: number }>();
  if (schemaState === null) throw new Error("Catalogue schema state is unavailable.");
  const sqlBytes = new TextEncoder().encode(
    "-- exact D1 SQL export without derived FTS virtual tables\n",
  );
  const firstRestoreDatabaseId =
    `${testEnv.DISPOSABLE_D1_DATABASE_ID}:backup-production-boundary:1`;
  const provider: D1BackupProvider = {
    async exportSql(input) {
      events.push(`export:${input.databaseId}`);
      const virtual = await testEnv.CATALOGUE_DB.prepare(
        `SELECT count(*) AS count FROM sqlite_schema
         WHERE type = 'table'
           AND name LIKE 'revision_card%'
           AND lower(sql) LIKE '%create virtual table%'`,
      ).first<{ count: number }>();
      expect(virtual?.count).toBe(0);
      return {
        body: new Blob([sqlBytes]).stream(),
        size: sqlBytes.byteLength,
        bookmark: "bookmark-backup-1",
        filename: "catalogue.sql",
      };
    },
    prepareRestoreTarget: freshRestoreTarget,
    async restoreSql(input) {
      events.push(`restore:${input.databaseId}`);
      expect(new Uint8Array(await new Response(input.body).arrayBuffer()))
        .toEqual(sqlBytes);
      expect(input.size).toBe(sqlBytes.byteLength);
    },
    async reconstructAndVerify(input) {
      events.push(`verify:${input.databaseId}`);
      expect(input.expectedRevisionId).toBe("catrev_spine_000");
      expect(input.ownerToken).toMatch(/^backup:/);
      expect(input.expectedSchemaMigrationLevel).toBe(
        schemaState.migration_level,
      );
      return completeRestoredVerification();
    },
  };

  const document = await createVerifiedCatalogueBackup(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    {
      expectedCurrentRevisionId: "catrev_spine_000",
      idempotencyKey: "backup-production-boundary",
      observedAt: "2026-08-05T02:00:00.000Z",
      cloudflareAccountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
      catalogueDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
      disposableDatabaseId: testEnv.DISPOSABLE_D1_DATABASE_ID,
      exportToken: "export-token",
      verificationToken: "verification-token",
    },
    provider,
  );

  expect(document).toMatchObject({
    contract: "card-keepr-catalogue-backup@1",
    catalogue_revision_id: "catrev_spine_000",
    verified: true,
    d1_bookmark: "bookmark-backup-1",
    content_sha256:
      "85b8329ea262e672d4abc5352f8f1c504196ea0dfdc13c268575e5ba6ac2ec87",
    manifest_key: expect.stringMatching(/\/manifest\.json$/),
    manifest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    linked_attempt_id: null,
    retention: { newest_success: true, retain_until: null },
  });
  expect(events).toEqual([
    `export:${testEnv.CATALOGUE_D1_DATABASE_ID}`,
    `restore:${firstRestoreDatabaseId}`,
    `verify:${firstRestoreDatabaseId}`,
  ]);

  const replay = await createVerifiedCatalogueBackup(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    {
      expectedCurrentRevisionId: "catrev_spine_000",
      idempotencyKey: "backup-production-boundary",
      observedAt: "2026-08-05T02:01:00.000Z",
      cloudflareAccountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
      catalogueDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
      disposableDatabaseId: testEnv.DISPOSABLE_D1_DATABASE_ID,
      exportToken: "export-token",
      verificationToken: "verification-token",
    },
    provider,
  );
  expect(replay).toEqual(document);
  expect(events).toHaveLength(3);
  await expect(createVerifiedCatalogueBackup(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    {
      expectedCurrentRevisionId: "catrev_changed_999",
      idempotencyKey: "backup-production-boundary",
      observedAt: "2026-08-05T02:02:00.000Z",
      cloudflareAccountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
      catalogueDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
      disposableDatabaseId: testEnv.DISPOSABLE_D1_DATABASE_ID,
      exportToken: "export-token",
      verificationToken: "verification-token",
    },
    provider,
  )).rejects.toMatchObject({
    status: 409,
    code: "idempotency_key_reused",
  });
  const backup = await testEnv.BACKUPS.get(document.object_key);
  expect(new Uint8Array(await backup!.arrayBuffer())).toEqual(sqlBytes);
  const manifest = await testEnv.BACKUPS.get(document.manifest_key);
  expect(await manifest!.json()).toEqual({
    contract: "card-keepr-catalogue-backup-manifest@1",
    attempt_id: "backup-production-boundary",
    catalogue_revision_id: "catrev_spine_000",
    content_sha256:
      "85b8329ea262e672d4abc5352f8f1c504196ea0dfdc13c268575e5ba6ac2ec87",
    d1_bookmark: "bookmark-backup-1",
    export_bytes: sqlBytes.byteLength,
    exported_at: "2026-08-05T02:00:00.000Z",
    object_key: document.object_key,
    producing_workflow_identity: "backup-production-boundary",
    schema_migration_level: schemaState.migration_level,
    expected_evidence: {
      cards: 0,
      printings: 0,
      products: 0,
      legality_rules: 0,
      api_documents: 0,
      search_terms: 0,
      search_chunks: 0,
      provenance: 0,
      audit_rows: 0,
      representative_card_id: null,
      representative_printing_id: null,
      representative_product_id: null,
      representative_legality_rule_id: null,
      representative_search_text: null,
      representative_curated_revision_id: null,
      representative_curated_revision_digest: null,
      publication_ingestion_run_id: null,
    },
    verification: {
      disposable_database_id: firstRestoreDatabaseId,
      restore_generation: 1,
      verified: true,
      verified_at: "2026-08-05T02:00:00.000Z",
    },
  });
  await expect(testEnv.CATALOGUE_DB.prepare(
    `SELECT state, owner_token, lease_expires_at
     FROM card_search_fts_state WHERE singleton = 1`,
  ).first()).resolves.toEqual({
    state: "ready",
    owner_token: null,
    lease_expires_at: null,
  });
  await expect(testEnv.CATALOGUE_DB.prepare(
    "SELECT recovery_health FROM operation_state WHERE singleton = 1",
  ).first()).resolves.toEqual({ recovery_health: "healthy" });

  await createVerifiedCatalogueBackup(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    {
      expectedCurrentRevisionId: "catrev_spine_000",
      idempotencyKey: "backup-production-boundary-newest",
      observedAt: "2026-08-06T02:00:00.000Z",
      cloudflareAccountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
      catalogueDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
      disposableDatabaseId: testEnv.DISPOSABLE_D1_DATABASE_ID,
      exportToken: "export-token",
      verificationToken: "verification-token",
    },
    provider,
  );
  const secondRestoreDatabaseId =
    `${testEnv.DISPOSABLE_D1_DATABASE_ID}:backup-production-boundary-newest:1`;
  expect(secondRestoreDatabaseId).not.toBe(firstRestoreDatabaseId);
  expect(events.slice(-2)).toEqual([
    `restore:${secondRestoreDatabaseId}`,
    `verify:${secondRestoreDatabaseId}`,
  ]);
  const datedReplay = await createVerifiedCatalogueBackup(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    {
      expectedCurrentRevisionId: "catrev_spine_000",
      idempotencyKey: "backup-production-boundary",
      observedAt: "2026-08-07T02:00:00.000Z",
      cloudflareAccountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
      catalogueDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
      disposableDatabaseId: testEnv.DISPOSABLE_D1_DATABASE_ID,
      exportToken: "export-token",
      verificationToken: "verification-token",
    },
    provider,
  );
  expect(datedReplay.retention).toEqual({
    newest_success: false,
    retain_until: "2026-11-03T02:00:00.000Z",
  });
});

test("backup failure reconstructs live search and leaves recovery degraded", async () => {
  let exportAttempts = 0;
  let exportAvailable = false;
  const provider: D1BackupProvider = {
    async exportSql() {
      exportAttempts += 1;
      if (!exportAvailable) throw new Error("synthetic export outage");
      const bytes = new TextEncoder().encode("-- immutable retry export\n");
      return {
        body: new Blob([bytes]).stream(),
        size: bytes.byteLength,
        bookmark: "bookmark-immutable-retry",
        filename: "catalogue.sql",
      };
    },
    prepareRestoreTarget: freshRestoreTarget,
    async restoreSql(input) {
      await new Response(input.body).arrayBuffer();
    },
    async reconstructAndVerify() {
      return completeRestoredVerification();
    },
  };

  await expect(createVerifiedCatalogueBackup(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    {
      expectedCurrentRevisionId: "catrev_spine_000",
      idempotencyKey: "backup-production-failure",
      observedAt: "2026-08-05T03:00:00.000Z",
      cloudflareAccountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
      catalogueDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
      disposableDatabaseId: testEnv.DISPOSABLE_D1_DATABASE_ID,
      exportToken: "export-token",
      verificationToken: "verification-token",
    },
    provider,
  )).rejects.toThrow("synthetic export outage");
  await expect(createVerifiedCatalogueBackup(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    {
      expectedCurrentRevisionId: "catrev_spine_000",
      idempotencyKey: "backup-production-failure",
      observedAt: "2026-08-05T03:01:00.000Z",
      cloudflareAccountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
      catalogueDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
      disposableDatabaseId: testEnv.DISPOSABLE_D1_DATABASE_ID,
      exportToken: "export-token",
      verificationToken: "verification-token",
    },
    provider,
  )).rejects.toMatchObject({ status: 409, code: "backup_failed" });
  expect(exportAttempts).toBe(1);
  await expect(testEnv.CATALOGUE_DB.prepare(
    `SELECT state, failure_code FROM catalogue_backup_attempts
     WHERE idempotency_key = 'backup-production-failure'`,
  ).first()).resolves.toEqual({
    state: "failed",
    failure_code: "backup_failed",
  });
  await expect(testEnv.CATALOGUE_DB.prepare(
    "SELECT state FROM card_search_fts_state WHERE singleton = 1",
  ).first()).resolves.toEqual({ state: "ready" });
  await expect(testEnv.CATALOGUE_DB.prepare(
    "SELECT recovery_health FROM operation_state WHERE singleton = 1",
  ).first()).resolves.toEqual({ recovery_health: "degraded" });

  const failedStatus = await catalogueBackupAttemptStatus(
    testEnv.CATALOGUE_DB,
    "backup-production-failure",
  );
  expect(failedStatus).toMatchObject({
    contract: "card-keepr-catalogue-backup-status@1",
    state: "failed",
    attempt_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    retry: {
      failed_attempt_id: "backup-production-failure",
      failed_attempt_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    },
  });
  await expect(createVerifiedCatalogueBackup(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    {
      expectedCurrentRevisionId: "catrev_spine_000",
      idempotencyKey: "backup-production-unlinked-after-failure",
      observedAt: "2026-08-05T03:05:00.000Z",
      cloudflareAccountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
      catalogueDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
      disposableDatabaseId: testEnv.DISPOSABLE_D1_DATABASE_ID,
      exportToken: "export-token",
      verificationToken: "verification-token",
    },
    provider,
  )).rejects.toMatchObject({
    status: 409,
    code: "backup_retry_required",
  });
  await expect(testEnv.CATALOGUE_DB.prepare(
    `SELECT 1 AS present FROM catalogue_backup_attempts
     WHERE idempotency_key = 'backup-production-unlinked-after-failure'`,
  ).first()).resolves.toBeNull();
  await expect(createVerifiedCatalogueBackup(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    {
      expectedCurrentRevisionId: "catrev_spine_000",
      idempotencyKey: "backup-production-newer-failure",
      observedAt: "2026-08-05T03:06:00.000Z",
      cloudflareAccountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
      catalogueDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
      disposableDatabaseId: testEnv.DISPOSABLE_D1_DATABASE_ID,
      exportToken: "export-token",
      verificationToken: "verification-token",
      failedAttemptId: "backup-production-failure",
      failedAttemptDigest: String(failedStatus.attempt_digest),
    },
    provider,
  )).rejects.toThrow("synthetic export outage");
  const newerFailedStatus = await catalogueBackupAttemptStatus(
    testEnv.CATALOGUE_DB,
    "backup-production-newer-failure",
  );
  await expect(testEnv.CATALOGUE_DB.prepare(
    "SELECT recovery_health FROM operation_state WHERE singleton = 1",
  ).first()).resolves.toEqual({ recovery_health: "degraded" });
  await expect(createVerifiedCatalogueBackup(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    {
      expectedCurrentRevisionId: "catrev_spine_000",
      idempotencyKey: "backup-production-superseded-retry",
      observedAt: "2026-08-05T03:07:00.000Z",
      cloudflareAccountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
      catalogueDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
      disposableDatabaseId: testEnv.DISPOSABLE_D1_DATABASE_ID,
      exportToken: "export-token",
      verificationToken: "verification-token",
      failedAttemptId: "backup-production-failure",
      failedAttemptDigest: String(failedStatus.attempt_digest),
    },
    provider,
  )).rejects.toMatchObject({
    status: 409,
    code: "backup_retry_source_superseded",
  });
  await expect(testEnv.CATALOGUE_DB.prepare(
    `SELECT 1 AS present FROM catalogue_backup_attempts
     WHERE idempotency_key = 'backup-production-superseded-retry'`,
  ).first()).resolves.toBeNull();
  await expect(createVerifiedCatalogueBackup(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    {
      expectedCurrentRevisionId: "catrev_spine_000",
      idempotencyKey: "backup-production-wrong-retry",
      observedAt: "2026-08-05T03:08:00.000Z",
      cloudflareAccountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
      catalogueDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
      disposableDatabaseId: testEnv.DISPOSABLE_D1_DATABASE_ID,
      exportToken: "export-token",
      verificationToken: "verification-token",
      failedAttemptId: "backup-production-newer-failure",
      failedAttemptDigest: "0".repeat(64),
    },
    provider,
  )).rejects.toMatchObject({
    status: 409,
    code: "backup_digest_mismatch",
  });
  exportAvailable = true;
  const retry = await createVerifiedCatalogueBackup(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    {
      expectedCurrentRevisionId: "catrev_spine_000",
      idempotencyKey: "backup-production-failure-retry",
      observedAt: "2026-08-05T03:10:00.000Z",
      cloudflareAccountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
      catalogueDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
      disposableDatabaseId: testEnv.DISPOSABLE_D1_DATABASE_ID,
      exportToken: "export-token",
      verificationToken: "verification-token",
      failedAttemptId: "backup-production-newer-failure",
      failedAttemptDigest: String(newerFailedStatus.attempt_digest),
    },
    provider,
  );
  expect(retry).toMatchObject({
    linked_attempt_id: "backup-production-newer-failure",
    retention: { newest_success: true, retain_until: null },
  });
  expect(retry.object_key).not.toContain("backup-production-failure.sql");
  expect(exportAttempts).toBe(3);
  await expect(testEnv.CATALOGUE_DB.prepare(
    "SELECT recovery_health FROM operation_state WHERE singleton = 1",
  ).first()).resolves.toEqual({ recovery_health: "healthy" });

  await expect(createVerifiedCatalogueBackup(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    {
      expectedCurrentRevisionId: "catrev_spine_000",
      idempotencyKey: "backup-periodic-after-recovery",
      observedAt: "2026-08-05T03:12:00.000Z",
      cloudflareAccountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
      catalogueDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
      disposableDatabaseId: testEnv.DISPOSABLE_D1_DATABASE_ID,
      exportToken: "export-token",
      verificationToken: "verification-token",
    },
    provider,
  )).resolves.toMatchObject({
    linked_attempt_id: null,
    verified: true,
  });
  expect(exportAttempts).toBe(4);
});

test("recovery stays degraded unless every restored catalogue contract passes", async () => {
  const sqlBytes = new TextEncoder().encode("-- incomplete verified restore\n");
  const provider = {
    async exportSql() {
      return {
        body: new Blob([sqlBytes]).stream(),
        size: sqlBytes.byteLength,
        bookmark: "bookmark-incomplete-verification",
        filename: "catalogue.sql",
      };
    },
    prepareRestoreTarget: freshRestoreTarget,
    async restoreSql(input: { body: ReadableStream<Uint8Array> }) {
      await new Response(input.body).arrayBuffer();
    },
    async reconstructAndVerify() {
      return {
        schema: true,
        integrity: true,
        current_revision: true,
        representative_entities: true,
        search: true,
        provenance: false,
        audit: true,
        api: true,
      };
    },
  } as unknown as D1BackupProvider;

  await expect(createVerifiedCatalogueBackup(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    {
      expectedCurrentRevisionId: "catrev_spine_000",
      idempotencyKey: "backup-incomplete-verification",
      observedAt: "2026-08-05T03:20:00.000Z",
      cloudflareAccountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
      catalogueDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
      disposableDatabaseId: testEnv.DISPOSABLE_D1_DATABASE_ID,
      exportToken: "export-token",
      verificationToken: "verification-token",
    },
    provider,
  )).rejects.toThrow(/restored.*verification/iu);
  await expect(testEnv.CATALOGUE_DB.prepare(
    "SELECT recovery_health FROM operation_state WHERE singleton = 1",
  ).first()).resolves.toEqual({ recovery_health: "degraded" });
});

test("the Workflow can resume the same owner after an interrupted active attempt", async () => {
  const sqlBytes = new TextEncoder().encode("-- resumable export\n");
  let exportsAttempted = 0;
  const provider: D1BackupProvider = {
    async exportSql() {
      exportsAttempted += 1;
      if (exportsAttempted === 1) throw new Error("interrupted export");
      return {
        body: new Blob([sqlBytes]).stream(),
        size: sqlBytes.byteLength,
        bookmark: "bookmark-resumed",
        filename: "catalogue.sql",
      };
    },
    prepareRestoreTarget: freshRestoreTarget,
    async restoreSql(input) {
      await new Response(input.body).arrayBuffer();
    },
    async reconstructAndVerify() {
      return completeRestoredVerification();
    },
  };
  const input = {
    expectedCurrentRevisionId: "catrev_spine_000",
    idempotencyKey: "backup-production-resume",
    observedAt: "2026-08-05T03:30:00.000Z",
    cloudflareAccountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
    catalogueDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
    disposableDatabaseId: testEnv.DISPOSABLE_D1_DATABASE_ID,
    exportToken: "export-token",
    verificationToken: "verification-token",
  } as const;
  await expect(createVerifiedCatalogueBackup(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    input,
    provider,
    { terminalFailure: false },
  )).rejects.toThrow("interrupted export");
  await expect(createVerifiedCatalogueBackup(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    input,
    provider,
    { terminalFailure: false },
  )).resolves.toMatchObject({
    verified: true,
    d1_bookmark: "bookmark-resumed",
  });
  expect(exportsAttempted).toBe(2);
});

test("a lost import response recreates and journals a fresh disposable target before retry", async () => {
  const sqlBytes = new TextEncoder().encode("-- lost import response\n");
  const preparedTargets: string[] = [];
  const populatedTargets = new Set<string>();
  let importAttempts = 0;
  const provider: D1BackupProvider = {
    async exportSql() {
      return {
        body: new Blob([sqlBytes]).stream(),
        size: sqlBytes.byteLength,
        bookmark: "bookmark-lost-import-response",
        filename: "catalogue.sql",
      };
    },
    async prepareRestoreTarget(input) {
      const databaseId = `disposable-${input.attemptId}-${input.generation}`;
      expect(input.previousDatabaseId).toBe(
        input.generation === 1 ? null : preparedTargets.at(-1),
      );
      preparedTargets.push(databaseId);
      return { databaseId };
    },
    async restoreSql(input) {
      importAttempts += 1;
      if (populatedTargets.has(input.databaseId)) {
        throw new Error("schema replayed into a populated disposable D1");
      }
      populatedTargets.add(input.databaseId);
      await new Response(input.body).arrayBuffer();
      if (importAttempts === 1) {
        throw new Error("synthetic lost import response");
      }
    },
    async reconstructAndVerify(input) {
      expect(input.databaseId).toBe(preparedTargets.at(-1));
      return completeRestoredVerification();
    },
  };
  const input = {
    expectedCurrentRevisionId: "catrev_spine_000",
    idempotencyKey: "backup-lost-import-response",
    observedAt: "2026-08-05T03:35:00.000Z",
    cloudflareAccountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
    catalogueDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
    disposableDatabaseId: testEnv.DISPOSABLE_D1_DATABASE_ID,
    exportToken: "export-token",
    verificationToken: "verification-token",
  } as const;

  await expect(createVerifiedCatalogueBackup(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    input,
    provider,
    { terminalFailure: false },
  )).rejects.toThrow("synthetic lost import response");
  await expect(testEnv.CATALOGUE_DB.prepare(
    `SELECT state, disposable_database_id, restore_generation, restore_phase
     FROM catalogue_backup_attempts WHERE idempotency_key = ?`,
  ).bind(input.idempotencyKey).first()).resolves.toEqual({
    state: "restoring_verification",
    disposable_database_id: preparedTargets[0],
    restore_generation: 1,
    restore_phase: "importing",
  });

  await expect(createVerifiedCatalogueBackup(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    input,
    provider,
    { terminalFailure: false },
  )).resolves.toMatchObject({ verified: true });
  expect(preparedTargets).toEqual([
    "disposable-backup-lost-import-response-1",
    "disposable-backup-lost-import-response-2",
  ]);
  expect(importAttempts).toBe(2);
});

test("an exact retained export resumes after the R2 put and D1 transition response is lost", async () => {
  const sqlBytes = new TextEncoder().encode("-- retained ambiguous export\n");
  let exportsAttempted = 0;
  const provider: D1BackupProvider = {
    async exportSql() {
      exportsAttempted += 1;
      return {
        body: new Blob([sqlBytes]).stream(),
        size: sqlBytes.byteLength,
        bookmark: "bookmark-ambiguous-transition",
        filename: "catalogue.sql",
      };
    },
    prepareRestoreTarget: freshRestoreTarget,
    async restoreSql(input) {
      await new Response(input.body).arrayBuffer();
    },
    async reconstructAndVerify() {
      return completeRestoredVerification();
    },
  };
  const input = {
    expectedCurrentRevisionId: "catrev_spine_000",
    idempotencyKey: "backup-ambiguous-r2-transition",
    observedAt: "2026-08-05T03:40:00.000Z",
    cloudflareAccountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
    catalogueDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
    disposableDatabaseId: testEnv.DISPOSABLE_D1_DATABASE_ID,
    exportToken: "export-token",
    verificationToken: "verification-token",
  } as const;
  await testEnv.CATALOGUE_DB.prepare(
    `CREATE TRIGGER synthetic_lost_export_transition
     BEFORE UPDATE OF state ON catalogue_backup_attempts
     WHEN OLD.state = 'exporting' AND NEW.state = 'restoring_verification'
     BEGIN SELECT RAISE(ABORT, 'synthetic_lost_export_transition'); END`,
  ).run();
  await expect(createVerifiedCatalogueBackup(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    input,
    provider,
    { terminalFailure: false },
  )).rejects.toThrow();
  await testEnv.CATALOGUE_DB.prepare(
    "DROP TRIGGER synthetic_lost_export_transition",
  ).run();
  await expect(createVerifiedCatalogueBackup(
    testEnv.CATALOGUE_DB,
    testEnv.BACKUPS,
    input,
    provider,
    { terminalFailure: false },
  )).resolves.toMatchObject({
    verified: true,
    d1_bookmark: "bookmark-ambiguous-transition",
  });
  expect(exportsAttempted).toBe(1);
});

test("terminal Workflow failure is an exact replayable observation", async () => {
  let creates = 0;
  const instance = {
    status: async () => ({
      status: "errored" as const,
      error: { message: "terminal workflow outage" },
    }),
  } as unknown as WorkflowInstance;
  const workflow = {
    create: async () => {
      creates += 1;
      return instance;
    },
    get: async () => instance,
  } as unknown as Workflow<CatalogueBackupWorkflowParams>;
  const input = {
    expected_current_revision_id: "catrev_spine_000",
    idempotency_key: "backup-terminal-observation",
  } as const;
  const first = await startOrObserveCatalogueBackupWorkflow(
    testEnv.CATALOGUE_DB,
    workflow,
    input,
    "2026-08-05T03:45:00.000Z",
  );
  const replay = await startOrObserveCatalogueBackupWorkflow(
    testEnv.CATALOGUE_DB,
    workflow,
    input,
    "2026-08-05T03:46:00.000Z",
  );
  expect(first.created).toBe(true);
  expect(replay.created).toBe(false);
  expect(replay.document).toEqual(first.document);
  expect(first.document).toMatchObject({
    contract: "card-keepr-catalogue-backup-workflow@1",
    status: "complete",
    output: {
      contract: "card-keepr-catalogue-backup-workflow-failure@1",
      code: "backup_failed",
      detail: "terminal workflow outage",
    },
  });
  expect(creates).toBe(1);
});

test("the authenticated status route exposes the exact pending publication attempt and resume request", async () => {
  await testEnv.CATALOGUE_DB.prepare(
    `INSERT INTO catalogue_backup_attempts (
       idempotency_key, request_json, owner_token, catalogue_revision_id,
       state, object_key, started_at, publication_ingestion_run_id
     ) VALUES (?, ?, ?, ?, 'pending', ?, ?, (
       SELECT ingestion_run_id FROM catalogue_revisions WHERE id = ?
     ))`,
  ).bind(
    "backup-production-route",
    '{"expected_current_revision_id":"catrev_spine_000"}',
    `backup:${"a".repeat(64)}`,
    "catrev_spine_000",
    "d1-backups/catrev_spine_000/pending/catalogue.sql",
    "2026-08-05T04:00:00.000Z",
    "catrev_spine_000",
  ).run();
  const statusResponse = await exports.default.fetch(new Request(
    "https://card-keepr.invalid/v1/backups/backup-production-route",
    { headers: { authorization: "Bearer vitest-administration-key" } },
  ));
  expect(statusResponse.status).toBe(200);
  await expect(statusResponse.json()).resolves.toMatchObject({
    contract: "card-keepr-catalogue-backup-status@1",
    idempotency_key: "backup-production-route",
    state: "pending",
    attempt_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    workflow_instance_id: null,
    resume: {
      method: "POST",
      path: "/v1/backups",
      body: {
        expected_current_revision_id: "catrev_spine_000",
        idempotency_key: "backup-production-route",
      },
    },
  });
  const revisionResponse = await exports.default.fetch(new Request(
    "https://card-keepr.invalid/v1/catalogue-revisions/catrev_spine_000/backups",
    { headers: { authorization: "Bearer vitest-administration-key" } },
  ));
  expect(revisionResponse.status).toBe(200);
  const revisionBackups = await revisionResponse.json() as {
    attempts: Record<string, unknown>[];
  } & Record<string, unknown>;
  expect(revisionBackups).toMatchObject({
    contract: "card-keepr-catalogue-revision-backups@1",
    catalogue_revision_id: "catrev_spine_000",
  });
  expect(revisionBackups.attempts.find((attempt) =>
    attempt.idempotency_key === "backup-production-route"
  )).toMatchObject({
      idempotency_key: "backup-production-route",
      state: "pending",
      resume: {
        body: { idempotency_key: "backup-production-route" },
      },
    });
});

test("the backup route reports stale revision as a stable conflict", async () => {
  const response = await exports.default.fetch(new Request(
    "https://card-keepr.invalid/v1/backups",
    {
      method: "POST",
      headers: {
        authorization: "Bearer vitest-administration-key",
        "content-type": "application/json",
        "x-keepr-test-now": "2026-08-05T05:00:00.000Z",
      },
      body: JSON.stringify({
        expected_current_revision_id: "catrev_stale_999",
        idempotency_key: "backup-production-stale",
      }),
    },
  ));
  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toMatchObject({
    code: "current_revision_mismatch",
  });
});

test("backup retry rejects source state, revision, and digest before Workflow creation", async () => {
  const insertAttempt = async (
    id: string,
    state: "pending" | "failed",
    revisionId: string,
    linkedAttemptId: string | null = null,
  ) => {
    await testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO catalogue_backup_attempts (
         idempotency_key, request_json, owner_token, catalogue_revision_id,
         state, object_key, started_at, failure_code, failure_detail,
         completed_at, linked_attempt_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      JSON.stringify({ expected_current_revision_id: revisionId }),
      `backup:${id.padEnd(64, "0").slice(0, 64)}`,
      revisionId,
      state,
      `d1-backups/${revisionId}/${id}/catalogue.sql`,
      "2026-08-05T06:00:00.000Z",
      state === "failed" ? "backup_failed" : null,
      state === "failed" ? "synthetic failure" : null,
      state === "failed" ? "2026-08-05T06:01:00.000Z" : null,
      linkedAttemptId,
    ).run();
  };
  await insertAttempt("backup-source-pending", "pending", "catrev_spine_000");
  await insertAttempt("backup-source-old", "failed", "catrev_old_000");
  await insertAttempt("backup-source-current", "failed", "catrev_spine_000");
  await insertAttempt(
    "backup-source-current-child",
    "failed",
    "catrev_spine_000",
    "backup-source-current",
  );

  const unlinked = await exports.default.fetch(new Request(
    "https://card-keepr.invalid/v1/backups",
    {
      method: "POST",
      headers: {
        authorization: "Bearer vitest-administration-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        expected_current_revision_id: "catrev_spine_000",
        idempotency_key: "backup-unlinked-route",
      }),
    },
  ));
  expect(unlinked.status).toBe(409);
  await expect(unlinked.json()).resolves.toMatchObject({
    code: "backup_retry_required",
  });

  const retry = (failedAttemptId: string, failedAttemptDigest: string) =>
    exports.default.fetch(new Request("https://card-keepr.invalid/v1/backups", {
      method: "POST",
      headers: {
        authorization: "Bearer vitest-administration-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        expected_current_revision_id: "catrev_spine_000",
        idempotency_key: `retry-${failedAttemptId}`,
        failed_attempt_id: failedAttemptId,
        failed_attempt_digest: failedAttemptDigest,
      }),
    }));
  const notFailed = await retry("backup-source-pending", "0".repeat(64));
  expect(notFailed.status).toBe(409);
  await expect(notFailed.json()).resolves.toMatchObject({
    code: "source_backup_not_failed",
  });
  const oldRevision = await retry("backup-source-old", "0".repeat(64));
  expect(oldRevision.status).toBe(409);
  await expect(oldRevision.json()).resolves.toMatchObject({
    code: "backup_not_current_revision",
  });
  const parentStatus = await catalogueBackupAttemptStatus(
    testEnv.CATALOGUE_DB,
    "backup-source-current",
  );
  const superseded = await retry(
    "backup-source-current",
    String(parentStatus.attempt_digest),
  );
  expect(superseded.status).toBe(409);
  await expect(superseded.json()).resolves.toMatchObject({
    code: "backup_retry_source_superseded",
  });
  const wrongDigest = await retry("backup-source-current-child", "0".repeat(64));
  expect(wrongDigest.status).toBe(409);
  await expect(wrongDigest.json()).resolves.toMatchObject({
    code: "backup_digest_mismatch",
  });
  const retained = await testEnv.CATALOGUE_DB.prepare(
    `SELECT count(*) AS count FROM catalogue_backup_workflow_requests
     WHERE idempotency_key LIKE 'retry-backup-source-%'
        OR idempotency_key = 'backup-unlinked-route'`,
  ).first<{ count: number }>();
  expect(retained?.count).toBe(0);
});
