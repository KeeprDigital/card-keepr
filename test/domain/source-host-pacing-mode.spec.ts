import { expect, test } from "vitest";
import { sourceHostPacingMode, sourceHostPacingIntervalMilliseconds } from "../../src/catalogue/source-evidence";

test("source host pacing mode defaults to production and accepts both modes", () => {
  expect(sourceHostPacingMode(undefined)).toBe("production");
  expect(sourceHostPacingMode("production")).toBe("production");
  expect(sourceHostPacingMode("immediate")).toBe("immediate");
});

test("source host pacing mode fails closed on unrecognized values", () => {
  expect(() => sourceHostPacingMode("fast")).toThrow(/SOURCE_HOST_PACING_MODE/);
  expect(() => sourceHostPacingMode("")).toThrow(/SOURCE_HOST_PACING_MODE/);
  expect(() => sourceHostPacingMode("IMMEDIATE")).toThrow(/SOURCE_HOST_PACING_MODE/);
});

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
