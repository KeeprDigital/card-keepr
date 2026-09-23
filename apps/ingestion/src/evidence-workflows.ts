import { snapshotRecoveryWait } from "./snapshot-recovery-wait";
import {
  boundedWorkflowInvocation,
  workflowInvocationStepBudget,
  workflowWaitMode,
} from "./workflow-invocation-budget";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { installedSourceAdapterRegistrations, requiredSourceAdapter } from "../../../src/catalogue/adapters";
import {
  type CatalogueStore,
  canonicalJson,
  catalogueStore,
  registeredSupportedGames,
  isWorkflowInstanceNotFound,
  observeWorkflowProgress,
  sha256,
  utf8,
  type WorkflowStatus,
  workflowAttemptSettled,
  workflowDriver,
  workflowStepName,
  workflowSteps,
} from "../../../src/catalogue/shared";
import {
  type ChildWorkflowSuccession,
  childWorkflowSuccession,
  childWorkflowSuccessorId,
  classifyCollectionBarrier,
  collectionBarrierFacts,
  collectionBarrierWaitMilliseconds,
  collectionBatchSize,
  collectSourceRequestBatch,
  type EvidenceHostWorkflowParams,
  type EvidenceParentWorkflowParams,
  type EvidenceRequestRow,
  failActiveEvidenceRequestsForWorkflowExhaustion,
  finalizeEvidenceRun,
  isCurrentCollectionWorkflowAttempt,
  pauseEvidenceRunForWorkflowRecovery,
  pendingEvidenceRequestPage,
  pendingEvidenceHostShards,
  evidenceHostShardRequestCapacity,
  settleTerminalOwnerDispatches,
  recordIngestionWorkflowProgress,
  recordWorkflowIds,
  requiredEvidenceRun,
  sourceHostPacingIntervalMilliseconds,
  sourceHostPacingMode,
  strandedCollectionWork,
  workflowAttemptStatements,
} from "../../../src/catalogue/source-evidence";
import { observeOperationalWorkflow } from "../../../src/http/operational-log";
import { fenceCollectionWorkflow, isSupersededCollectionWorkflow } from "./collection-workflow-fence";
import { runReconciliationWorkUnits } from "./reconciliation-workflow";
import { prepareCollectedGame } from "../../../src/catalogue/reconciliation";

const deterministicDatabaseStep = {
  retries: { limit: 3, delay: 250, backoff: "exponential" as const },
  timeout: "1 minute" as const,
};

// One batch step covers up to `collectionBatchSize` fetches with their
// pacing waits and persistence; the batch's own time budget (see
// source-evidence-batch.ts) keeps it well inside this timeout.
const collectionBatchStep = {
  retries: { limit: 3, delay: 500, backoff: "exponential" as const },
  timeout: "10 minutes" as const,
};

// A page remains far below the 1 MiB non-stream Workflow step-result limit.
// A 200-request child remains safely below the default 10,000 paid-step limit
// even when every request consumes every capture attempt: steady-state
// collection costs one durable step per `collectionBatchSize` requests, and
// only a retry wait adds a durable sleep plus a fresh batch step.
const workflowRequestPageSize = 100;
const hostShardRequestCapacity = evidenceHostShardRequestCapacity;
// One stable hostname identity plus three replacement identities exceeds the
// deepest discovery chain while placing a hard ceiling on durable recovery.
// Only a replacement — a successor for an instance that did not finish
// normally — spends one. A shard whose instance drained its window and
// returned is healthy, and later discovery admitting new Source Requests into
// that same sequence window continues it instead (#445).
const maximumHostWorkflowIdentities = 4;
const maximumHostWorkflowReplacements = maximumHostWorkflowIdentities - 1;

type HostShard = Readonly<{
  hostname: string;
  minimumSequenceNumber: number;
  maximumSequenceNumber: number;
  pendingRequestCount?: number;
  pendingShardCount?: number;
}>;

export class EvidenceIngestionWorkflow extends WorkflowEntrypoint<Env, EvidenceParentWorkflowParams> {
  override async run(
    event: Readonly<WorkflowEvent<EvidenceParentWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<unknown> {
    try {
      const waitMode = workflowWaitMode(this.env.WORKFLOW_WAIT_MODE);
      const invocation = boundedWorkflowInvocation(this.env, step, { mode: waitMode });
      this.env = invocation.env;
      step = invocation.step;
      const operational = observeOperationalWorkflow(snapshotRecoveryWait(this.env, step), event, this.env);
      this.env = operational.env;
      step = observeWorkflowProgress(operational.step, (progress) =>
        recordIngestionWorkflowProgress(
          catalogueStore(this.env.CATALOGUE_DB),
          event.payload.ingestion_run_id,
          event.instanceId,
          "parent",
          progress,
        ),
      );
      step = fenceCollectionWorkflow(
        step,
        catalogueStore(this.env.CATALOGUE_DB),
        event.payload.ingestion_run_id,
        event.instanceId,
        event.instanceId,
      );
      const runId = event.payload.ingestion_run_id;
      const retainedChildIds = await step.do(workflowSteps.parent.identities, deterministicDatabaseStep, async () => {
        const run = await requiredEvidenceRun(catalogueStore(this.env.CATALOGUE_DB), runId);
        const parsed: unknown = run.child_workflow_ids_json === null ? [] : JSON.parse(run.child_workflow_ids_json);
        return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
      });
      const allChildIds = new Set<string>(retainedChildIds);
      let barrierStage = 0;
      // Derived only from durable step results, so replay reproduces them.
      let previousShardSet: string | null = null,
        unchangedPolls = 0,
        previouslyRecorded: string | null = null,
        previousCensus: string | null = null,
        censusChangedAt: string | null = null;
      for (;;) {
        const pendingShards = await loadPendingHostShards(
          step,
          catalogueStore(this.env.CATALOGUE_DB),
          runId,
          barrierStage,
        );
        const activeChildren = await Promise.all(
          pendingShards.map(async (shard) => ({
            ...shard,
            id: await evidenceHostWorkflowId(runId, shard),
          })),
        );
        const shardSet = JSON.stringify(
          activeChildren.map((child) => [child.hostname, child.minimumSequenceNumber, child.maximumSequenceNumber]),
        );
        unchangedPolls = shardSet === previousShardSet ? unchangedPolls + 1 : 0;
        previousShardSet = shardSet;
        const maximumShardDepth = Math.max(0, ...activeChildren.map((child) => child.pendingShardCount ?? 0));
        const maximumActiveRequestCount = Math.max(0, ...activeChildren.map((child) => child.pendingRequestCount ?? 0));
        let selectedChildIds: string[] = [];
        if (activeChildren.length > 0) {
          selectedChildIds = await step.do(
            workflowStepName(workflowSteps.parent.recover, { stage: barrierStage }),
            deterministicDatabaseStep,
            async () => {
              const stillCurrent = () =>
                isCurrentCollectionWorkflowAttempt(
                  catalogueStore(this.env.CATALOGUE_DB),
                  runId,
                  event.instanceId,
                  event.instanceId,
                );
              const selected: Array<(typeof activeChildren)[number]> = [];
              for (const child of activeChildren) {
                const attempts = [...allChildIds]
                  .filter((id) => isChildWorkflowIdentity(child.id, id))
                  .sort((left, right) => childSuccessor(left) - childSuccessor(right));
                const replacements = attempts.filter((id) => childWorkflowSuccession(id) === "replacement").length;
                const latestId = attempts.at(-1);
                if (latestId === undefined) {
                  selected.push(child);
                  continue;
                }
                let status: WorkflowStatus;
                try {
                  status = await workflowDriver(this.env.EVIDENCE_HOST_WORKFLOW).inspect(latestId);
                } catch (error) {
                  // Only a genuinely absent instance may burn one of the
                  // bounded replacement identities. A transient control-plane
                  // failure rethrows into the durable step's retry policy, and
                  // if that exhausts, the parent errors recoverably (a new
                  // Workflow Attempt through resume) instead of terminally
                  // failing the shard's Source Requests.
                  if (!isWorkflowInstanceNotFound(error)) throw error;
                  if (!(await stillCurrent())) return [];
                  if (replacements >= maximumHostWorkflowReplacements) {
                    await failActiveEvidenceRequestsForWorkflowExhaustion(
                      catalogueStore(this.env.CATALOGUE_DB),
                      runId,
                      {
                        hostname: child.hostname,
                        minimumSequenceNumber: child.minimumSequenceNumber,
                        maximumSequenceNumber: child.maximumSequenceNumber,
                      },
                    );
                    continue;
                  }
                  selected.push({
                    ...child,
                    id: nextChildWorkflowIdentity(child.id, attempts, "replacement"),
                  });
                  continue;
                }
                if (!(await stillCurrent())) return [];
                const inheritedChild =
                  barrierStage === 0 && event.instanceId !== `evidence-${runId}` && retainedChildIds.includes(latestId);
                if (inheritedChild || workflowAttemptSettled(status.status)) {
                  if (workflowAttemptSettled(status.status)) {
                    // The finished attempt cannot complete a dispatch it still
                    // holds; an absent destination settles it so the
                    // replacement can reserve again instead of pausing.
                    await settleTerminalOwnerDispatches(
                      catalogueStore(this.env.CATALOGUE_DB),
                      this.env.EVIDENCE_OBJECTS,
                      runId,
                      async (instanceId) => instanceId === latestId,
                    );
                  }
                  // A shard that ran to normal completion drained every
                  // pending Source Request its sequence window held. The
                  // window showing pending work again is later discovery, not
                  // a failed attempt, so its successor continues the shard
                  // rather than spending one of the bounded replacements. An
                  // inherited child is taken over, not continued: this parent
                  // never observed it finish its own work.
                  const succession: ChildWorkflowSuccession =
                    !inheritedChild && status.status === "complete" ? "continuation" : "replacement";
                  if (succession === "replacement" && replacements >= maximumHostWorkflowReplacements) {
                    await failActiveEvidenceRequestsForWorkflowExhaustion(
                      catalogueStore(this.env.CATALOGUE_DB),
                      runId,
                      {
                        hostname: child.hostname,
                        minimumSequenceNumber: child.minimumSequenceNumber,
                        maximumSequenceNumber: child.maximumSequenceNumber,
                      },
                    );
                    continue;
                  }
                  selected.push({
                    ...child,
                    id: nextChildWorkflowIdentity(child.id, attempts, succession),
                  });
                } else {
                  if (status.status === "paused") {
                    await workflowDriver(this.env.EVIDENCE_HOST_WORKFLOW).resume(latestId);
                  }
                  selected.push({ ...child, id: latestId });
                }
              }
              // createBatch is idempotent for deterministic attempt IDs. A
              // request can be committed before child creation succeeds, so
              // each recovery pass closes that gap.
              for (let offset = 0; offset < selected.length; offset += 100) {
                const batch = selected.slice(offset, offset + 100);
                // Publish identities before dispatch: a child may execute its
                // first callback before createBatch returns to its parent.
                await catalogueStore(this.env.CATALOGUE_DB).batch(
                  workflowAttemptStatements(
                    catalogueStore(this.env.CATALOGUE_DB),
                    runId,
                    batch.map((child) => child.id),
                    event.instanceId,
                  ),
                );
                if (!(await stillCurrent())) return [];
                await workflowDriver(this.env.EVIDENCE_HOST_WORKFLOW).ensureBatch(
                  batch.map((child) => ({
                    id: child.id,
                    params: {
                      ingestion_run_id: runId,
                      parent_workflow_id: event.instanceId,
                      hostname: child.hostname,
                      minimum_sequence_number: child.minimumSequenceNumber,
                      maximum_sequence_number: child.maximumSequenceNumber,
                    },
                  })),
                );
              }
              return selected.map((child) => child.id);
            },
          );
        }
        for (const id of selectedChildIds) allChildIds.add(id);
        retireSupersededContinuations(allChildIds, selectedChildIds);
        const recordedChildIds = [...allChildIds].sort();
        // An unchanged identity set is already recorded; re-recording it on
        // every poll only spent a step and its subrequests.
        const recordedKey = JSON.stringify(recordedChildIds);
        if (recordedKey !== previouslyRecorded) {
          await step.do(
            workflowStepName(workflowSteps.parent.recordSummary, { stage: barrierStage }),
            deterministicDatabaseStep,
            async () => {
              await recordWorkflowIds(catalogueStore(this.env.CATALOGUE_DB), runId, event.instanceId, recordedChildIds);
              return { child_workflow_count: recordedChildIds.length };
            },
          );
          previouslyRecorded = recordedKey;
        }
        const { run, facts } = await step.do(
          workflowStepName(workflowSteps.parent.finalize, { stage: barrierStage }),
          deterministicDatabaseStep,
          async () => {
            await finalizeEvidenceRun(catalogueStore(this.env.CATALOGUE_DB), runId);
            return {
              run: await requiredEvidenceRun(catalogueStore(this.env.CATALOGUE_DB), runId),
              facts: await collectionBarrierFacts(catalogueStore(this.env.CATALOGUE_DB), runId),
            };
          },
        );
        if (run.state === "collecting") {
          // Liveness is judged from durable step results only, so a replay
          // reaches the same verdict: the census of this run's Source
          // Requests, and the work its current hostname shards recorded.
          const censusKey = `${facts.active_request_count}:${facts.settled_request_count}`;
          if (censusKey !== previousCensus) {
            previousCensus = censusKey;
            censusChangedAt = facts.observed_at;
          }
          const halt = classifyCollectionBarrier({
            barrierStage,
            activeRequestCount: facts.active_request_count,
            observedAtMs: Date.parse(facts.observed_at),
            quietSinceMs: Math.max(
              Date.parse(censusChangedAt ?? facts.observed_at),
              facts.shard_progress_at === null ? Number.NEGATIVE_INFINITY : Date.parse(facts.shard_progress_at),
            ),
            mode: waitMode,
          });
          if (halt !== null) {
            const stranded = await step.do(
              workflowStepName(workflowSteps.parent.halt, { stage: barrierStage }),
              deterministicDatabaseStep,
              async () => {
                const owed = await strandedCollectionWork(catalogueStore(this.env.CATALOGUE_DB), runId);
                await pauseEvidenceRunForWorkflowRecovery(catalogueStore(this.env.CATALOGUE_DB), runId, {
                  workflow_instance_id: event.instanceId,
                  pause_reason: halt.reason,
                  // This attempt is still running as it records why it stops.
                  workflow_status: "running",
                  last_progress_at: facts.shard_progress_at,
                  stranded: owed,
                });
                return owed;
              },
            );
            return {
              ingestion_run_id: runId,
              child_workflow_ids: [...allChildIds].sort(),
              state: "paused",
              paused: { reason: halt.reason, barrier_stage: barrierStage, stranded },
            };
          }
          await step.sleep(
            workflowStepName(workflowSteps.parent.wait, { stage: barrierStage }),
            collectionBarrierWaitMilliseconds({
              maximumShardDepth,
              maximumActiveRequestCount,
              unchangedPolls,
              mode: waitMode,
            }),
          );
          barrierStage += 1;
          continue;
        }
        if (
          run.state === "parsing" &&
          run.plan_origin === "production" &&
          (requiredSourceAdapter(run.adapter_version).reconciliationCapability === "catalogue" ||
            installedSourceAdapterRegistrations.some(
              (adapter) =>
                adapter.adapterVersion === run.adapter_version && adapter.reconciliationCapability === "errata",
            ))
        ) {
          return await this.prepareCollectedEvidence(event, step, run);
        }
        return {
          ingestion_run_id: runId,
          child_workflow_ids: [...allChildIds].sort(),
          state: run.state,
        };
      }
    } catch (error) {
      if (!isSupersededCollectionWorkflow(error)) throw error;
      return { ingestion_run_id: event.payload.ingestion_run_id, superseded: true };
    }
  }
  protected async prepareCollectedEvidence(
    event: Readonly<WorkflowEvent<EvidenceParentWorkflowParams>>,
    step: WorkflowStep,
    run: Awaited<ReturnType<typeof requiredEvidenceRun>>,
  ): Promise<unknown> {
    const runId = run.id;
    const games = JSON.parse(run.selected_games_json) as string[];
    const adapter = requiredSourceAdapter(run.adapter_version);
    if (
      games.length > 1 ||
      installedSourceAdapterRegistrations.some(
        (registration) => registration.adapterVersion === adapter.adapterVersion,
      ) ||
      adapter.officialSourceContract ||
      adapter.reconciliationCapability === "errata"
    ) {
      if (games.length > registeredSupportedGames().length)
        throw new Error("Collection selected too many Supported Games.");
      const preparations: Awaited<ReturnType<typeof prepareCollectedGame>>[] = [];
      for (const game of [...games].sort()) {
        const prepared = await step.do(
          workflowStepName(workflowSteps.parent.prepareGame, { game }),
          deterministicDatabaseStep,
          () =>
            prepareCollectedGame(
              catalogueStore(this.env.CATALOGUE_DB),
              this.env.RECONCILIATION_WORKFLOW,
              runId,
              game,
              new Date().toISOString(),
            ),
        );
        preparations.push(prepared);
      }
      return { ingestion_run_id: runId, game_preparations: preparations };
    }

    return this.reconcileCollectedEvidence(event, step, run);
  }

  protected async reconcileCollectedEvidence(
    event: Readonly<WorkflowEvent<EvidenceParentWorkflowParams>>,
    step: WorkflowStep,
    run: Awaited<ReturnType<typeof requiredEvidenceRun>>,
  ): Promise<unknown> {
    const runId = run.id;
    const reconciliationResultJson = await runReconciliationWorkUnits(
      this.env,
      step,
      {
        ingestion_run_id: runId,
        observed_at: run.collection_completed_at ?? new Date().toISOString(),
        expected_current_revision_id: run.expected_current_revision_id,
        idempotency_key: `collection-${event.instanceId}`,
      },
      workflowSteps.parent.reconcile,
      { binding: "collection", id: event.instanceId },
    );
    return {
      ingestion_run_id: runId,
      reconciliation: JSON.parse(reconciliationResultJson),
    };
  }
}

// Shards of one hostname run sequentially, so a deep multi-shard collection
// waits on the barrier for whole shard durations; a minute of poll slack per
// stage keeps the parent under its step budget without dominating wall clock.
/** Position in a shard's single successor sequence; the base identity is 0. */
function childSuccessor(id: string): number {
  const value = id.match(/-(?:attempt|continue)-(\d+)$/u)?.[1];
  return value === undefined ? 0 : Number.parseInt(value, 10) + 1;
}

function isChildWorkflowIdentity(baseId: string, id: string): boolean {
  if (id === baseId) return true;
  for (const suffix of ["-attempt-", "-continue-"]) {
    if (!id.startsWith(`${baseId}${suffix}`)) continue;
    if (/^(?:0|[1-9]\d*)$/u.test(id.slice(`${baseId}${suffix}`.length))) return true;
  }
  return false;
}

function nextChildWorkflowIdentity(
  baseId: string,
  attempts: readonly string[],
  succession: ChildWorkflowSuccession,
): string {
  return childWorkflowSuccessorId(baseId, Math.max(...attempts.map(childSuccessor)), succession);
}

/**
 * Drop the continuations a newly selected continuation supersedes.
 *
 * A shard that later discovery keeps feeding is continued for as long as the
 * collection runs, so retaining every continuation would grow the run's
 * retained identity list without bound. Only the shard's replacements carry
 * its bounded recovery budget and must stay; the complete history of every
 * identity is the append-only Workflow Attempt record in D1 (#445).
 */
function retireSupersededContinuations(retained: Set<string>, selected: readonly string[]): void {
  for (const id of selected) {
    if (childWorkflowSuccession(id) !== "continuation") continue;
    const baseId = id.slice(0, id.lastIndexOf("-continue-"));
    for (const other of [...retained])
      if (other !== id && childWorkflowSuccession(other) === "continuation" && isChildWorkflowIdentity(baseId, other))
        retained.delete(other);
  }
}

async function loadPendingHostShards(
  step: WorkflowStep,
  database: CatalogueStore,
  runId: string,
  barrierStage: number,
): Promise<HostShard[]> {
  const shards = await step.do(
    workflowStepName(workflowSteps.parent.shards, { stage: barrierStage }),
    deterministicDatabaseStep,
    () => pendingEvidenceHostShards(database, runId),
  );
  return shards.map((shard) => ({
    hostname: shard.hostname,
    minimumSequenceNumber: shard.minimum_sequence_number,
    maximumSequenceNumber: shard.minimum_sequence_number + hostShardRequestCapacity - 1,
    pendingRequestCount: shard.pending_request_count,
    pendingShardCount: shard.pending_shard_count,
  }));
}

async function loadPendingShardRequests(
  step: WorkflowStep,
  database: CatalogueStore,
  runId: string,
  shard: HostShard,
  stage: number,
  purpose = "load",
): Promise<EvidenceRequestRow[]> {
  const requests: EvidenceRequestRow[] = [];
  let afterSequenceNumber = shard.minimumSequenceNumber - 1;
  let pageNumber = 0;
  for (;;) {
    const page = await step.do(
      workflowStepName(workflowSteps.child.pending, { purpose, page: pageNumber, stage }),
      deterministicDatabaseStep,
      () =>
        pendingEvidenceRequestPage(
          database,
          runId,
          afterSequenceNumber,
          shard.maximumSequenceNumber,
          workflowRequestPageSize,
        ),
    );
    requests.push(...page.filter((request) => new URL(request.url).hostname === shard.hostname));
    if (page.length < workflowRequestPageSize) break;
    afterSequenceNumber = page.at(-1)!.sequence_number;
    pageNumber += 1;
  }
  return requests;
}

async function evidenceHostWorkflowId(runId: string, shard: HostShard): Promise<string> {
  const digest = await sha256(
    utf8(
      canonicalJson({
        ingestion_run_id: runId,
        hostname: shard.hostname,
        minimum_sequence_number: shard.minimumSequenceNumber,
        maximum_sequence_number: shard.maximumSequenceNumber,
      }),
    ),
  );
  return `evidence-host-${digest}`;
}

export class EvidenceHostWorkflow extends WorkflowEntrypoint<Env, EvidenceHostWorkflowParams> {
  override async run(event: Readonly<WorkflowEvent<EvidenceHostWorkflowParams>>, step: WorkflowStep): Promise<unknown> {
    try {
      const waitMode = workflowWaitMode(this.env.WORKFLOW_WAIT_MODE);
      // This shard runs the archive steps, which spend their bound inflating
      // and hashing in the isolate rather than on bindings, so its engine
      // lifetime needs a step bound as well as a subrequest one (#327).
      const invocation = boundedWorkflowInvocation(this.env, step, {
        mode: waitMode,
        steps: workflowInvocationStepBudget,
      });
      this.env = invocation.env;
      step = invocation.step;
      const operational = observeOperationalWorkflow(snapshotRecoveryWait(this.env, step), event, this.env);
      this.env = operational.env;
      step = observeWorkflowProgress(operational.step, (progress) =>
        recordIngestionWorkflowProgress(
          catalogueStore(this.env.CATALOGUE_DB),
          event.payload.ingestion_run_id,
          event.instanceId,
          "child",
          progress,
        ),
      );
      step = fenceCollectionWorkflow(
        step,
        catalogueStore(this.env.CATALOGUE_DB),
        event.payload.ingestion_run_id,
        event.payload.parent_workflow_id,
        event.instanceId,
      );
      const {
        ingestion_run_id: runId,
        hostname,
        minimum_sequence_number: minimumSequenceNumber,
        maximum_sequence_number: maximumSequenceNumber,
      } = event.payload;
      // Fails closed on unrecognized values before any capture work begins.
      const pacingMode = sourceHostPacingMode(this.env.SOURCE_HOST_PACING_MODE);
      const pacingIntervalMilliseconds = sourceHostPacingIntervalMilliseconds(this.env.SOURCE_HOST_PACING_INTERVAL_MS);
      let stage = 0;
      for (;;) {
        // Only a collecting run has work for this shard. A run that left its
        // collection phase (a Workflow, Capacity, or Retry Pause, a Collection
        // Termination, or a failure recorded by another shard) keeps its
        // pending and captured Source Requests, so this shard would otherwise
        // reload them forever without a sleep; the run-state gate lets the
        // child Workflow finish while the retained work awaits the owner or
        // stays as audit evidence.
        const runState = await step.do(
          workflowStepName(workflowSteps.child.state, { stage }),
          deterministicDatabaseStep,
          async () => (await requiredEvidenceRun(catalogueStore(this.env.CATALOGUE_DB), runId)).state,
        );
        if (runState !== "collecting") break;
        const requests = await loadPendingShardRequests(
          step,
          catalogueStore(this.env.CATALOGUE_DB),
          runId,
          { hostname, minimumSequenceNumber, maximumSequenceNumber },
          stage,
        );
        // Batches persist through one durable step each; see the step-layout
        // note in source-evidence-batch.ts for what stays a separate step.
        let halted = false;
        for (let offset = 0; offset < requests.length && !halted; offset += collectionBatchSize) {
          const batch = requests.slice(offset, offset + collectionBatchSize);
          let cursor = 0;
          let pass = 0;
          while (cursor < batch.length) {
            const remaining = batch.slice(cursor);
            const outcome = await step.do(
              workflowStepName(workflowSteps.child.collect, { stage, offset, cursor, pass }),
              collectionBatchStep,
              () =>
                collectSourceRequestBatch({
                  database: catalogueStore(this.env.CATALOGUE_DB),
                  evidenceObjects: this.env.EVIDENCE_OBJECTS,
                  officialSourceTransport: this.env.OFFICIAL_SOURCE_TRANSPORT,
                  runId,
                  workflowAttempt: { parentId: event.payload.parent_workflow_id, instanceId: event.instanceId },
                  hostname,
                  pacingMode,
                  pacingIntervalMilliseconds,
                  requests: remaining,
                }),
            );
            pass += 1;
            cursor += outcome.processed;
            if (outcome.halt === null) continue;
            if (outcome.halt.kind === "run_not_collecting") {
              halted = true;
              break;
            }
            if (outcome.halt.kind === "retry_wait" && outcome.halt.wait_ms > 0) {
              await step.sleep(
                workflowStepName(workflowSteps.child.retry, { request: outcome.halt.request_id, pass }),
                outcome.halt.wait_ms,
              );
            }
          }
        }
        // A batch halted by the run leaving its collection phase must not
        // reload the untouched requests into another stage: the next stage's
        // run-state gate would stop it anyway, but only after more steps.
        if (halted) break;
        const localPending = await loadPendingShardRequests(
          step,
          catalogueStore(this.env.CATALOGUE_DB),
          runId,
          { hostname, minimumSequenceNumber, maximumSequenceNumber },
          stage,
          "reload",
        );
        if (localPending.length > 0) {
          stage += 1;
          continue;
        }
        break;
      }
      return {
        ingestion_run_id: runId,
        hostname,
        minimum_sequence_number: minimumSequenceNumber,
        maximum_sequence_number: maximumSequenceNumber,
      };
    } catch (error) {
      if (!isSupersededCollectionWorkflow(error)) throw error;
      return { ingestion_run_id: event.payload.ingestion_run_id, superseded: true };
    }
  }
}
