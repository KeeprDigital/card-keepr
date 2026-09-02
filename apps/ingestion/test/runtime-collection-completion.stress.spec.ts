import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  appendDiscoveredEvidenceRequests,
  pendingEvidenceRequests,
  requiredEvidenceRun,
} from "../../../src/catalogue/source-evidence-repository";
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
    requests: [
      { id: "root", url: "https://official-source.invalid/cards" },
    ],
  });
  expect(created.status).toBe(201);
  const run = await created.json<CollectionDocument>();
  const storedRun = await requiredEvidenceRun(env.CATALOGUE_DB, run.id);
  const root = (await pendingEvidenceRequests(env.CATALOGUE_DB, run.id))[0];
  if (root === undefined) throw new Error("pending root request missing");

  // Retained, already observed identities occupy sequence numbers
  // 1000..5799, so the live requests appended afterwards start exactly on a
  // 200-request shard boundary: one bounded shard per live host.
  await env.CATALOGUE_DB.batch([
    env.CATALOGUE_DB.prepare(
      `WITH RECURSIVE filler(n) AS (
         SELECT 1 UNION ALL SELECT n + 1 FROM filler WHERE n < ?2
       )
       INSERT INTO source_discovery_request_plans (
         ingestion_run_id, request_id, sequence_number, parent_request_id,
         method, url, request_headers_json, representation_fingerprint,
         request_role
       )
       SELECT ?1, 'fusion-world-en:detail:' || printf('%08d', n), 999 + n,
              ?3, 'GET',
              'https://retained-official-source.invalid/sequence/' || n,
              '{}', printf('%064x', n), 'detail'
       FROM filler`,
    ).bind(run.id, retainedObservedCount, root.request_id),
    env.CATALOGUE_DB.prepare(
      `INSERT INTO source_requests (
         ingestion_run_id, request_id, sequence_number, method, url,
         request_headers_json, representation_fingerprint, state,
         source_snapshot_id, failure_code, request_role,
         discovered_from_request_id
       )
       SELECT ingestion_run_id, request_id, sequence_number, method, url,
              request_headers_json, representation_fingerprint, 'observed',
              NULL, NULL, request_role, parent_request_id
       FROM source_discovery_request_plans
       WHERE ingestion_run_id = ?1
         AND request_id LIKE 'fusion-world-en:detail:%'`,
    ).bind(run.id),
  ]);
  const discovered = liveHosts.flatMap((host) =>
    Array.from({ length: requestsPerHost }, (_, index) => ({
      role: "detail" as const,
      url: `https://graph-${host}-official-source.invalid/sequence/${String(index + 1).padStart(4, "0")}`,
      headers: { accept: "application/json" },
    }))
  );
  await appendDiscoveredEvidenceRequests(
    env.CATALOGUE_DB,
    storedRun,
    root,
    discovered,
  );
  const totalRequests = 1 + retainedObservedCount + discovered.length;
  expect(totalRequests).toBeGreaterThan(5_000);
  expect(await env.CATALOGUE_DB.prepare(
    "SELECT COUNT(*) AS count FROM source_requests WHERE ingestion_run_id = ?",
  ).bind(run.id).first("count")).toBe(totalRequests);

  const resumed = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(resumed.status).toBe(202);
  await resumed.body?.cancel();
  let completed: CollectionDocument | undefined;
  try {
    completed = await waitForEvidenceCondition(
      run.id,
      (current) => current.state !== "collecting",
      420_000,
    );
  } finally {
    const current = await showCollection(run.id);
    if (current.state === "collecting") {
      if (current.workflow.parent_id !== null) {
        await (await env.EVIDENCE_INGESTION_WORKFLOW.get(
          current.workflow.parent_id,
        )).terminate().catch(() => undefined);
      }
      for (const childId of current.workflow.child_ids) {
        await (await env.EVIDENCE_HOST_WORKFLOW.get(childId)).terminate()
          .catch(() => undefined);
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
  expect(collection.capacity).toEqual([{
    source_lineage: "fusion-world-en",
    adapter_version: "fixture-fusion-world-json-large@1",
    capacity_generation: 1,
    request_capacity: 15_000,
    used_capacity: totalRequests,
    remaining_capacity: 15_000 - totalRequests,
    required_capacity: null,
    overflow_request_count: null,
  }]);
  // Each live host collected through its own bounded shard, and the bounded
  // detail lists stayed bounded while the aggregate counts stayed exact.
  const childIds = completed?.workflow.child_ids ?? [];
  expect(childIds.length).toBeGreaterThanOrEqual(1 + liveHosts.length);
  expect(completed?.snapshots).toHaveLength(200);
  expect(completed?.diagnostics).toHaveLength(200);
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM ingestion_run_capacity_pauses
     WHERE ingestion_run_id = ?`,
  ).bind(run.id).first("count")).toBe(0);
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM ingestion_run_retry_pauses
     WHERE ingestion_run_id = ?`,
  ).bind(run.id).first("count")).toBe(0);
}, 480_000);
