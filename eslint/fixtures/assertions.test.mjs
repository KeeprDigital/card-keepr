import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
test("unawaited assertion", () => {
  assert.rejects(Promise.reject(new Error("probe"))); // probe:node-unawaited
});
test("awaited assertion", async () => { await assert.rejects(Promise.reject(new Error("probe"))); });
export function discardedRead() {
  readFile("diagnostic-only"); // probe:node-imported
}
