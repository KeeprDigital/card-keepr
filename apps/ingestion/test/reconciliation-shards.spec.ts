import { applyD1Migrations, introspectWorkflow, introspectWorkflowInstance, reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import type { WorkflowEvent, WorkflowStep, WorkflowStepContext } from "cloudflare:workers";
import type { ReconciliationWorkflowParams } from "../../../src/catalogue/reconciliation";
import { runReconciliationWorkflow } from "./reconciliation-workflow-driver";
import { collectRequests, get, post, requiredString, testEnv } from "./reconciliation-helpers";

afterEach(reset);

test("historical evidence keeps a full preparation deadline across successor Workflows and request replay", async () => {
  await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
  await using workflows = await introspectWorkflow(testEnv.RECONCILIATION_WORKFLOW);
  const run = await collectRequests([{ id: "cards", scenario: "curated-conflict-fanout-base" }], "historical-shards");
  const started = Date.now();
  const request = {
    expected_current_revision_id: requiredString(run.document, "expected_current_revision_id"),
    idempotency_key: "historical-shards-request",
  };
  const requested = await post(`/v1/ingestion-runs/${run.id}/reconciliation`, request, {
    "x-keepr-test-now": "2026-07-01T00:00:00.000Z",
  });
  expect(requested.response.status).toBe(202);
  const first = await get(`/v1/ingestion-runs/${run.id}/reconciliation`);
  expect(Date.parse(String(first.document.deadline))).toBeGreaterThanOrEqual(started + 604800000);
  const root = await introspectWorkflowInstance(
    testEnv.RECONCILIATION_WORKFLOW,
    requiredString(requested.document, "workflow_instance_id"),
  );
  await root.waitForStatus("complete");
  expect(JSON.parse(((await root.getOutput()) as { result_json: string }).result_json)).toHaveProperty(
    "candidate_digest",
  );
  expect((await workflows.get()).length).toBeGreaterThan(1);
  await post(`/v1/ingestion-runs/${run.id}/reconciliation`, request);
  expect((await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document.deadline).toBe(first.document.deadline);
});

test("a successor initialization outage exhausts bounded retries and returns the paused operation to its root", async () => {
  await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
  const run = await collectRequests([{ id: "cards", scenario: "curated-conflict-fanout-base" }], "shard-init-outage");
  const trace = { callbacks: new Map<string, number>(), created: [] as string[] };
  let failures = 0;
  let activeStep = "";
  const database = new Proxy(testEnv.CATALOGUE_DB, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => {
          if (
            activeStep !== "finalize exhausted reconciliation failure" &&
            trace.created.length > 0 &&
            failures < 4 &&
            sql.includes("SELECT state, generation, candidate_digest, definition_pins_json")
          ) {
            failures++;
            throw new Error("Injected successor initialization D1 outage.");
          }
          return target.prepare(sql);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const output = await runReconciliationWorkflow(
    { ...testEnv, CATALOGUE_DB: database },
    {
      instanceId: "shard-init-outage-root",
      payload: {
        ingestion_run_id: run.id,
        observed_at: new Date().toISOString(),
        expected_current_revision_id: requiredString(run.document, "expected_current_revision_id"),
        idempotency_key: "shard-init-outage-request",
      },
    } as WorkflowEvent<ReconciliationWorkflowParams>,
    {
      do: async (name: string, config: { retries: { limit: number } }, callback: () => Promise<string>) => {
        activeStep = name;
        try {
          for (let attempt = 0; ; attempt++) {
            try {
              return await callback();
            } catch (error) {
              if (attempt >= config.retries.limit) throw error;
            }
          }
        } finally {
          activeStep = "";
        }
      },
    } as unknown as WorkflowStep,
    trace,
  );
  expect(failures).toBe(4);
  expect(JSON.parse(output.result_json), output.result_json).toMatchObject({
    run_id: run.id,
    result: { state: "paused" },
  });
  expect((await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document).toMatchObject({
    state: "paused",
    generation: 1,
  });
});

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
    expect(JSON.parse(output.result_json), output.result_json).toMatchObject({
      run_id: run.id,
      candidate_digest: expect.any(String),
    });
    expect((await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document).toMatchObject({ state: "sealed" });
    expect((await workflows.get()).length).toBeGreaterThan(1);
  },
);

test.each([1, 4])(
  "lost dispatch and work outputs preserve one chain within the shard attempt allowance (attempts=%s)",
  async (attempts) => {
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
        do: async (name: string, _config: unknown, callback: (context: WorkflowStepContext) => Promise<string>) => {
          let result = "";
          const count = name.startsWith("reconcile retained Card, Printing, and Erratum evidence") ? attempts : 1;
          for (let attempt = 1; attempt <= count; attempt++)
            result = await callback({ step: { name, count: 1 }, attempt, config: {} });
          return result;
        },
      } as unknown as WorkflowStep,
      trace,
    );
    expect(JSON.parse(output.result_json), output.result_json).toMatchObject({
      run_id: run.id,
      candidate_digest: expect.any(String),
    });
    expect(trace.created.length).toBeGreaterThan(1);
    expect(new Set(trace.created).size).toBe(trace.created.length);
    expect(trace.callbacks.size).toBe(trace.created.length + 1);
    const maximumAttempts = Math.max(...trace.callbacks.values());
    expect(maximumAttempts).toBeGreaterThan(10);
    expect(maximumAttempts).toBeLessThanOrEqual(attempts === 1 ? 40 : 48);
    const budgets = await testEnv.CATALOGUE_DB.prepare(
      "SELECT reserved_calls FROM reconciliation_workflow_budgets WHERE preparation_id = ?",
    )
      .bind(run.id)
      .all<{ reserved_calls: number }>();
    expect(budgets.results.length).toBe(trace.callbacks.size);
    expect(Math.max(...budgets.results.map((row) => row.reserved_calls)) + 500).toBeLessThanOrEqual(5000);
    expect((await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document).toMatchObject({ state: "sealed" });
  },
);

test("a Workflow restart preserves reservations made before a lost work result", async () => {
  await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
  const run = await collectRequests([{ id: "cards", scenario: "curated-conflict-fanout-base" }], "reserved-restart");
  await testEnv.CATALOGUE_DB.prepare(`CREATE TRIGGER fail_normalization_checkpoint BEFORE INSERT ON reconciliation_checkpoints
    WHEN NEW.phase = 'normalization' BEGIN SELECT RAISE(ABORT, 'Injected normalization checkpoint outage'); END`).run();
  const requested = await post(`/v1/ingestion-runs/${run.id}/reconciliation`, {
    expected_current_revision_id: requiredString(run.document, "expected_current_revision_id"),
    idempotency_key: "reserved-restart-request",
  });
  expect(requested.response.status).toBe(202);
  const id = requiredString(requested.document, "workflow_instance_id");
  await using root = await introspectWorkflowInstance(testEnv.RECONCILIATION_WORKFLOW, id);
  const instance = await testEnv.RECONCILIATION_WORKFLOW.get(id);
  const deadline = Date.now() + 10_000;
  let reached = false;
  while (Date.now() < deadline) {
    reached =
      (await testEnv.CATALOGUE_DB.prepare(
        "SELECT 1 FROM reconciliation_normalized_observations WHERE preparation_id = ? LIMIT 1",
      )
        .bind(run.id)
        .first()) !== null;
    if (reached) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(reached).toBe(true);
  await instance.terminate();
  await root.waitForStatus("terminated");
  const readBudget = () =>
    testEnv.CATALOGUE_DB.prepare(
      "SELECT reserved_calls FROM reconciliation_workflow_budgets WHERE preparation_id = ? AND generation = 0 AND shard_ordinal = 0",
    )
      .bind(run.id)
      .first<number>("reserved_calls");
  const before = await readBudget();
  expect(before).toBeGreaterThan(0);
  expect(
    await testEnv.CATALOGUE_DB.prepare(
      "SELECT 1 FROM reconciliation_checkpoints WHERE preparation_id = ? AND phase = 'normalization' LIMIT 1",
    )
      .bind(run.id)
      .first(),
  ).toBeNull();
  await testEnv.CATALOGUE_DB.prepare("DROP TRIGGER fail_normalization_checkpoint").run();
  await instance.restart();
  await root.waitForStatus("complete");
  expect(await readBudget()).toBeGreaterThan(before!);
  expect(await readBudget()).toBeLessThanOrEqual(4500);
  expect((await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document).toMatchObject({
    state: "sealed",
    generation: 0,
  });
});
