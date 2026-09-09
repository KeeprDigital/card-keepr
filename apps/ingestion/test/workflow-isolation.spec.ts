import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import { resetTestStorage } from "./workflow-isolation";

// A real idle interval is load-bearing: explicit eviction does not reproduce
// the retained-storage failure in the installed runtime's reset implementation.
test("fixture reset clears every R2 bucket after the runtime idles it", async () => {
  const buckets = [env.EVIDENCE_OBJECTS, env.PRINTING_IMAGES, env.CATALOGUE_EXPORTS, env.BACKUPS];
  const key = "fixture-reset-idle-object";
  await Promise.all(buckets.map((bucket) => bucket.put(key, "prior fixture")));
  await new Promise((resolve) => setTimeout(resolve, 12_000));
  await resetTestStorage();
  const retained = await Promise.all(buckets.map((bucket) => bucket.head(key)));
  expect(retained).toEqual([null, null, null, null]);
});
