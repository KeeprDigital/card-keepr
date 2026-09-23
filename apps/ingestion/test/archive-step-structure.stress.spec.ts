import { expect, test } from "vitest";
import { assertArchiveStepStructure } from "./archive-step-structure";
import { installRuntimeSuite } from "./runtime-helpers";

installRuntimeSuite();

// Full Scryfall-scale record count (the adapter's 150,000-record ceiling;
// the live archive held 117,941). Local runtimes enforce no CPU or
// subrequest limit, so this proves structure: many bounded steps, each within
// its declared budget, with lost responses resumed without duplicates.
test("a 150,000-record archive advances across bounded steps and resumes lost responses without duplicates", async () => {
  const result = await assertArchiveStepStructure("archive-step-structure-scale", 150_000);
  expect(result.blocks).toBeGreaterThanOrEqual(147);
  expect(result.steps).toBeGreaterThanOrEqual(147);
  // The synthetic archive alone exceeds one invocation's subrequest budget.
  expect(result.yields).toBeGreaterThanOrEqual(1);
}, 900_000);
