import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { catalogueStore } from "../../../src/catalogue/shared";
import { pendingEvidenceRequests } from "../../../src/catalogue/source-evidence";
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
  // Discovery assigns canonical request IDs; the caller-supplied labels are
  // not retained. Compare timestamps using the actual graph IDs for each URL.
  const requests = await pendingEvidenceRequests(catalogueStore(env.CATALOGUE_DB), run.id);
  const idFor = (host: string, sequence: number) => {
    const request = requests.find(
      ({ url }) => url === `https://pacing-${host}-official-source.invalid/sequence/${sequence}`,
    );
    expect(request).toBeDefined();
    return request!.request_id;
  };
  const completed = await resumeCollection(run.id);
  expect(completed.collection_completed_at).toEqual(expect.any(String));
  const attempts = Object.fromEntries(
    completed.diagnostics.map((attempt) => [attempt.request_id, Date.parse(attempt.requested_at)]),
  );
  expect(attempts[idFor("a", 2)]! - attempts[idFor("a", 1)]!).toBeGreaterThanOrEqual(500);
  expect(attempts[idFor("b", 2)]! - attempts[idFor("b", 1)]!).toBeGreaterThanOrEqual(500);
  expect(Math.abs(attempts[idFor("a", 1)]! - attempts[idFor("b", 1)]!)).toBeLessThan(500);
});
