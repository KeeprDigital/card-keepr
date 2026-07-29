import { AdministrationProblem } from "./ingestion";
import {
  parseSnapshot,
  reparseSnapshot,
} from "./source-evidence-parsing";
import {
  assertIdentifier,
  type StartEvidenceRunRequest,
} from "./source-evidence-model";
import {
  publicObservationSet,
  requiredEvidenceRun,
  retryEvidenceRun,
  showEvidenceRun,
  startEvidenceRun,
  type ObservationSetRow,
  type SnapshotRow,
} from "./source-evidence-repository";
import type { EvidenceParentWorkflowParams } from "./source-evidence-workflows";

export {
  retryEvidenceRun,
  showEvidenceRun,
  startEvidenceRun,
};
export type { StartEvidenceRunRequest };

export async function resumeEvidenceRun(
  database: D1Database,
  workflow: Workflow<EvidenceParentWorkflowParams>,
  runId: string,
): Promise<Record<string, unknown>> {
  const run = await requiredEvidenceRun(database, runId);
  if (run.state !== "collecting") {
    throw new AdministrationProblem(
      409,
      "ingestion_run_not_collecting",
      "Only an Ingestion Run in its collection phase can be resumed.",
    );
  }
  const workflowId = `evidence-${runId}`;
  let instance;
  let status: Record<string, unknown> = { status: "queued" };
  if (run.parent_workflow_id === null) {
    try {
      instance = await workflow.create({
        id: workflowId,
        params: { ingestion_run_id: runId },
      });
    } catch {
      instance = await workflow.get(workflowId);
    }
    await database
      .prepare(
        `UPDATE ingestion_evidence_plans SET parent_workflow_id = ?
         WHERE ingestion_run_id = ? AND parent_workflow_id IS NULL`,
      )
      .bind(workflowId, runId)
      .run();
  } else {
    instance = await workflow.get(run.parent_workflow_id);
    try {
      status = await instance.status();
      if (status.status === "errored" || status.status === "terminated") {
        await instance.restart();
        status = { status: "queued" };
      } else if (status.status === "paused") {
        await instance.resume();
        status = { status: "queued" };
      } else if (status.status === "complete") {
        await instance.restart({
          from: { name: "start dynamically sharded hostname workflows" },
        });
        status = { status: "queued" };
      }
    } catch {
      status = { status: "queued" };
    }
  }
  const result = {
    ingestion_run_id: runId,
    workflow: {
      id: instance.id,
      ...status,
    },
  };
  disposeRpcHandle(instance);
  return result;
}

export async function reparseSourceSnapshot(
  database: D1Database,
  evidenceObjects: R2Bucket,
  snapshotId: string,
  adapterVersion: string,
): Promise<Record<string, unknown>> {
  assertIdentifier(snapshotId, "source_snapshot_id");
  assertIdentifier(adapterVersion, "adapter_version");
  return reparseSnapshot(
    database,
    evidenceObjects,
    snapshotId,
    adapterVersion,
  );
}

export async function sourceSnapshotContent(
  database: D1Database,
  evidenceObjects: R2Bucket,
  snapshotId: string,
): Promise<Response> {
  assertIdentifier(snapshotId, "source_snapshot_id");
  const snapshot = await database
    .prepare("SELECT * FROM source_snapshots WHERE id = ?")
    .bind(snapshotId)
    .first<SnapshotRow>();
  if (snapshot === null) {
    throw new AdministrationProblem(
      404,
      "source_snapshot_not_found",
      "The requested Source Snapshot does not exist.",
    );
  }
  return evidenceObjectResponse(evidenceObjects, {
    key: snapshot.content_object_key,
    digest: snapshot.content_digest,
    byteLength: snapshot.content_byte_length,
    contentType: snapshot.media_type ?? "application/octet-stream",
  });
}

export async function sourceObservationSetContent(
  database: D1Database,
  evidenceObjects: R2Bucket,
  observationSetId: string,
): Promise<Response> {
  assertIdentifier(observationSetId, "source_observation_set_id");
  const observation = await database
    .prepare("SELECT * FROM source_observation_sets WHERE id = ?")
    .bind(observationSetId)
    .first<ObservationSetRow>();
  if (observation === null) {
    throw new AdministrationProblem(
      404,
      "source_observation_set_not_found",
      "The requested Source Observation set does not exist.",
    );
  }
  return evidenceObjectResponse(evidenceObjects, {
    key: observation.content_object_key,
    digest: observation.content_digest,
    byteLength: observation.content_byte_length,
    contentType: "application/json",
  });
}

async function evidenceObjectResponse(
  bucket: R2Bucket,
  expected: {
    key: string;
    digest: string;
    byteLength: number;
    contentType: string;
  },
): Promise<Response> {
  const object = await bucket.get(expected.key);
  if (object === null || object.size !== expected.byteLength) {
    throw new AdministrationProblem(
      500,
      "evidence_object_unavailable",
      "The immutable evidence object is unavailable or failed verification.",
    );
  }
  return new Response(object.body, {
    headers: {
      "cache-control": "private, max-age=31536000, immutable",
      "content-length": String(expected.byteLength),
      "content-type": expected.contentType,
      etag: `"sha256-${expected.digest}"`,
    },
  });
}

// Re-exported for the durable workflow module's adapter-bound parse path.
export const parseImmutableSourceSnapshot = parseSnapshot;

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
