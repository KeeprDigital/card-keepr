import { catalogueStore, sha256, utf8 } from "../../../src/catalogue/shared";
import * as sourceEvidenceQueries from "./query-helpers/source-evidence";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  appendDiscoveredEvidenceRequests,
  pendingEvidenceRequests,
  persistOfficialSourceCollectionPlan,
  requiredEvidenceRun,
} from "../../../src/catalogue/source-evidence";
import { administrationRequest, installRuntimeSuite } from "./runtime-helpers";

installRuntimeSuite();

// One production run composing an Official Source lineage whose collection
// plan is derived after its staged discovery with a lineage that discovers
// its requests dynamically from its own root.
const composedPlans = [
  {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "one-piece-en@6",
    subset: "complete",
    participation: "required",
    requests: [{ id: "one-piece-en:discovery", url: "https://en.onepiece-cardgame.com/cardlist/?series=569116" }],
  },
  {
    supported_game: "one-piece",
    source_lineage: "limitless-one-piece-en",
    adapter_version: "limitless-one-piece-en@1",
    subset: "p-001-catalogue",
    participation: "required",
    requests: [
      { id: "limitless-one-piece-en:p-001-catalogue", url: "https://onepiece.limitlesstcg.com/cards/en/P-001" },
    ],
  },
];

// The dynamic lineage must never occupy the sequence window the immutable-plan
// trigger reserves for the Official Source Collection Plan (issue #334: the
// first live composed One Piece run failed its Bandai shard with a
// source_requests sequence collision after Limitless discovered first).
test("a dynamically discovering lineage never blocks the composed Official Source Collection Plan", async () => {
  const created = await administrationRequest("/v1/ingestion-runs/evidence", "POST", {
    plans: composedPlans,
    idempotency_key: "composed_collection_plan_sequences_001",
  });
  expect(created.status).toBe(201);
  const { id: runId } = await created.json<{ id: string }>();
  const store = catalogueStore(env.CATALOGUE_DB);
  const run = await requiredEvidenceRun(store, runId);
  const pending = await pendingEvidenceRequests(store, runId);
  const limitlessRoot = pending.find((request) => request.request_id === "limitless-one-piece-en:p-001-catalogue");
  const discovery = pending.find((request) => request.request_id === "one-piece-en:discovery");
  if (limitlessRoot === undefined || discovery === undefined) throw new Error("composed roots are absent");

  // The dynamic lineage discovers first, exactly as the live run interleaved.
  const variants = await appendDiscoveredEvidenceRequests(
    store,
    run,
    limitlessRoot,
    Array.from({ length: 5 }, (_, index) => ({
      role: "detail" as const,
      url: `https://onepiece.limitlesstcg.com/cards/en/P-001?v=${index + 1}`,
      headers: { accept: "text/html" },
    })),
  );
  expect(variants).toHaveLength(5);

  const bytes = utf8("<html>bandai discovery</html>");
  const digest = await sha256(bytes);
  const snapshotId = `srcsnap_${digest}`;
  const fetchId = `srcfetch_${digest}`;
  const objectKey = `source-snapshots/${snapshotId}.bin`;
  await env.EVIDENCE_OBJECTS.put(objectKey, bytes);
  const observationSetId = "srcobsset_composed_sequences_001";
  await store.batch([
    sourceEvidenceQueries
      .insertSourceFetchAttemptsForRetainCapturedDiscoveryRoot(env.CATALOGUE_DB)
      .bind(fetchId, runId, discovery.request_id),
    sourceEvidenceQueries
      .insertSourceSnapshotsForComposedCollectionPlanSequences(env.CATALOGUE_DB)
      .bind(
        snapshotId,
        runId,
        discovery.request_id,
        fetchId,
        discovery.url,
        digest,
        digest,
        bytes.byteLength,
        objectKey,
      ),
    sourceEvidenceQueries
      .insertSourceParseOperationsForComposedCollectionPlanSequences(env.CATALOGUE_DB)
      .bind(
        "srcparse_composed_sequences_001",
        snapshotId,
        "composed_sequences_parse_001",
        observationSetId,
        `source-observation-sets/${observationSetId}.json`,
      ),
    sourceEvidenceQueries
      .insertSourceObservationSetsForComposedCollectionPlanSequences(env.CATALOGUE_DB)
      .bind(
        observationSetId,
        "srcparse_composed_sequences_001",
        snapshotId,
        `source-observation-sets/${observationSetId}.json`,
      ),
  ]);
  const collectionRequests = ["card-list", "products", "releases", "errata"].map((surface, index) => ({
    id: `one-piece-en:${surface}`,
    method: "GET" as const,
    url: `https://en.onepiece-cardgame.com/${surface}/`,
    headers: { accept: "text/html" },
    representation_fingerprint: String(index).repeat(64),
    surface,
  }));
  await expect(
    persistOfficialSourceCollectionPlan(store, runId, observationSetId, collectionRequests),
  ).resolves.toBeUndefined();
  const rows = (
    await sourceEvidenceQueries
      .readSourceRequestSequencesForComposedCollectionPlanSequences(env.CATALOGUE_DB)
      .bind(runId)
      .all<{ request_id: string; sequence_number: number; request_role: string }>()
  ).results;
  expect(rows).toHaveLength(2 + 5 + 4);
  expect(new Set(rows.map((row) => row.sequence_number)).size).toBe(rows.length);
  const planned = rows.filter((row) => collectionRequests.some((request) => request.id === row.request_id));
  expect(planned.map((row) => row.request_id)).toEqual(collectionRequests.map((request) => request.id));
  // Replaying the identical derivation is idempotent.
  await expect(
    persistOfficialSourceCollectionPlan(store, runId, observationSetId, collectionRequests),
  ).resolves.toBeUndefined();
  // Later dynamic discovery keeps appending after everything retained so far.
  const later = await appendDiscoveredEvidenceRequests(store, run, limitlessRoot, [
    {
      role: "detail" as const,
      url: "https://onepiece.limitlesstcg.com/cards/en/P-001?v=9",
      headers: { accept: "text/html" },
    },
  ]);
  const maximum = Math.max(...rows.map((row) => row.sequence_number));
  expect(later[0]!.sequence_number).toBeGreaterThan(maximum);
}, 30_000);
