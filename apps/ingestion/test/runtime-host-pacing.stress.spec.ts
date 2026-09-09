import { expect, test } from "vitest";
import {
  type CollectionDocument,
  fixtureEvidenceRequest,
  installRuntimeSuite,
  resumeCollection,
} from "./runtime-helpers";

installRuntimeSuite();

test("collection is sequential per hostname and different hostnames progress concurrently", async () => {
  const response = await fixtureEvidenceRequest({
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: "source_collection_pacing_001",
    requests: [
      {
        id: "first-a",
        url: "https://pacing-a-official-source.invalid/sequence/1",
      },
      {
        id: "second-a",
        url: "https://pacing-a-official-source.invalid/sequence/2",
      },
      {
        id: "first-b",
        url: "https://pacing-b-official-source.invalid/sequence/1",
      },
      {
        id: "second-b",
        url: "https://pacing-b-official-source.invalid/sequence/2",
      },
    ],
  });
  expect(response.status).toBe(201);
  const run = await response.json<CollectionDocument>();
  const completed = await resumeCollection(run.id);
  expect(completed.collection_completed_at).toEqual(expect.any(String));
  // The retained graph assigns canonical Source Request identities. Resolve
  // each attempt through its Source Snapshot rather than fixture input labels.
  const requestedAt = (url: string) => {
    const snapshot = completed.snapshots.find((item) => item.request.url === url);
    expect(snapshot, `retained snapshot for ${url}`).toBeDefined();
    const attempt = completed.diagnostics.find((item) => item.id === snapshot!.retrieval.fetch_attempt_id);
    expect(attempt, `fetch attempt for ${url}`).toBeDefined();
    const timestamp = Date.parse(attempt!.requested_at);
    expect(Number.isFinite(timestamp), `requested_at for ${url}`).toBe(true);
    return timestamp;
  };
  const firstA = requestedAt("https://pacing-a-official-source.invalid/sequence/1");
  const secondA = requestedAt("https://pacing-a-official-source.invalid/sequence/2");
  const firstB = requestedAt("https://pacing-b-official-source.invalid/sequence/1");
  const secondB = requestedAt("https://pacing-b-official-source.invalid/sequence/2");
  expect(secondA - firstA).toBeGreaterThanOrEqual(500);
  expect(secondB - firstB).toBeGreaterThanOrEqual(500);
  expect(Math.abs(firstA - firstB)).toBeLessThan(500);
});
