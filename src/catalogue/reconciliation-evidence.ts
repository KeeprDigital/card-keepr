import { sha256 } from "./serialization";
import { parseReconciliationObservation } from "./reconciliation-model";
import type { SupportedGame } from "./fixture";
import { requiredSourceAdapter } from "./source-adapters";
import { evidencePlanForRequest } from "./source-evidence-repository";

type PlannedRequestRow = {
  request_id: string;
  sequence_number: number;
  state: string;
  source_snapshot_id: string | null;
};

type EvidenceRow = {
  request_id: string;
  observation_set_id: string;
  source_snapshot_id: string;
  retrieved_at: string;
  source_lineage: string;
  supported_game: string;
  game_profile_version: string;
  adapter_version: string;
  content_digest: string;
  content_byte_length: number;
  content_object_key: string;
  observation_count: number;
  request_plan_json: string;
  plan_origin: string;
};

type PrintingImageSnapshotRow = {
  request_url: string;
  media_type: string | null;
  content_digest: string;
  content_byte_length: number;
  content_object_key: string;
};

export async function retainedReconciliationObservation(
  database: D1Database,
  evidenceObjects: R2Bucket,
  runId: string,
) {
  const [requests, observations, printingImageSnapshots] = await Promise.all([
    database
      .prepare(
        `SELECT request_id, sequence_number, state, source_snapshot_id
         FROM source_requests
         WHERE ingestion_run_id = ?
         ORDER BY sequence_number, request_id`,
      )
      .bind(runId)
      .all<PlannedRequestRow>(),
    database
      .prepare(
        `SELECT
          snapshots.request_id,
          observations.id AS observation_set_id,
          observations.source_snapshot_id,
          snapshots.retrieved_at,
          observations.source_lineage,
          observations.supported_game,
          observations.game_profile_version,
          observations.adapter_version,
          observations.content_digest,
          observations.content_byte_length,
          observations.content_object_key,
          observations.observation_count,
          plan.request_plan_json,
          plan.plan_origin
         FROM source_observation_sets AS observations
         JOIN source_parse_operations AS parse
           ON parse.id = observations.parse_operation_id
         JOIN source_snapshots AS snapshots
           ON snapshots.id = observations.source_snapshot_id
         JOIN ingestion_evidence_plans AS plan
           ON plan.ingestion_run_id = snapshots.ingestion_run_id
         WHERE snapshots.ingestion_run_id = ?
           AND parse.intent = 'collection'
         ORDER BY snapshots.request_id, observations.id`,
      )
      .bind(runId)
      .all<EvidenceRow>(),
    database
      .prepare(
        `SELECT
          snapshot.request_url,
          snapshot.media_type,
          snapshot.content_digest,
          snapshot.content_byte_length,
          snapshot.content_object_key
         FROM source_snapshots AS snapshot
         JOIN source_requests AS request
           ON request.ingestion_run_id = snapshot.ingestion_run_id
          AND request.request_id = snapshot.request_id
         WHERE snapshot.ingestion_run_id = ?
           AND request.request_role = 'image'
           AND request.state = 'observed'
         ORDER BY snapshot.request_url`,
      )
      .bind(runId)
      .all<PrintingImageSnapshotRow>(),
  ]);
  if (requests.results.length === 0) {
    throw new Error(
      "Reconciliation requires complete coverage of every planned Source Request.",
    );
  }
  const selectedSnapshots = new Map<string, PlannedRequestRow>();
  for (const request of requests.results) {
    if (request.state !== "observed" || request.source_snapshot_id === null) {
      throw new Error(
        `Planned Source Request ${request.request_id} has no observed Source Snapshot.`,
      );
    }
    if (selectedSnapshots.has(request.source_snapshot_id)) {
      throw new Error(
        "Planned Source Requests selected a duplicate Source Snapshot.",
      );
    }
    selectedSnapshots.set(request.source_snapshot_id, request);
  }
  for (const row of observations.results) {
    if (!selectedSnapshots.has(row.source_snapshot_id)) {
      throw new Error(
        `Unplanned Source Observation Set ${row.observation_set_id} cannot participate in reconciliation.`,
      );
    }
  }
  const rowsBySnapshot = new Map<string, EvidenceRow[]>();
  for (const row of observations.results) {
    rowsBySnapshot.set(row.source_snapshot_id, [
      ...(rowsBySnapshot.get(row.source_snapshot_id) ?? []),
      row,
    ]);
  }
  const orderedRows = requests.results.map((request) => {
    const rows = rowsBySnapshot.get(request.source_snapshot_id!) ?? [];
    if (rows.length !== 1) {
      throw new Error(
        `Planned Source Request ${request.request_id} requires exactly one collection Source Observation Set.`,
      );
    }
    return rows[0]!;
  });
  const first = orderedRows[0]!;
  for (const row of orderedRows) {
    const plan = evidencePlanForRequest(
      { request_plan_json: row.request_plan_json },
      row.request_id,
    );
    if (
      row.source_lineage !== plan.source_lineage ||
      row.supported_game !== plan.supported_game ||
      row.game_profile_version !== plan.game_profile_version ||
      row.adapter_version !== plan.adapter_version
    ) {
      throw new Error(
        "Retained Source Observation Set provenance is inconsistent with its Evidence Plan.",
      );
    }
  }
  const documents = await Promise.all(
    orderedRows.map((row) =>
      retainedObservationDocument(evidenceObjects, row),
    ),
  );
  const retainedImages = new Map(
    await Promise.all(
      printingImageSnapshots.results.map(async (row) => [
        row.request_url,
        await retainedPrintingImage(evidenceObjects, row),
      ] as const),
    ),
  );
  const observationIds = new Set<string>();
  const merged = documents.flatMap((document, index) => {
    const row = orderedRows[index]!;
    return document.observations
      .map((wrapped) => {
        if (!isRecord(wrapped) || typeof wrapped.id !== "string") {
          throw new Error("Retained Source Observation identity is invalid.");
        }
        if (observationIds.has(wrapped.id)) {
          throw new Error(
            `Duplicate Source Observation ${wrapped.id} spans planned requests.`,
          );
        }
        observationIds.add(wrapped.id);
        return {
          ...parseReconciliationObservation(
            wrapped.id,
            attachRetainedPrintingImages(wrapped.value, retainedImages),
          ),
          sourceObservationSetId: row.observation_set_id,
          sourceSnapshotId: row.source_snapshot_id,
          sourceCapturedAt: row.retrieved_at,
          sourceLineage: row.source_lineage,
          supportedGame: supportedGame(row.supported_game),
          structurallyComplete: true,
        };
      })
      .sort((left, right) =>
        left.sourceObservationId.localeCompare(right.sourceObservationId),
      );
  });
  return {
    observationSetId: first.observation_set_id,
    sourceSnapshotId: first.source_snapshot_id,
    sourceLineage: first.source_lineage,
    supportedGame: supportedGame(first.supported_game),
    structurallyComplete: true,
    partitions: orderedRows.map((row, index) => ({
      sequenceNumber: requests.results[index]!.sequence_number,
      requestId: requests.results[index]!.request_id,
      observationSetId: row.observation_set_id,
      sourceSnapshotId: row.source_snapshot_id,
      sourceLineage: row.source_lineage,
      supportedGame: row.supported_game,
      gameProfileVersion: row.game_profile_version,
      adapterVersion: row.adapter_version,
    })),
    observations: merged,
  };
}

function attachRetainedPrintingImages(
  value: unknown,
  images: ReadonlyMap<
    string,
    {
      media_type: string;
      width: number;
      height: number;
      content_sha256: string;
      content_base64: string;
    }
  >,
): unknown {
  if (!isRecord(value) || !isRecord(value.appearance_evidence)) return value;
  const declared = value.appearance_evidence.images;
  if (!Array.isArray(declared)) return value;
  return {
    ...value,
    appearance_evidence: {
      ...value.appearance_evidence,
      images: declared.map((item) => {
        if (!isRecord(item) || typeof item.source_url !== "string") return item;
        const retained = images.get(item.source_url);
        return retained === undefined ? item : { ...item, ...retained };
      }),
    },
  };
}

async function retainedPrintingImage(
  evidenceObjects: R2Bucket,
  row: PrintingImageSnapshotRow,
): Promise<{
  media_type: string;
  width: number;
  height: number;
  content_sha256: string;
  content_base64: string;
}> {
  if (row.media_type === null || !row.media_type.startsWith("image/")) {
    throw new Error("Retained Printing Image media type is invalid.");
  }
  const object = await evidenceObjects.get(row.content_object_key);
  if (object === null || object.size !== row.content_byte_length) {
    throw new Error("Retained Printing Image bytes are unavailable.");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if ((await sha256(bytes)) !== row.content_digest) {
    throw new Error("Retained Printing Image digest is invalid.");
  }
  const dimensions = imageDimensions(bytes, row.media_type);
  return {
    media_type: row.media_type,
    width: dimensions.width,
    height: dimensions.height,
    content_sha256: row.content_digest,
    content_base64: base64(bytes),
  };
}

function imageDimensions(
  bytes: Uint8Array,
  mediaType: string,
): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    mediaType === "image/png" &&
    bytes.byteLength >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return {
      width: view.getUint32(16),
      height: view.getUint32(20),
    };
  }
  if (
    mediaType === "image/gif" &&
    bytes.byteLength >= 10 &&
    String.fromCharCode(...bytes.subarray(0, 3)) === "GIF"
  ) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (
    (mediaType === "image/jpeg" || mediaType === "image/jpg") &&
    bytes.byteLength >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8
  ) {
    let offset = 2;
    while (offset + 8 < bytes.byteLength) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1]!;
      const length = view.getUint16(offset + 2);
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return {
          height: view.getUint16(offset + 5),
          width: view.getUint16(offset + 7),
        };
      }
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  if (
    mediaType === "image/webp" &&
    bytes.byteLength >= 30 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    const chunk = String.fromCharCode(...bytes.subarray(12, 16));
    if (chunk === "VP8X") {
      return {
        width: 1 + uint24le(bytes, 24),
        height: 1 + uint24le(bytes, 27),
      };
    }
    if (chunk === "VP8 " && bytes.byteLength >= 30) {
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    }
    if (chunk === "VP8L" && bytes.byteLength >= 25 && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      return {
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >>> 14) & 0x3fff),
      };
    }
  }
  if (mediaType === "image/avif") {
    for (let offset = 4; offset + 16 <= bytes.byteLength; offset += 1) {
      if (
        bytes[offset] === 0x69 &&
        bytes[offset + 1] === 0x73 &&
        bytes[offset + 2] === 0x70 &&
        bytes[offset + 3] === 0x65
      ) {
        return {
          width: view.getUint32(offset + 8),
          height: view.getUint32(offset + 12),
        };
      }
    }
  }
  throw new Error("Retained Printing Image dimensions are unsupported.");
}

function uint24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16);
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function retainedObservationDocument(
  evidenceObjects: R2Bucket,
  row: EvidenceRow,
): Promise<{ observations: unknown[] }> {
  const object = await evidenceObjects.get(row.content_object_key);
  if (object === null || object.size !== row.content_byte_length) {
    throw new Error("Retained Source Observation Set bytes are unavailable.");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if ((await sha256(bytes)) !== row.content_digest) {
    throw new Error("Retained Source Observation Set digest is invalid.");
  }
  const document: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const adapter = requiredSourceAdapter(row.adapter_version);
  if (
    !isRecord(document) ||
    document.contract !== "card-keepr-source-observations@1" ||
    document.id !== row.observation_set_id ||
    document.source_snapshot_id !== row.source_snapshot_id ||
    document.source_lineage !== row.source_lineage ||
    document.supported_game !== row.supported_game ||
    document.game_profile_version !== row.game_profile_version ||
    document.adapter_version !== row.adapter_version ||
    adapter.reconciliationCoverage === "unavailable" ||
    row.plan_origin !== adapter.origin ||
    !isRecord(document.coverage_proof) ||
    document.coverage_proof.kind !== adapter.reconciliationCoverage ||
    document.coverage_proof.adapter_version !== adapter.adapterVersion ||
    document.coverage_proof.parser_contract !== adapter.parserContract ||
    !validEvidenceSummary(
      document.evidence_summary,
      document.observations,
      row.observation_count,
    ) ||
    !Array.isArray(document.observations)
  ) {
    throw new Error("Retained Source Observation Set provenance is invalid.");
  }
  return { observations: document.observations };
}

function validEvidenceSummary(
  value: unknown,
  observations: unknown,
  observationCount: number,
): boolean {
  if (!isRecord(value) || !Array.isArray(observations)) return false;
  return (
    value.structurally_complete === true &&
    value.required_surfaces_complete === true &&
    value.partitions_complete === true &&
    observationCount === observations.length &&
    value.observation_count === observationCount &&
    value.declared_record_count === observationCount &&
    value.parsed_record_count === observationCount
  );
}

function supportedGame(value: string): SupportedGame {
  if (
    value !== "one-piece" &&
    value !== "fusion-world" &&
    value !== "digimon" &&
    value !== "gundam"
  ) {
    throw new Error("Retained Source Observation Set game is unsupported.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
