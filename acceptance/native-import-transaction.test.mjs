import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nativeRecoveryCloudflare } from "./helpers/native-recovery-cloudflare.mjs";
import {
  invalidNativeImportSql,
  nativeImportedRows,
  nativeImportState,
  validNativeImportSql,
} from "./helpers/query-helpers/native-import-state.mjs";

test("native SQL import commits the file before lost response and rolls back invalid SQL", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-native-import-"));
  const provider = nativeRecoveryCloudflare({ directory, databaseDirectory: directory });
  t.after(async () => {
    provider.close();
    await rm(directory, { recursive: true, force: true });
  });
  const create = () =>
    provider.fetch(new Request("https://api.cloudflare.com/client/v4/accounts/local/d1/database", { method: "POST" }));
  const upload = (sql) =>
    provider.fetch(new Request("https://native-upload.invalid/snapshot", { method: "PUT", body: sql }));
  const ingest = () =>
    provider.fetch(
      new Request("https://api.cloudflare.com/client/v4/accounts/local/d1/database/target/import", {
        method: "POST",
        body: JSON.stringify({ action: "ingest" }),
      }),
    );
  await create();
  await upload(invalidNativeImportSql);
  await assert.rejects(ingest(), /absent_table/);
  assert.deepEqual(nativeImportState(provider.target), { tablePresent: false, foreignKeys: 1 });
  await upload(validNativeImportSql);
  provider.faults.lostImportResponses = 1;
  assert.equal((await (await ingest()).json()).success, false);
  assert.deepEqual(nativeImportedRows(provider.target), [1, 2]);
  assert.deepEqual(nativeImportState(provider.target), { tablePresent: true, foreignKeys: 1 });
});
