import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import {
  captureAttempt,
  hostPacingDelay,
} from "./source-evidence-capture";
import {
  finalizeEvidenceRun,
  pendingEvidenceRequests,
  recordWorkflowIds,
  requiredEvidenceRun,
} from "./source-evidence-repository";

export type EvidenceParentWorkflowParams = {
  ingestion_run_id: string;
};

export type EvidenceHostWorkflowParams = {
  ingestion_run_id: string;
  hostname: string;
};

type EvidenceWorkflowEnv = {
  CATALOGUE_DB: D1Database;
  EVIDENCE_OBJECTS: R2Bucket;
  EVIDENCE_HOST_WORKFLOW: Workflow<EvidenceHostWorkflowParams>;
};

const noAutomaticStepRetries = {
  retries: { limit: 0, delay: 0 },
  timeout: "1 minute" as const,
};

export class EvidenceIngestionWorkflow extends WorkflowEntrypoint<
  EvidenceWorkflowEnv,
  EvidenceParentWorkflowParams
> {
  override async run(
    event: Readonly<WorkflowEvent<EvidenceParentWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<unknown> {
    const runId = event.payload.ingestion_run_id;
    const hostnames = await step.do(
      "load Official Source host shards",
      noAutomaticStepRetries,
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
      "start dynamically sharded hostname workflows",
      noAutomaticStepRetries,
      async () => {
        for (const [index, hostname] of hostnames.entries()) {
          const id = childIds[index]!;
          try {
            const child = await this.env.EVIDENCE_HOST_WORKFLOW.create({
              id,
              params: { ingestion_run_id: runId, hostname },
            });
            disposeRpcHandle(child);
          } catch {
            // A replay may encounter a child created by the prior step attempt.
            const child = await this.env.EVIDENCE_HOST_WORKFLOW.get(id);
            const status = await child.status();
            if (status.status === "errored" || status.status === "terminated") {
              await child.restart();
            } else if (status.status === "paused") {
              await child.resume();
            }
            disposeRpcHandle(child);
          }
        }
        await recordWorkflowIds(
          this.env.CATALOGUE_DB,
          runId,
          event.instanceId,
          childIds,
        );
        return childIds;
      },
    );
    if (childIds.length === 0) {
      await step.do(
        "finalize empty evidence plan",
        noAutomaticStepRetries,
        () => finalizeEvidenceRun(this.env.CATALOGUE_DB, runId),
      );
    }
    return { ingestion_run_id: runId, child_workflow_ids: childIds };
  }
}

function disposeRpcHandle(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    return;
  }
  const record = value as Record<PropertyKey, unknown>;
  const dispose = (Symbol as unknown as { dispose?: symbol }).dispose;
  const candidate =
    (dispose === undefined ? undefined : record[dispose]) ?? record.dispose;
  if (typeof candidate === "function") candidate.call(value);
}

export class EvidenceHostWorkflow extends WorkflowEntrypoint<
  EvidenceWorkflowEnv,
  EvidenceHostWorkflowParams
> {
  override async run(
    event: Readonly<WorkflowEvent<EvidenceHostWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<unknown> {
    const { ingestion_run_id: runId, hostname } = event.payload;
    const requests = await step.do(
      "load hostname evidence requests",
      noAutomaticStepRetries,
      () => pendingEvidenceRequests(this.env.CATALOGUE_DB, runId, hostname),
    );
    for (const request of requests) {
      for (;;) {
        const pacingDelay = await step.do(
          `read pacing deadline for ${request.request_id}`,
          noAutomaticStepRetries,
          () => hostPacingDelay(this.env.CATALOGUE_DB, hostname),
        );
        if (pacingDelay > 0) {
          await step.sleep(
            `pace ${request.request_id}`,
            pacingDelay,
          );
        }
        const result = await step.do(
          `capture ${request.request_id}`,
          noAutomaticStepRetries,
          async () =>
            captureAttempt(
              this.env.CATALOGUE_DB,
              this.env.EVIDENCE_OBJECTS,
              await requiredEvidenceRun(this.env.CATALOGUE_DB, runId),
              request,
            ),
        );
        if (result.kind === "done") break;
        await step.sleep(
          `retry ${request.request_id}`,
          result.wait_ms,
        );
      }
    }
    await step.do(
      "finalize ingestion collection phase",
      noAutomaticStepRetries,
      () => finalizeEvidenceRun(this.env.CATALOGUE_DB, runId),
    );
    return { ingestion_run_id: runId, hostname };
  }
}
