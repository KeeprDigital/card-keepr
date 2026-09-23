import { env } from "cloudflare:workers";
import type { WorkflowStep } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  canonicalJson,
  catalogueStore,
  sha256,
  utf8,
  workflowStepName,
  workflowSteps,
} from "../../../src/catalogue/shared";
import {
  collectionBarrierPollCeiling,
  evidenceHostShardRequestCapacity,
  pendingEvidenceRequests,
  recordWorkflowIds,
} from "../../../src/catalogue/source-evidence";
import { EvidenceIngestionWorkflow } from "../src/evidence-workflows";
import { boundedWorkflowInvocation } from "../src/workflow-invocation-budget";
import * as sourceEvidenceQueries from "./query-helpers/source-evidence";
import { administrationRequest, createCollection, installRuntimeSuite } from "./runtime-helpers";

installRuntimeSuite();

class StopPolling extends Error {}

const hostname = "official-source.invalid";

/**
 * Drive the production parent Workflow body through `polls` barrier polls
 * while its one hostname shard reports the status `status` reports, and
 * return the child identities it dispatched.
 */
async function pollBarrier(
  runId: string,
  polls: number,
  status: (id: string) => string,
): Promise<{ created: string[]; waits: number; result: unknown }> {
  const parentId = `evidence-${runId}`;
  await recordWorkflowIds(catalogueStore(env.CATALOGUE_DB), runId, parentId, []);
  const created: string[] = [];
  const hostWorkflow = {
    async get(id: string) {
      if (!created.includes(id)) throw new Error("instance.not_found");
      return { id, status: async () => ({ status: status(id) }) };
    },
    async createBatch(batch: { id: string }[]) {
      // createBatch is idempotent for deterministic identities, so record
      // each identity once however often the barrier re-ensures it.
      for (const { id } of batch) if (!created.includes(id)) created.push(id);
      return batch.map(({ id }) => ({ id }));
    },
  } as unknown as Workflow;
  const measured = boundedWorkflowInvocation({ ...env, EVIDENCE_HOST_WORKFLOW: hostWorkflow }, {} as WorkflowStep, {
    mode: "immediate",
    budget: Number.POSITIVE_INFINITY,
  });
  let waits = 0;
  const step = {
    async do(name: string, configOrCallback: unknown, possibleCallback?: unknown) {
      const callback = (typeof configOrCallback === "function" ? configOrCallback : possibleCallback) as (
        context: unknown,
      ) => Promise<unknown>;
      const result = await callback({ step: { name, count: 1 }, attempt: 1 });
      return result === undefined ? undefined : structuredClone(result);
    },
    async sleep(name: string) {
      if (name.startsWith("yield Workflow invocation after ")) return;
      waits += 1;
      if (waits === polls) throw new StopPolling();
    },
  } as unknown as WorkflowStep;
  const workflow = Object.assign(Object.create(EvidenceIngestionWorkflow.prototype) as EvidenceIngestionWorkflow, {
    env: { ...(measured.env as Env), WORKFLOW_WAIT_MODE: "immediate" },
  });
  // The body either keeps polling until the harness stops it, or returns
  // because the run left its collection phase. Both are observable outcomes.
  let result: unknown = null;
  try {
    result = await workflow.run(
      {
        payload: { ingestion_run_id: runId },
        timestamp: new Date(),
        instanceId: parentId,
        workflowName: "card-keepr-evidence-ingestion",
      },
      step,
    );
  } catch (error) {
    if (!(error instanceof StopPolling)) throw error;
  }
  return { created, waits, result };
}

async function shardIdentity(runId: string): Promise<string> {
  return `evidence-host-${await sha256(
    utf8(
      canonicalJson({
        ingestion_run_id: runId,
        hostname,
        minimum_sequence_number: 0,
        maximum_sequence_number: evidenceHostShardRequestCapacity - 1,
      }),
    ),
  )}`;
}

// Issue #445. A hostname shard drains every pending Source Request its
// sequence window holds and returns; the window then shows pending work again
// only because later discovery admitted new requests into it. The parent used
// to treat each of those normal completions as a failed Workflow Attempt
// needing a replacement identity, so a healthy shard spent its four bounded
// identities in four polls, was declared `source_workflow_retries_exhausted`,
// and had every Source Request in its window failed with no fetch ever
// attempted. The retained One Piece replay lost 448 image requests that way
// while the runtime sat idle.
test("a hostname shard that keeps completing normally is continued, not exhausted", async () => {
  const run = await createCollection("source_shard_succession_001", `https://${hostname}/cards`);
  const baseChildId = await shardIdentity(run.id);

  // Every dispatched instance reports the status a shard that drained its
  // window and returned reports: complete.
  const { created } = await pollBarrier(run.id, 6, () => "complete");

  // The Source Request is still pending work, not evidence of a dead shard.
  // Before the fix this read `source_workflow_retries_exhausted` after the
  // fourth poll, with no fetch ever attempted.
  const requests = await sourceEvidenceQueries
    .readSourceRequestStateFailureCodes(env.CATALOGUE_DB)
    .bind(run.id)
    .all<{ request_id: string; state: string; failure_code: string | null }>();
  expect(requests.results.map(({ state, failure_code }) => [state, failure_code])).toEqual([["pending", null]]);

  // One dispatch per poll, all continuations after the base identity, and no
  // replacement identity spent: nothing failed, so nothing was recovered.
  expect(created[0]).toBe(baseChildId);
  expect(created.slice(1)).toEqual([0, 1, 2, 3, 4].map((index) => `${baseChildId}-continue-${index}`));
  expect(created.filter((id) => id.includes("-attempt-"))).toEqual([]);

  const attempts = await sourceEvidenceQueries
    .countSourceFetchAttemptsCount(env.CATALOGUE_DB)
    .bind(run.id)
    .first<{ count: number }>();
  expect(attempts?.count).toBe(0);
});

// The bounded replacement budget still exists, and still ends the same way:
// an instance that did not finish normally spends one, and the fourth
// identity fails the shard's Source Requests deterministically.
test("a hostname shard that keeps erroring still exhausts its bounded replacements", async () => {
  const run = await createCollection("source_shard_replacement_001", `https://${hostname}/cards`);
  const baseChildId = await shardIdentity(run.id);

  const { created, result } = await pollBarrier(run.id, 6, () => "errored");

  expect(created).toEqual([
    baseChildId,
    `${baseChildId}-attempt-0`,
    `${baseChildId}-attempt-1`,
    `${baseChildId}-attempt-2`,
  ]);
  expect(result).toMatchObject({ state: "failed" });
  const pending = await pendingEvidenceRequests(catalogueStore(env.CATALOGUE_DB), run.id);
  expect(pending).toEqual([]);
});

// A continuation is an ordinary successor in the shard's one append-only
// attempt sequence, so recovery, supersession and inspection keep seeing a
// single ordered line of attempts per shard.
test("continuation identities record the shard's next attempt number", async () => {
  const run = await createCollection("source_shard_succession_attempts_001", `https://${hostname}/cards`);
  const baseChildId = await shardIdentity(run.id);

  await pollBarrier(run.id, 3, () => "complete");

  const attempts = await sourceEvidenceQueries
    .readChildWorkflowAttempts(env.CATALOGUE_DB)
    .bind(run.id)
    .all<{ base_workflow_id: string; attempt_number: number; workflow_instance_id: string }>();
  expect(
    attempts.results
      .filter((attempt) => attempt.base_workflow_id === baseChildId)
      .map(({ attempt_number, workflow_instance_id }) => [attempt_number, workflow_instance_id]),
  ).toEqual([
    [1, baseChildId],
    [2, `${baseChildId}-continue-0`],
    [3, `${baseChildId}-continue-1`],
  ]);

  // The run retains the shard's base identity and the continuation currently
  // driving it, not one identity per poll: a shard that later discovery keeps
  // feeding is continued for as long as the collection runs, and the complete
  // history is the append-only attempt record above.
  const retained = await sourceEvidenceQueries
    .readIngestionEvidencePlansChildWorkflowIdsJson(env.CATALOGUE_DB)
    .bind(run.id)
    .first<{ child_workflow_ids_json: string }>();
  expect(JSON.parse(retained!.child_workflow_ids_json)).toEqual([baseChildId, `${baseChildId}-continue-1`]);
});

// A barrier that keeps polling while nothing advances must hand the run back
// to its owner. Before #445 it polled forever and the run sat in `collecting`
// with an idle runtime until the Workflow engine ended the instance at its
// 10,000-step ceiling, recording nothing anywhere.
test("a barrier that cannot keep polling records a resumable pause with the stranded work", async () => {
  const run = await createCollection("source_barrier_attempt_budget_001", `https://${hostname}/cards`);

  // A shard the platform reports running, that never records work: the
  // barrier polls until it reaches its own durable-step budget.
  const { created, result, waits } = await pollBarrier(run.id, collectionBarrierPollCeiling + 10, () => "running");

  expect(waits).toBe(collectionBarrierPollCeiling);
  expect(created).toHaveLength(1);
  expect(result).toMatchObject({
    state: "paused",
    paused: { reason: "source_workflow_attempt_exhausted", barrier_stage: collectionBarrierPollCeiling },
  });

  const pauses = await sourceEvidenceQueries
    .readIngestionRunWorkflowPauses(env.CATALOGUE_DB)
    .bind(run.id)
    .all<{ workflow_instance_id: string; pause_reason: string; workflow_status: string; stranded_json: string }>();
  expect(pauses.results).toHaveLength(1);
  expect(pauses.results[0]).toMatchObject({
    workflow_instance_id: `evidence-${run.id}`,
    pause_reason: "source_workflow_attempt_exhausted",
    workflow_status: "running",
  });
  expect(JSON.parse(pauses.results[0]!.stranded_json)).toEqual({
    by_host: [{ hostname, pending_request_count: 1 }],
    pending_request_count: 1,
  });

  // Non-terminal: the run is paused, its retained work untouched, and the
  // owner's ordinary resume reopens collection.
  const state = await sourceEvidenceQueries
    .readCollectionRunState(env.CATALOGUE_DB)
    .bind(run.id)
    .first<{ state: string }>();
  expect(state).toMatchObject({ state: "paused" });
  const pending = await pendingEvidenceRequests(catalogueStore(env.CATALOGUE_DB), run.id);
  expect(pending).toHaveLength(1);
  const resumed = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/resume`, "POST");
  expect(resumed.status).toBe(202);
  await resumed.body?.cancel();
});

// The barrier's finalize step is named for the stage it polls, not for a
// decision it made: it can never complete a run that still owes work.
test("the collection barrier never finalizes a run with pending Source Requests", async () => {
  const run = await createCollection("source_barrier_pending_finalize_001", `https://${hostname}/cards`);
  await pollBarrier(run.id, 3, () => "running");

  const current = await sourceEvidenceQueries
    .readCollectionRunState(env.CATALOGUE_DB)
    .bind(run.id)
    .first<{ state: string; collection_completed_at: string | null }>();
  expect(current).toMatchObject({ state: "collecting", collection_completed_at: null });
  expect(workflowStepName(workflowSteps.parent.finalize, { stage: 0 })).toBe("finalize collection barrier stage 0");
});
