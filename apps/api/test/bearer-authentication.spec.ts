import { exports } from "cloudflare:workers";
import { expect, test } from "vitest";
import { installApiSuite } from "./api-fixtures";

installApiSuite();

// ADR 0005: each worker accepts a primary and a replacement bearer key so a
// rotation never has a gap. Nothing else decides whether a bearer is valid.
async function healthWith(
  headers: Record<string, string>,
): Promise<{ status: number; document: Record<string, unknown> }> {
  const response = await exports.default.fetch(
    new Request("https://card-keepr.invalid/health", {
      headers: { "cf-connecting-ip": "192.0.2.201", ...headers },
    }),
  );
  return {
    status: response.status,
    document: await response.json<Record<string, unknown>>(),
  };
}

test("the primary and replacement API bearer keys both authenticate", async () => {
  const primary = await healthWith({ authorization: "Bearer vitest-api-key" });
  expect(primary.status).toBe(200);
  const replacement = await healthWith({
    authorization: "Bearer vitest-api-key-replacement-slot",
  });
  expect(replacement.status).toBe(200);
  expect(replacement.document).toMatchObject({ runtime: "api", status: "ok" });
});

test("a missing or unknown bearer is refused with a typed problem", async () => {
  const missing = await healthWith({});
  expect(missing.status).toBe(401);
  expect(missing.document).toMatchObject({ code: "authentication_required" });
  for (const bearer of ["Bearer vitest-api-key-retired", "Basic dXNlcjpwYXNz", "Bearer "]) {
    const refused = await healthWith({ authorization: bearer });
    expect(refused.status).toBe(401);
    expect(refused.document).toMatchObject({ code: "invalid_api_key" });
  }
});
