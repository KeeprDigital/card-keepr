import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { Miniflare } from "miniflare";
import { unstable_getMiniflareWorkerOptions } from "wrangler";
import { applyMigrations, persistedDatabaseDirectory } from "./acceptance-runtime.mjs";
import { catalogueStateTableExists } from "./query-helpers/schema.mjs";

/** Import the frozen schema-32 fixture before running the shipped migration.
 * Its database and object bytes came from actual publications on the recorded commit.
 */
export async function installCardModelPredecessor(statePath, config) {
  const bytes = await readFile(new URL("../fixtures/card-model-predecessor.json.gz", import.meta.url));
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "7b11368a8ae4e4da997d6f6d9e1b97a164cbdf92ad7ba451964d200e9518b4b8",
  );
  const fixture = JSON.parse(gunzipSync(bytes));
  assert.equal(fixture.schema, 32);
  assert.equal(fixture.commit, "d0f6ccaec3ca248c2e117b193d6d0251a0cf23c7");
  // Allocate this disposable binding's file before replacing it with the predecessor.
  await applyMigrations(statePath, config);
  const directory = await persistedDatabaseDirectory(statePath);
  const files = (await readdir(directory, { recursive: true })).filter((name) => {
    if (!name.endsWith(".sqlite")) return false;
    const database = new DatabaseSync(join(directory, name), { readOnly: true });
    try {
      return !!catalogueStateTableExists(database).get();
    } finally {
      database.close();
    }
  });
  assert.equal(files.length, 1);
  const databasePath = join(directory, files[0]);
  await rm(`${databasePath}-wal`, { force: true });
  await rm(`${databasePath}-shm`, { force: true });
  await writeFile(databasePath, Buffer.from(fixture.database, "base64"));
  const options = unstable_getMiniflareWorkerOptions(config).workerOptions;
  const suffix = createHash("sha256").update(resolve(statePath)).digest("hex").slice(0, 16);
  const buckets = Object.fromEntries(
    Object.entries(options.r2Buckets).map(([binding, value]) => [
      binding,
      { ...value, id: `${typeof value === "string" ? value : value.id}-${suffix}` },
    ]),
  );
  const runtime = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("migration fixture")}}',
    compatibilityDate: options.compatibilityDate,
    r2Buckets: buckets,
    r2Persist: join(dirname(resolve(statePath)), "miniflare/r2"),
  });
  try {
    for (const object of fixture.objects) {
      const bucket = await runtime.getR2Bucket(object.binding);
      await bucket.put(object.key, Buffer.from(object.bytes, "base64"), {
        httpMetadata: object.httpMetadata,
        customMetadata: object.customMetadata,
      });
    }
  } finally {
    await runtime.dispose();
  }
  return { fixture, databasePath };
}
