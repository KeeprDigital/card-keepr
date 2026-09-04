import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { collectSourceRequestBatch } from "../../../src/catalogue/source-evidence-batch";
import { pendingEvidenceRequests } from "../../../src/catalogue/source-evidence-repository";
import {
  administrationRequest,
  type CollectionDocument,
  fixtureEvidenceRequest,
  installRuntimeSuite,
  showCollection,
  waitForEvidenceCondition,
  waitForEvidenceRun,
  waitForWorkflowStatus,
} from "./runtime-helpers";

installRuntimeSuite();

// Collection persists in batches of Source Requests behind one durable step
// (issue #138). These scenarios prove the batch is replayable: a failure
// anywhere inside it, or a pause that lands mid-batch, never duplicates a
// fetch attempt or a Source Snapshot and never loses retained bytes.

type AttemptFacts = {
  request_id: string;
  attempt_number: number;
  outcome: string;
};

async function attemptFacts(runId: string): Promise<AttemptFacts[]> {
  const rows = await env.CATALOGUE_DB.prepare(
    `SELECT request_id, attempt_number, outcome FROM source_fetch_attempts
     WHERE ingestion_run_id = ? ORDER BY request_id, attempt_number`,
  )
    .bind(runId)
    .all<AttemptFacts>();
  return rows.results;
}

async function captureOperations(runId: string): Promise<
  Array<{
    request_id: string;
    attempt_number: number;
    state: string;
    completed_at: string | null;
    content_digest: string | null;
    source_snapshot_id: string;
  }>
> {
  const rows = await env.CATALOGUE_DB.prepare(
    `SELECT request_id, attempt_number, state, completed_at, content_digest,
            source_snapshot_id
     FROM source_capture_operations
     WHERE ingestion_run_id = ? ORDER BY request_id, attempt_number`,
  )
    .bind(runId)
    .all<{
      request_id: string;
      attempt_number: number;
      state: string;
      completed_at: string | null;
      content_digest: string | null;
      source_snapshot_id: string;
    }>();
  return rows.results;
}

async function requestStates(runId: string): Promise<Record<string, string>> {
  const rows = await env.CATALOGUE_DB.prepare(
    `SELECT request_id, state FROM source_requests
     WHERE ingestion_run_id = ? ORDER BY request_id`,
  )
    .bind(runId)
    .all<{ request_id: string; state: string }>();
  return Object.fromEntries(rows.results.map((row) => [row.request_id, row.state]));
}

function sequenceRequests(hostname: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `sequence-${index + 1}`,
    url: `https://${hostname}/sequence/${index + 1}`,
  }));
}

async function failSnapshotCommitFor(requestId: string): Promise<void> {
  await env.CATALOGUE_DB.prepare(
    `CREATE TRIGGER fail_batch_snapshot_commit
     BEFORE INSERT ON source_snapshots
     WHEN NEW.request_id = '${requestId}'
     BEGIN
       SELECT RAISE(FAIL, 'synthetic_batch_commit_outage');
     END`,
  ).run();
}

async function releaseSnapshotCommit(): Promise<void> {
  await env.CATALOGUE_DB.prepare("DROP TRIGGER fail_batch_snapshot_commit").run();
}

test("a batch that fails midway replays without duplicating snapshots or attempts", async () => {
  const hostname = "batch-replay-official-source.invalid";
  const created = await fixtureEvidenceRequest({
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: "batch_replay_direct_001",
    requests: sequenceRequests(hostname, 6),
  });
  expect(created.status).toBe(201);
  const run = await created.json<CollectionDocument>();
  const requests = await pendingEvidenceRequests(env.CATALOGUE_DB, run.id);
  expect(requests).toHaveLength(6);
  const batchInput = {
    database: env.CATALOGUE_DB,
    evidenceObjects: env.EVIDENCE_OBJECTS,
    officialSourceTransport: env.OFFICIAL_SOURCE_TRANSPORT,
    runId: run.id,
    hostname,
    pacingMode: "immediate" as const,
    pacingIntervalMilliseconds: 0,
    requests,
  };

  // The third request's commit fails after its bytes reached R2: the batch
  // step rejects as a whole, exactly as a durable step would before replay.
  await failSnapshotCommitFor("sequence-3");
  await expect(collectSourceRequestBatch(batchInput)).rejects.toThrowError(/synthetic_batch_commit_outage/u);
  const interrupted = await captureOperations(run.id);
  const stagedThird = interrupted.find((operation) => operation.request_id === "sequence-3");
  expect(stagedThird).toMatchObject({
    attempt_number: 1,
    state: "uploaded",
    content_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
  });
  expect(stagedThird?.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  // The failed commit recorded neither an attempt nor a Source Snapshot for
  // the third request, and every request holds at most one capture
  // operation and one attempt regardless of where the failure landed.
  const interruptedAttempts = await attemptFacts(run.id);
  expect(interruptedAttempts.filter((attempt) => attempt.request_id === "sequence-3")).toEqual([]);
  for (const requestId of requests.map((request) => request.request_id)) {
    expect(interrupted.filter((operation) => operation.request_id === requestId).length).toBeLessThanOrEqual(1);
    expect(interruptedAttempts.filter((attempt) => attempt.request_id === requestId).length).toBeLessThanOrEqual(1);
  }
  expect(await requestStates(run.id)).toMatchObject({
    "sequence-1": "observed",
    "sequence-2": "observed",
    "sequence-3": "pending",
  });
  expect(
    await env.CATALOGUE_DB.prepare(
      `SELECT COUNT(*) AS count FROM source_snapshots
     WHERE ingestion_run_id = ? AND request_id = 'sequence-3'`,
    )
      .bind(run.id)
      .first("count"),
  ).toBe(0);

  // Replaying the same batch after the outage clears completes every
  // request from its retained operation state: the third request's staged
  // bytes are committed without another Official Source fetch.
  await releaseSnapshotCommit();
  await expect(collectSourceRequestBatch(batchInput)).resolves.toEqual({
    processed: 6,
    halt: null,
  });
  expect(await requestStates(run.id)).toEqual(
    Object.fromEntries(requests.map((request) => [request.request_id, "observed"])),
  );
  expect(await attemptFacts(run.id)).toEqual(
    requests.map((request) => ({
      request_id: request.request_id,
      attempt_number: 1,
      outcome: "success",
    })),
  );
  const replayed = await captureOperations(run.id);
  expect(replayed.map((operation) => operation.state)).toEqual(Array.from({ length: 6 }, () => "finalized"));
  const finalThird = replayed.find((operation) => operation.request_id === "sequence-3");
  expect(finalThird).toMatchObject({
    attempt_number: 1,
    completed_at: stagedThird?.completed_at,
    content_digest: stagedThird?.content_digest,
  });
  const thirdSnapshot = await env.CATALOGUE_DB.prepare(
    `SELECT id, retrieved_at, content_digest FROM source_snapshots
     WHERE ingestion_run_id = ? AND request_id = 'sequence-3'`,
  )
    .bind(run.id)
    .all<{
      id: string;
      retrieved_at: string;
      content_digest: string;
    }>();
  expect(thirdSnapshot.results).toEqual([
    {
      id: stagedThird?.source_snapshot_id,
      retrieved_at: stagedThird?.completed_at,
      content_digest: stagedThird?.content_digest,
    },
  ]);
  expect(
    await env.CATALOGUE_DB.prepare(`SELECT COUNT(*) AS count FROM source_snapshots WHERE ingestion_run_id = ?`)
      .bind(run.id)
      .first("count"),
  ).toBe(6);

  // A further replay of a settled batch is a no-op.
  await expect(collectSourceRequestBatch(batchInput)).resolves.toEqual({
    processed: 6,
    halt: null,
  });
  expect(await attemptFacts(run.id)).toHaveLength(6);
});

test("a Retry Pause inside a batch leaves later requests untouched and resumes without duplicates", async () => {
  const hostname = "batch-retry-pause-official-source.invalid";
  const requests = sequenceRequests(hostname, 6);
  requests[2] = {
    id: "sequence-3",
    url: `https://${hostname}/unavailable-then-recovered`,
  };
  const created = await fixtureEvidenceRequest({
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: "batch_retry_pause_001",
    requests,
  });
  expect(created.status).toBe(201);
  const run = await created.json<CollectionDocument>();
  const started = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/resume`, "POST");
  expect(started.status).toBe(202);
  await started.body?.cancel();
  const paused = await waitForEvidenceCondition(run.id, (current) => current.state === "paused", 15_000);
  expect(paused.pause).toMatchObject({
    reason: "source_transport_retries_exhausted",
    request_id: "sequence-3",
    hostname,
    retry_generation: 1,
    attempt_count: 4,
  });
  // Requests ahead of the exhausted one completed inside the batch; the
  // requests behind it were never attempted, and nothing failed.
  expect(await requestStates(run.id)).toEqual({
    "sequence-1": "observed",
    "sequence-2": "observed",
    "sequence-3": "pending",
    "sequence-4": "pending",
    "sequence-5": "pending",
    "sequence-6": "pending",
  });
  expect(await attemptFacts(run.id)).toEqual([
    { request_id: "sequence-1", attempt_number: 1, outcome: "success" },
    { request_id: "sequence-2", attempt_number: 1, outcome: "success" },
    ...[1, 2, 3, 4].map((attempt) => ({
      request_id: "sequence-3",
      attempt_number: attempt,
      outcome: "http_failure",
    })),
  ]);

  // Resuming opens generation 2 for the exhausted request only; the batch
  // replays through the retained state and every request ends with exactly
  // one successful fetch.
  const resumed = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/resume`, "POST");
  expect(resumed.status).toBe(202);
  await resumed.body?.cancel();
  const completed = await waitForEvidenceRun(run.id, "parsing", 20_000);
  expect(completed.snapshots).toHaveLength(6);
  expect(completed.observation_sets).toHaveLength(6);
  expect(await attemptFacts(run.id)).toEqual([
    { request_id: "sequence-1", attempt_number: 1, outcome: "success" },
    { request_id: "sequence-2", attempt_number: 1, outcome: "success" },
    ...[1, 2, 3, 4].map((attempt) => ({
      request_id: "sequence-3",
      attempt_number: attempt,
      outcome: "http_failure",
    })),
    { request_id: "sequence-3", attempt_number: 5, outcome: "success" },
    { request_id: "sequence-4", attempt_number: 1, outcome: "success" },
    { request_id: "sequence-5", attempt_number: 1, outcome: "success" },
    { request_id: "sequence-6", attempt_number: 1, outcome: "success" },
  ]);
  expect(
    await env.CATALOGUE_DB.prepare(
      `SELECT request_id, retry_generation FROM source_requests
     WHERE ingestion_run_id = ? AND retry_generation > 1`,
    )
      .bind(run.id)
      .all()
      .then(({ results }) => results),
  ).toEqual([{ request_id: "sequence-3", retry_generation: 2 }]);
}, 40_000);

test("a hostname Workflow whose batch step errors is superseded by an attempt that replays the batch without duplicate evidence", async () => {
  const hostname = "batch-workflow-official-source.invalid";
  const created = await fixtureEvidenceRequest({
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: "batch_workflow_replay_001",
    requests: sequenceRequests(hostname, 6),
  });
  expect(created.status).toBe(201);
  const run = await created.json<CollectionDocument>();
  await failSnapshotCommitFor("sequence-3");
  const started = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/resume`, "POST");
  expect(started.status).toBe(202);
  await started.body?.cancel();
  const collecting = await waitForEvidenceCondition(run.id, (current) => current.workflow.child_ids.length === 1);
  const childId = collecting.workflow.child_ids[0]!;
  // The batch step exhausts its bounded retries against the outage and the
  // hostname Workflow errors: the run stays collecting with its retained
  // work intact.
  await waitForWorkflowStatus(
    childId,
    async () => (await env.EVIDENCE_HOST_WORKFLOW.get(childId)).status(),
    "errored",
    20_000,
  );
  await releaseSnapshotCommit();
  const errored = await showCollection(run.id);
  expect(errored.state).toBe("collecting");
  expect((await attemptFacts(run.id)).filter((attempt) => attempt.request_id === "sequence-3")).toEqual([]);

  // The parent replaces the dead shard with a bounded new Workflow Attempt
  // identity that replays the batch from its retained operation state.
  const completed = await waitForEvidenceCondition(
    run.id,
    (current) => current.state === "parsing" && current.snapshots.length === 6 && current.observation_sets.length === 6,
    30_000,
  );
  expect(completed.workflow.child_ids).toContain(`${childId}-attempt-0`);
  expect(await attemptFacts(run.id)).toEqual(
    Array.from({ length: 6 }, (_, index) => ({
      request_id: `sequence-${index + 1}`,
      attempt_number: 1,
      outcome: "success",
    })),
  );
  expect((await captureOperations(run.id)).map((operation) => operation.state)).toEqual(
    Array.from({ length: 6 }, () => "finalized"),
  );
}, 60_000);
