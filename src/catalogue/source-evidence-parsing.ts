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

type ParseOperationRow = {
  id: string;
  source_snapshot_id: string;
  adapter_version: string;
  intent: "collection" | "reparse";
  idempotency_key: string;
  observation_set_id: string;
  content_object_key: string;
  parsed_at: string;
  state: "planned" | "uploaded" | "finalized";
  content_digest: string | null;
  content_byte_length: number | null;
  observation_count: number | null;
};

type ParseIntent = {
  intent: "collection" | "reparse";
  idempotencyKey: string;
};

export async function parseSnapshot(
  database: D1Database,
  evidenceObjects: R2Bucket,
  snapshotId: string,
  adapterVersion: string,
  parseIntent: ParseIntent,
): Promise<ObservationSetRow> {
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
  const operation = await prepareParseOperation(
    database,
    snapshot.id,
    adapter.adapterVersion,
    parseIntent,
  );
  if (operation.state === "finalized") {
    return requiredObservationSet(database, operation.id);
  }
  if (operation.state === "uploaded") {
    return finalizeParseOperation(database, operation.id, snapshot);
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
  let observations: readonly unknown[];
  try {
    observations = adapter.parse(document);
  } catch (error) {
    throw new AdministrationProblem(
      422,
      "source_parse_failed",
      error instanceof Error
        ? error.message
        : "The Official Source document does not satisfy its adapter contract.",
    );
  }
  if (operation.state === "planned") {
    const observationDocument = {
      contract: "card-keepr-source-observations@1",
      id: operation.observation_set_id,
      source_snapshot_id: snapshot.id,
      source_lineage: snapshot.source_lineage,
      supported_game: snapshot.supported_game,
      game_profile_version: snapshot.game_profile_version,
      adapter_version: adapter.adapterVersion,
      parsed_at: operation.parsed_at,
      coverage_proof:
        adapter.reconciliationCoverage !== "unavailable"
          ? {
              kind: adapter.reconciliationCoverage,
              adapter_version: adapter.adapterVersion,
              parser_contract: adapter.parserContract,
            }
          : null,
      evidence_summary: observationEvidenceSummary(observations),
      observations: observations.map((value, index) => ({
        id: `srcobs_${operation.observation_set_id.slice(10)}_${index + 1}`,
        ordinal: index + 1,
        value,
      })),
    };
    const observationBytes = utf8(canonicalJson(observationDocument));
    const digest = await sha256(observationBytes);
    await putImmutableBytes(
      evidenceObjects,
      operation.content_object_key,
      observationBytes,
      digest,
    );
    await database
      .prepare(
        `UPDATE source_parse_operations
         SET state = 'uploaded', content_digest = ?,
             content_byte_length = ?, observation_count = ?
         WHERE id = ? AND state = 'planned'`,
      )
      .bind(
        digest,
        observationBytes.byteLength,
        observations.length,
        operation.id,
      )
      .run();
  }
  return finalizeParseOperation(database, operation.id, snapshot);
}

function observationEvidenceSummary(observations: readonly unknown[]) {
  const completeness = observations.map((observation) => {
    if (!isRecord(observation) || !isRecord(observation.completeness)) {
      return null;
    }
    return observation.completeness;
  });
  const declaredRecordCount = completeness.reduce(
    (total, item) =>
      total +
      (item !== null && Number.isInteger(item.declared_record_count)
        ? Number(item.declared_record_count)
        : 0),
    0,
  );
  const parsedRecordCount = completeness.reduce(
    (total, item) =>
      total +
      (item !== null && Number.isInteger(item.parsed_record_count)
        ? Number(item.parsed_record_count)
        : 0),
    0,
  );
  return {
    observation_count: observations.length,
    declared_record_count: declaredRecordCount,
    parsed_record_count: parsedRecordCount,
    required_surfaces_complete: completeness.every(
      (item) => item?.required_surfaces_complete === true,
    ),
    partitions_complete: completeness.every(
      (item) => item?.partitions_complete === true,
    ),
    structurally_complete:
      completeness.length === observations.length &&
      completeness.every(
        (item) => item?.structurally_complete === true,
      ) &&
      declaredRecordCount === parsedRecordCount &&
      parsedRecordCount === observations.length,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function reparseSnapshot(
  database: D1Database,
  evidenceObjects: R2Bucket,
  snapshotId: string,
  adapterVersion: string,
  idempotencyKey: string,
): Promise<Record<string, unknown>> {
  return publicObservationSet(
    await parseSnapshot(database, evidenceObjects, snapshotId, adapterVersion, {
      intent: "reparse",
      idempotencyKey,
    }),
  );
}

async function prepareParseOperation(
  database: D1Database,
  snapshotId: string,
  adapterVersion: string,
  parseIntent: ParseIntent,
): Promise<ParseOperationRow> {
  const digest = await sha256(
    utf8(
      canonicalJson({
        source_snapshot_id: snapshotId,
        adapter_version: adapterVersion,
        intent: parseIntent.intent,
        idempotency_key: parseIntent.idempotencyKey,
      }),
    ),
  );
  const id = `srcparse_${digest}`;
  const observationSetId = `srcobsset_${digest}`;
  await database
    .prepare(
      `INSERT OR IGNORE INTO source_parse_operations (
        id, source_snapshot_id, adapter_version, intent, idempotency_key,
        observation_set_id, content_object_key, parsed_at, state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned')`,
    )
    .bind(
      id,
      snapshotId,
      adapterVersion,
      parseIntent.intent,
      parseIntent.idempotencyKey,
      observationSetId,
      `source-observations/${observationSetId}.json`,
      new Date().toISOString(),
    )
    .run();
  return requiredParseOperation(database, id);
}

async function finalizeParseOperation(
  database: D1Database,
  operationId: string,
  snapshot: SnapshotRow,
): Promise<ObservationSetRow> {
  const operation = await requiredParseOperation(database, operationId);
  if (operation.state === "finalized") {
    return requiredObservationSet(database, operation.id);
  }
  if (
    operation.state !== "uploaded" ||
    operation.content_digest === null ||
    operation.content_byte_length === null ||
    operation.observation_count === null
  ) {
    throw new Error("Parse operation upload metadata is incomplete");
  }
  await database.batch([
    database
      .prepare(
        `INSERT OR IGNORE INTO source_observation_sets (
          id, parse_operation_id, source_snapshot_id, source_lineage,
          supported_game, game_profile_version, adapter_version, parsed_at,
          content_digest, content_byte_length, content_object_key,
          observation_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        operation.observation_set_id,
        operation.id,
        snapshot.id,
        snapshot.source_lineage,
        snapshot.supported_game,
        snapshot.game_profile_version,
        operation.adapter_version,
        operation.parsed_at,
        operation.content_digest,
        operation.content_byte_length,
        operation.content_object_key,
        operation.observation_count,
      ),
    database
      .prepare(
        `UPDATE source_parse_operations SET state = 'finalized'
         WHERE id = ? AND state = 'uploaded'`,
      )
      .bind(operation.id),
  ]);
  return requiredObservationSet(database, operation.id);
}

async function requiredParseOperation(
  database: D1Database,
  id: string,
): Promise<ParseOperationRow> {
  const operation = await database
    .prepare("SELECT * FROM source_parse_operations WHERE id = ?")
    .bind(id)
    .first<ParseOperationRow>();
  if (operation === null) throw new Error("Parse operation disappeared");
  return operation;
}

async function requiredObservationSet(
  database: D1Database,
  operationId: string,
): Promise<ObservationSetRow> {
  const stored = await database
    .prepare(
      "SELECT * FROM source_observation_sets WHERE parse_operation_id = ?",
    )
    .bind(operationId)
    .first<ObservationSetRow>();
  if (stored === null) throw new Error("Source Observation Set disappeared");
  return stored;
}

async function putImmutableBytes(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
  digest: string,
): Promise<void> {
  const existing = await bucket.head(key);
  if (existing !== null) {
    assertMatchingObject(existing, bytes, digest);
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
  if (stored !== null) return;
  const concurrent = await bucket.head(key);
  if (concurrent === null) throw new Error("Immutable evidence write conflict");
  assertMatchingObject(concurrent, bytes, digest);
}

function assertMatchingObject(
  object: R2Object,
  bytes: Uint8Array,
  digest: string,
): void {
  if (
    object.size !== bytes.byteLength ||
    object.customMetadata?.sha256 !== digest
  ) {
    throw new Error("Immutable evidence object key collision");
  }
}
