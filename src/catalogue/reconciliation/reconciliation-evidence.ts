import {
  readVerifiedReconciliationInput,
  retainVerifiedReconciliationInput,
  verifiedReconciliationObservations,
} from "./reconciliation-input";
import { documentStorage, readVerifiedSourceDocument, retainVerifiedSourceDocument } from "./reconciliation-document";
import { canonicalValueDigest } from "./reconciliation-preparation";
import {
  normalizedCardErrata,
  claimObservationOrigin,
  hasNormalizedObservation,
  retainNormalizedObservation,
  stagedNormalizedObservations,
} from "./reconciliation-normalized";
import { retainCandidateImage } from "./reconciliation-images";
import { adapterReconciliationAreas, parsedOfficialArtworkIdentity, requiredSourceAdapter } from "../adapters";
import { type CatalogueStore, canonicalJson, type SupportedGame, sha256 } from "../shared";
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
  reconciliationEvidencePlanStatement,
  reconciliationObservationCountsStatement,
  reconciliationObservationSetsStatement,
  reconciliationOverflowRequestsStatement,
  reconciliationSnapshotEvidenceStatement,
  reconciliationSourceRequestsStatement,
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
  source_lineage: string;
  discovery_observation_set_id: string;
  contract: string;
  collection_plan_json: string;
  content_digest: string;
};

type EvidencePlanRow = {
  request_plan_json: string;
};

type PriorObservationCountRow = {
  adapter_version: string;
  request_id: string;
  source_lineage: string;
  observation_count: number;
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

const maximumAggregateReconciliationBytes = 32 * 1024 * 1024;

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

export async function retainedReconciliationObservation(
  database: CatalogueStore,
  evidenceObjects: R2Bucket,
  runId: string,
  printingImages: R2Bucket,
) {
  let retained = await readVerifiedReconciliationInput(database, runId);
  if (!retained) {
    await prepareVerifiedReconciliationInput(database, evidenceObjects, runId, printingImages);
    retained = await readVerifiedReconciliationInput(database, runId);
  }
  if (!retained) throw new Error("The verified reconciliation input is unavailable.");
  return {
    ...retained,
    observations: () => verifiedReconciliationObservations<NormalizedReconciliationObservation>(database, runId),
    cardErrata: (game: string, identity: unknown) =>
      normalizedCardErrata<Extract<NormalizedReconciliationObservation, { kind: "official_erratum" }>>(
        database,
        runId,
        game,
        identity,
      ),
  } as Omit<Awaited<ReturnType<typeof collectRetainedReconciliationObservation>>, "observations"> & {
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
) {
  const input = await collectRetainedReconciliationObservation(database, evidenceObjects, runId, printingImages);
  await retainVerifiedReconciliationInput(database, runId, input);
}

async function collectRetainedReconciliationObservation(
  database: CatalogueStore,
  evidenceObjects: R2Bucket,
  runId: string,
  printingImages: R2Bucket,
) {
  const [requests, observations, printingImageSnapshots, collectionPlans, evidencePlanRow, discoveryRequestPlans] =
    await Promise.all([
      reconciliationSourceRequestsStatement(database, runId).all<PlannedRequestRow>(),
      reconciliationObservationSetsStatement(database, runId).all<EvidenceRow>(),
      reconciliationSnapshotEvidenceStatement(database, runId).all<PrintingImageSnapshotRow>(),
      reconciliationCollectionPlansStatement(database, runId).all<CollectionPlanRow>(),
      reconciliationEvidencePlanStatement(database, runId).first<EvidencePlanRow>(),
      reconciliationOverflowRequestsStatement(database, runId).all<DiscoveryRequestPlanRow>(),
    ]);
  if (requests.results.length === 0 || evidencePlanRow === null) {
    throw new Error("Reconciliation requires complete coverage of every planned Source Request.");
  }
  const evidencePlans = parseEvidencePlans(evidencePlanRow.request_plan_json);
  const omittedLineages = new Set(
    requests.results
      .filter(
        (request) =>
          request.state === "failed" &&
          isOptionalSourceOutage(evidencePlanForRequest(evidencePlanRow, request.request_id), request.failure_code),
      )
      .map((request) => evidencePlanForRequest(evidencePlanRow, request.request_id).source_lineage),
  );
  const selectedPlans = evidencePlans.filter((plan) => !omittedLineages.has(plan.source_lineage));
  // Optional transport failure never excuses a parser/identity/retained-byte failure.
  for (const request of requests.results) {
    const plan = evidencePlanForRequest(evidencePlanRow, request.request_id);
    if (
      request.state === "failed" &&
      omittedLineages.has(plan.source_lineage) &&
      !isOptionalSourceOutage(plan, request.failure_code) &&
      !toleratesRequestFailure(request.request_role, request.failure_code)
    ) {
      throw new Error(`Optional Source ${plan.source_lineage} has blocking evidence failure ${request.failure_code}.`);
    }
  }
  const unchangedAcceptedLineages = new Set<string>();
  for (const plan of selectedPlans) {
    if (await unchangedAcceptedSourceStatement(database, runId, plan.source_lineage, plan.adapter_version).first())
      unchangedAcceptedLineages.add(plan.source_lineage);
  }
  await assertSelectedAuthoritiesCollected(database, selectedPlans, unchangedAcceptedLineages, runId);
  const plannedRequests = evidencePlans.flatMap((plan) => plan.requests);
  if (
    plannedRequests.length === 0 ||
    plannedRequests.length > requests.results.length ||
    plannedRequests.some((planned) => {
      const request = requests.results.find(({ request_id: requestId }) => requestId === planned.id);
      return !samePlannedRequest(request, planned, request?.sequence_number ?? -1);
    })
  ) {
    throw new Error("Operational Source Requests differ from the immutable Evidence Plan.");
  }
  const collectionRequests = (await Promise.all(collectionPlans.results.map(retainedCollectionRequests))).flat();
  const immutableRequestIds = new Set([
    ...plannedRequests.map(({ id }) => id),
    ...collectionRequests.map(({ id }) => id as string),
    ...discoveryRequestPlans.results.map(({ request_id }) => request_id),
  ]);
  if (
    immutableRequestIds.size !== requests.results.length ||
    requests.results.some(({ request_id: requestId }) => !immutableRequestIds.has(requestId)) ||
    discoveryRequestPlans.results.some((planned) => {
      const request = requests.results.find(({ request_id: requestId }) => requestId === planned.request_id);
      return (
        request === undefined ||
        request.sequence_number !== planned.sequence_number ||
        request.method !== planned.method ||
        request.url !== planned.url ||
        request.request_headers_json !== planned.request_headers_json ||
        request.representation_fingerprint !== planned.representation_fingerprint ||
        request.request_role !== planned.request_role ||
        request.discovered_from_request_id !== planned.parent_request_id
      );
    })
  ) {
    throw new Error("Operational Source Requests differ from their immutable request plans.");
  }
  // A Printing Image whose transport retries were exhausted is a tolerated
  // failure: it takes no part in the observed evidence graph and is carried
  // out explicitly so the candidate records the gap instead of failing.
  const isToleratedImageFailure = (request: PlannedRequestRow): boolean =>
    request.state === "failed" && toleratesRequestFailure(request.request_role, request.failure_code);
  const unavailablePrintingImages = requests.results.filter(isToleratedImageFailure).map((request) => ({
    requestId: request.request_id,
    sourceUrl: request.url,
    sourceLineage: evidencePlanForRequest({ request_plan_json: evidencePlanRow.request_plan_json }, request.request_id)
      .source_lineage,
    failureCode: request.failure_code ?? printingImageRetriesExhaustedFailureCode,
  }));
  const retainedRequests = requests.results.filter(
    (request) =>
      !isToleratedImageFailure(request) &&
      !omittedLineages.has(evidencePlanForRequest(evidencePlanRow, request.request_id).source_lineage),
  );
  if (retainedRequests.length === 0)
    throw new Error("No independently complete Source Coverage remains in this refresh.");
  const selectedObservations = observations.results.filter((row) => !omittedLineages.has(row.source_lineage));
  const selectedSnapshots = new Map<string, PlannedRequestRow>();
  for (const request of retainedRequests) {
    if (request.state !== "observed" || request.source_snapshot_id === null) {
      throw new Error(`Planned Source Request ${request.request_id} has no observed Source Snapshot.`);
    }
    if (selectedSnapshots.has(request.source_snapshot_id)) {
      throw new Error("Planned Source Requests selected a duplicate Source Snapshot.");
    }
    selectedSnapshots.set(request.source_snapshot_id, request);
  }
  for (const row of selectedObservations) {
    if (!selectedSnapshots.has(row.source_snapshot_id)) {
      throw new Error(
        `Unplanned Source Observation Set ${row.observation_set_id} cannot participate in reconciliation.`,
      );
    }
  }
  const rowsBySnapshot = new Map<string, EvidenceRow[]>();
  for (const row of selectedObservations) {
    rowsBySnapshot.set(row.source_snapshot_id, [...(rowsBySnapshot.get(row.source_snapshot_id) ?? []), row]);
  }
  const orderedRows = retainedRequests.map((request) => {
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
    const request = retainedRequests[index]!;
    const plan = evidencePlanForRequest({ request_plan_json: row.request_plan_json }, row.request_id);
    if (
      row.request_id !== request.request_id ||
      row.snapshot_request_method !== request.method ||
      row.snapshot_request_url !== request.url ||
      row.snapshot_representation_fingerprint !== request.representation_fingerprint
    ) {
      throw new Error("Retained Source Snapshot provenance differs from its immutable Source Request.");
    }
    if (
      row.source_lineage !== plan.source_lineage ||
      row.supported_game !== plan.supported_game ||
      row.game_profile_version !== plan.game_profile_version ||
      row.adapter_version !== plan.adapter_version
    ) {
      throw new Error("Retained Source Observation Set provenance is inconsistent with its Evidence Plan.");
    }
  }
  const aggregateBytes = orderedRows.reduce((total, row) => total + row.content_byte_length, 0);
  if (aggregateBytes > maximumAggregateReconciliationBytes) {
    throw new Error("Retained Source Observation Sets exceed the aggregate reconciliation byte budget.");
  }
  const loadDocument = (index: number) =>
    retainedObservationDocument(database, evidenceObjects, runId, orderedRows[index]!);
  for (const row of orderedRows) {
    const adapter = requiredSourceAdapter(row.adapter_version);
    if (row.content_byte_length > adapter.maximumSnapshotBytes) {
      throw new Error(`Retained Source Observation Set ${row.observation_set_id} exceeds its adapter byte limit.`);
    }
    await retainedObservationDocument(database, evidenceObjects, runId, row);
  }
  await assertClosedRequestGraph(retainedRequests, orderedRows, loadDocument);
  const retainedImages = new Map(printingImageSnapshots.results.map((row) => [row.request_url, row]));
  const officialSurfaces = new Set<string>();
  const requestsById = new Map(retainedRequests.map((request) => [request.request_id, request]));
  for (let index = 0; index < orderedRows.length; index++) {
    const document = await loadDocument(index);
    const row = orderedRows[index]!;
    const request = retainedRequests[index]!;
    for (const [sourceOrdinal, wrapped] of document.observations.entries()) {
      if (!isRecord(wrapped) || typeof wrapped.id !== "string") {
        throw new Error("Retained Source Observation identity is invalid.");
      }
      await claimObservationOrigin(database, runId, wrapped.id, row.observation_set_id, sourceOrdinal);
      if (isRecord(wrapped.value) && wrapped.value.observation_type === "official_surface_evidence") {
        if (
          typeof wrapped.value.surface !== "string" ||
          !Array.isArray(wrapped.value.records) ||
          officialSurfaces.has(request.request_id)
        ) {
          throw new Error("Retained Official Source surface evidence is invalid or duplicated.");
        }
        officialSurfaces.add(request.request_id);
        continue;
      }
      if (await hasNormalizedObservation(database, runId, wrapped.id)) continue;
      let parsed = parseReconciliationObservation(
        wrapped.id,
        await attachRetainedPrintingImages(
          wrapped.value,
          retainedImages,
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
      const sourceSurface = sourceSurfaceForRequest(request, requestsById, row);
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
    }
  }
  for (const plan of selectedPlans) {
    await validateOfficialSurfaceCoverage({
      adapter: requiredSourceAdapter(plan.adapter_version),
      plan,
      collectionRequests,
    });
  }
  for (const collectionPlan of collectionPlans.results.filter((plan) => !omittedLineages.has(plan.source_lineage))) {
    await validateLegacyCollectionPlan(
      collectionPlan,
      await retainedCollectionRequests(collectionPlan),
      retainedRequests,
    );
  }
  const partitions = orderedRows.map((row, index) => ({
    sequenceNumber: retainedRequests[index]!.sequence_number,
    requestId: retainedRequests[index]!.request_id,
    observationSetId: row.observation_set_id,
    sourceSnapshotId: row.source_snapshot_id,
    sourceLineage: row.source_lineage,
    supportedGame: row.supported_game,
    gameProfileVersion: row.game_profile_version,
    adapterVersion: row.adapter_version,
  }));
  const countChangeWarnings = await sourceObservationCountChangeWarnings(database, runId, orderedRows);
  return {
    observationSetId: first.observation_set_id,
    sourceSnapshotId: first.source_snapshot_id,
    sourceLineage: first.source_lineage,
    supportedGame: supportedGame(first.supported_game),
    reconciliationCapability: requiredSourceAdapter(first.adapter_version).reconciliationCapability,
    structurallyComplete: true,
    countChangeWarnings: [
      ...countChangeWarnings,
      ...evidencePlans
        .filter((plan) => omittedLineages.has(plan.source_lineage))
        .map((plan) => ({
          code: "optional_source_carried_forward",
          source_lineage: plan.source_lineage,
          coverage: plan.coverage,
          detail:
            "The optional Source Coverage was not completely checked. Prior accepted facts and their evidence/check dates carry forward; partial captures establish no disappearance.",
        })),
    ],
    unavailablePrintingImages,
    partitions,
    evidencePlans: selectedPlans.map((plan) => {
      return {
        sourceLineage: plan.source_lineage,
        supportedGame: supportedGame(plan.supported_game),
        adapterVersion: plan.adapter_version,
        reconciliationCapability: requiredSourceAdapter(plan.adapter_version).reconciliationCapability,
        partitions: partitions.filter(
          ({ requestId }) =>
            requestId.startsWith(`${plan.source_lineage}:`) || plan.requests.some(({ id }) => id === requestId),
        ),
      };
    }),
    observations: stagedNormalizedObservations<NormalizedReconciliationObservation>(database, runId),
  };
}

async function sourceObservationCountChangeWarnings(
  database: CatalogueStore,
  runId: string,
  currentRows: readonly EvidenceRow[],
): Promise<Record<string, unknown>[]> {
  const prior = await reconciliationObservationCountsStatement(database, runId).all<PriorObservationCountRow>();
  const priorCounts = new Map<string, number>();
  for (const row of prior.results) {
    const key = `${row.source_lineage}\u0000${row.adapter_version}\u0000${row.request_id}`;
    if (!priorCounts.has(key)) priorCounts.set(key, row.observation_count);
  }
  return currentRows.flatMap((row) => {
    const previousCount = priorCounts.get(`${row.source_lineage}\u0000${row.adapter_version}\u0000${row.request_id}`);
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
    return previousCount === undefined || threshold === null || absoluteDelta === null || absoluteDelta < threshold
      ? []
      : [
          {
            code: "source_observation_count_changed",
            semantic_effect: "additions",
            source_lineage: row.source_lineage,
            request_id: row.request_id,
            previous_count: previousCount,
            current_count: row.observation_count,
            absolute_delta: absoluteDelta,
            warning_threshold: threshold,
            detail: `Official Source request ${row.request_id} changed by ${absoluteDelta} parsed observations since the prior published snapshot, meeting the review threshold of ${threshold}.`,
          },
        ];
  });
}

async function validateOfficialSurfaceCoverage(input: {
  adapter: ReturnType<typeof requiredSourceAdapter>;
  plan: ReturnType<typeof parseEvidencePlans>[number];
  collectionRequests: readonly Record<string, unknown>[];
}): Promise<void> {
  const { adapter, plan } = input;
  if (adapter.origin !== "production" || adapter.reconciliationCapability !== "catalogue") {
    return;
  }
  const requiredSurfaces = adapter.requiredSurfaces ?? [];
  if (
    requiredSurfaces.some(
      (surface) =>
        !input.collectionRequests.some((request) => request.id === `${adapter.sourceLineage}:${surface}`) &&
        !plan.requests.some((request) => request.id === `${adapter.sourceLineage}:${surface}`),
    )
  ) {
    throw new Error("Complete Official Source evidence omitted a required live surface.");
  }
}

async function validateLegacyCollectionPlan(
  retainedCollectionPlan: CollectionPlanRow,
  collectionRequests: readonly Record<string, unknown>[],
  requests: readonly PlannedRequestRow[],
): Promise<void> {
  if (
    retainedCollectionPlan.contract !== "card-keepr-official-source-collection-plan@1" ||
    (await sha256(new TextEncoder().encode(retainedCollectionPlan.collection_plan_json))) !==
      retainedCollectionPlan.content_digest
  ) {
    throw new Error("Official Source Collection Plan failed immutable artifact verification.");
  }
  const document: unknown = JSON.parse(retainedCollectionPlan.collection_plan_json);
  if (!isRecord(document) || document.source_lineage !== retainedCollectionPlan.source_lineage) {
    throw new Error("Official Source Collection Plan lineage ownership is invalid.");
  }
  const retainedRequests = new Map(collectionRequests.map((value) => [value.id as string, value] as const));
  if (
    retainedRequests.size !== collectionRequests.length ||
    collectionRequests.some((planned) => {
      const request = requests.find(({ request_id: requestId }) => requestId === planned.id);
      return !samePlannedRequest(request, planned, request?.sequence_number ?? -1);
    })
  ) {
    throw new Error("Official Source requests differ from the immutable Collection Plan.");
  }
}

function sourceSurfaceForRequest(
  request: PlannedRequestRow,
  requests: ReadonlyMap<string, PlannedRequestRow>,
  row: Pick<EvidenceRow, "adapter_version" | "plan_origin" | "source_lineage">,
): string | undefined {
  let current = request;
  const visited = new Set<string>();
  while (current.request_role !== "surface") {
    if (current.discovered_from_request_id === null || visited.has(current.request_id)) {
      throw new Error(`Discovered Source Request ${request.request_id} has no closed root surface lineage.`);
    }
    visited.add(current.request_id);
    const parent = requests.get(current.discovered_from_request_id);
    if (parent === undefined) {
      throw new Error(`Discovered Source Request ${request.request_id} names an unavailable parent.`);
    }
    current = parent;
  }
  const prefix = `${row.source_lineage}:`;
  if (!current.request_id.startsWith(prefix)) {
    throw new Error("Root Source Request identity does not match its retained lineage.");
  }
  return current.request_id.slice(prefix.length);
}

export type GundamListingCollectionGraphInput = Readonly<{
  requestId: string;
  requestUrl: string;
  sourceLineage: string;
  adapterVersion: string;
  observations: readonly unknown[];
}>;

export function validateGundamListingCollectionGraph(inputs: readonly GundamListingCollectionGraphInput[]): {
  completeRequestIds: string[];
  collections: {
    sourceLineage: string;
    package: string | null;
    declaredTotal: number;
    terminalPage: number;
    fullLocators: string[];
  }[];
} {
  type Page = {
    requestId: string;
    sourceLineage: string;
    package: string | null;
    page: number;
    terminal: boolean;
    declaredTotal: number;
    fullLocators: string[];
  };
  const grouped = new Map<string, Page[]>();
  for (const input of inputs) {
    if (requiredSourceAdapter(input.adapterVersion).listingReconciliation?.groupsPublisherPages !== true) continue;
    const retained = input.observations.flatMap((wrapped) => {
      const observation = isRecord(wrapped) && isRecord(wrapped.value) ? wrapped.value : wrapped;
      if (!isRecord(observation) || !isRecord(observation.source_sidecar)) {
        return [];
      }
      const raw = observation.source_sidecar.raw;
      if (!isRecord(raw) || !Array.isArray(raw.official_surfaces)) return [];
      return raw.official_surfaces.flatMap((surface) => {
        if (
          !isRecord(surface) ||
          surface.source_lineage !== input.sourceLineage ||
          surface.surface !== "listing" ||
          !isRecord(surface.document) ||
          !("terminal_page" in surface.document)
        )
          return [];
        return [{ observation, document: surface.document }];
      });
    });
    if (retained.length === 0) continue;
    if (retained.length !== 1) {
      throw new Error("A Gundam listing request retained duplicate collection proofs.");
    }
    const { observation, document } = retained[0]!;
    const selectedPackage = document.selected_package;
    const selectedPage = document.selected_page;
    const declaredTotal = document.declared_total;
    const fullLocators = document.full_locators;
    if (
      (selectedPackage !== null && (typeof selectedPackage !== "string" || selectedPackage.length === 0)) ||
      !Number.isSafeInteger(selectedPage) ||
      Number(selectedPage) < 1 ||
      !Number.isSafeInteger(declaredTotal) ||
      Number(declaredTotal) < 0 ||
      !Array.isArray(fullLocators) ||
      !fullLocators.every((locator) => typeof locator === "string" && locator.length > 0) ||
      new Set(fullLocators).size !== fullLocators.length ||
      typeof document.terminal_page !== "boolean"
    ) {
      throw new Error("A retained Gundam listing collection proof is invalid.");
    }
    const url = new URL(input.requestUrl);
    const requestedPackages = url.searchParams.getAll("package");
    const requestedPages = url.searchParams.getAll("page");
    const requestedPackage = requestedPackages[0] ?? null;
    const requestedPage = Number.parseInt(requestedPages[0] ?? "1", 10);
    if (
      requestedPackages.length > 1 ||
      requestedPages.length > 1 ||
      requestedPackage !== selectedPackage ||
      requestedPage !== selectedPage
    ) {
      throw new Error("A retained Gundam listing collection proof conflicts with its request identity.");
    }
    const completeness = observation.completeness;
    const individuallyComplete = document.terminal_page === true && fullLocators.length === declaredTotal;
    if (
      !isRecord(completeness) ||
      completeness.structurally_complete !== true ||
      completeness.declared_record_count !== declaredTotal ||
      completeness.parsed_record_count !== fullLocators.length ||
      completeness.required_surfaces_complete !== individuallyComplete ||
      completeness.partitions_complete !== individuallyComplete
    ) {
      throw new Error("A retained Gundam listing page overstates its individual completeness.");
    }
    const key = canonicalJson([input.sourceLineage, selectedPackage]);
    grouped.set(key, [
      ...(grouped.get(key) ?? []),
      {
        requestId: input.requestId,
        sourceLineage: input.sourceLineage,
        package: selectedPackage,
        page: Number(selectedPage),
        terminal: document.terminal_page,
        declaredTotal: Number(declaredTotal),
        fullLocators: fullLocators as string[],
      },
    ]);
  }
  const completeRequestIds = new Set<string>();
  const collections = [...grouped.values()]
    .map((pages) => {
      const ordered = [...pages].sort((left, right) => left.page - right.page);
      const pageNumbers = new Set(ordered.map(({ page }) => page));
      const terminal = ordered.filter(({ terminal }) => terminal);
      const lastPage = ordered.at(-1)!.page;
      if (
        pageNumbers.size !== ordered.length ||
        ordered[0]!.page !== 1 ||
        terminal.length !== 1 ||
        terminal[0]!.page !== lastPage ||
        ordered.some(({ page }, index) => page !== index + 1)
      ) {
        throw new Error("A retained Gundam listing collection has incomplete page continuity or terminal-page proof.");
      }
      const declaredTotals = new Set(ordered.map(({ declaredTotal }) => declaredTotal));
      if (declaredTotals.size !== 1) {
        throw new Error("A retained Gundam listing collection disagrees on its publisher total.");
      }
      const declaredTotal = ordered[0]!.declaredTotal;
      const fullLocators = [...new Set(ordered.flatMap(({ fullLocators }) => fullLocators))].sort();
      if (fullLocators.length !== declaredTotal) {
        throw new Error("A retained Gundam listing collection does not close its publisher total across pages.");
      }
      ordered.forEach(({ requestId }) => completeRequestIds.add(requestId));
      return {
        sourceLineage: ordered[0]!.sourceLineage,
        package: ordered[0]!.package,
        declaredTotal,
        terminalPage: lastPage,
        fullLocators,
      };
    })
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return {
    completeRequestIds: [...completeRequestIds].sort(),
    collections,
  };
}

async function assertClosedRequestGraph(
  requests: readonly PlannedRequestRow[],
  rows: readonly EvidenceRow[],
  loadDocument: (index: number) => Promise<Awaited<ReturnType<typeof retainedObservationDocument>>>,
): Promise<void> {
  const gundamInputs: GundamListingCollectionGraphInput[] = [];
  for (const [index, request] of requests.entries()) {
    if (requiredSourceAdapter(rows[index]!.adapter_version).listingReconciliation?.groupsPublisherPages !== true)
      continue;
    const document = await loadDocument(index);
    const observations = document.observations.flatMap((wrapped) => {
      const observation = isRecord(wrapped) && isRecord(wrapped.value) ? wrapped.value : wrapped;
      if (
        !isRecord(observation) ||
        !isRecord(observation.source_sidecar) ||
        !isRecord(observation.source_sidecar.raw) ||
        !Array.isArray(observation.source_sidecar.raw.official_surfaces)
      )
        return [];
      const surfaces = observation.source_sidecar.raw.official_surfaces.flatMap((surface) => {
        if (
          !isRecord(surface) ||
          surface.source_lineage !== rows[index]!.source_lineage ||
          surface.surface !== "listing" ||
          !isRecord(surface.document) ||
          !("terminal_page" in surface.document)
        )
          return [];
        const { selected_package, selected_page, declared_total, full_locators, terminal_page } = surface.document;
        return [
          {
            source_lineage: surface.source_lineage,
            surface: surface.surface,
            document: { selected_package, selected_page, declared_total, full_locators, terminal_page },
          },
        ];
      });
      return surfaces.length
        ? [
            {
              value: {
                completeness: observation.completeness,
                source_sidecar: { raw: { official_surfaces: surfaces } },
              },
            },
          ]
        : [];
    });
    if (!observations.length) continue;
    gundamInputs.push({
      requestId: request.request_id,
      requestUrl: request.url,
      sourceLineage: rows[index]!.source_lineage,
      adapterVersion: rows[index]!.adapter_version,
      observations,
    });
  }
  const gundamListingGraph = validateGundamListingCollectionGraph(gundamInputs);
  const aggregateCompleteGundamRequests = new Set(gundamListingGraph.completeRequestIds);
  const byId = new Map(requests.map((request) => [request.request_id, request]));
  const rootSurfaces = new Map<string, Set<string>>();
  const listingLocators = new Map<
    string,
    {
      requestId: string;
      semantic: string;
      canonical: string | null;
    }
  >();
  const listingPages = new Map<string, Set<number>>();
  for (const [index, request] of requests.entries()) {
    const row = rows[index]!;
    const document = await loadDocument(index);
    if (
      document.evidenceSummary.observation_count !== document.observations.length ||
      ((document.evidenceSummary.structurally_complete !== true ||
        document.evidenceSummary.required_surfaces_complete !== true ||
        document.evidenceSummary.partitions_complete !== true ||
        document.evidenceSummary.declared_record_count !== document.evidenceSummary.parsed_record_count) &&
        !aggregateCompleteGundamRequests.has(request.request_id))
    ) {
      throw new Error(`Source Request ${request.request_id} has incomplete declared/parsed count closure.`);
    }
    const adapter = requiredSourceAdapter(row.adapter_version);
    if (adapter.origin !== "production" || row.plan_origin !== "production") {
      throw new Error(`Source Request ${request.request_id} has mismatched graph authority.`);
    }
    if (request.request_role === "surface") {
      const prefix = `${row.source_lineage}:`;
      if (request.discovered_from_request_id !== null || !request.request_id.startsWith(prefix)) {
        throw new Error("Root Source Request graph identity is invalid.");
      }
      const surface = request.request_id.slice(prefix.length);
      if (surface !== "discovery") {
        rootSurfaces.set(row.adapter_version, new Set([...(rootSurfaces.get(row.adapter_version) ?? []), surface]));
      }
      continue;
    }
    if (request.discovered_from_request_id === null) {
      throw new Error(`Discovered Source Request ${request.request_id} has no parent.`);
    }
    const parent = byId.get(request.discovered_from_request_id);
    if (parent === undefined) {
      throw new Error(`Discovered Source Request ${request.request_id} does not close over a retained parent.`);
    }
    if (request.request_role === "image" && document.observations.length !== 0) {
      throw new Error("Printing Image requests cannot invent catalogue facts.");
    }
    if (
      (request.request_role === "detail" || request.request_role === "product_detail") &&
      document.observations.length === 0
    ) {
      throw new Error(`Required ${request.request_role} request ${request.request_id} parsed no retained detail.`);
    }
    if (request.request_role === "listing") {
      for (const observation of document.observations) {
        if (!isRecord(observation) || !isRecord(observation.value)) continue;
        const strictListingIdentity =
          adapter.listingReconciliation?.strictListingIdentity === true
            ? observation.value.listing_identity_evidence
            : undefined;
        const identity = strictListingIdentity ?? observation.value.identity_evidence;
        if (!isRecord(identity) || typeof identity.locator !== "string") {
          continue;
        }
        const locatorKey = `${row.source_lineage}:${identity.locator}`;
        const semantic = await compatibleListingObservationSemantic(observation.value);
        const canonical = typeof identity.canonical === "string" ? identity.canonical : null;
        const prior = listingLocators.get(locatorKey);
        if (prior !== undefined && prior.requestId !== request.request_id) {
          const compatibility = adapter.listingReconciliation?.duplicateLocatorCompatibility ?? "never";
          const compatible =
            compatibility === "semantic"
              ? prior.semantic === semantic
              : compatibility === "canonical"
                ? prior.canonical === canonical
                : false;
          if (!compatible) {
            throw new Error(`Official Source leaf partitions overlap at locator ${identity.locator}.`);
          }
        }
        listingLocators.set(locatorKey, {
          requestId: prior?.requestId ?? request.request_id,
          semantic,
          canonical,
        });
      }
      const url = new URL(request.url);
      const pageEntry = [...url.searchParams.entries()].find(([key]) => /^(?:page|paged|offset)$/u.test(key));
      if (pageEntry !== undefined) {
        const page = Number.parseInt(pageEntry[1], 10);
        if (!Number.isInteger(page) || page < 0) {
          throw new Error("Official Source listing page identity is invalid.");
        }
        url.searchParams.delete(pageEntry[0]);
        const key = `${row.source_lineage}:${url.pathname}?${url.searchParams.toString()}`;
        listingPages.set(key, new Set([...(listingPages.get(key) ?? []), page]));
      }
    }
  }
  for (const collection of gundamListingGraph.collections) {
    const retainedDetails = new Set(
      requests.flatMap((request, index) => {
        if (rows[index]!.source_lineage !== collection.sourceLineage || request.request_role !== "detail") return [];
        const locator = new URL(request.url).searchParams.get("detailSearch");
        return locator === null ? [] : [locator];
      }),
    );
    if (collection.fullLocators.some((locator) => !retainedDetails.has(locator))) {
      throw new Error("A complete Gundam listing collection omitted a retained Card detail request.");
    }
  }
  for (const [partition, pages] of listingPages) {
    const ordered = [...pages].sort((left, right) => left - right);
    const firstPage = ordered[0]!;
    for (let page = firstPage; page <= ordered.at(-1)!; page += 1) {
      if (!pages.has(page)) {
        throw new Error(`Official Source listing partition ${partition} has unfinished page closure.`);
      }
    }
  }
  for (const [adapterVersion, actual] of rootSurfaces) {
    const adapter = requiredSourceAdapter(adapterVersion);
    if (adapter.origin !== "production" || adapter.reconciliationCapability === "unavailable") {
      throw new Error(`Official Source ${adapterVersion} has invalid production coverage authority.`);
    }
    const expected = new Set(adapter.requiredSurfaces ?? []);
    if (actual.size !== expected.size || [...expected].some((surface) => !actual.has(surface))) {
      throw new Error(
        `Official Source ${adapterVersion} request graph does not close over every required root surface.`,
      );
    }
  }
}

function compatibleListingObservationSemantic(observation: Record<string, unknown>): Promise<string> {
  const { memberships: _memberships, source_sidecar: _sourceSidecar, ...semantic } = observation;
  return canonicalValueDigest(semantic);
}

async function attachRetainedPrintingImages(
  value: unknown,
  images: ReadonlyMap<string, PrintingImageSnapshotRow>,
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
    const retained = images.get(item.source_url);
    retainedImages.push(
      retained === undefined ? item : { ...item, ...(await retainedPrintingImage(evidenceObjects, retained)) },
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

async function retainedCollectionRequests(retained: CollectionPlanRow): Promise<Record<string, unknown>[]> {
  if (
    retained.contract !== "card-keepr-official-source-collection-plan@1" ||
    (await sha256(new TextEncoder().encode(retained.collection_plan_json))) !== retained.content_digest
  ) {
    throw new Error("Official Source Collection Plan failed immutable artifact verification.");
  }
  const collection: unknown = JSON.parse(retained.collection_plan_json);
  if (!isRecord(collection) || collection.contract !== retained.contract || !Array.isArray(collection.requests)) {
    throw new Error("Official Source Collection Plan is malformed.");
  }
  const identities = new Set<string>();
  return collection.requests.map((value) => {
    if (
      !isRecord(value) ||
      typeof value.id !== "string" ||
      identities.has(value.id) ||
      typeof value.surface !== "string" ||
      value.surface.length === 0
    ) {
      throw new Error("Official Source Collection Plan request is malformed.");
    }
    identities.add(value.id);
    return value;
  });
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

async function retainedObservationDocument(
  database: CatalogueStore,
  evidenceObjects: R2Bucket,
  runId: string,
  row: EvidenceRow,
): Promise<Awaited<ReturnType<typeof readRetainedObservationDocument>>> {
  const identity = {
    runId,
    observationSetId: row.observation_set_id,
    provenanceDigest: await canonicalValueDigest(row),
  };
  const retained = await readVerifiedSourceDocument(database, identity);
  if (retained) return retained as Awaited<ReturnType<typeof readRetainedObservationDocument>>;
  const document = await readRetainedObservationDocument(evidenceObjects, row);
  await retainVerifiedSourceDocument(database, identity, document);
  return document;
}

async function readRetainedObservationDocument(
  evidenceObjects: R2Bucket,
  row: EvidenceRow,
): Promise<{
  observations: unknown[];
  evidenceSummary: {
    observation_count: number;
    declared_record_count: number;
    parsed_record_count: number;
    structurally_complete: boolean;
    required_surfaces_complete: boolean;
    partitions_complete: boolean;
  };
}> {
  const object = await documentStorage(evidenceObjects.get(row.content_object_key));
  if (object === null || object.size !== row.content_byte_length) {
    throw new Error("Retained Source Observation Set bytes are unavailable.");
  }
  const bytes = new Uint8Array(await documentStorage(object.arrayBuffer()));
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
    !validEvidenceSummary(document.evidence_summary, document.observations, row.observation_count) ||
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
      structurally_complete: boolean;
      required_surfaces_complete: boolean;
      partitions_complete: boolean;
    },
  };
}

function validEvidenceSummary(value: unknown, observations: unknown, observationCount: number): boolean {
  if (!isRecord(value) || !Array.isArray(observations)) return false;
  return (
    typeof value.structurally_complete === "boolean" &&
    typeof value.required_surfaces_complete === "boolean" &&
    typeof value.partitions_complete === "boolean" &&
    observationCount === observations.length &&
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
