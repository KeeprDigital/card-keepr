import { snapshotRecoveryWait } from "./snapshot-recovery-wait";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { installedSourceAdapterRegistrations, requiredSourceAdapter } from "../../../src/catalogue/adapters";
import {
  type CatalogueStore,
  canonicalJson,
  catalogueStore,
  isWorkflowInstanceNotFound,
  observeWorkflowProgress,
  sha256,
  utf8,
  type WorkflowStatus,
  workflowDriver,
  workflowStepName,
  workflowSteps,
} from "../../../src/catalogue/shared";
import {
  collectionBarrierSleepDuration,
  collectionBatchSize,
  collectSourceRequestBatch,
  type EvidenceHostWorkflowParams,
  type EvidenceParentWorkflowParams,
  type EvidenceRequestRow,
  failActiveEvidenceRequestsForWorkflowExhaustion,
  finalizeEvidenceRun,
  isCurrentCollectionWorkflowAttempt,
  pendingEvidenceRequestPage,
  recordIngestionWorkflowProgress,
  recordWorkflowIds,
  requiredEvidenceRun,
  sourceHostPacingIntervalMilliseconds,
  sourceHostPacingMode,
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
const hostShardRequestCapacity = 200;
// One stable hostname identity plus three replacement identities exceeds the
// deepest discovery chain while placing a hard ceiling on durable recovery.
const maximumHostWorkflowIdentities = 4;

type HostShard = Readonly<{
  hostname: string;
  minimumSequenceNumber: number;
  maximumSequenceNumber: number;
  pendingRequestCount?: number;
}>;

export class EvidenceIngestionWorkflow extends WorkflowEntrypoint<Env, EvidenceParentWorkflowParams> {
  override async run(
    event: Readonly<WorkflowEvent<EvidenceParentWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<unknown> {
    try {
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
      for (;;) {
        const pendingShards = await loadPendingHostShards(
          step,
          catalogueStore(this.env.CATALOGUE_DB),
          runId,
          barrierStage,
        );
        const pendingChildren = await Promise.all(
          pendingShards.map(async (shard) => ({
            ...shard,
            id: await evidenceHostWorkflowId(runId, shard),
          })),
        );
        const activeChildren = [
          ...pendingChildren
            .reduce((byHostname, child) => {
              if (!byHostname.has(child.hostname)) {
                byHostname.set(child.hostname, child);
              }
              return byHostname;
            }, new Map<string, (typeof pendingChildren)[number]>())
            .values(),
        ];
        const shardDepths = new Map<string, number>();
        for (const child of pendingChildren) {
          shardDepths.set(child.hostname, (shardDepths.get(child.hostname) ?? 0) + 1);
        }
        const maximumShardDepth = Math.max(0, ...shardDepths.values());
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
                  .sort((left, right) => childAttempt(left) - childAttempt(right));
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
                  if (attempts.length >= maximumHostWorkflowIdentities) {
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
                    id: nextChildWorkflowIdentity(child.id, attempts),
                  });
                  continue;
                }
                if (!(await stillCurrent())) return [];
                const inheritedChild =
                  barrierStage === 0 && event.instanceId !== `evidence-${runId}` && retainedChildIds.includes(latestId);
                if (
                  inheritedChild ||
                  status.status === "complete" ||
                  status.status === "errored" ||
                  status.status === "terminated"
                ) {
                  if (attempts.length >= maximumHostWorkflowIdentities) {
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
                    id: nextChildWorkflowIdentity(child.id, attempts),
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
        for (const child of pendingChildren) allChildIds.add(child.id);
        for (const id of selectedChildIds) allChildIds.add(id);
        const recordedChildIds = [...allChildIds].sort();
        await step.do(
          workflowStepName(workflowSteps.parent.record, { stage: barrierStage }),
          deterministicDatabaseStep,
          async () => {
            await recordWorkflowIds(catalogueStore(this.env.CATALOGUE_DB), runId, event.instanceId, recordedChildIds);
            return recordedChildIds;
          },
        );
        const run = await step.do(
          workflowStepName(workflowSteps.parent.finalize, { stage: barrierStage }),
          deterministicDatabaseStep,
          async () => {
            await finalizeEvidenceRun(catalogueStore(this.env.CATALOGUE_DB), runId);
            return requiredEvidenceRun(catalogueStore(this.env.CATALOGUE_DB), runId);
          },
        );
        if (run.state === "collecting") {
          await step.sleep(
            workflowStepName(workflowSteps.parent.wait, { stage: barrierStage }),
            collectionBarrierSleepDuration(maximumShardDepth, maximumActiveRequestCount),
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
      if (games.length > 5) throw new Error("Collection selected too many Supported Games.");
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
function childAttempt(id: string): number {
  const value = id.match(/-attempt-(\d+)$/u)?.[1];
  return value === undefined ? 0 : Number.parseInt(value, 10) + 1;
}

function isChildWorkflowIdentity(baseId: string, id: string): boolean {
  if (id === baseId) return true;
  if (!id.startsWith(`${baseId}-attempt-`)) return false;
  return /^(?:0|[1-9]\d*)$/u.test(id.slice(`${baseId}-attempt-`.length));
}

function nextChildWorkflowIdentity(baseId: string, attempts: readonly string[]): string {
  const attemptNumber = Math.max(...attempts.map(childAttempt));
  return `${baseId}-attempt-${attemptNumber}`;
}

async function loadPendingHostShards(
  step: WorkflowStep,
  database: CatalogueStore,
  runId: string,
  barrierStage: number,
): Promise<HostShard[]> {
  const shards = new Map<string, HostShard>();
  let afterSequenceNumber = -1;
  let pageNumber = 0;
  for (;;) {
    const page = await step.do(
      workflowStepName(workflowSteps.parent.pending, { page: pageNumber, stage: barrierStage }),
      deterministicDatabaseStep,
      () =>
        pendingEvidenceRequestPage(
          database,
          runId,
          afterSequenceNumber,
          Number.MAX_SAFE_INTEGER,
          workflowRequestPageSize,
        ),
    );
    for (const request of page) {
      const minimumSequenceNumber =
        Math.floor(request.sequence_number / hostShardRequestCapacity) * hostShardRequestCapacity;
      const shardKey = `${new URL(request.url).hostname}\u0000${minimumSequenceNumber}`;
      const prior = shards.get(shardKey);
      const shard: HostShard = {
        hostname: new URL(request.url).hostname,
        minimumSequenceNumber,
        maximumSequenceNumber: minimumSequenceNumber + hostShardRequestCapacity - 1,
        pendingRequestCount: (prior?.pendingRequestCount ?? 0) + 1,
      };
      shards.set(shardKey, shard);
    }
    if (page.length < workflowRequestPageSize) break;
    afterSequenceNumber = page.at(-1)!.sequence_number;
    pageNumber += 1;
  }
  return [...shards.values()].sort(
    (left, right) =>
      left.minimumSequenceNumber - right.minimumSequenceNumber || left.hostname.localeCompare(right.hostname),
  );
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
