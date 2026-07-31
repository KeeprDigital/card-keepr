import { canonicalJson, sha256 } from "./serialization";
import { parseReconciliationObservation } from "./reconciliation-model";
import type { SupportedGame } from "./catalogue-candidate";
import { requiredSourceAdapter } from "./source-adapters";
import { evidencePlanForRequest } from "./source-evidence-repository";
import {
  parseEvidencePlans,
  type EvidencePlanRequest,
} from "./source-evidence-model";
import {
  parsedOfficialArtworkIdentity,
} from "./official-artwork-identity.mjs";
import {
  parseRetainedLegalityRules,
  type RetainedLegalityRule,
} from "./legality-rule";

type PlannedRequestRow = {
  request_id: string;
  sequence_number: number;
  method: string;
  url: string;
  request_headers_json: string;
  representation_fingerprint: string;
  request_role: "surface" | "listing" | "detail" | "product_detail" | "image";
  discovered_from_request_id: string | null;
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
  snapshot_request_method: string;
  snapshot_request_url: string;
  snapshot_request_headers_json: string;
  snapshot_representation_fingerprint: string;
};

type PrintingImageSnapshotRow = {
  request_url: string;
  media_type: string | null;
  content_digest: string;
  content_byte_length: number;
  content_object_key: string;
};

type CollectionPlanRow = {
  discovery_observation_set_id: string;
  contract: string;
  collection_plan_json: string;
  content_digest: string;
};

type EvidencePlanRow = {
  request_plan_json: string;
};

const maximumAggregateReconciliationBytes = 32 * 1024 * 1024;

export async function retainedReconciliationObservation(
  database: D1Database,
  evidenceObjects: R2Bucket,
  runId: string,
) {
  const [
    requests,
    observations,
    printingImageSnapshots,
    collectionPlan,
    evidencePlanRow,
  ] = await Promise.all([
    database
      .prepare(
        `SELECT request_id, sequence_number, method, url,
                request_headers_json, representation_fingerprint,
                request_role,
                discovered_from_request_id, state, source_snapshot_id
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
          plan.source_lineage AS plan_source_lineage,
          plan.supported_game AS plan_supported_game,
          plan.game_profile_version AS plan_game_profile_version,
          plan.adapter_version AS plan_adapter_version,
          plan.plan_origin,
          snapshots.request_method AS snapshot_request_method,
          snapshots.request_url AS snapshot_request_url,
          snapshots.request_headers_json AS snapshot_request_headers_json,
          snapshots.representation_fingerprint AS snapshot_representation_fingerprint
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
    database
      .prepare(
        `SELECT discovery_observation_set_id, contract,
                collection_plan_json, content_digest
         FROM official_source_collection_plans
         WHERE ingestion_run_id = ?`,
        )
        .bind(runId)
        .first<CollectionPlanRow>(),
      database
        .prepare(
          `SELECT request_plan_json
         FROM ingestion_evidence_plans
         WHERE ingestion_run_id = ?`,
        )
        .bind(runId)
        .first<EvidencePlanRow>(),
  ]);
  if (requests.results.length === 0 || evidencePlanRow === null) {
    throw new Error(
      "Reconciliation requires complete coverage of every planned Source Request.",
    );
  }
  const plannedRequests = parseEvidencePlans(
    evidencePlanRow.request_plan_json,
  ).flatMap((plan) => plan.requests);
  if (
    plannedRequests.length === 0 ||
    plannedRequests.length > requests.results.length ||
    plannedRequests.some((planned) => {
      const request = requests.results.find(
        ({ request_id: requestId }) => requestId === planned.id,
      );
      return !samePlannedRequest(
        request,
        planned,
        request?.sequence_number ?? -1,
      );
    })
  ) {
    throw new Error(
      "Operational Source Requests differ from the immutable Evidence Plan.",
    );
  }
  if (collectionPlan !== null) {
    if (
      collectionPlan.contract !==
        "card-keepr-official-source-collection-plan@1" ||
      (await sha256(new TextEncoder().encode(
        collectionPlan.collection_plan_json,
      ))) !== collectionPlan.content_digest
    ) {
      throw new Error(
        "Official Source Collection Plan failed immutable artifact verification.",
      );
    }
    const retainedCollection: unknown = JSON.parse(
      collectionPlan.collection_plan_json,
    );
    if (
      !isRecord(retainedCollection) ||
      !Array.isArray(retainedCollection.requests) ||
      retainedCollection.requests.some((planned) => {
        if (!isRecord(planned) || typeof planned.id !== "string") return true;
        const request = requests.results.find(
          ({ request_id: requestId }) => requestId === planned.id,
        );
        return !samePlannedRequest(
          request,
          planned,
          request?.sequence_number ?? -1,
        );
      })
    ) {
      throw new Error(
        "Official Source requests differ from the immutable Collection Plan.",
      );
    }
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
  for (const [index, row] of orderedRows.entries()) {
    const request = requests.results[index]!;
    const plan = evidencePlanForRequest(
      { request_plan_json: row.request_plan_json },
      row.request_id,
    );
    if (
      row.request_id !== request.request_id ||
      row.snapshot_request_method !== request.method ||
      row.snapshot_request_url !== request.url ||
      row.snapshot_request_headers_json !== request.request_headers_json ||
      row.snapshot_representation_fingerprint !==
        request.representation_fingerprint
    ) {
      throw new Error(
        "Retained Source Snapshot provenance differs from its immutable Source Request.",
      );
    }
    if (
      row.source_lineage !== first.source_lineage ||
      row.supported_game !== first.supported_game ||
      row.game_profile_version !== first.game_profile_version ||
      row.adapter_version !== first.adapter_version ||
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
  const aggregateBytes = orderedRows.reduce(
    (total, row) => total + row.content_byte_length,
    0,
  );
  if (aggregateBytes > maximumAggregateReconciliationBytes) {
    throw new Error(
      "Retained Source Observation Sets exceed the aggregate reconciliation byte budget.",
    );
  }
  assertClosedRequestGraph(requests.results, orderedRows, documents);
  const retainedImages = new Map(
    await Promise.all(
      printingImageSnapshots.results.map(async (row) => [
        row.request_url,
        await retainedPrintingImage(evidenceObjects, row),
      ] as const),
    ),
  );
  const observationIds = new Set<string>();
  const legalityRules: RetainedLegalityRule[] = [];
  const requestsById = new Map(
    requests.results.map((request) => [request.request_id, request]),
  );
  const merged = (
    await Promise.all(documents.map(async (document, index) => {
      const row = orderedRows[index]!;
      const request = requests.results[index]!;
      return Promise.all(
        document.observations.map(async (wrapped) => {
        if (!isRecord(wrapped) || typeof wrapped.id !== "string") {
          throw new Error("Retained Source Observation identity is invalid.");
        }
        if (observationIds.has(wrapped.id)) {
          throw new Error(
            `Duplicate Source Observation ${wrapped.id} spans planned requests.`,
          );
        }
        observationIds.add(wrapped.id);
        legalityRules.push(
          ...parseRetainedLegalityRules(wrapped.value, {
            game: supportedGame(row.supported_game),
            sourceLineage: row.source_lineage,
            sourceSnapshotId: row.source_snapshot_id,
            sourceObservationSetId: row.observation_set_id,
            sourceObservationId: wrapped.id,
          }),
        );
        if (
          isRecord(wrapped.value) &&
          wrapped.value.observation_type === "legality_rules"
        ) {
          return null;
        }
        const parsed = parseReconciliationObservation(
          wrapped.id,
          await attachRetainedPrintingImages(
            wrapped.value,
            retainedImages,
            row.plan_origin === "production",
          ),
        );
        assertObservationAuthority(
          parsed,
          requiredSourceAdapter(row.adapter_version)
            .reconciliationCapability,
        );
        return {
          ...parsed,
          sourceObservationSetId: row.observation_set_id,
          sourceSnapshotId: row.source_snapshot_id,
          sourceCapturedAt: row.retrieved_at,
          sourceLineage: row.source_lineage,
          sourceRequestRole: request.request_role,
          sourceSurface: sourceSurfaceForRequest(
            request,
            requestsById,
            row,
          ),
          supportedGame: supportedGame(row.supported_game),
          structurallyComplete: true,
        };
        }),
      );
    }))
  ).flat().flatMap((observation) =>
    observation === null ? [] : [observation]
  ).sort((left, right) =>
    left.sourceObservationId.localeCompare(right.sourceObservationId)
  );
  return {
    observationSetId: first.observation_set_id,
    sourceSnapshotId: first.source_snapshot_id,
    sourceLineage: first.source_lineage,
    supportedGame: supportedGame(first.supported_game),
    reconciliationCapability:
      requiredSourceAdapter(first.adapter_version).reconciliationCapability,
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
    legalityRules,
  };
}

function sourceSurfaceForRequest(
  request: PlannedRequestRow,
  requests: ReadonlyMap<string, PlannedRequestRow>,
  row: Pick<
    EvidenceRow,
    "adapter_version" | "plan_origin" | "source_lineage"
  >,
): string | undefined {
  const adapter = requiredSourceAdapter(row.adapter_version);
  if (
    adapter.origin === "synthetic_fixture" &&
    row.plan_origin === "synthetic_fixture"
  ) {
    return undefined;
  }
  let current = request;
  const visited = new Set<string>();
  while (current.request_role !== "surface") {
    if (
      current.discovered_from_request_id === null ||
      visited.has(current.request_id)
    ) {
      throw new Error(
        `Discovered Source Request ${request.request_id} has no closed root surface lineage.`,
      );
    }
    visited.add(current.request_id);
    const parent = requests.get(current.discovered_from_request_id);
    if (parent === undefined) {
      throw new Error(
        `Discovered Source Request ${request.request_id} names an unavailable parent.`,
      );
    }
    current = parent;
  }
  const prefix = `${row.source_lineage}:`;
  if (!current.request_id.startsWith(prefix)) {
    throw new Error(
      "Root Source Request identity does not match its retained lineage.",
    );
  }
  return current.request_id.slice(prefix.length);
}

function assertClosedRequestGraph(
  requests: readonly PlannedRequestRow[],
  rows: readonly EvidenceRow[],
  documents: readonly {
    observations: unknown[];
    evidenceSummary: {
      observation_count: number;
      declared_record_count: number;
      parsed_record_count: number;
    };
  }[],
): void {
  const byId = new Map(requests.map((request) => [request.request_id, request]));
  const rootSurfaces = new Map<string, Set<string>>();
  const listingLocators = new Map<string, string>();
  const listingPages = new Map<string, Set<number>>();
  requests.forEach((request, index) => {
    const row = rows[index]!;
    const document = documents[index]!;
    if (
      document.evidenceSummary.observation_count !==
        document.observations.length ||
      document.evidenceSummary.declared_record_count !==
        document.evidenceSummary.parsed_record_count
    ) {
      throw new Error(
        `Source Request ${request.request_id} has incomplete declared/parsed count closure.`,
      );
    }
    const adapter = requiredSourceAdapter(row.adapter_version);
    if (
      adapter.origin === "synthetic_fixture" &&
      row.plan_origin === "synthetic_fixture"
    ) {
      return;
    }
    if (
      adapter.origin !== "production" ||
      row.plan_origin !== "production"
    ) {
      throw new Error(
        `Source Request ${request.request_id} has mismatched graph authority.`,
      );
    }
    if (request.request_role === "surface") {
      const prefix = `${row.source_lineage}:`;
      if (
        request.discovered_from_request_id !== null ||
        !request.request_id.startsWith(prefix)
      ) {
        throw new Error("Root Source Request graph identity is invalid.");
      }
      const surface = request.request_id.slice(prefix.length);
      rootSurfaces.set(row.adapter_version, new Set([
        ...(rootSurfaces.get(row.adapter_version) ?? []),
        surface,
      ]));
      return;
    }
    if (request.discovered_from_request_id === null) {
      throw new Error(
        `Discovered Source Request ${request.request_id} has no parent.`,
      );
    }
    const parent = byId.get(request.discovered_from_request_id);
    if (parent === undefined) {
      throw new Error(
        `Discovered Source Request ${request.request_id} does not close over a retained parent.`,
      );
    }
    if (
      request.request_role === "image" &&
      document.observations.length !== 0
    ) {
      throw new Error("Printing Image requests cannot invent catalogue facts.");
    }
    if (
      (request.request_role === "detail" ||
        request.request_role === "product_detail") &&
      document.observations.length === 0
    ) {
      throw new Error(
        `Required ${request.request_role} request ${request.request_id} parsed no retained detail.`,
      );
    }
    if (request.request_role === "listing") {
      for (const observation of document.observations) {
        if (!isRecord(observation) || !isRecord(observation.value)) continue;
        const identity = observation.value.identity_evidence;
        if (!isRecord(identity) || typeof identity.locator !== "string") {
          continue;
        }
        const prior = listingLocators.get(identity.locator);
        if (prior !== undefined && prior !== request.request_id) {
          throw new Error(
            `Official Source leaf partitions overlap at locator ${identity.locator}.`,
          );
        }
        listingLocators.set(identity.locator, request.request_id);
      }
      const url = new URL(request.url);
      const pageEntry = [...url.searchParams.entries()].find(([key]) =>
        /^(?:page|paged|offset)$/u.test(key)
      );
      if (pageEntry !== undefined) {
        const page = Number.parseInt(pageEntry[1], 10);
        if (!Number.isInteger(page) || page < 0) {
          throw new Error("Official Source listing page identity is invalid.");
        }
        url.searchParams.delete(pageEntry[0]);
        const key = `${row.source_lineage}:${url.pathname}?${
          url.searchParams.toString()
        }`;
        listingPages.set(key, new Set([
          ...(listingPages.get(key) ?? []),
          page,
        ]));
      }
    }
  });
  for (const [partition, pages] of listingPages) {
    const ordered = [...pages].sort((left, right) => left - right);
    const firstPage = ordered[0]!;
    for (let page = firstPage; page <= ordered.at(-1)!; page += 1) {
      if (!pages.has(page)) {
        throw new Error(
          `Official Source listing partition ${partition} has unfinished page closure.`,
        );
      }
    }
  }
  for (const [adapterVersion, actual] of rootSurfaces) {
    const adapter = requiredSourceAdapter(adapterVersion);
    if (
      adapter.origin !== "production" ||
      adapter.reconciliationCapability === "unavailable"
    ) {
      throw new Error(
        `Official Source ${adapterVersion} has invalid production coverage authority.`,
      );
    }
    const expected = new Set(adapter.requiredSurfaces ?? []);
    if (
      actual.size !== expected.size ||
      [...expected].some((surface) => !actual.has(surface))
    ) {
      throw new Error(
        `Official Source ${adapterVersion} request graph does not close over every required root surface.`,
      );
    }
  }
}

async function attachRetainedPrintingImages(
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
  allowVerifiedNovelty: boolean,
): Promise<unknown> {
  if (!isRecord(value) || !isRecord(value.appearance_evidence)) return value;
  const declared = value.appearance_evidence.images;
  if (!Array.isArray(declared)) return value;
  const retainedImages = declared.map((item) => {
    if (!isRecord(item) || typeof item.source_url !== "string") return item;
    const retained = images.get(item.source_url);
    return retained === undefined ? item : { ...item, ...retained };
  });
  const complete =
    retainedImages.length > 0 &&
    retainedImages.every((item) =>
      isRecord(item) &&
      typeof item.role === "string" &&
      typeof item.content_sha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(item.content_sha256)
    );
  if (
    !complete ||
    !allowVerifiedNovelty ||
    !isRecord(value.identity_evidence)
  ) {
    return {
      ...value,
      appearance_evidence: {
        ...value.appearance_evidence,
        images: retainedImages,
      },
    };
  }
  const fingerprint = value.identity_evidence.artwork_fingerprint;
  if (typeof fingerprint !== "string" || fingerprint.length === 0) {
    throw new Error(
      "Retained Printing Image has no source-semantic artwork identity.",
    );
  }
  if (parsedOfficialArtworkIdentity(fingerprint) === null) {
    return {
      ...value,
      appearance_evidence: {
        ...value.appearance_evidence,
        images: retainedImages,
      },
    };
  }
  const firstImage = retainedImages[0]!;
  if (!isRecord(firstImage) || typeof firstImage.source_url !== "string") {
    throw new Error("Retained Printing Image source URL is invalid.");
  }
  return {
    ...value,
    identity_evidence: {
      ...value.identity_evidence,
      artwork_fingerprint: fingerprint,
      demonstrably_novel: true,
      novelty_basis: {
        kind: "official_printing_image",
        source_url: firstImage.source_url,
        artwork_fingerprint: fingerprint,
      },
    },
    appearance_evidence: {
      ...value.appearance_evidence,
      images: retainedImages.map((item) =>
        isRecord(item)
          ? { ...item, artwork_fingerprint: fingerprint }
          : item
      ),
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

function assertObservationAuthority(
  observation: ReturnType<typeof parseReconciliationObservation>,
  coverage: ReturnType<
    typeof requiredSourceAdapter
  >["reconciliationCapability"],
): void {
  const errataOnly = coverage === "errata";
  if (
    (observation.kind === "official_erratum") !== errataOnly ||
    (observation.kind === "card_printing" &&
      observation.errata.length > 0 &&
      coverage !== "catalogue")
  ) {
    throw new Error(
      "Retained Erratum authority conflicts with its exact Source Adapter coverage.",
    );
  }
}

function samePlannedRequest(
  request: PlannedRequestRow | undefined,
  planned: EvidencePlanRequest | Record<string, unknown> | undefined,
  sequenceNumber: number,
): boolean {
  if (request === undefined || planned === undefined) return false;
  return (
    request.sequence_number === sequenceNumber &&
    planned.id === request.request_id &&
    planned.method === request.method &&
    planned.url === request.url &&
    isRecord(planned.headers) &&
    canonicalJson(planned.headers) === request.request_headers_json &&
    planned.representation_fingerprint ===
      request.representation_fingerprint
  );
}

async function retainedObservationDocument(
  evidenceObjects: R2Bucket,
  row: EvidenceRow,
): Promise<{
  observations: unknown[];
  evidenceSummary: {
    observation_count: number;
    declared_record_count: number;
    parsed_record_count: number;
  };
}> {
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
    adapter.reconciliationCapability === "unavailable" ||
    row.plan_origin !== adapter.origin ||
    !isRecord(document.coverage_proof) ||
    document.coverage_proof.kind !== adapter.reconciliationCapability ||
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
  return {
    observations: document.observations,
    evidenceSummary: document.evidence_summary as {
      observation_count: number;
      declared_record_count: number;
      parsed_record_count: number;
    },
  };
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
    Number.isInteger(value.declared_record_count) &&
    Number.isInteger(value.parsed_record_count) &&
    value.declared_record_count === value.parsed_record_count
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
