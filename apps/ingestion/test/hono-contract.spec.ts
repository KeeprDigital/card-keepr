import { prepareNativeCandidate } from "./native-publication-helpers";
import { expect, test } from "vitest";
import worker from "../src/index";
import { collect, get, post, installReconciliationSuite, testEnv } from "./reconciliation-helpers";
import { assertHttpResponse } from "../../../test/support/http-contract";
import contract from "../../../contracts/admin-openapi.json";

installReconciliationSuite();

test("publication start replays its original acceptance while status advances independently", async () => {
  const source = await collect("/reconciliation/base", "hono-source");
  const sealed = await prepareNativeCandidate(String(source.id), "one-piece", "catrev_spine_000", "hono-candidate");
  const intent = {
    candidate_id: sealed.id,
    manifest_digest: sealed.manifest_digest,
    expected_game_revision_id: sealed.expected_game_revision_id,
    generation: sealed.generation,
    idempotency_key: "hono-publication",
  };
  const accepted = await post("/v1/publications/start", intent);
  expect(accepted.response.status).toBe(202);
  expect(accepted.document).toMatchObject({
    contract: "card-keepr-publication-acceptance@1",
    state: "approved",
    approval_scope: "whole_candidate",
  });
  await assertHttpResponse(contract, "/v1/publications/start", "post", accepted.response, accepted.document);
  const location = accepted.response.headers.get("location")!;
  expect(accepted.document.links).toEqual({ status: location });
  const current = await get(new URL(location).pathname);
  expect(current.document.state).not.toBe("approved");
  await assertHttpResponse(contract, "/v1/publications/{publication}", "get", current.response, current.document);
  const replay = await post("/v1/publications/start", intent);
  expect(replay.document).toEqual(accepted.document);
  const conflict = await post("/v1/publications/start", { ...intent, manifest_digest: "f".repeat(64) });
  expect(conflict.response.status).toBe(409);
  await assertHttpResponse(contract, "/v1/publications/start", "post", conflict.response, conflict.document);
});

test("publication wire validation rejects malformed, oversized and noncanonical bodies before domain work", async () => {
  for (const [body, type, status] of [
    ["{", "application/json", 400],
    ["{}", "text/plain", 415],
    [JSON.stringify({ padding: "x".repeat(16_384) }), "application/json", 413],
    [
      JSON.stringify({
        candidate_id: "missing",
        manifest_digest: "a".repeat(64),
        expected_game_revision_id: "catrev_spine_000",
        generation: "0",
        idempotency_key: "invalid",
      }),
      "application/json",
      422,
    ],
  ] as const) {
    const response = await worker.fetch(
      new Request("https://card-keepr.invalid/v1/publications/start", {
        method: "POST",
        headers: { authorization: "Bearer vitest-administration-key", "content-type": type },
        body,
      }),
      testEnv,
    );
    expect(response.status).toBe(status);
    await assertHttpResponse(contract, "/v1/publications/start", "post", response);
  }
});

test("publication wire errors preserve an empty unrecognized JSON property name", async () => {
  const invalid = await post("/v1/publications/start", {
    candidate_id: "missing",
    manifest_digest: "a".repeat(64),
    expected_game_revision_id: "catrev_spine_000",
    generation: 0,
    idempotency_key: "empty-property",
    "": 1,
  });
  expect(invalid.response.status).toBe(422);
  expect(invalid.document).toMatchObject({ invalid_params: [{ name: "" }] });
  await assertHttpResponse(contract, "/v1/publications/start", "post", invalid.response, invalid.document);
});

test("literal publication start cannot be invoked by a status read or unsupported verb", async () => {
  for (const method of ["GET", "HEAD", "PUT", "DELETE"]) {
    const response = await worker.fetch(
      new Request("https://card-keepr.invalid/v1/publications/start", {
        method,
        headers: { authorization: "Bearer vitest-administration-key" },
      }),
      testEnv,
    );
    expect(response.status).toBe(404);
  }
  const isolated = await worker.fetch(
    new Request("https://card-keepr.invalid/v1/publications/start", {
      method: "POST",
      headers: { authorization: "Bearer vitest-api-key" },
    }),
    testEnv,
  );
  expect(isolated.status).toBe(401);
  await assertHttpResponse(contract, "/v1/publications/start", "post", isolated);
});
