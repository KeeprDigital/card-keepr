import { catalogueStore } from "../../../src/catalogue/shared";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { recordIngestionWorkflowProgress, resumeEvidenceRun } from "../../../src/catalogue/source-evidence";
import { createCollection, installRuntimeSuite, showCollection } from "./runtime-helpers";

installRuntimeSuite();

test("inspection retains each attempt's durable progress, while barrier polling does not hide a stalled collection", async () => {
  const run = await createCollection("workflow_recorded_progress_001", "https://official-source.invalid/cards");
  const parent = `evidence-${run.id}`;
  const child = "evidence-host-progress-test";
  const workAt = "2099-01-01T00:00:00.000Z";
  const pollAt = "2099-01-01T01:00:00.000Z";
  await recordIngestionWorkflowProgress(catalogueStore(env.CATALOGUE_DB), run.id, child, "child", {
    name: "collect stage 0 batch 0 from 0 pass 0",
    phase: "completed",
    at: workAt,
  });
  await recordIngestionWorkflowProgress(catalogueStore(env.CATALOGUE_DB), run.id, parent, "parent", {
    name: "finalize collection barrier stage 1",
    phase: "completed",
    at: pollAt,
  });
  const inspected = await showCollection(run.id);
  expect(inspected.workflow.last_progress_at).toBe(workAt);
  expect(inspected.workflow.attempts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: child,
        attempt_number: 1,
        last_progress_at: workAt,
        last_step_name: "collect stage 0 batch 0 from 0 pass 0",
        last_phase: "completed",
      }),
      expect.objectContaining({ id: parent, attempt_number: 1, last_progress_at: pollAt }),
    ]),
  );
  // A stale callback cannot move the retained timestamp backwards.
  await recordIngestionWorkflowProgress(catalogueStore(env.CATALOGUE_DB), run.id, child, "child", {
    name: "collect stage 0 batch 0 from 0 pass 0",
    phase: "started",
    at: "2098-01-01T00:00:00.000Z",
  });
  expect((await showCollection(run.id)).workflow.last_progress_at).toBe(workAt);
});

test("a transient parent lookup failure leaves collection available for a later resume", async () => {
  const run = await createCollection("workflow_transient_resume_001", "https://official-source.invalid/cards");
  const failure = new Error("synthetic control plane timeout");
  const binding = {
    get: async () => {
      throw failure;
    },
    create: async () => {
      throw new Error("must not create");
    },
  } as unknown as Workflow;
  await expect(
    resumeEvidenceRun(catalogueStore(env.CATALOGUE_DB), binding, run.id, env.EVIDENCE_HOST_WORKFLOW),
  ).rejects.toBe(failure);
  const inspected = await showCollection(run.id);
  expect(inspected.state).toBe("collecting");
  expect(inspected.pause).toBeUndefined();
  // Dispatch intent is bound before creation so an immediately executing
  // parent can prove ownership. A transport failure retains that same first
  // identity for retry; it must not classify recovery or open a second one.
  expect(inspected.workflow.attempts).toHaveLength(1);
  expect(inspected.workflow.attempts[0]).toMatchObject({ id: `evidence-${run.id}`, attempt_number: 1, current: true });
});
