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

test.each(["1e400", "-1e400"])("raw numeric overflow %s cannot become acknowledged null intent", async (overflow) => {
  const intake = {
    game: "one-piece",
    source_lineage: "owner",
    reference: "synthetic-overflow-intake",
    content: { nested: [null] },
    evidence: { attestation: "Synthetic owner intake" },
    idempotency_key: "overflow-intake",
  };
  const rawPost = (path: string, body: string) =>
    exports.default.fetch(
      new Request(`https://card-keepr.invalid${path}`, {
        method: "POST",
        headers: {
          authorization: "Bearer vitest-administration-key",
          "content-type": "application/json",
          "cf-connecting-ip": "192.0.2.42",
        },
        body,
      }),
    );
  const invalid = await rawPost("/v1/entity-proposals", JSON.stringify(intake).replace("[null]", `[${overflow}]`));
  expect(invalid.status, await invalid.clone().text()).toBe(422);
  await assertHttpResponse(contract, "/v1/entity-proposals", "post", invalid);
  const empty = await administrationRequest("/v1/entity-proposals?game=one-piece", "GET");
  expect(await empty.json()).toMatchObject({ proposals: [] });
  const created = await administrationRequest("/v1/entity-proposals", "POST", intake);
  expect(created.status).toBe(201);
  const document = (await created.json()) as { id: string };
  const path = `/v1/entity-proposals/${document.id}/decisions`;
  for (const [generation, [action, field]] of [
    ["reconsider", "content"],
    ["reconsider", "evidence"],
    ["reconsider", "exception"],
    ["reject", "exception"],
  ].entries()) {
    const decision = {
      action,
      expected_generation: String(generation),
      rationale: "Synthetic overflow boundary inspection",
      idempotency_key: `overflow-decision-${generation}`,
      [field!]: { nested: [null] },
    };
    const rejected = await rawPost(path, JSON.stringify(decision).replace("[null]", `[${overflow}]`));
    expect(rejected.status, await rejected.clone().text()).toBe(422);
    await assertHttpResponse(contract, "/v1/entity-proposals/{proposal}/decisions", "post", rejected);
    const before = await administrationRequest(`/v1/entity-proposals/${document.id}`, "GET");
    expect(await before.json()).toMatchObject({ generation });
    // The rejected request retained no intent; null can be acknowledged under this key.
    const accepted = await administrationRequest(path, "POST", decision);
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    expect(await accepted.json()).toMatchObject({ generation: generation + 1 });
    const replay = await administrationRequest(path, "POST", decision);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ generation: generation + 1 });
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
