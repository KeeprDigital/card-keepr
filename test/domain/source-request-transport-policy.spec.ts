import { expect, test } from "vitest";
import {
  printingImageRetriesExhaustedFailureCode,
  toleratesRequestFailure,
  transportPolicyForRole,
} from "../../src/catalogue/source-evidence-model";

test("catalogue-fact roles keep the 30 s bound and pause the run on exhausted transport retries", () => {
  for (const role of ["surface", "listing", "detail", "product_detail"] as const) {
    expect(transportPolicyForRole(role)).toEqual({
      timeout_ms: 30_000,
      on_transport_exhaustion: "pause_run",
    });
  }
});

test("image requests get a longer bound and fail the request instead of pausing the run", () => {
  expect(transportPolicyForRole("image")).toEqual({
    timeout_ms: 60_000,
    on_transport_exhaustion: "fail_request",
  });
});

test("only an image request that exhausted its transport retries is a tolerated failure", () => {
  expect(
    toleratesRequestFailure("image", printingImageRetriesExhaustedFailureCode),
  ).toBe(true);
  expect(toleratesRequestFailure("image", "source_request_retries_exhausted"))
    .toBe(false);
  expect(toleratesRequestFailure("image", null)).toBe(false);
  expect(
    toleratesRequestFailure("detail", printingImageRetriesExhaustedFailureCode),
  ).toBe(false);
});
