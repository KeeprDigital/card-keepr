import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

// Synthetic provider inventory and injected mismatches, never live deletion.
test("dev Disposable Restore generations delete only the dev scratch namespace", async (t) => {
  const vite = await createServer({ logLevel: "silent", server: { middlewareMode: true } });
  t.after(() => vite.close());
  const { cloudflareD1BackupProvider } = await vite.ssrLoadModule("/src/catalogue/backup-recovery/backup-recovery.ts");
  const deleted = [];
  const created = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_url, options) => {
    if (options.method === "GET")
      return Response.json({
        success: true,
        result: [
          { name: "card-keepr-disposable-verification", uuid: "production-scratch" },
          { name: "card-keepr-disposable-verification-dev", uuid: "dev-scratch" },
          { name: "card-keepr-disposable-verification-staging", uuid: "staging-scratch" },
          { name: "card-keepr-catalogue-dev-replacement", uuid: "retained-replacement" },
        ],
      });
    if (options.method === "DELETE") deleted.push(String(_url).split("/").at(-1));
    if (options.method === "POST") created.push(JSON.parse(options.body).name);
    return Response.json({ success: true, result: { uuid: "new-dev-scratch" } });
  };
  const result = await cloudflareD1BackupProvider.prepareRestoreTarget({
    accountId: "synthetic-account",
    token: "synthetic-token",
    configuredDatabaseId: "dev-scratch",
    disposableDatabaseName: "card-keepr-disposable-verification-dev",
    previousDatabaseId: "dev-scratch",
    generation: 2,
    attemptId: "synthetic-attempt",
  });
  assert.equal(result.databaseId, "new-dev-scratch");
  assert.deepEqual(deleted, ["dev-scratch"]);
  assert.deepEqual(created, ["card-keepr-disposable-verification-dev"]);
});
