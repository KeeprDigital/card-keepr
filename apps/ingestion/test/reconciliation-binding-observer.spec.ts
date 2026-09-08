import { expect, test } from "vitest";
import { reconciliationBindingObserver } from "./reconciliation-binding-observer";
import { installReconciliationSuite, testEnv } from "./reconciliation-helpers";

installReconciliationSuite();

test("binding observer counts D1 execution and sessions without charging each submitted batch statement twice", async () => {
  const observer = reconciliationBindingObserver();
  const db = observer.database(testEnv.CATALOGUE_DB);
  const scope = observer.begin();
  await db.exec("CREATE TABLE observer_fixture(value INTEGER)");
  await db.prepare("INSERT INTO observer_fixture VALUES (?)").bind(7).run();
  expect(await db.prepare("SELECT value FROM observer_fixture").first("value")).toBe(7);
  expect((await db.prepare("SELECT value FROM observer_fixture").all()).results).toEqual([{ value: 7 }]);
  expect(await db.prepare("SELECT value FROM observer_fixture").raw({ columnNames: true })).toEqual([["value"], [7]]);
  await db.batch([db.prepare("SELECT 1"), db.prepare("SELECT 2")]);
  const session = db.withSession("first-primary");
  expect(await session.prepare("SELECT value FROM observer_fixture").first("value")).toBe(7);
  await session.batch([session.prepare("SELECT 3")]);
  expect(session.getBookmark()).toEqual(expect.any(String));
  observer.end();
  expect(scope.calls).toBe(8);
  expect(scope.methods).toEqual({
    "D1.exec": 1,
    "D1.run": 1,
    "D1.first": 1,
    "D1.all": 1,
    "D1.raw": 1,
    "D1.batch": 1,
    "D1.session.first": 1,
    "D1.session.batch": 1,
  });
  expect(scope.d1_batch_statements).toBe(3);
  expect(scope.returned_d1_metadata.exec_count?.total).toBe(1);
  expect(scope.returned_d1_metadata.rows_read?.observations).toBe(5);
  expect(Object.values(scope.outcomes).every((value) => value.fulfilled === 1 && value.rejected === 0)).toBe(true);
});

test("binding observer reads only R2 result metadata and observes each multipart method", async () => {
  const observer = reconciliationBindingObserver();
  const bucket = observer.bucket(testEnv.EVIDENCE_OBJECTS, "R2");
  const scope = observer.begin();
  const stored = await bucket.put("observer-object", "body");
  expect(stored!.size).toBe(4);
  expect((await bucket.head("observer-object"))!.size).toBe(4);
  const body = await bucket.get("observer-object");
  expect(body!.bodyUsed).toBe(false);
  expect(await body!.text()).toBe("body");
  expect(await bucket.get("observer-missing")).toBeNull();
  await bucket.list({ prefix: "observer-" });
  const created = await bucket.createMultipartUpload("observer-multipart");
  const resumed = bucket.resumeMultipartUpload(created.key, created.uploadId);
  expect(resumed).not.toBeInstanceOf(Promise);
  const part = await resumed.uploadPart(1, "part");
  expect((await resumed.complete([part])).size).toBe(4);
  await (await bucket.createMultipartUpload("observer-aborted")).abort();
  await bucket.delete(["observer-object", "observer-multipart"]);
  observer.end();
  expect(scope.methods).toEqual({
    "R2.put": 1,
    "R2.head": 1,
    "R2.get": 2,
    "R2.list": 1,
    "R2.createMultipartUpload": 2,
    "R2.resumeMultipartUpload": 1,
    "R2.multipart.uploadPart": 1,
    "R2.multipart.complete": 1,
    "R2.multipart.abort": 1,
    "R2.delete": 1,
  });
  expect(scope.calls).toBe(12);
  expect(scope.returned_r2_metadata["get.null_results"]).toEqual({ observations: 2, total: 1 });
  expect(scope.returned_r2_metadata["get.object_size"]).toEqual({ observations: 1, total: 4 });
  expect(scope.returned_r2_metadata["complete.object_size"]?.total).toBe(4);
  expect(scope.returned_r2_metadata["list.objects"]?.total).toBe(1);
});

test("binding observer preserves receiver, result identity and exact synchronous or asynchronous errors", async () => {
  const observer = reconciliationBindingObserver();
  const result = {
    size: 9,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }),
  };
  const error = new Error("synthetic observer rejection");
  const binding = {
    get() {
      expect(this).toBe(binding);
      return Promise.resolve(result);
    },
    head() {
      expect(this).toBe(binding);
      return Promise.reject(error);
    },
    resumeMultipartUpload() {
      expect(this).toBe(binding);
      throw error;
    },
  } as unknown as R2Bucket;
  const bucket = observer.bucket(binding, "R2");
  const scope = observer.begin();
  expect(await bucket.get("unrecorded-key")).toBe(result);
  expect(result.body.locked).toBe(false);
  await expect(bucket.head("unrecorded-key")).rejects.toBe(error);
  let caught: unknown;
  try {
    bucket.resumeMultipartUpload("unrecorded-key", "unrecorded-id");
  } catch (failure) {
    caught = failure;
  }
  expect(caught).toBe(error);
  observer.end();
  expect(scope.outcomes).toEqual({
    "R2.get": { attempted: 1, fulfilled: 1, rejected: 0 },
    "R2.head": { attempted: 1, fulfilled: 0, rejected: 1 },
    "R2.resumeMultipartUpload": { attempted: 1, fulfilled: 0, rejected: 1 },
  });
  expect(JSON.stringify(scope)).not.toContain("unrecorded");
});

test("binding observer attributes pending outcomes to their original callback and separates driver waits", async () => {
  const observer = reconciliationBindingObserver();
  observer.driverEvent("waitForEvent");
  const first = observer.begin();
  expect(() => observer.begin()).toThrow("sequential");
  let complete!: (value: number) => void;
  const pending = observer.driverMethod(
    "create",
    () =>
      new Promise<number>((resolve) => {
        complete = resolve;
      }),
  );
  observer.end();
  const second = observer.begin();
  observer.driverEvent("waitForEvent");
  complete(7);
  expect(await pending).toBe(7);
  observer.end();
  expect(first.outcomes["Workflow.driver.create"]).toEqual({ attempted: 1, fulfilled: 1, rejected: 0 });
  expect(second.calls).toBe(0);
  expect(second.driver_events).toEqual({ waitForEvent: 1 });
  expect(observer.outsideCallbacks.calls).toBe(0);
  expect(observer.outsideCallbacks.driver_events).toEqual({ waitForEvent: 1 });
});
