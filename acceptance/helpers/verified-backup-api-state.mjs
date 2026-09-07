import { DatabaseSync } from "node:sqlite";
import { copyFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { persistedDatabaseDirectory } from "./acceptance-runtime.mjs";
import { catalogueStateTableExists } from "./query-helpers/schema.mjs";

/** Use the actual last Cloudflare-verification import for a separate API boot.
 * Restore the disposable test binding in place, retaining its R2 objects and
 * binding identity. This also supports in-process persistence keyed by statePath.
 * Call only after both source runtimes have stopped and checkpoint verification passed.
 */
export async function verifiedBackupApiState(statePath, directory) {
  const imports = (await readdir(directory))
    .filter((name) => /^restore-[0-9]+\.sqlite$/u.test(name))
    .sort((a, b) => Number(a.match(/[0-9]+/u)[0]) - Number(b.match(/[0-9]+/u)[0]));
  if (!imports.length) throw new Error("No actual verification import exists.");
  const databaseDirectory = await persistedDatabaseDirectory(statePath);
  for (const name of await readdir(databaseDirectory, { recursive: true })) {
    if (!name.endsWith(".sqlite")) continue;
    const path = join(databaseDirectory, name);
    const database = new DatabaseSync(path, { readOnly: true });
    const catalogue = catalogueStateTableExists(database).get();
    database.close();
    if (!catalogue) continue;
    await rm(`${path}-wal`, { force: true });
    await rm(`${path}-shm`, { force: true });
    await copyFile(join(directory, imports.at(-1)), path);
    return statePath;
  }
  throw new Error("API binding database was not found in disposable test persistence.");
}
