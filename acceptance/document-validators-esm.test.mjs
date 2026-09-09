import assert from "node:assert/strict";
import test from "node:test";

test("generated document validators load as native ESM without a CommonJS require global", async () => {
  assert.equal(typeof globalThis.require, "undefined");
  const validators = await import("../src/catalogue/shared/document-validators.mjs");
  assert.equal(validators.record({ retained: true }), true);
  assert.equal(validators.record(null), false);
});
