import { expect, test } from "vitest";
import {
  advancesCollectionProgress,
  assertWorkflowRestartTarget,
  workflowStepName,
  workflowSteps,
} from "../../src/catalogue/shared/workflow-steps";

test("Riftbound collection dispatch has a valid, restartable preparation step", () => {
  const name = workflowStepName(workflowSteps.parent.prepareGame, { game: "riftbound" });
  expect(name).toBe("dispatch retained evidence preparation for riftbound");
  expect(advancesCollectionProgress("parent", name)).toBe(true);
  expect(() => assertWorkflowRestartTarget("parent", { name, count: 1, type: "do" })).not.toThrow();
  expect(() => workflowStepName(workflowSteps.parent.prepareGame, { game: "unregistered" })).toThrow();
});
