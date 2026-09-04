import { expect, test } from "vitest";
import {
  printingImageRetriesExhaustedFailureCode,
  requestFailureCode,
  terminalHttpFailureClass,
  toleratedPrintingImageFailureCodes,
  toleratesRequestFailure,
  transportPolicyForRole,
} from "../../src/catalogue/source-evidence-model";

const catalogueFactRoles = ["surface", "listing", "detail", "product_detail"] as const;

test("catalogue-fact roles keep the 30 s bound, pause the run on exhausted transport retries, and fail the run on terminal outcomes", () => {
  for (const role of catalogueFactRoles) {
    expect(transportPolicyForRole(role)).toEqual({
      timeout_ms: 30_000,
      on_transport_exhaustion: "pause_run",
      on_terminal_outcome: "fail_run",
    });
  }
});

test("image requests get a longer bound and fail the request alone on exhaustion and on terminal outcomes", () => {
  expect(transportPolicyForRole("image")).toEqual({
    timeout_ms: 60_000,
    on_transport_exhaustion: "fail_request",
    on_terminal_outcome: "fail_request",
  });
});

test("catalogue-fact roles keep their run-fatal failure codes for every class", () => {
  for (const role of catalogueFactRoles) {
    expect({
      retries_exhausted: requestFailureCode(role, "retries_exhausted"),
      not_found: requestFailureCode(role, "not_found"),
      rejected: requestFailureCode(role, "rejected"),
      redirected: requestFailureCode(role, "redirected"),
      revalidation_rejected: requestFailureCode(role, "revalidation_rejected"),
      body_contract: requestFailureCode(role, "body_contract"),
    }).toEqual({
      retries_exhausted: "source_request_retries_exhausted",
      not_found: "source_request_rejected",
      rejected: "source_request_rejected",
      redirected: "source_redirect_rejected",
      revalidation_rejected: "source_revalidation_rejected",
      body_contract: "source_request_retries_exhausted",
    });
  }
});

test("image requests record one distinct stable code per failure class", () => {
  expect({
    retries_exhausted: requestFailureCode("image", "retries_exhausted"),
    not_found: requestFailureCode("image", "not_found"),
    rejected: requestFailureCode("image", "rejected"),
    redirected: requestFailureCode("image", "redirected"),
    revalidation_rejected: requestFailureCode("image", "revalidation_rejected"),
    body_contract: requestFailureCode("image", "body_contract"),
  }).toEqual({
    retries_exhausted: "source_image_retries_exhausted",
    not_found: "source_image_not_found",
    rejected: "source_image_rejected",
    redirected: "source_image_redirected",
    revalidation_rejected: "source_image_revalidation_rejected",
    body_contract: "source_image_body_contract",
  });
  expect(printingImageRetriesExhaustedFailureCode).toBe(
    "source_image_retries_exhausted",
  );
  expect([...toleratedPrintingImageFailureCodes].sort()).toEqual([
    "source_image_body_contract",
    "source_image_not_found",
    "source_image_redirected",
    "source_image_rejected",
    "source_image_retries_exhausted",
    "source_image_revalidation_rejected",
  ]);
});

test("a missing file is distinguished from other non-retryable statuses; 429 and 5xx stay retryable", () => {
  expect(terminalHttpFailureClass(404)).toBe("not_found");
  expect(terminalHttpFailureClass(410)).toBe("not_found");
  expect(terminalHttpFailureClass(400)).toBe("rejected");
  expect(terminalHttpFailureClass(403)).toBe("rejected");
  expect(terminalHttpFailureClass(429)).toBeNull();
  expect(terminalHttpFailureClass(500)).toBeNull();
  expect(terminalHttpFailureClass(503)).toBeNull();
});

test("every image failure code is tolerated on the image role and nowhere else", () => {
  for (const code of toleratedPrintingImageFailureCodes) {
    expect(toleratesRequestFailure("image", code)).toBe(true);
    for (const role of catalogueFactRoles) {
      expect(toleratesRequestFailure(role, code)).toBe(false);
    }
  }
  expect(toleratesRequestFailure("image", "source_request_retries_exhausted"))
    .toBe(false);
  expect(toleratesRequestFailure("image", "source_request_rejected")).toBe(
    false,
  );
  expect(toleratesRequestFailure("image", "source_redirect_rejected")).toBe(
    false,
  );
  expect(toleratesRequestFailure("image", null)).toBe(false);
});
