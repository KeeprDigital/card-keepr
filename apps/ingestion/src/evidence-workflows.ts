import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import {
  advanceHostPacing,
  capturePreparedAttempt,
  completeUploadedCapture,
  hostPacingDelay,
  parseCapturedRequest,
  prepareCaptureAttempt,
  sourceHostPacingMode,
  type CaptureTransportResult,
  type PreparedCaptureAttempt,
} from "../../../src/catalogue/source-evidence-capture";
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
import {
  reconcileRetainedCardPrintingEvidence,
} from "../../../src/catalogue/card-printing-reconciliation";
import { canonicalJson, sha256, utf8 } from "../../../src/catalogue/serialization";
import {
  requiredSourceAdapter,
} from "../../../src/catalogue/source-adapters";
import { durableReconciliationResult } from "./reconciliation-workflow";
import { observeOperationalWorkflow } from "../../../src/http/operational-log";

const deterministicDatabaseStep = {
  retries: { limit: 3, delay: 250, backoff: "exponential" as const },
  timeout: "1 minute" as const,
};

const transportStep = {
  retries: { limit: 3, delay: 500, backoff: "exponential" as const },
  timeout: "10 minutes" as const,
};

// A page remains far below the 1 MiB non-stream Workflow step-result limit.
// A 200-request child remains safely below the default 10,000 paid-step limit
// even when every request consumes every capture attempt and parse step.
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

export class EvidenceIngestionWorkflow extends WorkflowEntrypoint<
  Env,
  EvidenceParentWorkflowParams
> {
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
        const parsed: unknown = run.child_workflow_ids_json === null
          ? []
          : JSON.parse(run.child_workflow_ids_json);
        return Array.isArray(parsed)
          ? parsed.filter((id): id is string => typeof id === "string")
          : [];
      },
    );
    const allChildIds = new Set<string>(retainedChildIds);
    let barrierStage = 0;
    for (;;) {
      const pendingShards = await loadPendingHostShards(
        step,
        this.env.CATALOGUE_DB,
        runId,
        `barrier ${barrierStage}`,
      );
      const pendingChildren = await Promise.all(pendingShards.map(
        async (shard) => ({
          ...shard,
          id: await evidenceHostWorkflowId(runId, shard),
        }),
      ));
      const activeChildren = [...pendingChildren.reduce(
        (byHostname, child) => {
          if (!byHostname.has(child.hostname)) {
            byHostname.set(child.hostname, child);
          }
          return byHostname;
        },
        new Map<string, (typeof pendingChildren)[number]>(),
      ).values()];
      const shardDepths = new Map<string, number>();
      for (const child of pendingChildren) {
        shardDepths.set(
          child.hostname,
          (shardDepths.get(child.hostname) ?? 0) + 1,
        );
      }
      const maximumShardDepth = Math.max(0, ...shardDepths.values());
      const maximumActiveRequestCount = Math.max(
        0,
        ...activeChildren.map((child) => child.pendingRequestCount ?? 0),
      );
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
              } catch {
                if (attempts.length >= maximumHostWorkflowIdentities) {
                  await failActiveEvidenceRequestsForWorkflowExhaustion(
                    this.env.CATALOGUE_DB,
                    runId,
                  );
                  return [];
                }
                selected.push({
                  ...child,
                  id: nextChildWorkflowIdentity(child.id, attempts),
                });
                continue;
              }
              if (
                status.status === "complete" ||
                status.status === "errored" ||
                status.status === "terminated"
              ) {
                if (attempts.length >= maximumHostWorkflowIdentities) {
                  await failActiveEvidenceRequestsForWorkflowExhaustion(
                    this.env.CATALOGUE_DB,
                    runId,
                  );
                  return [];
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
              const children = await Promise.all(
                batch.map((child) =>
                  this.env.EVIDENCE_HOST_WORKFLOW.get(child.id),
                ),
              );
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
          await recordWorkflowIds(
            this.env.CATALOGUE_DB,
            runId,
            event.instanceId,
            recordedChildIds,
          );
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
          maximumShardDepth > 1 && maximumActiveRequestCount > 10
            ? "4 minutes"
            : "1 second",
        );
        barrierStage += 1;
        continue;
      }
      if (
        run.state === "parsing" &&
        run.plan_origin === "production" &&
        requiredSourceAdapter(run.adapter_version)
            .reconciliationCapability === "catalogue"
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

function childAttempt(id: string): number {
  const value = id.match(/-attempt-(\d+)$/u)?.[1];
  return value === undefined ? 0 : Number.parseInt(value, 10) + 1;
}

function isChildWorkflowIdentity(baseId: string, id: string): boolean {
  if (id === baseId) return true;
  if (!id.startsWith(`${baseId}-attempt-`)) return false;
  return /^(?:0|[1-9]\d*)$/u.test(id.slice(`${baseId}-attempt-`.length));
}

function nextChildWorkflowIdentity(
  baseId: string,
  attempts: readonly string[],
): string {
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
      () => pendingEvidenceRequestPage(
        database,
        runId,
        afterSequenceNumber,
        Number.MAX_SAFE_INTEGER,
        workflowRequestPageSize,
      ),
    );
    for (const request of page) {
      const minimumSequenceNumber = Math.floor(
        request.sequence_number / hostShardRequestCapacity,
      ) * hostShardRequestCapacity;
      const shardKey = `${new URL(request.url).hostname}\u0000${minimumSequenceNumber}`;
      const prior = shards.get(shardKey);
      const shard: HostShard = {
        hostname: new URL(request.url).hostname,
        minimumSequenceNumber,
        maximumSequenceNumber:
          minimumSequenceNumber + hostShardRequestCapacity - 1,
        pendingRequestCount: (prior?.pendingRequestCount ?? 0) + 1,
      };
      shards.set(shardKey, shard);
    }
    if (page.length < workflowRequestPageSize) break;
    afterSequenceNumber = page.at(-1)!.sequence_number;
    pageNumber += 1;
  }
  return [...shards.values()].sort((left, right) =>
    left.minimumSequenceNumber - right.minimumSequenceNumber ||
    left.hostname.localeCompare(right.hostname)
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
    const page = await step.do(
      `${purpose} shard page ${pageNumber} stage ${stage}`,
      deterministicDatabaseStep,
      () => pendingEvidenceRequestPage(
        database,
        runId,
        afterSequenceNumber,
        shard.maximumSequenceNumber,
        workflowRequestPageSize,
      ),
    );
    requests.push(...page.filter(
      (request) => new URL(request.url).hostname === shard.hostname,
    ));
    if (page.length < workflowRequestPageSize) break;
    afterSequenceNumber = page.at(-1)!.sequence_number;
    pageNumber += 1;
  }
  return requests;
}

async function evidenceHostWorkflowId(
  runId: string,
  shard: HostShard,
): Promise<string> {
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

export class EvidenceHostWorkflow extends WorkflowEntrypoint<
  Env,
  EvidenceHostWorkflowParams
> {
  override async run(
    event: Readonly<WorkflowEvent<EvidenceHostWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<unknown> {
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
    let stage = 0;
    for (;;) {
      const requests = await loadPendingShardRequests(
        step,
        this.env.CATALOGUE_DB,
        runId,
        { hostname, minimumSequenceNumber, maximumSequenceNumber },
        stage,
      );
      for (const request of requests) {
        for (;;) {
          const prepared = await step.do(
            `prepare ${request.request_id}`,
            deterministicDatabaseStep,
            async () =>
              prepareCaptureAttempt(
                this.env.CATALOGUE_DB,
                await requiredEvidenceRun(this.env.CATALOGUE_DB, runId),
                request,
              ),
          );
          if (prepared.kind === "done") break;
          let result: CaptureTransportResult;
          if (prepared.kind === "captured") {
            result = await parseStep(step, this.env, runId, request, prepared);
          } else {
            const pacingDelay = await step.do(
              `read pacing deadline for ${request.request_id}`,
              deterministicDatabaseStep,
              () => hostPacingDelay(this.env.CATALOGUE_DB, hostname, pacingMode),
            );
            if (pacingDelay > 0) {
              await step.sleep(`pace ${request.request_id}`, pacingDelay);
            }
            result = await step.do(
              `transport ${request.request_id} attempt ${prepared.attempt_number}`,
              transportStep,
              async () =>
                capturePreparedAttempt(
                  this.env.CATALOGUE_DB,
                  this.env.EVIDENCE_OBJECTS,
                  this.env.OFFICIAL_SOURCE_TRANSPORT,
                  await requiredEvidenceRun(this.env.CATALOGUE_DB, runId),
                  request,
                  prepared,
                ),
            );
            if (result.request_made) {
              await step.do(
                `advance pacing for ${request.request_id} attempt ${prepared.attempt_number}`,
                deterministicDatabaseStep,
                () =>
                  advanceHostPacing(this.env.CATALOGUE_DB, hostname, pacingMode),
              );
            }
            if (result.kind === "uploaded") {
              result = await step.do(
                `commit ${request.request_id} attempt ${prepared.attempt_number}`,
                deterministicDatabaseStep,
                async () =>
                  completeUploadedCapture(
                    this.env.CATALOGUE_DB,
                    await requiredEvidenceRun(this.env.CATALOGUE_DB, runId),
                    request,
                    result.kind === "uploaded"
                      ? result.attempt_id
                      : prepared.attempt_id,
                  ),
              );
            }
            if (result.kind === "captured") {
              result = await parseStep(
                step,
                this.env,
                runId,
                request,
                result,
              );
            }
          }
          if (result.kind === "done") break;
          if (result.kind === "wait") {
            await step.sleep(
              `retry ${request.request_id}`,
              result.wait_ms,
            );
          }
        }
      }
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

async function parseStep(
  step: WorkflowStep,
  env: Env,
  runId: string,
  request: EvidenceRequestRow,
  captured:
    | Extract<PreparedCaptureAttempt, { kind: "captured" }>
    | Extract<CaptureTransportResult, { kind: "captured" }>,
): Promise<CaptureTransportResult> {
  return step.do(
    `parse ${request.request_id}`,
    deterministicDatabaseStep,
    async () =>
      parseCapturedRequest(
        env.CATALOGUE_DB,
        env.EVIDENCE_OBJECTS,
        await requiredEvidenceRun(env.CATALOGUE_DB, runId),
        request,
        captured.source_snapshot_id,
      ),
  );
}
