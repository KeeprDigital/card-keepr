import { type HostPacingPolicy, requiredSourceAdapter } from "../adapters";

// Adaptive per-host pacing (#389). Pure decisions only: persistence and waits
// live in host-pacer.ts. A host starts at its most aggressive recorded setting
// (floor interval, maximum concurrency). It backs off multiplicatively (the
// interval doubles, concurrency halves) on HTTP 429, 503, 502/504, any
// Retry-After on a refusal, a transport timeout or connection failure, or a
// response clearly slower than its latency baseline. After a run of clean
// responses it recovers additively (one step shorter, one more in flight),
// always clamped to the registration's floor and ceiling.

export type ResolvedHostPacingPolicy = Readonly<{
  hostname: string;
  kind: "page" | "asset";
  floor_ms: number;
  ceiling_ms: number;
  maximum_concurrency: number;
  // "registration" when a run's Source Adapter Version declares the host;
  // "default" for an undeclared host, paced sequentially from the configured
  // deployment interval.
  source: "registration" | "default";
  adapter_versions: readonly string[];
}>;

export type HostPacingState = Readonly<{
  interval_ms: number;
  concurrency: number;
  clean_streak: number;
  latency_baseline_ms: number | null;
}>;

export type HostPacingSignal =
  | Readonly<{ kind: "response"; status: number; latency_ms: number; retry_after_ms: number | null }>
  | Readonly<{ kind: "transport_failure"; reason: "timeout" | "connection"; latency_ms: number }>;

export type HostPacingBackoffReason =
  "rate_limited" | "unavailable" | "gateway" | "retry_after" | "timeout" | "connection" | "latency";

export type HostPacingEvent = Readonly<{
  kind: "backoff" | "recovery";
  reason: HostPacingBackoffReason | "clean_streak";
  interval_before_ms: number;
  interval_after_ms: number;
  concurrency_before: number;
  concurrency_after: number;
  http_status: number | null;
  retry_after_ms: number | null;
  latency_ms: number;
}>;

export type HostPacingDecision = Readonly<{
  state: HostPacingState;
  event: HostPacingEvent | null;
  // The minimum wait before any next request to the host (Retry-After).
  hold_ms: number;
}>;

// Clean responses needed before one additive recovery step.
export const hostPacingRecoveryStreak = 20;
// The smallest multiplicative backoff step, so a zero or tiny interval still
// slows down measurably.
const minimumBackoffStepMs = 250;
// A response is clearly slow when it exceeds both this multiple of the
// baseline and the baseline plus this margin.
const slowLatencyFactor = 4;
const slowLatencyMarginMs = 1_000;

/** The pacing bounds for one hostname across a run's Source Adapter Versions.
 * Only versions that declare the host contribute; several declarations merge
 * to the most polite bounds. An undeclared host is a sequential page host
 * starting at the configured deployment interval. */
export function resolveHostPacingPolicy(
  hostname: string,
  adapterVersions: readonly string[],
  defaultIntervalMs: number,
): ResolvedHostPacingPolicy {
  const declared: Array<{ adapterVersion: string; policy: HostPacingPolicy }> = [];
  for (const adapterVersion of [...new Set(adapterVersions)].sort()) {
    const policy = requiredSourceAdapter(adapterVersion).hostPacing?.find((entry) => entry.hostname === hostname);
    if (policy !== undefined) declared.push({ adapterVersion, policy });
  }
  if (declared.length === 0) {
    return {
      hostname,
      kind: "page",
      floor_ms: defaultIntervalMs,
      ceiling_ms: Math.min(60_000, Math.max(4_000, defaultIntervalMs * 8)),
      maximum_concurrency: 1,
      source: "default",
      adapter_versions: [],
    };
  }
  const page = declared.some(({ policy }) => policy.kind === "page");
  return {
    hostname,
    kind: page ? "page" : "asset",
    floor_ms: Math.max(...declared.map(({ policy }) => policy.floorMs)),
    ceiling_ms: Math.max(...declared.map(({ policy }) => policy.ceilingMs)),
    maximum_concurrency: page ? 1 : Math.min(...declared.map(({ policy }) => policy.maximumConcurrency)),
    source: "registration",
    adapter_versions: declared.map(({ adapterVersion }) => adapterVersion),
  };
}

/** A host's current state within its bounds: the most aggressive setting when
 * nothing is recorded, otherwise the recorded state clamped to the bounds in
 * force now (a registration may have changed since it was recorded). */
export function currentHostPacingState(
  policy: ResolvedHostPacingPolicy,
  recorded: Readonly<{
    interval_ms?: number | null;
    concurrency?: number | null;
    clean_streak?: number | null;
    latency_baseline_ms?: number | null;
  }> | null,
): HostPacingState {
  if (recorded?.interval_ms === undefined || recorded.interval_ms === null) {
    return {
      interval_ms: policy.floor_ms,
      concurrency: policy.maximum_concurrency,
      clean_streak: 0,
      latency_baseline_ms: null,
    };
  }
  return {
    interval_ms: clamp(recorded.interval_ms, policy.floor_ms, policy.ceiling_ms),
    concurrency: clamp(recorded.concurrency ?? policy.maximum_concurrency, 1, policy.maximum_concurrency),
    clean_streak: Math.max(0, recorded.clean_streak ?? 0),
    latency_baseline_ms: recorded.latency_baseline_ms ?? null,
  };
}

/** One response or transport failure's effect on a host. A 5xx other than
 * 502/503/504 and a body failure are neutral; every other response is clean. */
export function adaptHostPacing(
  policy: ResolvedHostPacingPolicy,
  state: HostPacingState,
  signal: HostPacingSignal,
): HostPacingDecision {
  const reason = backoffReason(state, signal);
  const status = signal.kind === "response" ? signal.status : null;
  const retryAfter = signal.kind === "response" ? signal.retry_after_ms : null;
  if (reason !== null) {
    const next: HostPacingState = {
      interval_ms: clamp(
        Math.max(state.interval_ms * 2, state.interval_ms + minimumBackoffStepMs),
        policy.floor_ms,
        policy.ceiling_ms,
      ),
      concurrency: Math.max(1, Math.floor(state.concurrency / 2)),
      clean_streak: 0,
      // A slow response still feeds the baseline, so a host that has become
      // durably slower stops counting as slow instead of pinning the ceiling.
      latency_baseline_ms:
        reason === "latency" && state.latency_baseline_ms !== null
          ? Math.round(state.latency_baseline_ms * 0.8 + signal.latency_ms * 0.2)
          : state.latency_baseline_ms,
    };
    return {
      state: next,
      event: event("backoff", reason, state, next, status, retryAfter, signal.latency_ms),
      hold_ms: retryAfter ?? 0,
    };
  }
  if (signal.kind !== "response" || signal.status >= 500) {
    return { state, event: null, hold_ms: 0 };
  }
  const baseline =
    state.latency_baseline_ms === null
      ? signal.latency_ms
      : Math.round(state.latency_baseline_ms * 0.8 + signal.latency_ms * 0.2);
  const streak = state.clean_streak + 1;
  const atMostAggressive = state.interval_ms <= policy.floor_ms && state.concurrency >= policy.maximum_concurrency;
  if (streak < hostPacingRecoveryStreak || atMostAggressive) {
    return {
      state: {
        ...state,
        clean_streak: atMostAggressive ? 0 : streak,
        latency_baseline_ms: baseline,
      },
      event: null,
      hold_ms: 0,
    };
  }
  const next: HostPacingState = {
    interval_ms: Math.max(policy.floor_ms, state.interval_ms - recoveryStepMs(policy)),
    concurrency: Math.min(policy.maximum_concurrency, state.concurrency + 1),
    clean_streak: 0,
    latency_baseline_ms: baseline,
  };
  return {
    state: next,
    event: event("recovery", "clean_streak", state, next, signal.status, null, signal.latency_ms),
    hold_ms: 0,
  };
}

function backoffReason(state: HostPacingState, signal: HostPacingSignal): HostPacingBackoffReason | null {
  if (signal.kind === "transport_failure") return signal.reason;
  if (signal.status === 429) return "rate_limited";
  if (signal.status === 503) return "unavailable";
  if (signal.status === 502 || signal.status === 504) return "gateway";
  if (signal.retry_after_ms !== null && signal.status >= 400) return "retry_after";
  const baseline = state.latency_baseline_ms;
  if (
    signal.status < 400 &&
    baseline !== null &&
    signal.latency_ms > Math.max(baseline * slowLatencyFactor, baseline + slowLatencyMarginMs)
  ) {
    return "latency";
  }
  return null;
}

function recoveryStepMs(policy: ResolvedHostPacingPolicy): number {
  return Math.max(50, Math.round((policy.ceiling_ms - policy.floor_ms) / 8));
}

function event(
  kind: HostPacingEvent["kind"],
  reason: HostPacingEvent["reason"],
  before: HostPacingState,
  after: HostPacingState,
  status: number | null,
  retryAfter: number | null,
  latency: number,
): HostPacingEvent {
  return {
    kind,
    reason,
    interval_before_ms: before.interval_ms,
    interval_after_ms: after.interval_ms,
    concurrency_before: before.concurrency,
    concurrency_after: after.concurrency,
    http_status: status,
    retry_after_ms: retryAfter,
    latency_ms: Math.max(0, Math.round(latency)),
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
