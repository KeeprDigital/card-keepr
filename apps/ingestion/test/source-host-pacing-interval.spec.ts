import { catalogueStore } from "../../../src/catalogue/shared";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  advanceHostPacing,
  hostPacingDelay,
  sourceHostPacingIntervalMilliseconds,
} from "../../../src/catalogue/source-evidence";
import { installRuntimeSuite } from "./runtime-helpers";

installRuntimeSuite();

test("source host pacing interval defaults to 500ms and accepts overrides", () => {
  expect(sourceHostPacingIntervalMilliseconds(undefined)).toBe(500);
  expect(sourceHostPacingIntervalMilliseconds("500")).toBe(500);
  expect(sourceHostPacingIntervalMilliseconds("0")).toBe(0);
  expect(sourceHostPacingIntervalMilliseconds("1000")).toBe(1000);
  expect(sourceHostPacingIntervalMilliseconds("60000")).toBe(60000);
});

test("source host pacing interval fails closed on unrecognized values", () => {
  for (const value of ["fast", "", "-1", "1.5", "500ms", "60001", "0x20"]) {
    expect(() => sourceHostPacingIntervalMilliseconds(value)).toThrow(/SOURCE_HOST_PACING_INTERVAL_MS/);
  }
});

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
