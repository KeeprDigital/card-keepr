import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

/** Independent staging data can already be upgraded; this database always starts at the recorded production level. */
export async function rehearseStagingMigrations({ expectedHeadSha, productionStartingLevel }) {
  const actualHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (actualHead !== expectedHeadSha) throw new Error("staging_rehearsal_checkout_mismatch");
  const names = (await readdir("migrations")).filter((name) => /^\d+_.*\.sql$/u.test(name)).sort();
  const target = Number.parseInt(names.at(-1), 10);
  if (!Number.isSafeInteger(productionStartingLevel) || productionStartingLevel < 1 || productionStartingLevel > target)
    throw new Error("production_starting_schema_not_rehearsable");
  const database = new DatabaseSync(":memory:");
  const migrations = [];
  let startingObserved = false;
  try {
    database.exec("PRAGMA foreign_keys=ON");
    for (const name of names) {
      const level = Number.parseInt(name, 10);
      const sql = await readFile(`migrations/${name}`, "utf8");
      if (level > productionStartingLevel && !startingObserved) throw new Error("production_starting_schema_missing");
      database.exec("BEGIN");
      try {
        database.exec(sql);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      const observed = database.prepare("SELECT migration_level FROM catalogue_schema_state WHERE singleton=1").get();
      if (observed?.migration_level !== level) throw new Error("migration_did_not_advance_exactly_once");
      if (level === productionStartingLevel) startingObserved = true;
      migrations.push({
        name,
        level,
        phase: level <= productionStartingLevel ? "starting-state" : "forward-migration",
        sha256: createHash("sha256").update(sql).digest("hex"),
      });
      if (level > productionStartingLevel) {
        // A forward migration must refuse its now-stale predecessor; roll back even an unexpected success.
        database.exec("BEGIN");
        let refused = false;
        try {
          database.exec(sql);
        } catch {
          refused = true;
        } finally {
          database.exec("ROLLBACK");
        }
        if (!refused) throw new Error("migration_predecessor_guard_missing");
      }
    }
    if (
      !startingObserved ||
      database.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" ||
      database.prepare("PRAGMA foreign_key_check").all().length
    )
      throw new Error("migration_rehearsal_integrity_failed");
    return {
      contract: "card-keepr-staging-migration-rehearsal@1",
      expected_head_sha: actualHead,
      state: "succeeded",
      starting_level: productionStartingLevel,
      ending_level: target,
      data_scope: "isolated_synthetic_baseline",
      migrations,
    };
  } finally {
    database.close();
  }
}
