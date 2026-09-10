import { catalogueStore } from "../../../src/catalogue/shared";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { advanceHostPacing, hostPacingDelay } from "../../../src/catalogue/source-evidence";
import { installRuntimeSuite } from "./runtime-helpers";

installRuntimeSuite();

test("advancing host pacing schedules the next request one interval ahead", async () => {
  const before = Date.now();
  await advanceHostPacing(catalogueStore(env.CATALOGUE_DB), "pacing-interval.invalid", "production", 250);
  const delay = await hostPacingDelay(catalogueStore(env.CATALOGUE_DB), "pacing-interval.invalid");
  const elapsed = Date.now() - before;
  // Deadline lands in [interval, interval + 25% jitter] of the advance time.
  expect(delay + elapsed).toBeGreaterThanOrEqual(250);
  expect(delay).toBeLessThanOrEqual(Math.ceil(250 * 1.25));
});

test("advancing host pacing defaults to the 500ms interval", async () => {
  const before = Date.now();
  await advanceHostPacing(catalogueStore(env.CATALOGUE_DB), "pacing-default.invalid", "production");
  const delay = await hostPacingDelay(catalogueStore(env.CATALOGUE_DB), "pacing-default.invalid");
  const elapsed = Date.now() - before;
  expect(delay + elapsed).toBeGreaterThanOrEqual(500);
  expect(delay).toBeLessThanOrEqual(Math.ceil(500 * 1.25));
});
