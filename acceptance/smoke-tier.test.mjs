import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import { officialSourceAuthorities } from "../src/catalogue/adapters/official-source-authority.ts";
import { isWranglerSmokeFile, smokeFlows } from "./helpers/smoke-tier.mjs";

test("publisher journeys cover the Bandai registry with one real Wrangler CLI smoke", async () => {
  assert.deepEqual(
    smokeFlows.flatMap(({ lineages }) => lineages).sort(),
    Object.keys(officialSourceAuthorities).sort(),
  );
  assert.equal(smokeFlows.filter(({ cli }) => cli).length, 1);
  assert.equal(new Set(smokeFlows.map(({ file }) => file)).size, smokeFlows.length);
  for (const { file, cli } of smokeFlows) {
    await access(new URL(file, import.meta.url));
    assert.equal(isWranglerSmokeFile(`/repo/acceptance/${file}`), Boolean(cli));
  }
  assert.equal(isWranglerSmokeFile("/repo/acceptance/runtime-health.test.mjs"), false);
});
