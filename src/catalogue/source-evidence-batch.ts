import {
  advanceHostPacing,
  capturePreparedAttempt,
  completeUploadedCapture,
  hostPacingDelay,
  parseCapturedRequest,
  prepareCaptureAttempt,
  type CaptureTransportResult,
  type SourceHostPacingMode,
} from "./source-evidence-capture";
import {
  requiredEvidenceRun,
  type EvidenceRequestRow,
} from "./source-evidence-repository";

// Durable-step layout for one hostname shard of an Ingestion Run's
// collection (issue #138).
//
// Work that keeps its own durable step:
//   - the per-stage run-state gate and the pending-request page loads, which
//     bound what a stage may touch;
//   - every retry wait ("retry <request>"): a transport backoff or an
//     Official Source Retry-After is a durable sleep so a long deadline
//     survives eviction and stays visible to stall classification as the
//     persisted retry deadline rather than as silence.
//
// Work that moves into one durable step per batch of `collectionBatchSize`
// Source Requests ("collect ... batch ..."): preparing the attempt, the host
// pacing wait, the Official Source fetch with its R2 upload, the attempt
// and Source Snapshot commit, and the parse (Source Observation Set,
// dynamic discovery, Official Source Collection Plan). Nothing inside the
// batch relies on the step ledger for idempotence: every write is guarded
// by the capture-operation state machine (planned -> response_received ->
// uploaded -> finalized | failed), the parse-operation state machine, and
// INSERT OR IGNORE on deterministic identities. A replay of the batch after
// a failure at any point therefore re-derives the same rows: a request whose
// fetch already recorded a response is recovered from its operation row and
// R2 object without another Official Source fetch, a request whose commit
// or parse was interrupted is committed or parsed from its staged state, and
// only a request whose fetch never recorded a response is fetched again,
// under the same attempt number. The fetch is the one non-idempotent action
// and it is fenced by the operation row exactly as when it had its own step.
//
// Pacing: the next request's deadline is persisted the moment the previous
// fetch completes (`advanceHostPacing`) and the wait runs in-process against
// that persisted deadline, so a replay honours the same politeness floor.
// The previous request's commit and parse run meanwhile in a serial
// persistence chain that overlaps the wait; the batch step settles only
// after the chain does, and a chain failure fails the step for replay.
//
// Retry Pause inside a batch: the exhausting attempt commits its attempt row
// and the pause atomically; the run-state read before the next request
// halts the batch ("run_not_collecting"), leaving later requests pending
// with no attempt. A chain member that observes the paused run leaves its
// operation 'uploaded' or the request 'captured' for the resumed attempt.
// Workflow Pause inside a batch: the abandoned Workflow Attempt's step never
// completes; the replacement attempt reloads the pending and captured
// requests and replays them through the same guards.

// Bounded so one batch step stays far below the 1 MiB step-result limit
// and a replay after a failure repeats at most this many cheap recoveries.
export const collectionBatchSize = 8;

// A batch stops admitting new requests once this much wall time has passed,
// so a slow host or a long configured pacing interval cannot push one step
// against its execution timeout; the next batch step resumes from there.
export const collectionBatchTimeBudgetMilliseconds = 4 * 60_000;

export type SourceRequestBatchInput = Readonly<{
  database: D1Database;
  evidenceObjects: R2Bucket;
  officialSourceTransport: Fetcher;
  runId: string;
  hostname: string;
  pacingMode: SourceHostPacingMode;
  pacingIntervalMilliseconds: number;
  requests: readonly EvidenceRequestRow[];
  timeBudgetMilliseconds?: number;
  wait?: (milliseconds: number) => Promise<void>;
}>;

export type SourceRequestBatchHalt =
  // The request at `processed` needs a durable retry wait before its next
  // attempt; the batch resumes from that request afterwards.
  | { kind: "retry_wait"; request_id: string; wait_ms: number }
  // The run left its collecting state (a Retry Pause, Capacity Pause, owner
  // pause, or termination); the requests from `processed` on are untouched.
  | { kind: "run_not_collecting" }
  // The time budget elapsed; the next batch step continues from `processed`.
  | { kind: "time_budget" };

export type SourceRequestBatchOutcome = Readonly<{
  // Requests from the front of the batch that are settled: observed, failed,
  // paused-pending, or fetched with their persistence completed.
  processed: number;
  halt: SourceRequestBatchHalt | null;
}>;

export async function collectSourceRequestBatch(
  input: SourceRequestBatchInput,
): Promise<SourceRequestBatchOutcome> {
  const startedAt = Date.now();
  const timeBudget =
    input.timeBudgetMilliseconds ?? collectionBatchTimeBudgetMilliseconds;
  const wait = input.wait ?? defaultWait;
  let persistence: Promise<void> = Promise.resolve();
  let persistenceFailure: { error: unknown } | null = null;
  const enqueuePersistence = (work: () => Promise<void>): void => {
    persistence = persistence.then(work);
    persistence.catch((error: unknown) => {
      persistenceFailure ??= { error };
    });
  };
  let processed = 0;
  let halt: SourceRequestBatchHalt | null = null;
  let loopFailure: { error: unknown } | null = null;
  try {
    for (const request of input.requests) {
      if (persistenceFailure !== null) break;
      if (processed > 0 && Date.now() - startedAt > timeBudget) {
        halt = { kind: "time_budget" };
        break;
      }
      const run = await requiredEvidenceRun(input.database, input.runId);
      if (run.state !== "collecting") {
        halt = { kind: "run_not_collecting" };
        break;
      }
      const prepared = await prepareCaptureAttempt(
        input.database,
        run,
        request,
      );
      if (prepared.kind === "done") {
        processed += 1;
        continue;
      }
      if (prepared.kind === "captured") {
        const snapshotId = prepared.source_snapshot_id;
        enqueuePersistence(() =>
          persistCapturedRequest(input, request, {
            kind: "captured",
            source_snapshot_id: snapshotId,
            request_made: false,
          })
        );
        processed += 1;
        continue;
      }
      const pacingDelay = await hostPacingDelay(
        input.database,
        input.hostname,
        input.pacingMode,
      );
      if (pacingDelay > 0) await wait(pacingDelay);
      const result = await capturePreparedAttempt(
        input.database,
        input.evidenceObjects,
        input.officialSourceTransport,
        run,
        request,
        prepared,
      );
      if (result.request_made) {
        // Persisted before anything else so a replay after a crash here
        // still waits the full interval from this fetch.
        await advanceHostPacing(
          input.database,
          input.hostname,
          input.pacingMode,
          input.pacingIntervalMilliseconds,
        );
      }
      if (result.kind === "wait") {
        halt = {
          kind: "retry_wait",
          request_id: request.request_id,
          wait_ms: result.wait_ms,
        };
        break;
      }
      if (result.kind === "done") {
        processed += 1;
        continue;
      }
      enqueuePersistence(() => persistCapturedRequest(input, request, result));
      processed += 1;
    }
  } catch (error) {
    loopFailure = { error };
  }
  try {
    await persistence;
  } catch (error) {
    if (loopFailure === null) throw error;
  }
  if (loopFailure !== null) throw loopFailure.error;
  return { processed, halt };
}

// Commit an uploaded capture and parse the captured Source Snapshot. Each
// stage re-reads the run so a pause that landed after the fetch leaves the
// staged state for the resumed attempt instead of advancing past it.
async function persistCapturedRequest(
  input: SourceRequestBatchInput,
  request: EvidenceRequestRow,
  fetched: Extract<CaptureTransportResult, { kind: "uploaded" | "captured" }>,
): Promise<void> {
  let result: CaptureTransportResult = fetched;
  if (result.kind === "uploaded") {
    result = await completeUploadedCapture(
      input.database,
      await requiredEvidenceRun(input.database, input.runId),
      request,
      result.attempt_id,
    );
  }
  if (result.kind === "captured") {
    await parseCapturedRequest(
      input.database,
      input.evidenceObjects,
      await requiredEvidenceRun(input.database, input.runId),
      request,
      result.source_snapshot_id,
    );
  }
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
