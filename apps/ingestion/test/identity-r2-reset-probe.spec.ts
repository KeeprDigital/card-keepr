import { env, evictAllDurableObjects, reset } from "cloudflare:test";
import { expect, test } from "vitest";

test("reset removes an active R2 object's retained bytes", async () => {
  await env.EVIDENCE_OBJECTS.put("identity-reset-probe", "prior-test");
  await reset();
  expect(await env.EVIDENCE_OBJECTS.head("identity-reset-probe")).toBeNull();
});

test("reset removes an evicted R2 object's retained bytes", async () => {
  await env.EVIDENCE_OBJECTS.put("identity-reset-probe", "prior-test");
  await evictAllDurableObjects();
  await reset();
  expect(await env.EVIDENCE_OBJECTS.head("identity-reset-probe")).toBeNull();
});

test("reset removes an idle R2 object's retained bytes", async () => {
  await env.EVIDENCE_OBJECTS.put("identity-idle-reset-probe", "prior-test");
  await new Promise((resolve) => setTimeout(resolve, 12_000));
  await reset();
  expect(await env.EVIDENCE_OBJECTS.head("identity-idle-reset-probe")).toBeNull();
});
