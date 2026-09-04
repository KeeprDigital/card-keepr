import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { sourceHostPacingIntervalMilliseconds } from "../../../src/catalogue/source-evidence";
import {
  type CollectionDocument,
  fixtureEvidenceRequest,
  installRuntimeSuite,
  resumeCollection,
} from "./runtime-helpers";

installRuntimeSuite();

// Local stand-in for the production measurement in issue #138: one hostname,
// a steady window of successful fetches against the fake publisher under the
// real per-host pacing interval (500 ms unless overridden). Wall time per
// Source Request is measured exactly as the issue did, from the retained
// attempt diagnostics (`requested_at` / `completed_at`): the gap between one
// fetch completing and the next starting is the durable-step overhead the
// pacing wait does not already cover.
const requestCount = 60;
const hostname = "throughput-official-source.invalid";

test("a single-host collection spends close to the pacing interval per Source Request", async () => {
  const pacingIntervalMs = sourceHostPacingIntervalMilliseconds(env.SOURCE_HOST_PACING_INTERVAL_MS);
  const response = await fixtureEvidenceRequest({
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: "collection_throughput_stress_001",
    requests: Array.from({ length: requestCount }, (_, index) => ({
      id: `sequence-${String(index + 1).padStart(3, "0")}`,
      url: `https://${hostname}/sequence/${String(index + 1).padStart(3, "0")}`,
    })),
  });
  expect(response.status).toBe(201);
  const run = await response.json<CollectionDocument>();
  const completed = await resumeCollection(run.id, 300_000);
  expect(completed.state).toBe("parsing");
  expect(completed.snapshots).toHaveLength(requestCount);

  const attempts = completed.diagnostics
    .filter((attempt) => attempt.outcome === "success")
    .map((attempt) => ({
      request_id: attempt.request_id,
      requested_at: Date.parse(attempt.requested_at),
      completed_at: Date.parse(attempt.completed_at),
    }))
    .sort((left, right) => left.requested_at - right.requested_at);
  expect(attempts).toHaveLength(requestCount);

  const walls: number[] = [];
  const gaps: number[] = [];
  const fetches: number[] = [];
  for (let index = 0; index < attempts.length; index += 1) {
    const current = attempts[index]!;
    fetches.push(current.completed_at - current.requested_at);
    const next = attempts[index + 1];
    if (next === undefined) continue;
    walls.push(next.requested_at - current.requested_at);
    gaps.push(next.requested_at - current.completed_at);
  }
  const summary = {
    request_count: requestCount,
    pacing_interval_ms: pacingIntervalMs,
    total_ms: attempts.at(-1)!.completed_at - attempts[0]!.requested_at,
    wall_per_request_ms: statistics(walls),
    gap_after_fetch_ms: statistics(gaps),
    fetch_ms: statistics(fetches),
  };
  console.log(`collection throughput ${JSON.stringify(summary)}`);

  // Every gap honours the politeness pacing (the pacing deadline is one
  // interval after the previous fetch completed, plus non-negative jitter).
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(pacingIntervalMs - 5);
  // Acceptance criterion from #138: wall time per request within ~0.5 s of
  // the pacing interval.
  expect(summary.wall_per_request_ms.mean).toBeLessThanOrEqual(pacingIntervalMs + 500);
}, 360_000);

function statistics(values: readonly number[]): {
  mean: number;
  p50: number;
  max: number;
  min: number;
} {
  const sorted = [...values].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    mean: Math.round(total / Math.max(1, sorted.length)),
    p50: sorted[Math.floor(sorted.length / 2)] ?? 0,
    max: sorted.at(-1) ?? 0,
    min: sorted[0] ?? 0,
  };
}
