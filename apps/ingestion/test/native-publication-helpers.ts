import { expect } from "vitest";
import { get, post, requiredString } from "./reconciliation-helpers";

/** A native fixture starts from retained collection, never a legacy aggregate candidate. */
export async function prepareNativeCandidate(
  runId: string,
  game: string,
  expectedGameRevision: string,
  key: string,
  timeoutMs = 15_000,
  extraHeaders: Record<string, string> = {},
) {
  const created = await post(
    "/v1/game-candidates",
    {
      ingestion_run_id: runId,
      supported_game: game,
      expected_game_revision_id: expectedGameRevision,
      idempotency_key: key,
    },
    extraHeaders,
  );
  expect(created.response.status, JSON.stringify(created.document)).toBe(201);
  const id = requiredString(created.document, "id");
  const observed = await observeUntil(`/v1/game-candidates/${id}`, (state) => state !== "preparing", timeoutMs);
  expect(observed.document.state, JSON.stringify(observed.document)).toBe("sealed");
  return observed.document;
}

/** Exercise the owner protocol; return its actual publication result, not legacy run aliases. */
export async function approveNativeCandidate(
  candidate: Record<string, unknown>,
  key: string,
  timeoutMs = 15_000,
  extraHeaders: Record<string, string> = {},
) {
  const id = requiredString(candidate, "id");
  const manifest = requiredString(candidate, "manifest_digest");
  const inspected = await get(`/v1/game-candidates/${id}/inspection?manifest=${manifest}`);
  expect(inspected.response.status, JSON.stringify(inspected.document)).toBe(200);
  expect(inspected.document).toMatchObject({
    ready: true,
    approval_scope: "whole_candidate",
    manifest_digest: manifest,
  });
  const preparationPath = `/v1/game-candidates/${id}/publication-preparation`;
  const prepared = await post(`${preparationPath}/start`, {
    manifest_digest: manifest,
    generation: candidate.generation,
    sequence: 0,
    idempotency_key: `${key}-artifacts`,
  });
  expect(prepared.response.status, JSON.stringify(prepared.document)).toBe(202);
  const artifacts = await observeUntil(preparationPath, (state) => state !== "preparing", timeoutMs);
  expect(artifacts.document.state, JSON.stringify(artifacts.document)).toBe("verified");
  const approved = await post(
    "/v1/publications/start",
    {
      candidate_id: id,
      manifest_digest: manifest,
      expected_game_revision_id: requiredString(candidate, "expected_game_revision_id"),
      generation: candidate.generation,
      idempotency_key: key,
    },
    extraHeaders,
  );
  expect(approved.response.status, JSON.stringify(approved.document)).toBe(202);
  expect(approved.document).toMatchObject({
    candidate_id: id,
    manifest_digest: manifest,
    approval_scope: "whole_candidate",
  });
  const operation = requiredString(approved.document, "id");
  const result = await observeUntil(
    `/v1/publications/${operation}`,
    (state) => ["published", "failed", "retry_paused"].includes(state),
    timeoutMs,
  );
  expect(result.document.state, JSON.stringify(result.document)).toBe("published");
  await waitForVerifiedPublicationBackup(
    requiredString(result.document, "backup_attempt_id"),
    requiredString(result.document, "resulting_revision_id"),
    timeoutMs,
  );
  return result;
}

export async function waitForVerifiedPublicationBackup(attemptId: string, revisionId: string, timeoutMs = 15_000) {
  const backup = await observeUntil(
    `/v1/backups/${attemptId}`,
    (state) => ["verified", "failed"].includes(state),
    timeoutMs,
  );
  expect(backup.document.state, JSON.stringify(backup.document)).toBe("verified");
  expect(backup.document.catalogue_revision_id).toBe(revisionId);
}

async function observeUntil(path: string, complete: (state: string) => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let observed = await get(path);
  while (Date.now() < deadline) {
    expect(observed.response.status, JSON.stringify(observed.document)).toBe(200);
    if (complete(String(observed.document.state))) return observed;
    await new Promise((resolve) => setTimeout(resolve, 25));
    observed = await get(path);
  }
  throw new Error(
    `Native owner operation ${path} remained pending after ${timeoutMs}ms: ${JSON.stringify(observed.document)}`,
  );
}
