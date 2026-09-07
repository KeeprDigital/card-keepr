import { expect, test } from "vitest";
import { collect, get, post, installReconciliationSuite, requiredString } from "./reconciliation-helpers";

installReconciliationSuite();

// Synthetic retained source evidence; exercises authenticated owner operations.
test("exact whole-candidate approval is durable before acknowledgement and a lost response reuses its operation", async () => {
  const source = await collect("/reconciliation/base", "atomic-source");
  const created = await post("/v1/game-candidates", {
    ingestion_run_id: source.id,
    supported_game: "one-piece",
    expected_game_revision_id: "catrev_spine_000",
    idempotency_key: "atomic-candidate",
  });
  const id = requiredString(created.document, "id");
  let candidate = created.document;
  const deadline = Date.now() + 15000;
  while (candidate.state === "preparing" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    candidate = (await get(`/v1/game-candidates/${id}`)).document;
  }
  expect(candidate.state).toBe("sealed");
  const intent = {
    candidate_id: id,
    manifest_digest: candidate.manifest_digest,
    expected_game_revision_id: "catrev_spine_000",
    generation: candidate.generation,
    idempotency_key: "atomic-approval",
  };
  const approved = await post("/v1/publications", intent);
  expect(approved.response.status, JSON.stringify(approved.document)).toBe(202);
  expect(approved.document).toMatchObject({
    candidate_id: id,
    deadline: candidate.deadline,
    state: "approved",
    approval_scope: "whole_candidate",
  });
  expect(approved.document.id).not.toBe(id);
  expect(approved.document.id).not.toBe(source.id);
  expect((await post("/v1/publications", intent)).document).toEqual(approved.document);
  expect((await get(`/v1/publications/${approved.document.id}`)).document).toEqual(approved.document);
  expect((await post("/v1/publications", { ...intent, manifest_digest: "0".repeat(64) })).response.status).toBe(409);
  const preparationPath = `/v1/game-candidates/${id}/publication-preparation`;
  let preparation = (
    await post(preparationPath, {
      manifest_digest: candidate.manifest_digest,
      generation: 0,
      sequence: 0,
      idempotency_key: "atomic-artifacts",
    })
  ).document;
  for (let unit = 0; preparation.state === "preparing" && unit < 250; unit++) {
    preparation = (
      await post(preparationPath, {
        manifest_digest: candidate.manifest_digest,
        generation: 0,
        sequence: preparation.sequence,
        idempotency_key: `atomic-artifacts-${unit}`,
      })
    ).document;
  }
  expect(preparation.state).toBe("verified");
  const switched = await post(`/v1/publications/${approved.document.id}/advance`, { generation: 0 });
  expect(switched.response.status, JSON.stringify(switched.document)).toBe(200);
  expect(switched.document).toMatchObject({
    state: "published",
    deadline: candidate.deadline,
    backup_attempt_id: expect.any(String),
    resulting_revision_id: expect.any(String),
  });
  expect((await post(`/v1/publications/${approved.document.id}/advance`, { generation: 0 })).document).toEqual(
    switched.document,
  );
  expect((await get(`/v1/game-candidates/${id}`)).document.state).toBe("published");
});
