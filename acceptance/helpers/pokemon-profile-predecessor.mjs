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

const sha = (value) => createHash("sha256").update(value).digest("hex");

export async function readPokemonProfilePredecessor() {
  const bytes = await readFile(new URL("../fixtures/pokemon-profile-predecessor.json.gz", import.meta.url));
  assert.equal(sha(bytes), "75eb256770ca1f99e9eb28a3b99dc6409b0e209fd8d4a8d340de1201f65cb4fa");
  const fixture = JSON.parse(gunzipSync(bytes));
  assert.equal(fixture.contract, "card-keepr-pokemon-profile-predecessor@1");
  assert.equal(fixture.commit, "ebbdd7abeccc241e0dac050f70c2977325b2223e");
  assert.equal(fixture.schema, 37);
  for (const state of Object.values(fixture.states)) {
    const database = Buffer.from(state.database, "base64");
    assert.equal(database.length, state.bytes);
    assert.equal(sha(database), state.sha256);
    assert.equal(sha(state.candidate.definition_pins_json), state.candidate.definitions_sha256);
  }
  for (const object of fixture.objects) {
    const content = Buffer.from(object.bytes, "base64");
    assert.equal(content.length, object.length, object.key);
    assert.equal(sha(content), object.sha256, object.key);
  }
  return fixture;
}

/** Restore actual old application bytes; no fixture definition or receipt is rewritten. */
export async function installPokemonProfilePredecessor(statePath, config, fixture, stateName) {
  await applyMigrations(statePath, config);
  const directory = await persistedDatabaseDirectory(statePath);
  const files = [];
  for (const name of await readdir(directory, { recursive: true })) {
    if (!name.endsWith(".sqlite")) continue;
    const database = new DatabaseSync(join(directory, name), { readOnly: true });
    try {
      if (catalogueStateTableExists(database).get()) files.push(name);
    } finally {
      database.close();
    }
  }
  assert.equal(files.length, 1);
  const databasePath = join(directory, files[0]);
  await rm(`${databasePath}-wal`, { force: true });
  await rm(`${databasePath}-shm`, { force: true });
  await writeFile(databasePath, Buffer.from(fixture.states[stateName].database, "base64"));
  const options = unstable_getMiniflareWorkerOptions(config).workerOptions;
  const suffix = sha(resolve(statePath)).slice(0, 16);
  const buckets = Object.fromEntries(
    Object.entries(options.r2Buckets).map(([binding, value]) => [
      binding,
      { ...value, id: `${typeof value === "string" ? value : value.id}-${suffix}` },
    ]),
  );
  const runtime = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("profile predecessor")}}',
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
  return databasePath;
}
