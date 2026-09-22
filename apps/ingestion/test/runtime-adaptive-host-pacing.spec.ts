import { catalogueStore } from "../../../src/catalogue/shared";
import { env } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import { OfficialSourceTransport } from "../src/official-source-transport";
import * as sourceEvidenceQueries from "./query-helpers/source-evidence";
import {
  appendDiscoveredEvidenceRequests,
  HostPacer,
  pendingEvidenceRequests,
  requiredEvidenceRun,
  resolveHostPacingPolicy,
} from "../../../src/catalogue/source-evidence";
import {
  clearActiveRunForNextScenario,
  createCollection,
  installRuntimeSuite,
  resumeCollection,
} from "./runtime-helpers";

installRuntimeSuite();

type PacingDocument = {
  hosts: Array<{ hostname: string; interval_ms: number; concurrency: number }>;
  limits: Array<Record<string, unknown>>;
  events: { count: number; recent: Array<Record<string, unknown>> };
};

test("a page host spaces the next request one adapted interval after completion", async () => {
  const run = await createCollection("adaptive_pacing_interval", "https://official-source.invalid/cards");
  const database = catalogueStore(env.CATALOGUE_DB);
  const policy = resolveHostPacingPolicy("pacing-interval.invalid", ["fixture-one-piece-json@3"], 250);
  expect(policy).toMatchObject({ kind: "page", source: "default", floor_ms: 250, maximum_concurrency: 1 });
  const pacer = await HostPacer.load(database, run.id, policy, "production");
  const before = Date.now();
  await pacer.completed(
    { kind: "response", status: 200, latency_ms: 10, retry_after_ms: null },
    { requestId: "request", attemptId: "attempt-interval" },
  );
  // A replacement shard or the next batch step resumes from the persisted deadline.
  const resumed = await HostPacer.load(database, run.id, policy, "production");
  const delay = resumed.startDelay();
  expect(delay + (Date.now() - before)).toBeGreaterThanOrEqual(250);
  expect(delay).toBeLessThanOrEqual(Math.ceil(250 * 1.25));
});

// #389: backoff state lives in D1 per hostname, so the deployed hostname-shard
// Workflow (a later batch step, a replayed step or a replacement Workflow
// Attempt) continues from it instead of restarting at the aggressive floor.
test("backoff and recovery persist per host across pacer instances and are receipted", async () => {
  const run = await createCollection("adaptive_pacing_persisted", "https://official-source.invalid/cards");
  const database = catalogueStore(env.CATALOGUE_DB);
  const policy = resolveHostPacingPolicy("asset-pacing-official-source.invalid", ["fixture-one-piece-json@3"], 500);
  expect(policy).toMatchObject({ kind: "asset", source: "registration", floor_ms: 0, maximum_concurrency: 4 });
  const first = await HostPacer.load(database, run.id, policy, "immediate");
  expect(first.state).toMatchObject({ interval_ms: 0, concurrency: 4 });
  await first.completed(
    { kind: "response", status: 503, latency_ms: 20, retry_after_ms: 1_500 },
    { requestId: "request-503", attemptId: "attempt-503" },
  );
  const second = await HostPacer.load(database, run.id, policy, "immediate");
  expect(second.state).toMatchObject({ interval_ms: 250, concurrency: 2, clean_streak: 0 });
  for (let index = 0; index < 20; index += 1) {
    await second.completed(
      { kind: "response", status: 200, latency_ms: 20, retry_after_ms: null },
      { requestId: `request-${index}`, attemptId: `attempt-clean-${index}` },
    );
  }
  const third = await HostPacer.load(database, run.id, policy, "immediate");
  expect(third.state).toMatchObject({ interval_ms: 125, concurrency: 3 });
  const events = await sourceEvidenceQueries.readRunHostPacingEvents(env.CATALOGUE_DB).bind(run.id).all();
  expect(events.results).toEqual([
    {
      kind: "backoff",
      reason: "unavailable",
      interval_before_ms: 0,
      interval_after_ms: 250,
      concurrency_before: 4,
      concurrency_after: 2,
      http_status: 503,
      retry_after_ms: 1_500,
    },
    {
      kind: "recovery",
      reason: "clean_streak",
      interval_before_ms: 250,
      interval_after_ms: 125,
      concurrency_before: 2,
      concurrency_after: 3,
      http_status: 200,
      retry_after_ms: null,
    },
  ]);
});

test("a 429 with Retry-After backs the host off through the Workflow and shows in source show", async () => {
  const run = await createCollection(
    "adaptive_pacing_rate_limited",
    "https://adaptive-pacing-official-source.invalid/rate-limited-once",
  );
  const completed = await resumeCollection(run.id, 12_000);
  await clearActiveRunForNextScenario();
  expect(completed.collection_completed_at).not.toBeNull();
  const pacing = (completed.collection as { pacing: PacingDocument }).pacing;
  expect(pacing.limits).toEqual([
    {
      hostname: "adaptive-pacing-official-source.invalid",
      kind: "page",
      source: "default",
      floor_ms: 500,
      ceiling_ms: 4_000,
      maximum_concurrency: 1,
      interval_ms: 1_000,
      concurrency: 1,
      clean_streak: 1,
      backoff_count: 1,
      recovery_count: 0,
    },
  ]);
  expect(pacing.events).toMatchObject({
    count: 1,
    recent: [
      {
        hostname: "adaptive-pacing-official-source.invalid",
        kind: "backoff",
        reason: "rate_limited",
        interval_before_ms: 500,
        interval_after_ms: 1_000,
        http_status: 429,
        retry_after_ms: 0,
      },
    ],
  });
}, 20_000);

test("an asset host keeps at most its registered concurrency in flight", async () => {
  const run = await createCollection("adaptive_pacing_assets", "https://official-source.invalid/cards");
  const database = catalogueStore(env.CATALOGUE_DB);
  const storedRun = await requiredEvidenceRun(database, run.id);
  const root = (await pendingEvidenceRequests(database, run.id))[0];
  if (root === undefined) throw new Error("pending root request missing");
  await appendDiscoveredEvidenceRequests(
    database,
    storedRun,
    root,
    Array.from({ length: 8 }, (_, index) => ({
      role: "image" as const,
      url: `https://asset-pacing-official-source.invalid/png/front-${index}`,
      headers: { accept: "*/*" },
    })),
  );
  let active = 0;
  let maximumActive = 0;
  let releaseFirstWave!: () => void;
  const firstWave = new Promise<void>((resolve) => {
    releaseFirstWave = resolve;
  });
  const transport = vi.spyOn(OfficialSourceTransport.prototype, "fetch").mockImplementation(async (request) => {
    if (new URL(request.url).hostname !== "asset-pacing-official-source.invalid") return fetch(request);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      // Hold the first wave until the pool is full, so a sequential host could
      // never satisfy the barrier and an unbounded one would exceed it.
      if (active >= 4) releaseFirstWave();
      await firstWave;
      return await fetch(request);
    } finally {
      active -= 1;
    }
  });
  try {
    const completed = await resumeCollection(run.id, 12_000);
    expect(completed.collection_completed_at).not.toBeNull();
    expect((completed.collection as { requests: { by_state: Record<string, number> } }).requests.by_state).toEqual({
      observed: 9,
    });
  } finally {
    transport.mockRestore();
    await clearActiveRunForNextScenario();
  }
  expect(maximumActive).toBe(4);
}, 20_000);
