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
