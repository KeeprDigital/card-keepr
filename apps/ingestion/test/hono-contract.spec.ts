import { prepareNativeCandidate } from "./native-publication-helpers";
import { expect, test } from "vitest";
import worker from "../src/index";
import { collect, get, post, installReconciliationSuite, testEnv } from "./reconciliation-helpers";
import { assertHttpResponse } from "../../../test/support/http-contract";
import contract from "../../../contracts/admin-openapi.json";

installReconciliationSuite();

test("all publication commands enforce bounded JSON, owner authentication and canonical wire inputs", async () => {
  for (const [client, template] of [
    "/v1/publications",
    "/v1/publications/start",
    "/v1/publications/{publication}/resume",
    "/v1/publications/{publication}/advance",
    "/v1/publications/{publication}/export-preparation/advance",
    "/v1/publication-compositions",
    "/v1/game-candidates/{candidate}/publication-preparation",
    "/v1/game-candidates/{candidate}/publication-preparation/start",
    "/v1/game-candidates/{candidate}/publication-preparation/resume",
  ].entries()) {
    const path = template.replace(/\{[^}]+\}/g, "missing");
    for (const [body, media, status] of [
      ["{", "application/json", 400],
      ["{}", "text/plain", 415],
      [JSON.stringify({ generation: "0" }), "application/json", 422],
      [JSON.stringify({ padding: "x".repeat(16384) }), "application/json", 413],
    ] as const) {
      const response = await worker.fetch(
        new Request(`https://card-keepr.invalid${path}`, {
          method: "POST",
          headers: {
            authorization: "Bearer vitest-administration-key",
            "content-type": media,
            "cf-connecting-ip": `198.51.100.${client + 1}`,
          },
          body,
        }),
        testEnv,
      );
      expect(response.status, `${path}: ${status}`).toBe(status);
      await assertHttpResponse(contract, template, "post", response);
    }
    const unauthorized = await worker.fetch(
      new Request(`https://card-keepr.invalid${path}`, {
        method: "POST",
        headers: {
          authorization: "Bearer vitest-api-key",
          "content-type": "application/json",
          "cf-connecting-ip": `198.51.100.${client + 1}`,
        },
        body: "{}",
      }),
      testEnv,
    );
    expect(unauthorized.status).toBe(401);
    await assertHttpResponse(contract, template, "post", unauthorized);
  }
});

test("prepared inspection validates query cursors and Card-only search before looking up a candidate", async () => {
  for (const [suffix, query] of [
    ["artifacts", "after=1.5"],
    ["query", "kind=printings&q=card"],
    ["query", "kind=cards&unexpected=true"],
  ]) {
    const response = await get(`/v1/game-candidates/missing/publication-preparation/${suffix}?${query}`);
    expect(response.response.status).toBe(400);
    await assertHttpResponse(
      contract,
      `/v1/game-candidates/{candidate}/publication-preparation/${suffix}`,
      "get",
      response.response,
      response.document,
    );
  }
});

test("publication preparation commands reject noncanonical intent through the generated boundary", async () => {
  const path = "/v1/game-candidates/missing/publication-preparation";
  const invalid = await post(path, {
    manifest_digest: "a".repeat(64),
    generation: "0",
    sequence: 0,
    idempotency_key: "typed-preparation",
  });
  expect(invalid.response.status).toBe(422);
  expect(invalid.document.code).toBe("invalid_parameter");
  await assertHttpResponse(
    contract,
    "/v1/game-candidates/{candidate}/publication-preparation",
    "post",
    invalid.response,
    invalid.document,
  );
});

test("approval without dispatch keeps artifacts private and exposes bounded publication waiting status", async () => {
  const source = await collect("/reconciliation/base", "hono-operation-source");
  const candidate = await prepareNativeCandidate(
    String(source.id),
    "one-piece",
    "catrev_spine_000",
    "hono-operation-candidate",
  );
  const intent = {
    candidate_id: candidate.id,
    manifest_digest: candidate.manifest_digest,
    expected_game_revision_id: candidate.expected_game_revision_id,
    generation: candidate.generation,
    idempotency_key: "hono-approval-only",
  };
  const approved = await post("/v1/publications", intent);
  expect(approved.response.status).toBe(202);
  await assertHttpResponse(contract, "/v1/publications", "post", approved.response, approved.document);
  const path = `/v1/publications/${approved.document.id}`;
  expect((await get(path)).document).toEqual(approved.document);
  const exports = await post(`${path}/export-preparation/advance`, {
    generation: 0,
    idempotency_key: "hono-waiting-export",
  });
  expect(exports.document).toEqual({ state: "waiting_private", sequence: 0 });
  await assertHttpResponse(
    contract,
    "/v1/publications/{publication}/export-preparation/advance",
    "post",
    exports.response,
    exports.document,
  );
  const advanced = await post(`${path}/advance`, { generation: 0 });
  expect(advanced.document).toMatchObject({ state: "waiting_artifacts", deadline: candidate.deadline });
  await assertHttpResponse(
    contract,
    "/v1/publications/{publication}/advance",
    "post",
    advanced.response,
    advanced.document,
  );
  const replay = await post("/v1/publications", intent);
  expect(replay.document).toEqual(approved.document);
  const resume = await post(`${path}/resume`, { generation: 9, idempotency_key: "hono-stale-resume" });
  expect(resume.response.status).toBe(409);
  await assertHttpResponse(contract, "/v1/publications/{publication}/resume", "post", resume.response, resume.document);
});

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
