import type { CatalogueStore } from "../shared";
import { HostPacer } from "./host-pacer";
import { type HostPacingSignal, resolveHostPacingPolicy } from "./host-pacing";
import {
  type CaptureTransportResult,
  capturePreparedAttempt,
  completeUploadedCapture,
  parseCapturedRequest,
  prepareCaptureAttempt,
  skipUnchangedImageCapture,
  type SourceHostPacingMode,
} from "./source-evidence-capture";
import { type CollectionWorkflowAttempt, parseEvidencePlans } from "./source-evidence-model";
import {
  type EvidenceRequestRow,
  isCurrentCollectionWorkflowAttempt,
  requiredEvidenceRun,
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
// Pacing (#389): the host's adaptive state (interval, concurrency, streak,
// next-request deadline) is persisted the moment each fetch completes
// (`HostPacer.completed`) and the wait runs in-process against that persisted
// deadline, so a replay or replacement shard honours the same politeness
// floor. A page host settles each request before the next; an asset host
// keeps up to its current concurrency in flight within the batch.
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
  database: CatalogueStore;
  evidenceObjects: R2Bucket;
  officialSourceTransport: Fetcher;
  runId: string;
  workflowAttempt?: CollectionWorkflowAttempt;
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

export async function collectSourceRequestBatch(input: SourceRequestBatchInput): Promise<SourceRequestBatchOutcome> {
  const startedAt = Date.now();
  const timeBudget = input.timeBudgetMilliseconds ?? collectionBatchTimeBudgetMilliseconds;
  const wait = input.wait ?? defaultWait;
  let persistence: Promise<void> = Promise.resolve();
  let persistenceFailure: { error: unknown } | null = null;
  const enqueuePersistence = (work: () => Promise<void>): void => {
    persistence = persistence.then(work);
    persistence.catch((error: unknown) => {
      persistenceFailure ??= { error };
    });
  };
  // Requests settle out of order when an asset host keeps several in flight;
  // `processed` is the settled prefix, and a halt records the earliest index
  // it affects. Every later request that already settled replays cheaply.
  const settled = input.requests.map(() => false);
  let halt: { index: number; value: SourceRequestBatchHalt } | null = null;
  const haltAt = (index: number, value: SourceRequestBatchHalt): void => {
    if (halt === null || index < halt.index) halt = { index, value };
  };
  const inFlight = new Set<Promise<void>>();
  let taskFailure: { error: unknown } | null = null;
  let loopFailure: { error: unknown } | null = null;
  try {
    const pacer = await HostPacer.load(
      input.database,
      input.runId,
      resolveHostPacingPolicy(
        input.hostname,
        parseEvidencePlans((await requiredEvidenceRun(input.database, input.runId)).request_plan_json).map(
          (plan) => plan.adapter_version,
        ),
        input.pacingIntervalMilliseconds,
      ),
      input.pacingMode,
    );
    for (const [index, request] of input.requests.entries()) {
      if (persistenceFailure !== null || taskFailure !== null || halt !== null) break;
      if (index > 0 && Date.now() - startedAt > timeBudget) {
        haltAt(index, { kind: "time_budget" });
        break;
      }
      const run = await requiredEvidenceRun(input.database, input.runId);
      if (run.state !== "collecting" || !(await ownsCollectionAttempt(input))) {
        haltAt(index, { kind: "run_not_collecting" });
        break;
      }
      const prepared = await prepareCaptureAttempt(input.database, run, request);
      if (prepared.kind === "done") {
        settled[index] = true;
        continue;
      }
      if (prepared.kind === "captured") {
        const snapshotId = prepared.source_snapshot_id;
        enqueuePersistence(() =>
          persistCapturedRequest(input, request, {
            kind: "captured",
            source_snapshot_id: snapshotId,
            request_made: false,
          }),
        );
        settled[index] = true;
        continue;
      }
      // An unchanged Printing Image reuses its retained bytes without a
      // dispatch, so it neither waits for nor advances host pacing.
      const skipped = await skipUnchangedImageCapture(input.database, run, request, prepared);
      if (skipped !== null) {
        const attemptId = prepared.attempt_id;
        enqueuePersistence(() =>
          persistCapturedRequest(input, request, { kind: "uploaded", attempt_id: attemptId, request_made: false }),
        );
        settled[index] = true;
        continue;
      }
      while (inFlight.size >= pacer.concurrency) await Promise.race(inFlight);
      if (taskFailure !== null || halt !== null) break;
      const pacingDelay = pacer.startDelay();
      if (pacingDelay > 0) await wait(pacingDelay);
      // A pacing wait can span pause and resume; never reuse its earlier
      // state/identity observation to admit the next Official Source fetch.
      if (
        !(await ownsCollectionAttempt(input)) ||
        (await requiredEvidenceRun(input.database, input.runId)).state !== "collecting"
      ) {
        haltAt(index, { kind: "run_not_collecting" });
        break;
      }
      pacer.started();
      const task = (async () => {
        let signal: HostPacingSignal | null = null;
        const result = await capturePreparedAttempt(
          input.database,
          input.evidenceObjects,
          input.officialSourceTransport,
          run,
          request,
          prepared,
          input.workflowAttempt,
          (observed) => {
            signal = observed;
          },
        );
        if (result.request_made) {
          // Persisted before anything else so a replay after a crash here
          // still honours the adapted interval and deadline.
          await pacer.completed(signal, { requestId: request.request_id, attemptId: prepared.attempt_id });
        }
        if (result.kind === "wait") {
          haltAt(index, { kind: "retry_wait", request_id: request.request_id, wait_ms: result.wait_ms });
          return;
        }
        if (result.kind !== "done") enqueuePersistence(() => persistCapturedRequest(input, request, result));
        settled[index] = true;
      })();
      const tracked: Promise<void> = task
        .catch((error: unknown) => {
          taskFailure ??= { error };
        })
        .finally(() => inFlight.delete(tracked));
      inFlight.add(tracked);
      // A sequential host settles each request before admitting the next.
      if (pacer.concurrency === 1) await tracked;
    }
  } catch (error) {
    loopFailure = { error };
  }
  await Promise.all(inFlight);
  try {
    await persistence;
  } catch (error) {
    if (loopFailure === null && taskFailure === null) throw error;
  }
  if (loopFailure !== null) throw loopFailure.error;
  if (taskFailure !== null) throw (taskFailure as { error: unknown }).error;
  const unsettled = settled.indexOf(false);
  const processed = unsettled === -1 ? settled.length : unsettled;
  const finalHalt = halt as { index: number; value: SourceRequestBatchHalt } | null;
  return { processed, halt: finalHalt !== null && finalHalt.index <= processed ? finalHalt.value : null };
}

// Commit an uploaded capture and parse the captured Source Snapshot. Each
// stage re-reads the run so a pause that landed after the fetch leaves the
// staged state for the resumed attempt instead of advancing past it.
async function persistCapturedRequest(
  input: SourceRequestBatchInput,
  request: EvidenceRequestRow,
  fetched: Extract<CaptureTransportResult, { kind: "uploaded" | "captured" }>,
): Promise<void> {
  if (!(await ownsCollectionAttempt(input))) return;
  let result: CaptureTransportResult = fetched;
  if (result.kind === "uploaded") {
    result = await completeUploadedCapture(
      input.database,
      await requiredEvidenceRun(input.database, input.runId),
      request,
      result.attempt_id,
    );
  }
  if (result.kind === "captured" && (await ownsCollectionAttempt(input))) {
    await parseCapturedRequest(
      input.database,
      input.evidenceObjects,
      await requiredEvidenceRun(input.database, input.runId),
      request,
      result.source_snapshot_id,
      input.workflowAttempt,
    );
  }
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function ownsCollectionAttempt(input: SourceRequestBatchInput): Promise<boolean> {
  return (
    input.workflowAttempt === undefined ||
    isCurrentCollectionWorkflowAttempt(
      input.database,
      input.runId,
      input.workflowAttempt.parentId,
      input.workflowAttempt.instanceId,
    )
  );
}
