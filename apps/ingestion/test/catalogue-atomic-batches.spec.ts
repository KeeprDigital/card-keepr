import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { atomicRepositoryStatement, catalogueStore } from "../../../src/catalogue/shared";
import {
  atomicBatchValues,
  createAtomicBatchFixture,
  insertAtomicBatchValue,
  requireAtomicBatchValue,
} from "./query-helpers/atomic-batches";

beforeEach(async () => {
  await createAtomicBatchFixture(env.CATALOGUE_DB);
});

test("a failed repository guard rolls back every sibling write and retains its problem code", async () => {
  const database = catalogueStore(env.CATALOGUE_DB);
  const guarded = atomicRepositoryStatement(database, {
    statement: insertAtomicBatchValue(database, "guarded", 2),
    after: [requireAtomicBatchValue(database, "guarded", null)],
  });
  await expect(
    database.batch([
      insertAtomicBatchValue(database, "earlier", 1),
      guarded,
      insertAtomicBatchValue(database, "later", 3),
    ]),
  ).rejects.toThrow("atomic_batch_value_changed");
  expect((await atomicBatchValues(database).all()).results).toEqual([]);
});

test("repository guards observe prior sibling writes without changing primary result positions", async () => {
  const database = catalogueStore(env.CATALOGUE_DB);
  const guarded = atomicRepositoryStatement(database, {
    before: [requireAtomicBatchValue(database, "earlier", 1)],
    statement: insertAtomicBatchValue(database, "guarded", 2),
    after: [requireAtomicBatchValue(database, "guarded", 2)],
  });
  const results = await database.batch<{ id: string; value: number }>([
    insertAtomicBatchValue(database, "earlier", 1),
    guarded,
    atomicBatchValues(database),
  ]);
  expect(results).toHaveLength(3);
  expect(results[0]?.results).toEqual([{ id: "earlier", value: 1 }]);
  expect(results[1]?.results).toEqual([{ id: "guarded", value: 2 }]);
  expect(results[1]?.meta.changes).toBe(1);
  expect(results[2]?.results).toEqual([
    { id: "earlier", value: 1 },
    { id: "guarded", value: 2 },
  ]);
});

test("direct execution uses the same atomic recipe and cannot bypass a postcondition", async () => {
  const database = catalogueStore(env.CATALOGUE_DB);
  const rejected = atomicRepositoryStatement(database, {
    statement: insertAtomicBatchValue(database, "rejected", 1),
    after: [requireAtomicBatchValue(database, "rejected", 2)],
  });
  await expect(rejected.run()).rejects.toThrow("atomic_batch_value_changed");
  expect((await atomicBatchValues(database).all()).results).toEqual([]);
  const accepted = atomicRepositoryStatement(database, {
    statement: insertAtomicBatchValue(database, "accepted", 2),
    after: [requireAtomicBatchValue(database, "accepted", 2)],
  });
  expect(await accepted.first("value")).toBe(2);
});

test("guard expansion rejects an oversized transaction before writing any part", async () => {
  const database = catalogueStore(env.CATALOGUE_DB);
  const guarded = atomicRepositoryStatement(database, {
    statement: insertAtomicBatchValue(database, "oversized", 1),
    after: Array.from({ length: 900 }, () => requireAtomicBatchValue(database, "oversized", 1)),
  });
  await expect(guarded.run()).rejects.toThrow("900-statement D1 budget after guard expansion");
  expect((await atomicBatchValues(database).all()).results).toEqual([]);
});
