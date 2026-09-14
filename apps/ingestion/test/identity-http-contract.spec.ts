import { exports } from "cloudflare:workers";
import { expect, test } from "vitest";
import contract from "../../../contracts/admin-openapi.json";
import { assertHttpResponse } from "../../../test/support/http-contract";
import { administrationRequest, installRuntimeSuite } from "./runtime-helpers";

installRuntimeSuite();

const operations = [
  ["get", "/v1/entity-proposals"],
  ["post", "/v1/entity-proposals"],
  ["get", "/v1/entity-proposals/{proposal}"],
  ["get", "/v1/entity-proposals/{proposal}/evidence"],
  ["post", "/v1/entity-proposals/{proposal}/decisions"],
  ["get", "/v1/identity-corrections"],
  ["post", "/v1/identity-corrections"],
  ["get", "/v1/identity-corrections/{correction}"],
  ["post", "/v1/identity-corrections/validate"],
  ["get", "/v1/reconciliation/identities/{identity}"],
  ["get", "/v1/reconciliation/identity-reviews"],
  ["post", "/v1/reconciliation/identity-reviews/{review}/resolve"],
  ["get", "/v1/reconciliation/printings/{printing}"],
] as const;

test("every identity operation requires owner authentication before inspecting evidence or command input", async () => {
  for (const [method, path] of operations) {
    const response = await exports.default.fetch(
      new Request(`https://card-keepr.invalid${path.replaceAll(/\{\w+\}/g, "unknown")}`, {
        method: method.toUpperCase(),
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await assertHttpResponse(contract, path, method, response);
  }
});

test("identity commands enforce JSON media, actual byte bounds and typed inputs before domain work", async () => {
  for (const [method, path] of operations.filter(([method]) => method === "post")) {
    const url = `https://card-keepr.invalid${path.replaceAll(/\{\w+\}/g, "unknown")}`;
    for (const [media, body, status] of [
      ["text/plain", "{}", 415],
      ["application/json", "{", 400],
      ["application/json", JSON.stringify({ padding: "é".repeat(8200) }), 413],
      ["application/json", "{}", 422],
    ] as const) {
      const response = await exports.default.fetch(
        new Request(url, {
          method: "POST",
          headers: {
            authorization: "Bearer vitest-administration-key",
            "content-type": media,
            "cf-connecting-ip": "192.0.2.42",
          },
          body,
        }),
      );
      expect(response.status, `${path}: ${await response.clone().text()}`).toBe(status);
      await assertHttpResponse(contract, path, method, response);
    }
  }
});

test("identity lists reject invalid selectors and cursors while missing retained identities remain not found", async () => {
  for (const [path, query] of [
    ["/v1/entity-proposals", "?game=unknown"],
    ["/v1/entity-proposals/{proposal}", "?after_generation=01"],
    ["/v1/identity-corrections", "?game=one-piece&after=-1"],
    ["/v1/reconciliation/identity-reviews", ""],
    ["/v1/reconciliation/identities/{identity}", "?unexpected=true"],
  ]) {
    const response = await administrationRequest(`${path!.replaceAll(/\{\w+\}/g, "unknown")}${query}`, "GET");
    expect(response.status).toBe(400);
    await assertHttpResponse(contract, path!, "get", response);
  }
  for (const path of [
    "/v1/entity-proposals/{proposal}",
    "/v1/entity-proposals/{proposal}/evidence",
    "/v1/identity-corrections/{correction}",
    "/v1/reconciliation/identities/{identity}",
    "/v1/reconciliation/printings/{printing}",
  ]) {
    const response = await administrationRequest(path.replaceAll(/\{\w+\}/g, "unknown"), "GET");
    expect(response.status).toBe(404);
    await assertHttpResponse(contract, path, "get", response);
  }
});
