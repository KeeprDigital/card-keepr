import { expect, test } from "vitest";
import { assertCollectionBarrierStructure } from "./collection-barrier-structure";
import { installRuntimeSuite } from "./runtime-helpers";

installRuntimeSuite();

// The live failure polled 200 stages inside one invocation. 600 polls (ten
// hours at the one-minute cap) must cross invocation yields that keep each
// invocation's subrequests under the budget, with every poll still bounded.
test("a long-waiting collection barrier survives many polls with bounded subrequests per invocation", async () => {
  const result = await assertCollectionBarrierStructure("barrier-structure-scale", 600);
  expect(result.yields).toBeGreaterThanOrEqual(1);
}, 600_000);
