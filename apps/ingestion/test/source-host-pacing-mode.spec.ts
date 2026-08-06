import { expect, test } from "vitest";
import {
  sourceHostPacingMode,
} from "../../../src/catalogue/source-evidence-capture";

test("source host pacing mode defaults to production and accepts both modes", () => {
  expect(sourceHostPacingMode(undefined)).toBe("production");
  expect(sourceHostPacingMode("production")).toBe("production");
  expect(sourceHostPacingMode("immediate")).toBe("immediate");
});

test("source host pacing mode fails closed on unrecognized values", () => {
  expect(() => sourceHostPacingMode("fast")).toThrow(
    /SOURCE_HOST_PACING_MODE/,
  );
  expect(() => sourceHostPacingMode("")).toThrow(/SOURCE_HOST_PACING_MODE/);
  expect(() => sourceHostPacingMode("IMMEDIATE")).toThrow(
    /SOURCE_HOST_PACING_MODE/,
  );
});
