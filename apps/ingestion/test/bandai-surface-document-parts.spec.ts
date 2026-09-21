import { catalogueStore, sha256 } from "../../../src/catalogue/shared";
import * as sourceEvidenceQueries from "./query-helpers/source-evidence";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  parseCapturedRequest,
  pendingEvidenceRequests,
  persistOfficialSourceCollectionPlan,
  requiredEvidenceRun,
} from "../../../src/catalogue/source-evidence";
import { officialSourceDiscoveryRequests } from "../../../src/catalogue/adapters";
import retainedSeriesPage from "../../../acceptance/fixtures/retained-official-source/one-piece-en-card-list-op16-series.json";
import { administrationRequest, installRuntimeSuite } from "./runtime-helpers";

installRuntimeSuite();

async function retainOnePieceSnapshot(runId: string, requestId: string, url: string, bytes: Uint8Array) {
  const digest = await sha256(bytes);
  const snapshotId = `srcsnap_${digest}`;
  const fetchId = `srcfetch_${digest}`;
  const objectKey = `source-snapshots/${snapshotId}.bin`;
  await env.EVIDENCE_OBJECTS.put(objectKey, bytes);
  await catalogueStore(env.CATALOGUE_DB).batch([
    sourceEvidenceQueries
      .insertSourceFetchAttemptsForRetainCapturedDiscoveryRoot(env.CATALOGUE_DB)
      .bind(fetchId, runId, requestId),
    sourceEvidenceQueries
      .insertSourceSnapshotsForComposedCollectionPlanSequences(env.CATALOGUE_DB)
      .bind(snapshotId, runId, requestId, fetchId, url, digest, digest, bytes.byteLength, objectKey),
  ]);
  return snapshotId;
}

// The live OP16 series page (155 Cards, 414,702 bytes) parsed into a first
// observation of 820,364 bytes and 16,938 nodes because the whole surface
// document and its derived field maps were inlined; the bounded intake
// refuses that as source_parse_failed (issue #334). The page must parse
// through the real intake, retaining the document once as auxiliary text.
test("a full Bandai series page parses through the bounded source intake", async () => {
  const created = await administrationRequest("/v1/ingestion-runs/evidence", "POST", {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "one-piece-en@6",
    idempotency_key: "bandai_surface_document_parts_001",
    requests: officialSourceDiscoveryRequests("one-piece-en"),
  });
  expect(created.status).toBe(201);
  const { id: runId } = await created.json<{ id: string }>();
  const store = catalogueStore(env.CATALOGUE_DB);
  const run = await requiredEvidenceRun(store, runId);
  const [discovery] = await pendingEvidenceRequests(store, runId);
  if (discovery === undefined) throw new Error("discovery root request is absent");
  const discoverySnapshot = await retainOnePieceSnapshot(
    runId,
    discovery.request_id,
    discovery.url,
    new TextEncoder().encode("<html>discovery</html>"),
  );
  const observationSetId = "srcobsset_surface_document_parts_001";
  await store.batch([
    sourceEvidenceQueries
      .insertSourceParseOperationsForComposedCollectionPlanSequences(env.CATALOGUE_DB)
      .bind(
        "srcparse_surface_document_parts_001",
        discoverySnapshot,
        "surface_document_parts_parse_001",
        observationSetId,
        `source-observation-sets/${observationSetId}.json`,
      ),
    sourceEvidenceQueries
      .insertSourceObservationSetsForComposedCollectionPlanSequences(env.CATALOGUE_DB)
      .bind(
        observationSetId,
        "srcparse_surface_document_parts_001",
        discoverySnapshot,
        `source-observation-sets/${observationSetId}.json`,
      ),
  ]);
  const surfaces = ["card-list", "products", "releases", "errata"];
  await persistOfficialSourceCollectionPlan(
    store,
    runId,
    observationSetId,
    surfaces.map((surface, index) => ({
      id: `one-piece-en:${surface}`,
      method: "GET" as const,
      url: surface === "card-list" ? retainedSeriesPage.source_url : `https://en.onepiece-cardgame.com/${surface}/`,
      headers: { accept: "text/html" },
      representation_fingerprint: String(index).repeat(64),
      surface,
    })),
  );
  const cardList = (await pendingEvidenceRequests(store, runId)).find(
    (request) => request.request_id === "one-piece-en:card-list",
  );
  if (cardList === undefined) throw new Error("card-list surface request is absent");
  const bytes = Uint8Array.from(atob(retainedSeriesPage.body_base64), (character) => character.charCodeAt(0));
  expect(bytes.byteLength).toBe(retainedSeriesPage.full_body_size);
  expect(await sha256(bytes)).toBe(retainedSeriesPage.body_sha256);
  const snapshotId = await retainOnePieceSnapshot(runId, cardList.request_id, cardList.url, bytes);

  await expect(parseCapturedRequest(store, env.EVIDENCE_OBJECTS, run, cardList, snapshotId)).resolves.toMatchObject({
    kind: "done",
    failure_code: null,
  });
  const parsed = await sourceEvidenceQueries
    .readParsedObservationSetForBandaiSurfaceDocumentParts(env.CATALOGUE_DB)
    .bind(snapshotId)
    .first<{ state: string; observation_count: number; text_parts: number }>();
  expect(parsed).toMatchObject({ state: "finalized", observation_count: 155 });
  expect(parsed!.text_parts).toBeGreaterThan(0);
}, 60_000);
