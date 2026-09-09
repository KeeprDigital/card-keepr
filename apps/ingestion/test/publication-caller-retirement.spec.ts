import { expect, test } from "vitest";
import { approveNativeCandidate, prepareNativeCandidate } from "./native-publication-helpers";
import { collect, get, installReconciliationSuite, post } from "./reconciliation-helpers";

installReconciliationSuite();

test("a collected source publishes through exact native owner operations after run approval is retired", async () => {
  const collection = await collect("/reconciliation/base", "retired-callers-native-source");
  const rejected = await post(`/v1/ingestion-runs/${collection.id}/approval`, {
    candidate_digest: "a".repeat(64),
    expected_current_revision_id: "catrev_spine_000",
    idempotency_key: "retired-callers-old-intent",
  });
  expect(rejected.response.status).toBe(410);
  expect(rejected.document.code).toBe("run_approval_retired");
  const candidate = await prepareNativeCandidate(
    collection.id,
    "one-piece",
    "catrev_spine_000",
    "retired-callers-native-candidate",
  );
  const result = await approveNativeCandidate(candidate, "retired-callers-native-approval");
  expect(result.document).toMatchObject({
    state: "published",
    candidate_id: candidate.id,
    manifest_digest: candidate.manifest_digest,
    expected_game_revision_id: candidate.expected_game_revision_id,
    approval_scope: "whole_candidate",
  });
  const replay = await post("/v1/publications/start", {
    candidate_id: candidate.id,
    manifest_digest: candidate.manifest_digest,
    expected_game_revision_id: candidate.expected_game_revision_id,
    generation: candidate.generation,
    idempotency_key: "retired-callers-native-approval",
  });
  expect(replay.response.status).toBe(202);
  expect(replay.document).toMatchObject({ id: result.document.id, state: "approved", candidate_id: candidate.id });
  expect((await get(`/v1/publications/${result.document.id}`)).document).toEqual(result.document);
  const changed = await post("/v1/publications/start", {
    candidate_id: candidate.id,
    manifest_digest: "0".repeat(64),
    expected_game_revision_id: candidate.expected_game_revision_id,
    generation: candidate.generation,
    idempotency_key: "retired-callers-native-approval",
  });
  expect(changed.response.status).toBe(409);
  expect(changed.document.code).toBe("idempotency_conflict");
});
