import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { publicationWriterAuthorityStatement } from "../../../src/catalogue/ingestion/publication-storage-repository";
import { catalogueStore } from "../../../src/catalogue/shared";
import { parentWorkflowAttemptId } from "../../../src/catalogue/source-evidence/collection-recovery";
import { evidenceRunByIdempotencyKeyStatement } from "../../../src/catalogue/source-evidence/ingestion-run-repository";
import {
  isCurrentCollectionWorkflowAttempt,
  recordWorkflowIds,
  releaseTerminatedEvidenceRun,
  requiredEvidenceRun,
  retryExhaustionPauseStatements,
  startEvidenceRun,
  terminateEvidenceRun,
} from "../../../src/catalogue/source-evidence/source-evidence-repository";
import { resetMaintenanceOperation } from "./query-helpers/maintenance-guards";
import { corruptPublishedRunProjection } from "./query-helpers/reconciliation-run-events";
import { readEventFixtureReservation } from "./query-helpers/run-event-projection";
import { seedRunFixtureStatement } from "./query-helpers/run-events";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
const database = catalogueStore(testEnv.CATALOGUE_DB);
const corruptions = ["scalar", "selected-games", "missing-current"] as const;
beforeEach(async () => {
  await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
  await resetMaintenanceOperation(testEnv.CATALOGUE_DB).run();
});

async function evidenceRun(key: string): Promise<string> {
  const run = await startEvidenceRun(database, {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: key,
    requests: [{ id: "cards", url: "https://event-authority.invalid/cards" }],
  });
  if (typeof run.id !== "string") throw new Error("Run identity is missing.");
  return run.id;
}

test.each(corruptions)("publication writer rejects %s projection damage before storage authority", async (kind) => {
  const runId = `event_authority_publication_${kind}`;
  const revisionId = `catrev_${runId}`;
  await seedRunFixtureStatement(testEnv.CATALOGUE_DB, {
    id: runId,
    state: "publishing",
    publication_revision_id: revisionId,
    publication_writer_token: "writer",
  }).run();
  const authority = publicationWriterAuthorityStatement(database, {
    runId,
    revisionId,
    writerToken: "writer",
    includePublished: 0,
  });
  expect(await authority.first()).toEqual({ id: runId });
  await corruptPublishedRunProjection(testEnv.CATALOGUE_DB, runId, kind).run();
  expect(await authority.first()).toBeNull();
});

test.each(corruptions)("collection dispatch and fetch authorities reject %s projection damage", async (kind) => {
  const key = `event_authority_collection_${kind}`;
  const runId = await evidenceRun(key);
  const workflowId = parentWorkflowAttemptId(runId, 1);
  await recordWorkflowIds(database, runId, workflowId, []);
  expect(await isCurrentCollectionWorkflowAttempt(database, runId, workflowId, workflowId)).toBe(true);
  expect(await requiredEvidenceRun(database, runId)).toMatchObject({ state: "collecting" });
  expect(await evidenceRunByIdempotencyKeyStatement(database, key).first()).toMatchObject({ id: runId });
  await corruptPublishedRunProjection(testEnv.CATALOGUE_DB, runId, kind).run();
  expect(await isCurrentCollectionWorkflowAttempt(database, runId, workflowId, workflowId)).toBe(false);
  await expect(requiredEvidenceRun(database, runId)).rejects.toThrow();
  if (kind === "missing-current") expect(await evidenceRunByIdempotencyKeyStatement(database, key).first()).toBeNull();
  else
    await expect(evidenceRunByIdempotencyKeyStatement(database, key).first()).rejects.toThrow(
      "ingestion_run_projection_mismatch",
    );
});

test("standalone termination release preserves the reservation when selected-game evidence is damaged", async () => {
  const runId = await evidenceRun("event_authority_termination");
  await database.batch(
    retryExhaustionPauseStatements(database, runId, {
      request_id: "cards",
      source_lineage: "one-piece-en",
      hostname: "event-authority.invalid",
      retry_generation: 1,
      attempt_count: 4,
      failure_classification: "network_failure",
      http_status: null,
    }),
  );
  await terminateEvidenceRun(database, runId, { idempotency_key: "event_authority_termination_decision" });
  await corruptPublishedRunProjection(testEnv.CATALOGUE_DB, runId, "selected-games").run();
  expect(await releaseTerminatedEvidenceRun(database, runId)).toBe(false);
  expect(await readEventFixtureReservation(testEnv.CATALOGUE_DB).first("active_ingestion_run_id")).toBe(runId);
});
