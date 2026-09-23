import { expect, test } from "vitest";
import { collectionBarrierWaitMilliseconds } from "../../src/catalogue/source-evidence";

const wait = (maximumShardDepth: number, maximumActiveRequestCount: number, unchangedPolls = 0) =>
  collectionBarrierWaitMilliseconds({
    maximumShardDepth,
    maximumActiveRequestCount,
    unchangedPolls,
    mode: "production",
  });

test("deep multi-shard collections poll the barrier every minute", () => {
  expect(wait(2, 11)).toBe(60_000);
  expect(wait(5, 200, 40)).toBe(60_000);
});

test("a shallow barrier backs off while its pending shard set is unchanged", () => {
  expect([0, 1, 2, 3, 4, 5, 6, 7, 500].map((polls) => wait(1, 200, polls))).toEqual([
    1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000,
  ]);
  expect(wait(2, 10)).toBe(1000);
  expect(wait(0, 0)).toBe(1000);
});

test("an hour-long single shard costs a bounded number of barrier polls", () => {
  let elapsed = 0,
    polls = 0;
  while (elapsed < 3_600_000) elapsed += wait(1, 1, polls++);
  // One-second polling took 3,600 polls (four durable steps each).
  expect(polls).toBeLessThanOrEqual(66);
});

test("the test harness wait mode keeps one-second polls", () => {
  expect(
    collectionBarrierWaitMilliseconds({
      maximumShardDepth: 1,
      maximumActiveRequestCount: 1,
      unchangedPolls: 9,
      mode: "immediate",
    }),
  ).toBe(1000);
});
