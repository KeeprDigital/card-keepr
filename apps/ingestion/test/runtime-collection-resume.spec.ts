import { ingestionRunInsertStatement } from "../../../src/catalogue/source-evidence/ingestion-run-repository";
import { insertAuthoredCuratedRevisionStatement } from "../../../src/catalogue/curated/curated-repository";
import { removeCuratedGuards } from "./query-helpers/curated-guards";
import { requireCuratedReconfirmation, inspectRunCount } from "./query-helpers/collection-resume";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { catalogueStore } from "../../../src/catalogue/shared";
import { pauseEvidenceRunForWorkflowRecovery, resumePausedEvidenceRun } from "../../../src/catalogue/source-evidence";
import { removeIngestionTransitionAudit } from "./query-helpers/collection-resume";
import {
  administrationRequest,
  createCollection,
  installRuntimeSuite,
  showCollection,
  waitForEvidenceRun,
} from "./runtime-helpers";

installRuntimeSuite();

test("collection progress and concurrent recovery remain inspectable without transition audit history", async () => {
  await removeIngestionTransitionAudit(env.CATALOGUE_DB);
  const run = await createCollection("resume_without_transition_audit", "https://official-source.invalid/cards");
  const collecting = await showCollection(run.id);
  expect(collecting.state).toBe("collecting");
  expect(collecting.workflow.last_progress_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  const paused = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/pause`, "POST", {
    idempotency_key: "pause_without_transition_audit",
  });
  expect(paused.status).toBe(200);
  await paused.body?.cancel();
  const responses = await Promise.all([
    administrationRequest(`/v1/ingestion-runs/${run.id}/collection/resume`, "POST"),
    administrationRequest(`/v1/ingestion-runs/${run.id}/collection/resume`, "POST"),
  ]);
  for (const response of responses) {
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      workflow: { id: `evidence-${run.id}-resume-1`, attempt_number: 2 },
    });
  }
  const completed = await waitForEvidenceRun(run.id, "parsing");
  expect(completed.snapshots).toHaveLength(1);
  expect(completed.workflow.attempts.filter(({ kind }) => kind === "parent").map(({ id }) => id)).toEqual([
    `evidence-${run.id}`,
    `evidence-${run.id}-resume-1`,
  ]);
});

test("replaying a resume retains its identity and a later pause advances the immutable parent attempt", async () => {
  await removeIngestionTransitionAudit(env.CATALOGUE_DB);
  const run = await createCollection(
    "replayed_resume_without_transition_audit",
    "https://official-source.invalid/cards",
  );
  const database = catalogueStore(env.CATALOGUE_DB);
  const paused = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/pause`, "POST", {
    idempotency_key: "initial_replayed_resume_pause",
  });
  expect(paused.status).toBe(200);
  await paused.body?.cancel();
  await Promise.all([resumePausedEvidenceRun(database, run.id), resumePausedEvidenceRun(database, run.id)]);
  await resumePausedEvidenceRun(database, run.id);
  const first = await showCollection(run.id);
  expect(first).toMatchObject({
    state: "collecting",
    workflow: { current_attempt: { id: `evidence-${run.id}-resume-1`, attempt_number: 2 } },
  });
  await pauseEvidenceRunForWorkflowRecovery(database, run.id, {
    workflow_instance_id: `evidence-${run.id}-resume-1`,
    pause_reason: "source_workflow_unavailable",
    workflow_status: "unavailable",
    last_progress_at: first.workflow.last_progress_at,
  });
  expect((await showCollection(run.id)).state).toBe("paused");
  await Promise.all([resumePausedEvidenceRun(database, run.id), resumePausedEvidenceRun(database, run.id)]);
  await resumePausedEvidenceRun(database, run.id);
  const second = await showCollection(run.id);
  expect(second).toMatchObject({
    state: "collecting",
    workflow: { current_attempt: { id: `evidence-${run.id}-resume-2`, attempt_number: 3 } },
  });
  expect(second.workflow.attempts.filter(({ kind }) => kind === "parent").map(({ id }) => id)).toEqual([
    `evidence-${run.id}`,
    `evidence-${run.id}-resume-1`,
    `evidence-${run.id}-resume-2`,
  ]);
});

test("a source run cannot start for a Curated Revision awaiting reconfirmation after the trigger is removed", async () => {
  const database = catalogueStore(env.CATALOGUE_DB);
  await removeCuratedGuards(env.CATALOGUE_DB);
  await insertAuthoredCuratedRevisionStatement(database, {
    revisionId: "curated_source_start_guard",
    game: "one-piece",
    targetKey: "card:OP01-001:name",
    targetKind: "field",
    effectiveFrom: null,
    effectiveTo: null,
    proposalJson: "{}",
    contentDigest: "a".repeat(64),
    reviewedSourceDigest: "b".repeat(64),
    schemaBindingJson: '{"catalogue_revision_id":"catrev_spine_000"}',
    observedAt: "2026-09-01T00:00:00.000Z",
  }).run();
  await requireCuratedReconfirmation(env.CATALOGUE_DB, "curated_source_start_guard").run();
  const runId = "run_source_curated_start_guard";
  await expect(
    ingestionRunInsertStatement(database, {
      runId,
      supportedGames: ["one-piece"],
      startedAt: "2026-09-04T00:00:00.000Z",
      linkedRunId: null,
      idempotencyKey: "source_curated_start_guard",
    }).run(),
  ).rejects.toThrow(/curated_revision_reconfirmation_required/);
  expect(await inspectRunCount(env.CATALOGUE_DB, runId).first("count")).toBe(0);
});
