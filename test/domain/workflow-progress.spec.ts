import type { WorkflowStep } from "cloudflare:workers";
import { expect, test } from "vitest";
import { observeWorkflowProgress } from "../../src/catalogue/shared/workflow-progress";

test("cached durable step replay does not invent fresh progress", async () => {
  let cached = false;
  const events: string[] = [];
  const platformStep = {
    do: async (_name: string, callback: () => Promise<unknown>) => {
      if (cached) return "retained";
      cached = true;
      return callback();
    },
  } as unknown as WorkflowStep;
  const step = observeWorkflowProgress(platformStep, async ({ phase }) => {
    events.push(phase);
  });
  await step.do("collect stage 0 batch 0 from 0 pass 0", async () => "retained");
  await step.do("collect stage 0 batch 0 from 0 pass 0", async () => "unexpected");
  expect(events).toEqual(["started", "completed"]);
});
