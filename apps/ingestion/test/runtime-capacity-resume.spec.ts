import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  pauseEvidenceRunForRequestCapacity,
  RequestCapacityProblem,
} from "../../../src/catalogue/source-evidence-repository";
import {
  administrationRequest,
  fixtureEvidenceRequest,
  installRuntimeSuite,
  waitForEvidenceRun,
} from "./runtime-helpers";
import {
  fusionWorldRequestCapacity,
  pauseRunAtCapacity,
} from "./capacity-pause-helpers";

installRuntimeSuite();

async function catalogueRevisionCount(): Promise<unknown> {
  return env.CATALOGUE_DB.prepare(
    "SELECT COUNT(*) AS count FROM catalogue_revisions",
  ).first("count");
}

async function terminateRunWorkflows(
  runId: string,
  parentWorkflowId: string,
): Promise<void> {
  const plan = await env.CATALOGUE_DB.prepare(
    `SELECT child_workflow_ids_json FROM ingestion_evidence_plans
     WHERE ingestion_run_id = ?`,
  ).bind(runId).first<{ child_workflow_ids_json: string | null }>();
  const childIds: string[] = JSON.parse(plan?.child_workflow_ids_json ?? "[]");
  for (const id of [parentWorkflowId, ...childIds]) {
    try {
      const instance = id === parentWorkflowId
        ? await env.EVIDENCE_INGESTION_WORKFLOW.get(id)
        : await env.EVIDENCE_HOST_WORKFLOW.get(id);
      await instance.terminate();
    } catch {
      // The handle may not exist or may already be settled.
    }
  }
}

test("resuming an extended run derives the overflow batch again without refetching retained work", async () => {
  // Fillers are retained as already observed Source Requests so the resumed
  // collection proves they are neither fetched nor parsed again.
  const { runId, root, snapshotId } = await pauseRunAtCapacity(
    "capacity_resume_noretch_001",
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
  expect(pause.required_capacity).toBeLessThan(25_000);
  const revisionsBefore = await catalogueRevisionCount();

  const extended = await administrationRequest(
    `/v1/ingestion-runs/${runId}/capacity/extension`,
    "POST",
    {
      expected_request_capacity: fusionWorldRequestCapacity,
      expected_capacity_generation: 1,
      request_capacity: pause.required_capacity,
      idempotency_key: "capacity_resume_noretch_extension_001",
    },
  );
  expect(extended.status).toBe(200);

  const resumedParentId = `evidence-${runId}-resume-2`;
  try {
    // The single collection-resume command moves the same run from paused
    // back to collecting and starts the required Workflow work.
    const resumed = await administrationRequest(
      `/v1/ingestion-runs/${runId}/collection/resume`,
      "POST",
    );
    expect(resumed.status).toBe(202);
    await expect(resumed.json()).resolves.toMatchObject({
      ingestion_run_id: runId,
      workflow: { id: resumedParentId },
    });
    expect(await env.CATALOGUE_DB.prepare(
      "SELECT state FROM ingestion_runs WHERE id = ?",
    ).bind(runId).first("state")).toBe("collecting");
    expect(await env.CATALOGUE_DB.prepare(
      `SELECT from_state, to_state FROM ingestion_run_transitions
       WHERE ingestion_run_id = ? ORDER BY sequence DESC LIMIT 1`,
    ).bind(runId).first()).toMatchObject({
      from_state: "paused",
      to_state: "collecting",
    });

    // Resuming again reacquires the same Workflow instead of starting more.
    const replayed = await administrationRequest(
      `/v1/ingestion-runs/${runId}/collection/resume`,
      "POST",
    );
    expect(replayed.status).toBe(202);
    await expect(replayed.json()).resolves.toMatchObject({
      workflow: { id: resumedParentId },
    });

    // The rejected overflow batch is derived again from the retained
    // discovery evidence and admitted under the new capacity.
    const deadline = Date.now() + 20_000;
    for (;;) {
      const parent = await env.CATALOGUE_DB.prepare(
        `SELECT state FROM source_requests
         WHERE ingestion_run_id = ? AND request_id = ?`,
      ).bind(runId, root.request_id).first("state");
      if (parent === "observed") break;
      if (Date.now() >= deadline) {
        throw new Error("the parent Source Request was not observed again");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(await env.CATALOGUE_DB.prepare(
      `SELECT COUNT(*) AS count FROM source_requests
       WHERE ingestion_run_id = ?`,
    ).bind(runId).first("count")).toBe(
      fusionWorldRequestCapacity + pause.overflow_request_count,
    );

    // The parent Source Request resumed from its retained Source Snapshot:
    // the only fetch attempt in the whole run is the one retained before the
    // pause, so nothing already captured or observed was fetched again.
    expect(await env.CATALOGUE_DB.prepare(
      `SELECT COUNT(*) AS count FROM source_fetch_attempts
       WHERE ingestion_run_id = ?`,
    ).bind(runId).first("count")).toBe(1);
    expect(await env.CATALOGUE_DB.prepare(
      `SELECT state, source_snapshot_id FROM source_requests
       WHERE ingestion_run_id = ? AND request_id = ?`,
    ).bind(runId, root.request_id).first()).toMatchObject({
      state: "observed",
      source_snapshot_id: snapshotId,
    });
    // Reparsing the retained snapshot replays the retained Source
    // Observation Set instead of appending another interpretation.
    expect(await env.CATALOGUE_DB.prepare(
      `SELECT COUNT(*) AS count FROM source_observation_sets
       WHERE source_snapshot_id = ?`,
    ).bind(snapshotId).first("count")).toBe(1);

    // The immutable pause record, the extension record, and the current
    // Catalogue Revision all survive the resumed collection unchanged.
    expect(await env.CATALOGUE_DB.prepare(
      `SELECT COUNT(*) AS count FROM ingestion_run_capacity_pauses
       WHERE ingestion_run_id = ?`,
    ).bind(runId).first("count")).toBe(1);
    expect(await env.CATALOGUE_DB.prepare(
      `SELECT capacity_generation FROM ingestion_run_capacity_extensions
       WHERE ingestion_run_id = ?`,
    ).bind(runId).first("capacity_generation")).toBe(2);
    expect(await catalogueRevisionCount()).toEqual(revisionsBefore);
  } finally {
    await terminateRunWorkflows(runId, resumedParentId);
  }
}, 30_000);

test("a resumed run advances through the existing completeness gates once collection finishes", async () => {
  const created = await fixtureEvidenceRequest({
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@1",
    idempotency_key: "capacity_resume_complete_001",
    requests: [
      { id: "cards", url: "https://official-source.invalid/cards" },
    ],
  });
  expect(created.status).toBe(201);
  const run = await created.json<{ id: string }>();
  const revisionsBefore = await catalogueRevisionCount();

  // Pause the run through the production pause path, then extend and resume.
  await pauseEvidenceRunForRequestCapacity(
    env.CATALOGUE_DB,
    run.id,
    "cards",
    new RequestCapacityProblem({
      source_lineage: "one-piece-en",
      request_capacity: 5_000,
      capacity_generation: 1,
      used_capacity: 5_000,
      overflow_request_count: 1,
      required_capacity: 5_001,
    }),
  );
  expect(await env.CATALOGUE_DB.prepare(
    "SELECT state FROM ingestion_runs WHERE id = ?",
  ).bind(run.id).first("state")).toBe("paused");
  const extended = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/capacity/extension`,
    "POST",
    {
      expected_request_capacity: 5_000,
      expected_capacity_generation: 1,
      request_capacity: 6_000,
      idempotency_key: "capacity_resume_complete_extension_001",
    },
  );
  expect(extended.status).toBe(200);
  const resumed = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(resumed.status).toBe(202);

  // The same Ingestion Run collects its pending request and advances into
  // parsing through the unchanged completeness gates.
  const completed = await waitForEvidenceRun(run.id, "parsing");
  expect(completed.state).toBe("parsing");
  expect(completed.snapshots).toHaveLength(1);
  const transitions = await env.CATALOGUE_DB.prepare(
    `SELECT from_state, to_state FROM ingestion_run_transitions
     WHERE ingestion_run_id = ? ORDER BY sequence`,
  ).bind(run.id).all();
  expect(transitions.results.slice(-3)).toEqual([
    { from_state: "collecting", to_state: "paused" },
    { from_state: "paused", to_state: "collecting" },
    { from_state: "collecting", to_state: "parsing" },
  ]);
  expect(await catalogueRevisionCount()).toEqual(revisionsBefore);
}, 30_000);
