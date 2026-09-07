import { applyD1Migrations, introspectWorkflow, introspectWorkflowInstance, reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { ReconciliationWorkflowParams } from "../../../src/catalogue/reconciliation";
import { runReconciliationWorkflow } from "./reconciliation-workflow-driver";
import { collectRequests, get, post, requiredString, testEnv } from "./reconciliation-helpers";

afterEach(reset);

test.each([false, true])(
  "the authenticated reconciliation Workflow hands durable preparation to successive instances (restart=%s)",
  async (restart) => {
    await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
    await using workflows = await introspectWorkflow(testEnv.RECONCILIATION_WORKFLOW);
    const run = await collectRequests([{ id: "cards", scenario: "curated-conflict-fanout-base" }], "sharded-candidate");
    const requested = await post(`/v1/ingestion-runs/${run.id}/reconciliation`, {
      expected_current_revision_id: requiredString(run.document, "expected_current_revision_id"),
      idempotency_key: "sharded-candidate-request",
    });
    expect(requested.response.status).toBe(202);
    const rootId = requiredString(requested.document, "workflow_instance_id");
    const root = await introspectWorkflowInstance(testEnv.RECONCILIATION_WORKFLOW, rootId);
    if (restart) {
      await root.waitForStepResult({ name: "dispatch reconciliation successor" });
      await (await testEnv.RECONCILIATION_WORKFLOW.get(rootId)).restart();
    }
    await root.waitForStatus("complete");
    const output = (await root.getOutput()) as { result_json: string };
    expect(JSON.parse(output.result_json)).toMatchObject({ run_id: run.id, candidate_digest: expect.any(String) });
    expect((await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document).toMatchObject({ state: "sealed" });
    expect((await workflows.get()).length).toBeGreaterThan(1);
  },
);

test("a lost successor create response preserves one chain with at most ten preparation callbacks per instance", async () => {
  await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
  const run = await collectRequests([{ id: "cards", scenario: "curated-conflict-fanout-base" }], "lost-shard-create");
  const trace = { callbacks: new Map<string, number>(), created: [] as string[], loseCreateResponse: true };
  const output = await runReconciliationWorkflow(
    testEnv,
    {
      instanceId: "lost-shard-create-root",
      payload: {
        ingestion_run_id: run.id,
        observed_at: new Date().toISOString(),
        expected_current_revision_id: requiredString(run.document, "expected_current_revision_id"),
        idempotency_key: "lost-shard-create-request",
      },
    } as WorkflowEvent<ReconciliationWorkflowParams>,
    {
      do: async (_name: string, _config: unknown, callback: () => Promise<string>) => callback(),
    } as unknown as WorkflowStep,
    trace,
  );
  expect(JSON.parse(output.result_json)).toMatchObject({ run_id: run.id, candidate_digest: expect.any(String) });
  expect(trace.created.length).toBeGreaterThan(1);
  expect(new Set(trace.created).size).toBe(trace.created.length);
  expect(trace.callbacks.size).toBe(trace.created.length + 1);
  expect(Math.max(...trace.callbacks.values())).toBeLessThanOrEqual(10);
  expect((await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document).toMatchObject({ state: "sealed" });
});
