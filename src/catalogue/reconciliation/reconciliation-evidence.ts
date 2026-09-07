import { ReconciliationInputSequence } from "./reconciliation-input-sequence";
import { ReconciliationContinuation } from "./reconciliation-continuation";
import {
  retainEvidenceSelection,
  retainedEvidenceSelection,
  retainedEvidenceSelectionRequest,
} from "./reconciliation-selection";
import { readSourceObservation } from "./reconciliation-source-observation";
import { reconciliationCheckpoint, retainReconciliationCheckpoint } from "./reconciliation-checkpoint";
import { assertClosedRequestGraph } from "./reconciliation-source-graph";
import { ReconciliationReducerIndex } from "./reconciliation-reducer-state";
import {
  readVerifiedReconciliationInput,
  retainVerifiedReconciliationInput,
  verifiedReconciliationRecords,
} from "./reconciliation-input";
import { documentStorage } from "./reconciliation-document";
import { prepareSourceDocuments, readSourceDocument } from "./reconciliation-source-document";
import { canonicalValueDigest } from "./reconciliation-preparation";
import {
  normalizedCardErrata,
  claimObservationOrigin,
  hasNormalizedObservation,
  retainNormalizedObservation,
  stagedNormalizedObservations,
} from "./reconciliation-normalized";
import { imageStorage, retainCandidateImage } from "./reconciliation-images";
import { adapterReconciliationAreas, parsedOfficialArtworkIdentity, requiredSourceAdapter } from "../adapters";
import {
  type CatalogueStore,
  canonicalJson,
  type SupportedGame,
  sha256,
  sha256Text,
  StreamingSha256,
  streamedObjectMembers,
} from "../shared";
import {
  isOptionalSourceOutage,
  assertSelectedAuthoritiesCollected,
  type EvidencePlanRequest,
  evidencePlanForRequest,
  parseEvidencePlans,
  printingImageRetriesExhaustedFailureCode,
  toleratesRequestFailure,
} from "../source-evidence";
import {
  unchangedAcceptedSourceStatement,
  reconciliationCollectionPlansStatement,
  reconciliationCollectionPlanChunkStatement,
  reconciliationEvidencePlanStatement,
  reconciliationObservationCountsStatement,
  reconciliationObservationSetsStatement,
  reconciliationOverflowRequestsStatement,
  reconciliationSnapshotEvidenceStatement,
  reconciliationSourceRequestsStatement,
  reconciliationSourceRequestStatement,
} from "./reconciliation-evidence-repository";
import { parseReconciliationObservation } from "./reconciliation-model";

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
  failure_code: string | null;
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
  snapshot_content_digest: string;
  content_byte_length: number;
  content_object_key: string;
  observation_count: number;
  plan_origin: string;
  snapshot_request_method: string;
  snapshot_request_url: string;
  snapshot_request_headers_json: string;
  snapshot_representation_fingerprint: string;
};

type EvidenceSelection = { request: PlannedRequestRow; row: EvidenceRow | null };

type PrintingImageSnapshotRow = {
  request_url: string;
  media_type: string | null;
  content_digest: string;
  content_byte_length: number;
  content_object_key: string;
};

type CollectionPlanRow = {
  source_lineage: string;
  discovery_observation_set_id: string;
  contract: string;
  content_digest: string;
};

type EvidencePlanRow = {
  request_plan_json: string;
};

type DiscoveryRequestPlanRow = {
  ingestion_run_id: string;
  request_id: string;
  sequence_number: number;
  parent_request_id: string;
  method: "GET";
  url: string;
  request_headers_json: string;
  representation_fingerprint: string;
  request_role: Exclude<PlannedRequestRow["request_role"], "surface">;
};

export type NormalizedReconciliationObservation = ReturnType<typeof parseReconciliationObservation> & {
  sourceObservationSetId: string;
  sourceSnapshotId: string;
  sourceCapturedAt: string;
  sourceLineage: string;
  sourceRequestRole: PlannedRequestRow["request_role"];
  sourceSurface: string | undefined;
  supportedGame: SupportedGame;
  structurallyComplete: true;
};

type CollectedReconciliationInput = Awaited<ReturnType<typeof collectRetainedReconciliationObservation>>;
type SequenceElement<T> = T extends Iterable<infer U> | AsyncIterable<infer U> ? U : never;
type MetadataSequence = "partitions" | "countChangeWarnings" | "unavailablePrintingImages" | "evidencePlans";

export async function retainedReconciliationObservation(
  database: CatalogueStore,
  evidenceObjects: R2Bucket,
  runId: string,
  printingImages: R2Bucket,
  yieldAtCheckpoint = false,
  snapshot?: Record<string, unknown>,
) {
  let retained = snapshot
    ? {
        ...snapshot,
        ...Object.fromEntries(
          ["countChangeWarnings", "unavailablePrintingImages", "partitions"].map((kind) => [
            kind,
            { [Symbol.asyncIterator]: () => verifiedReconciliationRecords(database, runId, kind) },
          ]),
        ),
        evidencePlans: {
          async *[Symbol.asyncIterator]() {
            yield* snapshot.evidencePlans as unknown[];
          },
        },
      }
    : await readVerifiedReconciliationInput(database, runId, yieldAtCheckpoint);
  if (!retained) {
    await prepareVerifiedReconciliationInput(database, evidenceObjects, runId, printingImages, yieldAtCheckpoint);
    retained = await readVerifiedReconciliationInput(database, runId, yieldAtCheckpoint);
  }
  if (!retained) throw new Error("The verified reconciliation input is unavailable.");
  return {
    ...retained,
    observations: () =>
      verifiedReconciliationRecords<NormalizedReconciliationObservation>(database, runId, "observations"),
    cardErrata: (game: string, identity: unknown) =>
      normalizedCardErrata<Extract<NormalizedReconciliationObservation, { kind: "official_erratum" }>>(
        database,
        runId,
        game,
        identity,
      ),
  } as Omit<CollectedReconciliationInput, MetadataSequence | "observations"> & {
    [K in MetadataSequence]: AsyncIterable<SequenceElement<CollectedReconciliationInput[K]>>;
  } & {
    observations: () => AsyncGenerator<NormalizedReconciliationObservation>;
    cardErrata: (
      game: string,
      identity: unknown,
    ) => AsyncGenerator<Extract<NormalizedReconciliationObservation, { kind: "official_erratum" }>>;
  };
}

async function prepareVerifiedReconciliationInput(
  database: CatalogueStore,
  evidenceObjects: R2Bucket,
  runId: string,
  printingImages: R2Bucket,
  yieldAtCheckpoint = false,
) {
  const input = await collectRetainedReconciliationObservation(
    database,
    evidenceObjects,
    runId,
    printingImages,
    yieldAtCheckpoint,
  );
  await retainVerifiedReconciliationInput(database, runId, input, yieldAtCheckpoint);
}

async function collectRetainedReconciliationObservation(
  database: CatalogueStore,
  evidenceObjects: R2Bucket,
  runId: string,
  printingImages: R2Bucket,
  yieldAtCheckpoint = false,
) {
  const evidencePlanRow = await documentStorage(() =>
    reconciliationEvidencePlanStatement(database, runId).first<EvidencePlanRow>(),
  );
  const pinned = await reconciliationCheckpoint<{ inputDigest: string; omittedLineages: string[] }>(
    database,
    runId,
    "input_selection",
  );
  const requests = {
    async *[Symbol.asyncIterator]() {
      if (pinned) {
        for await (const selection of retainedEvidenceSelection<EvidenceSelection>(database, runId))
          yield selection.request;
      } else yield* sourceRequests(database, runId);
    },
  };
  if (evidencePlanRow === null || (await requests[Symbol.asyncIterator]().next()).done) {
    throw new Error("Reconciliation requires complete coverage of every planned Source Request.");
  }
  const evidencePlans = parseEvidencePlans(evidencePlanRow.request_plan_json);
  const omittedLineages = new Set<string>(pinned?.value.omittedLineages);
  if (!pinned)
    for await (const request of requests) {
      const plan = evidencePlanForRequest(evidencePlanRow, request.request_id);
      if (request.state === "failed" && isOptionalSourceOutage(plan, request.failure_code))
        omittedLineages.add(plan.source_lineage);
    }
  const selectedPlans = evidencePlans.filter((plan) => !omittedLineages.has(plan.source_lineage));
  // Optional transport failure never excuses a parser/identity/retained-byte failure.
  if (!pinned)
    for await (const request of requests) {
      const plan = evidencePlanForRequest(evidencePlanRow, request.request_id);
      if (
        request.state === "failed" &&
        omittedLineages.has(plan.source_lineage) &&
        !isOptionalSourceOutage(plan, request.failure_code) &&
        !toleratesRequestFailure(request.request_role, request.failure_code)
      ) {
        throw new Error(
          `Optional Source ${plan.source_lineage} has blocking evidence failure ${request.failure_code}.`,
        );
      }
    }
  const unchangedAcceptedLineages = new Set<string>();
  if (!pinned)
    for (const plan of selectedPlans) {
      if (await unchangedAcceptedSourceStatement(database, runId, plan.source_lineage, plan.adapter_version).first())
        unchangedAcceptedLineages.add(plan.source_lineage);
    }
  if (!pinned) await assertSelectedAuthoritiesCollected(database, selectedPlans, unchangedAcceptedLineages, runId);
  const requestById = async (id: string) =>
    pinned
      ? (await retainedEvidenceSelectionRequest<EvidenceSelection>(database, runId, id))?.request
      : ((await documentStorage(() =>
          reconciliationSourceRequestStatement(database, runId, id).first<PlannedRequestRow>(),
        )) ?? undefined);
  const immutableRequestIds = new ReconciliationReducerIndex<boolean>(database, runId, "immutable_request_ids");
  let immutableCount = 0;
  const claimRequest = async (id: string) => {
    if (await immutableRequestIds.has(id)) return;
    await immutableRequestIds.seed(id, true);
    immutableCount++;
  };
  let rootRequestCount = 0;
  if (!pinned)
    for (const plan of evidencePlans)
      for (const planned of plan.requests) {
        rootRequestCount++;
        const request = await requestById(planned.id);
        if (!samePlannedRequest(request, planned, request?.sequence_number ?? -1))
          throw new Error("Operational Source Requests differ from the immutable Evidence Plan.");
        await claimRequest(planned.id);
      }
  if (!pinned && !rootRequestCount)
    throw new Error("Operational Source Requests differ from the immutable Evidence Plan.");
  const collectionSurfaces = new ReconciliationReducerIndex<boolean>(database, runId, "collection_request_ids");
  if (!pinned)
    for await (const collectionPlan of collectionPlans(database, runId)) {
      for await (const planned of retainedCollectionRequests(database, runId, collectionPlan)) {
        const id = planned.id as string;
        await claimRequest(id);
        await collectionSurfaces.seed(id, true);
        if (!omittedLineages.has(collectionPlan.source_lineage)) {
          const request = await requestById(id);
          if (
            !samePlannedRequest(request, planned, request?.sequence_number ?? -1) ||
            request === undefined ||
            (request.state === "failed" && toleratesRequestFailure(request.request_role, request.failure_code)) ||
            omittedLineages.has(evidencePlanForRequest(evidencePlanRow, id).source_lineage)
          )
            throw new Error("Official Source requests differ from the immutable Collection Plan.");
        }
      }
    }
  if (!pinned)
    for await (const planned of discoveryRequests(database, runId)) {
      await claimRequest(planned.request_id);
      const request = await requestById(planned.request_id);
      if (
        request === undefined ||
        request.sequence_number !== planned.sequence_number ||
        request.method !== planned.method ||
        request.url !== planned.url ||
        request.request_headers_json !== planned.request_headers_json ||
        request.representation_fingerprint !== planned.representation_fingerprint ||
        request.request_role !== planned.request_role ||
        request.discovered_from_request_id !== planned.parent_request_id
      )
        throw new Error("Operational Source Requests differ from their immutable request plans.");
    }
  const isToleratedImageFailure = (request: PlannedRequestRow): boolean =>
    request.state === "failed" && toleratesRequestFailure(request.request_role, request.failure_code);
  const isSelected = (request: PlannedRequestRow) =>
    !isToleratedImageFailure(request) &&
    !omittedLineages.has(evidencePlanForRequest(evidencePlanRow, request.request_id).source_lineage);
  const selectedRequestById = async (id: string) => {
    const request = await requestById(id);
    return request !== undefined && isSelected(request) ? request : undefined;
  };
  type MetadataCursor =
    | { stage: "requests"; sequenceNumber: number; requestId: string }
    | { stage: "suffix"; index: number };
  const metadataSequence = <T>(project: (selection: EvidenceSelection) => Promise<T[]>, suffix: T[] = []) =>
    new ReconciliationInputSequence<T, MetadataCursor>(async function* (after) {
      if (after?.stage !== "suffix")
        for await (const selection of retainedEvidenceSelection<EvidenceSelection>(database, runId, after ?? undefined))
          yield {
            cursor: {
              stage: "requests",
              sequenceNumber: selection.request.sequence_number,
              requestId: selection.request.request_id,
            },
            records: await project(selection),
          };
      for (let index = after?.stage === "suffix" ? after.index + 1 : 0; index < suffix.length; index++)
        yield { cursor: { stage: "suffix", index }, records: [suffix[index]!] };
    });
  const unavailablePrintingImages = metadataSequence(async ({ request }) =>
    isToleratedImageFailure(request)
      ? [
          {
            requestId: request.request_id,
            sourceUrl: request.url,
            sourceLineage: evidencePlanForRequest(evidencePlanRow, request.request_id).source_lineage,
            failureCode: request.failure_code ?? printingImageRetriesExhaustedFailureCode,
          },
        ]
      : [],
  );
  if (!pinned) {
    const selectedSnapshots = new ReconciliationReducerIndex<boolean>(database, runId, "selected_snapshot_ids");
    let requestCount = 0;
    let selectedCount = 0;
    for await (const request of requests) {
      requestCount++;
      if (!(await immutableRequestIds.has(request.request_id)))
        throw new Error("Operational Source Requests differ from their immutable request plans.");
      if (!isSelected(request)) continue;
      selectedCount++;
      if (request.state !== "observed" || request.source_snapshot_id === null)
        throw new Error(`Planned Source Request ${request.request_id} has no observed Source Snapshot.`);
      if (await selectedSnapshots.has(request.source_snapshot_id))
        throw new Error("Planned Source Requests selected a duplicate Source Snapshot.");
      await selectedSnapshots.seed(request.source_snapshot_id, true);
    }
    if (requestCount !== immutableCount || rootRequestCount > requestCount)
      throw new Error("Operational Source Requests differ from their immutable request plans.");
    if (!selectedCount) throw new Error("No independently complete Source Coverage remains in this refresh.");
    for await (const row of evidenceRows(database, runId)) {
      if (!omittedLineages.has(row.source_lineage) && !(await selectedSnapshots.has(row.source_snapshot_id)))
        throw new Error(
          `Unplanned Source Observation Set ${row.observation_set_id} cannot participate in reconciliation.`,
        );
    }
  }
  const evidenceAfter = async function* (after?: { sequenceNumber: number; requestId: string; complete?: boolean }) {
    if (pinned) {
      for await (const selection of retainedEvidenceSelection<EvidenceSelection>(database, runId, after))
        if (selection.row !== null) yield { request: selection.request, row: selection.row };
      return;
    }
    for await (const request of sourceRequests(
      database,
      runId,
      after?.sequenceNumber,
      after?.requestId,
      after?.complete === false,
    )) {
      if (!isSelected(request)) continue;
      const rows = evidenceRows(database, runId, request.source_snapshot_id!);
      const first = await rows.next();
      if (first.done || !(await rows.next()).done)
        throw new Error(
          `Planned Source Request ${request.request_id} requires exactly one collection Source Observation Set.`,
        );
      const row = first.value;
      const plan = evidencePlanForRequest(evidencePlanRow, row.request_id);
      if (
        row.request_id !== request.request_id ||
        row.snapshot_request_method !== request.method ||
        row.snapshot_request_url !== request.url ||
        row.snapshot_representation_fingerprint !== request.representation_fingerprint
      )
        throw new Error("Retained Source Snapshot provenance differs from its immutable Source Request.");
      if (
        row.source_lineage !== plan.source_lineage ||
        row.supported_game !== plan.supported_game ||
        row.game_profile_version !== plan.game_profile_version ||
        row.adapter_version !== plan.adapter_version
      )
        throw new Error("Retained Source Observation Set provenance is inconsistent with its Evidence Plan.");
      if (row.content_byte_length > requiredSourceAdapter(row.adapter_version).maximumSnapshotBytes)
        throw new Error(`Retained Source Observation Set ${row.observation_set_id} exceeds its adapter byte limit.`);
      yield { request, row };
    }
  };
  const selectedEvidence = { [Symbol.asyncIterator]: () => evidenceAfter() };
  const orderedRows = {
    async *[Symbol.asyncIterator]() {
      for await (const { row } of selectedEvidence) yield row;
    },
  };
  const first = (await orderedRows[Symbol.asyncIterator]().next()).value!;
  let inputDigest =
    pinned?.value.inputDigest ??
    (await canonicalValueDigest({ evidencePlanRow, omittedLineages: [...omittedLineages] }));
  if (!pinned) {
    for await (const evidence of selectedEvidence) {
      inputDigest = await canonicalValueDigest({ previous: inputDigest, evidence });
      await retainEvidenceSelection(
        database,
        runId,
        evidence.request.request_id,
        evidence.request.sequence_number,
        evidence,
      );
    }
    for await (const request of requests)
      if (!isSelected(request))
        await retainEvidenceSelection(database, runId, request.request_id, request.sequence_number, {
          request,
          row: null,
        });
    for (const plan of selectedPlans)
      await validateOfficialSurfaceCoverage({
        adapter: requiredSourceAdapter(plan.adapter_version),
        plan,
        hasCollectionRequest: (id) => collectionSurfaces.has(id),
      });
    await retainReconciliationCheckpoint(database, runId, "input_selection", 0, {
      inputDigest,
      omittedLineages: [...omittedLineages],
    });
  }
  const graph = await reconciliationCheckpoint<{ inputDigest: string }>(database, runId, "source_graph");
  const loadDocument = (row: EvidenceRow) => retainedObservationDocument(database, runId, row);
  if (graph) {
    if (graph.value.inputDigest !== inputDigest)
      throw new Error("Verified Source graph checkpoint provenance changed.");
  } else {
    await prepareSourceDocuments(
      database,
      evidenceObjects,
      runId,
      inputDigest,
      evidenceAfter,
      validateObservationDocument,
      yieldAtCheckpoint,
    );
    await assertClosedRequestGraph(
      database,
      runId,
      inputDigest,
      evidenceAfter,
      loadDocument,
      selectedRequestById,
      yieldAtCheckpoint,
    );
    await retainReconciliationCheckpoint(database, runId, "source_graph", 0, { inputDigest });
    if (yieldAtCheckpoint) throw new ReconciliationContinuation({ phase: "source_graph", ordinal: 0 });
  }
  const normalized = await reconciliationCheckpoint<{
    inputDigest: string;
    sequenceNumber: number;
    requestId: string;
    observationSetId: string;
    nextObservationOrdinal: number;
    complete: boolean;
    officialSurfaceSeen: boolean;
  }>(database, runId, "normalization");
  if (normalized && normalized.value.inputDigest !== inputDigest)
    throw new Error("Normalization checkpoint provenance changed.");
  let checkpointOrdinal = (normalized?.ordinal ?? -1) + 1;
  for await (const { request, row } of evidenceAfter(normalized?.value)) {
    const continuingDocument = normalized?.value.requestId === request.request_id && !normalized.value.complete;
    let officialSurfaceSeen = continuingDocument ? normalized!.value.officialSurfaceSeen : false;
    const sourceSurface = await sourceSurfaceForRequest(request, selectedRequestById, row);
    const normalize = async (wrapped: unknown, sourceOrdinal: number) => {
      if (!isRecord(wrapped) || typeof wrapped.id !== "string") {
        throw new Error("Retained Source Observation identity is invalid.");
      }
      await claimObservationOrigin(database, runId, wrapped.id, row.observation_set_id, sourceOrdinal);
      if (isRecord(wrapped.value) && wrapped.value.observation_type === "official_surface_evidence") {
        if (typeof wrapped.value.surface !== "string" || !Array.isArray(wrapped.value.records) || officialSurfaceSeen) {
          throw new Error("Retained Official Source surface evidence is invalid or duplicated.");
        }
        officialSurfaceSeen = true;
        return;
      }
      if (await hasNormalizedObservation(database, runId, wrapped.id)) return;
      let parsed = parseReconciliationObservation(
        wrapped.id,
        await attachRetainedPrintingImages(
          wrapped.value,
          async (url) => {
            const image = await imageStorage(() =>
              reconciliationSnapshotEvidenceStatement(database, runId, url, row.source_lineage).first<
                PrintingImageSnapshotRow & { selection_content: string; selection_sha256: string }
              >(),
            );
            if (image && (await sha256Text(image.selection_content)) !== image.selection_sha256)
              throw new Error("Retained image evidence selection failed integrity verification.");
            return image;
          },
          evidenceObjects,
          row.plan_origin === "production",
        ),
      );
      if (parsed.kind === "card_printing") {
        const references = [];
        for (const image of parsed.printingImages) references.push(await retainCandidateImage(printingImages, image));
        parsed = { ...parsed, printingImages: references };
      }
      const adapter = requiredSourceAdapter(row.adapter_version);
      assertObservationAuthority(parsed, adapter, sourceSurface);
      await retainNormalizedObservation(
        database,
        runId,
        wrapped.id,
        {
          ...parsed,
          sourceObservationSetId: row.observation_set_id,
          sourceSnapshotId: row.source_snapshot_id,
          sourceCapturedAt: row.retrieved_at,
          sourceLineage: row.source_lineage,
          sourceRequestRole: request.request_role,
          sourceSurface,
          supportedGame: supportedGame(row.supported_game),
          structurallyComplete: true,
        },
        parsed.kind === "official_erratum" && parsed.target.type === "card" && parsed.appliesToParallelPrintings
          ? { game: parsed.game, officialIdentity: parsed.target.officialIdentity }
          : null,
      );
    };
    const startOrdinal = continuingDocument ? normalized!.value.nextObservationOrdinal : 0;
    for (let sourceOrdinal = startOrdinal; sourceOrdinal < row.observation_count; sourceOrdinal++) {
      await normalize(
        await readSourceObservation(database, runId, row.observation_set_id, sourceOrdinal),
        sourceOrdinal,
      );
      if ((sourceOrdinal + 1) % 8 === 0 && sourceOrdinal + 1 < row.observation_count) {
        await retainReconciliationCheckpoint(database, runId, "normalization", checkpointOrdinal++, {
          inputDigest,
          sequenceNumber: request.sequence_number,
          requestId: request.request_id,
          observationSetId: row.observation_set_id,
          nextObservationOrdinal: sourceOrdinal + 1,
          complete: false,
          officialSurfaceSeen,
        });
        if (yieldAtCheckpoint)
          throw new ReconciliationContinuation({ phase: "normalization", ordinal: checkpointOrdinal - 1 });
      }
    }
    await retainReconciliationCheckpoint(database, runId, "normalization", checkpointOrdinal++, {
      inputDigest,
      sequenceNumber: request.sequence_number,
      requestId: request.request_id,
      observationSetId: row.observation_set_id,
      nextObservationOrdinal: row.observation_count,
      complete: true,
      officialSurfaceSeen,
    });
    if (yieldAtCheckpoint)
      throw new ReconciliationContinuation({ phase: "normalization", ordinal: checkpointOrdinal - 1 });
  }
  const partitions = metadataSequence(async ({ request, row }) =>
    row === null
      ? []
      : [
          {
            sequenceNumber: request.sequence_number,
            requestId: request.request_id,
            observationSetId: row.observation_set_id,
            sourceSnapshotId: row.source_snapshot_id,
            sourceLineage: row.source_lineage,
            supportedGame: row.supported_game,
            gameProfileVersion: row.game_profile_version,
            adapterVersion: row.adapter_version,
          },
        ],
  );
  const countChangeWarnings = metadataSequence<Record<string, unknown>>(
    async ({ row }) => {
      const warnings: Record<string, unknown>[] = [];
      if (row !== null)
        for await (const warning of sourceObservationCountChangeWarnings(database, runId, [row]))
          warnings.push(warning);
      return warnings;
    },
    evidencePlans
      .filter((plan) => omittedLineages.has(plan.source_lineage))
      .map((plan) => ({
        code: "optional_source_carried_forward",
        source_lineage: plan.source_lineage,
        coverage: plan.coverage,
        detail:
          "The optional Source Coverage was not completely checked. Prior accepted facts and their evidence/check dates carry forward; partial captures establish no disappearance.",
      })),
  );
  return {
    observationSetId: first.observation_set_id,
    sourceSnapshotId: first.source_snapshot_id,
    sourceLineage: first.source_lineage,
    supportedGame: supportedGame(first.supported_game),
    reconciliationCapability: requiredSourceAdapter(first.adapter_version).reconciliationCapability,
    structurallyComplete: true,
    countChangeWarnings,
    unavailablePrintingImages,
    partitions,
    evidencePlans: selectedPlans.map((plan) => {
      return {
        sourceLineage: plan.source_lineage,
        supportedGame: supportedGame(plan.supported_game),
        adapterVersion: plan.adapter_version,
        reconciliationCapability: requiredSourceAdapter(plan.adapter_version).reconciliationCapability,
      };
    }),
    observations: stagedNormalizedObservations<NormalizedReconciliationObservation>(database, runId),
  };
}

async function* sourceObservationCountChangeWarnings(
  database: CatalogueStore,
  runId: string,
  currentRows: Iterable<EvidenceRow> | AsyncIterable<EvidenceRow>,
): AsyncGenerator<Record<string, unknown>> {
  for await (const row of currentRows) {
    const prior = await documentStorage(() =>
      reconciliationObservationCountsStatement(
        database,
        runId,
        row.source_lineage,
        row.adapter_version,
        row.request_id,
      ).first<{ observation_count: number }>(),
    );
    const previousCount = prior?.observation_count;
    const policy = requiredSourceAdapter(row.adapter_version).coverageLossThreshold;
    const threshold =
      previousCount === undefined
        ? null
        : Math.max(policy?.absolute ?? 25, Math.ceil(previousCount * (policy?.fraction ?? 0.2)));
    const absoluteDelta = previousCount === undefined ? null : Math.abs(row.observation_count - previousCount);
    if (previousCount !== undefined && threshold !== null && previousCount - row.observation_count >= threshold) {
      throw new Error(
        `Unexplained Source Coverage loss for ${row.source_lineage}/${row.request_id}: ${previousCount} to ${row.observation_count} observations. Completeness is blocked; inspect retained evidence and explicitly select an independently complete narrower scope or repair the adapter.`,
      );
    }
    if (previousCount === undefined || threshold === null || absoluteDelta === null || absoluteDelta < threshold)
      continue;
    yield {
      code: "source_observation_count_changed",
      semantic_effect: "additions",
      source_lineage: row.source_lineage,
      request_id: row.request_id,
      previous_count: previousCount,
      current_count: row.observation_count,
      absolute_delta: absoluteDelta,
      warning_threshold: threshold,
      detail: `Official Source request ${row.request_id} changed by ${absoluteDelta} parsed observations since the prior published snapshot, meeting the review threshold of ${threshold}.`,
    };
  }
}

async function validateOfficialSurfaceCoverage(input: {
  adapter: ReturnType<typeof requiredSourceAdapter>;
  plan: ReturnType<typeof parseEvidencePlans>[number];
  hasCollectionRequest: (id: string) => Promise<boolean>;
}): Promise<void> {
  const { adapter, plan } = input;
  if (adapter.origin !== "production" || adapter.reconciliationCapability !== "catalogue") {
    return;
  }
  for (const surface of adapter.requiredSurfaces ?? []) {
    const id = `${adapter.sourceLineage}:${surface}`;
    if (!(await input.hasCollectionRequest(id)) && !plan.requests.some((request) => request.id === id))
      throw new Error("Complete Official Source evidence omitted a required live surface.");
  }
}

async function sourceSurfaceForRequest(
  request: PlannedRequestRow,
  requestById: (id: string) => Promise<PlannedRequestRow | undefined>,
  row: Pick<EvidenceRow, "adapter_version" | "plan_origin" | "source_lineage">,
): Promise<string | undefined> {
  let current = request;
  // Brent cycle detection keeps the parent walk bounded in memory.
  let checkpoint = current.request_id;
  let power = 1;
  let distance = 0;
  while (current.request_role !== "surface") {
    if (current.discovered_from_request_id === null) {
      throw new Error(`Discovered Source Request ${request.request_id} has no closed root surface lineage.`);
    }
    const parent = await requestById(current.discovered_from_request_id);
    if (parent === undefined) {
      throw new Error(`Discovered Source Request ${request.request_id} names an unavailable parent.`);
    }
    current = parent;
    distance++;
    if (current.request_id === checkpoint)
      throw new Error(`Discovered Source Request ${request.request_id} has no closed root surface lineage.`);
    if (distance === power) {
      checkpoint = current.request_id;
      power *= 2;
      distance = 0;
    }
  }
  const prefix = `${row.source_lineage}:`;
  if (!current.request_id.startsWith(prefix)) {
    throw new Error("Root Source Request identity does not match its retained lineage.");
  }
  return current.request_id.slice(prefix.length);
}

export {
  validateGundamListingCollectionGraph,
  type GundamListingCollectionGraphInput,
} from "./reconciliation-listing-page";

async function attachRetainedPrintingImages(
  value: unknown,
  imageAtUrl: (url: string) => Promise<PrintingImageSnapshotRow | null>,
  evidenceObjects: R2Bucket,
  allowVerifiedNovelty: boolean,
): Promise<unknown> {
  if (!isRecord(value) || !isRecord(value.appearance_evidence)) return value;
  const declared = value.appearance_evidence.images;
  if (!Array.isArray(declared)) return value;
  const retainedImages = [];
  for (const item of declared) {
    if (!isRecord(item) || typeof item.source_url !== "string") {
      retainedImages.push(item);
      continue;
    }
    const retained = await imageAtUrl(item.source_url);
    retainedImages.push(
      retained === null ? item : { ...item, ...(await retainedPrintingImage(evidenceObjects, retained)) },
    );
  }
  const complete =
    retainedImages.length > 0 &&
    retainedImages.every(
      (item) =>
        isRecord(item) &&
        typeof item.role === "string" &&
        typeof item.content_sha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(item.content_sha256),
    );
  if (!complete || !allowVerifiedNovelty || !isRecord(value.identity_evidence)) {
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
    throw new Error("Retained Printing Image has no source-semantic artwork identity.");
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
      images: retainedImages.map((item) => (isRecord(item) ? { ...item, artwork_fingerprint: fingerprint } : item)),
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
  const object = await imageStorage(() => evidenceObjects.get(row.content_object_key));
  if (object === null || object.size !== row.content_byte_length) {
    throw new Error("Retained Printing Image bytes are unavailable.");
  }
  const bytes = new Uint8Array(await imageStorage(() => object.arrayBuffer()));
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

function imageDimensions(bytes: Uint8Array, mediaType: string): { width: number; height: number } {
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
  if (mediaType === "image/gif" && bytes.byteLength >= 10 && String.fromCharCode(...bytes.subarray(0, 3)) === "GIF") {
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
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
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
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
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
  adapter: ReturnType<typeof requiredSourceAdapter>,
  sourceSurface: string | undefined,
): void {
  const coverage = adapterReconciliationAreas(adapter);
  const errataOnly = adapter.reconciliationCapability === "errata";
  const catalogueErratum =
    adapter.reconciliationCapability === "catalogue" &&
    adapter.origin === "production" &&
    sourceSurface === "errata" &&
    (coverage.includes("errata") || adapter.reconciliationAreas === undefined);
  if (
    (observation.kind === "official_erratum" ? !errataOnly && !catalogueErratum : errataOnly) ||
    (observation.kind === "card_printing" && !coverage.includes("catalogue"))
  ) {
    throw new Error("Retained Erratum authority conflicts with its exact Source Adapter coverage.");
  }
}

async function* sourceRequests(
  database: CatalogueStore,
  runId: string,
  sequence = -1,
  id = "",
  includeCurrent = false,
): AsyncGenerator<PlannedRequestRow> {
  if (includeCurrent) {
    const current = await documentStorage(() =>
      reconciliationSourceRequestStatement(database, runId, id).first<PlannedRequestRow>(),
    );
    if (!current || current.sequence_number !== sequence)
      throw new Error("Normalization checkpoint names an unavailable Source Request.");
    yield current;
  }
  while (true) {
    const row = await documentStorage(() =>
      reconciliationSourceRequestsStatement(database, runId, sequence, id).first<PlannedRequestRow>(),
    );
    if (!row) return;
    sequence = row.sequence_number;
    id = row.request_id;
    yield row;
  }
}
async function* discoveryRequests(database: CatalogueStore, runId: string): AsyncGenerator<DiscoveryRequestPlanRow> {
  let sequence = -1,
    id = "";
  while (true) {
    const row = await documentStorage(() =>
      reconciliationOverflowRequestsStatement(database, runId, sequence, id).first<DiscoveryRequestPlanRow>(),
    );
    if (!row) return;
    sequence = row.sequence_number;
    id = row.request_id;
    yield row;
  }
}
async function* evidenceRows(
  database: CatalogueStore,
  runId: string,
  snapshotId: string | null = null,
): AsyncGenerator<EvidenceRow> {
  let id = "";
  while (true) {
    const row = await documentStorage(() =>
      reconciliationObservationSetsStatement(database, runId, id, snapshotId).first<EvidenceRow>(),
    );
    if (!row) return;
    id = row.observation_set_id;
    yield row;
  }
}
async function* collectionPlans(database: CatalogueStore, runId: string): AsyncGenerator<CollectionPlanRow> {
  let lineage = "";
  while (true) {
    const row = await documentStorage(() =>
      reconciliationCollectionPlansStatement(database, runId, lineage).first<CollectionPlanRow>(),
    );
    if (!row) return;
    lineage = row.source_lineage;
    yield row;
  }
}
async function* retainedCollectionRequests(
  database: CatalogueStore,
  runId: string,
  retained: CollectionPlanRow,
): AsyncGenerator<Record<string, unknown>> {
  if (retained.contract !== "card-keepr-official-source-collection-plan@1")
    throw new Error("Official Source Collection Plan failed immutable artifact verification.");
  const chunks = async function* () {
    for (let offset = 1; ; offset += 32768) {
      const row = await documentStorage(() =>
        reconciliationCollectionPlanChunkStatement(database, runId, retained.source_lineage, offset).first<{
          content: string;
        }>(),
      );
      if (!row) throw new Error("Official Source Collection Plan failed immutable artifact verification.");
      if (!row.content) return;
      yield row.content;
    }
  };
  const digest = new StreamingSha256();
  for await (const chunk of chunks()) digest.update(new TextEncoder().encode(chunk));
  if (digest.digestHex() !== retained.content_digest)
    throw new Error("Official Source Collection Plan failed immutable artifact verification.");
  const identities = new ReconciliationReducerIndex<boolean>(
    database,
    runId,
    `collection_plan_ids_${retained.source_lineage}`,
  );
  let contract = false,
    requests = false,
    lineage = false;
  for await (const member of streamedObjectMembers(chunks())) {
    if (member.key === "contract" && member.kind === "value" && !member.array)
      contract = member.value === retained.contract;
    else if (member.key === "source_lineage" && member.kind === "value" && !member.array)
      lineage = member.value === retained.source_lineage;
    else if (member.key === "requests" && member.kind === "array") requests = true;
    else if (member.key === "requests" && member.kind === "value" && member.array) {
      const value = member.value;
      if (
        !isRecord(value) ||
        typeof value.id !== "string" ||
        typeof value.surface !== "string" ||
        value.surface.length === 0 ||
        (await identities.has(value.id))
      )
        throw new Error("Official Source Collection Plan request is malformed.");
      await identities.seed(value.id, true);
      yield value;
    }
  }
  if (!contract || !requests) throw new Error("Official Source Collection Plan is malformed.");
  if (!lineage) throw new Error("Official Source Collection Plan lineage ownership is invalid.");
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
    planned.representation_fingerprint === request.representation_fingerprint
  );
}

async function retainedObservationDocument(database: CatalogueStore, runId: string, row: EvidenceRow) {
  const document = await readSourceDocument(database, runId, row);
  validateObservationDocument(row, document.values, document.observationCount);
  return {
    observations: document.observations,
    observationCount: document.observationCount,
    evidenceSummary: document.values.evidence_summary as {
      observation_count: number;
      declared_record_count: number;
      parsed_record_count: number;
      structurally_complete: boolean;
      required_surfaces_complete: boolean;
      partitions_complete: boolean;
    },
  };
}
function validateObservationDocument(row: EvidenceRow, document: Record<string, unknown>, observationCount: number) {
  const adapter = requiredSourceAdapter(row.adapter_version);
  if (row.content_byte_length > adapter.maximumSnapshotBytes)
    throw new Error(`Retained Source Observation Set ${row.observation_set_id} exceeds its adapter byte limit.`);
  if (
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
    !validEvidenceSummary(document.evidence_summary, observationCount, row.observation_count) ||
    document.observations !== true
  )
    throw new Error("Retained Source Observation Set provenance is invalid.");
}
function validEvidenceSummary(value: unknown, observed: number, observationCount: number): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.structurally_complete === "boolean" &&
    typeof value.required_surfaces_complete === "boolean" &&
    typeof value.partitions_complete === "boolean" &&
    observationCount === observed &&
    value.observation_count === observationCount &&
    Number.isSafeInteger(value.declared_record_count) &&
    Number(value.declared_record_count) >= 0 &&
    Number.isSafeInteger(value.parsed_record_count) &&
    Number(value.parsed_record_count) >= 0
  );
}

function supportedGame(value: string): SupportedGame {
  if (value !== "one-piece" && value !== "fusion-world" && value !== "digimon" && value !== "gundam") {
    throw new Error("Retained Source Observation Set game is unsupported.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
