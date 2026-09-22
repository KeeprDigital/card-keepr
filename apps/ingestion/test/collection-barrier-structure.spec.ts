import { test } from "vitest";
import { assertCollectionBarrierStructure } from "./collection-barrier-structure";
import { installRuntimeSuite } from "./runtime-helpers";

installRuntimeSuite();

// Routine size crosses the backoff to its one-minute cap. The many-poll run
// that crosses invocation yields is collection-barrier-structure.stress.spec.ts.
test("the collection barrier polls in bounded durable steps and backs off while a shard is unchanged", async () => {
  await assertCollectionBarrierStructure("barrier-structure", 12);
});
