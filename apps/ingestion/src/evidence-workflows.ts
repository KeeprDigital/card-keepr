import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  sourceHostPacingIntervalMilliseconds,
  sourceHostPacingMode,
} from "../../../src/catalogue/source-evidence-capture";
import { collectSourceRequestBatch, collectionBatchSize } from "../../../src/catalogue/source-evidence-batch";
import {
  type EvidenceHostWorkflowParams,
  type EvidenceParentWorkflowParams,
} from "../../../src/catalogue/source-evidence-model";
import {
  failActiveEvidenceRequestsForWorkflowExhaustion,
  finalizeEvidenceRun,
  pendingEvidenceRequestPage,
  recordWorkflowIds,
  requiredEvidenceRun,
  type EvidenceRequestRow,
} from "../../../src/catalogue/source-evidence-repository";
import { reconcileRetainedCardPrintingEvidence } from "../../../src/catalogue/reconciliation";
import { canonicalJson, sha256, utf8 } from "../../../src/catalogue/shared";
import { collectionBarrierSleepDuration, isWorkflowInstanceNotFound } from "../../../src/catalogue/collection-recovery";
import { requiredSourceAdapter } from "../../../src/catalogue/adapters";
import { durableReconciliationResult } from "./reconciliation-workflow";
import { observeOperationalWorkflow } from "../../../src/http/operational-log";

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
    const operational = observeOperationalWorkflow(step, event, this.env);
    this.env = operational.env;
    step = operational.step;
    const runId = event.payload.ingestion_run_id;
    const retainedChildIds = await step.do(
      "load retained hostname Workflow identities",
      deterministicDatabaseStep,
      async () => {
        const run = await requiredEvidenceRun(this.env.CATALOGUE_DB, runId);
        const parsed: unknown = run.child_workflow_ids_json === null ? [] : JSON.parse(run.child_workflow_ids_json);
        return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
      },
    );
    const allChildIds = new Set<string>(retainedChildIds);
    let barrierStage = 0;
    for (;;) {
      const pendingShards = await loadPendingHostShards(step, this.env.CATALOGUE_DB, runId, `barrier ${barrierStage}`);
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
          `recover pending hostname workflows stage ${barrierStage}`,
          deterministicDatabaseStep,
          async () => {
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
              let latest;
              let status;
              try {
                latest = await this.env.EVIDENCE_HOST_WORKFLOW.get(latestId);
                status = await latest.status();
              } catch (error) {
                // Only a genuinely absent instance may burn one of the
                // bounded replacement identities. A transient control-plane
                // failure rethrows into the durable step's retry policy, and
                // if that exhausts, the parent errors recoverably (a new
                // Workflow Attempt through resume) instead of terminally
                // failing the shard's Source Requests.
                if (!isWorkflowInstanceNotFound(error)) throw error;
                if (attempts.length >= maximumHostWorkflowIdentities) {
                  await failActiveEvidenceRequestsForWorkflowExhaustion(this.env.CATALOGUE_DB, runId, {
                    hostname: child.hostname,
                    minimumSequenceNumber: child.minimumSequenceNumber,
                    maximumSequenceNumber: child.maximumSequenceNumber,
                  });
                  continue;
                }
                selected.push({
                  ...child,
                  id: nextChildWorkflowIdentity(child.id, attempts),
                });
                continue;
              }
              if (status.status === "complete" || status.status === "errored" || status.status === "terminated") {
                if (attempts.length >= maximumHostWorkflowIdentities) {
                  await failActiveEvidenceRequestsForWorkflowExhaustion(this.env.CATALOGUE_DB, runId, {
                    hostname: child.hostname,
                    minimumSequenceNumber: child.minimumSequenceNumber,
                    maximumSequenceNumber: child.maximumSequenceNumber,
                  });
                  continue;
                }
                selected.push({
                  ...child,
                  id: nextChildWorkflowIdentity(child.id, attempts),
                });
              } else {
                if (status.status === "paused") {
                  await latest.resume();
                }
                selected.push({ ...child, id: latestId });
              }
            }
            // createBatch is idempotent for deterministic attempt IDs. A
            // request can be committed before child creation succeeds, so
            // each recovery pass closes that gap.
            for (let offset = 0; offset < selected.length; offset += 100) {
              const batch = selected.slice(offset, offset + 100);
              await this.env.EVIDENCE_HOST_WORKFLOW.createBatch(
                batch.map((child) => ({
                  id: child.id,
                  params: {
                    ingestion_run_id: runId,
                    hostname: child.hostname,
                    minimum_sequence_number: child.minimumSequenceNumber,
                    maximum_sequence_number: child.maximumSequenceNumber,
                  },
                })),
              );
              const children = await Promise.all(batch.map((child) => this.env.EVIDENCE_HOST_WORKFLOW.get(child.id)));
              for (const child of children) {
                const status = await child.status();
                if (status.status === "paused") {
                  await child.resume();
                }
              }
            }
            return selected.map((child) => child.id);
          },
        );
      }
      for (const child of pendingChildren) allChildIds.add(child.id);
      for (const id of selectedChildIds) allChildIds.add(id);
      const recordedChildIds = [...allChildIds].sort();
      await step.do(
        `record hostname Workflow identities stage ${barrierStage}`,
        deterministicDatabaseStep,
        async () => {
          await recordWorkflowIds(this.env.CATALOGUE_DB, runId, event.instanceId, recordedChildIds);
          return recordedChildIds;
        },
      );
      const run = await step.do(
        `finalize collection barrier stage ${barrierStage}`,
        deterministicDatabaseStep,
        async () => {
          await finalizeEvidenceRun(this.env.CATALOGUE_DB, runId);
          return requiredEvidenceRun(this.env.CATALOGUE_DB, runId);
        },
      );
      if (run.state === "collecting") {
        await step.sleep(
          `await collection barrier stage ${barrierStage}`,
          collectionBarrierSleepDuration(maximumShardDepth, maximumActiveRequestCount),
        );
        barrierStage += 1;
        continue;
      }
      if (
        run.state === "parsing" &&
        run.plan_origin === "production" &&
        requiredSourceAdapter(run.adapter_version).reconciliationCapability === "catalogue"
      ) {
        const reconciliationResultJson = await step.do(
          "reconcile retained Official Source evidence",
          deterministicDatabaseStep,
          async () => {
            const result = await reconcileRetainedCardPrintingEvidence(
              this.env.CATALOGUE_DB,
              this.env.EVIDENCE_OBJECTS,
              runId,
              run.collection_completed_at ?? new Date().toISOString(),
            );
            return durableReconciliationResult(runId, result);
          },
        );
        return {
          ingestion_run_id: runId,
          reconciliation: JSON.parse(reconciliationResultJson),
        };
      }
      return {
        ingestion_run_id: runId,
        child_workflow_ids: [...allChildIds].sort(),
        state: run.state,
      };
    }
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
  database: D1Database,
  runId: string,
  stepPrefix: string,
): Promise<HostShard[]> {
  const shards = new Map<string, HostShard>();
  let afterSequenceNumber = -1;
  let pageNumber = 0;
  for (;;) {
    const page = await step.do(
      `load pending evidence page ${pageNumber} ${stepPrefix}`,
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
  database: D1Database,
  runId: string,
  shard: HostShard,
  stage: number,
  purpose = "load",
): Promise<EvidenceRequestRow[]> {
  const requests: EvidenceRequestRow[] = [];
  let afterSequenceNumber = shard.minimumSequenceNumber - 1;
  let pageNumber = 0;
  for (;;) {
    const page = await step.do(`${purpose} shard page ${pageNumber} stage ${stage}`, deterministicDatabaseStep, () =>
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
    const operational = observeOperationalWorkflow(step, event, this.env);
    this.env = operational.env;
    step = operational.step;
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
        `read run state stage ${stage}`,
        deterministicDatabaseStep,
        async () => (await requiredEvidenceRun(this.env.CATALOGUE_DB, runId)).state,
      );
      if (runState !== "collecting") break;
      const requests = await loadPendingShardRequests(
        step,
        this.env.CATALOGUE_DB,
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
            `collect stage ${stage} batch ${offset} from ${cursor} pass ${pass}`,
            collectionBatchStep,
            () =>
              collectSourceRequestBatch({
                database: this.env.CATALOGUE_DB,
                evidenceObjects: this.env.EVIDENCE_OBJECTS,
                officialSourceTransport: this.env.OFFICIAL_SOURCE_TRANSPORT,
                runId,
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
            await step.sleep(`retry ${outcome.halt.request_id} pass ${pass}`, outcome.halt.wait_ms);
          }
        }
      }
      // A batch halted by the run leaving its collection phase must not
      // reload the untouched requests into another stage: the next stage's
      // run-state gate would stop it anyway, but only after more steps.
      if (halted) break;
      const localPending = await loadPendingShardRequests(
        step,
        this.env.CATALOGUE_DB,
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
  }
}
