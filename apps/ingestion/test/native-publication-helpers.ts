import { expect } from "vitest";
import { waitForNativeCandidate } from "./native-candidate-helpers";
import { nativePredecessorDriver } from "./native-preparation-driver";
import {
  get,
  postThroughWorkflowBindings,
  postWithControlledPreparation,
  postWithControlledPublication,
  requiredString,
  request,
  testEnv,
} from "./reconciliation-helpers";

/** A native fixture starts from retained collection, never a legacy aggregate candidate. */
async function prepareCandidate(
  runId: string,
  game: string,
  expectedGameRevision: string,
  key: string,
  timeoutMs = 15_000,
  extraHeaders: Record<string, string> = {},
  scheduling: "binding" | "direct",
  expectedState: "sealed" | "failed" = "sealed",
) {
  const created = await (scheduling === "direct" ? postWithControlledPreparation : postThroughWorkflowBindings)(
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
  return waitForNativeCandidate(id, expectedState, timeoutMs);
}

/** Completed seed for fault/semantic tests; subsequent operations retain their own bindings or injected drivers. */
export function prepareNativeCandidate(
  runId: string,
  game: string,
  expectedGameRevision: string,
  key: string,
  timeoutMs = 15_000,
  extraHeaders: Record<string, string> = {},
) {
  return prepareCandidate(runId, game, expectedGameRevision, key, timeoutMs, extraHeaders, "direct");
}

/** Explicit native preparation after collection, including intentionally rejected evidence. */
export function prepareNativeEvidence(input: {
  runId: string;
  game: string;
  predecessor: string;
  key: string;
  expectedState?: "sealed" | "failed";
}) {
  return prepareCandidate(
    input.runId,
    input.game,
    input.predecessor,
    input.key,
    15_000,
    {},
    "direct",
    input.expectedState,
  );
}

/** Exercise the owner protocol; return its actual publication result, not legacy run aliases. */
async function publishCandidate(
  candidate: Record<string, unknown>,
  key: string,
  timeoutMs = 15_000,
  extraHeaders: Record<string, string> = {},
  submit: typeof postThroughWorkflowBindings,
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
  const prepared = await submit(`${preparationPath}/start`, {
    manifest_digest: manifest,
    generation: candidate.generation,
    sequence: 0,
    idempotency_key: `${key}-artifacts`,
  });
  expect(prepared.response.status, JSON.stringify(prepared.document)).toBe(202);
  const artifacts = await observeUntil(preparationPath, (state) => state !== "preparing", timeoutMs);
  expect(artifacts.document.state, JSON.stringify(artifacts.document)).toBe("verified");
  const approved = await submit(
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

  return result;
}

/** Rule and storage fixtures use controlled scheduling; binding and recovery journeys keep the original helper. */
export async function approveNativeCandidate(
  candidate: Record<string, unknown>,
  key: string,
  timeoutMs = 15_000,
  extraHeaders: Record<string, string> = {},
) {
  const result = await publishCandidate(candidate, key, timeoutMs, extraHeaders, postWithControlledPublication);
  await verifyPublicationResult(result, timeoutMs);
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

/** Explicitly exercise platform scheduling instead of a suite's controlled driver. */
export function prepareNativeCandidateThroughBinding(...args: Parameters<typeof prepareNativeCandidate>) {
  const [runId, game, predecessor, key, timeout = 15_000, headers = {}] = args;
  return prepareCandidate(runId, game, predecessor, key, timeout, headers, "binding");
}

export async function approveNativeCandidateThroughBinding(...args: Parameters<typeof approveNativeCandidate>) {
  const [candidate, key, timeout = 15_000, headers = {}] = args;
  const result = await publishCandidate(candidate, key, timeout, headers, postThroughWorkflowBindings);
  await verifyPublicationResult(result, timeout);
  return result;
}

async function verifyPublicationResult(result: Awaited<ReturnType<typeof publishCandidate>>, timeout: number) {
  await waitForVerifiedPublicationBackup(
    requiredString(result.document, "backup_attempt_id"),
    requiredString(result.document, "resulting_revision_id"),
    timeout,
  );
}

export type NativePredecessor = {
  candidateId: string;
  revisionId: string;
  publicationId: string;
  backupAttemptId: string;
  checkpoint: "pending";
};

/** Real published storage for preparation assertions. Backup remains pending and blocks the next publication. */
export async function seedNativePredecessor(
  candidate: Record<string, unknown>,
  key: string,
): Promise<NativePredecessor> {
  const driver = nativePredecessorDriver(testEnv);
  const submit: typeof postThroughWorkflowBindings = (path, body, headers = {}) => request(path, body, headers, driver);
  const result = await publishCandidate(candidate, key, 15_000, {}, submit);
  const backupAttemptId = requiredString(result.document, "backup_attempt_id");
  const queued = driver.pendingBackups();
  expect(queued).toHaveLength(1);
  expect(queued[0]).toMatchObject({ idempotency_key: backupAttemptId });
  const backup = await get(`/v1/backups/${backupAttemptId}`);
  expect(backup.document.state, JSON.stringify(backup.document)).toBe("pending");
  return {
    candidateId: requiredString(candidate, "id"),
    revisionId: requiredString(result.document, "resulting_revision_id"),
    publicationId: requiredString(result.document, "id"),
    backupAttemptId,
    checkpoint: "pending",
  };
}
