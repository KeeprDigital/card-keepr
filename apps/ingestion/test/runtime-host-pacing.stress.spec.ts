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
  const attempts = Object.fromEntries(
    completed.diagnostics.map((attempt) => [attempt.request_id, Date.parse(attempt.requested_at)]),
  );
  expect(attempts["second-a"]! - attempts["first-a"]!).toBeGreaterThanOrEqual(500);
  expect(attempts["second-b"]! - attempts["first-b"]!).toBeGreaterThanOrEqual(500);
  expect(Math.abs(attempts["first-a"]! - attempts["first-b"]!)).toBeLessThan(500);
});
