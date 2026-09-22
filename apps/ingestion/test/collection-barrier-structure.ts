import { env } from "cloudflare:workers";
import type { WorkflowStep } from "cloudflare:workers";
import { expect } from "vitest";
import { catalogueStore } from "../../../src/catalogue/shared";
import { recordWorkflowIds } from "../../../src/catalogue/source-evidence";
import { EvidenceIngestionWorkflow } from "../src/evidence-workflows";
import { boundedWorkflowInvocation, workflowInvocationSubrequestBudget } from "../src/workflow-invocation-budget";
import { createCollection } from "./runtime-helpers";

/** Binding calls one barrier step may make: its fence, progress and a few reads/writes. */
export const barrierStepSubrequestCeiling = 40;
class StopPolling extends Error {}

/**
 * Drive the production parent Workflow body through `polls` barrier polls while
 * its one hostname child stays running, with a recording step. Every barrier
 * step stays within its ceiling, an idle poll costs three durable steps, poll
 * intervals back off, and invocation yields bound the subrequests between them.
 */
export async function assertCollectionBarrierStructure(key: string, polls: number) {
  const run = await createCollection(key, "https://official-source.invalid/cards");
  const db = catalogueStore(env.CATALOGUE_DB);
  const parentId = `evidence-${run.id}`;
  await recordWorkflowIds(db, run.id, parentId, []);
  const created: string[] = [];
  const hostWorkflow = {
    async get(id: string) {
      if (!created.includes(id)) throw new Error("instance.not_found");
      return { id, status: async () => ({ status: "running" }) };
    },
    async createBatch(batch: { id: string }[]) {
      created.push(...batch.map(({ id }) => id));
      return batch.map(({ id }) => ({ id }));
    },
  } as unknown as Workflow;
  const measured = boundedWorkflowInvocation({ ...env, EVIDENCE_HOST_WORKFLOW: hostWorkflow }, {} as WorkflowStep, {
    mode: "production",
    budget: Number.POSITIVE_INFINITY,
  });
  const steps: { name: string; subrequests: number }[] = [];
  const waits: number[] = [];
  const yields: number[] = [];
  const step = {
    async do(name: string, configOrCallback: unknown, possibleCallback?: unknown) {
      const callback = (typeof configOrCallback === "function" ? configOrCallback : possibleCallback) as (
        context: unknown,
      ) => Promise<unknown>;
      const used = measured.usage().subrequests;
      const result = await callback({ step: { name, count: 1 }, attempt: 1 });
      steps.push({ name, subrequests: measured.usage().subrequests - used });
      return result === undefined ? undefined : structuredClone(result);
    },
    async sleep(name: string, duration: number | string) {
      if (name.startsWith("yield Workflow invocation after ")) {
        expect(duration).toBe("6 minutes");
        yields.push(measured.usage().subrequests);
        return;
      }
      expect(name).toMatch(/^await collection barrier stage \d+$/u);
      waits.push(Number(duration));
      if (waits.length === polls) throw new StopPolling();
    },
  } as unknown as WorkflowStep;
  const workflow = Object.assign(Object.create(EvidenceIngestionWorkflow.prototype) as EvidenceIngestionWorkflow, {
    env: { ...(measured.env as Env), WORKFLOW_WAIT_MODE: "production" },
  });
  await expect(
    workflow.run(
      {
        payload: { ingestion_run_id: run.id },
        timestamp: new Date(),
        instanceId: parentId,
        workflowName: "card-keepr-evidence-ingestion",
      },
      step,
    ),
  ).rejects.toBeInstanceOf(StopPolling);

  expect(waits).toHaveLength(polls);
  // Recovery re-ensures the same deterministic child identity on each pass.
  expect(new Set(created).size).toBe(1);
  // Backoff: one second, doubling while the pending shard set is unchanged, to a minute.
  expect(waits.slice(0, 8)).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000].slice(0, polls));
  for (const { name, subrequests } of steps)
    expect(subrequests, name).toBeLessThanOrEqual(barrierStepSubrequestCeiling);
  // An idle poll is three durable steps; the unchanged identity set is not re-recorded.
  const barrierSteps = steps.filter(({ name }) => / stage \d+$/u.test(name));
  expect(barrierSteps.length).toBeLessThanOrEqual(3 * polls + 2);
  expect(
    steps.filter(({ name }) => name.startsWith("record hostname Workflow identity count")).length,
  ).toBeLessThanOrEqual(2);
  const boundaries = [0, ...yields, measured.usage().subrequests];
  for (let index = 1; index < boundaries.length; index++)
    expect(boundaries[index]! - boundaries[index - 1]!).toBeLessThanOrEqual(
      workflowInvocationSubrequestBudget + barrierStepSubrequestCeiling,
    );
  return { yields: yields.length, subrequests: measured.usage().subrequests, steps: steps.length };
}
