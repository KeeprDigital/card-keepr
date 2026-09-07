import { expect, test } from "vitest";
import { replaceGameCandidateProvenance } from "./query-helpers/game-candidates";
import {
  collect,
  get,
  installReconciliationSuite,
  post,
  reconcile,
  requiredString,
  testEnv,
} from "./reconciliation-helpers";

installReconciliationSuite();

test("a sealed candidate retains its original collection provenance when another collection exists", async () => {
  const first = await collect("/reconciliation/base", "immutable-candidate-first");
  const result = await reconcile(first.id);
  expect(result.response.status).toBe(200);
  const status = await get(`/v1/ingestion-runs/${first.id}/reconciliation`);
  const candidates = status.document.candidates as { id: string }[];
  const candidateId = candidates[0]!.id;
  const original = await get(`/v1/game-candidates/${candidateId}`);
  expect(original.document.ingestion_run_id).toBe(first.id);
  const published = await post(`/v1/ingestion-runs/${first.id}/approval`, {
    candidate_digest: requiredString(result.document, "candidate_digest"),
    expected_current_revision_id: requiredString(result.document, "expected_current_revision_id"),
    idempotency_key: "immutable-candidate-publish",
  });
  expect(published.response.status).toBe(200);
  const second = await collect("/reconciliation/base", "immutable-candidate-second");
  expect(second.id).not.toBe(first.id);
  await expect(replaceGameCandidateProvenance(testEnv.CATALOGUE_DB).bind(second.id, candidateId).run()).rejects.toThrow(
    "game_candidate_identity_immutable",
  );
  expect((await get(`/v1/game-candidates/${candidateId}`)).document).toEqual(original.document);
});
