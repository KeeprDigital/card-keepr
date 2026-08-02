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
  type CaptureTransportResult,
  type PreparedCaptureAttempt,
} from "../../../src/catalogue/source-evidence-capture";
import {
  parseEvidencePlans,
  type EvidenceHostWorkflowParams,
  type EvidenceParentWorkflowParams,
} from "../../../src/catalogue/source-evidence-model";
import {
  finalizeEvidenceRun,
  pendingEvidenceRequests,
  recordWorkflowIds,
  requiredEvidenceRun,
} from "../../../src/catalogue/source-evidence-repository";
import {
  reconcileRetainedCardPrintingEvidence,
} from "../../../src/catalogue/card-printing-reconciliation";
import { canonicalJson, sha256, utf8 } from "../../../src/catalogue/serialization";
import {
  requiredSourceAdapter,
} from "../../../src/catalogue/source-adapters";
import { durableReconciliationResult } from "./reconciliation-workflow";

const deterministicDatabaseStep = {
  retries: { limit: 3, delay: 250, backoff: "exponential" as const },
  timeout: "1 minute" as const,
};

const transportStep = {
  retries: { limit: 3, delay: 500, backoff: "exponential" as const },
  timeout: "10 minutes" as const,
};

export class EvidenceIngestionWorkflow extends WorkflowEntrypoint<
  Env,
  EvidenceParentWorkflowParams
> {
  override async run(
    event: Readonly<WorkflowEvent<EvidenceParentWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<unknown> {
    const runId = event.payload.ingestion_run_id;
    const hostShards = await step.do(
      "load Official Source host shards",
      deterministicDatabaseStep,
      async () => {
        const run = await requiredEvidenceRun(this.env.CATALOGUE_DB, runId);
        if (run.state !== "collecting") {
          return { allHostnames: [], pendingHostnames: [] };
        }
        const requests = await pendingEvidenceRequests(
          this.env.CATALOGUE_DB,
          runId,
        );
        return {
          allHostnames: [
            ...new Set(
              parseEvidencePlans(run.request_plan_json).flatMap((plan) =>
                plan.requests.map(
                  (request) => new URL(request.url).hostname,
                ),
              ),
            ),
          ].sort(),
          pendingHostnames: [
            ...new Set(
              requests.map((request) => new URL(request.url).hostname),
            ),
          ].sort(),
        };
      },
    );
    const allChildIds = await Promise.all(
      hostShards.allHostnames.map((hostname) =>
        evidenceHostWorkflowId(runId, hostname),
      ),
    );
    const pendingChildren = await Promise.all(
      hostShards.pendingHostnames.map(async (hostname) => ({
        hostname,
        id: await evidenceHostWorkflowId(runId, hostname),
      })),
    );
    await step.do(
      "record hostname Workflow identities",
      deterministicDatabaseStep,
      async () => {
        await recordWorkflowIds(
          this.env.CATALOGUE_DB,
          runId,
          event.instanceId,
          allChildIds,
        );
        return allChildIds;
      },
    );
    if (pendingChildren.length > 0) {
      await step.do(
        "start dynamically sharded hostname workflows",
        deterministicDatabaseStep,
        async () => {
          await this.env.EVIDENCE_HOST_WORKFLOW.createBatch(
            pendingChildren.map((child) => ({
              id: child.id,
              params: {
                ingestion_run_id: runId,
                hostname: child.hostname,
              },
            })),
          );
          const children = await Promise.all(
            pendingChildren.map((child) =>
              this.env.EVIDENCE_HOST_WORKFLOW.get(child.id),
            ),
          );
          for (const child of children) {
            const status = await child.status();
            if (
              status.status === "errored" ||
              status.status === "terminated"
            ) {
              await child.restart();
            } else if (status.status === "paused") {
              await child.resume();
            }
          }
          return pendingChildren.map((child) => child.id);
        },
      );
    }
    let barrierStage = 0;
    for (;;) {
      const pendingChildren = await step.do(
        `reload pending hostname workflows stage ${barrierStage}`,
        deterministicDatabaseStep,
        async () =>
          Promise.all(
            [...new Set(
              (await pendingEvidenceRequests(this.env.CATALOGUE_DB, runId))
                .map((request) => new URL(request.url).hostname),
            )]
              .sort()
              .map(async (hostname) => ({
                hostname,
                id: await evidenceHostWorkflowId(runId, hostname),
              })),
          ),
      );
      if (pendingChildren.length > 0) {
        await step.do(
          `recover pending hostname workflows stage ${barrierStage}`,
          deterministicDatabaseStep,
          async () => {
            // createBatch is idempotent for deterministic IDs. A request can
            // be committed before the child creation RPC succeeds, so every
            // recovery pass closes that creation gap before reading status.
            await this.env.EVIDENCE_HOST_WORKFLOW.createBatch(
              pendingChildren.map((child) => ({
                id: child.id,
                params: {
                  ingestion_run_id: runId,
                  hostname: child.hostname,
                },
              })),
            );
            const children = await Promise.all(
              pendingChildren.map((child) =>
                this.env.EVIDENCE_HOST_WORKFLOW.get(child.id),
              ),
            );
            for (const child of children) {
              const status = await child.status();
              if (
                status.status === "errored" ||
                status.status === "terminated"
              ) {
                await child.restart();
              } else if (status.status === "paused") {
                await child.resume();
              }
            }
            return pendingChildren.map((child) => child.id);
          },
        );
      }
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
          "1 second",
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
        child_workflow_ids: allChildIds,
        state: run.state,
      };
    }
  }
}

async function evidenceHostWorkflowId(
  runId: string,
  hostname: string,
): Promise<string> {
  const digest = await sha256(
    utf8(
      canonicalJson({
        ingestion_run_id: runId,
        hostname,
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
    const { ingestion_run_id: runId, hostname } = event.payload;
    let stage = 0;
    for (;;) {
      const requests = await step.do(
        `load hostname evidence requests stage ${stage}`,
        deterministicDatabaseStep,
        () => pendingEvidenceRequests(this.env.CATALOGUE_DB, runId, hostname),
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
              () => hostPacingDelay(this.env.CATALOGUE_DB, hostname),
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
                () => advanceHostPacing(this.env.CATALOGUE_DB, hostname),
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
      const pending = await step.do(
        `load discovered evidence hostnames stage ${stage}`,
        deterministicDatabaseStep,
        () => pendingEvidenceRequests(this.env.CATALOGUE_DB, runId),
      );
      const localPending = pending.filter(
        (request) => new URL(request.url).hostname === hostname,
      );
      if (localPending.length > 0) {
        stage += 1;
        continue;
      }
      const discoveredHostnames = [
        ...new Set(
          pending
            .filter(
              (request) => request.discovered_from_request_id !== null,
            )
            .map((request) => new URL(request.url).hostname)
            .filter((candidate) => candidate !== hostname),
        ),
      ].sort();
      if (discoveredHostnames.length > 0) {
        await step.do(
          `start discovered hostname workflows stage ${stage}`,
          deterministicDatabaseStep,
          async () => {
            await this.env.EVIDENCE_HOST_WORKFLOW.createBatch(
              await Promise.all(
                discoveredHostnames.map(async (candidate) => ({
                  id: await evidenceHostWorkflowId(runId, candidate),
                  params: {
                    ingestion_run_id: runId,
                    hostname: candidate,
                  },
                })),
              ),
            );
            return discoveredHostnames;
          },
        );
      }
      break;
    }
    return { ingestion_run_id: runId, hostname };
  }
}

async function parseStep(
  step: WorkflowStep,
  env: Env,
  runId: string,
  request: Awaited<ReturnType<typeof pendingEvidenceRequests>>[number],
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
