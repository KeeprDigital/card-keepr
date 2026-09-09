import { type CatalogueStore, canonicalJson } from "../shared";
import { requiredSourceAdapter } from "../adapters";
import { ReconciliationReducerIndex } from "./reconciliation-reducer-state";
import { ReconciliationGundamGraph } from "./reconciliation-gundam-graph";
import { readSourceObservation } from "./reconciliation-source-observation";
import { reconciliationCheckpoint, retainReconciliationCheckpoint } from "./reconciliation-checkpoint";
import { ReconciliationContinuation } from "./reconciliation-continuation";
import { canonicalValueDigest } from "./reconciliation-preparation";

type Request = {
  request_id: string;
  sequence_number: number;
  url: string;
  request_role: string;
  discovered_from_request_id: string | null;
};
type Evidence = { adapter_version: string; source_lineage: string; plan_origin: string; observation_set_id: string };
type After = { sequenceNumber: number; requestId: string; complete: boolean };
type Document = {
  observationCount: number;
  evidenceSummary: {
    observation_count: number;
    structurally_complete: boolean;
    required_surfaces_complete: boolean;
    partitions_complete: boolean;
    declared_record_count: number;
    parsed_record_count: number;
  };
};
type Stage =
  | "gundam_requests"
  | "gundam_validation"
  | "requests"
  | "gundam_locators"
  | "listing_pages"
  | "root_surfaces"
  | "complete";
type Cursor = {
  inputDigest: string;
  stage: Stage;
  after: After | null;
  observation: number;
  headerComplete: boolean;
  pageProgress: { nextLocator: number; added: number } | null;
  afterEntity: string;
  processedRequests: number;
  rootSurfaces: [string, string[]][];
  positions: {
    gundam: ReconciliationGundamGraph["cursor"];
    inputs: number;
    locators: number;
    pages: number;
    pageIds: number;
    details: number;
  };
};

export async function assertClosedRequestGraph<T extends Evidence, R extends Request>(
  database: CatalogueStore,
  runId: string,
  inputDigest: string,
  evidenceAfter: (after?: After) => AsyncIterable<{ request: R; row: T | null }>,
  loadDocument: (row: T) => Promise<Document>,
  requestById: (id: string) => Promise<R | undefined>,
  yieldAtCheckpoint: boolean,
  adapterForVersion = requiredSourceAdapter,
) {
  const gundam = new ReconciliationGundamGraph(database, runId);
  const inputs = new ReconciliationReducerIndex<unknown[]>(database, runId, "gundam_graph_inputs");
  const locators = new ReconciliationReducerIndex<{ requestId: string; semantic: string; canonical: string | null }>(
    database,
    runId,
    "listing_locators",
  );
  const pages = new ReconciliationReducerIndex<{
    id: string;
    partition: string;
    first: number;
    last: number;
    count: number;
  }>(database, runId, "listing_page_groups");
  const pageIds = new ReconciliationReducerIndex<boolean>(database, runId, "listing_page_ids");
  const details = new ReconciliationReducerIndex<boolean>(database, runId, "listing_detail_locators");
  const positions = () => ({
    gundam: gundam.cursor,
    inputs: inputs.position,
    locators: locators.position,
    pages: pages.position,
    pageIds: pageIds.position,
    details: details.position,
  });
  const checkpoint = await reconciliationCheckpoint<Cursor>(database, runId, "graph_validation");
  const cursor: Cursor = checkpoint?.value ?? {
    inputDigest,
    stage: "gundam_requests",
    after: null,
    observation: 0,
    headerComplete: false,
    pageProgress: null,
    afterEntity: "",
    processedRequests: 0,
    rootSurfaces: [],
    positions: positions(),
  };
  if (cursor.inputDigest !== inputDigest) throw new Error("Source graph provenance changed.");
  gundam.resumeAt(cursor.positions.gundam);
  inputs.resumeAt(cursor.positions.inputs);
  locators.resumeAt(cursor.positions.locators);
  pages.resumeAt(cursor.positions.pages);
  pageIds.resumeAt(cursor.positions.pageIds);
  details.resumeAt(cursor.positions.details);
  const rootSurfaces = new Map(cursor.rootSurfaces.map(([key, values]) => [key, new Set(values)]));
  let ordinal = (checkpoint?.ordinal ?? -1) + 1;
  let work = 0,
    bytes = 0;
  const save = async () => {
    cursor.positions = positions();
    cursor.rootSurfaces = [...rootSurfaces].map(([key, values]) => [key, [...values]]);
    await retainReconciliationCheckpoint(database, runId, "graph_validation", ordinal, cursor);
    if (yieldAtCheckpoint) throw new ReconciliationContinuation({ phase: "graph_validation", ordinal });
    ordinal++;
    work = 0;
    bytes = 0;
  };
  const before = async (value: unknown) => {
    if (work > 0 && bytes + new TextEncoder().encode(canonicalJson(value)).byteLength > 512000) await save();
  };
  const tick = async (value?: unknown) => {
    work++;
    if (value !== undefined) bytes += new TextEncoder().encode(canonicalJson(value)).byteLength;
    if (work >= 8 || bytes >= 512000) await save();
  };
  const nextStage = async (stage: Stage) => {
    cursor.stage = stage;
    cursor.after = null;
    cursor.observation = 0;
    cursor.headerComplete = false;
    cursor.afterEntity = "";
    cursor.pageProgress = null;
    await save();
  };
  const beginRequest = (request: R) => {
    if (cursor.after?.requestId !== request.request_id || cursor.after.complete) {
      cursor.after = { sequenceNumber: request.sequence_number, requestId: request.request_id, complete: false };
      cursor.observation = 0;
      cursor.headerComplete = false;
      cursor.pageProgress = null;
    }
  };
  const finishRequest = async () => {
    cursor.after!.complete = true;
    cursor.observation = 0;
    cursor.headerComplete = false;
    cursor.pageProgress = null;
    if (cursor.stage === "requests") cursor.processedRequests++;
    await tick();
  };
  if (cursor.stage === "gundam_requests") {
    for await (const { request, row } of evidenceAfter(cursor.after ?? undefined)) {
      beginRequest(request);
      if (row === null) {
        cursor.after!.complete = true;
        await tick();
        continue;
      }
      if (adapterForVersion(row.adapter_version).listingReconciliation?.groupsPublisherPages === true) {
        const document = await loadDocument(row);
        while (cursor.observation < document.observationCount) {
          const wrapped = await readSourceObservation(database, row.observation_set_id, cursor.observation);
          await before(wrapped);
          const compact = gundamProof(wrapped, row.source_lineage);
          if (compact) {
            if (await inputs.has(request.request_id))
              throw new Error("A Gundam listing request retained duplicate collection proofs.");
            if (new TextEncoder().encode(canonicalJson(compact)).byteLength > 512000)
              throw new Error(
                "reconciliation_capacity_exceeded: one Gundam listing proof exceeds 512000 metadata bytes.",
              );
            await inputs.seed(request.request_id, [compact]);
          }
          cursor.observation++;
          await tick(wrapped);
        }
        const observations = await inputs.get(request.request_id);
        if (observations) {
          if (work > 0) await save();
          do {
            cursor.pageProgress = await gundam.add(
              {
                requestId: request.request_id,
                requestUrl: request.url,
                sourceLineage: row.source_lineage,
                adapterVersion: row.adapter_version,
                observations,
              },
              cursor.pageProgress ?? undefined,
            );
            if (cursor.pageProgress) await save();
          } while (cursor.pageProgress);
          await finishRequest();
          await save();
          continue;
        }
      }
      await finishRequest();
    }
    await nextStage("gundam_validation");
  }
  if (cursor.stage === "gundam_validation") {
    for await (const id of gundam.validateGroups(cursor.afterEntity)) {
      cursor.afterEntity = id;
      await tick();
    }
    await gundam.completeValidation();
    await nextStage("requests");
  }
  if (cursor.stage === "requests") {
    for await (const { request, row } of evidenceAfter(cursor.after ?? undefined)) {
      beginRequest(request);
      if (row === null) {
        cursor.after!.complete = true;
        await tick();
        continue;
      }
      const adapter = adapterForVersion(row.adapter_version);
      const document = await loadDocument(row);
      if (!cursor.headerComplete) {
        const summary = document.evidenceSummary;
        if (
          summary.observation_count !== document.observationCount ||
          ((summary.structurally_complete !== true ||
            summary.required_surfaces_complete !== true ||
            summary.partitions_complete !== true ||
            summary.declared_record_count !== summary.parsed_record_count) &&
            !(await gundam.hasCompleteRequest(request.request_id)))
        )
          throw new Error(`Source Request ${request.request_id} has incomplete declared/parsed count closure.`);
        if (request.request_role === "detail") {
          const locator = new URL(request.url).searchParams.get("detailSearch");
          if (locator !== null) await details.seed(canonicalJson([row.source_lineage, locator]), true);
        }
        if (adapter.origin !== "production" || row.plan_origin !== "production")
          throw new Error(`Source Request ${request.request_id} has mismatched graph authority.`);
        if (request.request_role === "surface") {
          const prefix = `${row.source_lineage}:`;
          if (request.discovered_from_request_id !== null || !request.request_id.startsWith(prefix))
            throw new Error("Root Source Request graph identity is invalid.");
          const surface = request.request_id.slice(prefix.length);
          if (surface !== "discovery") {
            if (!(adapter.requiredSurfaces ?? []).includes(surface))
              throw new Error(
                `Official Source ${row.adapter_version} request graph contains an unexpected root surface.`,
              );
            rootSurfaces.set(row.adapter_version, new Set([...(rootSurfaces.get(row.adapter_version) ?? []), surface]));
          }
          await finishRequest();
          continue;
        }
        if (request.discovered_from_request_id === null)
          throw new Error(`Discovered Source Request ${request.request_id} has no parent.`);
        if ((await requestById(request.discovered_from_request_id)) === undefined)
          throw new Error(`Discovered Source Request ${request.request_id} does not close over a retained parent.`);
        if (request.request_role === "image" && document.observationCount !== 0)
          throw new Error("Printing Image requests cannot invent catalogue facts.");
        if (
          (request.request_role === "detail" || request.request_role === "product_detail") &&
          document.observationCount === 0
        )
          throw new Error(`Required ${request.request_role} request ${request.request_id} parsed no retained detail.`);
        cursor.headerComplete = true;
      }
      if (request.request_role === "listing") {
        while (cursor.observation < document.observationCount) {
          const observation = await readSourceObservation(database, row.observation_set_id, cursor.observation);
          await before(observation);
          if (isRecord(observation) && isRecord(observation.value)) {
            const identity =
              (adapter.listingReconciliation?.strictListingIdentity === true
                ? observation.value.listing_identity_evidence
                : undefined) ?? observation.value.identity_evidence;
            if (isRecord(identity) && typeof identity.locator === "string") {
              const key = `${row.source_lineage}:${identity.locator}`;
              const { memberships: _memberships, source_sidecar: _sidecar, ...semanticValue } = observation.value;
              const semantic = await canonicalValueDigest(semanticValue);
              const canonical = typeof identity.canonical === "string" ? identity.canonical : null;
              const prior = await locators.get(key);
              if (prior !== undefined && prior.requestId !== request.request_id) {
                const compatibility = adapter.listingReconciliation?.duplicateLocatorCompatibility ?? "never";
                if (
                  !(compatibility === "semantic"
                    ? prior.semantic === semantic
                    : compatibility === "canonical"
                      ? prior.canonical === canonical
                      : false)
                )
                  throw new Error(`Official Source leaf partitions overlap at locator ${identity.locator}.`);
              }
              await locators.seed(key, { requestId: prior?.requestId ?? request.request_id, semantic, canonical });
            }
          }
          cursor.observation++;
          await tick(observation);
        }
        const url = new URL(request.url);
        const pageEntry = [...url.searchParams.entries()].find(([key]) => /^(?:page|paged|offset)$/u.test(key));
        if (pageEntry !== undefined) {
          const page = Number.parseInt(pageEntry[1], 10);
          if (!Number.isInteger(page) || page < 0) throw new Error("Official Source listing page identity is invalid.");
          url.searchParams.delete(pageEntry[0]);
          const key = `${row.source_lineage}:${url.pathname}?${url.searchParams.toString()}`;
          const pageKey = canonicalJson([key, page]);
          if (!(await pageIds.has(pageKey))) {
            await pageIds.seed(pageKey, true);
            const prior = await pages.get(key);
            await pages.seed(key, {
              id: await canonicalValueDigest(key),
              partition: key,
              first: Math.min(prior?.first ?? page, page),
              last: Math.max(prior?.last ?? page, page),
              count: (prior?.count ?? 0) + 1,
            });
          }
        }
      }
      await finishRequest();
    }
    await nextStage("gundam_locators");
  }
  if (cursor.stage === "gundam_locators") {
    for await (const locator of gundam.locators(cursor.afterEntity)) {
      if (!(await details.has(canonicalJson([locator.sourceLineage, locator.locator]))))
        throw new Error("A complete Gundam listing collection omitted a retained Card detail request.");
      cursor.afterEntity = locator.id;
      await tick(locator);
    }
    await nextStage("listing_pages");
  }
  if (cursor.stage === "listing_pages") {
    for await (const group of pages.entityValues(cursor.afterEntity)) {
      if (group.last - group.first + 1 !== group.count)
        throw new Error(`Official Source listing partition ${group.partition} has unfinished page closure.`);
      cursor.afterEntity = group.id;
      await tick(group);
    }
    await nextStage("root_surfaces");
  }
  if (cursor.stage === "root_surfaces") {
    for (const [version, actual] of rootSurfaces) {
      const adapter = adapterForVersion(version);
      if (adapter.origin !== "production" || adapter.reconciliationCapability === "unavailable")
        throw new Error(`Official Source ${version} has invalid production coverage authority.`);
      const expected = new Set(adapter.requiredSurfaces ?? []);
      if (actual.size !== expected.size || [...expected].some((surface) => !actual.has(surface)))
        throw new Error(`Official Source ${version} request graph does not close over every required root surface.`);
    }
    await nextStage("complete");
  }
}
function gundamProof(wrapped: unknown, lineage: string) {
  const value = isRecord(wrapped) && isRecord(wrapped.value) ? wrapped.value : wrapped;
  if (
    !isRecord(value) ||
    !isRecord(value.source_sidecar) ||
    !isRecord(value.source_sidecar.raw) ||
    !Array.isArray(value.source_sidecar.raw.official_surfaces)
  )
    return null;
  const surfaces = value.source_sidecar.raw.official_surfaces.flatMap((surface) => {
    if (
      !isRecord(surface) ||
      surface.source_lineage !== lineage ||
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
    ? { value: { completeness: value.completeness, source_sidecar: { raw: { official_surfaces: surfaces } } } }
    : null;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
