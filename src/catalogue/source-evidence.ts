import { AdministrationProblem } from "./shared";
import { parseSnapshot, reparseSnapshot } from "./source-evidence-parsing";
import { assertIdentifier, type StartEvidenceRunRequest } from "./source-evidence-model";
import {
  extendRunRequestCapacity,
  publicObservationSet,
  requiredEvidenceRun,
  retryEvidenceRun,
  showEvidenceRun,
  startEvidenceRun,
  type ObservationSetRow,
  type SnapshotRow,
} from "./source-evidence-repository";

export { extendRunRequestCapacity, retryEvidenceRun, showEvidenceRun, startEvidenceRun };
export type { StartEvidenceRunRequest };

export async function reparseSourceSnapshot(
  database: D1Database,
  evidenceObjects: R2Bucket,
  snapshotId: string,
  adapterVersion: string,
  idempotencyKey: string,
): Promise<Record<string, unknown>> {
  assertIdentifier(snapshotId, "source_snapshot_id");
  assertIdentifier(adapterVersion, "adapter_version");
  assertIdentifier(idempotencyKey, "idempotency_key");
  return reparseSnapshot(database, evidenceObjects, snapshotId, adapterVersion, idempotencyKey);
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
    throw new AdministrationProblem(404, "source_snapshot_not_found", "The requested Source Snapshot does not exist.");
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
