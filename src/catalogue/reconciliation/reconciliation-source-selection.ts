import {
  type CatalogueStore,
  type ObjectMemberCursor,
  canonicalJson,
  StreamingSha256,
  resumableObjectMembers,
} from "../shared";
import { requiredSourceAdapter } from "../adapters";
import {
  isOptionalSourceOutage,
  assertSelectedAuthoritiesCollected,
  type EvidencePlanRequest,
  evidencePlanForRequest,
  parseEvidencePlans,
  toleratesRequestFailure,
} from "../source-evidence";
import {
  unchangedAcceptedSourceStatement,
  reconciliationCollectionPlansStatement,
  reconciliationCollectionPlanChunkStatement,
  reconciliationObservationSetsStatement,
  reconciliationOverflowRequestsStatement,
  reconciliationSourceRequestsStatement,
  reconciliationSourceRequestStatement,
} from "./reconciliation-evidence-repository";
import type {
  PlannedRequestRow,
  EvidenceRow,
  CollectionPlanRow,
  EvidencePlanRow,
  DiscoveryRequestPlanRow,
} from "./reconciliation-evidence-types";
import { ReconciliationReducerIndex } from "./reconciliation-reducer-state";
import { documentStorage } from "./reconciliation-document";
import { canonicalValueDigest } from "./reconciliation-preparation";
import { retainEvidenceSelection } from "./reconciliation-selection";
import { reconciliationCheckpoint, retainReconciliationCheckpoint } from "./reconciliation-checkpoint";
import { ReconciliationContinuation } from "./reconciliation-continuation";

type Selection = { inputDigest: string; omittedLineages: string[] };
type Stage =
  | "outages"
  | "optional_failures"
  | "authorities"
  | "roots"
  | "collection_plans"
  | "discovery_plans"
  | "request_coverage"
  | "evidence_coverage"
  | "selection"
  | "surface_coverage"
  | "complete";
type Cursor = {
  planDigest: string;
  stage: Stage;
  sequence: number;
  id: string;
  plan: number;
  request: number;
  lineage: string;
  collection: null | {
    plan: CollectionPlanRow;
    stage: "hash" | "requests";
    offset: number;
    hash: StreamingSha256["checkpoint"];
    member: ObjectMemberCursor | null;
    identities: number;
    contract: boolean;
    requests: boolean;
    lineage: boolean;
  };
  omittedLineages: string[];
  unchangedLineages: string[];
  immutableCount: number;
  rootRequestCount: number;
  requestCount: number;
  selectedCount: number;
  inputDigest: string;
  positions: { immutable: number; surfaces: number; snapshots: number };
};

/** Freeze request membership and provenance through bounded, replayable validation passes. */
export async function prepareSourceSelection(
  database: CatalogueStore,
  runId: string,
  evidencePlanRow: EvidencePlanRow,
  yieldAtCheckpoint: boolean,
): Promise<Selection> {
  const pinned = await reconciliationCheckpoint<Selection>(database, runId, "input_selection");
  if (pinned) return pinned.value;
  const plans = parseEvidencePlans(evidencePlanRow.request_plan_json);
  const planDigest = await canonicalValueDigest(evidencePlanRow);
  const immutable = new ReconciliationReducerIndex<boolean>(database, runId, "immutable_request_ids");
  const surfaces = new ReconciliationReducerIndex<boolean>(database, runId, "collection_request_ids");
  const snapshots = new ReconciliationReducerIndex<boolean>(database, runId, "selected_snapshot_ids");
  const checkpoint = await reconciliationCheckpoint<Cursor>(database, runId, "source_selection");
  const cursor: Cursor = checkpoint?.value ?? {
    planDigest,
    stage: "outages",
    sequence: -1,
    id: "",
    plan: 0,
    request: 0,
    lineage: "",
    collection: null,
    omittedLineages: [],
    unchangedLineages: [],
    immutableCount: 0,
    rootRequestCount: 0,
    requestCount: 0,
    selectedCount: 0,
    inputDigest: "",
    positions: { immutable: 0, surfaces: 0, snapshots: 0 },
  };
  if (cursor.planDigest !== planDigest) throw new Error("Source selection Evidence Plan changed.");
  immutable.resumeAt(cursor.positions.immutable);
  surfaces.resumeAt(cursor.positions.surfaces);
  snapshots.resumeAt(cursor.positions.snapshots);
  const omitted = new Set(cursor.omittedLineages);
  const unchanged = new Set(cursor.unchangedLineages);
  let ordinal = (checkpoint?.ordinal ?? -1) + 1;
  let work = 0,
    bytes = 0;
  const save = async () => {
    cursor.omittedLineages = [...omitted];
    cursor.unchangedLineages = [...unchanged];
    cursor.positions = { immutable: immutable.position, surfaces: surfaces.position, snapshots: snapshots.position };
    await retainReconciliationCheckpoint(database, runId, "source_selection", ordinal, cursor);
    if (yieldAtCheckpoint) throw new ReconciliationContinuation({ phase: "source_selection", ordinal });
    ordinal++;
    work = 0;
    bytes = 0;
  };
  const before = async (value: unknown) => {
    const size = new TextEncoder().encode(canonicalJson(value)).byteLength;
    if (size > 512000)
      throw new Error("reconciliation_capacity_exceeded: one source selection record exceeds 500 KiB.");
    if (work > 0 && bytes + size > 512000) await save();
    bytes += size;
  };
  const tick = async () => {
    if (++work >= 4) await save();
  };
  const advance = async (stage: Stage) => {
    cursor.stage = stage;
    cursor.sequence = -1;
    cursor.id = "";
    cursor.plan = 0;
    cursor.request = 0;
    await save();
  };
  const requestById = async (id: string) =>
    (await documentStorage(() =>
      reconciliationSourceRequestStatement(database, runId, id).first<PlannedRequestRow>(),
    )) ?? undefined;
  const claim = async (id: string) => {
    if (await immutable.has(id)) return;
    await immutable.seed(id, true);
    cursor.immutableCount++;
  };
  const selected = (request: PlannedRequestRow) =>
    !(request.state === "failed" && toleratesRequestFailure(request.request_role, request.failure_code)) &&
    !omitted.has(evidencePlanForRequest(evidencePlanRow, request.request_id).source_lineage);
  const requestPosition = (request: { sequence_number: number; request_id: string }) => {
    cursor.sequence = request.sequence_number;
    cursor.id = request.request_id;
  };
  if (cursor.stage === "outages") {
    for await (const request of sourceRequests(database, runId, cursor.sequence, cursor.id)) {
      await before(request);
      const plan = evidencePlanForRequest(evidencePlanRow, request.request_id);
      if (request.state === "failed" && isOptionalSourceOutage(plan, request.failure_code))
        omitted.add(plan.source_lineage);
      requestPosition(request);
      await tick();
    }
    await advance("optional_failures");
  }
  if (cursor.stage === "optional_failures") {
    for await (const request of sourceRequests(database, runId, cursor.sequence, cursor.id)) {
      await before(request);
      const plan = evidencePlanForRequest(evidencePlanRow, request.request_id);
      if (
        request.state === "failed" &&
        omitted.has(plan.source_lineage) &&
        !isOptionalSourceOutage(plan, request.failure_code) &&
        !toleratesRequestFailure(request.request_role, request.failure_code)
      )
        throw new Error(
          `Optional Source ${plan.source_lineage} has blocking evidence failure ${request.failure_code}.`,
        );
      requestPosition(request);
      await tick();
    }
    await advance("authorities");
  }
  const selectedPlans = plans.filter((plan) => !omitted.has(plan.source_lineage));
  if (cursor.stage === "authorities") {
    for (; cursor.plan < selectedPlans.length; ) {
      const plan = selectedPlans[cursor.plan]!;
      if (
        await documentStorage(() =>
          unchangedAcceptedSourceStatement(database, runId, plan.source_lineage, plan.adapter_version).first(),
        )
      )
        unchanged.add(plan.source_lineage);
      cursor.plan++;
      await tick();
    }
    await assertSelectedAuthoritiesCollected(database, selectedPlans, unchanged, runId);
    await advance("roots");
  }
  if (cursor.stage === "roots") {
    for (; cursor.plan < plans.length; cursor.plan++, cursor.request = 0) {
      const plan = plans[cursor.plan]!;
      for (; cursor.request < plan.requests.length; ) {
        const planned = plan.requests[cursor.request]!;
        await before(planned);
        const request = await requestById(planned.id);
        if (!samePlannedRequest(request, planned, request?.sequence_number ?? -1))
          throw new Error("Operational Source Requests differ from the immutable Evidence Plan.");
        await claim(planned.id);
        cursor.rootRequestCount++;
        cursor.request++;
        await tick();
      }
    }
    if (!cursor.rootRequestCount)
      throw new Error("Operational Source Requests differ from the immutable Evidence Plan.");
    await advance("collection_plans");
  }
  if (cursor.stage === "collection_plans") {
    while (true) {
      if (!cursor.collection) {
        const next = await collectionPlans(database, runId, cursor.lineage).next();
        if (next.done) break;
        if (next.value.contract !== "card-keepr-official-source-collection-plan@1")
          throw new Error("Official Source Collection Plan failed immutable artifact verification.");
        cursor.collection = {
          plan: next.value,
          stage: "hash",
          offset: 0,
          hash: new StreamingSha256().checkpoint,
          member: null,
          identities: 0,
          contract: false,
          requests: false,
          lineage: false,
        };
      }
      const collection = cursor.collection;
      const chunks = async function* (start: number) {
        for (let index = start; ; index++) {
          const row = await documentStorage(() =>
            reconciliationCollectionPlanChunkStatement(
              database,
              runId,
              collection.plan.source_lineage,
              index * 32768 + 1,
            ).first<{ content: string }>(),
          );
          if (!row) throw new Error("Official Source Collection Plan failed immutable artifact verification.");
          if (!row.content) return;
          yield row.content;
        }
      };
      if (collection.stage === "hash") {
        const hash = new StreamingSha256(collection.hash);
        for await (const chunk of chunks(collection.offset)) {
          await before(chunk);
          hash.update(new TextEncoder().encode(chunk));
          collection.offset++;
          collection.hash = hash.checkpoint;
          await tick();
        }
        if (hash.digestHex() !== collection.plan.content_digest)
          throw new Error("Official Source Collection Plan failed immutable artifact verification.");
        collection.stage = "requests";
        await save();
      }
      const identities = new ReconciliationReducerIndex<boolean>(
        database,
        runId,
        `collection_plan_ids_${collection.plan.source_lineage}`,
      );
      identities.resumeAt(collection.identities);
      for await (const { member, cursor: next } of resumableObjectMembers(chunks, collection.member, {
        maximumTokenCharacters: 65536,
      })) {
        await before(member);
        if (member.key === "contract" && member.kind === "value" && !member.array)
          collection.contract = member.value === collection.plan.contract;
        else if (member.key === "source_lineage" && member.kind === "value" && !member.array)
          collection.lineage = member.value === collection.plan.source_lineage;
        else if (member.key === "requests" && member.kind === "array") collection.requests = true;
        else if (member.key === "requests" && member.kind === "value" && member.array) {
          const planned = member.value;
          if (
            !isRecord(planned) ||
            typeof planned.id !== "string" ||
            typeof planned.surface !== "string" ||
            planned.surface.length === 0 ||
            (await identities.has(planned.id))
          )
            throw new Error("Official Source Collection Plan request is malformed.");
          await identities.seed(planned.id, true);
          await claim(planned.id);
          await surfaces.seed(planned.id, true);
          if (!omitted.has(collection.plan.source_lineage)) {
            const request = await requestById(planned.id);
            if (
              !samePlannedRequest(request, planned, request?.sequence_number ?? -1) ||
              request === undefined ||
              (request.state === "failed" && toleratesRequestFailure(request.request_role, request.failure_code)) ||
              omitted.has(evidencePlanForRequest(evidencePlanRow, planned.id).source_lineage)
            )
              throw new Error("Official Source requests differ from the immutable Collection Plan.");
          }
        }
        collection.member = next;
        collection.identities = identities.position;
        await tick();
      }
      if (!collection.contract || !collection.requests)
        throw new Error("Official Source Collection Plan is malformed.");
      if (!collection.lineage) throw new Error("Official Source Collection Plan lineage ownership is invalid.");
      cursor.lineage = collection.plan.source_lineage;
      cursor.collection = null;
      await save();
    }
    await advance("discovery_plans");
  }
  if (cursor.stage === "discovery_plans") {
    for await (const planned of discoveryRequests(database, runId, cursor.sequence, cursor.id)) {
      await before(planned);
      await claim(planned.request_id);
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
      requestPosition(planned);
      await tick();
    }
    await advance("request_coverage");
  }
  if (cursor.stage === "request_coverage") {
    for await (const request of sourceRequests(database, runId, cursor.sequence, cursor.id)) {
      await before(request);
      cursor.requestCount++;
      if (!(await immutable.has(request.request_id)))
        throw new Error("Operational Source Requests differ from their immutable request plans.");
      if (selected(request)) {
        cursor.selectedCount++;
        if (request.state !== "observed" || request.source_snapshot_id === null)
          throw new Error(`Planned Source Request ${request.request_id} has no observed Source Snapshot.`);
        if (await snapshots.has(request.source_snapshot_id))
          throw new Error("Planned Source Requests selected a duplicate Source Snapshot.");
        await snapshots.seed(request.source_snapshot_id, true);
      }
      requestPosition(request);
      await tick();
    }
    if (cursor.requestCount !== cursor.immutableCount || cursor.rootRequestCount > cursor.requestCount)
      throw new Error("Operational Source Requests differ from their immutable request plans.");
    if (!cursor.selectedCount) throw new Error("No independently complete Source Coverage remains in this refresh.");
    await advance("evidence_coverage");
  }
  if (cursor.stage === "evidence_coverage") {
    for await (const row of evidenceRows(database, runId, null, cursor.id)) {
      await before(row);
      if (!omitted.has(row.source_lineage) && !(await snapshots.has(row.source_snapshot_id)))
        throw new Error(
          `Unplanned Source Observation Set ${row.observation_set_id} cannot participate in reconciliation.`,
        );
      cursor.id = row.observation_set_id;
      await tick();
    }
    cursor.inputDigest = await canonicalValueDigest({ evidencePlanRow, omittedLineages: [...omitted] });
    await advance("selection");
  }
  if (cursor.stage === "selection") {
    for await (const request of sourceRequests(database, runId, cursor.sequence, cursor.id)) {
      await before(request);
      let row: EvidenceRow | null = null;
      if (selected(request)) {
        const rows = evidenceRows(database, runId, request.source_snapshot_id!);
        const first = await rows.next();
        if (first.done || !(await rows.next()).done)
          throw new Error(
            `Planned Source Request ${request.request_id} requires exactly one collection Source Observation Set.`,
          );
        row = first.value;
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
        cursor.inputDigest = await canonicalValueDigest({ previous: cursor.inputDigest, evidence: { request, row } });
      }
      await retainEvidenceSelection(database, runId, request.request_id, request.sequence_number, { request, row });
      requestPosition(request);
      await tick();
    }
    await advance("surface_coverage");
  }
  if (cursor.stage === "surface_coverage") {
    for (; cursor.plan < selectedPlans.length; ) {
      const plan = selectedPlans[cursor.plan]!;
      await validateOfficialSurfaceCoverage({
        adapter: requiredSourceAdapter(plan.adapter_version),
        plan,
        hasCollectionRequest: (id) => surfaces.has(id),
      });
      cursor.plan++;
      await tick();
    }
    await advance("complete");
  }
  const result = { inputDigest: cursor.inputDigest, omittedLineages: [...omitted] };
  await retainReconciliationCheckpoint(database, runId, "input_selection", 0, result);
  if (yieldAtCheckpoint) throw new ReconciliationContinuation({ phase: "source_selection", ordinal });
  return result;
}
async function* sourceRequests(
  database: CatalogueStore,
  runId: string,
  sequence = -1,
  id = "",
): AsyncGenerator<PlannedRequestRow> {
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
async function* discoveryRequests(
  database: CatalogueStore,
  runId: string,
  sequence = -1,
  id = "",
): AsyncGenerator<DiscoveryRequestPlanRow> {
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
  id = "",
): AsyncGenerator<EvidenceRow> {
  while (true) {
    const row = await documentStorage(() =>
      reconciliationObservationSetsStatement(database, runId, id, snapshotId).first<EvidenceRow>(),
    );
    if (!row) return;
    id = row.observation_set_id;
    yield row;
  }
}
async function* collectionPlans(
  database: CatalogueStore,
  runId: string,
  lineage = "",
): AsyncGenerator<CollectionPlanRow> {
  while (true) {
    const row = await documentStorage(() =>
      reconciliationCollectionPlansStatement(database, runId, lineage).first<CollectionPlanRow>(),
    );
    if (!row) return;
    lineage = row.source_lineage;
    yield row;
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
    planned.representation_fingerprint === request.representation_fingerprint
  );
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
