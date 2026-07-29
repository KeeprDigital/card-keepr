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
import type {
  EvidenceHostWorkflowParams,
  EvidenceParentWorkflowParams,
} from "../../../src/catalogue/source-evidence-model";
import {
  finalizeEvidenceRun,
  pendingEvidenceRequests,
  recordWorkflowIds,
  requiredEvidenceRun,
} from "../../../src/catalogue/source-evidence-repository";

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
    const hostnames = await step.do(
      "load Official Source host shards",
      deterministicDatabaseStep,
      async () => {
        const run = await requiredEvidenceRun(this.env.CATALOGUE_DB, runId);
        if (run.state !== "collecting") return [];
        const requests = await pendingEvidenceRequests(
          this.env.CATALOGUE_DB,
          runId,
        );
        return [
          ...new Set(requests.map((request) => new URL(request.url).hostname)),
        ].sort();
      },
    );
    const childIds = hostnames.map(
      (_, index) => `${event.instanceId}-host-${index + 1}`,
    );
    await step.do(
      "record hostname Workflow identities",
      deterministicDatabaseStep,
      async () => {
        await recordWorkflowIds(
          this.env.CATALOGUE_DB,
          runId,
          event.instanceId,
          childIds,
        );
        return childIds;
      },
    );
    if (hostnames.length > 0) {
      await step.do(
        "start dynamically sharded hostname workflows",
        deterministicDatabaseStep,
        async () => {
          let children: WorkflowInstance[];
          try {
            children = await this.env.EVIDENCE_HOST_WORKFLOW.createBatch(
              hostnames.map((hostname, index) => ({
                id: childIds[index]!,
                params: { ingestion_run_id: runId, hostname },
              })),
            );
          } catch {
            children = await Promise.all(
              childIds.map((id) =>
                this.env.EVIDENCE_HOST_WORKFLOW.get(id),
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
          }
          return childIds;
        },
      );
    } else {
      await step.do(
        "finalize empty evidence plan",
        deterministicDatabaseStep,
        () => finalizeEvidenceRun(this.env.CATALOGUE_DB, runId),
      );
    }
    return { ingestion_run_id: runId, child_workflow_ids: childIds };
  }
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
    const requests = await step.do(
      "load hostname evidence requests",
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
    await step.do(
      "finalize ingestion collection phase",
      deterministicDatabaseStep,
      () => finalizeEvidenceRun(this.env.CATALOGUE_DB, runId),
    );
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
