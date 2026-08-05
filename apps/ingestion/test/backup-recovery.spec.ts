import {
  applyD1Migrations,
  env,
  type D1Migration,
} from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import {
  createVerifiedCatalogueBackup,
  type D1BackupProvider,
} from "../../../src/catalogue/backup-recovery";
import {
  startOrObserveCatalogueBackupWorkflow,
  type CatalogueBackupWorkflowParams,
} from "../../../src/catalogue/backup-workflow";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };

beforeEach(async () => {
  await applyD1Migrations(
    testEnv.CATALOGUE_DB,
    testEnv.TEST_MIGRATIONS,
  );
});

test("the production backup boundary exports and verifies the exact restored revision", async () => {
  const events: string[] = [];
  const sqlBytes = new TextEncoder().encode(
    "-- exact D1 SQL export without derived FTS virtual tables\n",
  );
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
  });
  expect(events).toEqual([
    `export:${testEnv.CATALOGUE_D1_DATABASE_ID}`,
    `restore:${testEnv.DISPOSABLE_D1_DATABASE_ID}`,
    `verify:${testEnv.DISPOSABLE_D1_DATABASE_ID}`,
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
});

test("backup failure reconstructs live search and leaves recovery degraded", async () => {
  let exportAttempts = 0;
  const provider: D1BackupProvider = {
    async exportSql() {
      exportAttempts += 1;
      throw new Error("synthetic export outage");
    },
    async restoreSql() {
      throw new Error("restore must not run");
    },
    async reconstructAndVerify() {
      throw new Error("verification must not run");
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
    async restoreSql(input) {
      await new Response(input.body).arrayBuffer();
    },
    async reconstructAndVerify() {},
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

test("the authenticated route starts and observes one durable backup Workflow", async () => {
  let document: Record<string, unknown> | null = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await exports.default.fetch(new Request(
      "https://card-keepr.invalid/v1/backups",
      {
        method: "POST",
        headers: {
          authorization: "Bearer vitest-administration-key",
          "content-type": "application/json",
          "x-keepr-test-now": "2026-08-05T04:00:00.000Z",
        },
        body: JSON.stringify({
          expected_current_revision_id: "catrev_spine_000",
          idempotency_key: "backup-production-route",
        }),
      },
    ));
    expect([200, 202]).toContain(response.status);
    document = await response.json<Record<string, unknown>>();
    expect(document).toMatchObject({
      contract: "card-keepr-catalogue-backup-workflow@1",
      expected_current_revision_id: "catrev_spine_000",
      idempotency_key: "backup-production-route",
    });
    if (document.status === "complete") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(document).toMatchObject({
    status: "complete",
    output: {
      contract: "card-keepr-catalogue-backup@1",
      catalogue_revision_id: "catrev_spine_000",
      verified: true,
      d1_bookmark: "vitest-export-bookmark",
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
