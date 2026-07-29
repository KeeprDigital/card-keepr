import { AdministrationProblem } from "./ingestion";
import { canonicalJson, sha256, utf8 } from "./serialization";
import {
  assertAdapterBinding,
  requiredSourceAdapter,
} from "./source-adapters";
import {
  publicObservationSet,
  type ObservationSetRow,
  type SnapshotRow,
} from "./source-evidence-repository";

export async function parseSnapshot(
  database: D1Database,
  evidenceObjects: R2Bucket,
  snapshotId: string,
  adapterVersion: string,
): Promise<ObservationSetRow> {
  const replay = await database
    .prepare(
      `SELECT * FROM source_observation_sets
       WHERE source_snapshot_id = ? AND adapter_version = ?
       ORDER BY parsed_at DESC LIMIT 1`,
    )
    .bind(snapshotId, adapterVersion)
    .first<ObservationSetRow>();
  if (replay !== null) return replay;
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
  const adapter = requiredSourceAdapter(adapterVersion);
  assertAdapterBinding(adapter, {
    sourceLineage: snapshot.source_lineage,
    supportedGame: snapshot.supported_game,
    gameProfileVersion: snapshot.game_profile_version,
  });
  if (snapshot.content_byte_length > adapter.maximumJsonBytes) {
    throw new AdministrationProblem(
      422,
      "source_parse_too_large",
      "The Source Snapshot exceeds the adapter's bounded JSON parse limit.",
    );
  }
  const object = await evidenceObjects.get(snapshot.content_object_key);
  if (object === null || object.size !== snapshot.content_byte_length) {
    throw new Error("Source Snapshot bytes are unavailable or truncated");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if ((await sha256(bytes)) !== snapshot.content_digest) {
    throw new Error("Source Snapshot bytes failed digest verification");
  }
  let document: unknown;
  try {
    document = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        bytes,
      ),
    );
  } catch {
    throw new AdministrationProblem(
      422,
      "source_parse_failed",
      "The Source Snapshot is not valid UTF-8 JSON.",
    );
  }
  const observations =
    typeof document === "object" &&
    document !== null &&
    !Array.isArray(document) &&
    Array.isArray((document as { cards?: unknown }).cards)
      ? (document as { cards: unknown[] }).cards
      : [document];
  const parsedAt = new Date().toISOString();
  const observationSetId = `srcobsset_${crypto.randomUUID()}`;
  const observationDocument = {
    contract: "card-keepr-source-observations@1",
    id: observationSetId,
    source_snapshot_id: snapshot.id,
    source_lineage: snapshot.source_lineage,
    supported_game: snapshot.supported_game,
    game_profile_version: snapshot.game_profile_version,
    adapter_version: adapter.adapterVersion,
    parsed_at: parsedAt,
    observations: observations.map((value, index) => ({
      id: `srcobs_${observationSetId.slice(10)}_${index + 1}`,
      ordinal: index + 1,
      value,
    })),
  };
  const observationBytes = utf8(canonicalJson(observationDocument));
  const digest = await sha256(observationBytes);
  const objectKey = `source-observations/${observationSetId}.json`;
  await putImmutableBytes(
    evidenceObjects,
    objectKey,
    observationBytes,
    digest,
  );
  await database
    .prepare(
      `INSERT INTO source_observation_sets (
        id, source_snapshot_id, source_lineage, supported_game,
        game_profile_version, adapter_version, parsed_at, content_digest,
        content_byte_length, content_object_key, observation_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      observationSetId,
      snapshot.id,
      snapshot.source_lineage,
      snapshot.supported_game,
      snapshot.game_profile_version,
      adapter.adapterVersion,
      parsedAt,
      digest,
      observationBytes.byteLength,
      objectKey,
      observations.length,
    )
    .run();
  const stored = await database
    .prepare("SELECT * FROM source_observation_sets WHERE id = ?")
    .bind(observationSetId)
    .first<ObservationSetRow>();
  if (stored === null) throw new Error("Source Observation set disappeared");
  return stored;
}

export async function reparseSnapshot(
  database: D1Database,
  evidenceObjects: R2Bucket,
  snapshotId: string,
  adapterVersion: string,
): Promise<Record<string, unknown>> {
  return publicObservationSet(
    await parseSnapshot(database, evidenceObjects, snapshotId, adapterVersion),
  );
}

async function putImmutableBytes(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
  digest: string,
): Promise<void> {
  const existing = await bucket.head(key);
  if (existing !== null) {
    if (
      existing.size !== bytes.byteLength ||
      existing.customMetadata?.sha256 !== digest
    ) {
      throw new Error("Immutable evidence object key collision");
    }
    return;
  }
  const stored = await bucket.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: {
      contentType: "application/json",
      cacheControl: "private, max-age=31536000, immutable",
    },
    customMetadata: { sha256: digest },
  });
  if (stored === null) throw new Error("Immutable evidence write conflict");
}
