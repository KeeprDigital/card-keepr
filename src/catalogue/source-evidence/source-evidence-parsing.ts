import { beginEvidenceObjectWrite, completeEvidenceObjectWrite } from "./evidence-cleanup-repository";
import { MissingObjectError } from "../shared";
import {
  AdapterParseFailure,
  assertAdapterBinding,
  assertAdapterRequestSurface,
  requiredSourceAdapter,
} from "../adapters";
import { AdministrationProblem, type CatalogueStore, canonicalJson, sha256, utf8 } from "../shared";
import { sourceSnapshotStatement } from "./evidence-repository";
import { publicObservationSet } from "./source-evidence-repository";
import type { ObservationSetRow, SnapshotRow } from "./source-evidence-repository-types";
import {
  createParseOperationStatement,
  finalizedObservationSetStatement,
  finalizeParseStatement,
  observationSetByParseOperationStatement,
  parseOperationStatement,
  retainedDiscoveryObservationsStatement,
  uploadedParseStatement,
} from "./source-parse-repository";

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
  database: CatalogueStore,
  evidenceObjects: R2Bucket,
  snapshotId: string,
  adapterVersion: string,
  parseIntent: ParseIntent,
): Promise<ObservationSetRow> {
  const snapshot = await sourceSnapshotStatement(database, snapshotId).first<SnapshotRow>();
  if (snapshot === null) {
    throw new AdministrationProblem(404, "source_snapshot_not_found", "The requested Source Snapshot does not exist.");
  }
  const adapter = requiredSourceAdapter(adapterVersion);
  if (adapter.adapterVersion !== snapshot.adapter_version) {
    throw new AdministrationProblem(
      422,
      "source_snapshot_adapter_mismatch",
      "A Source Snapshot can only be parsed with its exact capturing adapter version.",
    );
  }
  assertAdapterBinding(adapter, {
    sourceLineage: snapshot.source_lineage,
    supportedGame: snapshot.supported_game,
    gameProfileVersion: snapshot.game_profile_version,
  });
  assertAdapterRequestSurface(adapter, new URL(snapshot.request_url));
  if (snapshot.content_byte_length > adapter.maximumSnapshotBytes) {
    throw new AdministrationProblem(
      422,
      "source_parse_too_large",
      "The Source Snapshot exceeds the adapter's bounded parse limit.",
    );
  }
  const operation = await prepareParseOperation(database, snapshot.id, adapter.adapterVersion, parseIntent);
  if (operation.state === "finalized") {
    return requiredObservationSet(database, operation.id);
  }
  if (operation.state === "uploaded") {
    return finalizeParseOperation(database, operation.id, snapshot);
  }
  const object = await evidenceObjects.get(snapshot.content_object_key);
  if (object === null) throw new MissingObjectError();
  if (object.size !== snapshot.content_byte_length) {
    throw new Error("Source Snapshot bytes are unavailable or truncated");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if ((await sha256(bytes)) !== snapshot.content_digest) {
    throw new Error("Source Snapshot bytes failed digest verification");
  }
  let observations: readonly unknown[];
  try {
    if (adapter.parseBytes !== undefined) {
      observations = await adapter.parseBytes(bytes, {
        mediaType: snapshot.media_type,
        url: snapshot.request_url,
        requestId: snapshot.request_id,
      });
    } else {
      let document: unknown;
      try {
        document = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
      } catch {
        throw new AdapterParseFailure("The Source Snapshot is not valid UTF-8 JSON.");
      }
      if (adapter.parse === undefined) {
        throw new Error("The Source Snapshot adapter has no parser.");
      }
      observations = await adapter.parse(document);
    }
  } catch (error) {
    if (!(error instanceof AdapterParseFailure) || error.category !== "source-contract") throw error;
    throw new AdministrationProblem(
      422,
      "source_parse_failed",
      error instanceof Error ? error.message : "The Official Source document does not satisfy its adapter contract.",
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
        adapter.reconciliationCapability !== "unavailable"
          ? {
              kind: adapter.reconciliationCapability,
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
    const writeToken = crypto.randomUUID();
    await beginEvidenceObjectWrite(
      database,
      writeToken,
      snapshot.ingestion_run_id,
      operation.content_object_key,
      new Date().toISOString(),
    ).run();
    try {
      await putImmutableBytes(evidenceObjects, operation.content_object_key, observationBytes, digest, writeToken);
    } finally {
      await completeEvidenceObjectWrite(database, writeToken, new Date().toISOString()).run();
    }
    await uploadedParseStatement(database, {
      digest: digest,
      byteLength: observationBytes.byteLength,
      observationCount: observations.length,
      operationId: operation.id,
    }).run();
  }
  return finalizeParseOperation(database, operation.id, snapshot);
}

export async function discoverSnapshotRequests(
  database: CatalogueStore,
  evidenceObjects: R2Bucket,
  snapshotId: string,
  adapterVersion: string,
): Promise<
  readonly {
    role: "listing" | "detail" | "product_detail" | "image";
    discoveryKey?: string;
    url: string;
    headers: Record<string, string>;
  }[]
> {
  const snapshot = await sourceSnapshotStatement(database, snapshotId).first<SnapshotRow>();
  if (snapshot === null) {
    throw new Error("Source Snapshot disappeared before request discovery.");
  }
  const adapter = requiredSourceAdapter(adapterVersion);
  assertAdapterBinding(adapter, {
    sourceLineage: snapshot.source_lineage,
    supportedGame: snapshot.supported_game,
    gameProfileVersion: snapshot.game_profile_version,
  });
  if (adapter.discoverRequests === undefined) return [];
  const object = await evidenceObjects.get(snapshot.content_object_key);
  if (object === null) throw new MissingObjectError();
  if (object.size !== snapshot.content_byte_length) {
    throw new Error("Source Snapshot bytes are unavailable or truncated");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if ((await sha256(bytes)) !== snapshot.content_digest) {
    throw new Error("Source Snapshot bytes failed digest verification");
  }
  try {
    const discovered = adapter.discoverRequests(bytes, {
      mediaType: snapshot.media_type,
      url: snapshot.request_url,
      requestId: snapshot.request_id,
    });
    const inheritedHeaders: unknown = JSON.parse(snapshot.request_headers_json);
    return discovered.map((request) => {
      if (
        !isRecord(inheritedHeaders) ||
        (request.discoveryKey === undefined && adapter.inheritDiscoveryRequestHeaders !== true)
      ) {
        return request;
      }
      const inherited = Object.fromEntries(
        Object.entries(inheritedHeaders).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
      const headers = { ...request.headers, ...inherited };
      if (request.headers.accept !== undefined) {
        headers.accept = request.headers.accept;
      }
      return {
        ...request,
        headers: discoveredRequestHeaders(request, headers),
      };
    });
  } catch (error) {
    if (!(error instanceof AdapterParseFailure) || error.category !== "source-contract") throw error;
    throw new AdministrationProblem(
      422,
      "source_discovery_failed",
      error instanceof Error ? error.message : "The Official Source request graph could not be discovered.",
    );
  }
}

function discoveredRequestHeaders(
  request: { role: "listing" | "detail" | "product_detail" | "image" },
  headers: Record<string, string>,
): Record<string, string> {
  const baseUserAgent = (headers["user-agent"] ?? "card-keepr-official-source/1").replace(
    /;\s*request-role=(?:surface|listing|detail|product_detail|image)(?=;|$)/gu,
    "",
  );
  return {
    ...headers,
    "user-agent": `${baseUserAgent}; request-role=${request.role}`,
  };
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
      total + (item !== null && Number.isInteger(item.declared_record_count) ? Number(item.declared_record_count) : 0),
    0,
  );
  const parsedRecordCount = completeness.reduce(
    (total, item) =>
      total + (item !== null && Number.isInteger(item.parsed_record_count) ? Number(item.parsed_record_count) : 0),
    0,
  );
  return {
    observation_count: observations.length,
    declared_record_count: declaredRecordCount,
    parsed_record_count: parsedRecordCount,
    required_surfaces_complete: completeness.every((item) => item?.required_surfaces_complete === true),
    partitions_complete: completeness.every((item) => item?.partitions_complete === true),
    structurally_complete:
      completeness.length === observations.length &&
      completeness.every((item) => item?.structurally_complete === true) &&
      declaredRecordCount === parsedRecordCount,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function retainedOfficialDiscoveryRecords(
  evidenceObjects: R2Bucket,
  observationSet: ObservationSetRow,
): Promise<unknown[]> {
  const discoveries = await retainedOfficialDiscoverySurfaces(evidenceObjects, observationSet);
  if (discoveries.length !== 1) {
    throw new Error("Official Source discovery retained an invalid surface count.");
  }
  return discoveries[0]!;
}

async function retainedOfficialDiscoverySurfaces(
  evidenceObjects: R2Bucket,
  observationSet: ObservationSetRow,
): Promise<unknown[][]> {
  const object = await evidenceObjects.get(observationSet.content_object_key);
  if (object === null) throw new MissingObjectError();
  if (object.size !== observationSet.content_byte_length) {
    throw new Error("Official Source discovery observations are unavailable.");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if ((await sha256(bytes)) !== observationSet.content_digest) {
    throw new Error("Official Source discovery observations failed digest verification.");
  }
  const document: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!isRecord(document) || !Array.isArray(document.observations)) {
    throw new Error("Official Source discovery observations are invalid.");
  }
  const discoveries = document.observations.filter(
    (wrapped) =>
      isRecord(wrapped) &&
      isRecord(wrapped.value) &&
      wrapped.value.observation_type === "official_surface_evidence" &&
      wrapped.value.surface === "discovery" &&
      Array.isArray(wrapped.value.records),
  );
  return discoveries.map((discovery) => (discovery as { value: { records: unknown[] } }).value.records);
}

export async function retainedOfficialDiscoveryRunRecords(
  database: CatalogueStore,
  evidenceObjects: R2Bucket,
  runId: string,
  sourceLineage: string,
): Promise<{
  discoveryObservationSetId: string;
  records: unknown[];
}> {
  const retained = await retainedDiscoveryObservationsStatement(database, {
    runId: runId,
    sourceLineage: sourceLineage,
  }).all<
    ObservationSetRow & {
      request_id: string;
    }
  >();
  const rootRequestId = `${sourceLineage}:discovery`;
  const root = retained.results.find(({ request_id }) => request_id === rootRequestId);
  if (root === undefined) {
    throw new Error("Official Source discovery root observations are unavailable.");
  }
  const records: unknown[] = [];
  for (const observationSet of retained.results) {
    const surfaces = await retainedOfficialDiscoverySurfaces(evidenceObjects, observationSet);
    for (const surfaceRecords of surfaces) records.push(...surfaceRecords);
  }
  return {
    discoveryObservationSetId: root.id,
    records,
  };
}

export async function reparseSnapshot(
  database: CatalogueStore,
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
  database: CatalogueStore,
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
  await createParseOperationStatement(database, {
    operationId: id,
    snapshotId: snapshotId,
    adapterVersion: adapterVersion,
    intent: parseIntent.intent,
    idempotencyKey: parseIntent.idempotencyKey,
    observationSetId: observationSetId,
    objectKey: `source-observations/${observationSetId}.json`,
    parsedAt: new Date().toISOString(),
  }).run();
  return requiredParseOperation(database, id);
}

async function finalizeParseOperation(
  database: CatalogueStore,
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
    finalizedObservationSetStatement(database, {
      observationSetId: operation.observation_set_id,
      operationId: operation.id,
      snapshotId: snapshot.id,
      sourceLineage: snapshot.source_lineage,
      supportedGame: snapshot.supported_game,
      gameProfileVersion: snapshot.game_profile_version,
      adapterVersion: operation.adapter_version,
      parsedAt: operation.parsed_at,
      digest: operation.content_digest,
      byteLength: operation.content_byte_length,
      objectKey: operation.content_object_key,
      observationCount: operation.observation_count,
    }),
    finalizeParseStatement(database, operation.id),
  ]);
  return requiredObservationSet(database, operation.id);
}

async function requiredParseOperation(database: CatalogueStore, id: string): Promise<ParseOperationRow> {
  const operation = await parseOperationStatement(database, id).first<ParseOperationRow>();
  if (operation === null) throw new Error("Parse operation disappeared");
  return operation;
}

async function requiredObservationSet(database: CatalogueStore, operationId: string): Promise<ObservationSetRow> {
  const stored = await observationSetByParseOperationStatement(database, operationId).first<ObservationSetRow>();
  if (stored === null) throw new Error("Source Observation Set disappeared");
  return stored;
}

async function putImmutableBytes(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
  digest: string,
  writeToken: string,
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
    customMetadata: { sha256: digest, cleanup_writer_token: writeToken },
  });
  if (stored !== null) return;
  const concurrent = await bucket.head(key);
  if (concurrent === null) throw new Error("Immutable evidence write conflict");
  assertMatchingObject(concurrent, bytes, digest);
}

function assertMatchingObject(object: R2Object, bytes: Uint8Array, digest: string): void {
  if (object.size !== bytes.byteLength || object.customMetadata?.sha256 !== digest) {
    throw new Error("Immutable evidence object key collision");
  }
}
