import { env } from "cloudflare:workers";
import type { WorkflowStep } from "cloudflare:workers";
import { expect, test } from "vitest";
import { catalogueStore, repositoryStatements } from "../../../src/catalogue/shared";
import { recordWorkflowIds, workflowAttemptStatements } from "../../../src/catalogue/source-evidence";
import { fenceCollectionWorkflow, isSupersededCollectionWorkflow } from "../src/collection-workflow-fence";
import { boundedWorkflowInvocation, workflowWaitMode } from "../src/workflow-invocation-budget";
import { createCollection, installRuntimeSuite } from "./runtime-helpers";

installRuntimeSuite();

/** A step whose `cached` names replay their retained result without running the callback. */
function replayingStep(cached: ReadonlySet<string>) {
  const sleeps: { name: string; duration: unknown }[] = [];
  const step = {
    async do(name: string, configOrCallback: unknown, possibleCallback?: unknown) {
      const callback = (
        typeof configOrCallback === "function" ? configOrCallback : possibleCallback
      ) as () => Promise<unknown>;
      return cached.has(name) ? `cached ${name}` : callback();
    },
    async sleep(name: string, duration: unknown) {
      sleeps.push({ name, duration });
    },
  } as unknown as WorkflowStep;
  return { step, sleeps };
}

const query = (database: D1Database) =>
  repositoryStatements(catalogueStore(database)).prepare("SELECT 1 AS one").first();

test("an invocation yields once its live binding calls reach the budget, and replay neither counts nor yields", async () => {
  const replay = replayingStep(new Set(["step 0", "step 1", "step 2"]));
  const bounded = boundedWorkflowInvocation(env, replay.step, { mode: "production", budget: 10 });
  for (let index = 0; index < 8; index++)
    await bounded.step.do(`step ${index}`, async () => {
      for (let call = 0; call < 4; call++) await query(bounded.env.CATALOGUE_DB);
      return index;
    });
  // Three replayed steps cost nothing; five live steps made 20 calls.
  expect(bounded.usage()).toEqual({ subrequests: 20, steps: 5, yields: 1 });
  expect(replay.sleeps).toEqual([{ name: "yield Workflow invocation after step 5", duration: "6 minutes" }]);
  await bounded.step.do("step 8", async () => {
    await bounded.env.EVIDENCE_OBJECTS.head("absent");
    await bounded.env.CATALOGUE_DB.batch([bounded.env.CATALOGUE_DB.prepare("SELECT 1")]);
    return 8;
  });
  expect(bounded.usage().subrequests).toBe(22);
  expect(workflowWaitMode(undefined)).toBe("production");
  expect(workflowWaitMode("immediate")).toBe("immediate");
  expect(() => workflowWaitMode("fast")).toThrow("WORKFLOW_WAIT_MODE");
});

/**
 * Archive decoding spends its bound in the isolate, not on bindings: the #327
 * live collection made 177 subrequests in total while a single archive would
 * have spent tens of CPU-seconds, and CPU is charged per invocation just as
 * subrequests are. Live steps must therefore yield on their own count.
 */
test("an invocation yields on its live step count even when the steps make almost no binding calls", async () => {
  const replay = replayingStep(new Set(["step 0", "step 1"]));
  const bounded = boundedWorkflowInvocation(env, replay.step, { mode: "production", steps: 4 });
  for (let index = 0; index < 11; index++)
    await bounded.step.do(`step ${index}`, async () => {
      await query(bounded.env.CATALOGUE_DB);
      return index;
    });
  // Nine live steps, far below the 5,000-call subrequest budget, still yield
  // twice; the two replayed steps neither count nor yield.
  expect(bounded.usage()).toEqual({ subrequests: 9, steps: 9, yields: 2 });
  expect(replay.sleeps.map(({ name }) => name)).toEqual([
    "yield Workflow invocation after step 5",
    "yield Workflow invocation after step 9",
  ]);
  expect(replay.sleeps.every(({ duration }) => duration === "6 minutes")).toBe(true);
});

test("replaying a long collection history fences once, while every live callback is still fenced", async () => {
  const run = await createCollection("fence-replay-cost", "https://official-source.invalid/cards");
  const parentId = `evidence-${run.id}`;
  await recordWorkflowIds(catalogueStore(env.CATALOGUE_DB), run.id, parentId, []);
  const history = Array.from({ length: 200 }, (_, index) => `poll ${index}`);
  const replay = replayingStep(new Set(history));
  const bounded = boundedWorkflowInvocation(env, replay.step, { mode: "production" });
  const fenced = fenceCollectionWorkflow(
    replay.step,
    catalogueStore(bounded.env.CATALOGUE_DB),
    run.id,
    parentId,
    parentId,
  );
  for (const name of history) await fenced.do(name, async () => name);
  expect(bounded.usage().subrequests).toBe(1);
  await fenced.do("live", async () => "live");
  expect(bounded.usage().subrequests).toBe(2);
  // After a live callback every step is checked before and inside it again.
  await fenced.do("live again", async () => "live");
  expect(bounded.usage().subrequests).toBe(4);
  // A newer parent attempt supersedes this one: its next live callback stops.
  const database = catalogueStore(env.CATALOGUE_DB);
  await database.batch(workflowAttemptStatements(database, run.id, [`${parentId}-resume-1`]));
  const error = await fenced.do("after supersession", async () => "acted").catch((caught: unknown) => caught);
  expect(isSupersededCollectionWorkflow(error)).toBe(true);
});
