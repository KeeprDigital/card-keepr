import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import test from "node:test";

test("migration rehearsal rejects an unpinned checkout before opening a rehearsal database", async () => {
  const { rehearseStagingMigrations } = await import("../scripts/staging-migrations.mjs");
  await assert.rejects(
    rehearseStagingMigrations({ expectedHeadSha: "0".repeat(40), productionStartingLevel: 31 }),
    /staging_rehearsal_checkout_mismatch/u,
  );
});

// A first live installation starts far below the predecessor level: every
// checked-in forward file must apply in order from the schema baseline and
// refuse its stale predecessor, not only the newest one.
test("migration rehearsal traverses every checked-in forward migration from the schema baseline", async () => {
  const { rehearseStagingMigrations } = await import("../scripts/staging-migrations.mjs");
  const expectedHeadSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const levels = (await readdir("migrations"))
    .filter((name) => /^\d+_.*\.sql$/u.test(name))
    .map((name) => Number.parseInt(name, 10))
    .sort((a, b) => a - b);
  assert.equal(levels[0], 1);
  const result = await rehearseStagingMigrations({ expectedHeadSha, productionStartingLevel: 1 });
  assert.equal(result.state, "succeeded");
  assert.equal(result.starting_level, 1);
  assert.equal(result.ending_level, levels.at(-1));
  assert.deepEqual(
    result.migrations.map((migration) => migration.level),
    levels,
    "every checked-in file participates exactly once, in level order",
  );
  assert.deepEqual(
    result.migrations.filter((migration) => migration.phase === "forward-migration").map((m) => m.level),
    levels.slice(1),
    "every file beyond the baseline is rehearsed as a guarded forward migration",
  );
});
