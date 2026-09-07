import * as eventQueries from "./query-helpers/run-event-projection";
import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import {
  rebuildRunProjection,
  catalogueStore,
  createRunEventStatement,
  foldRunEvents,
  runStartGuardStatement,
} from "../../../src/catalogue/shared";
import { transitionRunStatement } from "../../../src/catalogue/ingestion/run-lifecycle-repository";
const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
let runId = "";
let sequence = 0;
beforeEach(async () => {
  runId = `events_run_${++sequence}`;
  await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
  await eventQueries.resetEventFixtureOperation(testEnv.CATALOGUE_DB).run();
});
async function start() {
  const database = catalogueStore(testEnv.CATALOGUE_DB);
  await createRunEventStatement(database, {
    runId,
    selectedGamesJson: '["one-piece"]',
    startedAt: "2026-09-04T00:00:00.000Z",
    linkedRunId: null,
    idempotencyKey: runId,
    state: "planning",
    candidateJson: "{}",
    diagnosticsJson: "[]",
    guards: [runStartGuardStatement(database)],
  }).run();
  await eventQueries.reserveEventFixtureRun(testEnv.CATALOGUE_DB, runId).run();
  return database;
}
test("real D1 appends accepted transitions, preserves replay results and reconstructs the exact projection", async () => {
  const database = await start();
  const transition = () =>
    transitionRunStatement(database, {
      runId,
      from: "planning",
      to: "collecting",
      progressJson: '{"completed_stages":["planning"],"current_stage":"collecting"}',
    });
  const result = await database.batch([transition(), transition()]);
  expect(result.map((row) => row.meta.changes)).toEqual([1, 0]);
  const current = await eventQueries.readEventFixtureCurrent(testEnv.CATALOGUE_DB, runId).first();
  expect(await foldRunEvents(database, runId)).toEqual(current);
  expect((await eventQueries.countRunEvents(testEnv.CATALOGUE_DB, runId).first<{ count: number }>())?.count).toBe(2);
  await expect(eventQueries.attemptEventRewrite(testEnv.CATALOGUE_DB).run()).rejects.toThrow(
    "ingestion_run_event_immutable",
  );
  await expect(eventQueries.attemptEventDeletion(testEnv.CATALOGUE_DB).run()).rejects.toThrow(
    "ingestion_run_event_immutable",
  );
});
test("an authority failure rolls back the scalar projection, event and sibling mutation together", async () => {
  const database = await start();
  await testEnv.CATALOGUE_DB.batch([
    eventQueries.clearEventFixtureReservation(testEnv.CATALOGUE_DB),
    eventQueries.deleteEventFixtureReservation(testEnv.CATALOGUE_DB, runId),
  ]);
  await expect(
    database.batch([
      eventQueries.writeEventFixtureSibling(testEnv.CATALOGUE_DB),
      transitionRunStatement(database, {
        runId,
        from: "planning",
        to: "collecting",
        progressJson: '{"completed_stages":["planning"],"current_stage":"collecting"}',
      }),
    ]),
  ).rejects.toThrow("run_not_active");
  expect((await foldRunEvents(database, runId)).state).toBe("planning");
  expect(await eventQueries.readEventFixtureSibling(testEnv.CATALOGUE_DB).first("published_at")).not.toBe("sibling");
});
test("a corrupted projection cannot authorize a new event", async () => {
  const database = await start();
  await eventQueries.corruptEventFixtureProgress(testEnv.CATALOGUE_DB, runId).run();
  await expect(
    transitionRunStatement(database, {
      runId,
      from: "planning",
      to: "collecting",
      progressJson: '{"completed_stages":["planning"],"current_stage":"collecting"}',
    }).run(),
  ).rejects.toThrow("ingestion_run_projection_mismatch");
  expect((await foldRunEvents(database, runId)).completed_stage_count).toBe(0);
});

test("rebuild replaces damaged current and selected games, is idempotent, and requires maintenance ownership", async () => {
  const database = await start();
  const before = await eventQueries.readEventFixtureDocument(testEnv.CATALOGUE_DB, runId).first();
  const maintenance = { ownerId: "event_rebuild", observedAt: "2026-09-04T00:00:00.000Z" };
  await expect(rebuildRunProjection(database, runId, maintenance)).rejects.toThrow(
    "ingestion_run_rebuild_requires_maintenance",
  );
  await eventQueries.claimEventFixtureMaintenance(testEnv.CATALOGUE_DB).run();
  await testEnv.CATALOGUE_DB.batch([
    eventQueries.deleteEventFixtureCurrent(testEnv.CATALOGUE_DB, runId),
    eventQueries.deleteEventFixtureGames(testEnv.CATALOGUE_DB, runId),
  ]);
  await rebuildRunProjection(database, runId, maintenance);
  await rebuildRunProjection(database, runId, maintenance);
  expect(await eventQueries.readEventFixtureDocument(testEnv.CATALOGUE_DB, runId).first()).toEqual(before);
  expect(await eventQueries.countRunEvents(testEnv.CATALOGUE_DB, runId).first("count")).toBe(1);
});

test("bulk expiry records only accepted rows and retains each deadline as event time", async () => {
  const { seedRunFixtureStatement } = await import("./query-helpers/run-events");
  const { expireRunEventsStatement } = await import("../../../src/catalogue/shared");
  const database = catalogueStore(testEnv.CATALOGUE_DB);
  const ids = Array.from({ length: 24 }, (_, index) => `${runId}_expiry_${index}`);
  for (const id of ids)
    await seedRunFixtureStatement(testEnv.CATALOGUE_DB, {
      id,
      state: "awaiting_approval",
      candidate_digest: "candidate",
      candidate_catalogue_digest: "catalogue",
      candidate_created_at: "2026-09-01T00:00:00.000Z",
      approval_deadline: "2026-09-08T00:00:00.000Z",
    }).run();
  const sweep = expireRunEventsStatement(database, "2026-09-09T00:00:00.000Z");
  const result = await database.batch([sweep, sweep]);
  expect(result.map((row) => row.meta.changes)).toEqual([24, 0]);
  for (const id of ids) {
    const folded = await foldRunEvents(database, id);
    expect(folded.state).toBe("expired");
    expect(folded.last_event_sequence).toBe(6);
    expect(folded.terminal_at).toBe("2026-09-08T00:00:00.000Z");
  }
});

test("missing and corrupt current rows cannot release a live reservation", async () => {
  const { releaseTerminalRunLockStatement } = await import("../../../src/catalogue/ingestion/run-lifecycle-repository");
  const database = await start();
  const activeStates = '["planning","collecting","paused","parsing","reconciling","awaiting_approval","publishing"]';
  await eventQueries.corruptEventFixtureTerminalState(testEnv.CATALOGUE_DB, runId).run();
  await releaseTerminalRunLockStatement(database, activeStates).run();
  expect(await eventQueries.readEventFixtureReservation(testEnv.CATALOGUE_DB).first("active_ingestion_run_id")).toBe(
    runId,
  );
  await eventQueries.deleteEventFixtureCurrent(testEnv.CATALOGUE_DB, runId).run();
  await releaseTerminalRunLockStatement(database, activeStates).run();
  expect(await eventQueries.readEventFixtureReservation(testEnv.CATALOGUE_DB).first("active_ingestion_run_id")).toBe(
    runId,
  );
  await expect(
    transitionRunStatement(database, {
      runId,
      from: "planning",
      to: "collecting",
      progressJson: '{"completed_stages":["planning"],"current_stage":"collecting"}',
    }).run(),
  ).rejects.toThrow("ingestion_run_projection_missing");
});
test("selected-game corruption cannot authorize a transition", async () => {
  const database = await start();
  await eventQueries.deleteEventFixtureGames(testEnv.CATALOGUE_DB, runId).run();
  await expect(
    transitionRunStatement(database, {
      runId,
      from: "planning",
      to: "collecting",
      progressJson: '{"completed_stages":["planning"],"current_stage":"collecting"}',
    }).run(),
  ).rejects.toThrow("ingestion_run_projection_mismatch");
});
