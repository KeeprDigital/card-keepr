import { catalogueStore } from "../../../src/catalogue/shared";
import * as sourceEvidenceQueries from "./query-helpers/source-evidence";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  appendDiscoveredEvidenceRequests,
  pendingEvidenceRequests,
  requiredEvidenceRun,
} from "../../../src/catalogue/source-evidence";
import {
  administrationRequest,
  type CollectionDocument,
  fixtureEvidenceRequest,
  installRuntimeSuite,
  showCollection,
  waitForEvidenceCondition,
} from "./runtime-helpers";

installRuntimeSuite();

// The production-sized shape that regressed to terminal capacity failure at
// the old fixed 5,000-request bound: one Source Lineage whose unique request
// graph exceeds that bound completes collection under its legitimate Source
// Adapter Version capacity. Most identities are retained as already observed
// work (exactly what a resumed run carries), and the remaining live requests
// collect through two bounded 200-request hostname shards under production
// per-host pacing. The local Workflow emulator cannot sustain dozens of
// concurrent paced shards, so the live share is sized to what it proves:
// the lineage passes 5,000 identities without pausing and the unchanged
// completeness gate advances the run.
const retainedObservedCount = 4_800;
const liveHosts = ["a", "b"] as const;
const requestsPerHost = 200;

test("a single-lineage graph larger than 5,000 requests completes collection through bounded host shards", async () => {
  const created = await fixtureEvidenceRequest({
    supported_game: "fusion-world",
    source_lineage: "fusion-world-en",
    adapter_version: "fixture-fusion-world-json-large@1",
    idempotency_key: "collection_completion_stress_001",
    requests: [{ id: "root", url: "https://official-source.invalid/cards" }],
  });
  expect(created.status).toBe(201);
  const run = await created.json<CollectionDocument>();
  const storedRun = await requiredEvidenceRun(catalogueStore(env.CATALOGUE_DB), run.id);
  const root = (await pendingEvidenceRequests(catalogueStore(env.CATALOGUE_DB), run.id))[0];
  if (root === undefined) throw new Error("pending root request missing");

  // Retained, already observed identities occupy sequence numbers
  // 1000..5799, so the live requests appended afterwards start exactly on a
  // 200-request shard boundary: one bounded shard per live host.
  await env.CATALOGUE_DB.batch([
    sourceEvidenceQueries
      .inspectFillerForSingleLineageGraphLargerThan5000RequestsCompletes(env.CATALOGUE_DB)
      .bind(run.id, retainedObservedCount, root.request_id),
    sourceEvidenceQueries
      .insertSourceRequestsForSingleLineageGraphLargerThan5000RequestsCompletes(env.CATALOGUE_DB)
      .bind(run.id),
  ]);
  const discovered = liveHosts.flatMap((host) =>
    Array.from({ length: requestsPerHost }, (_, index) => ({
      role: "detail" as const,
      url: `https://graph-${host}-official-source.invalid/sequence/${String(index + 1).padStart(4, "0")}`,
      headers: { accept: "application/json" },
    })),
  );
  await appendDiscoveredEvidenceRequests(catalogueStore(env.CATALOGUE_DB), storedRun, root, discovered);
  const totalRequests = 1 + retainedObservedCount + discovered.length;
  expect(totalRequests).toBeGreaterThan(5_000);
  expect(await sourceEvidenceQueries.countSourceRequestsCount(env.CATALOGUE_DB).bind(run.id).first("count")).toBe(
    totalRequests,
  );

  const resumed = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/resume`, "POST");
  expect(resumed.status).toBe(202);
  await resumed.body?.cancel();
  let completed: CollectionDocument | undefined;
  try {
    completed = await waitForEvidenceCondition(run.id, (current) => current.state !== "collecting", 420_000);
  } finally {
    const current = await showCollection(run.id);
    if (current.state === "collecting") {
      if (current.workflow.parent_id !== null) {
        await (await env.EVIDENCE_INGESTION_WORKFLOW.get(current.workflow.parent_id))
          .terminate()
          .catch(() => undefined);
      }
      for (const childId of current.workflow.child_ids) {
        await (await env.EVIDENCE_HOST_WORKFLOW.get(childId)).terminate().catch(() => undefined);
      }
    }
  }
  expect(completed?.state).toBe("parsing");
  expect(completed?.failure_code).toBeNull();
  const collection = completed?.collection as {
    requests: { total: number; by_state: Record<string, number> };
    evidence: Record<string, unknown>;
    capacity: Array<Record<string, unknown>>;
  };
  expect(collection.requests).toMatchObject({
    total: totalRequests,
    by_state: { observed: totalRequests },
  });
  // The live share was fetched exactly once each and parsed; the retained
  // share was neither fetched nor parsed again.
  expect(collection.evidence).toMatchObject({
    snapshot_count: 1 + discovered.length,
    observation_set_count: 1 + discovered.length,
    fetch_attempt_count: 1 + discovered.length,
    retry_attempt_count: 0,
    failed_attempt_count: 0,
    snapshots_truncated: true,
  });
  expect(collection.capacity).toEqual([
    {
      source_lineage: "fusion-world-en",
      adapter_version: "fixture-fusion-world-json-large@1",
      capacity_generation: 1,
      request_capacity: 15_000,
      used_capacity: totalRequests,
      remaining_capacity: 15_000 - totalRequests,
      required_capacity: null,
      overflow_request_count: null,
    },
  ]);
  // Each live host collected through its own bounded shard, and the bounded
  // detail lists stayed bounded while the aggregate counts stayed exact.
  const childIds = completed?.workflow.child_ids ?? [];
  expect(childIds.length).toBeGreaterThanOrEqual(1 + liveHosts.length);
  expect(completed?.snapshots).toHaveLength(200);
  expect(completed?.diagnostics).toHaveLength(200);
  expect(
    await sourceEvidenceQueries.countIngestionRunCapacityPausesCount(env.CATALOGUE_DB).bind(run.id).first("count"),
  ).toBe(0);
  expect(
    await sourceEvidenceQueries.countIngestionRunRetryPausesCount(env.CATALOGUE_DB).bind(run.id).first("count"),
  ).toBe(0);
}, 480_000);
