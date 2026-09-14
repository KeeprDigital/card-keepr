import assert from "node:assert/strict";
import test from "node:test";

test("migration rehearsal rejects an unpinned checkout before opening a rehearsal database", async () => {
  const { rehearseStagingMigrations } = await import("../scripts/staging-migrations.mjs");
  await assert.rejects(
    rehearseStagingMigrations({ expectedHeadSha: "0".repeat(40), productionStartingLevel: 31 }),
    /staging_rehearsal_checkout_mismatch/u,
  );
});
