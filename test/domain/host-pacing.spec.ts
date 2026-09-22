import { describe, expect, test } from "vitest";
import {
  adaptHostPacing,
  currentHostPacingState,
  hostPacingRecoveryStreak,
  type HostPacingState,
  type ResolvedHostPacingPolicy,
  resolveHostPacingPolicy,
} from "../../src/catalogue/source-evidence";

const page: ResolvedHostPacingPolicy = {
  hostname: "pages.invalid",
  kind: "page",
  floor_ms: 250,
  ceiling_ms: 4_000,
  maximum_concurrency: 1,
  source: "registration",
  adapter_versions: ["example@1"],
};
const asset: ResolvedHostPacingPolicy = {
  ...page,
  hostname: "cdn.invalid",
  kind: "asset",
  floor_ms: 50,
  ceiling_ms: 2_000,
  maximum_concurrency: 8,
};
const ok = (latency = 100) => ({ kind: "response" as const, status: 200, latency_ms: latency, retry_after_ms: null });

describe("registered per-host bounds (#389)", () => {
  test("One Piece hosts: sequential publisher and Limitless pages, a bounded CDN", () => {
    expect(resolveHostPacingPolicy("en.onepiece-cardgame.com", ["one-piece-en@6"], 500)).toMatchObject({
      kind: "page",
      source: "registration",
      floor_ms: 500,
      ceiling_ms: 4_000,
      maximum_concurrency: 1,
    });
    expect(resolveHostPacingPolicy("onepiece.limitlesstcg.com", ["limitless-one-piece-en@1"], 500)).toMatchObject({
      kind: "page",
      floor_ms: 250,
      maximum_concurrency: 1,
    });
    expect(
      resolveHostPacingPolicy("limitlesstcg.nyc3.cdn.digitaloceanspaces.com", ["limitless-one-piece-en@1"], 500),
    ).toMatchObject({ kind: "asset", floor_ms: 50, ceiling_ms: 2_000, maximum_concurrency: 8 });
  });

  test("an undeclared host is a sequential page host at the deployment interval", () => {
    expect(resolveHostPacingPolicy("elsewhere.invalid", ["one-piece-en@6"], 500)).toEqual({
      hostname: "elsewhere.invalid",
      kind: "page",
      floor_ms: 500,
      ceiling_ms: 4_000,
      maximum_concurrency: 1,
      source: "default",
      adapter_versions: [],
    });
  });

  test("a composed run takes only declaring versions into account", () => {
    expect(
      resolveHostPacingPolicy("en.onepiece-cardgame.com", ["one-piece-en@6", "limitless-one-piece-en@1"], 2_000),
    ).toMatchObject({ floor_ms: 500, adapter_versions: ["one-piece-en@6"] });
  });
});

describe("adaptive decisions", () => {
  test("a host starts at its most aggressive setting and clamps recorded state to current bounds", () => {
    expect(currentHostPacingState(asset, null)).toEqual({
      interval_ms: 50,
      concurrency: 8,
      clean_streak: 0,
      latency_baseline_ms: null,
    });
    expect(currentHostPacingState(asset, { interval_ms: 9_000, concurrency: 20, clean_streak: 3 })).toMatchObject({
      interval_ms: 2_000,
      concurrency: 8,
      clean_streak: 3,
    });
  });

  test.each([
    [{ kind: "response" as const, status: 429, latency_ms: 10, retry_after_ms: null }, "rate_limited"],
    [{ kind: "response" as const, status: 503, latency_ms: 10, retry_after_ms: 2_000 }, "unavailable"],
    [{ kind: "response" as const, status: 502, latency_ms: 10, retry_after_ms: null }, "gateway"],
    [{ kind: "response" as const, status: 504, latency_ms: 10, retry_after_ms: null }, "gateway"],
    [{ kind: "response" as const, status: 403, latency_ms: 10, retry_after_ms: 5_000 }, "retry_after"],
    [{ kind: "transport_failure" as const, reason: "timeout" as const, latency_ms: 30_000 }, "timeout"],
    [{ kind: "transport_failure" as const, reason: "connection" as const, latency_ms: 5 }, "connection"],
  ])("backs off multiplicatively on %o", (signal, reason) => {
    const decision = adaptHostPacing(asset, currentHostPacingState(asset, null), signal);
    expect(decision.state).toMatchObject({ interval_ms: 300, concurrency: 4, clean_streak: 0 });
    expect(decision.event).toMatchObject({ kind: "backoff", reason, interval_before_ms: 50, interval_after_ms: 300 });
    expect(decision.hold_ms).toBe(signal.kind === "response" ? (signal.retry_after_ms ?? 0) : 0);
  });

  test("clearly rising latency backs off; ordinary jitter does not", () => {
    const state: HostPacingState = { interval_ms: 250, concurrency: 1, clean_streak: 0, latency_baseline_ms: 200 };
    expect(adaptHostPacing(page, state, ok(700)).event).toBeNull();
    expect(adaptHostPacing(page, state, ok(1_300)).event).toMatchObject({ kind: "backoff", reason: "latency" });
  });

  test("backoff clamps to the ceiling and one in flight; other 5xx are neutral", () => {
    let state: HostPacingState = { interval_ms: 3_000, concurrency: 1, clean_streak: 5, latency_baseline_ms: 100 };
    state = adaptHostPacing(page, state, { kind: "response", status: 429, latency_ms: 10, retry_after_ms: null }).state;
    expect(state).toMatchObject({ interval_ms: 4_000, concurrency: 1 });
    const neutral = adaptHostPacing(page, state, {
      kind: "response",
      status: 500,
      latency_ms: 10,
      retry_after_ms: null,
    });
    expect(neutral).toEqual({ state, event: null, hold_ms: 0 });
  });

  test("recovers additively after a run of clean responses, never past the floor", () => {
    let state: HostPacingState = { interval_ms: 1_000, concurrency: 2, clean_streak: 0, latency_baseline_ms: 100 };
    const events = [];
    for (let index = 0; index < hostPacingRecoveryStreak * 3; index += 1) {
      const decision = adaptHostPacing(asset, state, ok());
      state = decision.state;
      if (decision.event !== null) events.push(decision.event);
    }
    expect(events.map((event) => [event.interval_after_ms, event.concurrency_after])).toEqual([
      [756, 3],
      [512, 4],
      [268, 5],
    ]);
    for (let index = 0; index < hostPacingRecoveryStreak * 10; index += 1)
      state = adaptHostPacing(asset, state, ok()).state;
    expect(state).toMatchObject({ interval_ms: 50, concurrency: 8 });
  });
});
