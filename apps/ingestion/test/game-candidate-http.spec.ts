import { expect, test } from "vitest";
import worker from "../src/index";
import { collect, installReconciliationSuite, testEnv } from "./reconciliation-helpers";
import { nativePreparationDriver } from "./native-preparation-driver";
import { assertHttpResponse } from "../../../test/support/http-contract";
import { prepareNativeCandidate, seedNativePredecessor } from "./native-publication-helpers";
import { replaceGameHeadForFence } from "./query-helpers/game-candidates";
import { get } from "./reconciliation-helpers";
import contract from "../../../contracts/admin-openapi.json";

installReconciliationSuite();

test("owner preparation receipts replay unchanged across pause, resume and sealed status", async () => {
  const source = await collect("/reconciliation/base", "candidate-http-source");
  const driver = nativePreparationDriver(testEnv);
  let requestSequence = 0;
  const request = async (path: string, body?: Record<string, unknown>, extraHeaders: Record<string, string> = {}) => {
    const response = await worker.fetch(
      new Request(`https://card-keepr.invalid${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          authorization: "Bearer vitest-administration-key",
          "content-type": "application/json",
          "cf-connecting-ip": `203.0.113.${++requestSequence}`,
          ...extraHeaders,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      driver.environment,
    );
    return { response, document: await response.clone().json<Record<string, unknown>>() };
  };
  const intent = {
    ingestion_run_id: source.id,
    supported_game: "one-piece",
    expected_game_revision_id: "catrev_spine_000",
    idempotency_key: "candidate-http-prepare",
  };
  const accepted = await request("/v1/game-candidates", intent);
  expect(accepted.response.status).toBe(202);
  expect(accepted.document).toMatchObject({
    contract: "card-keepr-game-preparation-acceptance@1",
    action: "prepare",
    state: "accepted",
  });
  await assertHttpResponse(contract, "/v1/game-candidates", "post", accepted.response, accepted.document);
  const location = accepted.response.headers.get("location")!;
  expect(accepted.document.links).toEqual({ status: location });
  const path = new URL(location).pathname;
  const unauthorized = await request(path, undefined, { authorization: "" });
  expect(unauthorized.response.status).toBe(401);
  await assertHttpResponse(
    contract,
    "/v1/game-candidates/{candidate}",
    "get",
    unauthorized.response,
    unauthorized.document,
  );
  const initial = await request(path);
  expect(initial.response.status, JSON.stringify(initial.document)).toBe(200);
  expect(initial.document).toMatchObject({ state: "preparing", generation: 0, manifest_digest: null });
  for (const suffix of ["partitions", "inspection/evidence/identity"]) {
    const unsealed = await request(`${path}/${suffix}`);
    expect(unsealed.response.status).toBe(409);
    expect(unsealed.document).toMatchObject({ code: "candidate_not_sealed" });
  }
  for (const body of [
    { generation: "0", idempotency_key: "invalid-generation" },
    { generation: 0, idempotency_key: "unknown-field", unexpected: true },
  ]) {
    const invalid = await request(`${path}/pause`, body);
    expect(invalid.response.status).toBe(422);
    await assertHttpResponse(
      contract,
      "/v1/game-candidates/{candidate}/pause",
      "post",
      invalid.response,
      invalid.document,
    );
  }
  const changedIntent = await request("/v1/game-candidates", {
    ...intent,
    expected_game_revision_id: "changed_revision",
  });
  expect(changedIntent.response.status).toBe(409);
  await assertHttpResponse(contract, "/v1/game-candidates", "post", changedIntent.response, changedIntent.document);
  const pauseIntent = { generation: 0, idempotency_key: "candidate-http-pause" };
  const paused = await request(`${path}/pause`, pauseIntent);
  expect(paused.response.status).toBe(202);
  await assertHttpResponse(contract, "/v1/game-candidates/{candidate}/pause", "post", paused.response, paused.document);
  expect((await request(path)).document).toMatchObject({
    state: "paused",
    generation: 1,
    deadline: initial.document.deadline,
  });
  const stale = await request(`${path}/resume`, { generation: 0, idempotency_key: "candidate-http-stale" });
  expect(stale.response.status).toBe(409);
  await assertHttpResponse(contract, "/v1/game-candidates/{candidate}/resume", "post", stale.response, stale.document);
  const resumed = await request(`${path}/resume`, { generation: 1, idempotency_key: "candidate-http-resume" });
  expect(resumed.response.status).toBe(202);
  await driver.drain();
  const sealed = await request(path);
  expect(sealed.response.status, JSON.stringify(sealed.document)).toBe(200);
  expect(sealed.document).toMatchObject({ state: "sealed", generation: 1, deadline: initial.document.deadline });
  await assertHttpResponse(contract, "/v1/game-candidates/{candidate}", "get", sealed.response, sealed.document);
  expect((await request("/v1/game-candidates", intent)).document).toEqual(accepted.document);
  expect((await request(`${path}/pause`, pauseIntent)).document).toEqual(paused.document);
  const collection = await request(`/v1/ingestion-runs/${source.id}/game-candidates`);
  expect(collection.response.status, JSON.stringify(collection.document)).toBe(200);
  await assertHttpResponse(
    contract,
    "/v1/ingestion-runs/{run}/game-candidates",
    "get",
    collection.response,
    collection.document,
  );
  const progress = await request(`${path}/progress`);
  expect(progress.response.status, JSON.stringify(progress.document)).toBe(200);
  await assertHttpResponse(
    contract,
    "/v1/game-candidates/{candidate}/progress",
    "get",
    progress.response,
    progress.document,
  );
  const inspection = await request(`${path}/inspection?manifest=${sealed.document.manifest_digest}`);
  expect(inspection.response.status, JSON.stringify(inspection.document)).toBe(200);
  expect(inspection.document).toMatchObject({ ready: true, approval_scope: "whole_candidate" });
  await assertHttpResponse(
    contract,
    "/v1/game-candidates/{candidate}/inspection",
    "get",
    inspection.response,
    inspection.document,
  );
  for (const family of ["partitions", "inputs"]) {
    const page = await request(`${path}/${family}`);
    expect(page.response.status, JSON.stringify(page.document)).toBe(200);
    await assertHttpResponse(
      contract,
      `/v1/game-candidates/{candidate}/${family}`,
      "get",
      page.response,
      page.document,
    );
    for (const partition of page.document.partitions as { ordinal: number }[]) {
      const detail = await request(`${path}/${family}/${partition.ordinal}`);
      expect(detail.response.status, JSON.stringify(detail.document)).toBe(200);
      await assertHttpResponse(
        contract,
        `/v1/game-candidates/{candidate}/${family}/{ordinal}`,
        "get",
        detail.response,
        detail.document,
      );
    }
  }
  for (const kind of ["identity", "admission", "correction", "curated"]) {
    const evidence = await request(`${path}/inspection/evidence/${kind}?manifest=${sealed.document.manifest_digest}`);
    expect(evidence.response.status, JSON.stringify(evidence.document)).toBe(200);
    if (evidence.document.next_cursor) {
      const next = await request(
        `${path}/inspection/evidence/${kind}?after=${encodeURIComponent(String(evidence.document.next_cursor))}`,
      );
      expect(next.response.status).toBe(200);
      expect(next.document).toMatchObject({
        candidate_id: sealed.document.id,
        manifest_digest: sealed.document.manifest_digest,
        expected_game_revision_id: sealed.document.expected_game_revision_id,
      });
      await assertHttpResponse(
        contract,
        "/v1/game-candidates/{candidate}/inspection/evidence/{kind}",
        "get",
        next.response,
        next.document,
      );
    }
    await assertHttpResponse(
      contract,
      "/v1/game-candidates/{candidate}/inspection/evidence/{kind}",
      "get",
      evidence.response,
      evidence.document,
    );
  }
  const invalidOrdinal = await request(`${path}/partitions/01`);
  expect(invalidOrdinal.response.status).toBe(400);
  await assertHttpResponse(
    contract,
    "/v1/game-candidates/{candidate}/partitions/{ordinal}",
    "get",
    invalidOrdinal.response,
    invalidOrdinal.document,
  );
  const mixed = await request(`${path}/partitions?after=${"0".repeat(64)}:0`);
  expect(mixed.response.status).toBe(409);
  await assertHttpResponse(
    contract,
    "/v1/game-candidates/{candidate}/partitions",
    "get",
    mixed.response,
    mixed.document,
  );
  const abandonIntent = { generation: 1, idempotency_key: "candidate-http-abandon" };
  const abandoned = await request(`${path}/abandon`, abandonIntent);
  expect(abandoned.response.status).toBe(202);
  await assertHttpResponse(
    contract,
    "/v1/game-candidates/{candidate}/abandon",
    "post",
    abandoned.response,
    abandoned.document,
  );
  expect((await request(path)).document).toMatchObject({
    state: "abandoned",
    generation: 2,
    deadline: sealed.document.deadline,
    manifest_digest: sealed.document.manifest_digest,
  });
  expect((await request(`${path}/abandon`, abandonIntent)).document).toEqual(abandoned.document);
  expect((await request("/v1/game-candidates", intent)).document).toEqual(accepted.document);
});

test("sealed candidate pages retain their predecessor and evidence cursor when the game head changes", async () => {
  const source = await collect("/reconciliation/base", "candidate-http-pinned-source");
  const seed = await prepareNativeCandidate(source.id, "one-piece", "catrev_spine_000", "candidate-http-pinned-seed");
  // Preparation-only predecessor fixture: backup remains explicitly pending.
  const predecessor = await seedNativePredecessor(seed, "candidate-http-pinned-predecessor");
  const candidate = await prepareNativeCandidate(
    source.id,
    "one-piece",
    predecessor.revisionId,
    "candidate-http-pinned-next",
  );
  const path = `/v1/game-candidates/${candidate.id}`;
  const page = await get(`${path}/partitions?manifest=${candidate.manifest_digest}`);
  expect(page.response.status).toBe(200);
  const first = (page.document.partitions as { ordinal: number }[])[0]!;
  const detailPath = `${path}/partitions/${first.ordinal}?manifest=${candidate.manifest_digest}`;
  const detail = await get(detailPath);
  const evidence = await get(`${path}/inspection/evidence/identity?manifest=${candidate.manifest_digest}`);
  expect(evidence.response.status).toBe(200);
  expect(evidence.document.next_cursor).toBeTypeOf("string");
  const nextPath = `${path}/inspection/evidence/identity?after=${encodeURIComponent(String(evidence.document.next_cursor))}`;
  const next = await get(nextPath);
  expect(next.response.status).toBe(200);
  await replaceGameHeadForFence(testEnv.CATALOGUE_DB).bind("catrev_spine_000", "one-piece").run();
  const retained = await get(detailPath);
  expect(retained.response.status).toBe(200);
  expect(retained.document).toEqual(detail.document);
  await assertHttpResponse(
    contract,
    "/v1/game-candidates/{candidate}/partitions/{ordinal}",
    "get",
    retained.response,
    retained.document,
  );
  const retainedNext = await get(nextPath);
  expect(retainedNext.response.status).toBe(200);
  expect(retainedNext.document).toEqual(next.document);
  await assertHttpResponse(
    contract,
    "/v1/game-candidates/{candidate}/inspection/evidence/{kind}",
    "get",
    retainedNext.response,
    retainedNext.document,
  );
  const inspection = await get(`${path}/inspection?manifest=${candidate.manifest_digest}`);
  expect(inspection.response.status).toBe(200);
  expect(inspection.document).toMatchObject({
    ready: false,
    reason: "game_predecessor_changed",
    expected_game_revision_id: candidate.expected_game_revision_id,
  });
  await assertHttpResponse(
    contract,
    "/v1/game-candidates/{candidate}/inspection",
    "get",
    inspection.response,
    inspection.document,
  );
});
