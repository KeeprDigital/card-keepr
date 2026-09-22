import { type CatalogueStore, canonicalJson } from "../shared";
import {
  adaptHostPacing,
  currentHostPacingState,
  type HostPacingSignal,
  type HostPacingState,
  type ResolvedHostPacingPolicy,
} from "./host-pacing";
import { hostPacingEventStatement, hostPacingStatement, saveHostPacingStatement } from "./source-capture-repository";

export type SourceHostPacingMode = "production" | "immediate";

type HostPacingRow = {
  next_request_not_before: string;
  interval_ms: number | null;
  concurrency: number | null;
  clean_streak: number | null;
  latency_baseline_ms: number | null;
};

// The adaptive pacing of one hostname for one collection batch (#389). The
// state is loaded from D1 when the batch starts and written after every
// response, so a replayed batch, the next batch step, or a replacement
// hostname shard Workflow resumes from the persisted interval, concurrency,
// streak and next-request deadline rather than restarting aggressively.
// Only one hostname shard of one collecting run owns a host at a time, so the
// in-memory state is authoritative for the batch's lifetime.
//
// Page hosts space requests from the previous completion (plus jitter), as
// before. Asset hosts space request starts by the interval and keep up to the
// current concurrency in flight. "immediate" mode (tests) adapts and records
// state but never waits.
export class HostPacer {
  private constructor(
    private readonly database: CatalogueStore,
    private readonly runId: string,
    readonly policy: ResolvedHostPacingPolicy,
    private readonly mode: SourceHostPacingMode,
    private current: HostPacingState,
    private nextStartAt: number,
  ) {}

  static async load(
    database: CatalogueStore,
    runId: string,
    policy: ResolvedHostPacingPolicy,
    mode: SourceHostPacingMode,
  ): Promise<HostPacer> {
    const row = await hostPacingStatement(database, policy.hostname).first<HostPacingRow>();
    const deadline = row === null ? Number.NaN : Date.parse(row.next_request_not_before);
    return new HostPacer(
      database,
      runId,
      policy,
      mode,
      currentHostPacingState(policy, row),
      Number.isNaN(deadline) ? 0 : deadline,
    );
  }

  get state(): HostPacingState {
    return this.current;
  }

  get concurrency(): number {
    return this.current.concurrency;
  }

  /** Milliseconds to wait before the next request may start. */
  startDelay(nowMs = Date.now()): number {
    return this.mode === "immediate" ? 0 : Math.max(0, this.nextStartAt - nowMs);
  }

  /** Records a request start; asset hosts space starts by the interval. */
  started(nowMs = Date.now()): void {
    if (this.policy.kind === "asset") {
      this.nextStartAt = Math.max(this.nextStartAt, nowMs + this.current.interval_ms);
    }
  }

  /** Applies one physical request's outcome and persists the host state
   * before anything else, so a replay still honours the new deadline. A
   * request without a transport signal (a body failure) leaves the adaptive
   * state unchanged but still advances a page host's deadline. */
  async completed(
    signal: HostPacingSignal | null,
    receipt: Readonly<{ requestId: string; attemptId: string }>,
  ): Promise<void> {
    const nowMs = Date.now();
    const decision =
      signal === null
        ? { state: this.current, event: null, hold_ms: 0 }
        : adaptHostPacing(this.policy, this.current, signal);
    this.current = decision.state;
    if (this.policy.kind === "page") {
      this.nextStartAt = nowMs + this.current.interval_ms + jitter(Math.floor(this.current.interval_ms / 4));
    }
    this.nextStartAt = Math.max(this.nextStartAt, nowMs + decision.hold_ms);
    const at = new Date(nowMs).toISOString();
    const statements = [
      saveHostPacingStatement(this.database, {
        hostname: this.policy.hostname,
        nextRequestAt: this.mode === "immediate" ? at : new Date(this.nextStartAt).toISOString(),
        intervalMs: this.current.interval_ms,
        concurrency: this.current.concurrency,
        cleanStreak: this.current.clean_streak,
        latencyBaselineMs: this.current.latency_baseline_ms,
        policyJson: canonicalJson(this.policy),
        updatedAt: at,
      }),
    ];
    if (decision.event !== null) {
      statements.push(
        hostPacingEventStatement(this.database, {
          id: `pacing_${receipt.attemptId}`,
          hostname: this.policy.hostname,
          runId: this.runId,
          requestId: receipt.requestId,
          occurredAt: at,
          kind: decision.event.kind,
          reason: decision.event.reason,
          intervalBeforeMs: decision.event.interval_before_ms,
          intervalAfterMs: decision.event.interval_after_ms,
          concurrencyBefore: decision.event.concurrency_before,
          concurrencyAfter: decision.event.concurrency_after,
          httpStatus: decision.event.http_status,
          retryAfterMs: decision.event.retry_after_ms,
          latencyMs: decision.event.latency_ms,
        }),
      );
    }
    await this.database.batch(statements);
  }
}

function jitter(maximumInclusive: number): number {
  if (maximumInclusive <= 0) return 0;
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return random[0]! % (maximumInclusive + 1);
}
