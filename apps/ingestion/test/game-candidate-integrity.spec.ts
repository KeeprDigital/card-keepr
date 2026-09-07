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
  const beforeMutation = await get(`/v1/game-candidates/${candidateId}`);
  await expect(replaceGameCandidateProvenance(testEnv.CATALOGUE_DB).bind(second.id, candidateId).run()).rejects.toThrow(
    "game_candidate_identity_immutable",
  );
  expect((await get(`/v1/game-candidates/${candidateId}`)).document).toEqual(beforeMutation.document);
});

test("reusing a published collection retains native mapping ownership separately from published mappings", async () => {
  const run = await collect("/reconciliation/base", "native-mapping-published-source");
  const reconciled = await reconcile(run.id);
  const printingId = (reconciled.document.printings as { id: string }[])[0]!.id;
  const published = await post(`/v1/ingestion-runs/${run.id}/approval`, {
    candidate_digest: requiredString(reconciled.document, "candidate_digest"),
    expected_current_revision_id: requiredString(reconciled.document, "expected_current_revision_id"),
    idempotency_key: "native-mapping-publish-source",
  });
  expect(published.response.status).toBe(200);
  const original = (await get(`/v1/reconciliation/identities/${printingId}`)).document;
  const created = await post("/v1/game-candidates", {
    ingestion_run_id: run.id,
    supported_game: "one-piece",
    expected_game_revision_id: published.document.resulting_revision_id,
    idempotency_key: "native-mapping-reuse-source",
  });
  expect(created.response.status).toBe(201);
  const id = requiredString(created.document, "id");
  let candidate = (await get(`/v1/game-candidates/${id}`)).document;
  const deadline = Date.now() + 15000;
  while (candidate.state === "preparing" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    candidate = (await get(`/v1/game-candidates/${id}`)).document;
  }
  expect(candidate, JSON.stringify(candidate)).toMatchObject({ state: "sealed" });
  const audit = await get(`/v1/reconciliation/identities/${printingId}?preparation_id=${id}`);
  expect(audit.response.status).toBe(200);
  expect(audit.document.mappings).toEqual([
    expect.objectContaining({ preparation_id: id, ingestion_run_id: run.id, publication_state: "sealed" }),
  ]);
  expect((await get(`/v1/reconciliation/identities/${printingId}`)).document).toEqual(original);
  expect((await get(`/v1/ingestion-runs/${run.id}`)).document).toMatchObject({ state: "published" });
});
