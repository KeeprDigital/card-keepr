import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { catalogueStore, foldRunEvents } from "../../../src/catalogue/shared";
import { runEventsPageStatement } from "../../../src/catalogue/shared/ingestion-run-event-repository";
import {
  collectionProgressFacts,
  currentPause,
  failActiveEvidenceRequestsForWorkflowExhaustion,
  finalizeEvidenceRun,
  pauseEvidenceRunForWorkflowRecovery,
  requiredEvidenceRun,
  resumePausedEvidenceRun,
  retryExhaustionPauseStatements,
  startEvidenceRun,
  terminateEvidenceRun,
} from "../../../src/catalogue/source-evidence/source-evidence-repository";
import { resetMaintenanceOperation } from "./query-helpers/maintenance-guards";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
const database = catalogueStore(testEnv.CATALOGUE_DB);

beforeEach(async () => {
  await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
  await resetMaintenanceOperation(testEnv.CATALOGUE_DB).run();
});

async function createRun(key: string): Promise<string> {
  const run = await startEvidenceRun(database, {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: key,
    requests: [{ id: "cards", url: "https://source-event-fixture.invalid/cards" }],
  });
  if (typeof run.id !== "string") throw new Error("Run identity is missing.");
  return run.id;
}

const retryFacts = {
  request_id: "cards",
  source_lineage: "one-piece-en",
  hostname: "source-event-fixture.invalid",
  retry_generation: 1,
  attempt_count: 4,
  failure_classification: "network_failure" as const,
  http_status: null,
};

test("collection events preserve resume races, stale workflow fencing, termination replay, and deterministic projection", async () => {
  const runId = await createRun("source_event_lifecycle");
  await database.batch(retryExhaustionPauseStatements(database, runId, retryFacts));
  await database.batch(retryExhaustionPauseStatements(database, runId, retryFacts));
  await Promise.all([resumePausedEvidenceRun(database, runId), resumePausedEvidenceRun(database, runId)]);
  await resumePausedEvidenceRun(database, runId);
  await pauseEvidenceRunForWorkflowRecovery(database, runId, {
    workflow_instance_id: "superseded-parent",
    pause_reason: "owner_requested",
    workflow_status: "running",
    last_progress_at: null,
  });
  const resumed = await requiredEvidenceRun(database, runId);
  expect(resumed.state).toBe("collecting");
  if (resumed.parent_workflow_id === null) throw new Error("Resumed parent identity is missing.");
  await pauseEvidenceRunForWorkflowRecovery(database, runId, {
    workflow_instance_id: resumed.parent_workflow_id,
    pause_reason: "owner_requested",
    workflow_status: "running",
    last_progress_at: null,
  });
  const termination = await terminateEvidenceRun(database, runId, { idempotency_key: "source_event_termination" });
  expect(await terminateEvidenceRun(database, runId, { idempotency_key: "source_event_termination" })).toEqual(
    termination,
  );
  expect(
    (await runEventsPageStatement(database, runId, 0).all()).results.map((event) => [
      event.sequence_number,
      event.event_kind,
    ]),
  ).toEqual([
    [1, "created"],
    [2, "collection_paused"],
    [3, "collection_resumed"],
    [4, "collection_paused"],
    [5, "collection_terminated"],
  ]);
  expect(await foldRunEvents(database, runId)).toMatchObject({
    ingestion_run_id: runId,
    state: "failed",
    last_event_sequence: 5,
    completed_stage_count: 1,
    failure_code: "ingestion_run_terminated",
  });
  expect(await requiredEvidenceRun(database, runId)).toMatchObject({
    state: "failed",
    failure_code: "ingestion_run_terminated",
  });
});

test("a rejected collection transition rolls back its event and pause evidence", async () => {
  const runId = await createRun("source_event_rejected_transition");
  await resetMaintenanceOperation(testEnv.CATALOGUE_DB).run();
  await expect(database.batch(retryExhaustionPauseStatements(database, runId, retryFacts))).rejects.toThrow(
    "run_not_active",
  );
  expect((await runEventsPageStatement(database, runId, 0).all()).results).toHaveLength(1);
  expect(await currentPause(database, runId)).toBeNull();
  expect(await foldRunEvents(database, runId)).toMatchObject({ state: "collecting", last_event_sequence: 1 });
});

test("collection failure appends one terminal event and exposes its timestamp as progress", async () => {
  const runId = await createRun("source_event_failure");
  await failActiveEvidenceRequestsForWorkflowExhaustion(database, runId, {
    hostname: "source-event-fixture.invalid",
    minimumSequenceNumber: 0,
    maximumSequenceNumber: 100,
  });
  await finalizeEvidenceRun(database, runId);
  await finalizeEvidenceRun(database, runId);
  const events = (await runEventsPageStatement(database, runId, 0).all()).results;
  expect(events.map((event) => event.event_kind)).toEqual(["created", "failed"]);
  expect(await foldRunEvents(database, runId)).toMatchObject({
    state: "failed",
    last_event_sequence: 2,
    failure_code: "source_workflow_retries_exhausted",
  });
  expect((await collectionProgressFacts(database, runId)).last_progress_at).toBe(events[1]?.occurred_at);
});
