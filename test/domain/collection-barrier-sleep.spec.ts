import { expect, test } from "vitest";
import { collectionBarrierSleepDuration } from "../../src/catalogue/collection-recovery";

test("deep multi-shard collections poll the barrier every minute", () => {
  expect(collectionBarrierSleepDuration(2, 11)).toBe("1 minute");
  expect(collectionBarrierSleepDuration(5, 200)).toBe("1 minute");
});

test("shallow or small collections poll the barrier immediately", () => {
  expect(collectionBarrierSleepDuration(1, 200)).toBe("1 second");
  expect(collectionBarrierSleepDuration(2, 10)).toBe("1 second");
  expect(collectionBarrierSleepDuration(0, 0)).toBe("1 second");
});
