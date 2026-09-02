import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  administrationRequest,
  type CollectionDocument,
  installRuntimeSuite,
  showCollection,
  waitForEvidenceCondition,
} from "./runtime-helpers";
import {
  fusionWorldRequestCapacity,
  pauseRunAtCapacity,
} from "./capacity-pause-helpers";

installRuntimeSuite();

// The production-shaped pause -> extend -> resume path: a fusion-world-en@9
// run paused at its full 15,000-identity capacity is extended through the
// compare-and-set administration action and resumed under production source
// host pacing. The resumed hostname shard re-parses the retained discovery
// snapshot without another Official Source fetch, admits the rejected
// overflow batch under the new capacity, and continues bounded hostname
// sharding for the pending overflow.
test("an extended production-shaped run resumes into bounded host shards without refetching", async () => {
  const { runId, root } = await pauseRunAtCapacity(
    "source_capacity_resume_stress_001",
    "observed",
  );
  const pause = await env.CATALOGUE_DB.prepare(
    `SELECT overflow_request_count, required_capacity
     FROM ingestion_run_capacity_pauses WHERE ingestion_run_id = ?`,
  ).bind(runId).first<{
    overflow_request_count: number;
    required_capacity: number;
  }>();
  if (pause === null) throw new Error("capacity pause record is absent");

  const extended = await administrationRequest(
    `/v1/ingestion-runs/${runId}/capacity/extension`,
    "POST",
    {
      expected_request_capacity: fusionWorldRequestCapacity,
      expected_capacity_generation: 1,
      request_capacity: pause.required_capacity,
      idempotency_key: "source_capacity_resume_stress_extension_001",
    },
  );
  expect(extended.status).toBe(200);

  let observed: CollectionDocument | undefined;
  try {
    const resumed = await administrationRequest(
      `/v1/ingestion-runs/${runId}/collection/resume`,
      "POST",
    );
    expect(resumed.status).toBe(202);
    await expect(resumed.json()).resolves.toMatchObject({
      workflow: { id: `evidence-${runId}-resume-1` },
    });

    // The overflow batch is admitted again and the pending overflow work
    // continues through bounded hostname shards beyond the parent's shard.
    observed = await waitForEvidenceCondition(
      runId,
      (current) =>
        current.state === "collecting" &&
        current.workflow.child_ids.length >= 2,
      60_000,
    );
    expect(await env.CATALOGUE_DB.prepare(
      `SELECT COUNT(*) AS count FROM source_requests
       WHERE ingestion_run_id = ?`,
    ).bind(runId).first("count")).toBe(
      fusionWorldRequestCapacity + pause.overflow_request_count,
    );
    expect(await env.CATALOGUE_DB.prepare(
      `SELECT state FROM source_requests
       WHERE ingestion_run_id = ? AND request_id = ?`,
    ).bind(runId, root.request_id).first("state")).toBe("observed");

    // The parent Source Request was re-parsed from its retained Source
    // Snapshot: the root still holds exactly the one fetch attempt retained
    // before the pause, so nothing captured or observed was fetched again.
    // (Pending overflow requests may already be collecting through the
    // resumed hostname shards by now, so the run-wide attempt count is not
    // a stable observation.)
    expect(await env.CATALOGUE_DB.prepare(
      `SELECT COUNT(*) AS count FROM source_fetch_attempts
       WHERE ingestion_run_id = ? AND request_id = ?`,
    ).bind(runId, root.request_id).first("count")).toBe(1);
  } finally {
    const current = await showCollection(runId);
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
  expect(observed?.state).toBe("collecting");
}, 120_000);
