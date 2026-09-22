import { test } from "vitest";
import { assertArchiveStepStructure } from "./archive-step-structure";
import { installRuntimeSuite } from "./runtime-helpers";

installRuntimeSuite();

// Routine size: a few blocks and normalization calls still cross every step
// boundary and both lost-response retries. The 150,000-record volume runs in
// archive-step-structure.stress.spec.ts.
test("a retained archive decodes, normalizes and discovers across bounded steps and resumes lost responses", async () => {
  await assertArchiveStepStructure("archive-step-structure", 6000);
});
