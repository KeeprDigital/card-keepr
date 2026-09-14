import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "vite";
import { d1Adapter } from "./query-helpers/sqlite-d1-adapter.mjs";

export async function stagingStateFixture(t) {
  const vite = await createServer({ logLevel: "silent", server: { middlewareMode: true } });
  t.after(() => vite.close());
  const { resolveStagingRelease, showStagingRelease } = await vite.ssrLoadModule(
    "/src/catalogue/ingestion/staging-release.ts",
  );
  const { catalogueStore } = await vite.ssrLoadModule("/src/catalogue/shared/index.ts");
  const sql = new DatabaseSync(":memory:");
  t.after(() => sql.close());
  const migrations = (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort();
  for (const name of migrations) sql.exec(await readFile(`migrations/${name}`, "utf8"));
  const database = catalogueStore(d1Adapter(sql));
  const target = {
    cloudflare_account_id: "0123456789abcdef0123456789abcdef",
    worker_scripts: ["card-keepr-api", "card-keepr-ingestion"],
    d1_databases: [
      { name: "card-keepr-catalogue", id: "00000000-0000-0000-0000-000000000001" },
      { name: "card-keepr-disposable-verification", id: "00000000-0000-0000-0000-000000000002" },
    ],
    r2_buckets: [
      "card-keepr-evidence",
      "card-keepr-printing-images",
      "card-keepr-catalogue-exports",
      "card-keepr-backups",
    ],
  };
  const bucket = { head: async () => null, list: async () => ({ objects: [], truncated: false }) };
  const choices = {
    release_id: "staging-237",
    idempotency_key: "owner-237",
    expected_head_sha: "a".repeat(40),
    expected_actor: "owner",
    ci_run_id: "123",
    validation_scope: "full",
  };
  return { vite, sql, database, bucket, target, choices, migrations, resolveStagingRelease, showStagingRelease };
}
