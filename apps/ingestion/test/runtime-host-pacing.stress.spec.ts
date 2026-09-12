import { env } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import { OfficialSourceTransport } from "../src/official-source-transport";
import { catalogueStore } from "../../../src/catalogue/shared";
import { pendingEvidenceRequests, sourceHostPacingIntervalMilliseconds } from "../../../src/catalogue/source-evidence";
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
  const enteredHosts = new Set<string>();
  const activeHosts = new Set<string>();
  const overlaps: string[] = [];
  let releaseFetches!: () => void;
  const fetchesReleased = new Promise<void>((resolve) => {
    releaseFetches = resolve;
  });
  const transport = vi.spyOn(OfficialSourceTransport.prototype, "fetch").mockImplementation(async (request) => {
    const url = new URL(request.url);
    if (activeHosts.has(url.hostname)) overlaps.push(url.hostname);
    activeHosts.add(url.hostname);
    try {
      if (url.pathname === "/sequence/1") {
        enteredHosts.add(url.hostname);
        await fetchesReleased;
      }
      return await fetch(request);
    } finally {
      activeHosts.delete(url.hostname);
    }
  });
  const completion = resumeCollection(run.id);
  // Observe both outstanding fetches before releasing either. Serial execution
  // cannot satisfy this barrier, even when its request starts happen close together.
  void completion.catch(() => undefined);
  try {
    await expect.poll(() => enteredHosts.size, { timeout: 4_000 }).toBe(2);
    expect([...activeHosts].sort()).toEqual(["pacing-a-official-source.invalid", "pacing-b-official-source.invalid"]);
  } finally {
    releaseFetches();
    // Finish late work before restoring transport or letting storage reset.
    await completion.catch(() => undefined);
    transport.mockRestore();
  }
  const completed = await completion;
  expect(completed.collection_completed_at).toEqual(expect.any(String));
  expect(overlaps).toEqual([]);
  expect(completed.diagnostics).toHaveLength(4);
  const attempts = Object.fromEntries(
    completed.diagnostics.map((attempt) => {
      expect(attempt.outcome).toBe("success");
      return [attempt.request_id, attempt];
    }),
  );
  const interval = sourceHostPacingIntervalMilliseconds(env.SOURCE_HOST_PACING_INTERVAL_MS);
  for (const host of ["a", "b"]) {
    const first = attempts[idFor(host, 1)]!;
    const second = attempts[idFor(host, 2)]!;
    expect(Date.parse(second.requested_at) - Date.parse(first.completed_at)).toBeGreaterThanOrEqual(interval);
  }
});
